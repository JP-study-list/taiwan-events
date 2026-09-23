#!/usr/bin/env python3
"""從 Klook 的門票商品反推「站上還沒收的景點」（單位 R，2026-09-03）。

⚠️⚠️ **這一支的紅線寫在最前面，因為它最容易滑掉**：

> **收錄標準仍然是「值得去」，不是「Klook 上有票的才收」。**
> 每一筆都要問得出：**就算它沒有票，我也會收嗎？**

`klook_match.py` 是**站上已有景點 → 找它的票**（那時「這是哪個景點」是已知的）。
**這一支是反過來**：Klook 有票、站上沒有這個景點，等於要從零建一筆——
而 Klook 那邊只拿得到一串英文網址（商品頁擋 DataDome，實測 403，
**繞過它是規避存取控制，本專案不做**）。

所以流程是三段，中間那段**由人／AI 去查公開資料**，不是這支程式去抓 Klook：

    python3 klook_scout.py prepare   # ① 從 sitemap 快取挑出候選、分兩堆（不打網路）
    （中間）AI 逐筆查日文名／地址／官網，寫進 _klook_scout.json 的 guess
    python3 klook_scout.py serve     # ② 網頁上逐筆看、要／不要、選票種
    python3 klook_scout.py apply     # ③ 寫回 places_src/，再跑 build_places.py

⚠️ **候選不可以由程式直接填進資料層**（2026-09-02 使用者退回過一次）：
填進去之後「這一筆有沒有人看過」就再也看不出來了。同 `pick_photos.py` 的三段式。
"""
import collections
import glob
import html
import importlib.util
import io
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(HERE, 'places_src')
SCOUT = os.path.join(SRC_DIR, '_klook_scout.json')
PLACES = os.path.join(HERE, 'places.json')
PORT = 8767            # 與 klook_match.py 的 8766 錯開，兩個網頁可以同時開


