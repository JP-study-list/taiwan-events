#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""景點照片工具 —— 把你拍的原圖壓成網站用的 WebP，並自動認出那是哪個景點。

四支程式的分工（**彼此獨立，不要想成同一件事**）：
  fetch_events.py       自動抓活動（64 個網站，每天變，要 LLM 與金鑰）
  build_restaurants.py  整理餐廳清單（人工放清單，每月跑）
  build_places.py       整理常設景點（座標、營業時間）
  build_photos.py       景點照片 ← 本檔

⚠️ **本檔只在本機跑，不進任何 workflow。** 原圖在外接硬碟上，Actions 看不到；
而且「哪張照片好看」是人的判斷，自動化沒有意義。它**只讀 places.json**
（不改），寫的地方只有兩處：`places/` 的 WebP 與 `places_src/*.json` 的 `img`。

用法：
    python3 build_photos.py --todo     # 列出還沒照片的景點（按地區分組）
    python3 build_photos.py            # 掃原圖 → 配對 → 壓縮 → 回寫 img（會先問你）
    python3 build_photos.py --yes      # 同上，不停下來問
    python3 build_photos.py --force    # 連「已經有照片」的也重壓覆蓋
    python3 build_photos.py --dry-run  # 只看它打算做什麼，一個字都不寫
    python3 build_photos.py --src ~/x  # 換一個原圖資料夾

它怎麼知道「這張是哪個景點」——兩條路，共同原則是**對不上就擋下來，絕不猜**：
  ① **檔名就是 id**（`pl-tokyo-tower.jpg`）→ 直接用。你明確指定的最優先。
  ② 否則讀 EXIF 的 GPS，找 RADIUS_M 公尺內的景點：
       剛好一個  → 採用
       零個或多個 → 擋下來列給你看，要你改檔名再跑一次

⚠️ **「多個候選就擋下來」不是防禦性設計，第一批照片就會用到。**
實測東京鐵塔與增上寺的座標只差 **31 公尺**（一張照片到兩者分別是 202m／233m），
明治神宮與代代木公園差 94 公尺，上野那四個博物館彼此 140〜300 公尺。
自動選最近的那個會有一半機率掛到隔壁景點上——而那種錯誤在地圖上
**跟正確的長得一模一樣**，你不會發現。

