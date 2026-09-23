#!/usr/bin/env python3
"""後台 hold 那批景點的「逐筆決定去留」工具（單位 P-2，2026-09-04，本機用，不上線）。

    python3 places_review.py prep     # ① 查座標（GSI）＋ 撈 Commons 照片候選
    python3 places_review.py serve    # ② 網頁上一筆一張卡：要／待定／不要，可就地改欄位
    python3 places_review.py apply    # ③ 寫回 places_src/

⚠️⚠️ **這支的性質是「候選收斂」不是「自動決定」**，同 `klook_scout.py` 與
   `pick_photos.py`。判準是使用者的「值不值得去」，程式給不出答案——
   所以 prep **絕不把任何東西寫進資料檔**，決定全部落在 `_review.json`，
   人按過的才會被 apply 搬動。（使用者 2026-09-02 退回過「直接填進資料層」那種做法：
   填進去之後「這一筆有沒有人看過」就再也看不出來了。）

⚠️ **為什麼要先查座標**：hold 檔不進管線（`build_places.py` 跳過 `_` 開頭的檔），
   所以那 190 筆**沒有座標**；而照片候選是靠「Commons 上 300m 內的照片」找的，
   `pick_photos.py` 讀的是 `places.json` 的 `lat`／`lng`。**沒有座標就沒有照片候選。**

⚠️ **兩個快取都是共用的，這是刻意的**：
   - 座標寫 `places_src/_geocache.json`（以完整地址為鍵）→ 留下的那幾筆之後跑
     `build_places.py` 是 **0 次 GSI 查詢**、立刻上線。
   - 照片寫 `places_src/_photocache.json`（以景點 id 為鍵）→ 上線之後跑
     `pick_photos.py serve` 直接就看得到候選，不必重撈。
   兩支都不知道本程式存在，本程式也不改它們的邏輯（同 `build_places` 對
   `build_restaurants` 的關係）。
"""

import html
import io
import json
import os
import re
import sys
import time

import build_places as bp
import build_restaurants as br
import pick_photos as pp

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'places_src')
STATE = os.path.join(SRC, '_review.json')
PHOTO_CACHE = os.path.join(SRC, '_photocache.json')
PORT = 8902           # 8766/8767/8768（klook_scout）、8811（klook_match）、8901（pick_photos）之外

# 「要」的那些搬去哪個檔（依都道府縣，沿用既有檔名，沒有就新建）。
# ⚠️ 這四個檔已經存在（R-2 建的），所以是併進去不是覆蓋。
PREF_FILE = {
    '愛知県': 'aichi.json',
    '広島県': 'hiroshima.json',
    '兵庫県': 'hyogo.json',
    '奈良県': 'nara.json',
}
DEL_FILE = '_deleted-%s-2026-09.json'   # ⚠️ `_` 開頭＝管線跳過，等於留著但永遠不上線

DECISIONS = ('keep', 'hold', 'drop')


# ═══ 讀寫 ═══════════════════════════════════════════════════════════

def _rows(d):
    return d if isinstance(d, list) else d.get('places', [])


def hold_files():
    return sorted(n for n in os.listdir(SRC)
                  if n.startswith('_hold-') and n.endswith('.json'))


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with io.open(path, encoding='utf-8') as f:
        return json.load(f)


def save_json(path, data):
    with io.open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def load_state():
    return load_json(STATE, {})


# ═══ ① prep ════════════════════════════════════════════════════════