def _km():
    """借 klook_match 的 sitemap 快取與比對邏輯。**只讀不改那一支。**

    ⚠️ 不要把 `kind_of`／`match_places` 抄一份過來——抄一份就變成改一邊要改兩邊，
    而漏改的症狀是「這一支認得的商品跟報表裡的不一樣」，兩邊各自看起來都正常。
    （同 `build_places.py` import `build_restaurants.py` 的理由。）
    """
    spec = importlib.util.spec_from_file_location('klook_match', os.path.join(HERE, 'klook_match.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# ── 分堆：哪些「一看就不是景點」 ────────────────────────────────
# ⚠️ **這份表是量出來的**（2026-09-03 對那 212 件做 token 詞頻），不是憑印象列的。
# ⚠️⚠️ **分錯堆的代價不對稱**：放進 noise 只是折疊起來（點得開），放進 place 只是多看幾筆。
#    所以**寧可保守**——只有非常確定的才進來。實測踩到兩個差點誤殺的：
#    `onsen` 是**真的溫泉設施**（別府地獄溫泉、萬葉之湯），`tobu` 底下有東武世界廣場
#    與東武動物園（都是景點），只有東武百貨的餐券是雜訊——**所以判準是那個字本身，
#    不是它前面的品牌**。
NOISE_WORDS = (
    'pass',                                   # 城市／區域通票，一張涵蓋好幾個景點（單位 F 的地盤）
    'coupon',                                 # 餐券、商場折價券
    'show', 'club', 'sumo', 'samurai',        # 相撲秀、忍者秀、夜店
    'baseball', 'match', 'vip',
    'universal', 'studios',                   # 環球影城
    'disneyland', 'disneysea', 'disney',
    'yomiuriland', 'sanrio', 'puroland',
    'fujiq', 'legoland', 'joypolis',          # 主題樂園一律不收（營業時間逐日公告）
)

# 從 slug 還原成人看得懂的英文名時要丟掉的字。
DROP = set('''ticket tickets admission entry entrance eticket direct e voucher
1 2 3 day days in of the and with for at to a an on from only
'''.split())


def name_en_of(slug, jp_tokens):
    """把 slug 還原成一個「拿去搜尋用」的英文名。

    ⚠️ **地名要留著**（`akiyoshido-cave` + `yamaguchi`）：搜尋時多一個縣名，
    命中率差很多——實測 `Akiyoshido Cave` 單查在 OSM 是查無，
    加上縣名去搜尋引擎一次就中。
    """
    toks = [t for t in slug.split('-') if t not in DROP and not t.isdigit()]
    return ' '.join(toks)


def city_of(slug, jp_tokens):
    hits = [t for t in slug.split('-') if t in jp_tokens]
    return hits[-1] if hits else ''


def load_scout():
    if not os.path.exists(SCOUT):
        return {}
    with io.open(SCOUT, encoding='utf-8') as f:
        return json.load(f)


def save_scout(d):
    with io.open(SCOUT, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')


def prepare():
    """① 從 sitemap 快取挑出「像門票、但沒對到站上任何景點」的商品，分兩堆。

    ⚠️ **既有的 guess／pick 一律保留**（同 `--force` 之前的每一支管線）：
    重跑一次不可以把已經查好的資料或已經按過的決定清掉。
    """
    km = _km()
    cache = km.load_cache()
    if not cache:
        print('沒有 sitemap 快取，請先跑：python3 klook_match.py fetch', file=sys.stderr)
        return 2
    with io.open(PLACES, encoding='utf-8') as f:
        places = json.load(f)['places']
    items = cache['items']
    rows, matched, _ = km.match_places(places, km.load_aliases(), items)
    others = [it for it in items
              if it['slug'] not in matched and km.kind_of(it['slug']) == 'ticket']

    old = load_scout()
    old_items = {x['slug']: x for x in old.get('items', [])}
    out = []
    # ⚠️ **第二輪的項目不是 prepare 產生的**（它們來自 `add2`），所以重跑時必須原樣保留
    #    ——否則第二輪查好的資料會被清光，而且是靜默的。
    keep2 = [x for x in old.get('items', []) if x.get('round') == 2]
    for it in sorted(others, key=lambda x: x['slug']):
        toks = set(it['slug'].split('-'))
        prev = old_items.get(it['slug'], {})
        out.append({
            'aid': it['aid'],
            'slug': it['slug'],
            'url': it['url'],
            'name_en': name_en_of(it['slug'], km.JP_TOKENS),
            'city': city_of(it['slug'], km.JP_TOKENS),
            'bucket': 'noise' if toks & set(NOISE_WORDS) else 'place',
            'guess': prev.get('guess'),      # ← 中間那段由 AI 填
            'pick': prev.get('pick'),        # ← serve 落地的決定
            'round': 1,
        })
    out.extend(keep2)
    d = {'generated': cache.get('fetched', ''), 'items': out}
    save_scout(d)
    r1 = [x for x in out if x.get('round') != 2]
    n_place = sum(1 for x in r1 if x['bucket'] == 'place')
    n_guess = sum(1 for x in out if x['guess'])
    print('[scout] 第一輪候選 %d 件：像景點的 %d／樂園·餐券·通票等 %d'
          % (len(r1), n_place, len(r1) - n_place))
    if keep2:
        print('[scout] 第二輪（人工掃 other 挖出來的）%d 件，原樣保留' % len(keep2))
    print('[scout] 其中已經查好資料的 %d 件' % n_guess)
    print('[scout] 已寫入 %s' % os.path.relpath(SCOUT, HERE))
    cd = collections.Counter(x['city'] or '(看不出)' for x in r1 if x['bucket'] == 'place')
    print('[scout] 像景點的那堆，地區分布：%s'
          % '／'.join('%s %d' % (k, v) for k, v in cd.most_common(10)))
    return 0


def todo():
    """印出「還沒查資料」的那些，給中間那段用。"""
    d = load_scout()
    if not d:
        print('請先跑：python3 klook_scout.py prepare', file=sys.stderr)
        return 2
    only = sys.argv[2] if len(sys.argv) > 2 else 'place'
    rest = [x for x in d['items'] if not x['guess'] and (only == 'all' or x['bucket'] == only)]
    print('# 還沒查的 %d 件（bucket=%s）' % (len(rest), only))
    for x in rest:
        print('%s\t%s\t%s' % (x['slug'], x['name_en'], x['city']))
    return 0


def add2():
    """把「第二輪」挖到的商品加進來（從 stdin 讀 slug，一行一個）。

    ⚠️ **第二輪的來源與第一輪完全不同**，這是它需要獨立一條路的原因：
    第一輪是 `kind_of == 'ticket'`（網址裡明講門票）；第二輪是**人工掃過
    `other`（1062 件）與「被判行程但含 ticket 字」（76 件）挑出來的**。
    那 1138 件裡有大量餐廳訂位與美容沙龍，**字面規則篩不乾淨**
    ——`greenland-kumamoto` 是遊樂園、`kashiwaya-osaka` 是餐廳，網址上分不出來，
    所以只能一個一個看。

    ⚠️ **一律標 `round: 2`**：`serve` 預設只出第一輪，
    使用者手上那批卡片不會因為第二輪進來而變動位置。
    """
    km = _km()
    cache = km.load_cache()
    if not cache:
        print('沒有 sitemap 快取', file=sys.stderr)
        return 2
    by = {x['slug']: x for x in cache['items']}
    d = load_scout()
    have = {x['slug'] for x in d['items']}
    want = [ln.strip() for ln in sys.stdin if ln.strip() and not ln.startswith('#')]
    add, miss, dup = [], [], []
    for sl in want:
        if sl in have:
            dup.append(sl); continue
        it = by.get(sl)
        if not it:
            miss.append(sl); continue
        add.append({'aid': it['aid'], 'slug': it['slug'], 'url': it['url'],
                    'name_en': name_en_of(it['slug'], km.JP_TOKENS),
                    'city': city_of(it['slug'], km.JP_TOKENS),
                    'bucket': 'place', 'guess': None, 'pick': None, 'round': 2})
    d['items'].extend(add)
    save_scout(d)
    print('[scout] 第二輪加入 %d 件（已存在 %d／找不到 %d）' % (len(add), len(dup), len(miss)))
    for m in miss:
        print('   ⚠️ 找不到：%s' % m, file=sys.stderr)
    return 0


def guess():
    """把查到的資料寫進 `guess`（從 stdin 讀一個 JSON 陣列）。

    ⚠️ **這一步刻意不是程式去抓的**：Klook 商品頁擋 DataDome（實測 403），
    而繞過它是規避存取控制。資料來自公開的官網／觀光局／維基，由 AI 逐筆查、
    **把來源網址一起存下來**——網頁上要看得到根據，否則「猜錯但看起來正常」
    就沒有任何人擋得住（本專案最貴的教訓全是這一族）。

    ⚠️ **寫進 guess 不等於決定收錄**：`pick` 才是使用者按的，兩者分開存。
    """
    rows = json.load(sys.stdin)
    d = load_scout()
    if not d:
        print('請先跑：python3 klook_scout.py prepare', file=sys.stderr)
        return 2
    by = {x['slug']: x for x in d['items']}
    n, miss = 0, []
    for r in rows:
        x = by.get(r['slug'])
        if not x:
            miss.append(r['slug'])
            continue
        x['guess'] = {k: r.get(k, '') for k in
                      ('id', 'title', 'title_ja', 'address', 'genre', 'site', 'note', 'src')}
        if r.get('world_heritage'):
            x['guess']['world_heritage'] = True
        if r.get('drop'):
            x['guess']['drop'] = r['drop']      # 查了才發現不是景點（交通票、餐廳…）
        n += 1
    save_scout(d)
    done = sum(1 for x in d['items'] if x['guess'])
    todo_n = sum(1 for x in d['items'] if x['bucket'] == 'place' and not x['guess'])
    print('[scout] 寫入 %d 筆／累計查好 %d／像景點的還剩 %d 筆沒查' % (n, done, todo_n))
    if miss:
        print('[scout] ⚠️ 找不到這些 slug：%s' % '、'.join(miss[:5]), file=sys.stderr)
    return 0


# ─────────────────────────────────────────────────────── serve（勾選網頁）

GENRES = ('神社寺廟', '博物館', '美術館', '公園庭園', '自然景勝', '水族館動物園', '地標展望')
# 票種沿用 build_places.py 的 TICKET_TYPES，顯示名沿用 js/config.js 的 ticketTypes。
# ⚠️ **不要在這裡自己編第三套名字**：三處講的是同一件事。
TYPES = (('admission', '一般入場券'), ('premium', '快速通關・特別版'), ('combo', '組合票'))

EXTRA_CSS = """
.addr{font-size:13px;color:#444;margin:2px 0}
.links{font-size:12px;margin:4px 0 8px}
.links a{color:#36c;margin-right:10px}
.edit{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;padding-top:8px;
      border-top:1px dashed #e5e5e5}
/* ⚠️ 這條不可省（全站第十一處，CLAUDE.md 地雷 #26）：上面那個 display:flex 會蓋掉
   瀏覽器預設的 [hidden]{display:none}，於是「還沒按要／不要」的卡片也會把五個
   編輯欄位整排攤開——212 張卡就是 212 排，頁面長到不能看，而且看起來像每一筆
   都已經在等你填。**2026-09-03 同一天內第二次踩到這個。** */
.edit[hidden]{display:none}
.edit label{font-size:12px;color:#666;display:flex;flex-direction:column;gap:2px}
.edit input,.edit select{font:13px inherit;padding:4px 6px;border:1px solid #ddd;border-radius:4px}
.edit input.w1{width:150px} .edit input.w2{width:210px} .edit input.w3{width:290px}
#noiseH{padding:14px 16px;background:#f3f3f3;border-top:2px solid #ddd;cursor:pointer;
        font-weight:600}
.warn{color:#b60;font-size:12px;font-weight:600;margin-left:8px}
.red{background:#fff6f6;border-left:3px solid #d99}
"""


def hold_names():
    """後台被 hold 住的那 200 筆（`_hold-*.json`）的日文名，用來標「後台已有」。

    ⚠️ **使用者 2026-09-03 決定那批先不上線**（裡面有他想刪的），所以這裡**只提醒、
    不擋**——同一個景點若已經在後台，這一輪就不必再新增一筆，否則放行那天會撞成兩筆。
    """
    out = {}
    for fn in sorted(glob.glob(os.path.join(SRC_DIR, '_hold-*.json'))):
        try:
            with io.open(fn, encoding='utf-8') as f:
                d = json.load(f)
        except Exception:
            continue
        for r in (d['places'] if isinstance(d, dict) else d):
            for k in ('title_ja', 'title'):
                if r.get(k):
                    out[r[k]] = os.path.basename(fn)
    return out


def build_page(rnd=1):
    d = load_scout()
    held = hold_names()
    # ⚠️ **一次只出一輪**：使用者是照順序一張一張往下按的，
    #    第二輪插進來會讓他手上那批卡片整個位移。
    items = [x for x in d['items'] if x.get('round', 1) == rnd]
    place = [x for x in items if x['bucket'] == 'place']
    noise = [x for x in items if x['bucket'] != 'place']
    o = ['<!doctype html><meta charset="utf-8"><title>Klook 新景點確認</title>',
         '<style>%s%s</style>' % (_km().PAGE_CSS, EXTRA_CSS),
         '<div id="bar"><b>Klook 新景點確認%s</b><span id="n"></span>'
         % ('（第二輪）' if rnd == 2 else ''),
         '<label><input type="checkbox" onchange="onlyTodo(this)"> 只看還沒決定的</label>',
         '<span class="hint">⚠️ <b>收錄標準是「值得去」，不是「Klook 有票」</b>——'
         '每一筆都問得出「就算它沒有票，我也會收嗎？」。每按一下就存。</span></div>']

    def card(x):
        g = x.get('guess') or {}
        pk = x.get('pick') or {}
        want = pk.get('want')
        cls = 'done' if want else ('skip' if want is False else '')
        if g.get('drop'):
            cls += ' red'
        o.append('<section id="s-%s" class="%s" data-todo="%d">'
                 % (html.escape(x['slug']), cls, 0 if want is not None else 1))
        title = pk.get('title') or g.get('title') or x['name_en']
        ja = pk.get('title_ja') or g.get('title_ja') or ''
        o.append('<h2>%s<small>%s</small>' % (html.escape(title), html.escape(ja)))
        if g.get('world_heritage'):
            o.append('<span class="badge">世界遺產</span>')
        if ja and ja in held:
            o.append('<span class="warn">⚠️ 後台已經有這一筆（%s）</span>' % html.escape(held[ja]))
        if g.get('drop'):
            o.append('<span class="warn">⚠️ 查了之後看起來不是景點：%s</span>' % html.escape(g['drop']))
        o.append('</h2>')
        o.append('<div class="addr">%s</div>' % html.escape(pk.get('address') or g.get('address') or '（還沒查到地址）'))
        if g.get('note') or g.get('src'):
            o.append('<div class="note">%s%s</div>'
                     % (html.escape(g.get('note') or ''),
                        ('　來源：' + html.escape(g['src'])) if g.get('src') else ''))
        o.append('<div class="links"><a href="%s" target="_blank">Klook 商品頁</a>' % html.escape(x['url']))
        if g.get('site'):
            o.append('<a href="%s" target="_blank">官網</a>' % html.escape(g['site']))
        o.append('<span class="slug">%s</span></div>' % html.escape(x['slug']))
        # 按鈕列
        o.append('<div class="btns">')
        o.append('<button class="t no%s" onclick="pick(this,\'%s\',null)">不要</button>'
                 % (' on' if want is False else '', html.escape(x['slug'])))
        for k, lab in TYPES:
            on = ' on' if (want and pk.get('ticket_type') == k) else ''
            o.append('<button class="t%s" onclick="pick(this,\'%s\',\'%s\')">要・%s</button>'
                     % (on, html.escape(x['slug']), k, html.escape(lab)))
        o.append('</div>')
        # 選了「要」才要填的欄位（預先帶入查到的值，改了就存）
        o.append('<div class="edit"%s>' % ('' if want else ' hidden'))
        for key, lab, w in (('id', 'id（發布後不可改）', 'w2'), ('title', '繁中名', 'w2'),
                            ('title_ja', '日文名', 'w2'), ('address', '地址', 'w3')):
            v = pk.get(key) or g.get(key) or ''
            o.append('<label>%s<input class="%s" value="%s" onchange="fld(this,\'%s\',\'%s\')"></label>'
                     % (lab, w, html.escape(v), html.escape(x['slug']), key))
        cur = pk.get('genre') or g.get('genre') or ''
        o.append('<label>小類<select onchange="fld(this,\'%s\',\'genre\')">' % html.escape(x['slug']))
        o.append('<option value="">（選一個）</option>')
        for gn in GENRES:
            o.append('<option%s>%s</option>' % (' selected' if gn == cur else '', gn))
        o.append('</select></label>')
        wh = pk.get('world_heritage', g.get('world_heritage'))
        o.append('<label>世界遺產<input type="checkbox"%s onchange="fld(this,\'%s\',\'world_heritage\')"></label>'
                 % (' checked' if wh else '', html.escape(x['slug'])))
        o.append('</div></section>')

    for x in place:
        card(x)
    o.append('<div id="noiseH" onclick="document.getElementById(\'noise\').hidden=!document.getElementById(\'noise\').hidden">'
             '▸ 樂園・餐券・通票・秀場等 %d 件（點開看，分堆可能有錯）</div>' % len(noise))
    o.append('<div id="noise" hidden>')
    for x in noise:
        card(x)
    o.append('</div>')
    o.append("""<script>
function post(b){return fetch('/',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(b)}).then(function(){return refresh()});}
function pick(btn,slug,type){
  var sec=btn.closest('section');
  sec.querySelectorAll('.btns button').forEach(function(b){b.classList.remove('on')});
  btn.classList.add('on');
  var want=type!==null;
  sec.className=want?'done':'skip';
  sec.dataset.todo='0';
  sec.querySelector('.edit').hidden=!want;
  post({slug:slug,want:want,ticket_type:type});
}
function fld(el,slug,key){
  var v=el.type==='checkbox'?el.checked:el.value.trim();
  post({slug:slug,field:key,value:v});
}
function onlyTodo(cb){
  document.querySelectorAll('section').forEach(function(s){
    s.style.display=(cb.checked&&s.dataset.todo==='0')?'none':'';});
}
function refresh(){return fetch('/count').then(function(r){return r.json()}).then(function(d){
  document.getElementById('n').textContent=' 已決定 '+d.done+' / '+d.total+'（要收 '+d.want+'）';});}
refresh();
</script>""")
    return '\n'.join(o).encode('utf-8')


def serve():
    import http.server
    d = load_scout()
    if not d:
        print('請先跑：python3 klook_scout.py prepare', file=sys.stderr)
        return 2

    rnd = 2 if (len(sys.argv) > 2 and sys.argv[2] == '2') else 1
    # ⚠️ **兩輪用不同的埠**，這樣兩個分頁可以同時開著（同一個埠的話第二個起不來，
    #    而錯誤訊息是「Address already in use」——看起來像程式壞了）。
    port = PORT + (1 if rnd == 2 else 0)

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, body, ctype='text/html; charset=utf-8'):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith('/count'):
                cur = [x for x in load_scout()['items'] if x.get('round', 1) == rnd]
                done = sum(1 for x in cur if (x.get('pick') or {}).get('want') is not None)
                want = sum(1 for x in cur if (x.get('pick') or {}).get('want'))
                self._send(json.dumps({'done': done, 'total': len(cur), 'want': want}).encode(),
                           'application/json')
            else:
                self._send(build_page(rnd))

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n) or b'{}')
            cur = load_scout()
            for x in cur['items']:
                if x['slug'] != body['slug']:
                    continue
                pk = x.get('pick') or {}
                if 'field' in body:
                    pk[body['field']] = body['value']
                else:
                    pk['want'] = bool(body['want'])
                    pk['ticket_type'] = body.get('ticket_type') or ''
                    # 按「要」的當下，把查到的值複製一份進 pick——**apply 只讀 pick**，
                    # 這樣日後重查 guess 不會默默改掉使用者已經確認過的內容。
                    g = x.get('guess') or {}
                    for k in ('id', 'title', 'title_ja', 'address', 'genre', 'site', 'world_heritage'):
                        pk.setdefault(k, g.get(k, ''))
                x['pick'] = pk
                break
            save_scout(cur)
            self._send(b'{}', 'application/json')

        def log_message(self, *a):
            pass

    d = {'items': [x for x in d['items'] if x.get('round', 1) == rnd]}
    n_place = sum(1 for x in d['items'] if x['bucket'] == 'place')
    print('新景點確認網頁%s：http://127.0.0.1:%d/   （決定完按 Ctrl+C 結束）'
          % ('（第二輪）' if rnd == 2 else '', port))
    print('像景點的 %d 件在上面，其餘 %d 件折疊在最下面。選擇即時存進 %s'
          % (n_place, len(d['items']) - n_place, os.path.relpath(SCOUT, HERE)))
    print('決定完再跑：python3 klook_scout.py apply')
    http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
    return 0