⚠️ **刻意不用 macOS 的 `mdls` 讀 GPS。** 它查的是 Spotlight 索引，而外接硬碟
多半沒被索引：實測同一個檔案，用內接碟路徑查得到座標、用外接碟路徑回
「could not find」。那種「有時候能、有時候不能」比完全不能更糟——它會在
某一天靜默地把所有照片都變成「沒有 GPS」，而你只會看到配對率突然歸零。
故 EXIF 自己解（純 stdlib，實測與 mdls 一致到小數點後 7 位）。
"""

import argparse, glob, json, math, os, re, shutil, struct, subprocess, sys, tempfile
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_restaurants as R        # 只為了拿 AREAS 的顯示順序，**只讀不改**

# ---------------------------------------------------------------- 設定
SRC_DEFAULT = '/Volumes/renssd/vscodegithub/event-photo'
PLACES_JSON = os.path.join(HERE, 'places.json')
PLACES_SRC  = os.path.join(HERE, 'places_src')
PHOTO_DIR   = os.path.join(HERE, 'places')

# ⚠️⚠️ **限制的是「寬度」不是「長邊」**（2026-09-04 改）。畫面上限制照片的
# 一直是**寬度**——高度是跟著長寬比跑的——所以用長邊當上限會**同時做錯兩件事**：
# 橫式給太多（用不到）、**直式給太少（會糊）**。
# ⚠️ **舊制的直式真的偏小**：實測當時 356 張裡 18 張直式，寬度只有 799～964，
# 而詳情卡需要 1014。**橫式看起來沒事，所以這件事從畫面上看不出來。**
MAX_W    = 1000      # 寬度上限。**量出來的，不是猜的**（2026-09-04 用 headless Chrome 實測）：
                     #   詳情卡的照片是**固定 338 CSS px 寬**（各種螢幕都一樣）
                     #   → 手機 3 倍密度需要 338×3 = **1014 實體像素**，1000 只差 1.4%（看不出來）
                     #   清單卡片 176（390 手機）〜267（1600 桌機）CSS px → 3 倍下最多 588
                     #   匯出行程圖 184px、地圖彈窗更小
                     # ⚠️ **再往上是純浪費**：1200 只服務「比 1014 還大」的想像需求，
                     # 而實照比對（1200q80 vs 1000q75，338px＠3x 的 1:1 裁切）分不出來。
MAX_H    = 1500      # 高度上限，只為了擋極端直幅（候選本來就濾掉長寬比 <0.4／>2.0）
QUALITY  = 75        # cwebp -q。**2026-09-04 由 80 降到 75**：同樣拿實照在
                     # **真實顯示尺寸**（338 CSS px＠3 倍）下 1:1 比過，
                     # 1000q75 與 1200q80 分不出來，而體積是 60%。
                     # ⚠️ **700 是真的會糊**（同一組比對裡看板下方那段英文糊成一片），
                     # 別為了省空間再往下砍。
METHOD   = 6         # cwebp -m，最慢最省空間。67 張的量，慢一點無所謂
RADIUS_M = 500       # GPS 配對半徑
WARN_KB  = 200       # 超過就在報表標出來，讓你決定要不要降品質
AR_WARN  = 1.6       # 長寬比超過這個就提醒「正方形裁切會切掉很多」

PHOTO_EXT    = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff'}
NEED_CONVERT = {'.heic', '.heif'}     # cwebp 讀不了，得先過一手 sips

# EXIF orientation → (要不要鏡像, 順時針幾度)。iPhone 只會產生 1/3/6/8，
# 鏡像那四種（2/4/5/7）程式碼寫了但**沒有實照可測**，遇到會在報表註明。
ORIENT_FIX = {2: ('horizontal', 0), 3: (None, 180), 4: ('vertical', 0),
              5: ('horizontal', 270), 6: (None, 90), 7: ('horizontal', 90),
              8: (None, 270)}


# ---------------------------------------------------------------- EXIF
def _ifd(t, en, off):
    """讀一個 IFD，回 {tag: value_offset}。"""
    n = struct.unpack(en + 'H', t[off:off + 2])[0]
    out = {}
    for k in range(n):
        e = off + 2 + k * 12
        tag = struct.unpack(en + 'H', t[e:e + 2])[0]
        out[tag] = e + 8
    return out


def _gps_of(t, en, gp):
    """GPS IFD → (lat, lng)。度分秒三組有理數 + N/S/E/W 方位。"""
    if 2 not in gp or 4 not in gp:
        return None

    def deg(tag):
        o = struct.unpack(en + 'I', t[gp[tag]:gp[tag] + 4])[0]
        v = []
        for k in range(3):
            a, b = struct.unpack(en + 'II', t[o + k * 8:o + k * 8 + 8])
            v.append(a / b if b else 0.0)
        return v[0] + v[1] / 60 + v[2] / 3600

    def ref(tag):
        return t[gp[tag]:gp[tag] + 1].decode('ascii', 'ignore') if tag in gp else ''

    lat, lng = deg(2), deg(4)
    if ref(1) == 'S':
        lat = -lat
    if ref(3) == 'W':
        lng = -lng
    # 有些相機在「定位失敗」時會寫 0,0。那是幾內亞灣外海，不是資料。
    if abs(lat) < 0.001 and abs(lng) < 0.001:
        return None
    return (round(lat, 7), round(lng, 7))


def read_exif(path):
    """JPEG → {'gps': (lat,lng)|None, 'orient': int}。解不出來一律回預設值。

    ⚠️ **任何例外都吞掉退回預設。** 一張壞掉的 EXIF 不該讓整批照片停下來——
    退回檔名比對就好，而報表會顯示「沒讀到 GPS」，你看得見。
    """
    res = {'gps': None, 'orient': 1}
    try:
        with open(path, 'rb') as f:
            d = f.read(512 * 1024)
    except OSError:
        return res
    if d[:2] != b'\xff\xd8':
        return res
    t, i = None, 2
    while i < len(d) - 4:
        if d[i] != 0xFF:
            i += 1
            continue
        m = d[i + 1]
        if m == 0xDA:                       # SOS，之後是影像資料，沒有 metadata 了
            break
        if m == 0x01 or 0xD0 <= m <= 0xD8:  # 無長度欄位的 marker
            i += 2
            continue
        ln = struct.unpack('>H', d[i + 2:i + 4])[0]
        if m == 0xE1 and d[i + 4:i + 10] == b'Exif\x00\x00':
            t = d[i + 10:i + 2 + ln]
            break
        i += 2 + ln
    if not t or len(t) < 8:
        return res
    try:
        en = '>' if t[:2] == b'MM' else '<'
        ifd0 = _ifd(t, en, struct.unpack(en + 'I', t[4:8])[0])
        if 0x0112 in ifd0:
            res['orient'] = struct.unpack(en + 'H', t[ifd0[0x0112]:ifd0[0x0112] + 2])[0] or 1
        if 0x8825 in ifd0:
            gp = _ifd(t, en, struct.unpack(en + 'I', t[ifd0[0x8825]:ifd0[0x8825] + 4])[0])
            res['gps'] = _gps_of(t, en, gp)
    except Exception:
        pass
    return res


def pad(s, n):
    """補到顯示寬度 n。中日文字佔兩格，直接用 %-20s 會歪掉。"""
    s = str(s)
    w = sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in s)
    return s + ' ' * max(0, n - w)


def dist_m(a, b, c, d):
    """兩個經緯度之間的公尺數（haversine）。"""
    p, Rk = math.radians, 6371000.0
    return 2 * Rk * math.asin(math.sqrt(
        math.sin((p(c) - p(a)) / 2) ** 2 +
        math.cos(p(a)) * math.cos(p(c)) * math.sin((p(d) - p(b)) / 2) ** 2))


# ---------------------------------------------------------------- 影像
def pixel_size(path):
    """(寬, 高)。讀不到回 (0, 0)。"""
    r = subprocess.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path],
                       capture_output=True, text=True)
    w = h = 0
    for ln in r.stdout.splitlines():
        if 'pixelWidth:' in ln:
            w = int(ln.split(':')[1])
        elif 'pixelHeight:' in ln:
            h = int(ln.split(':')[1])
    return w, h


def compress(src, dst, orient):
    """壓成 WebP。回 (ok, 寬, 高, 訊息)。

    ⚠️ **orientation 非 1 時一定要真的把像素轉正。** cwebp 不看 EXIF 的方向標記，
    而我們輸出時又用 `-metadata none` 把 metadata 全清掉（GPS 不能跟著上網站）
    ——不轉的話照片會躺著。這個錯誤在 64px 縮圖上一眼就看得出來，不會靜默。
    """
    ext = os.path.splitext(src)[1].lower()
    tmp, note = None, ''
    work = src
    if ext in NEED_CONVERT or orient != 1:
        fd, tmp = tempfile.mkstemp(suffix='.jpg')
        os.close(fd)
        # formatOptions 100 = 中間檔不要再壓一次；真正的壓縮交給 cwebp
        cmd = ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '100']
        flip, rot = ORIENT_FIX.get(orient, (None, 0))
        if flip:
            cmd += ['--flip', flip]
            note = '（orientation %d 含鏡像，此路徑未經實照驗證）' % orient
        if rot:
            cmd += ['--rotate', str(rot)]
        if orient != 1 and not note:
            note = '（已依 orientation %d 轉正）' % orient
        cmd += [src, '--out', tmp]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 or not os.path.getsize(tmp):
            os.path.exists(tmp) and os.unlink(tmp)
            return False, 0, 0, 'sips 轉檔失敗：' + (r.stderr.strip() or '無訊息')
        work = tmp

    w, h = pixel_size(work)
    resize = []
    # **原圖比上限小就不放大**：放大只會變模糊又變大，沒有任何好處。
    # ⚠️ 一律用 `-resize <寬> 0` 交給 cwebp 保持長寬比——自己算兩邊會有捨入誤差。
    k = min(1.0, MAX_W / w, MAX_H / h)
    if k < 1.0:
        w, h = round(w * k), round(h * k)
        resize = ['-resize', str(w), '0']
    cmd = (['cwebp', '-q', str(QUALITY), '-m', str(METHOD), '-metadata', 'none']
           + resize + [work, '-o', dst])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if tmp and os.path.exists(tmp):
        os.unlink(tmp)
    if r.returncode != 0:
        return False, 0, 0, 'cwebp 失敗：' + (r.stderr.strip().splitlines() or ['無訊息'])[-1]
    return True, w, h, note


# ---------------------------------------------------------------- 配對
def match_by_name(stem, ids):
    """檔名 → id。允許少了 `pl-` 前綴、允許尾部帶 `-2` 這種序號。"""
    s = stem.lower().strip()
    for cand in (s, 'pl-' + s):
        if cand in ids:
            return cand
    s2 = re.sub(r'[-_]\d+$', '', s)
    if s2 != s:
        for cand in (s2, 'pl-' + s2):
            if cand in ids:
                return cand
    return None


def near_places(gps, places):
    """回 [(距離, 景點)]，近的在前，只留 RADIUS_M 以內。"""
    out = [(dist_m(gps[0], gps[1], p['lat'], p['lng']), p) for p in places]
    out.sort(key=lambda x: x[0])
    return [x for x in out if x[0] <= RADIUS_M], (out[0] if out else None)


# ---------------------------------------------------------------- 回寫
def write_img_fields(assign, dry):
    """把 img 寫回 places_src/*.json，回改動清單。

    ⚠️ 整檔用 json.dumps 重寫是安全的：六個檔在動手前已驗證
    round trip **逐位元組相同**（indent=2、ensure_ascii=False、結尾無換行），
    所以 diff 只會出現真正改到的那一行。日後若有人手改壞了格式，
    這裡會產生大量無關 diff——**那時要先修格式，不要改這個函式**。
    """
    changes = []
    for path in sorted(glob.glob(os.path.join(PLACES_SRC, '*.json'))):
        if os.path.basename(path).startswith('_'):
            continue
        raw = open(path, encoding='utf-8').read()
        d = json.loads(raw)
        touched = False
        for rec in d.get('places', []):
            new = assign.get(rec.get('id'))
            if new and rec.get('img', '') != new:
                changes.append((rec['id'], rec.get('img', ''), new, os.path.basename(path)))
                rec['img'] = new
                touched = True
        if touched and not dry:
            out = json.dumps(d, ensure_ascii=False, indent=2)
            if out != raw:
                open(path, 'w', encoding='utf-8').write(out)
    return changes


# ---------------------------------------------------------------- 指令
def load_places():
    if not os.path.exists(PLACES_JSON):
        sys.exit('找不到 places.json。請先跑一次：python3 build_places.py')
    d = json.load(open(PLACES_JSON, encoding='utf-8'))
    return d.get('places', [])


def has_photo(pid):
    return os.path.exists(os.path.join(PHOTO_DIR, pid + '.webp'))


def cmd_todo(places):
    """列出還沒照片的景點，按地區分組。"""
    miss = [p for p in places if not has_photo(p['id'])]
    ghost = [p for p in places if p.get('img') and not has_photo(p['id'])]
    print('景點 %d 個，已有照片 %d，還缺 %d\n' % (
        len(places), len(places) - len(miss), len(miss)))
    order = {a: i for i, a in enumerate(R.AREAS)}
    miss.sort(key=lambda p: (order.get(p.get('area'), 99), p['id']))
    cur = None
    for p in miss:
        if p.get('area') != cur:
            cur = p.get('area')
            n = sum(1 for q in miss if q.get('area') == cur)
            print('%s（%d）' % (cur or '（無地區）', n))
        print('  %s%s%s' % (pad(p['id'], 28), pad(p.get('title', ''), 26), p.get('genre', '')))
    if ghost:
        print('\n⚠ 這幾筆的 img 有填檔名，但 places/ 底下沒有那個檔（前端會破圖）：')
        for p in ghost:
            print('  %simg=%s' % (pad(p['id'], 28), p.get('img')))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC_DEFAULT, help='原圖資料夾（預設是外接硬碟那個）')
    ap.add_argument('--todo', action='store_true', help='只列出還沒照片的景點')
    ap.add_argument('--force', action='store_true', help='連已經有照片的也重壓覆蓋')
    ap.add_argument('--yes', action='store_true', help='不要停下來問')
    ap.add_argument('--dry-run', action='store_true', help='只看計畫，什麼都不寫')
    a = ap.parse_args()

    places = load_places()
    if a.todo:
        cmd_todo(places)
        return

    # ⚠️ 路徑不存在時**一定要 exit 1 並講清楚**。若只回「找到 0 張照片，完成」，
    # 那跟「全部都處理過了」在畫面上長得一模一樣——本專案最怕的那種失敗。
    if not os.path.isdir(a.src):
        sys.exit('找不到原圖資料夾：%s\n外接硬碟是不是沒接上？（或用 --src 指定別的路徑）' % a.src)
    if not shutil.which('cwebp'):
        sys.exit('找不到 cwebp。請先執行：brew install webp')
    os.path.isdir(PHOTO_DIR) or os.makedirs(PHOTO_DIR)

    ids = {p['id']: p for p in places}
    shots = sorted(f for f in os.listdir(a.src)
                   if os.path.splitext(f)[1].lower() in PHOTO_EXT and not f.startswith('.'))
    print('原圖資料夾  %s（%d 張）' % (a.src, len(shots)))
    print('景點        %d 個，已有照片 %d\n' % (
        len(places), sum(1 for p in places if has_photo(p['id']))))
    if not shots:
        print('資料夾裡沒有照片，沒事可做。')
        return

    # ── 第一輪：檔名明確指定的優先，先把 id 佔掉
    plan, blocked, skipped = {}, [], []
    claimed, by_gps = {}, []
    for f in shots:
        path = os.path.join(a.src, f)
        pid = match_by_name(os.path.splitext(f)[0], ids)
        if pid:
            claimed.setdefault(pid, []).append(f)
        else:
            by_gps.append(f)

    for pid, fs in claimed.items():
        if len(fs) > 1:
            blocked.append((', '.join(fs), '檔名都指到 %s（%s），要用哪一張？'
                            % (pid, ids[pid].get('title', '')), []))
        else:
            plan[fs[0]] = (pid, '檔名指定')

    # ── 第二輪：其餘靠 GPS
    for f in by_gps:
        path = os.path.join(a.src, f)
        ex = read_exif(path)
        if not ex['gps']:
            blocked.append((f, '讀不到 GPS（截圖、關掉定位、或非 JPEG 的格式都會這樣）'
                               '　→ 把檔名改成景點 id 再跑一次', []))
            continue
        near, closest = near_places(ex['gps'], places)
        # ⚠️ **歧義要拿「範圍內的全部景點」判，不可以先把已被檔名佔用的濾掉。**
        # 濾掉會讓兩個候選變成一個，歧義憑空消失、程式自信地配給剩下那個
        # ——2026-08-20 實測就是這樣把東京鐵塔的照片配給了 233 公尺外的增上寺，
        # 而報表上長得跟正確配對一模一樣。**先判歧義，再判佔用。**
        if len(near) == 1:
            pid = near[0][1]['id']
            if pid in claimed:
                blocked.append((f, 'GPS 對到 %s（%s），但已經有另一張的檔名指定給它'
                                   '　→ 兩張要用哪一張？'
                                % (pid, ids[pid].get('title', '')), []))
            else:
                plan[f] = (pid, 'GPS %.0fm' % near[0][0])
        elif len(near) == 0:
            if closest:
                d, p = closest
                tip = ('最近的景點在 %.1f 公里外（%s）　→ 這張不在收錄範圍內？'
                       '或那個景點還沒加進 places_src' % (d / 1000, p.get('title', '')))
            else:
                tip = '找不到任何景點可以比對'
            blocked.append((f, tip, []))
        else:
            blocked.append((f, '%d 公尺內有 %d 個景點，分不出來　→ 把檔名改成其中一個 id'
                            '（例如 %s%s）再跑一次'
                            % (RADIUS_M, len(near), near[0][1]['id'],
                               os.path.splitext(f)[1]), near[:4]))

    # ── 同一個 id 被兩張 GPS 對到 → 兩張都擋下來
    seen = {}
    for f, (pid, why) in list(plan.items()):
        seen.setdefault(pid, []).append(f)
    for pid, fs in seen.items():
        if len(fs) > 1:
            for f in fs:
                plan.pop(f, None)
            blocked.append((', '.join(sorted(fs)),
                            '都對到 %s（%s），要用哪一張？　→ 把要用的那張改名成 %s.jpg'
                            % (pid, ids[pid].get('title', ''), pid), []))

    # ── 已經有照片的，跳過但要講出來
    if not a.force:
        for f in list(plan):
            pid = plan[f][0]
            if has_photo(pid):
                kb = os.path.getsize(os.path.join(PHOTO_DIR, pid + '.webp')) / 1024
                skipped.append((f, pid, ids[pid].get('title', ''), kb))
                plan.pop(f)

    # ── 印計畫
    if plan:
        print('【要處理】%d 張' % len(plan))
        for f in sorted(plan):
            pid, why = plan[f]
            print('  %s→ %s%s（%s）'
                  % (pad(f, 24), pad(pid, 26), pad(ids[pid].get('title', ''), 24), why))
        print()
    if skipped:
        print('【略過：該景點已有照片】%d 張' % len(skipped))
        for f, pid, title, kb in sorted(skipped):
            print('  %s→ %s現有 %.0f KB' % (pad(f, 24), pad(pid, 26), kb))
        print('  要換成新的請加 --force，或先把 places/ 底下那個檔刪掉\n')
    if blocked:
        print('【需要你處理】%d 筆' % len(blocked))
        for f, why, cands in blocked:
            print('  %s' % f)
            print('     %s' % why)
            for d, p in cands:
                print('        %5.0fm  %s%s' % (d, pad(p['id'], 26), p.get('title', '')))
        print()
    if not plan:
        print('沒有要壓縮的照片。')
        return
    if a.dry_run:
        print('（--dry-run，到此為止，什麼都沒寫）')
        return
    if not a.yes:
        if not sys.stdin.isatty():
            sys.exit('不是互動環境，請加 --yes 確認要執行。')
        if input('要開始壓縮嗎？[y/N] ').strip().lower() not in ('y', 'yes'):
            print('取消。')
            return
        print()

    # ── 壓縮
    print('【完成】')
    assign, big, fails = {}, [], []
    for f in sorted(plan):
        pid, why = plan[f]
        src = os.path.join(a.src, f)
        dst = os.path.join(PHOTO_DIR, pid + '.webp')
        ok, w, h, note = compress(src, dst, read_exif(src)['orient'])
        if not ok:
            fails.append((f, note))
            print('  ✗ %s%s' % (pad(f, 24), note))
            continue
        before = os.path.getsize(src) / 1048576
        after = os.path.getsize(dst) / 1024
        assign[pid] = pid + '.webp'
        print('  %s%5.1f MB → %5.0f KB   %d×%d %s'
              % (pad(pid + '.webp', 30), before, after, w, h, note))
        if after > WARN_KB:
            big.append((pid, after))
        ar = max(w, h) / min(w, h) if min(w, h) else 1
        if ar >= AR_WARN:
            cut = (1 - min(w, h) / max(w, h)) * 100
            print('     ⚠ %s %.2f:1，正方形縮圖會切掉約 %.0f%%——先確認 64px 下還認得出來'
                  % ('直式' if h > w else '橫式', ar, cut))
    if big:
        print('\n  這幾張超過 %d KB，想更小的話把 QUALITY 調低重跑（--force）：' % WARN_KB)
        for pid, kb in big:
            print('    %s%.0f KB' % (pad(pid, 28), kb))

    # ── 回寫 places_src
    changes = write_img_fields(assign, a.dry_run)
    if changes:
        print('\n【places_src 已更新】')
        for pid, old, new, fn in changes:
            print('  %s%simg: "%s" → "%s"' % (pad(fn, 20), pad(pid, 28), old, new))
    if fails:
        print('\n⚠ %d 張壓縮失敗，上面有原因。' % len(fails))

    print('\n下一步：python3 build_places.py 確認，然後把 places/ 與 places_src/ 一起 commit')


if __name__ == '__main__':
    main()
