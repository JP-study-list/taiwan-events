#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""klook_match.py — 把 Klook 的商品對到站上的景點（單位 M 第 2 段）

    python3 klook_match.py fetch     # 抓 Klook 的 sitemap，存成快取
    python3 klook_match.py report    # 產出報表（不打網路）
    python3 klook_match.py serve     # 開網頁逐筆確認候選，點一下就存
    python3 klook_match.py apply     # 把確認結果寫進 places_src/*.json

⚠️ **這支程式只讀 Klook 公開的 sitemap，不去開它的商品頁。**
商品頁掛著 DataDome 的 CAPTCHA（2026-09-02 實測，連真的 headless Chrome 都被擋），
**繞過它是規避存取控制，不做**。sitemap 本來就是給爬蟲讀的、也沒有擋。

代價要講清楚：**sitemap 只有網址，沒有商品標題、價格與圖片**。
所以這支程式的產出是**候選**不是答案——同 `pick_photos.py` 的定位：
把候選收斂到十來筆讓人點得動，最後由人去開頁面確認。

⚠️ **配對靠的是網址裡的 slug**（`.../activity/1-tokyo-skytree-tokyo/`），
而站上景點的 `id` 本來就是羅馬拼音（`pl-fushimi-inari`），兩邊天生對得上。
對不上的（`pl-kahaku` ＝ 国立科学博物館）靠 `places_src/_klook_alias.json` 逐筆補，
**那個檔是給人改的，程式只讀不寫**。

