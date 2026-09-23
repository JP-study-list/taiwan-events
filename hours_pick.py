# -*- coding: utf-8 -*-
"""單位 け：補景點的 `hours_url`，三段式（fetch → serve → apply）。

    python3 hours_pick.py fetch [--ids a,b,c] [--limit N]   # 探測候選並抓節錄
    python3 hours_pick.py serve                             # 網頁逐筆確認
    python3 hours_pick.py apply [--dry-run]                 # 寫回 places_src/*.json

⚠️⚠️ **為什麼非要人看一眼不可**：本專案最該防的不是死連結，是
**「抓得到的時刻不是這個設施的時刻」**（CLAUDE.md 那條 2026-08-21 的教訓）。
那一頁活著、時刻真的印在上面、`hours_grounded()` 一路放行，只是那個時刻屬於
館內商店、團體導覽、泳池那一區，或是一場一次性的活動。實測 2026-09-10 那輪
44 筆自動命中裡**約一半是這一種**，而且**只看網址或只看筆數都看不出來**。
所以這支程式的產出依定義是**候選不是答案**（同 `klook_match.py`／`pick_photos.py`）。

⚠️ **不可以把候選直接填進 `places_src`**：填進資料層之後，「這一筆有沒有人看過」
就再也看不出來了（CLAUDE.md 那條通則）。

⚠️ 一律用管線自己的 `fetch_page()`，不用 `curl` 代替——2026-08-21 的教訓：
curl 拿得到而 Jina 拿不到的頁面是存在的，用 curl 驗會驗出一批假的成功。
"""
import glob
import json
import os
import re
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_places as bp                                    # noqa: E402

PLACES = os.path.join(HERE, 'places.json')
SRC_DIR = os.path.join(HERE, 'places_src')
# 候選快取：fetch 的產出。**累積式**——日後補剩下那批時同一支再跑，已經看過的不必重抓。
CACHE = os.path.join(SRC_DIR, '_hourscache.json')
# 使用者的決定：serve 每按一下就落地。進 git，同 `_photopick.json`／`_klook_pick.json`。
# ⚠️ 「都不要」也一定要記下來（值 `{"no": 1}`），否則下一輪會拿同樣那幾筆再問一次
# ——同 `_photoskip.json` 存在的理由。
PICKS = os.path.join(SRC_DIR, '_hours_pick.json')
PORT = 8903                                                  # 8901 挑圖、8902 選票券

MAX_CAND = 4          # 一筆最多抓幾個候選頁：多了挑不動，而每一頁都是一次 Jina
# ⚠️ **快取存長的、顯示時才裁切。** 截短了存是不可逆的：`hours_excerpt()` 的產出
# 可能上千字，而要給人看的是**時刻周圍那一段**，未必落在開頭 400 字裡。
# 第一版存 `ex[:420]` 的結果是卡片上顯示 Jina 的標頭與圖片語法，對判斷毫無幫助。
CACHE_CHARS = 1600
SHOW_WINDOW = 240     # 顯示時取時刻前後各幾個字

# 連結文字的兩級關鍵字。強＝這一頁幾乎一定在講開放時間；弱＝泛稱，可能是交通或簡介。
STRONG = re.compile(r'営業時間|開館時間|開園時間|開館・休館|利用案内|ご利用案内|入館案内|'
                    r'入園案内|開館情報|営業案内|拝観時間|拝観案内|開館日|休館日|休園日|'
                    r'料金.*時間|時間.*料金|入館料|拝観料|観覧案内', re.I)
WEAK = re.compile(r'アクセス|交通|インフォメーション|施設案内|施設情報|来館案内|来園案内|'
                  r'ご案内|基本情報|概要|about|access|info|guide|visit', re.I)