def prep():
    """查座標 ＋ 撈照片候選，寫進 `_review.json`。

    ⚠️ **決定與就地編輯一律保留**（同 `klook_scout.prepare` 保留 prev['pick']）：
    重跑 prep 不可以把人按過的東西洗掉——那是這支工具唯一不可重來的資產。
    """
    no_photo = '--no-photo' in sys.argv
    prev = {it['id']: it for it in load_state().get('items', [])}
    cache = bp.Cache(bp.CACHE_PATH)
    pcache = load_json(PHOTO_CACHE, {})

    items, seen = [], set()
    for fn in hold_files():
        d = load_json(os.path.join(SRC, fn), {})
        for row in _rows(d):
            rid = row.get('id', '')
            if rid in seen:
                print('[warn] id 重複，跳過：%s' % rid, file=sys.stderr)
                continue
            seen.add(rid)
            old = prev.get(rid, {})
            addr = br.norm_text(row.get('address', ''))
            pref, city = br.parse_address(addr)
            genre, gerr = bp.resolve_genre(row.get('genre'))
            bad = []
            if not bp.ID_RE.match(rid):
                bad.append('id 不合規則')
            for k in ('title', 'title_ja', 'address', 'url'):
                if not br.norm_text(row.get(k, '')):
                    bad.append('缺少必填欄位 %s' % k)
            if gerr:
                bad.append(gerr)
            area = br.area_of(pref, city)
            if not area:
                bad.append('判不出地區桶（%s %s）' % (pref, city))

            it = {
                'id': rid, 'src': fn, 'pref': pref, 'city': city, 'area': area,
                'title': row.get('title', ''), 'title_ja': row.get('title_ja', ''),
                'genre': genre or row.get('genre', ''),
                'address': addr, 'url': row.get('url', ''),
                'hours_url': row.get('hours_url', ''),
                'world_heritage': bool(row.get('world_heritage')),
                'no_hours': bool(row.get('no_hours')),
                'note': row.get('_note', ''),
                'bad': bad,
                # ↓ 人按過的東西，重跑 prep 一律沿用
                'decision': old.get('decision'),
                'edit': old.get('edit') or {},
            }
            # 座標：地址沒變就沿用上一次查到的（GSI 限速 1 req/s，不要白查）
            if old.get('lat') is not None and old.get('address') == addr:
                it.update(lat=old['lat'], lng=old['lng'], geo=old.get('geo'),
                          geo_note=old.get('geo_note', ''))
            else:
                lat, lng, geo, note = bp.geocode(addr, cache)
                it.update(lat=lat, lng=lng, geo=geo, geo_note=note)
                print('%-28s %s %s' % (it['title'][:26], geo or '查不到', note),
                      flush=True)
            items.append(it)

    cache.save()
    print('[geo] 快取命中 %d／查詢 %d／失敗 %d' % (cache.hits, cache.misses, cache.fails))

    # 照片候選：與 pick_photos 共用 `_photocache.json`（鍵是景點 id）
    if not no_photo:
        todo = [it for it in items
                if it.get('lat') is not None and it['id'] not in pcache]
        print('[photo] 要撈 %d 筆（已有快取 %d）' % (len(todo), len(items) - len(todo)))
        for i, it in enumerate(todo, 1):
            try:
                d = pp.api({'action': 'query', 'generator': 'geosearch',
                            'ggscoord': '%s|%s' % (it['lat'], it['lng']),
                            'ggsradius': pp.RADIUS_M, 'ggslimit': 50, 'ggsnamespace': 6,
                            'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata',
                            'iiurlwidth': 400,
                            'iiextmetadatafilter': 'LicenseShortName|Artist'})
            except Exception as e:
                # ⚠️ 查詢失敗不寫快取——寫了等於永久判定「這個景點沒照片」，
                #    而這次正好要拿「有沒有照片」當判準之一。下次重跑就是重試。
                print('  [warn] %s 查詢失敗：%s' % (it['title'], e), file=sys.stderr)
                continue
            cands = [c for c in (pp.cand_of(pg)
                                 for pg in d.get('query', {}).get('pages', [])) if c]
            cands.sort(key=lambda c: -c['w'])
            pcache[it['id']] = cands[:pp.TOP_N]
            print('%3d/%d %-24s %d 張' % (i, len(todo), it['title'][:22],
                                          len(cands[:pp.TOP_N])), flush=True)
            time.sleep(0.35)
        save_json(PHOTO_CACHE, pcache)

    # ⚠️ **照片候選刻意不存進 `_review.json`**：那是 `_photocache.json` 已經有的東西，
    # 存第二份就是「同一份資料存在兩處」（本專案所有最貴的教訓都是這一族），
    # 而且會讓這個每按一下就重寫的狀態檔從 260KB 漲成 760KB。serve 時現讀即可。
    save_json(STATE, {'built': time.strftime('%Y-%m-%d %H:%M'), 'items': items})
    n_ok = sum(1 for it in items if not it['bad'] and it.get('lat') is not None)
    n_px = sum(1 for it in items if pcache.get(it['id']))
    print('\n寫好 %s' % STATE)
    print('共 %d 筆：可上線 %d／有照片候選 %d／approx %d／查不到座標 %d'
          % (len(items), n_ok, n_px,
             sum(1 for it in items if it.get('geo') == 'approx'),
             sum(1 for it in items if it.get('lat') is None)))
    print('接著跑：python3 places_review.py serve')
    return 0