⚠️ **slug 裡出現景點名 ≠ 那是這個景點的門票。** 實測「伏見稻荷」命中 57 件，
絕大多數是**會經過那裡的一日遊**。所以報表把「像門票」與「像行程」分開列，
混在一起的話門票會被導覽淹掉（同 build_restaurants.py 把「範圍外」與「地址不完整」
分開的理由：兩種東西擠進同一個數字，那個數字就沒有意義了）。
"""
import collections
import glob
import html
import io
import json
import os
import re
import sys
import time
import gzip
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PLACES = os.path.join(HERE, 'places.json')
SRC_DIR = os.path.join(HERE, 'places_src')
CACHE = os.path.join(SRC_DIR, '_klook_cache.json')
ALIAS = os.path.join(SRC_DIR, '_klook_alias.json')
REPORT_DIR = os.path.join(HERE, '_probe')
REPORT = os.path.join(REPORT_DIR, 'klook_report.txt')
# 人工確認的結果。⚠️ **與 `_klook_alias.json` 一樣是「人說了算」的檔**，
# 程式只在 `serve` 時寫、在 `apply` 時讀，其餘流程一個字都不碰。
PICKS = os.path.join(SRC_DIR, '_klook_pick.json')
PORT = 8811

SITEMAP = 'https://www.klook.com/sitemap-experiences-activity-plain_zh-tw.xml'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')

# ⚠️ **一次只打一個檔，而且不重試**。實測連打三次就開始回 429——
# 這支程式一個月跑一次都嫌多，沒有任何理由去逼它。
ACT_RE = re.compile(r'/activity/(\d+)-([a-z0-9-]+)/')

# 「這件像門票」與「這件像行程」。⚠️ **行程的字優先**：寧可把門票誤判成行程
# （只是排到第二段，人還看得到），也不要把一日遊混進門票那段——
# 那會讓門票那段失去意義，而它正是這份報表唯一要回答的問題。
TOUR_WORDS = ('tour', 'tours', 'trip', 'guide', 'guided', 'walking', 'hiking',
              'charter', 'transfer', 'transfers', 'private', 'experience',
              'class', 'lesson', 'workshop', 'making', 'cruise', 'rental',
              'rent', 'kimono', 'yukata', 'photoshoot', 'photography',
              'taxi', 'driver', 'bus', 'shuttle', 'cooking', 'dining',
              'lunch', 'dinner', 'course', 'package', 'wifi', 'sim', 'esim')
TICKET_WORDS = ('ticket', 'tickets', 'admission', 'entry', 'entrance',
                'pass', 'combo', 'eticket')

# 通票與交通票。⚠️ **它們也帶著 `pass`／`ticket`，所以會被判成「像門票」**，
# 但對「要不要多收一個景點」這個問題完全是雜訊（實測反向清單前幾筆全是 JR Pass）。
# ⚠️ **只在第二份報表裡分段，不是丟掉**——使用者的規格書把城市／區域 Pass 列在範圍內，
# 只是它涵蓋好幾個景點、掛不到單一景點底下（那是單位 F 的地盤）。
PASS_WORDS = ('jr', 'jrpass', 'railpass', 'subway', 'metro', 'shinkansen',
              'suica', 'pasmo', 'icoca', 'nightclub', 'unlimited', 'airport',
              'highway', 'expressway', 'ferry', 'monorail')

# ⚠️ **有一整類門票的 slug 裡一個關鍵字都沒有。** Klook 對「這個景點自己的入場券」
# 常常直接拿設施名當網址（`shibuya-sky-tokyo`／`tokyo-national-museum`／
# `osaka-aquarium-kaiyukan-japan`），於是 `kind_of` 只回得出 'other'，
# 那個景點就整個掉進【二】——**而【二】的說明寫著「多半代表這個景點不需要買票」，
# 看起來完全合理**。2026-09-02 實測漏掉海遊館、SHIBUYA SKY、新宿御苑、
# 新江之島水族館、東京國立博物館、MOA 美術館六個，一個都沒人發現。
#
# ⚠️ **修法刻意不是「多加幾個關鍵字」**——那會把一日遊拉進門票那段，
# 違反上面「行程的字優先」那條。判準改成**「把景點名與日本地名拿掉之後還剩幾個字」**：
#   0 個            → 這個網址講的就是這個景點本身
#   1 個且是設施類名詞 → 一樣是它自己（`moa-museum-of-art-shizuoka` 剩 art）
#   2 個以上        → 裡面還有別的東西
# **這個分界是量出來的不是挑的**：全站 20 件 other 命中，剩 0~1 的 8 件全部是門票，
# 剩 2 以上的 12 件全部不是（剩 2 的那件是南禪寺門前的餐廳 `nanzenji-junsei-restaurant`）。
SLUG_FILLER = ('the', 'a', 'of', 'and', 'in', 'at', 'on', 'with', 's', 'to',
               'city')      # `kyoto-city-kyocera-museum-of-art` 少了它就進不來
# ⚠️ 這份表只在「剩下剛好一個字」時才會被問到，所以放寬它不會把行程放進來
# （行程一定剩兩個字以上）。**但也不要塞進動詞**，那是行程在用的字。
BARE_VENUE_WORDS = ('aquarium', 'museum', 'art', 'gallery', 'park', 'garden',
                    'castle', 'tower', 'shrine', 'temple', 'zoo', 'observatory',
                    'hall', 'onsen', 'sky', 'observation')

# 日本的地名 token（用來認出「這件商品在日本」）。**只影響第二份報表**
# （Klook 有票、站上沒收），第一份是拿站上景點去比對，不需要它。
# ⚠️ 寧寬勿窄：漏一個地名只是那幾件不會被提議收錄，多一個只是報表多幾行雜訊。
JP_TOKENS = set("""
japan tokyo osaka kyoto nara kobe yokohama kawasaki chiba saitama hakone nikko
kamakura enoshima fuji fujisan kawaguchiko hakuba nagano matsumoto karuizawa
nagoya aichi gifu takayama shirakawa kanazawa toyama niigata sendai aomori
akita yamagata fukushima ibaraki tochigi gunma shizuoka atami izu hamamatsu
mie ise shima wakayama koyasan shiga otsu hyogo himeji awaji okayama kurashiki
hiroshima miyajima onomichi yamaguchi shimane tottori matsue kagawa takamatsu
ehime matsuyama kochi tokushima fukuoka hakata kitakyushu nagasaki kumamoto
oita beppu yufuin miyazaki kagoshima yakushima okinawa naha ishigaki miyako
hokkaido sapporo otaru hakodate furano biei asahikawa noboribetsu kushiro
universal usj disneyland disneysea skytree shibuya shinjuku asakusa ueno ginza
odaiba ikebukuro harajuku roppongi akihabara dotonbori umeda namba arashiyama
gion kiyomizu fushimi
""".split())


def norm_url(u):
    """只留乾淨的商品網址。

    ⚠️ **query 參數一律砍掉**：Klook 後台明講「現有連結若含 gclid／gbraid／wbraid
    或 UTM，會讓你拿不到佣金」，而聯盟連結是之後才由 `?aid=` 接上去的。
    帶著別人的追蹤參數存進資料，等於把佣金送給別人而畫面上完全看不出來。
    """
    return u.split('?')[0].split('#')[0]


def fetch():
    print('[klook] 抓 sitemap（一次一個檔、不重試——連打會被限速）…')
    req = urllib.request.Request(SITEMAP, headers={
        'User-Agent': UA, 'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept-Encoding': 'gzip'})
    t = time.time()
    r = urllib.request.urlopen(req, timeout=90)
    raw = r.read()
    if r.headers.get('Content-Encoding') == 'gzip':
        raw = gzip.decompress(raw)
    text = raw.decode('utf-8', 'replace')
    print('[klook] HTTP %s，%.1f MB，%.1f 秒' % (r.status, len(raw) / 1048576.0, time.time() - t))

    items = []
    for m in re.finditer(r'<loc>([^<]+)</loc>', text):
        u = norm_url(m.group(1).strip())
        a = ACT_RE.search(u)
        if not a:
            continue
        items.append({'aid': a.group(1), 'slug': a.group(2), 'url': u})
    print('[klook] 商品網址 %d 筆' % len(items))

    # ⚠️ **只留日本相關的存進快取**。全部存下來是 7 MB 的 JSON，而其中九成
    # 這個站永遠用不到；快取是要進 git 的（同 `_geocache.json`），別讓它變成負擔。
    jp = [it for it in items if set(it['slug'].split('-')) & JP_TOKENS]
    print('[klook] 其中看起來在日本的 %d 筆' % len(jp))
    os.makedirs(SRC_DIR, exist_ok=True)
    with io.open(CACHE, 'w', encoding='utf-8') as f:
        json.dump({'fetched': time.strftime('%Y-%m-%d'), 'source': SITEMAP,
                   'total': len(items), 'items': jp}, f,
                  ensure_ascii=False, indent=1)
        f.write('\n')
    print('[klook] 已寫入 %s' % os.path.relpath(CACHE, HERE))
    return 0


def load_cache():
    if not os.path.exists(CACHE):
        print('[klook] 還沒有快取，先跑一次 `python3 klook_match.py fetch`', file=sys.stderr)
        return None
    with io.open(CACHE, encoding='utf-8') as f:
        return json.load(f)


def load_aliases():
    """`places_src/_klook_alias.json`：`{"pl-kahaku": ["national-museum-of-nature"]}`

    ⚠️ **程式只讀不寫。** 它是人在維護的對照表——自動回寫的話，
    使用者改過的東西下一輪就被蓋掉，而那是靜默的（同 `build_places.py` 的
    `status` 曾被寫死成「營業中」）。
    """
    if not os.path.exists(ALIAS):
        return {}
    with io.open(ALIAS, encoding='utf-8') as f:
        return json.load(f)


def keys_of(place, aliases):
    """這個景點在 Klook 的 slug 裡可能長什麼樣。"""
    out = []
    base = place['id'][3:] if place['id'].startswith('pl-') else place['id']
    out.append(base)
    for a in aliases.get(place['id'], []):
        out.append(a.strip().lower())
    return [k for k in out if len(k) >= 4]      # 太短的會亂命中


def hit(slug, key):
    """slug 是不是含這個 key。**以連字號為詞界**，不是純子字串。

    ⚠️ 純子字串會讓 `nara`（奈良）命中 `honmaru`、`sagawa`——
    而那種誤配在報表上跟正確的長得一模一樣。
    """
    return ('-' + slug + '-').find('-' + key + '-') >= 0


def kind_of(slug):
    parts = set(slug.split('-'))
    if parts & set(TOUR_WORDS):
        return 'tour'
    if parts & set(TICKET_WORDS):
        return 'pass' if parts & set(PASS_WORDS) else 'ticket'
    return 'other'


def bare_hit(slug, key):
    """這個 slug 是不是「就是這個景點本身」（而不是一趟會經過它的行程）。

    ⚠️ **只在 `kind_of` 回 'other' 時問它**——已經看得出是門票或行程的不必猜。
    """
    toks = slug.split('-')
    ktoks = key.split('-')
    for i in range(len(toks) - len(ktoks) + 1):
        if toks[i:i + len(ktoks)] == ktoks:      # 詞界比對，只拿掉第一次出現
            toks = toks[:i] + toks[i + len(ktoks):]
            break
    rest = [t for t in toks if t not in JP_TOKENS and t not in SLUG_FILLER]
    if not rest:
        return True
    return len(rest) == 1 and rest[0] in BARE_VENUE_WORDS


def match_places(places, aliases, items):
    """把商品分給景點。回 `(rows, matched_slugs, stolen)`。

    ⚠️ **`report` 與 `serve` 共用這一份。** 分兩份寫的話，網頁上看到的候選
    與報表上的會慢慢漂移，而**兩邊各自看起來都正常**——同 `hoursHTML()`／
    `awardsHTML()` 收進共用層的理由。
    """
    # ⚠️ **「一件商品命中兩個景點」多半是對的，不要去修它**：一日遊本來就會同時
    # 經過金閣寺與伏見稻荷，兩邊都該看得到。**真正要擋的是另一種**——
    # 一個景點的比對字整個包在另一個景點的比對字裡：`railway-museum`（埼玉的鐵道博物館）
    # 會吃到 `kyoto-railway-museum-ticket`，因為短的名字連詞界都對得上。
    # 這時判給**比對字比較長**的那一個（同 `osm_place_key` 取最長那一段的理由）。
    # ⚠️ 第一版寫成「任何一件商品都只判給最長的那個 key」，於是把上面那種
    # 多景點行程全部誤判成撞名——**而報表上它看起來完全合理**，是逐筆看才發現的。
    key_owner = {}
    for p in places:
        for k in keys_of(p, aliases):
            key_owner.setdefault(k, p['id'])
    # k 被哪些更長的比對字包住（以詞界為準）
    covered_by = {}
    for k in key_owner:
        longer = [k2 for k2 in key_owner
                  if k2 != k and len(k2) > len(k) and hit(k2, k)]
        if longer:
            covered_by[k] = longer

    matched_slugs = set()
    rows = []
    stolen = []
    for p in places:
        keys = keys_of(p, aliases)
        found = []
        for it in items:
            for k in keys:
                if not hit(it['slug'], k):
                    continue
                matched_slugs.add(it['slug'])
                # 這件商品同時命中「包住我的那個更長的名字」→ 讓給它
                eaten = [k2 for k2 in covered_by.get(k, []) if hit(it['slug'], k2)]
                if eaten:
                    stolen.append((p['id'], key_owner[eaten[0]], it['url']))
                else:
                    found.append((it, k))       # 哪個比對字命中的，`bare_hit` 要用
                break
        buckets = {'ticket': [], 'bare': [], 'tour': [], 'other': [], 'pass': []}
        for it, k in found:
            kind = kind_of(it['slug'])
            if kind == 'other' and bare_hit(it['slug'], k):
                kind = 'bare'               # slug 就是景點名本身 ＝ 它自己的商品頁
            buckets[kind].append(it)
        rows.append((p, keys, buckets))
    return rows, matched_slugs, stolen


def report():
    cache = load_cache()
    if not cache:
        return 2
    with io.open(PLACES, encoding='utf-8') as f:
        places = json.load(f)['places']
    aliases = load_aliases()
    items = cache['items']
    rows, matched_slugs, stolen = match_places(places, aliases, items)

    os.makedirs(REPORT_DIR, exist_ok=True)
    L = ['Klook 候選比對報表（klook_match.py）',
         'sitemap 抓取日 %s／日本相關商品 %d 筆／站上景點 %d 筆'
         % (cache.get('fetched', '?'), len(items), len(places)),
         '',
         '⚠️ 這是**候選**不是答案：slug 裡出現景點名不代表那是這個景點的門票',
         '（實測「伏見稻荷」命中的多半是會經過那裡的一日遊）。',
         '⚠️ 商品頁擋機器人，所以標題與價格拿不到——**要開連結自己看**。',
         '']

    has = [r for r in rows if r[2]['ticket'] or r[2]['bare']]
    maybe = [r for r in rows if not (r[2]['ticket'] or r[2]['bare'])
             and (r[2]['tour'] or r[2]['other'])]
    none = [r for r in rows if not any(r[2].values())]

    L.append('【一】站上有、Klook 也有「像門票」的商品：%d 個景點' % len(has))
    L.append('')
    for p, keys, b in has:
        L.append('  %s（%s・%s）' % (p['title'], p['id'], p['area']))
        for it in b['ticket'][:8]:
            L.append('      門票? %s' % it['url'])
        if len(b['ticket']) > 8:
            L.append('      …另有 %d 件' % (len(b['ticket']) - 8))
        for it in b['bare'][:8]:
            # ⚠️ 這一種是**推論出來的**（slug 裡沒有 ticket／admission 那些字），
            # 所以標示與上面那行不同——要讓人看得出這一筆的根據比較弱。
            L.append('      門票?（網址就是景點名）%s' % it['url'])
        if len(b['bare']) > 8:
            L.append('      …另有 %d 件' % (len(b['bare']) - 8))
        if b['tour']:
            L.append('      （另有 %d 件看起來是行程／體驗，已略過）' % len(b['tour']))
        L.append('')

    L.append('【二】只找到行程／體驗，沒有像門票的：%d 個景點' % len(maybe))
    L.append('  ⚠️ 這一段多半代表「這個景點不需要買票」或「Klook 只賣經過它的行程」。')
    L.append('')
    for p, keys, b in maybe:
        n = len(b['tour']) + len(b['other'])
        L.append('  %s（%s）：%d 件行程／其他' % (p['title'], p['id'], n))
    L.append('')

    L.append('【三】完全沒有命中：%d 個景點' % len(none))
    L.append('  ⚠️ 兩種可能，**分不出來就是分不出來**：Klook 真的沒賣，')
    L.append('  或它用的名字跟我們的 id 不一樣（那要在 _klook_alias.json 補別名）。')
    L.append('')
    for p, keys, b in none:
        L.append('  %s（%s）  比對用的字：%s' % (p['title'], p['id'], '／'.join(keys)))
    L.append('')

    # 【四】反過來：Klook 有票、站上沒有這個景點
    others = [it for it in items
              if it['slug'] not in matched_slugs and kind_of(it['slug']) == 'ticket']
    passes = [it for it in items
              if it['slug'] not in matched_slugs and kind_of(it['slug']) == 'pass']
    L.append('【四】Klook 有「像門票」的商品、但沒對到站上任何景點：%d 件' % len(others))
    L.append('  ⚠️ 這一段是**擴充景點的線索**，不是待辦清單。收錄標準仍然是「值得去」，')
    L.append('  不是「Klook 有票就收」——那會讓清單退化成聯盟目錄（v3 §1-H 決策 20）。')
    L.append('  ⚠️ 而且裡面一定混著樂園、交通票、餐券與體驗，那些本來就不收。')
    L.append('')
    for it in sorted(others, key=lambda x: x['slug'])[:400]:
        L.append('  %s' % it['url'])
    if len(others) > 400:
        L.append('  …另有 %d 件（只列前 400 件，太長會沒人看）' % (len(others) - 400))
    L.append('')

    L.append('【五】通票與交通票：%d 件（**這一段不必看**，除非日後要做 Pass）' % len(passes))
    L.append('  ⚠️ 它們也帶著 pass／ticket，所以會被判成「像門票」，但一張 Pass 涵蓋')
    L.append('  好幾個景點，掛在單一景點底下會讓人以為那是那個景點的門票。')
    L.append('')

    if stolen:
        L.append('【六】比對字被另一個景點包住而讓出去的：%d 件' % len(stolen))
        for a, b, u in stolen[:40]:
            L.append('  %s → 判給 %s：%s' % (a, b, u))
        if len(stolen) > 40:
            L.append('  …另有 %d 件' % (len(stolen) - 40))

    with io.open(REPORT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(L) + '\n')

    print('[klook] 站上 %d 個景點：有門票候選 %d／只有行程 %d／完全沒命中 %d'
          % (len(places), len(has), len(maybe), len(none)))
    print('[klook] 另有 %d 件像門票的商品沒對到站上任何景點（另有通票／交通票 %d 件）'
          % (len(others), len(passes)))
    if stolen:
        print('[klook] 撞名讓出去的命中 %d 件（見報表【六】）' % len(stolen))
    print('[klook] 報表：%s' % os.path.relpath(REPORT, HERE))
    return 0


# ─────────────────────────────────────────────────────── serve（人工確認）

# ⚠️ **這支程式的產出是候選不是答案**（見檔頭），所以中間一定要有人。
# 做成網頁而不是「叫使用者改 JSON」的理由跟 `pick_photos.py serve` 一樣：
# 要做的事是「開連結、看一眼、按一下」，那在瀏覽器裡最順手。
#
# ⚠️ **每按一下就落地**（同 `pick_photos.py`）：關掉瀏覽器不會掉進度。
# 26 筆要開 26 個分頁，中途一定會被打斷。

TICKET_TYPES = [('admission', '一般入場'), ('premium', '快速通關・特別版'),
                ('combo', '組合票')]

PAGE_CSS = """
body{font:14px/1.6 -apple-system,"Hiragino Sans","Noto Sans TC",sans-serif;
     margin:0;background:#faf9f7;color:#222}
#bar{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;
     padding:10px 16px;display:flex;gap:16px;align-items:center;z-index:9;flex-wrap:wrap}