# ⚠️ markdown 連結。`(?<!!)` 不可省 —— 少了它 `![alt](url)` 的後半段也會被當成連結，
# 2026-09-10 那輪因此多報了 10 筆假陽性（秋芳洞挑到 `s6_img04.png`、熱田神宮挑到
# 一張交通管制地圖的 PDF），而**它們還「通過」了時刻檢查**：Jina 對圖片網址回的
# 東西裡剛好有數字。症狀是「數字很漂亮而且每一筆都有網址」。
LINK = re.compile(r'(?<!!)\[([^\]]{1,60})\]\((https?://[^\s)]+)\)')
ASSET = re.compile(r'\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|docx?|xlsx?)(?:[?#]|$)', re.I)

# 網頁上要標紅的兩種風險。**只標不擋**——判斷是使用者的，程式只負責讓他看見。
RISK_URL = re.compile(r'/news/|/event/|/topics/|/blog/|/information/\d|'
                      r'/20\d{2}[-/_]?\d{2}|\d{4}setsubun|calender|calendar', re.I)
RISK_TEXT = re.compile(r'売店|ショップ|レストラン|カフェ|団体|プール|pool|宴会|宿泊|'
                       r'駐車場|イベント|ニュース|お知らせ', re.I)
# ⚠️⚠️ **時刻一律用管線自己那一份 `bp._TIME_RE`，不要在這裡另寫一個。**
# 它要求「冒號前後無空白且分鐘兩位」，那是 2026-08-21 用淺草寺實測換來的：
# 寬鬆一點寫的話，Jina 的圖片標記 `[Image 62: …]` 會被當成「62 時」，
# 於是卡片上會標出一整排假時刻，而那**看起來跟真的一模一樣**。
TIME_RE = bp._TIME_RE
# markdown 的雜訊：圖片整個丟掉，連結只留文字。**只影響顯示，不影響管線判斷。**
MD_IMG = re.compile(r'!\[[^\]]*\]\([^)]*\)')
MD_LINK = re.compile(r'\[([^\]]*)\]\([^)]*\)')
MD_HEAD = re.compile(r'^(Title|URL Source|Markdown Content|Published Time|Warning):.*$',
                     re.M)


def load_json(p, d):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return d


def save_json(p, obj):
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')


def places():
    return load_json(PLACES, {}).get('places', [])


def targets():
    """要處理的母體：**沒有營業時間、沒填 `hours_url`、而且不是本來就沒有時間的**。

    ⚠️ 判準刻意不看 `hours_fail`：那個欄位在「這一輪還沒輪到」時是空的
    （分批之後每輪只抓一部分），拿它當條件會讓母體隨輪次忽大忽小。
    """
    out = []
    for p in places():
        if p.get('no_hours') or p.get('hours') or p.get('hours_url'):
            continue
        out.append(p)
    return out


# ─────────────────────────────────────────────────────── fetch

def links_of(page, base):
    """回 (強候選, 弱候選)，各為 [(文字, 網址)]。同網域、去重、保留順序。"""
    host = urllib.parse.urlparse(base).netloc.lower().replace('www.', '')
    strong, weak, seen = [], [], set()
    for m in LINK.finditer(page):
        text, url = m.group(1).strip(), m.group(2)
        if not text or url in seen:
            continue
        if ASSET.search(urllib.parse.urlparse(url).path):    # 圖片與 PDF 不是頁面
            continue
        h = urllib.parse.urlparse(url).netloc.lower().replace('www.', '')
        if h != host:                                        # 外部連結一律不跟
            continue
        if url.rstrip('/') == base.rstrip('/'):
            continue
        seen.add(url)
        if STRONG.search(text):
            strong.append((text, url))
        elif WEAK.search(text):
            weak.append((text, url))
    return strong, weak


def excerpt_of(page):
    """那一頁的節錄、時刻數，以及**有沒有命中營業時間關鍵字**。

    ⚠️⚠️ 第三個值不可省。`hours_excerpt()` 一個關鍵字都沒命中時會**退回開頭那一段**
    （那是刻意的，寧可讓模型自己看一眼），所以「節錄有內容」不等於「這一頁有營業時間」
    ——而兩者在卡片上長得一模一樣。沒命中就是強烈訊號，要標出來給人看。
    """
    if not page:
        return '', 0, False
    ex = bp.hours_excerpt(page) or ''
    return ex, len(bp._times(ex)), bool(bp.HOURS_KEY_RE.search(page))