# ─────────────────────────────────────────────────────── apply（寫回 places_src）

# 都道府縣 → 檔名用的羅馬字。⚠️ **這張表只決定檔名，沒有任何功能意義**
# （`build_places.py` 讀 `places_src/` 底下所有非 `_` 開頭的 .json），
# 所以拼錯只是檔名難看，不會讓景點消失。**縣名本身是從地址開頭取的**
# ——地址格式固定（開頭必為 `○○都/道/府/県`），這不是「猜市町村」那種事（地雷 #3b）。
PREF_ROMAJI = {
    '北海道': 'hokkaido', '青森県': 'aomori', '岩手県': 'iwate', '宮城県': 'miyagi',
    '秋田県': 'akita', '山形県': 'yamagata', '福島県': 'fukushima', '茨城県': 'ibaraki',
    '栃木県': 'tochigi', '群馬県': 'gunma', '埼玉県': 'saitama', '千葉県': 'chiba',
    '東京都': 'tokyo', '神奈川県': 'kanagawa', '新潟県': 'niigata', '富山県': 'toyama',
    '石川県': 'ishikawa', '福井県': 'fukui', '山梨県': 'yamanashi', '長野県': 'nagano',
    '岐阜県': 'gifu', '静岡県': 'shizuoka', '愛知県': 'aichi', '三重県': 'mie',
    '滋賀県': 'shiga', '京都府': 'kyoto', '大阪府': 'osaka', '兵庫県': 'hyogo',
    '奈良県': 'nara', '和歌山県': 'wakayama', '鳥取県': 'tottori', '島根県': 'shimane',
    '岡山県': 'okayama', '広島県': 'hiroshima', '山口県': 'yamaguchi', '徳島県': 'tokushima',
    '香川県': 'kagawa', '愛媛県': 'ehime', '高知県': 'kochi', '福岡県': 'fukuoka',
    '佐賀県': 'saga', '長崎県': 'nagasaki', '熊本県': 'kumamoto', '大分県': 'oita',
    '宮崎県': 'miyazaki', '鹿児島県': 'kagoshima', '沖縄県': 'okinawa',
}
PREF_RE = re.compile(r'^(.+?[都道府県])')
RELEASED = 'released-from-hold-2026-09.json'   # ①「從 hold 提前放行」那一批的落腳處