# ═══ ② serve ═══════════════════════════════════════════════════════

CSS = """
*{box-sizing:border-box}
body{font:14px/1.6 -apple-system,"Hiragino Sans","Noto Sans TC",sans-serif;
     margin:0;background:#faf9f7;color:#222}
#bar{position:sticky;top:0;z-index:9;background:#fff;border-bottom:1px solid #ddd;
     padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
#bar b{font-size:16px}
#bar .n{font-variant-numeric:tabular-nums}
#bar select,#bar label{font-size:13px;color:#555}
.card{padding:14px 16px;border-bottom:1px solid #eee;background:#fff;margin:0 0 1px}
.card.keep{background:#f1f8f2;border-left:4px solid #2a7}
.card.drop{background:#fbf1f1;border-left:4px solid #c55;opacity:.62}
.card.hold{background:#fdf8ec;border-left:4px solid #d9a520}
h2{margin:0;font-size:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
h2 .ja{font-weight:400;color:#666;font-size:14px}
.tag{font-size:11px;padding:1px 6px;border-radius:9px;background:#eee;color:#555}
.tag.wh{background:#f6e6b8;color:#7a5a00}
.tag.bad{background:#f6d6d6;color:#a22}
.tag.approx{background:#e6e2f6;color:#524a86}
.meta{font-size:12px;color:#777;margin:4px 0 8px}
.meta a{color:#36c;margin-right:12px}
.fields{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.fields input,.fields select{font:13px -apple-system,"Hiragino Sans",sans-serif;
     padding:4px 6px;border:1px solid #ccc;border-radius:4px;background:#fff}
.fields input.t{width:190px} .fields input.a{width:330px}
.fields .ed{border-color:#2a7;background:#f2fbf5}
.note{font-size:12px;color:#8a8578;background:#f6f4ef;border-radius:4px;
      padding:6px 8px;margin-bottom:8px;max-height:3.2em;overflow:hidden;cursor:pointer}
.note.open{max-height:none}
.ph{display:flex;gap:6px;margin-bottom:9px;flex-wrap:wrap;align-items:flex-start}
.ph img{height:110px;max-width:210px;object-fit:cover;border-radius:3px;
        background:#eee;display:block}
/* ⚠️ 破圖時 alt 會撐開版面（Commons 的作者欄很長），整條藏掉 */
.ph a{display:block;font-size:0;overflow:hidden;max-width:210px;height:110px}
.ph .none{font-size:12px;color:#b06;background:#fdf0f4;padding:4px 8px;border-radius:4px}
.phhint{font-size:11px;color:#a09a8c;margin:-4px 0 8px}
.btns{display:flex;gap:8px}
.btns button{font:14px -apple-system,sans-serif;padding:5px 16px;border-radius:6px;
     border:1px solid #ccc;background:#fff;cursor:pointer}
.btns button:hover{border-color:#888}
.btns button.on[data-d=keep]{background:#2a7;border-color:#2a7;color:#fff}
.btns button.on[data-d=hold]{background:#d9a520;border-color:#d9a520;color:#fff}
.btns button.on[data-d=drop]{background:#c55;border-color:#c55;color:#fff}
"""

