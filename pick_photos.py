#!/usr/bin/env python3
"""景點照片挑圖工具（2026-09-02，本機用，不上線）。

Commons 那條（三步）：
    python3 pick_photos.py fetch    # ① 座標：Commons 上 300m 內的照片
    python3 pick_photos.py fetch --wiki   # ②【2026-09-04 加】名字：維基條目主圖＋Commons 分類
    python3 pick_photos.py serve    # 開網頁挑圖，點縮圖就選好了
    python3 pick_photos.py apply    # ③ 下載選中的圖 + 產出處檔
    python3 pick_photos.py skip     # ④ 這輪看過沒挑的，下次不再列出（候選變多會自己回來）
    python3 pick_photos.py hold     # ⑤【2026-09-16 加】這一批不要再問我（預設只預覽，--yes 才鎖）
    python3 pick_photos.py unhold   #    放回來（不帶 id ＝全部）
    python3 build_photos.py --src _photodl

自己拍的那條（2026-09-02 加的，**不必改檔名**）：
    python3 pick_photos.py assign   # 開網頁：一張照片一列，點它是哪個景點
    python3 build_photos.py --src _photoin

⚠️ `assign` 存在的理由很具體：`build_photos.py` 靠 GPS 找 500m 內的景點、
   **剛好一個才採用**，而景點很密集——實測還沒有照片的 49 個裡有 **22 個**
   500m 內還有別的景點（大阪市立長居植物園 ↔ 自然史博物館 **0m**、
   墨田水族館 ↔ 晴空塔 0m、明治神宮 ↔ 代代木公園 94m）。
   原本的解法是「把檔名改成 id」，但那是 22 次手動改名。
   這個模式改成**點一下**，然後由程式複製成正確的檔名放進 `_photoin/`。
   ⚠️ **複製不是搬移**：原圖是唯一的備份（WebP 壓過回不去），絕不動它。

⚠️ 候選是「照片自己的座標落在景點 300m 內」找出來的，不是「拍的是這個景點」。
   300m 內有土產店、有隔壁的神社（實測清水寺撈到門前商店街、根津神社撈到相機店），
   所以**一定要人眼挑**——這支工具的全部意義就是把候選收斂到十來張讓你挑得動。
   放寬半徑會開始撈到隔壁景點，同 build_photos.py 的 GPS 配對（東京鐵塔↔增上寺 31m）。

⚠️ 這支只讀 places.json，不改它。被選中的授權資訊寫 places/_credits.json，
   放在 places/ 底下是刻意的——Cloudflare 的組建命令是 `cp -r ... places dist/`，
   整個資料夾一起複製，所以**不必動組建命令**（地雷 #14 最容易犯的新錯）。
"""

import html
import io
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PLACES = os.path.join(HERE, 'places.json')
CACHE = os.path.join(HERE, 'places_src', '_photocache.json')
PICKS = os.path.join(HERE, 'places_src', '_photopick.json')
CREDITS = os.path.join(HERE, 'places', '_credits.json')
DL_DIR = os.path.join(HERE, '_photodl')
IN_DIR = os.path.join(HERE, '_photoin')       # assign 的產出（複製過來、改好名）
ASSIGN = os.path.join(HERE, 'places_src', '_photoassign.json')
# 「這一筆我看過了，沒有想要的」——`skip` 寫進來，挑圖網頁預設不再列出。
# ⚠️ **一定要連當時的候選張數一起記**：日後多了新來源（或維基那條再撈一輪），
# 候選變多時要讓它**自己回到清單上**。只記 id 的話，那個景點就永遠消失了
# ——而畫面上完全看不出來，同「絕不自動從收藏移除」那條的失敗方向。
SKIP = os.path.join(HERE, 'places_src', '_photoskip.json')
# 「這個景點根本不要收」——挑圖網頁上那顆廢棄鈕寫進來，`apply-trash` 才真的動資料。
# ⚠️ **與 SKIP 是兩件完全不同的事，不要合併**：skip 是「這輪沒挑到照片，景點留著」，
# trash 是「這個景點不收」。混成一個的話，候選變多時 skip 會自己回到清單上，
# 而**被廢棄的也會跟著回來**——那是使用者已經決定過的事又被問一次。
TRASH = os.path.join(HERE, 'places_src', '_placetrash.json')
# 「這一批不要再問我」——`hold` 寫進來，挑圖網頁一律不列出，**候選變多也不回來**。
# ⚠️⚠️ **與 SKIP 分成兩個檔是刻意的，不要合併。** `cmd_skip` 是整筆覆寫
# `skip[pid] = {...}`，旗標塞進同一筆的話，下一次跑 `skip` 就把它**靜默洗掉**
# ——那正是單位 い-2 修過的坑（`pick()` 整個覆寫 className 會洗掉 trashed）。
# ⚠️ 兩者的意思也真的不同：skip 是「這輪看過沒挑」（**候選變多會回來**），
# hold 是「這一批不要再問」（**不會回來**）。同 skip 與 trash 刻意不合併的理由。
# ⚠️ **`n` 存的是「鎖的那一刻有幾張候選」**，只當 `_hold_report` 的基準；
# 它**不再影響要不要列出**（那正是 hold 與 skip 的差別），只影響提醒那一行。
# ⚠️ 這推翻了單位 え 的「不要永久略過」——使用者 2026-09-16 改了決定，
# 但**只改一半**：不自動回來，代價改由 `fetch` 收尾那一行提醒承接。
HOLD = os.path.join(HERE, 'places_src', '_photohold.json')

API = 'https://commons.wikimedia.org/w/api.php?'
UA = 'taiwan-events-photo-picker/1.0 (https://github.com/JP-study-list/taiwan-events)'
RADIUS_M = 300      # 放寬會開始撈到隔壁景點，見檔頭
MIN_W = 1200        # 瀑布流目標寬 900（IMG_W），留一點餘裕
TOP_N = 8           # 每個景點最多列幾張，多了挑不動
PORT = 8901

# ── 第二種來源：日文維基／Wikidata（2026-09-04 加）─────────────────
JAWIKI = 'https://ja.wikipedia.org/w/api.php'
# 台灣版（2026-09-26，單位 H-4）：先用中文名查中文維基，查不到才用日文名查日文維基。
ZHWIKI = 'https://zh.wikipedia.org/w/api.php'
WIKIDATA = 'https://www.wikidata.org/w/api.php'
WIKI_LEDGER = os.path.join(HERE, 'places_src', '_photowiki.json')
WIKI_MAX = 10        # 一個景點最多留幾張維基來源的候選
WIKI_CAT_MAX = 40    # 一個 Commons 分類最多看幾個檔（大分類幾百張，看不完也挑不動）
WIKI_FAR_KM = 1.0    # 超過就在卡片上標警告——**只標不擋**，見 cmd_fetch_wiki 的說明
# ⚠️⚠️ **但差太遠的一律不收**：那已經不是「座標不準」，是**配到另一個地方**。
# 2026-09-04 實跑抓到活的：站上「鎌倉長谷寺」配到**奈良的**長谷寺條目（差 341km），
# 十張候選一字不差全是奈良那座——**挑下去就是「在地圖上跟正確的長得一模一樣」的錯誤**。
# 50km 是量出來的門檻：我們自己的 approx 最壞約 7.7km，而條目本身涵蓋範圍大的
# （箱根海賊船 14.1km ＝整條航線）也還在 15km 以內。
WIKI_REJECT_KM = 50.0