def cmd_fetch(ids=None, limit=0):
    cache = load_json(CACHE, {})
    todo = [p for p in targets() if p['id'] not in cache]
    if ids:
        want = set(ids)
        todo = [p for p in targets() if p['id'] in want]      # 指定 id 時允許重抓
    if limit:
        todo = todo[:limit]
    print('[fetch] 母體 %d 筆／這次要探測 %d 筆（已在快取 %d 筆）'
          % (len(targets()), len(todo), len(cache)), flush=True)
    if not todo:
        return

    t0 = time.time()
    for i, p in enumerate(todo):
        if i:
            time.sleep(bp.PLACE_WAIT)
        rec = {'title': p['title'], 'title_ja': p.get('title_ja', ''),
               'area': p.get('area', ''), 'genre': p.get('genre', ''),
               'url': p['url'], 'home': 'ok', 'cands': [],
               'at': time.strftime('%Y-%m-%d')}
        home = bp.fetch_page(p['url'])
        if home is None:
            # ⚠️ 「抓不到」與「抓到了但沒有候選」是兩件事，分開記：前者是死連結或
            # 被擋（要換網址或放棄），後者是網站結構問題（可能要多跟一層）。
            rec['home'] = 'dead'
            cache[p['id']] = rec
            save_json(CACHE, cache)
            print('%3d/%d %-24s 首頁抓不到' % (i + 1, len(todo), p['title'][:22]), flush=True)
            continue
        s, w = links_of(home, p['url'])
        picks = [('strong', t, u) for t, u in s[:3]] + [('weak', t, u) for t, u in w[:3]]
        for kind, text, url in picks[:MAX_CAND]:
            time.sleep(bp.PLACE_WAIT)
            ex, n, key = excerpt_of(bp.fetch_page(url))
            rec['cands'].append({'kind': kind, 'text': text, 'url': url,
                                 'times': n, 'key': key, 'ex': ex[:CACHE_CHARS]})
        cache[p['id']] = rec
        save_json(CACHE, cache)                               # 每一筆都落地，中斷不掉進度
        hit = len([c for c in rec['cands'] if c['times']])
        print('%3d/%d %-24s 強%d 弱%d → 抓了 %d 頁、%d 頁有時刻'
              % (i + 1, len(todo), p['title'][:22], len(s), len(w),
                 len(rec['cands']), hit), flush=True)
    print('\n[fetch] 完成，耗時 %.0f 分。接著跑：python3 hours_pick.py serve'
          % ((time.time() - t0) / 60), flush=True)


# ─────────────────────────────────────────────────────── serve

def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def _trim_tail(s):
    """砍掉硬切留下的半截 markdown。

    ⚠️ **要用兩次**：一次在清理時（節錄本身是硬切的），一次在 `show_excerpt`
    取完窗口之後（那一刀同樣會切在連結中間）。少了第二次，卡片尾端會冒出
    `](http` 這種碎片，而它看起來只是「節錄有點亂」。
    """
    s = re.sub(r'\[!?\[?[^\]\n]*\][ \t]*\($', '', s)   # `[![Image 3](`、`[Language](`
    s = re.sub(r'!?\[+[^\]\n]*$', '', s)                 # 連 `]` 都還沒出現
    return re.sub(r'\]?\(?https?:?/{0,2}$', '', s)         # 只剩半個網址開頭


def clean_md(s):
    """Jina 的 markdown → 讀得下去的純文字。**只用於顯示。**"""
    s = MD_HEAD.sub('', s)
    s = MD_IMG.sub('', s)
    s = MD_LINK.sub(r'\1', s)
    s = re.sub(r'https?://\S+', '', s)
    s = _trim_tail(s)
    s = re.sub(r'^#{1,6}[ \t]*$', '', s, flags=re.M)      # 只剩井字號的空標題行
    s = re.sub(r'[ \t]*\n[ \t]*', '\n', s)
    return re.sub(r'\n{2,}', '\n', s).strip()