JS = """
function post(u,b){return fetch(u,{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});}
function decide(id,d){
  var c=document.getElementById('c-'+id);
  var was=c.dataset.d===d; var nd=was?'':d;
  c.dataset.d=nd; c.className='card '+nd;
  c.querySelectorAll('.btns button').forEach(function(b){
    b.classList.toggle('on', !!nd && b.dataset.d===nd);});
  post('/set',{id:id,decision:nd||null}).then(count);
}
function edit(el,id,k){
  var v=el.value.trim();
  el.classList.toggle('ed', v!==el.dataset.orig);
  post('/edit',{id:id,k:k,v:v}).then(count);
}
function count(){
  fetch('/count').then(function(r){return r.json();}).then(function(d){
    document.getElementById('n').textContent=
      '要 '+d.keep+'　待定 '+d.hold+'　不要 '+d.drop+'　未決定 '+d.todo+' / '+d.total;});
}
function filt(){
  var f=document.getElementById('fPref').value,
      g=document.getElementById('fGenre').value,
      t=document.getElementById('fTodo').checked,
      p=document.getElementById('fNoPhoto').checked;
  document.querySelectorAll('.card').forEach(function(c){
    var ok=(!f||c.dataset.pref===f)&&(!g||c.dataset.genre===g)
         &&(!t||!c.dataset.d)&&(!p||c.dataset.px==='0');
    c.style.display=ok?'':'none';});
}
count();
"""


def esc(s):
    return html.escape(s or '', quote=True)


def card_html(it):
    d = it.get('decision') or ''
    ed = it.get('edit') or {}
    def val(k):
        return ed.get(k, it.get(k, ''))

    tags = []
    if it['world_heritage']:
        tags.append('<span class="tag wh">世界遺產</span>')
    if it.get('geo') == 'approx':
        tags.append('<span class="tag approx">概略位置</span>')
    if it.get('lat') is None:
        tags.append('<span class="tag bad">查不到座標</span>')
    for b in it['bad']:
        tags.append('<span class="tag bad">%s</span>' % esc(b))
    if it['no_hours']:
        tags.append('<span class="tag">無常規營業時間</span>')

    px = it.get('photos') or []
    if px:
        ph = ''.join(
            '<a href="%s" target="_blank"><img src="%s" loading="lazy" title="%s／%s"></a>'
            % (esc(c.get('page')), esc(c.get('thumb')), esc(c.get('lic')), esc(c.get('by')[:60]))
            for c in px[:6])
    else:
        ph = '<span class="none">Commons 300m 內沒有可用照片</span>'
    # ⚠️ **這行提示不是客套話**：候選是「照片自己的座標落在 300m 內」找出來的，
    # **不是「拍的是這個地方」**（實測中部電力 MIRAI TOWER 撈到的六張全是附近
    # 餐廳的醬料照、Sky Promenade 撈到消防栓與機車）。不寫的話，一整排不相干的
    # 照片看起來就像「這個景點很醜」——那會把判斷帶往完全錯的方向。
    hint = ('Commons 300m 內的照片，未必拍的是這個地方（挑圖是之後單位 Q 的事）'
            if px else '')

    gopts = ''.join('<option value="%s"%s>%s</option>'
                    % (g, ' selected' if g == val('genre') else '', g)
                    for g in bp.GENRES)
    maps = 'https://www.google.com/maps/search/?api=1&query=' + esc(
        (it.get('title_ja') or '') + ' ' + (it.get('address') or ''))

    links = ['<a href="%s" target="_blank">官網</a>' % esc(it['url'])] if it['url'] else []
    if it['hours_url'] and it['hours_url'] != it['url']:
        links.append('<a href="%s" target="_blank">營業時間頁</a>' % esc(it['hours_url']))
    links.append('<a href="%s" target="_blank">Google 地圖</a>' % maps)

    btns = ''.join(
        '<button data-d="%s" class="%s" onclick="decide(\'%s\',\'%s\')">%s</button>'
        % (k, 'on' if d == k else '', it['id'], k, lab)
        for k, lab in (('keep', '要'), ('hold', '待定'), ('drop', '不要')))

    return """
<div class="card %s" id="c-%s" data-d="%s" data-pref="%s" data-genre="%s" data-px="%d">
  <h2>%s <span class="ja">%s</span> %s</h2>
  <div class="meta">%s ｜ %s ｜ %s</div>
  <div class="ph">%s</div>
  <div class="phhint">%s</div>
  <div class="fields">
    <select onchange="edit(this,'%s','genre')" data-orig="%s">%s</select>
    <input class="t" value="%s" data-orig="%s" onchange="edit(this,'%s','title')" title="繁中名">
    <input class="t" value="%s" data-orig="%s" onchange="edit(this,'%s','title_ja')" title="日文名">
    <input class="a" value="%s" data-orig="%s" onchange="edit(this,'%s','address')" title="地址">
  </div>
  <div class="note" onclick="this.classList.toggle('open')">%s</div>
  <div class="btns">%s</div>
</div>""" % (
        d, it['id'], d, esc(it['pref']), esc(val('genre')), len(px),
        esc(val('title')), esc(val('title_ja')), ''.join(tags),
        esc(it['area'] or '—'), esc(it['id']), ' '.join(links),
        ph, hint,
        it['id'], esc(it['genre']), gopts,
        esc(val('title')), esc(it['title']), it['id'],
        esc(val('title_ja')), esc(it['title_ja']), it['id'],
        esc(val('address')), esc(it['address']), it['id'],
        esc(it['note']) or '（沒有建檔備註）', btns)