#bar b{font-size:16px} #n{font-variant-numeric:tabular-nums}
#bar label,#bar span.hint{font-size:13px;color:#666}
section{padding:12px 16px;border-bottom:1px solid #eee}
section.done{background:#f971f81a;background:#f2f8f2}
section.skip{background:#fdf3f3}
h2{margin:0 0 2px;font-size:15px}
h2 small{font-weight:400;color:#888;margin-left:8px}
.badge{font-size:11px;padding:1px 6px;border-radius:8px;margin-left:8px;
       background:#e6f0e6;color:#276}
.note{font-size:12px;color:#999;margin:2px 0 8px}
.prod{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;
      padding:8px 0;border-top:1px dashed #e5e5e5}
.prod:first-of-type{border-top:0}
.plink{flex:1 1 320px;min-width:0}
.plink a{color:#36c;word-break:break-all}
.slug{font-size:11px;color:#aaa}
.btns{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
button.t{font:13px inherit;padding:4px 10px;border:1px solid #ccc;background:#fff;
         border-radius:6px;cursor:pointer}
button.t:hover{border-color:#888}
button.t.on{background:#276;border-color:#276;color:#fff;font-weight:600}
button.t.no{border-color:#d9b3b3}
button.t.no.on{background:#b33;border-color:#b33;color:#fff}
.pri{font-size:12px;color:#666;display:flex;gap:4px;align-items:center}
.nm{font:12px inherit;padding:3px 6px;border:1px solid #ddd;border-radius:4px;width:220px}
.todo{color:#b60;font-size:12px;font-weight:600}
.warn{font-size:12px;color:#b60;background:#fff8ec;border:1px solid #f0d9b0;
      border-radius:4px;padding:4px 8px;margin:4px 0}
.nm.want{border-color:#e0a030;background:#fffaf0}
"""

PAGE_JS = r"""
function post(b){return fetch('/pick',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(count);}
function count(){fetch('/count').then(r=>r.json()).then(d=>{
  document.getElementById('n').textContent='已確認 '+d.n+' / '+d.total;});}
function sec(pid){return document.getElementById('s-'+pid);}
function paint(pid){
  var s=sec(pid), rows=[...s.querySelectorAll('.prod')];
  var todo=rows.some(r=>!r.dataset.t);
  var keep=rows.filter(r=>r.dataset.t&&r.dataset.t!=='no');
  s.className=todo?'':(keep.length?'done':'skip');
  s.querySelector('.todo').style.display=todo?'':'none';
  // 主要那一顆只在「留下兩件以上」時才需要選
  s.querySelectorAll('.pri').forEach(el=>{
    var r=el.closest('.prod');
    el.style.display=(keep.length>1&&keep.indexOf(r)>=0)?'':'none';});
  if(keep.length&&!keep.some(r=>r.dataset.p==='1')){
    keep[0].dataset.p='1';
    var rb=keep[0].querySelector('input[type=radio]'); if(rb)rb.checked=true;
  }
  // ⚠️ **留兩件時名稱幾乎是必填**：小卡上會並列兩行，若兩件的票種又一樣
  // （東京國立博物館那兩件都是一般入場），畫面上會是兩行一模一樣的字——
  // 看起來像重複的 bug，其實是兩件不同的商品。
  var need=keep.length>1;
  s.querySelectorAll('.nm').forEach(el=>{
    var kept=keep.indexOf(el.closest('.prod'))>=0;
    el.classList.toggle('want',need&&kept&&!el.value.trim());
  });
  var w=s.querySelector('.warn');
  if(w)w.style.display=(need&&keep.some(r=>!(r.querySelector('.nm')||{}).value.trim()))?'':'none';
}
var KEEP_MAX=2;                            // 一個景點在同一家平台最多留兩件
function setType(el,pid,slug,ty){
  var r=el.closest('.prod');
  if(r.dataset.t===ty)return;              // 已經是這個狀態就不動
  if(ty!=='no'){
    // ⚠️ 擋在按下去的當下並說明白，不要讓它按得下去、之後才在 apply 靜默丟掉。
    var kept=[...sec(pid).querySelectorAll('.prod')]
      .filter(x=>x!==r&&x.dataset.t&&x.dataset.t!=='no');
    if(kept.length>=KEEP_MAX){
      alert('一個景點最多留 '+KEEP_MAX+' 件。要換的話，先把其中一件按「不要」。');
      return;
    }
  }
  r.dataset.t=ty;
  r.querySelectorAll('button.t').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  if(ty==='no'){r.dataset.p='';var rb=r.querySelector('input[type=radio]');if(rb)rb.checked=false;}
  paint(pid); send(r,pid,slug);
}
function setPri(el,pid,slug){
  sec(pid).querySelectorAll('.prod').forEach(r=>r.dataset.p='');
  el.closest('.prod').dataset.p='1';
  paint(pid);
  sec(pid).querySelectorAll('.prod').forEach(r=>{if(r.dataset.t)send(r,pid,r.dataset.slug);});
}
function send(r,pid,slug){
  post({id:pid,slug:slug,type:r.dataset.t,primary:r.dataset.p==='1',
        name:(r.querySelector('.nm')||{}).value||''});
}
function onlyTodo(c){document.querySelectorAll('section').forEach(s=>{
  s.style.display=(c.checked&&s.className!=='')?'none':'';});}
document.addEventListener('DOMContentLoaded',function(){
  document.querySelectorAll('section').forEach(s=>paint(s.id.slice(2)));
  document.querySelectorAll('.nm').forEach(i=>i.addEventListener('change',function(){
    var r=this.closest('.prod'); if(r.dataset.t)send(r,r.dataset.pid,r.dataset.slug);}));
  count();
});
"""


def _cands(rows):
    """網頁與 apply 都用這一份：只有【一】那些景點，且只列像門票的候選。"""
    out = []
    for p, keys, b in rows:
        cands = b['ticket'] + b['bare']
        if cands:
            out.append((p, cands, len(b['tour']) + len(b['other'])))
    return out


def load_picks():
    if not os.path.exists(PICKS):
        return {}
    with io.open(PICKS, encoding='utf-8') as f:
        return json.load(f)


def save_picks(d):
    with io.open(PICKS, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')


def slug_of(url):
    m = ACT_RE.search(url)
    return '%s-%s' % (m.group(1), m.group(2)) if m else url


def build_page(cands, live):
    picks = load_picks()
    o = ['<!doctype html><meta charset="utf-8"><title>Klook 票券確認</title>',
         '<style>%s</style>' % PAGE_CSS,
         '<div id="bar"><b>Klook 票券確認</b><span id="n"></span>',
         '<label><input type="checkbox" onchange="onlyTodo(this)"> 只看還沒確認的</label>',
         '<span class="hint">開連結看一眼，再按下面那排。'
         '<b>不要</b>＝這件不掛（配錯了、或就是不想掛，都按它）。每按一下就存。</span></div>']
    for p, items, ntour in cands:
        pid = p['id']
        got = picks.get(pid, {})
        o.append('<section id="s-%s">' % html.escape(pid))
        o.append('<h2>%s<small>%s・%s</small>%s<span class="todo"> ← 還沒確認</span></h2>'
                 % (html.escape(p['title']), html.escape(pid), html.escape(p.get('area', '')),
                    '<span class="badge">9/2 已上線</span>' if pid in live else ''))
        if ntour:
            o.append('<div class="note">（另有 %d 件看起來是導覽團／體驗，沒有列出來）</div>' % ntour)
        o.append('<div class="warn" style="display:none">⚠️ 留了兩件，'
                 '請幫它們各填一個「商品名稱」——不然小卡上會出現兩行一樣的字。</div>')
        for it in items:
            sl = slug_of(it['url'])
            cur = got.get(sl) or {}
            ty = cur.get('type', '')
            o.append('<div class="prod" data-pid="%s" data-slug="%s" data-t="%s" data-p="%s">'
                     % (html.escape(pid), html.escape(sl), html.escape(ty),
                        '1' if cur.get('primary') else ''))
            o.append('<div class="plink"><a href="%s" target="_blank" rel="noreferrer">開商品頁 ↗</a>'
                     '<div class="slug">%s</div></div>'
                     % (html.escape(it['url']), html.escape(sl)))
            o.append('<div class="btns">')
            for key, label in TICKET_TYPES:
                o.append('<button class="t%s" onclick="setType(this,\'%s\',\'%s\',\'%s\')">%s</button>'
                         % (' on' if ty == key else '', html.escape(pid), html.escape(sl),
                            key, label))
            o.append('<button class="t no%s" onclick="setType(this,\'%s\',\'%s\',\'no\')">不要</button>'
                     % (' on' if ty == 'no' else '', html.escape(pid), html.escape(sl)))
            o.append('<label class="pri"><input type="radio" name="pri-%s"%s'
                     ' onchange="setPri(this,\'%s\',\'%s\')"> 主要</label>'
                     % (html.escape(pid), ' checked' if cur.get('primary') else '',
                        html.escape(pid), html.escape(sl)))
            o.append('<input class="nm" placeholder="商品名稱（選填，組合票才需要）" value="%s">'
                     % html.escape(cur.get('name', '')))
            o.append('</div></div>')
        o.append('</section>')
    o.append('<script>%s</script>' % PAGE_JS)
    return '\n'.join(o).encode('utf-8')


# 後端景點的地址開頭（都道府県）。**只給網頁顯示用，不進任何資料。**
PREF_RE = re.compile(r'^(.{2,3}?[都道府県])')


def backend_places(online_ids):
    """`places_src` 裡還沒上線的景點（地區桶還沒開，`places.json` 不會輸出）。

    ⚠️ **它們沒有 `area`**（那是管線算出來的），所以拿地址開頭的都道府県代替。
    ⚠️ **一起收進來是刻意的**（2026-09-02 使用者要求）：那 200 筆裡有 6 個
    Klook 有票，現在確認完，**開桶那一天它們就是完成狀態**。填了也不會上線——
    `build_places.py` 照樣會把它們擋在 `places.json` 外面。
    """
    out = []
    for f in sorted(glob.glob(os.path.join(SRC_DIR, '*.json'))):
        if os.path.basename(f).startswith('_'):
            continue
        with io.open(f, encoding='utf-8') as fh:
            d = json.load(fh)
        rows = d['places'] if isinstance(d, dict) and 'places' in d else d
        for r in rows:
            if r.get('id') in online_ids:
                continue
            m = PREF_RE.match(r.get('address', '') or '')
            out.append(dict(r, area='%s・未上線' % m.group(1) if m else '未上線'))
    return out


def _load_all():
    cache = load_cache()
    if not cache:
        return None
    with io.open(PLACES, encoding='utf-8') as f:
        places = json.load(f)['places']
    online = set(p['id'] for p in places)
    # ⚠️ **上線的排前面**，網頁上先看到會真的生效的那些。
    rows, _, _ = match_places(places + backend_places(online), load_aliases(),
                              cache['items'])
    live = set(p['id'] for p in places if p.get('tickets'))
    return _cands(rows), live


def serve():
    import http.server
    got = _load_all()
    if not got:
        return 2
    cands, live = got

    def done_n():
        picks = load_picks()
        n = 0
        for p, items, _ in cands:
            g = picks.get(p['id'], {})
            if all(slug_of(it['url']) in g for it in items):
                n += 1
        return n

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, body, ctype='text/html; charset=utf-8'):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith('/count'):
                self._send(json.dumps({'n': done_n(), 'total': len(cands)}).encode(),
                           'application/json')
            else:
                self._send(build_page(cands, live))

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            d = json.loads(self.rfile.read(n) or b'{}')
            picks = load_picks()
            rec = picks.setdefault(d['id'], {})
            rec[d['slug']] = {'type': d.get('type') or '',
                              'primary': bool(d.get('primary')),
                              'name': (d.get('name') or '').strip()}
            save_picks(picks)          # 每一下都落地，關掉瀏覽器不會掉進度
            self._send(b'{}', 'application/json')

        def log_message(self, *a):
            pass

    print('票券確認網頁：http://127.0.0.1:%d/   （確認完按 Ctrl+C 結束）' % PORT)
    print('共 %d 個景點要確認，選擇會即時存進 %s'
          % (len(cands), os.path.relpath(PICKS, HERE)))
    print('確認完再跑：python3 klook_match.py apply')
    http.server.HTTPServer(('127.0.0.1', PORT), H).serve_forever()
    return 0


# ─────────────────────────────────────────────────────── apply（寫回清單檔）

def apply_picks():
    """把確認結果寫進 `places_src/*.json` 的 `tickets`。

    ⚠️ **只動有被確認過的景點**：沒在勾選檔裡的一個字都不碰。
    ⚠️ **`aff_url` 若已經填過就保留**——那是逐筆填的後路，不可被整批覆蓋
    （同「`url` 與 `aff_url` 一定要分兩欄」那條）。
    """
    got = _load_all()
    if not got:
        return 2
    cands, _ = got
    picks = load_picks()
    if not picks:
        print('還沒有任何確認，請先跑：python3 klook_match.py serve', file=sys.stderr)
        return 2
    today = time.strftime('%Y-%m-%d')

    want = {}
    skipped = []
    for p, items, _ in cands:
        g = picks.get(p['id'])
        if not g:
            continue
        keep = []
        for it in items:
            sl = slug_of(it['url'])
            c = g.get(sl)
            if not c or not c.get('type') or c['type'] == 'no':
                if c and c.get('type') == 'no':
                    skipped.append('%s %s' % (p['id'], sl))
                continue
            keep.append((it, c))
        # 主要那一件：使用者選的優先，沒選就取第一件（同一個平台只能有一件）
        pri = None
        for it, c in keep:
            if c.get('primary'):
                pri = it['url']
                break
        if keep and pri is None:
            pri = keep[0][0]['url']
        out = []
        for it, c in keep:
            r = collections.OrderedDict()
            r['platform'] = 'klook'
            r['type'] = c['type']
            if it['url'] == pri:
                r['primary'] = True
            r['url'] = it['url']
            r['status'] = 'active'
            r['checked'] = today
            if c.get('name'):
                r['name'] = c['name']
            out.append(r)
        want[p['id']] = out

    changed = []
    for f in sorted(glob.glob(os.path.join(SRC_DIR, '*.json'))):
        if os.path.basename(f).startswith('_'):
            continue
        raw = io.open(f, encoding='utf-8').read()
        d = json.loads(raw, object_pairs_hook=collections.OrderedDict)
        rows = d['places'] if isinstance(d, dict) and 'places' in d else d
        hit = False
        for r in rows:
            if r.get('id') not in want:
                continue
            new = want[r['id']]
            # 已經填過 aff_url 的逐筆帶回來（鍵是乾淨的商品網址）
            old = {t.get('url'): t.get('aff_url', '') for t in (r.get('tickets') or [])}
            for t in new:
                if old.get(t['url']):
                    t['aff_url'] = old[t['url']]
            if new:
                r['tickets'] = new
            else:
                r.pop('tickets', None)
            hit = True
        if hit:
            out = json.dumps(d, ensure_ascii=False, indent=2)
            if raw.endswith('\n'):
                out += '\n'                  # 檔尾照原樣，不多也不少
            # ⚠️ **內容一樣就不要寫**：寫了也沒事，但報表會列出一個其實沒變的檔名，
            # 而那會讓人以為改到了東西、跑去 git 找卻找不到。
            if out != raw:
                io.open(f, 'w', encoding='utf-8').write(out)
                changed.append(os.path.basename(f))

    n = sum(len(v) for v in want.values())
    print('[klook] 寫回 %d 個景點共 %d 件商品，剔除 %d 件'
          % (len([v for v in want.values() if v]), n, len(skipped)))
    for x in skipped:
        print('   不要：%s' % x)
    print('[klook] 動到的檔：%s' % ('、'.join(changed) or '無'))
    print('[klook] 接著跑：python3 build_places.py')
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'fetch':
        return fetch()
    if cmd == 'report':
        return report()
    if cmd == 'serve':
        return serve()
    if cmd == 'apply':
        return apply_picks()
    print(__doc__)
    return 1


if __name__ == '__main__':
    sys.exit(main())