def show_excerpt(ex):
    """挑出**時刻周圍**那一段給人看。

    節錄可能上千字，而使用者要判斷的只有一件事：「這幾個數字是誰的時間」。
    從頭截的話，時刻常常落在畫面外——那正是第一版沒用的原因。
    """
    s = clean_md(ex)
    m = TIME_RE.search(s)
    if not m:
        return s[:SHOW_WINDOW * 2]
    a, b = max(0, m.start() - SHOW_WINDOW), min(len(s), m.start() + SHOW_WINDOW)
    return ('……' if a else '') + _trim_tail(s[a:b].strip()) + ('……' if b < len(s) else '')


def mark_times(s):
    """把時刻高亮。使用者要判斷的就是「這幾個數字是誰的時間」。"""
    return TIME_RE.sub(lambda m: '<b>%s</b>' % m.group(0), esc(s))


def build_page():
    cache, picks = load_json(CACHE, {}), load_json(PICKS, {})
    ids = [p['id'] for p in targets() if p['id'] in cache]
    done = len([i for i in ids if i in picks])
    rows = []
    for pid in ids:
        r = cache[pid]
        cur = picks.get(pid) or {}
        cards = []
        for j, c in enumerate(r['cands']):
            risk = []
            if RISK_URL.search(c['url']):
                risk.append('網址像是新聞或活動頁')
            if RISK_TEXT.search(c['text']):
                risk.append('連結文字指向館內設施或公告')
            if not c['times']:
                risk.append('這一頁節錄不到任何時刻')
            elif not c.get('key', True):
                # 有時刻但整頁沒有一個「営業時間／開館／拝観」那類的詞：
                # 那個時刻多半是別的東西（電話受理時間、活動場次、車班）。
                risk.append('整頁沒有營業時間那類的詞，這些時刻可能不是開放時間')
            sel = 'on' if cur.get('u') == c['url'] else ''
            cards.append(
                '<div class="cand %s" data-id="%s" data-u="%s">'
                '<div class="ch"><span class="kind %s">%s</span>'
                '<span class="txt">%s</span><span class="n">%d 個時刻</span></div>'
                '<a class="u" href="%s" target="_blank" rel="noreferrer">%s</a>'
                '%s<div class="ex">%s</div>'
                '<button class="take" data-id="%s" data-u="%s">採用這一頁</button></div>'
                % (sel, esc(pid), esc(c['url']), c['kind'],
                   '強' if c['kind'] == 'strong' else '弱',
                   esc(c['text']), c['times'], esc(c['url']), esc(c['url'][:90]),
                   ('<div class="risk">⚠ %s</div>' % esc('；'.join(risk))) if risk else '',
                   mark_times(show_excerpt(c['ex'])) or '<i>（這一頁沒有節錄到內容）</i>',
                   esc(pid), esc(c['url'])))
        if not cards:
            cards.append('<div class="none">%s</div>'
                         % ('首頁抓不到，可能是死連結或被擋'
                            if r['home'] == 'dead' else '首頁上找不到任何像營業時間的連結'))
        state = ('已選 ' + esc(cur['u'][:60])) if cur.get('u') else (
            '這一筆不要' if cur.get('no') else '')
        rows.append(
            '<section class="p %s" id="p-%s"><h2>%s <small>%s</small></h2>'
            '<div class="meta">%s・%s　官網 '
            '<a href="%s" target="_blank" rel="noreferrer">%s</a></div>'
            '<div class="state">%s</div>'
            '<div class="cands">%s</div>'
            '<button class="no" data-id="%s">這一筆都不要</button>'
            '</section>'
            % ('done' if pid in picks else '', esc(pid), esc(r['title']),
               esc(r['title_ja']), esc(r['area']), esc(r['genre']),
               esc(r['url']), esc(r['url'][:70]), state, ''.join(cards), esc(pid)))

    tpl = '''<!doctype html><meta charset="utf-8">
<title>補營業時間頁（單位 け）</title>
<style>
:root{color-scheme:light dark;--pa:#faf8f4;--in:#1b1a17;--in2:#5c584f;--li:#e2ddd2;--ac:#14868A}
@media(prefers-color-scheme:dark){:root{--pa:#141311;--in:#ece8df;--in2:#a6a096;--li:#33302a}}
body{margin:0;background:var(--pa);color:var(--in);
 font:15px/1.65 -apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
header{position:sticky;top:0;background:var(--pa);border-bottom:1px solid var(--li);
 padding:12px 20px;z-index:9}
h1{font-size:17px;margin:0 0 4px}
.bar{height:6px;background:var(--li);border-radius:3px;overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;background:var(--ac)}
main{max-width:900px;margin:0 auto;padding:20px}
.p{border:1px solid var(--li);border-radius:12px;padding:16px;margin:0 0 20px;background:#0001}
.p.done{opacity:.5}
h2{font-size:16px;margin:0 0 2px}
h2 small{font-weight:400;color:var(--in2);margin-left:6px}
.meta{color:var(--in2);font-size:13px;margin-bottom:10px}
.state{font-size:13px;color:var(--ac);min-height:19px;margin-bottom:6px}
.cand{border:1px solid var(--li);border-radius:9px;padding:10px 12px;margin-bottom:10px}
.cand.on{border-color:var(--ac);box-shadow:inset 0 0 0 1px var(--ac)}
.ch{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.kind{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--li)}
.kind.strong{background:var(--ac);color:#fff}
.txt{font-weight:600}
.n{color:var(--in2);font-size:12px}
.u{font-size:12px;color:var(--in2);word-break:break-all;display:block;margin-bottom:6px}
.risk{color:#b4341c;font-size:12.5px;margin-bottom:6px}
@media(prefers-color-scheme:dark){.risk{color:#e8735a}}
.ex{font-size:13px;color:var(--in2);white-space:pre-wrap;max-height:150px;overflow:auto;
 background:#8881;padding:8px;border-radius:6px}
.ex b{color:var(--in);background:#14868a22;padding:0 2px;border-radius:3px}
button{font:inherit;font-size:13px;padding:6px 14px;border-radius:8px;cursor:pointer;
 border:1px solid var(--li);background:transparent;color:var(--in);margin-top:8px}
.take{border-color:var(--ac);color:var(--ac)}
.take:hover{background:var(--ac);color:#fff}
.no:hover{background:var(--li)}
.none{color:var(--in2);font-size:13px;padding:8px 0}
</style>
<header><h1>補營業時間頁　<span id="c">@DONE@</span>/@TOTAL@ 筆已決定</h1>
<div class="bar"><i id="b" style="width:@PCT@%"></i></div></header>
<main>@ROWS@</main>
<script>
function post(u,d){return fetch(u,{method:'POST',body:JSON.stringify(d)})
 .then(r=>r.json()).then(j=>{document.getElementById('c').textContent=j.n;
 document.getElementById('b').style.width=(j.n/j.total*100)+'%';});}
document.addEventListener('click',e=>{
 const t=e.target.closest('.take'), n=e.target.closest('.no');
 if(t){const s=t.closest('.p');
  post('/pick',{id:t.dataset.id,u:t.dataset.u}).then(()=>{
   s.classList.add('done');
   s.querySelector('.state').textContent='已選 '+t.dataset.u.slice(0,60);
   s.querySelectorAll('.cand').forEach(c=>c.classList.toggle('on',c.dataset.u===t.dataset.u));
  });}
 if(n){const s=n.closest('.p');
  post('/pick',{id:n.dataset.id,no:1}).then(()=>{
   s.classList.add('done');
   s.querySelector('.state').textContent='這一筆不要';
   s.querySelectorAll('.cand').forEach(c=>c.classList.remove('on'));
  });}
});
</script>'''
    # ⚠️ 用佔位符替換而不是 `%` 格式化：模板裡的 CSS 與 JS 本來就含 `%`
    # （`width:100%`、`+'%'`），走格式化的話每一個都要跳脫成 `%%`，
    # 而漏一個是 ValueError 不是靜默出錯——但那會在「網頁打不開」的時候才現形。
    return (tpl.replace('@DONE@', str(done)).replace('@TOTAL@', str(len(ids)))
            .replace('@PCT@', str(100 * done // max(len(ids), 1)))
            .replace('@ROWS@', ''.join(rows)).encode())


def cmd_serve():
    import http.server
    if not load_json(CACHE, {}):
        sys.exit('還沒有候選快取，請先跑：python3 hours_pick.py fetch')

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, body, ctype='text/html; charset=utf-8'):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._send(build_page())

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            d = json.loads(self.rfile.read(n) or b'{}')
            picks, cache = load_json(PICKS, {}), load_json(CACHE, {})
            pid = d.get('id')
            if d.get('u'):
                picks[pid] = {'u': d['u'], 'd': time.strftime('%Y-%m-%d')}
            elif d.get('no'):
                picks[pid] = {'no': 1, 'd': time.strftime('%Y-%m-%d')}
            else:
                picks.pop(pid, None)
            save_json(PICKS, picks)          # 每一下都落地，關掉瀏覽器不會掉進度
            ids = [p['id'] for p in targets() if p['id'] in cache]
            self._send(json.dumps({'n': len([i for i in ids if i in picks]),
                                   'total': len(ids)}).encode(), 'application/json')

        def log_message(self, *a):
            pass

    print('確認網頁：http://127.0.0.1:%d/   （看完按 Ctrl+C 結束）' % PORT)
    print('每按一下就存進 %s' % PICKS)
    print('全部決定完之後跑：python3 hours_pick.py apply')
    http.server.HTTPServer(('127.0.0.1', PORT), H).serve_forever()


# ─────────────────────────────────────────────────────── apply

def set_hours_url(raw, pid, url):
    """在原始文字裡把那一筆的 `hours_url` 換成 url。回 (新內容, 是否有動)。

    ⚠️⚠️ **文字切除，不是 `json.loads` 再 `dumps` 回去。** `places_src` 的檔多半是
    「一筆擠一行」的緊湊寫法，重寫會把它展開成一行一欄位，**在 diff 裡混進幾百行
    無關改動**，真正改了什麼就淹沒在裡面（同 `pick_photos.py` 的 `_cut_rows`
    與單位 U-2 選擇逐行刪除的理由）。
    """
    import pick_photos as pp                                  # 共用 `_spans`，不抄一份
    for a, b in pp._spans(raw):
        seg = raw[a:b]
        if json.loads(seg).get('id') != pid:
            continue
        m = re.search(r'"hours_url"\s*:\s*"([^"]*)"', seg)
        if not m:
            raise ValueError('%s 這一筆沒有 hours_url 欄位' % pid)
        if m.group(1):
            return raw, False                                 # 已經填過了，不覆蓋
        new = seg[:m.start()] + '"hours_url": %s' % json.dumps(url, ensure_ascii=False) \
            + seg[m.end():]
        return raw[:a] + new + raw[b:], True
    return raw, False


def set_no_hours(raw, pid):
    """在原始文字裡替那一筆補上 `"no_hours": true`。回 (新內容, 是否有動)。

    ⚠️ **縮排要跟著原檔的寫法走。** `places_src` 兩種格式並存：有的一行一欄位、
    有的一整筆擠一行。寫死換行會把緊湊的那幾個檔在 diff 裡撐開。
    """
    import pick_photos as pp
    for a, b in pp._spans(raw):
        seg = raw[a:b]
        if json.loads(seg).get('id') != pid:
            continue
        if json.loads(seg).get('no_hours'):
            return raw, False                                 # 已經標過了
        m = re.search(r'(\n[ \t]*)?"hours_url"\s*:\s*"[^"]*"', seg)
        if not m:
            raise ValueError('%s 這一筆沒有 hours_url 欄位' % pid)
        sep = m.group(1) or ' '
        new = seg[:m.end()] + ',' + sep + '"no_hours": true' + seg[m.end():]
        return raw[:a] + new + raw[b:], True
    return raw, False


def cmd_apply(dry_run=False):
    picks = load_json(PICKS, {})
    take = {k: v['u'] for k, v in picks.items() if v.get('u')}
    # `nh` ＝這個景點本來就沒有常規營業時間。**與「都不要」（`no`）是兩件事**：
    # 後者只是「這一輪的候選都不對」，景點仍留在母體裡每月重試。
    nh = [k for k, v in picks.items() if v.get('nh')]
    if not take and not nh:
        sys.exit('還沒有任何決定，請先跑：python3 hours_pick.py serve')
    files = [f for f in sorted(glob.glob(os.path.join(SRC_DIR, '*.json')))
             if not os.path.basename(f).startswith('_')]
    done, seen = 0, set()
    for f in files:
        raw = open(f, encoding='utf-8').read()
        before = json.loads(raw)
        out, hit = raw, []
        for pid, url in take.items():
            if pid in seen:
                continue
            out2, ok = set_hours_url(out, pid, url)
            if ok:
                out, hit = out2, hit + [pid]
                seen.add(pid)
        for pid in nh:
            if pid in seen:
                continue
            out2, ok = set_no_hours(out, pid)
            if ok:
                out, hit = out2, hit + [pid + '(no_hours)']
                seen.add(pid)
        if not hit:
            continue
        after = json.loads(out)                               # 守門①：還是合法 JSON
        bl = before['places'] if isinstance(before, dict) else before
        al = after['places'] if isinstance(after, dict) else after
        # 守門②：除了那幾筆的 hours_url，**其餘逐欄相同**。
        # 少了它，一個寫歪的正規表達式會安靜地改到別的欄位。
        assert len(bl) == len(al), '%s 筆數變了' % f
        for x, y in zip(bl, al):
            # ⚠️ 比「其餘欄位」而不是「把 hours_url 蓋成一樣再整包比」：**有些筆
            # 原本連 hours_url 這個欄位都沒有**，後者會因為鍵的有無而誤判成
            # 「欄位被動到」——第一次乾跑就是這樣被自己的守門擋下來的。
            skip = ('hours_url', 'no_hours')
            x2 = {k: v for k, v in x.items() if k not in skip}
            y2 = {k: v for k, v in y.items() if k not in skip}
            assert x2 == y2, '%s 的 %s 除了 hours_url 之外還有欄位被動到' % (f, x.get('id'))
        print('%-34s %d 筆：%s' % (os.path.basename(f), len(hit), '、'.join(hit)))
        if not dry_run:
            open(f, 'w', encoding='utf-8').write(out)
        done += len(hit)
    missing = [p for p in list(take) + nh if p not in seen]
    print('\n%s：%d 筆寫進 places_src' % ('試跑（沒有動檔）' if dry_run else '完成', done))
    if missing:
        print('⚠️ 有 %d 筆沒有寫進去（已經填過或找不到）：%s' % (len(missing), '、'.join(missing)))
    if not dry_run and done:
        print('\n接著重跑管線讓 places.json 跟上：\n    python3 build_places.py')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'fetch':
        _ids = None
        if '--ids' in sys.argv:
            _ids = [s for s in sys.argv[sys.argv.index('--ids') + 1].split(',') if s]
        _lim = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else 0
        cmd_fetch(_ids, _lim)
    elif cmd == 'serve':
        cmd_serve()
    elif cmd == 'apply':
        cmd_apply('--dry-run' in sys.argv)
    else:
        sys.exit(__doc__)