def build_page(items):
    prefs = sorted({it['pref'] for it in items})
    genres = sorted({(it.get('edit') or {}).get('genre', it['genre']) for it in items})
    opt = lambda xs: ''.join('<option value="%s">%s</option>' % (esc(x), esc(x)) for x in xs)
    body = ''.join(card_html(it) for it in items)
    return ("""<!doctype html><meta charset="utf-8"><title>後台景點去留（%d 筆）</title>
<style>%s</style>
<div id="bar">
  <b>後台景點去留</b><span class="n" id="n">…</span>
  <select id="fPref" onchange="filt()"><option value="">全部縣</option>%s</select>
  <select id="fGenre" onchange="filt()"><option value="">全部小類</option>%s</select>
  <label><input type="checkbox" id="fTodo" onchange="filt()"> 只看未決定</label>
  <label><input type="checkbox" id="fNoPhoto" onchange="filt()"> 只看沒照片的</label>
</div>
%s
<script>%s</script>""" % (len(items), CSS, opt(prefs), opt(genres), body, JS)).encode('utf-8')


def serve():
    import http.server
    st = load_state()
    if not st.get('items'):
        print('請先跑：python3 places_review.py prep', file=sys.stderr)
        return 2
    items = st['items']
    by_id = {it['id']: it for it in items}
    # 照片候選現讀（不存在狀態檔裡，見 prep 那段的說明）
    pcache = load_json(PHOTO_CACHE, {})
    for it in items:
        it['photos'] = pcache.get(it['id'], [])

    def flush():
        # ⚠️ **`photos` 是 serve 現讀塞進去的，不可以跟著寫回狀態檔**
        # ——寫回去就等於又存了第二份（見 prep 那段）。
        st2 = dict(st, items=[{k: v for k, v in it.items() if k != 'photos'}
                              for it in items])
        save_json(STATE, st2)

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, body, ctype='text/html; charset=utf-8'):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj):
            self._send(json.dumps(obj).encode('utf-8'), 'application/json')

        def _body(self):
            n = int(self.headers.get('Content-Length') or 0)
            return json.loads(self.rfile.read(n) or b'{}')

        def do_GET(self):
            if self.path.startswith('/count'):
                c = {k: sum(1 for it in items if it.get('decision') == k)
                     for k in DECISIONS}
                c['todo'] = sum(1 for it in items if not it.get('decision'))
                c['total'] = len(items)
                return self._json(c)
            self._send(build_page(items))

        def do_POST(self):
            b = self._body()
            it = by_id.get(b.get('id'))
            if not it:
                return self._json({'ok': False})
            if self.path.startswith('/set'):
                d = b.get('decision')
                it['decision'] = d if d in DECISIONS else None
            elif self.path.startswith('/edit'):
                k, v = b.get('k'), (b.get('v') or '').strip()
                if k in ('genre', 'title', 'title_ja', 'address'):
                    ed = it.setdefault('edit', {})
                    # 改回原值就把覆寫拿掉，不要留一筆「改成一樣」的紀錄
                    if v and v != it.get(k):
                        ed[k] = v
                    else:
                        ed.pop(k, None)
            flush()          # ⚠️ 每按一下就落地（同 klook_scout）：關掉分頁不會弄丟
            return self._json({'ok': True})

        def log_message(self, *a):
            pass

    print('開 http://127.0.0.1:%d  （每按一下就存進 %s，關掉分頁不會弄丟）'
          % (PORT, os.path.basename(STATE)))
    print('決定完跑：python3 places_review.py apply')
    http.server.HTTPServer(('127.0.0.1', PORT), H).serve_forever()