def _norm_name(s):
    """比對用的名稱正規化。⚠️ **只用來比對，絕不拿去顯示或算 id**
    （同 build_restaurants 的店名正規化那條）。"""
    return re.sub(r'[\s\u3000・（）()「」]', '', s or '')


def _rows(d):
    return d if isinstance(d, list) else d.get('places', [])


def _load_src():
    """places_src 底下每一個資料檔（含 `_hold-`）。回 [(檔名, 原始物件, 紀錄清單)]。"""
    out = []
    for name in sorted(os.listdir(SRC_DIR)):
        if not name.endswith('.json'):
            continue
        if name.startswith('_') and not name.startswith('_hold-'):
            continue          # _geocache／_klook_*／_photo* 都不是資料檔
        with io.open(os.path.join(SRC_DIR, name), encoding='utf-8') as f:
            d = json.load(f)
        out.append((name, d, _rows(d)))
    return out


def _save_src(name, d):
    with io.open(os.path.join(SRC_DIR, name), 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def _ticket_of(pk, today, primary=True):
    """⚠️ **同一個平台只能有一件 `primary`**（`clean_tickets()` 會擋，那是刻意的）：
    兩件都標的話順序會變成看資料順序而定，是「看起來正常但每次可能不一樣」的結果。
    所以合併多件商品時，**只有排第一的那件是 primary**。
    ⚠️ 2026-09-04 第一版沒帶這個參數，關門海峽博物館那兩件因此整筆被擋下——
    **報表有講，但 places.json 上只是少一顆買票鈕，畫面上看不出來。**"""
    return {'platform': 'klook', 'type': pk.get('ticket_type') or 'admission',
            'primary': primary, 'url': pk['_url'], 'status': 'active', 'checked': today}


def apply_picks():
    """③ 把勾選結果寫回 `places_src/`。

    **四種去向，順序不可對調**（先認出重複的，剩下的才是新增）：

    1. **欄位不全** → 不寫，列進報表。
    2. **與站上已上線是同一個景點** → **不新增**，只把票券掛到既有那筆上。
       ⚠️ 不這樣做的話地圖上會出現兩顆完全重疊的圖釘，而畫面上看起來很正常。
    3. **與後台 `_hold-*` 是同一個景點** → 從 hold 檔**搬**到 `released-from-hold-*.json`
       （連同它原本的資料：`hours_url`、`_note`、既有的 `tickets` 都比這次查的完整）。
       ⚠️⚠️ **一定要「搬」不是「複製」**：留一份在 hold 裡的話，日後整批放行時
       `build_places.py` 會偵測到 id 撞名**整支中止**（那是它刻意的行為）。
    4. **其餘** → 按**都道府縣**分檔新增（該縣已有檔就併進去，沒有就新建）。

    ⚠️ **同一個景點的多件商品會合併成一筆、多張票券**（`kanmon-strait` 與
    `kanmon-straits` 是同一間博物館的兩件商品）——不合併的話會變成兩筆同 id 的紀錄。
    """
    dry = '--dry-run' in sys.argv
    today = time.strftime('%Y-%m-%d')
    d = load_scout()
    if not d:
        print('請先跑：python3 klook_scout.py prepare', file=sys.stderr)
        return 2
    want = [x for x in d['items'] if (x.get('pick') or {}).get('want')]
    if not want:
        print('還沒有任何「要收」的勾選，請先跑 serve', file=sys.stderr)
        return 2

    # ── 索引：站上已上線／places_src 各檔（含 hold）
    with io.open(PLACES, encoding='utf-8') as f:
        live = json.load(f)['places']
    live_name = {}
    for p in live:
        for k in ('title_ja', 'title'):
            if p.get(k):
                live_name.setdefault(_norm_name(p[k]), p['id'])
    src = _load_src()
    src_name, src_id = {}, {}
    for name, _, rows in src:
        for r in rows:
            src_id.setdefault(r.get('id'), name)
            for k in ('title_ja', 'title'):
                if r.get(k):
                    src_name.setdefault(_norm_name(r[k]), (r['id'], name))

    # ── 先把「同一個景點的多件商品」併起來
    merged, order = {}, []
    for x in want:
        pk = dict(x['pick'])
        pk['_url'] = x['url']
        key = _norm_name(pk.get('title_ja')) or ('slug:' + x['slug'])
        if key in merged:
            merged[key]['_extra'].append(pk)
        else:
            pk['_extra'] = []
            merged[key] = pk
            order.append(key)

    bad, to_live, from_hold, to_new = [], [], [], []
    for key in order:
        pk = merged[key]
        miss = [lab for k, lab in (('id', 'id'), ('title', '繁中名'), ('title_ja', '日文名'),
                                   ('address', '地址'), ('genre', '小類'))
                if not (pk.get(k) or '').strip()]
        if miss:
            bad.append((pk.get('title') or pk.get('id') or key, '／'.join(miss) + ' 空著'))
            continue
        if key in live_name:
            to_live.append((live_name[key], pk))
        elif key in src_name and src_name[key][1].startswith('_hold-'):
            from_hold.append((src_name[key], pk))
        elif key in src_name:
            to_live.append((src_name[key][0], pk))      # 已在某個非 hold 檔裡＝已經會上線
        else:
            to_new.append(pk)

    # ── 分檔（都道府縣）
    pref_file = {}
    for name, _, rows in src:
        if name.startswith('_hold-'):
            continue
        for r in rows:
            m = PREF_RE.match(r.get('address') or '')
            if m:
                pref_file.setdefault(m.group(1), name)
    plan_new = collections.OrderedDict()
    for pk in to_new:
        m = PREF_RE.match(pk['address'])
        pref = m.group(1) if m else ''
        fn = pref_file.get(pref) or ('%s.json' % PREF_ROMAJI.get(pref, 'unknown'))
        plan_new.setdefault(fn, []).append(pk)

    # ── 報表
    print('【勾選 %d 筆 → 合併同一景點的多件商品後 %d 筆】' % (len(want), len(merged)))
    print('  ①欄位不全（不寫）%d／②掛到既有那筆 %d／③從 hold 搬出 %d／④新增 %d'
          % (len(bad), len(to_live), len(from_hold), len(to_new)))
    for t, why in bad:
        print('     ⚠️ 不寫：%s（%s）' % (t, why))
    for pid, pk in to_live:
        print('     票券掛到既有的 %s（%s）' % (pid, pk['title']))
    for (pid, fn), pk in from_hold:
        print('     從 %s 搬出 %s（%s）' % (fn, pid, pk['title']))
    print('\n【新增的分檔】')
    for fn, lst in plan_new.items():
        print('   %-28s +%d' % (fn, len(lst)))
    if dry:
        print('\n（--dry-run，什麼都沒寫）')
        return 0

    # ── 寫入 ②：票券掛到既有那筆
    changed = {}
    for pid, pk in to_live:
        fn = src_id.get(pid)
        if not fn:
            print('   ⚠️ 找不到 %s 在哪個 places_src 檔，跳過' % pid, file=sys.stderr)
            continue
        d2 = changed.get(fn) or next(x[1] for x in src if x[0] == fn)
        changed[fn] = d2
        for r in _rows(d2):
            if r.get('id') != pid:
                continue
            tk = r.setdefault('tickets', [])
            urls = {t.get('url') for t in tk}
            for one in [pk] + pk['_extra']:
                if one['_url'] not in urls:
                    tk.append(_ticket_of(one, today, not tk))
    # ── 寫入 ③：從 hold 搬出
    rel_rows = []
    for (pid, fn), pk in from_hold:
        d2 = changed.get(fn) or next(x[1] for x in src if x[0] == fn)
        changed[fn] = d2
        rows = _rows(d2)
        hit = [r for r in rows if r.get('id') == pid]
        if not hit:
            continue
        rec = hit[0]
        rows.remove(rec)                       # ⚠️ 搬，不是複製
        tk = rec.setdefault('tickets', [])
        urls = {t.get('url') for t in tk}
        for one in [pk] + pk['_extra']:
            if one['_url'] not in urls:
                tk.append(_ticket_of(one, today, not tk))
        if not tk:
            rec.pop('tickets', None)
        rec['_note'] = ((rec.get('_note') or '') +
                        ' ／2026-09-04 由 Klook 候選比對確認，從 hold 提前放行。').strip()
        rel_rows.append(rec)
    # ── 寫入 ④：新增
    for fn, lst in plan_new.items():
        path = os.path.join(SRC_DIR, fn)
        if os.path.exists(path):
            d2 = changed.get(fn) or next((x[1] for x in src if x[0] == fn), None)
            if d2 is None:
                with io.open(path, encoding='utf-8') as f:
                    d2 = json.load(f)
        else:
            d2 = {'places': []}
        changed[fn] = d2
        rows = _rows(d2)
        for pk in lst:
            rec = {'id': pk['id'], 'title': pk['title'], 'title_ja': pk['title_ja'],
                   'genre': pk['genre'], 'address': pk['address'],
                   'url': pk.get('site') or '', 'hours_url': '', 'venue': '', 'venue_ja': '',
                   'img': '',
                   '_note': '2026-09-04 由 Klook 商品反查公開資料（官網／各地觀光局）建檔。',
                   'tickets': [_ticket_of(one, today, i == 0)
                               for i, one in enumerate([pk] + pk['_extra'])]}
            if pk.get('world_heritage'):
                rec['world_heritage'] = True
            rows.append(rec)
    for fn, d2 in changed.items():
        _save_src(fn, d2)
    if rel_rows:
        path = os.path.join(SRC_DIR, RELEASED)
        d2 = {'places': []}
        if os.path.exists(path):
            with io.open(path, encoding='utf-8') as f:
                d2 = json.load(f)
        _rows(d2).extend(rel_rows)
        _save_src(RELEASED, d2)
    print('\n[scout] 已寫入 %d 個檔案（含 %s）' % (len(changed) + (1 if rel_rows else 0), RELEASED))
    print('[scout] 接著跑：python3 build_places.py     （會查新地址的座標，約 2～3 分鐘）')
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'prepare':
        return prepare()
    if cmd == 'todo':
        return todo()
    if cmd == 'guess':
        return guess()
    if cmd == 'add2':
        return add2()
    if cmd == 'apply':
        return apply_picks()
    if cmd == 'serve':
        return serve()
    print(__doc__)
    return 1


if __name__ == '__main__':
    sys.exit(main())
