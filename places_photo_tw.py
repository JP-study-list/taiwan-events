#!/usr/bin/env python3
"""
景點照片（單位 H-4）：手機挑圖頁的資料產生與結果匯回。

    python3 places_photo_tw.py build            # 候選 → 縮圖 → places_src/_h4_photo/data/aNN.json
    python3 places_photo_tw.py export <匯出資料夾>  # 挑圖頁資料庫匯出 → _photopick.json／_photoskip.json

候選照片由 `pick_photos.py fetch`（座標）＋ `fetch --wiki`（名字，中文維基優先）抓進 `_photocache.json`。
日本版的挑圖頁是本機網頁（`pick_photos.py serve`）；台灣版改成 claude.ai 上的網頁，使用者用手機挑，
所以縮圖要先下載、縮小、包進資料檔（claude.ai 的網頁不能直接顯示外部網站的圖片）。

⚠️ 網頁存的是**檔名**，不是候選的索引：`_photopick.json` 存索引，而候選清單重抓時順序會變，
   存索引等於讓既有選擇靜默指到另一張（pick_photos.py 的 cmd_fetch_wiki 同一條教訓）。
   `export` 才把檔名換回索引，換不回來的（候選已經不在）會列出來、不寫。
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from glob import glob

import pick_photos as PP

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'places_src', '_h4_photo')
DATA = os.path.join(OUT, 'data')            # ⚠️ 縮圖包，不進版控（.gitignore）
THUMBS = os.path.join(OUT, '_thumbs')       # 下載快取，不進版控
MAX_CANDS = 12      # 一個景點最多給看幾張（手機上三欄四列）
THUMB_W = 320       # 縮圖寬：手機三欄約 115px（×2～3 倍螢幕），放大看時也還勉強；再大整包會超過 artifact 的 64MB
QUALITY = 55

# 地區按鈕的順序：北到南、本島再離島。清單上沒有的接在後面（不會消失）。
AREA_ORDER = ['台北', '新北', '基隆', '桃園', '新竹', '苗栗', '台中', '彰化', '南投', '雲林',
              '嘉義', '台南', '高雄', '屏東', '宜蘭', '花蓮', '台東', '澎湖', '金門', '馬祖']


def _areas(ps):
    have = {p['area'] for p in ps}
    return [a for a in AREA_ORDER if a in have] + sorted(have - set(AREA_ORDER))


def _order(cands):
    """維基（名字找到＝就是它）排前面，附近的排後面；維基第一張是條目主圖。"""
    wiki = [c for c in cands if c.get('src') == 'wiki']
    geo = [c for c in cands if c.get('src') != 'wiki']
    return (wiki + geo)[:MAX_CANDS]


def _thumb_file(c):
    import hashlib
    return os.path.join(THUMBS, hashlib.md5(c['file'].encode()).hexdigest() + '.webp')


def _get_thumb(c):
    dst = _thumb_file(c)
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return True
    url = c.get('thumb')
    if not url:
        return False
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': PP.UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            with tempfile.NamedTemporaryFile(suffix='.img', delete=False) as t:
                t.write(raw)
            try:
                r = subprocess.run(['cwebp', '-quiet', '-q', str(QUALITY), '-resize', str(THUMB_W), '0',
                                    t.name, '-o', dst], capture_output=True)
                if r.returncode != 0:
                    # PNG／奇怪的 JPEG cwebp 讀不了 → 先過一手 sips
                    j = t.name + '.jpg'
                    subprocess.run(['sips', '-s', 'format', 'jpeg', t.name, '--out', j], capture_output=True)
                    r = subprocess.run(['cwebp', '-quiet', '-q', str(QUALITY), '-resize', str(THUMB_W), '0',
                                        j, '-o', dst], capture_output=True)
                    os.path.exists(j) and os.remove(j)
            finally:
                os.remove(t.name)
            return r.returncode == 0
        except Exception as e:
            if '429' in str(e):
                time.sleep(5 * (attempt + 1))
                continue
            print('  [warn] 縮圖失敗 %s：%s' % (c['file'][:40], e), file=sys.stderr)
            return False
        finally:
            time.sleep(0.25)
    return False


def cmd_build():
    cache = PP.load_json(PP.CACHE, {})
    ps = PP.places()
    os.makedirs(THUMBS, exist_ok=True)
    os.makedirs(DATA, exist_ok=True)
    todo = [c for p in ps for c in _order(cache.get(p['id'], []))]
    need = [c for c in todo if not os.path.exists(_thumb_file(c))]
    print('候選 %d 張，要下載縮圖 %d 張' % (len(todo), len(need)))
    done = [0]

    def job(c):
        ok = _get_thumb(c)
        done[0] += 1
        if done[0] % 100 == 0:
            print('  %d/%d' % (done[0], len(need)), flush=True)
        return ok
    with ThreadPoolExecutor(2) as ex:       # Wikimedia 要客氣：兩條就好
        list(ex.map(job, need))

    ledger = PP.load_json(PP.WIKI_LEDGER, {})
    areas = _areas(ps)
    index = []
    n_sug = n_pick = n_none = 0
    for k, a in enumerate(areas):
        rows = []
        for p in [x for x in ps if x['area'] == a]:
            cs = []
            for c in _order(cache.get(p['id'], [])):
                f = _thumb_file(c)
                if not os.path.exists(f):
                    continue
                cs.append({'f': c['file'], 's': c.get('src') or 'geo', 'n': c.get('note', ''),
                           'lic': c.get('lic', ''), 'by': c.get('by', '')[:60], 'u': c.get('page', ''),
                           'i': 'data:image/webp;base64,' + base64.b64encode(open(f, 'rb').read()).decode()})
            # 建議：**維基條目的代表照片**（Wikidata P18 或條目主圖，`fetch --wiki` 記在 ledger 的 main），
            # 而且條目座標沒有離太遠（沒有 ⚠）。
            # ⚠️⚠️ 不可以用「排第一的維基候選」：條目沒有代表照片（或太小被濾掉）時，排第一的是分類裡
            # 按字母第一張——2026-09-26 實測 183 筆建議裡 40 筆是這種，總統參拜的新聞照、地圖、
            # 巴塞隆納的街頭活動、烏來的溫泉都被當成建議，而使用者沒有動它們就送出了。
            main = set(ledger.get(p['id'], {}).get('main') or [])
            sug = next((c['f'] for c in cs if c['s'] == 'wiki' and c['f'] in main and '⚠' not in c['n']), None)
            if sug:        # 代表照片排第一張，與「先幫你選的」打勾那格一致
                cs.sort(key=lambda c: c['f'] != sug)
            n_sug += bool(sug)
            n_pick += bool(cs) and not sug
            n_none += not cs
            rows.append({'id': p['id'], 't': p['title'], 'g': p.get('genre', ''), 'sug': sug, 'c': cs})
        key = 'a%02d' % k
        PP.save_json(os.path.join(DATA, key + '.json'), {'area': a, 'places': rows})
        index.append({'k': key, 'area': a, 'n': len(rows),
                      'sug': sum(1 for r in rows if r['sug']),
                      'pick': sum(1 for r in rows if r['c'] and not r['sug']),
                      'todoIds': [r['id'] for r in rows if r['c'] and not r['sug']],
                      'none': sum(1 for r in rows if not r['c'])})
    PP.save_json(os.path.join(DATA, 'index.json'), index)
    size = sum(os.path.getsize(f) for f in glob(os.path.join(DATA, '*.json')))
    print('寫好 %s（%d 個地區，共 %.1f MB）' % (DATA, len(index), size / 1e6))
    print('先幫你選 %d／要你挑 %d／沒有候選 %d' % (n_sug, n_pick, n_none))


def cmd_export(src):
    """挑圖頁資料庫（`pick/aNN`：{p:{景點 id: 檔名 | "-"}}）→ _photopick.json（索引）＋ _photoskip.json。
    「-」＝都不要（這輪看過沒挑，候選變多時 pick_photos 會讓它自己回來）。"""
    cache = PP.load_json(PP.CACHE, {})
    picks = PP.load_json(PP.PICKS, {})
    skip = PP.load_json(PP.SKIP, {})
    got = {}
    for f in glob(os.path.join(src, '**', 'a*.json'), recursive=True):
        doc = json.load(open(f, encoding='utf-8'))
        got.update((doc.get('data', doc) or {}).get('p', {}))
    # 使用者沒動過的「先幫你選」照樣算數（頁面上它就是選著的樣子）；動過的以使用者為準。
    n_sug = 0
    for f in glob(os.path.join(DATA, 'a*.json')):
        for r in json.load(open(f, encoding='utf-8'))['places']:
            if r['sug'] and r['id'] not in got:
                got[r['id']] = r['sug']
                n_sug += 1
    n_pick = n_skip = 0
    miss = []
    today = time.strftime('%Y-%m-%d')
    for pid, v in got.items():
        if v == '-':
            skip[pid] = {'d': today, 'n': len(cache.get(pid, []))}
            picks.pop(pid, None)
            n_skip += 1
            continue
        idx = next((i for i, c in enumerate(cache.get(pid, [])) if c['file'] == v), None)
        if idx is None:
            miss.append('%s：%s' % (pid, v))
            continue
        picks[pid] = idx
        skip.pop(pid, None)
        n_pick += 1
    PP.save_json(PP.PICKS, picks)
    PP.save_json(PP.SKIP, skip)
    print('選了 %d 筆（其中沒動過的建議 %d）、都不要 %d 筆 → %s' % (n_pick, n_sug, n_skip, PP.PICKS))
    if miss:
        print('⚠️ 候選裡找不到這些檔名（候選重抓過？），沒寫：\n  ' + '\n  '.join(miss))
    print('接著：python3 pick_photos.py apply → python3 build_photos.py --src _photodl')


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'build':
        cmd_build()
    elif len(sys.argv) == 3 and sys.argv[1] == 'export':
        cmd_export(sys.argv[2])
    else:
        sys.exit(__doc__)