def wapi(base, params):
    p = dict(params, format='json', formatversion='2')
    req = urllib.request.Request(base + '?' + urllib.parse.urlencode(p),
                                 headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def km_between(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def api(params):
    p = dict(params, format='json', formatversion='2')
    req = urllib.request.Request(API + urllib.parse.urlencode(p), headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def save_json(path, data):
    os.path.isdir(os.path.dirname(path)) or os.makedirs(os.path.dirname(path))
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def places():
    return load_json(PLACES, {}).get('places', [])


def strip_tags(s):
    """Commons 的 Artist 欄位是 HTML（多半是一個 <a>），出處頁要純文字。"""
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', s or '')).strip()


# ─────────────────────────────────────────────────────── fetch

def cand_of(page):
    ii = (page.get('imageinfo') or [{}])[0]
    w, h = ii.get('width') or 0, ii.get('height') or 0
    if w < MIN_W or not h:
        return None
    if not page['title'].lower().endswith(('.jpg', '.jpeg', '.png')):
        return None
    # 極端全景直接剔掉：瀑布流的長寬比夾在 0.72~1.38，超寬的放進去很醜
    # （大阪城撈到的兩張 panoramio 全景就是這種，天守閣小小一顆）
    r = w / h
    if r > 2.0 or r < 0.4:
        return None
    # ⚠️ 沒有任何中繼資料時 API 回的是空陣列 `[]` 而不是 `{}`（2026-09-26 台灣版實跑撞到，整支中止）
    em = ii.get('extmetadata') or {}
    if not isinstance(em, dict):
        em = {}
    return {
        'file': page['title'][5:],           # 去掉 "File:"
        'w': w, 'h': h,
        'thumb': ii.get('thumburl'),
        'page': ii.get('descriptionurl'),
        'lic': (em.get('LicenseShortName') or {}).get('value', ''),
        'by': strip_tags((em.get('Artist') or {}).get('value', '')),
    }


def cmd_fetch():
    cache = load_json(CACHE, {})
    ps = places()
    todo = [p for p in ps if p['id'] not in cache]
    print('景點 %d 筆，已有快取 %d，這次要查 %d 筆' % (len(ps), len(ps) - len(todo), len(todo)))
    for i, p in enumerate(todo, 1):
        try:
            d = api({'action': 'query', 'generator': 'geosearch',
                     'ggscoord': '%s|%s' % (p['lat'], p['lng']),
                     'ggsradius': RADIUS_M, 'ggslimit': 50, 'ggsnamespace': 6,
                     'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata',
                     'iiurlwidth': 400,
                     'iiextmetadatafilter': 'LicenseShortName|Artist'})
        except Exception as e:
            # ⚠️ 查詢失敗不寫快取——寫了就等於永久判定「這個景點沒照片」，
            #    下次重跑本身就是重試（同 gsi_search／osm_poi_search 那條）
            print('  [warn] %s 查詢失敗：%s' % (p['title'], e), file=sys.stderr)
            continue
        cands = [c for c in (cand_of(pg) for pg in d.get('query', {}).get('pages', [])) if c]
        cands.sort(key=lambda c: -c['w'])
        # ⚠️ **維基那條的候選要留著、而且要留在後面。** 直接指派會有兩個後果：
        # ①`fetch --wiki` 撈到的整批消失 ②既有選擇是**索引**（`_photopick.json`
        # 實測 128 筆全是 int），順序一動就靜默指到另一張照片。
        keep_wiki = [c for c in cache.get(p['id'], []) if c.get('src') == 'wiki']
        cache[p['id']] = cands[:TOP_N] + keep_wiki
        print('%3d/%d %-24s %d 張' % (i, len(todo), p['title'][:22], len(cands[:TOP_N])), flush=True)
        time.sleep(0.35)
    save_json(CACHE, cache)
    empty = [p['title'] for p in ps if not cache.get(p['id'])]
    print('\n寫好 %s' % CACHE)
    if empty:
        print('⚠️ %d 筆在 %dm 內找不到候選（這幾筆就留白，放寬半徑只會撈到隔壁）：' % (len(empty), RADIUS_M))
        for t in empty:
            print('   -', t)
    _hold_report(cache)


# ───────────────────────────────────────────── fetch --wiki（第二種來源）

def _jawiki_batch(titles, base=JAWIKI):
    """精確標題 → 條目。⚠️⚠️ **絕對不可以改成全文搜尋**（地雷 #3d）：
    維基的搜尋「一定會給你最像的那個」——實測查「池袋ロフト」回澀谷總店、
    查「横浜タカシマヤ」回名古屋店。而這批資料裡就有現成的陷阱：
    **奈良的長谷寺與站上鎌倉的長谷寺同名**，猜錯的後果是一張別的地方的照片
    掛在這個景點上，**在地圖上跟正確的長得一模一樣**。
    `redirects=1` 是安全的（那是維基自己維護的同義詞，不是相似度猜測）。"""
    out = {}
    for k in range(0, len(titles), 40):
        batch = titles[k:k + 40]
        d = wapi(base, {'action': 'query', 'titles': '|'.join(batch), 'redirects': 1,
                          'prop': 'coordinates|pageimages|pageprops',
                          'piprop': 'name', 'ppprop': 'wikibase_item'})
        q = d.get('query', {})
        norm = {n['from']: n['to'] for n in q.get('normalized', [])}
        redir = {n['from']: n['to'] for n in q.get('redirects', [])}
        pages = {pg['title']: pg for pg in q.get('pages', [])}
        for t in batch:
            t2 = redir.get(norm.get(t, t), norm.get(t, t))
            pg = pages.get(t2)
            # ⚠️ **查無此條目時 API 回的是一個 `missing: true` 的物件，不是空的。**
            # 直接往下傳的話，`if not pg` 這種判斷會把它當成「找到了」，於是
            # ledger 裡會記著一個有標題、卻永遠 0 張的假條目——**看起來只像
            # 「這個景點維基上沒有照片」，而其實是根本沒有這個條目**。
            out[t] = None if (not pg or pg.get('missing')) else pg
        time.sleep(0.35)
    return out


def _wikidata_batch(qids):
    out = {}
    for k in range(0, len(qids), 45):
        d = wapi(WIKIDATA, {'action': 'wbgetentities', 'ids': '|'.join(qids[k:k + 45]),
                            'props': 'claims'})
        out.update(d.get('entities', {}))
        time.sleep(0.35)
    return out


def _claim(ent, prop):
    try:
        return ent['claims'][prop][0]['mainsnak']['datavalue']['value']
    except Exception:
        return None


def _files_info(titles):
    """一批 Commons 檔名 → 候選（沿用 cand_of 的同一把尺：≥1200px、jpg/png、長寬比）。"""
    out = {}
    titles = list(dict.fromkeys(titles))
    for k in range(0, len(titles), 40):
        try:
            d = api({'action': 'query', 'titles': '|'.join(titles[k:k + 40]),
                     'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata',
                     'iiurlwidth': 400,
                     'iiextmetadatafilter': 'LicenseShortName|Artist'})
        except Exception as e:
            print('  [warn] 檔案資訊查詢失敗：%s' % e, file=sys.stderr)
            continue
        for pg in d.get('query', {}).get('pages', []):
            c = cand_of(pg)
            if c:
                out[pg['title']] = c
        time.sleep(0.35)
    return out


def cmd_fetch_wiki():
    """② 第二種來源：**用名字找「這就是它」的照片**，而不是用座標找「這附近」。

    ⚠️⚠️ **這條路存在的理由**：原本的 geosearch 同時漏掉兩件事——
    ①**沒打 GPS 標記的照片一律看不到**（Commons 上大量好照片沒有座標，
    但分類分得好好的）②**問到的是「附近的東西」不是「這個東西」**
    （實測中部電力 MIRAI TOWER 六張全是附近餐廳的醬料照、
    Sky Promenade 撈到消防栓與機車）。

    **2026-09-04 實測命中率**（那 132 筆後台景點）：84% 找得到條目、
    83% 有主圖或 Commons 分類；**原本 0～2 張候選的 17 筆救回 15 筆**。
    分類平均 42 張（抽 10 個），主圖抽驗 12 張有 10 張 ≥1200px。

    ⚠️⚠️ **新候選一律接在既有候選的「後面」，不可以插到前面。**
    `_photopick.json` 存的是**索引**（實測 128 筆全是 int），插到前面會讓
    **每一筆既有的選擇靜默指到另一張照片**——而挑圖網頁上看起來完全正常。

    ⚠️ **座標只用來標警告、不用來否決**（`WIKI_FAR_KM`）。2026-09-04 量過：
    條目座標離我們超過 1km 的 7 筆裡有 **5 筆是我們自己的 `approx`**
    （海之見杜 7.7km、大久野島 4.6km），**誤差在我們這邊**。
    照「>1km 就不採用」去做，會剛好把最需要照片的那幾筆擋掉。
    """
    cache = load_json(CACHE, {})
    ledger = load_json(WIKI_LEDGER, {})
    ps = places()
    # ⚠️ **「問過但沒有」一定要記下來**（ledger），否則每次重跑都會為同一批
    #    沒有條目的景點重打一次 API。候選清單本身當不了這個帳——它是空的。
    todo = [p for p in ps if p['id'] not in ledger]
    # `--limit N` 只為了先小跑一段確認接線對不對（ledger 會記住，下次接著跑）。
    if '--limit' in sys.argv:
        todo = todo[:int(sys.argv[sys.argv.index('--limit') + 1])]
    print('景點 %d 筆，已問過 %d，這次要問 %d 筆'
          % (len(ps), len(ledger), len(todo)))
    if not todo:
        return

    # 台灣版：中文名 → 中文維基優先；查不到的才拿日文名問日文維基。
    # 鍵用「語言:標題」，免得中日同形的名字（博物館那種）撞在一起。
    zh = _jawiki_batch([p['title'] for p in todo], ZHWIKI)
    miss = [p for p in todo if not zh.get(p['title'])]
    ja = _jawiki_batch([p.get('title_ja') or p['title'] for p in miss]) if miss else {}
    titles, pages = [], {}
    for p in todo:
        if zh.get(p['title']):
            k = 'zh:' + p['title']; pages[k] = zh[p['title']]
        else:
            t = p.get('title_ja') or p['title']
            k = 'ja:' + t; pages[k] = ja.get(t)
        titles.append(k)
    qids = [ (pages.get(t) or {}).get('pageprops', {}).get('wikibase_item')
             for t in titles ]
    ents = _wikidata_batch([q for q in qids if q])
    print('  找到條目 %d／%d' % (sum(1 for t in titles if pages.get(t)), len(titles)))

    n_add = 0
    for p, t in zip(todo, titles):
        pg = pages.get(t)
        rec = {'title': t, 'article': None, 'qid': None, 'cat': None,
               'dist_km': None, 'n': 0}
        if not pg:
            ledger[p['id']] = rec
            continue
        rec['article'] = t[:3] + pg['title']
        qid = (pg.get('pageprops') or {}).get('wikibase_item')
        rec['qid'] = qid
        ent = ents.get(qid or '', {})
        # 座標：條目自己的優先，沒有就用 Wikidata 的 P625（實測 111 筆裡 108 筆驗得到）
        co = (pg.get('coordinates') or [{}])[0]
        lat, lng = co.get('lat'), co.get('lon')
        if lat is None:
            v = _claim(ent, 'P625')
            if v:
                lat, lng = v['latitude'], v['longitude']
        if lat is not None and isinstance(p.get('lat'), float):
            rec['dist_km'] = round(km_between(p['lat'], p['lng'], lat, lng), 2)

        # ⚠️ 差太遠＝配到另一個地方，整筆不收（見 WIKI_REJECT_KM）
        if rec['dist_km'] is not None and rec['dist_km'] > WIKI_REJECT_KM:
            rec['rejected'] = '座標差 %.0fkm，判定配到別的地方' % rec['dist_km']
            ledger[p['id']] = rec
            print('%-24s ✗ %s（%s）' % (p['title'][:22], rec['rejected'], rec['article']),
                  flush=True)
            continue

        want = []
        p18 = _claim(ent, 'P18')
        if p18:
            want.append('File:' + p18)
        elif pg.get('pageimage'):
            want.append('File:' + pg['pageimage'])
        cat = _claim(ent, 'P373')
        rec['cat'] = cat
        if cat:
            try:
                d = api({'action': 'query', 'list': 'categorymembers',
                         'cmtitle': 'Category:' + cat, 'cmtype': 'file',
                         'cmlimit': WIKI_CAT_MAX})
                want += [m['title'] for m in d.get('query', {}).get('categorymembers', [])]
                time.sleep(0.35)
            except Exception as e:
                # 查詢失敗不記進 ledger（下一輪本身就是重試），同 cmd_fetch 那條
                print('  [warn] %s 分類查詢失敗：%s' % (p['title'], e), file=sys.stderr)
                continue

        info = _files_info(want)
        note = '維基「%s」' % rec['article']
        if rec['dist_km'] is not None and rec['dist_km'] > WIKI_FAR_KM:
            note += ' ⚠座標差 %.1fkm' % rec['dist_km']
        cands = []
        have = {c['file'] for c in cache.get(p['id'], [])}
        for ft in want:                      # 依 want 的順序＝主圖排第一
            c = info.get(ft)
            if not c or c['file'] in have:
                continue
            have.add(c['file'])
            c['src'] = 'wiki'
            c['note'] = note
            cands.append(c)
            if len(cands) >= WIKI_MAX:
                break
        # ⚠️ 接在後面，不插前面（見 docstring）
        cache[p['id']] = cache.get(p['id'], []) + cands
        rec['n'] = len(cands)
        ledger[p['id']] = rec
        n_add += len(cands)
        print('%-24s %s %d 張%s' % (p['title'][:22], rec['article'][:18],
                                    len(cands), ' ' + note.split('⚠')[1] if '⚠' in note else ''),
              flush=True)

    save_json(CACHE, cache)
    save_json(WIKI_LEDGER, ledger)
    got = [p for p in ps if ledger.get(p['id'], {}).get('n')]
    print('\n新增 %d 張候選，涵蓋 %d 個景點' % (n_add, len(got)))
    # ⚠️ 只數「問過的」——把還沒問到的也算進來，這個數字會在跑到一半時
    #    看起來像「愈跑愈糟」。
    print('問過的景點裡，兩種來源都沒有照片的：%d'
          % sum(1 for p in ps if p['id'] in ledger and not cache.get(p['id'])))
    far = [(p, ledger[p['id']]) for p in ps
           if ledger.get(p['id'], {}).get('dist_km') is not None
           and ledger[p['id']]['dist_km'] > WIKI_FAR_KM]
    if far:
        print('\n⚠️ 條目座標離我們 >%.0fkm 的 %d 筆——**多半是我們的座標不準**'
              '（approx），但也可能是配到別的地方，挑圖時卡片上會標出來：' % (WIKI_FAR_KM, len(far)))
        for p, r in far:
            print('   %-22s %5.2f km  %s' % (p['title'][:20], r['dist_km'], r['article']))
    # ⚠️ **同一個條目被兩個景點認領，至少有一個是錯的**（同名或分店）。
    # 距離那道擋得掉遠的，擋不掉「兩個都在附近」的情況，所以這裡再數一次。
    from collections import Counter
    arts = Counter(r['article'] for r in ledger.values()
                   if r.get('article') and r.get('n'))
    dup = [a for a, n in arts.items() if n > 1]
    if dup:
        print('\n⚠️⚠️ 同一個維基條目被多個景點認領（至少一個是錯的，挑圖前先看）：')
        for a in dup:
            who = [k for k, r in ledger.items() if r.get('article') == a and r.get('n')]
            print('   %-28s ← %s' % (a, '、'.join(who)))
    rej = [(k, r) for k, r in ledger.items() if r.get('rejected')]
    if rej:
        print('\n✗ 因為距離而整筆不收的 %d 筆：' % len(rej))
        for k, r in rej:
            print('   %-28s %s' % (k, r['rejected']))
    _hold_report(cache)
    print('\n接著跑：python3 pick_photos.py serve')


def cmd_skip():
    """把「有看過、但沒有挑」的景點記起來，挑圖網頁預設不再列出。

    ⚠️ **判準是「沒有 pick」而不是「沒有候選」**：完全沒候選的（維基與 300m 內
    都沒有）與「有候選但都不合意」的，對使用者來說是同一件事——**這一輪我處理過了**。

    ⚠️ **記下當時的候選張數**，日後候選變多就自己回到清單上（見 SKIP 的說明）。

    ⚠️⚠️ **已經在清單裡的也要更新張數**（2026-09-06 修）。舊版是
    `if p['id'] in picks or p['id'] in skip: continue`，於是**「我這輪又看過一次」
    這件事沒有被記下來**：更早那輪略過時記的是 3 張，後來 `fetch --wiki` 撈到 8 張，
    它就回到清單上；使用者又看了一次、還是沒挑，而基準點**永遠停在 3**
    ——**下一輪照樣出現，而且會一直出現下去**。實測 134 筆裡有 **33 筆**
    卡在這個迴圈裡，那正是使用者說的「不想再重複挑照片」。
    **基準點要推到最近一次真的看過的時候**，「新來源才讓它回來」的原意不變。

    ⚠️ **有照片的景點一律不記**（不只是 `picks`）：照片可能來自 `assign`
    （使用者自己拍的、自己有的），那條路不寫 `_photopick.json`。判準是
    **「它有沒有照片」這個事實**，不是「我在這個網頁上挑過沒」這個紀錄。
    """
    picks, cache, skip = load_json(PICKS, {}), load_json(CACHE, {}), load_json(SKIP, {})
    today = time.strftime('%Y-%m-%d')
    fresh = again = 0
    for p in places():
        if p['id'] in picks or p.get('img'):
            continue
        n_now = len(cache.get(p['id'], []))
        old = skip.get(p['id'])
        if old is None:
            fresh += 1
        elif n_now > old.get('n', 0):
            again += 1          # 它因為候選變多而回來過，這次又被略過一次
        else:
            continue            # 張數沒變，紀錄已經是最新的，不必動
        skip[p['id']] = {'d': today, 'n': n_now}
    save_json(SKIP, skip)
    print('這輪略過 %d 筆（新的 %d、又看過一次 %d），累計 %d 筆不再列出'
          % (fresh + again, fresh, again, len(skip)))
    print('（候選變多時它們會自己回到清單；要全部放回來跑：'
          'python3 pick_photos.py unskip）')


def cmd_unskip():
    save_json(SKIP, {})
    print('略過清單已清空，下次 serve 會把它們全部列回來')


def _hold_new_cands(cache=None, hold=None):
    """鎖住的名單裡，哪幾筆的候選比「鎖起來的那一刻」多了。

    ⚠️⚠️ **這是單位 え 那個代價的唯一替代品。** 使用者 2026-09-16 選的是
    「不自動回來，**但印一行提醒**」而不是「完全不再出現」——所以 `hold` 拿掉
    「候選變多就自己回來」之後，**知道 Commons 出現好照片的唯一管道就剩這一行**。
    拿掉它等於把那個代價變成靜默的（那筆照片永遠不會被挑到，而畫面上什麼都看不出來）。
    """
    cache = load_json(CACHE, {}) if cache is None else cache
    hold = load_json(HOLD, {}) if hold is None else hold
    out = []
    for pid, rec in hold.items():
        now = len(cache.get(pid, []))
        if now > rec.get('n', 0):
            out.append((pid, rec.get('t') or pid, rec.get('n', 0), now))
    out.sort(key=lambda x: x[2] - x[3])
    return out


def _hold_report(cache=None, hold=None):
    """`fetch` 與 `fetch --wiki` 收尾各印一次。見 `_hold_new_cands` 的說明。"""
    grown = _hold_new_cands(cache, hold)
    if not grown:
        return
    print('\n📌 不再詢問的名單裡有 %d 筆候選變多了'
          '（⚠️ 它們**不會**自己回到挑圖網頁上）：' % len(grown))
    for pid, title, old, now in grown[:15]:
        print('   %s  %s  %d → %d 張' % (pid.ljust(30), title[:18], old, now))
    if len(grown) > 15:
        print('   …另外 %d 筆' % (len(grown) - 15))
    print('   想看某一筆：python3 pick_photos.py unhold %s' % grown[0][0])
    print('   全部放回來：python3 pick_photos.py unhold')


def cmd_hold(yes=False):
    """把「沒有照片、而且已經看過沒挑」的景點鎖起來：挑圖網頁不再列出，
    **候選變多也不回來**（使用者 2026-09-16 決定，見 HOLD 的說明）。

    ⚠️⚠️ **預設只列出來、一個位元組都不寫，要加 `--yes` 才真的鎖。**
    這支日後還會被跑，而那時的母體是「**那時候**沒照片又看過沒挑的」
    ——會包含剛剛才略過、其實還想再挑一輪的新景點。**鎖錯是靜默的**
    （那筆從此不出現在網頁上，而畫面上只是少一個景點），所以確認這一步要留著。
    同「候選不可以由程式直接填進資料層」那條的理由。

    ⚠️ **還沒看過的不鎖**：判準是「已經在略過清單裡」＝我看過、沒挑。
    只看「沒有照片」的話，會把還沒輪到的新景點一起鎖進去。

    ⚠️ **已廢棄的不鎖**：它們在挑圖網頁上是「一律列出」的（不吃任何略過那道），
    鎖了完全沒有效果，記進帳本只會讓帳本說謊。
    """
    skip, cache, hold = load_json(SKIP, {}), load_json(CACHE, {}), load_json(HOLD, {})
    trash = load_json(TRASH, {})
    today = time.strftime('%Y-%m-%d')
    add = [p for p in places()
           if not p.get('img') and p['id'] in skip
           and p['id'] not in hold and p['id'] not in trash]
    if not add:
        print('沒有要鎖的景點。（判準是「沒有照片」且「已經看過沒挑」）')
        print('目前不再詢問的名單：%d 筆' % len(hold))
        return
    from collections import Counter
    n = Counter(p.get('area', '') for p in add)
    print('要鎖起來的 %d 筆（沒有照片、而且已經看過沒挑）：\n' % len(add))
    for a, c in n.most_common():
        print('   %s %3d' % ((a or '（無地區）').ljust(10), c))
    if not yes:
        print('\n⚠️ 這是預覽，一個位元組都沒有寫。確定要鎖就跑：')
        print('   python3 pick_photos.py hold --yes')
        return
    for p in add:
        hold[p['id']] = {'d': today, 'n': len(cache.get(p['id'], [])),
                         't': p.get('title', '')}
    save_json(HOLD, hold)
    print('\n寫好 %s，累計 %d 筆不再詢問' % (HOLD, len(hold)))
    print('（日後撈到新候選時，fetch 收尾會印一行提醒；'
          '要放回來跑 python3 pick_photos.py unhold）')


def cmd_unhold(ids=None):
    """把鎖住的放回挑圖網頁。不帶 id ＝全部放回來。

    ⚠️⚠️ **「放回來」不等於「看得到」**：那些景點多半也在略過清單裡，
    而略過那道是「候選沒變多就不列出」。所以只有候選真的變多的那幾筆會出現，
    **其餘仍被略過清單擋著**——不講清楚的話會以為這個指令沒有作用。
    要連略過一起放回來是 `unskip`（那會把全部略過過的都列回來）。
    """
    hold, cache, skip = load_json(HOLD, {}), load_json(CACHE, {}), load_json(SKIP, {})
    if not hold:
        sys.exit('不再詢問的名單是空的。')
    ids = [i for i in (ids or []) if i]
    miss = [i for i in ids if i not in hold]
    if miss:
        sys.exit('這幾個不在名單裡：%s' % '、'.join(miss))
    back = ids or list(hold)
    for i in back:
        hold.pop(i, None)
    save_json(HOLD, hold)
    shown = [i for i in back
             if i not in skip or len(cache.get(i, [])) > skip[i].get('n', 0)]
    print('放回來 %d 筆，名單剩 %d 筆' % (len(back), len(hold)))
    print('其中 %d 筆會真的出現在挑圖網頁上（候選比上次略過時多）' % len(shown))
    if len(shown) < len(back):
        print('另外 %d 筆仍被略過清單擋著（候選沒變多）。'
              '要全部列回來跑：python3 pick_photos.py unskip' % (len(back) - len(shown)))


# ─────────────────────────────────────────────────────── serve

PAGE_CSS = """
body{font:14px/1.5 -apple-system,"Hiragino Sans",sans-serif;margin:0;background:#faf9f7;color:#222}
#bar{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;
     display:flex;gap:16px;align-items:center;z-index:9}
#bar b{font-size:16px} #bar label{font-size:13px;color:#666}
section{padding:12px 16px;border-bottom:1px solid #eee}
section.done{background:#f2f8f2}
section.none{background:#fdf3f3}
/* 廢棄的**不從畫面上消失**，只壓暗——誤按一下就再也找不回來的話，
   那顆鈕會變成不敢按的鈕。要眼不見為淨有「隱藏已廢棄」那個勾選。 */
section.trashed{background:#f4f4f4;opacity:.4}
section.trashed .row{filter:grayscale(1)}
h2{margin:0 0 2px;font-size:15px;display:flex;align-items:center;gap:8px}
h2 small{font-weight:400;color:#888}
.tbtn{margin-left:auto;font-size:12px;padding:3px 11px;border:1px solid #ccc;
      border-radius:12px;background:#fff;color:#a33;cursor:pointer;flex:none}
.tbtn:hover{border-color:#a33}
section.trashed .tbtn{background:#a33;border-color:#a33;color:#fff}
.meta{font-size:12px;color:#777;margin-bottom:8px}
.meta a{color:#36c;margin-right:10px}
.row{display:flex;gap:8px;flex-wrap:wrap}
figure{margin:0;cursor:pointer;border:3px solid transparent;border-radius:4px;padding:2px}
figure:hover{border-color:#bbd}
figure.on{border-color:#2a7}
figure img{display:block;height:150px;border-radius:2px;background:#eee}
figcaption{font-size:10px;color:#888;max-width:200px;overflow:hidden;
           text-overflow:ellipsis;white-space:nowrap}
.clear{font-size:12px;color:#c33;cursor:pointer;align-self:center;margin-left:4px}
.own{background:#2a7;color:#fff;border-radius:3px;padding:0 5px;font-size:11px;font-weight:400}
.wk{background:#2a7;color:#fff;border-radius:3px;padding:0 4px;margin-right:4px}
.nb{background:#ddd;color:#666;border-radius:3px;padding:0 4px;margin-right:4px}
"""

PAGE_JS = """
function pick(el,id,i){
  var sec=document.getElementById('s-'+id);
  var was=el&&el.classList.contains('on');
  sec.querySelectorAll('figure').forEach(f=>f.classList.remove('on'));
  var idx=(el&&!was)?i:null;
  if(idx!==null)el.classList.add('on');
  /* ⚠️ 這裡本來是 sec.className='done'（整個覆寫），加了廢棄之後**會把 trashed 洗掉**
     ——按一下照片，剛剛標的廢棄就靜默不見了。一律用 classList 增減。 */
  sec.classList.toggle('done',idx!==null);
  sec.classList.toggle('none',idx===null&&sec.dataset.n==='0');
  fetch('/pick',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:id,i:idx})}).then(count);
}
function trash(el,id){
  var sec=document.getElementById('s-'+id);
  var on=!sec.classList.contains('trashed');
  fetch('/trash',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:id,v:on})}).then(r=>r.json()).then(function(){
      sec.classList.toggle('trashed',on);
      sec.dataset.trash=on?'1':'';
      el.textContent=on?'取消廢棄':'廢棄';
      count();filt();
    });
}
function count(){
  fetch('/count').then(r=>r.json()).then(d=>{
    document.getElementById('n').textContent=d.n+' / '+d.total;
    document.getElementById('t').textContent=d.trash?'　廢棄 '+d.trash+' 筆':'';});
}
function filt(){
  var a=document.getElementById('fArea').value,
      t=document.getElementById('fTodo').checked,
      h=document.getElementById('fTrash').checked;
  var n=0;
  document.querySelectorAll('section').forEach(s=>{
    /* ⚠️ 用 classList 問，不要比對整個 className——它現在可能是 'done trashed' */
    var ok=(!a||s.dataset.area===a)
         &&(!t||!s.classList.contains('done'))
         &&(!h||s.dataset.trash!=='1');
    s.style.display=ok?'':'none'; if(ok)n++;});
  document.getElementById('shown').textContent='　顯示 '+n+' 個';
}
count();filt();
"""


def _area_select():
    """⚠️ **依 `AREAS` 的順序列，不要用字母序或 set 的順序**——那份清單的順序
    本身有意義（同一個圈的桶相鄰，見 CLAUDE.md 那條），照它列人才找得到。"""
    ps = places()
    have = {p.get('area', '') for p in ps}
    try:
        import build_places as _bp
        order = [a for a in _bp.br.AREAS if a in have]
    except Exception:
        order = sorted(x for x in have if x)
    order += [a for a in sorted(have) if a and a not in order]
    n = {}
    for p in ps:
        n[p.get('area', '')] = n.get(p.get('area', ''), 0) + 1
    opt = ''.join('<option value="%s">%s（%d）</option>'
                  % (html.escape(a), html.escape(a), n[a]) for a in order)
    return ('<select id="fArea" onchange="filt()">'
            '<option value="">全部地區（%d）</option>%s</select>' % (len(ps), opt))


def build_page():
    cache = load_json(CACHE, {})
    picks = load_json(PICKS, {})
    ledger = load_json(WIKI_LEDGER, {})
    skip = load_json(SKIP, {})
    hold = load_json(HOLD, {})
    trash = load_json(TRASH, {})
    out = ['<!doctype html><meta charset="utf-8"><title>景點挑圖</title>',
           '<style>%s</style>' % PAGE_CSS,
           '<div id="bar"><b>景點挑圖</b><span id="n"></span><span id="shown"></span>',
           _area_select(),
           '<label><input type="checkbox" id="fTodo" onchange="filt()"> 只看還沒挑的</label>',
           '<label><input type="checkbox" id="fTrash" onchange="filt()"> 隱藏已廢棄</label>',
           '<span id="t" style="font-size:12px;color:#a33"></span>',
           '<span style="font-size:12px;color:#888">點縮圖＝選它，再點一次＝取消'
           '　／　廢棄＝這個景點不收</span></div>']
    hidden = held = 0
    for p in places():
        pid = p['id']
        cands = cache.get(pid, [])
        chosen = picks.get(pid)
        # 略過過的不再列出——**除非候選變多了**（新來源撈到東西），那時它自己回來。
        sk = skip.get(pid)
        tr = pid in trash
        # ⚠️⚠️ **「完成」的判準是「它有沒有照片」這個事實，不是「我在這個網頁上挑過沒」**
        # （2026-09-06 加）。照片有兩個來源：這個網頁（寫 `_photopick.json`）與
        # `assign`（使用者自己拍的、自己有的，**不寫那個檔**）。只看 picks 的話，
        # 自己放好照片的景點會**永遠留在待挑清單裡**，而它其實早就完成了。
        done = chosen is not None or bool(p.get('img'))
        # ⚠️ **已廢棄的一律列出來**（不吃 skip 那道）：它被藏起來的話，
        # 使用者按錯之後就再也點不到「取消廢棄」，而 `apply-trash` 照樣會刪掉它。
        # ⚠️ **鎖住的一律不列出，候選變多也不回來**——那是 hold 與 skip 的唯一差別。
        #    提醒改由 `fetch` 收尾那一行負責（見 `_hold_report`），
        #    拿掉那一行等於把「日後有好照片」變成靜默的。
        # ⚠️ **已廢棄的照樣要列出來**（同下面那道），理由見上方那段註解。
        if pid in hold and not done and not tr:
            held += 1
            continue
        if sk and not done and not tr and len(cands) <= sk.get('n', 0):
            hidden += 1
            continue
        cls = 'done' if done else ('none' if not cands else '')
        if tr:
            cls = (cls + ' trashed').strip()
        out.append('<section id="s-%s" class="%s" data-n="%d" data-area="%s" data-trash="%s">'
                   % (pid, cls, len(cands), html.escape(p.get('area', '')),
                      '1' if tr else ''))
        # 有照片但不是在這個網頁上挑的＝來自 assign，標出來免得看不懂為什麼是綠的
        own = ' <span class="own">已有照片</span>' if (p.get('img') and chosen is None) else ''
        out.append('<h2>%s <small>%s ・ %s ・ %s</small>%s'
                   '<button class="tbtn" onclick="trash(this,\'%s\')">%s</button></h2>' % (
                       html.escape(p['title']), html.escape(p.get('title_ja', '')),
                       html.escape(p.get('area', '')), html.escape(p.get('genre', '')),
                       own, pid, '取消廢棄' if tr else '廢棄'))
        out.append('<div class="meta"><a href="%s" target="_blank">官網↗</a>'
                   '<a href="https://www.google.com/maps/search/?api=1&query=%s,%s" '
                   'target="_blank">地圖↗</a>%d 張候選</div>'
                   % (html.escape(p.get('url', '') or '#'), p['lat'], p['lng'], len(cands)))
        if not cands:
            # ⚠️ **這句話要跟著實際問過的來源走。** 只寫「300m 內沒有」的話，
            # 在維基那條上線之後就是**一句不完整的實話**——人會以為還有別的招
            # 沒試過（或反過來，以為已經試遍了）。三種情況要分開講，
            # 同「範圍外 vs 地址不完整」那條原則。
            r = ledger.get(pid)
            if r is None:
                why = '300m 內沒有候選；<b>維基那條還沒問過</b>（跑 fetch --wiki）'
            elif not r.get('article'):
                why = '300m 內沒有候選，維基也沒有這個條目——留白即可'
            else:
                why = ('300m 內沒有候選，維基條目「%s」也沒有可用的圖——留白即可'
                       % html.escape(r['article']))
            out.append('<div style="color:#c33;font-size:13px">%s</div></section>' % why)
            continue
        out.append('<div class="row">')
        for i, c in enumerate(cands):
            on = ' on' if chosen == i else ''
            # ⚠️ **兩種來源的意思完全不同，一定要標出來**：`wiki` 是「條目說這就是它」，
            # 沒標的是 geosearch 的「300m 內」——後者可能是隔壁餐廳的醬料照。
            # 不標的話兩排長得一模一樣，人會以為都一樣可信。
            badge = ('<span class="wk">維基</span>' if c.get('src') == 'wiki'
                     else '<span class="nb">附近</span>')
            out.append('<figure class="%s" onclick="pick(this,\'%s\',%d)">'
                       '<img loading="lazy" src="%s">'
                       '<figcaption>%s%s ・ %d×%d</figcaption>'
                       '<figcaption>%s</figcaption></figure>'
                       % (on.strip(), pid, i, html.escape(c['thumb'] or ''),
                          badge, html.escape(c['lic']), c['w'], c['h'],
                          html.escape(c.get('note') or c['file'][:40])))
        out.append('</div></section>')
    if hidden:
        out.append('<div style="padding:14px 16px;color:#888;font-size:13px">'
                   '另有 <b>%d</b> 筆你之前看過但沒有挑，已不再列出。'
                   '<b>日後有新候選它們會自己回來</b>；'
                   '要全部放回來跑 <code>python3 pick_photos.py unskip</code>。</div>' % hidden)
    # ⚠️ **這兩句話不可以併成一句。** 兩批的行為相反（一批會自己回來、一批不會），
    #    併起來就等於對其中一批說謊，而畫面上完全看不出來。
    if held:
        out.append('<div style="padding:14px 16px;color:#888;font-size:13px">'
                   '另有 <b>%d</b> 筆是你指定<b>不再詢問</b>的，'
                   '<b>候選變多也不會自己回來</b>（撈候選時指令會印一行提醒）。'
                   '要放回來跑 <code>python3 pick_photos.py unhold</code>。</div>' % held)
    out.append('<script>%s</script>' % PAGE_JS)
    return ''.join(out).encode('utf-8')


def cmd_serve():
    import http.server

    if not load_json(CACHE, {}):
        sys.exit('還沒有候選快取，請先跑：python3 pick_photos.py fetch')

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, body, ctype='text/html; charset=utf-8'):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith('/count'):
                # ⚠️ 與 build_page 的 `done` 同一個判準（有挑或有照片），
                # 而且**只數清單上真的存在的景點**——直接數 `picks` 會把已經被
                # 移除的景點也算進去，於是分子比分母還大。
                pk = load_json(PICKS, {})
                ps = places()
                n = len([p for p in ps if pk.get(p['id']) is not None or p.get('img')])
                self._send(json.dumps({'n': n, 'total': len(ps),
                                       'trash': len(load_json(TRASH, {}))}).encode(),
                           'application/json')
            else:
                self._send(build_page())

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            d = json.loads(self.rfile.read(n) or b'{}')
            # ⚠️ 這裡本來不看 path（只有一種 POST）。加了廢棄之後**一定要分**，
            # 否則廢棄那一下會被當成挑照片、把 picks 寫壞。
            if self.path.startswith('/trash'):
                trash = load_json(TRASH, {})
                if d.get('v'):
                    # 連標題一起記：日後翻 _placetrash.json 時看得出廢棄了什麼，
                    # 光有 id 的話那份清單等於一串亂碼。
                    t = next((x for x in places() if x['id'] == d['id']), {})
                    trash[d['id']] = {'d': time.strftime('%Y-%m-%d'),
                                      't': t.get('title', ''),
                                      'a': t.get('area', '')}
                else:
                    trash.pop(d['id'], None)
                save_json(TRASH, trash)
                self._send(b'{}', 'application/json')
                return
            picks = load_json(PICKS, {})
            if d.get('i') is None:
                picks.pop(d['id'], None)
            else:
                picks[d['id']] = d['i']
            save_json(PICKS, picks)          # 每一下都落地，關掉瀏覽器不會掉進度
            self._send(b'{}', 'application/json')

        def log_message(self, *a):
            pass

    print('挑圖網頁：http://127.0.0.1:%d/   （挑完按 Ctrl+C 結束）' % PORT)
    print('選擇會即時存進 %s' % PICKS)
    print('廢棄的景點記在 %s，要真的移除再跑：python3 pick_photos.py apply-trash' % TRASH)
    http.server.HTTPServer(('127.0.0.1', PORT), H).serve_forever()


# ─────────────────────────────────────────────────────── apply

def cmd_apply():
    cache, picks = load_json(CACHE, {}), load_json(PICKS, {})
    if not picks:
        sys.exit('還沒有任何選擇，請先跑：python3 pick_photos.py serve')
    trash = load_json(TRASH, {})
    os.path.isdir(DL_DIR) or os.makedirs(DL_DIR)
    credits, ok, fail, skipped = load_json(CREDITS, {}), 0, 0, 0
    for p in places():
        pid = p['id']
        i = picks.get(pid)
        if i is None or i >= len(cache.get(pid, [])):
            continue
        # ⚠️ 廢棄的不下載：它馬上要被移出清單，下載等於留一張沒有主人的照片
        # 在 _photodl/ 裡，而 build_photos.py 之後會照著檔名找不到景點。
        if pid in trash:
            skipped += 1
            continue
        c = cache[pid][i]
        dst = os.path.join(DL_DIR, pid + '.jpg')
        if not os.path.exists(dst):
            try:
                # 要一張 1600px 寬的版本就好——原圖有的到幾十 MB，
                # 而 build_photos.py 反正會壓到 MAX_EDGE
                d = api({'action': 'query', 'titles': 'File:' + c['file'],
                         'prop': 'imageinfo', 'iiprop': 'url', 'iiurlwidth': 1600})
                url = (d['query']['pages'][0]['imageinfo'][0].get('thumburl')
                       or d['query']['pages'][0]['imageinfo'][0]['url'])
                req = urllib.request.Request(url, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=60) as r, open(dst, 'wb') as f:
                    f.write(r.read())
                time.sleep(0.3)
            except Exception as e:
                print('  [warn] %s 下載失敗：%s' % (p['title'], e), file=sys.stderr)
                fail += 1
                continue
        # 中日名都存：出處頁因此不必等 places.json 載好，也不會因為它讀取失敗就整頁空白
        credits[pid] = {'title': p['title'], 'title_ja': p.get('title_ja', ''),
                        'file': c['file'], 'by': c['by'],
                        'lic': c['lic'], 'src': c['page']}
        ok += 1
        print('%-24s %s' % (p['title'][:22], c['file'][:44]), flush=True)
    save_json(CREDITS, credits)
    print('\n下載好 %d 張到 %s（失敗 %d）' % (ok, DL_DIR, fail))
    if skipped:
        print('另有 %d 筆挑了照片但已標廢棄，沒有下載' % skipped)
    print('出處寫進 %s' % CREDITS)
    print('\n接著壓縮並寫回 img：\n    python3 build_photos.py --src %s' % DL_DIR)


# ─────────────────────────────────────────────────────── apply-trash（廢棄的景點）

def _spans(raw):
    """掃出頂層 `places` 陣列裡每一筆的起訖位置（字元 offset）。

    ⚠️ **為什麼不用 json.loads 再 dumps 回去**：Codex 交來的檔多半是
    「多個欄位擠一行」的緊湊寫法，而 `json.dumps(indent=2)` 會把它展開成
    一行一欄位——**50 個檔裡有 39 個**會因此在 diff 裡多出幾百行無關改動，
    真正刪掉了什麼就淹沒在裡面（單位 U-2 為了同一個理由選擇逐行刪除）。
    切位置＝純文字操作，diff 是**純刪除**。

    掃描要認得字串與跳脫字元，否則 `_note` 裡的一個 `}` 就會把深度算錯。
    """
    i = raw.index('[', raw.index('"places"')) if '"places"' in raw else raw.index('[')
    spans, depth, start, instr, esc = [], 0, None, False, False
    for j in range(i, len(raw)):
        c = raw[j]
        if instr:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                instr = False
            continue
        if c == '"':
            instr = True
        elif c in '{[':
            depth += 1
            if depth == 2 and c == '{':
                start = j
        elif c in '}]':
            depth -= 1
            if depth == 1 and start is not None:
                spans.append((start, j + 1))
                start = None
            if depth == 0:
                break
    return spans


def _cut_rows(raw, ids):
    """把 `ids` 裡那幾筆從原始文字中剪掉，回傳（新內容, 被剪掉的 row）。

    三道守門，任何一道不過就丟例外（那個檔不動）：
    ①切出來的每一段都要能單獨解析 ②結果仍是合法 JSON
    ③解析出來的內容，除了被剪掉的那幾筆之外**逐筆相同**。
    """
    spans = _spans(raw)
    rows = [(a, b, json.loads(raw[a:b])) for a, b in spans]
    drop = [(a, b, r) for a, b, r in rows if (r.get('id') or '') in ids]
    if not drop:
        return raw, []
    out = raw
    for a, b, _r in reversed(drop):
        # 連同分隔的逗號一起剪：前面有逗號就往前吃，否則往後吃（它是第一筆）
        lo, hi = a, b
        k = a - 1
        while k >= 0 and raw[k] in ' \t\r\n':
            k -= 1
        if k >= 0 and raw[k] == ',':
            lo = k
        else:
            k = b
            while k < len(raw) and raw[k] in ' \t\r\n':
                k += 1
            if k < len(raw) and raw[k] == ',':
                hi = k + 1
        out = out[:lo] + out[hi:]
    # 收掉剪完留下的空行（純空白的一行），不動其他任何一行
    out = re.sub(r'\n[ \t]*(?=\n)', '', out)
    before = json.loads(raw)
    after = json.loads(out)                       # ← 守門②：還是合法 JSON
    bl = before.get('places') if isinstance(before, dict) else before
    al = after.get('places') if isinstance(after, dict) else after
    want = [r for r in bl if (r.get('id') or '') not in ids]
    if al != want:                                # ← 守門③：只少了該少的
        raise ValueError('剪完之後內容對不上，沒有動這個檔')
    return out, [r for _a, _b, r in drop]



def cmd_apply_trash(dry_run=False):
    """把挑圖網頁上標為廢棄的景點移出清單。

    ⚠️ **搬走而不是刪掉**（`places_src/_deleted-trash-<日期>.json`，底線開頭＝管線跳過）。
    同 P-2 那次刪 58 筆的做法：資料仍在 repo 裡，反悔時把那幾筆貼回去就好。
    直接 `del` 的話，使用者按錯一下就永遠拿不回來，而**畫面上只是少一個景點**。

    ⚠️ **回寫走「整檔 json.dumps 重寫」，所以一定要先驗 round trip**
    （讀進來再 dump 出去，逐位元組等於原檔才動它）。不驗的話 diff 裡會混進
    大量格式重排（`build_photos.py` 那節與單位 U-2 都記過這個代價），
    而真正刪掉了什麼就淹沒在裡面看不見了。
    """
    trash = load_json(TRASH, {})
    if not trash:
        sys.exit('沒有標記為廢棄的景點。（在挑圖網頁上按「廢棄」）')

    files = sorted(n for n in os.listdir(os.path.join(HERE, 'places_src'))
                   if n.endswith('.json') and not n.startswith('_'))
    moved, unsafe, hit = [], [], set()
    for name in files:
        path = os.path.join(HERE, 'places_src', name)
        raw = io.open(path, encoding='utf-8').read()
        try:
            out, cut = _cut_rows(raw, trash)
        except Exception as e:
            unsafe.append((name, str(e)))
            continue
        if not cut:
            continue
        moved.extend(cut)
        hit.update(r['id'] for r in cut)
        if not dry_run:
            io.open(path, 'w', encoding='utf-8').write(out)
        print('%-34s 移除 %d 筆' % (name, len(cut)))

    for name, why in unsafe:
        print('[warn] %s 沒有處理：%s' % (name, why), file=sys.stderr)
    missing = [i for i in trash if i not in hit]
    if missing:
        # 找不到多半是「已經處理過了」或「那筆本來就不在 places_src」，不是錯誤，
        # 但要講出來——靜靜跳過的話，使用者會以為廢棄了而它其實還在網站上。
        print('[warn] 有 %d 筆在 places_src 裡找不到：%s'
              % (len(missing), '、'.join(trash[i].get('t') or i for i in missing)[:200]),
              file=sys.stderr)
    if not moved:
        sys.exit('沒有任何景點被移動。')
    if dry_run:
        print('\n--dry-run：不寫檔。共 %d 筆會被移出。' % len(moved))
        return

    dst = os.path.join(HERE, 'places_src',
                       '_deleted-trash-%s.json' % time.strftime('%Y-%m-%d'))
    old = load_json(dst, {}).get('places', [])
    save_json(dst, {'places': old + moved})
    for i in hit:
        trash.pop(i, None)
    save_json(TRASH, trash)
    print('\n移出 %d 筆 → %s' % (len(moved), os.path.basename(dst)))
    print('接著跑管線讓它們從 places.json 消失：\n    python3 build_places.py')


# ─────────────────────────────────────────────────────── assign（自己拍的照片）

ASSIGN_CSS = PAGE_CSS + """
.ph{display:flex;gap:14px;align-items:flex-start}
.ph>img{height:190px;border-radius:3px;background:#eee;flex:none}
.cands{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.cand{padding:5px 10px;border:1px solid #ccc;border-radius:14px;background:#fff;cursor:pointer;font-size:13px}
.cand:hover{border-color:#2a7}
.cand.on{background:#2a7;border-color:#2a7;color:#fff}
.cand .d{color:#999;font-size:11px;margin-left:4px}
.cand.on .d{color:#dff}
.has{color:#c80;font-size:11px;margin-left:4px}
select{max-width:320px;padding:5px;font-size:13px}
.nogps{color:#c33;font-size:12px}
"""

ASSIGN_JS = """
function assign(file,pid,el){
  var sec=el.closest('section');
  var was=el&&el.classList.contains('on');
  sec.querySelectorAll('.cand').forEach(c=>c.classList.remove('on'));
  var v=(el&&!was)?pid:null;
  if(v)el.classList.add('on');
  if(!v)sec.querySelector('select').value='';
  send(file,v,sec);
}
function assignSel(file,sel){
  var sec=sel.closest('section');
  sec.querySelectorAll('.cand').forEach(c=>c.classList.remove('on'));
  var v=sel.value||null;
  if(v){var b=sec.querySelector('.cand[data-pid="'+v+'"]');if(b)b.classList.add('on');}
  send(file,v,sec);
}
function send(file,pid,sec){
  fetch('/assign',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({file:file,pid:pid})})
   .then(r=>r.json()).then(d=>{
     sec.className=pid?'done':'';
     var m=sec.querySelector('.res');
     if(m)m.textContent=d.msg||'';
     count();
   });
}
function count(){
  fetch('/count').then(r=>r.json()).then(d=>{
    document.getElementById('n').textContent=d.n+' / '+d.total;});
}
count();
"""


def _photo_list(src):
    """來源資料夾裡的照片，依檔名排序。"""
    import build_photos as bp
    out = []
    for f in sorted(os.listdir(src)):
        if f.startswith('.'):
            continue
        if os.path.splitext(f)[1].lower() in bp.PHOTO_EXT:
            out.append(f)
    return out


def _thumb_path(f):
    return os.path.join(IN_DIR, '_thumbs', os.path.splitext(f)[0] + '.jpg')


def _make_thumbs(src, files):
    """用 sips 產 500px 縮圖。原圖動輒 5MB，直接餵給瀏覽器 49 張會很鈍。"""
    import subprocess
    d = os.path.join(IN_DIR, '_thumbs')
    os.path.isdir(d) or os.makedirs(d)
    made = 0
    for f in files:
        t = _thumb_path(f)
        if os.path.exists(t):
            continue
        r = subprocess.run(['sips', '-Z', '500', os.path.join(src, f), '--out', t],
                           capture_output=True)
        if r.returncode == 0:
            made += 1
        else:
            print('  [warn] 縮圖失敗：%s' % f, file=sys.stderr)
    return made


def cmd_assign(src):
    import http.server, shutil
    import build_photos as bp

    if not os.path.isdir(src):
        sys.exit('找不到照片資料夾：%s\n（外接碟沒接？或用 --src 指定別的資料夾）' % src)
    ps = places()
    files = _photo_list(src)
    if not files:
        sys.exit('%s 裡沒有照片' % src)
    print('照片 %d 張，正在產縮圖…' % len(files))
    print('縮圖新做 %d 張' % _make_thumbs(src, files))

    def cands_of(f):
        """GPS 500m 內的景點，近的在前。讀不到 GPS 就回空 → 只能用下拉。"""
        gps = bp.read_exif(os.path.join(src, f)).get('gps')
        if not gps:
            return None
        near = [(bp.dist_m(gps[0], gps[1], p['lat'], p['lng']), p) for p in ps]
        near.sort(key=lambda x: x[0])
        return [(d, p) for d, p in near if d <= bp.RADIUS_M]

    cache = {f: cands_of(f) for f in files}

    def page():
        a = load_json(ASSIGN, {})
        done = len([v for v in a.values() if v])
        o = ['<!doctype html><meta charset="utf-8"><title>照片配對</title>',
             '<style>%s</style>' % ASSIGN_CSS,
             '<div id="bar"><b>照片配對</b><span id="n"></span>',
             '<span style="font-size:12px;color:#888">點景點＝配對（會複製一份改好名），',
             '再點一次＝取消。找不到就用右邊的下拉。</span></div>']
        withimg = set(p['id'] for p in ps if p.get('img'))
        opts = ['<option value="">— 全部景點 —</option>'] + [
            '<option value="%s">%s%s</option>' % (
                html.escape(p['id']), html.escape(p['area'] + '・' + p['title']),
                '（已有照片）' if p['id'] in withimg else '')
            for p in sorted(ps, key=lambda x: (x['area'], x['title']))]
        for f in files:
            cur = a.get(f)
            near = cache.get(f)
            o.append('<section class="%s">' % ('done' if cur else ''))
            o.append('<div class="ph"><img loading="lazy" src="/thumb?f=%s">'
                     % urllib.parse.quote(f))
            o.append('<div><h2>%s</h2>' % html.escape(f))
            if near is None:
                o.append('<div class="nogps">這張沒有 GPS 資訊，請用下拉挑</div>')
            elif not near:
                o.append('<div class="nogps">500m 內沒有任何景點，請用下拉挑</div>')
            o.append('<div class="cands">')
            for d, p in (near or [])[:6]:
                on = ' on' if cur == p['id'] else ''
                o.append('<button class="cand%s" data-pid="%s" '
                         'onclick="assign(%s,%s,this)">%s<span class="d">%dm</span>%s</button>'
                         % (on, html.escape(p['id']),
                            html.escape(json.dumps(f)), html.escape(json.dumps(p['id'])),
                            html.escape(p['title']), int(d),
                            '<span class="has">已有</span>' if p['id'] in withimg else ''))
            o.append('</div>')
            o.append('<select onchange="assignSel(%s,this)">%s</select>'
                     % (html.escape(json.dumps(f)), ''.join(
                        opt.replace('value="%s"' % html.escape(cur),
                                    'value="%s" selected' % html.escape(cur))
                        if cur and ('value="%s"' % html.escape(cur)) in opt else opt
                        for opt in opts)))
            o.append('<div class="res" style="font-size:12px;color:#2a7;margin-top:4px"></div>')
            o.append('</div></div></section>')
        o.append('<script>%s</script>' % ASSIGN_JS)
        return ''.join(o).encode('utf-8')

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, body, ctype='text/html; charset=utf-8'):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == '/thumb':
                f = urllib.parse.parse_qs(u.query).get('f', [''])[0]
                # ⚠️ 只認「來源資料夾裡真的有的那幾個檔名」，不要拿使用者送來的字串去拼路徑
                if f not in files:
                    self._send(b'', 'text/plain'); return
                t = _thumb_path(f)
                if not os.path.exists(t):
                    self._send(b'', 'text/plain'); return
                self._send(open(t, 'rb').read(), 'image/jpeg')
            elif u.path == '/count':
                a = load_json(ASSIGN, {})
                self._send(json.dumps({'n': len([v for v in a.values() if v]),
                                       'total': len(files)}).encode(), 'application/json')
            else:
                self._send(page())

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            d = json.loads(self.rfile.read(n) or b'{}')
            f, pid = d.get('file'), d.get('pid')
            a = load_json(ASSIGN, {})
            msg = ''
            if f in files:
                # 先把這個檔案先前複製出去的那一份清掉（改選別的景點時不留孤兒）
                old = a.get(f)
                if old:
                    for e in ('.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff'):
                        q = os.path.join(IN_DIR, old + e)
                        if os.path.exists(q):
                            os.remove(q)
                if pid:
                    ext = os.path.splitext(f)[1].lower()
                    os.path.isdir(IN_DIR) or os.makedirs(IN_DIR)
                    # ⚠️ **複製不是搬移**：原圖是唯一的備份（WebP 壓過回不去）
                    shutil.copy2(os.path.join(src, f), os.path.join(IN_DIR, pid + ext))
                    a[f] = pid
                    msg = '→ _photoin/%s%s' % (pid, ext)
                else:
                    a.pop(f, None)
                save_json(ASSIGN, a)
            self._send(json.dumps({'msg': msg}).encode(), 'application/json')

        def log_message(self, *x):
            pass

    print('照片配對網頁：http://127.0.0.1:%d/   （配完按 Ctrl+C 結束）' % PORT)
    print('每點一下就複製一份到 %s，原圖不動' % IN_DIR)
    print('全部配完之後跑：python3 build_photos.py --src %s' % IN_DIR)
    http.server.HTTPServer(('127.0.0.1', PORT), H).serve_forever()


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'assign':
        import build_photos as bp
        src = bp.SRC_DEFAULT
        if '--src' in sys.argv:
            src = sys.argv[sys.argv.index('--src') + 1]
        if not src:
            sys.exit('台灣版還沒設定原圖資料夾（單位 H），請用 --src 指定路徑。')
        cmd_assign(os.path.abspath(os.path.expanduser(src)))
    elif cmd == 'fetch' and '--wiki' in sys.argv:
        cmd_fetch_wiki()
    elif cmd == 'apply-trash':
        cmd_apply_trash('--dry-run' in sys.argv)
    elif cmd == 'hold':
        cmd_hold('--yes' in sys.argv)
    elif cmd == 'unhold':
        cmd_unhold([a for a in sys.argv[2:] if not a.startswith('-')])
    else:
        {'fetch': cmd_fetch, 'serve': cmd_serve, 'apply': cmd_apply,
         'skip': cmd_skip, 'unskip': cmd_unskip}.get(
            cmd, lambda: sys.exit(__doc__))()