# ═══ ③ apply ═══════════════════════════════════════════════════════

def apply_decisions():
    """把決定寫回 `places_src/`。三種去向：

    1. **要** → 從 `_hold-*` **搬**到該縣的正式檔（`aichi.json` 那幾個）。
    2. **不要** → **搬**到 `_deleted-<縣>-2026-09.json`（`_` 開頭＝管線跳過，
       資料留著但永遠不上線；反悔時搬回來就好，不必翻 git 歷史）。
    3. **待定／未決定** → 原封不動留在 `_hold-*`。

    ⚠️⚠️ **一定要「搬」不是「複製」**（同 `klook_scout.apply_picks` 第 3 種去向）：
    留一份在 hold 裡的話，`build_places.py` 偵測到 id 撞名會**整支中止**——
    那是它刻意的行為，而中止的那一刻活動與景點都不會更新。

    ⚠️ **就地編輯只在這裡落地**：`prep` 一個位元組都不寫資料檔。
    """
    dry = '--dry-run' in sys.argv
    st = load_state()
    items = st.get('items') or []
    if not items:
        print('請先跑：python3 places_review.py prep', file=sys.stderr)
        return 2
    dec = {it['id']: it for it in items if it.get('decision') in ('keep', 'drop')}
    if not dec:
        print('還沒有任何「要」或「不要」的決定，請先跑 serve', file=sys.stderr)
        return 2

    # 讀進四個 hold 檔，把有決定的那幾筆挑出來
    holds, moved = {}, {'keep': [], 'drop': []}
    for fn in hold_files():
        d = load_json(os.path.join(SRC, fn), {})
        rows, rest = _rows(d), []
        for row in rows:
            it = dec.get(row.get('id'))
            if not it:
                rest.append(row)
                continue
            for k, v in (it.get('edit') or {}).items():
                row[k] = v
            moved[it['decision']].append((it, row))
        holds[fn] = (d, rest)

    # 目的地
    out = {}
    for it, row in moved['keep']:
        fn = PREF_FILE.get(it['pref'])
        if not fn:
            print('[warn] %s 的縣「%s」沒有對應檔，跳過' % (it['id'], it['pref']),
                  file=sys.stderr)
            continue
        out.setdefault(fn, []).append(row)
    for it, row in moved['drop']:
        slug = (PREF_FILE.get(it['pref']) or 'other.json').replace('.json', '')
        out.setdefault(DEL_FILE % slug, []).append(row)

    print('要 %d 筆／不要 %d 筆／留在 hold %d 筆'
          % (len(moved['keep']), len(moved['drop']),
             sum(len(r) for _, r in holds.values())))
    for fn in sorted(out):
        print('  → %-34s +%d' % (fn, len(out[fn])))
    if dry:
        print('--dry-run：不寫檔')
        return 0

    # ⚠️ 先寫目的地、再寫來源。反過來的話中途失敗會讓那幾筆兩邊都沒有。
    for fn, rows in out.items():
        path = os.path.join(SRC, fn)
        d = load_json(path, {'places': []})
        have = {r.get('id') for r in _rows(d)}
        for r in rows:
            if r.get('id') in have:
                print('[warn] %s 已在 %s，跳過' % (r.get('id'), fn), file=sys.stderr)
                continue
            _rows(d).append(r)
        save_json(path, d)
    for fn, (d, rest) in holds.items():
        path = os.path.join(SRC, fn)
        if isinstance(d, dict):
            d['places'] = rest
        else:
            d = rest
        if rest:
            save_json(path, d)
        else:
            os.remove(path)      # 整個檔都決定完了就不留空殼
            print('  %s 已清空，移除' % fn)
    print('\n寫好。接著跑：python3 build_places.py --dry-run 看擋下幾筆')
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'prep':
        return prep()
    if cmd == 'serve':
        return serve()
    if cmd == 'apply':
        return apply_decisions()
    print(__doc__)
    return 1


if __name__ == '__main__':
    sys.exit(main())
