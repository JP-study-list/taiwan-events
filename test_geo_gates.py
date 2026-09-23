# -*- coding: utf-8 -*-
"""活動座標三道守門的離線回歸（**完全不打網路**）。

本專案第二支測試。存在的理由與 `test_osm_places.py` 不同——那支是為了分辨
「程式對不對」與「今天 Overpass 連不連得上」；**這支是為了守住三個看不見的不變量**，
它們共同的失敗方式都是「壞掉但看起來完全正常」：

  ① 快取要分地區桶（`GEO_CACHE` 的鍵含 `allowed_prefs`）
     破掉的話：某個桶查到的答案會被發給另一個桶，而 `pref_gate` 不會再跑一次。
     實際發生過：`宝徳寺` 偏 102.9km、`八坂神社神楽殿` 112.2km、`ライブハウス` 97.8km，
     三筆都是 `precise`＝實心圖釘，而**單獨重跑 `geocode()` 回的是對的**，
     只有整批一起跑時才會壞，所以逐筆重現查不出來。
  ② AI 座標的逐桶半徑（`AI_MAX_KM_AREA`）與保底重驗（`previous_still_ok`）
     破掉的話：收嚴的守門會被保底原封不動填回去，統計照增、結果零改變。
  ③ 座標不在日本的既有資料要被重驗（`far_from_japan`）
     破掉的話：國別守門只管新查詢，舊的錯圖釘會一路沿用到活動過期。
  ④ 市町村撞名要靠地區桶消歧義（`CITY_PREF` 的值是縣的 tuple，2026-09-04 起）
  ⑤ `precise` 的座標要被反查複驗（`reverify_coords`，2026-09-04 起，單位 T-4）
     破掉的話：`can_reuse_coords` 對 precise 一律沿用、`geo_v` 連沿用的也蓋上當前版本號，
     於是**當初算錯的座標永遠錯下去**（2026-08-29 稽核 693 筆抓到 11 筆落在錯的縣，
     最遠 97.6km）。⚠️ 最容易破的是「查詢失敗被當成證據」那一半——
     GSI 逾時一次就把一筆好座標降級成概略位置，而那看起來只是「位置變得不太準」。
     破掉的話（改回扁平的 `{市町村: 縣}`）：全國同名的 25 組市町村裡，**後寫進去的
     那個縣會靜默覆蓋先寫的**——群馬的高山村變成長野的、東京的府中市變成廣島的，
     於是活動被「精準地畫到另一座城市」，而畫面上只是一個位置不太對的圖釘。

⚠️ **①刻意不用「預先塞快取」來測**，那樣寫在改動前的版本也會通過（見該段註解）。
A/B 已對照過：同一支跑在改動前是 13 FAIL，改動後 30 PASS / 0 FAIL。

跑法：`python3 test_geo_gates.py`（在專案根目錄，需要 `events.json`）。
"""
import sys, json
sys.path.insert(0, '.')
import fetch_events as fe

P = F = 0
def chk(name, got, want):
    global P, F
    ok = got == want
    print(('  PASS ' if ok else '  FAIL ') + name + ('' if ok else '  got=%r want=%r' % (got, want)))
    P += ok; F += not ok

print('=== ① 快取分桶（3a）===')
# ⚠️ **不可以用「預先塞快取」來測**：舊版的鍵是字串，塞 tuple 進去它一輪都不會命中，
# 於是它會真的去打網路、拿回東京那個答案 → **斷言照樣通過，但什麼都沒測到**
# （本專案第 39 次「測試錯了」的變體：測試自己沒有鑑別力）。
# 改成把三支查詢函式換掉，讓它們**依 allowed_prefs 回不同答案**——
# 這樣「有沒有分桶」就是唯一會改變結果的東西，而且完全不打網路。
TOKYO, GUNMA = (35.643102, 139.737168, 'strong'), (36.452722, 139.31725, 'strong')
calls = []
def stub(query, allowed=None):
    calls.append((query, allowed))
    if allowed and '東京都' in allowed:
        return TOKYO
    if allowed and '群馬県' in allowed:
        return GUNMA
    return None
fe.geocode_osm = stub
fe.geocode_photon = stub
fe.geocode_google = stub
fe.GEO_CACHE.clear()
chk('先用東京桶查', fe.geocode('宝徳寺', '', '東京23區')[:2], TOKYO[:2])
chk('北關東拿到自己的答案，不是東京那個', fe.geocode('宝徳寺', '', '北關東')[:2], GUNMA[:2])
chk('兩個桶各查了一次（沒有互相吃快取）', len(calls), 2)
calls.clear()
chk('同一個桶第二次才吃快取', fe.geocode('宝徳寺', '', '北關東')[:2], GUNMA[:2])
chk('  → 沒有再打一次', len(calls), 0)
# 查無也要分桶：某桶查無不代表別的桶查無
calls.clear()
chk('沖繩桶查無', fe.geocode('宝徳寺', '', '沖繩'), None)
chk('東京桶不受那個「查無」影響', fe.geocode('宝徳寺', '', '東京23區')[:2], TOKYO[:2])

print('=== ② 泛用詞黑名單（3c）===')
for v in ('中心市街地', 'ライブハウス'):
    chk('%s 整段跳過不查' % v, fe.is_multi_site(v), True)
chk('宇都宮市中心市街地（完整寫法）不受影響', fe.is_multi_site('宇都宮市中心市街地'), False)
chk('ライブハウス新宿（有分店名）不受影響', fe.is_multi_site('ライブハウス新宿'), False)

print('=== ③ AI 座標逐桶半徑（4a）===')
amk = getattr(fe, 'ai_max_km', lambda a: getattr(fe, 'AI_MAX_KM'))
chk('東京23區 50km', amk('東京23區'), 50)
chk('北關東 150km', amk('北關東'), 150)
chk('沒列出的桶退回全站上限', amk('沖繩'), fe.AI_MAX_KM)
# 東京23區中心約 (35.68,139.75)；伊豆 (35.1386,139.0604) 約 88km
chk('東京桶：88km 的 AI 座標被擋下',
    fe.parse_latlng({'lat': 35.1386, 'lng': 139.0604}, '東京23區'), None)
chk('東京桶：桶內的 AI 座標照常採用',
    fe.parse_latlng({'lat': 35.70, 'lng': 139.77}, '東京23區'), (35.7, 139.77))
chk('北關東：115km 的輕井澤仍然過關（舊行為不變）',
    fe.parse_latlng({'lat': 36.355, 'lng': 138.635}, '北關東'), (36.355, 138.635))

print('=== ④ 保底重驗（4b）===')
ev = {'area': '東京23區'}
chk('previous 是被擋下的 ai → 不沿用',
    getattr(fe, 'previous_still_ok', lambda e, p: True)(ev, {'geo': 'ai', 'lat': 35.1386, 'lng': 139.0604}), False)
chk('previous 是桶內的 ai → 照常沿用',
    getattr(fe, 'previous_still_ok', lambda e, p: True)(ev, {'geo': 'ai', 'lat': 35.70, 'lng': 139.77}), True)
chk('previous 是 precise → 不在這次收嚴範圍，照常沿用',
    getattr(fe, 'previous_still_ok', lambda e, p: True)(ev, {'geo': 'precise', 'lat': 35.1386, 'lng': 139.0604}), True)

print('=== ⑤ 座標不在日本 → 重驗且不信保底（3b 的既有資料那一半）===')
d = json.load(open('events.json'))
ffj = getattr(fe, 'far_from_japan', lambda e: False)
far = [e for e in d['events'] if ffj(e)]
# ⚠️ **這裡曾經斷言「全站命中 2 筆」，而 2026-08-30 那輪把那兩筆修好之後它就 FAIL 了**
# ——那是**測試過期**，不是產品壞掉。拿當下的資料當期望值，等於要求資料永遠不要被修好。
# 現在改成：對真實資料斷言「已經沒有了」（那是這道守門的目的），
# **機制本身改用合成資料驗**，這樣它不會再隨著資料變動而誤報。
chk('真實資料裡已經沒有座標在國外的活動了', [e['venue_ja'] for e in far], [])
# ⚠️ 合成資料**必須長得跟真的一樣**：少一個 `id`，`can_reuse_coords` 就一律回 False，
# 於是「因此不可沿用」那句照樣 PASS——**而它證明的是缺欄位，不是這道守門**
# （本專案第 40 次「測試自己造出想看的答案」，這次在寫的當下就抓到了）。
# `geo_v` 也要比當前版本舊：`needs_strict_recheck` 第一行就是「這輪處理過就不再驗」，
# 重驗本來就只發生在 GEO_VERSION 剛 +1 的那一輪。
def synth(name, lat, lng):
    return {'id': 'test00000001', 'venue_ja': name, 'lat': lat, 'lng': lng,
            'geo': 'precise', 'geo_v': fe.GEO_VERSION - 1}
FFJ_FOR_NOTE = getattr(fe, 'FAR_FROM_JAPAN_KM', 600)
inside = synth('（合成）東京車站', 35.6812, 139.7671)
chk('對照組：日本境內的 precise 不會被 far_from_japan 抓走', ffj(inside), False)
chk('對照組：它是可以沿用的（證明上面的 False 不是缺欄位造成的）', fe.can_reuse_coords(inside), True)
# 1182.3km，任何合理門檻都抓得到
for name, lat, lng in [('（合成）中國黑龍江', 45.54491, 131.871199)]:
    fake = synth(name, lat, lng)
    chk('%s 會被 far_from_japan 抓到' % name, ffj(fake), True)
    chk('%s 會被 needs_strict_recheck 抓到' % name, fe.needs_strict_recheck(fake), True)
    chk('%s 因此 can_reuse_coords=False' % name, fe.can_reuse_coords(fake), False)

# ⚠️⚠️ **韓國慶州（586.7km）從 2026-09-06 起「刻意」不再由這道守門抓，這是取捨不是漏洞。**
# 門檻拉到 600 是因為西表島 440km 是合法場地（見上方那段），而**釜山離福岡縣廳只有約 210km**
# ——任何一個數字都同時誤殺離島、漏掉近的國外座標，**這個判準本身在 26 桶之後就失效了**。
# 接手的是兩道與距離無關的守門，兩道都在別處驗過：
#   ① 新查詢的國別過濾（Nominatim countrycodes=jp／Photon countrycode，地雷 #3h）
#   ② `reverify_coords()` 拿国土地理院反查（單位 T-4）→ **⑧ 組的 (c2) 就是拿慶州驗的，
#      它在那裡確實被降級**。所以這裡斷言「抓不到」是為了**記住這件事是知情的**，
#      免得日後有人看到 587 < 600 以為是漏設而把門檻調回去（調回去 = 離島每輪白重查）。
kj = synth('（合成）韓國慶州', 35.835234, 129.211848)
chk('韓國慶州「不再」被 far_from_japan 抓到（刻意，改由 T-4 反查接手）', ffj(kj), False)
chk('  ——而它離最近縣中心確實只有不到 600km', 
    min(fe.haversine_km((kj['lat'], kj['lng']), c) for c in fe.PREF_CENTER.values()) < FFJ_FOR_NOTE, True)
# ⚠️⚠️ **這條斷言在 2026-09-06（單位 T-6）改過一次，改的是它問錯了問題。**
# 舊版問「**第三遠**的是否低於門檻的一半」——那個「第三」是寫死的：當時最遠的兩筆
# 正好是要抓的國外壞資料（慶州、黑龍江），跳過它們才問得到「正常資料的上緣」。
# **開了沖繩與北海道之後那個前提沒了**：西表島 440.2km、小浜島 425.5km、別海町 307.6km
# 全部是合法場地，於是「第三遠」變成別海町、307.6 > 300 而 FAIL——**測試是對的，
# 它在說門檻已經失效**（而不是資料壞了）。門檻拉到 600 之後，正確的問法變成
# 「**最遠的**那一筆還在不在門檻之下、餘裕夠不夠」。
far_rank = sorted((min(fe.haversine_km((e['lat'], e['lng']), c) for c in fe.PREF_CENTER.values()), e['venue_ja'])
                  for e in d['events'] if e.get('lat'))
FFJ = getattr(fe, 'FAR_FROM_JAPAN_KM', 600)
farthest = far_rank[-1]
chk('最遠的真實場地仍在門檻之下（＝沒有一筆合法資料被誤抓）', farthest[0] < FFJ, True)
chk('餘裕還有 100km 以上（不夠就是該回頭重想判準，不是調數字）', FFJ - farthest[0] > 100, True)
print('     （最遠：%s %.1fkm，門檻 %dkm，餘裕 %.1fkm）' % (farthest[1], farthest[0], FFJ, FFJ - farthest[0]))
print('     （前三遠：%s）' % '、'.join('%s %.0fkm' % (n, k) for k, n in far_rank[-1:-4:-1]))

print('=== ⑥ 片假名的名稱把關（3k）===')
# 根因：**片假名的字元集小**（而且 ー ェ ッ 這類音符到處都是），字元集合比對在這裡
# 幾乎沒有鑑別力——與地雷 #3f 的英文 26 字母是同一件事，只是換一種文字。
# 實測 `ヴェールカフェ（行田市水城公園）` 被 Photon 配到和光市一個叫
# `ヴェールフェリーチェ` 的**自行車租借站**（重疊率 0.83 → strong），錯 41km 而標成 precise。
# ⚠️ **量出來的**：全站 44 個純片假名查詢字串兩兩配對，現行規則會判 strong 的
# 非包含配對有 19 組、**全部是毫不相干的地方**（`スパ` × `ユニバーサルスタジオジャパン`
# 重疊率高達 1.00），而那 19 組的最長公共子串比例**最高只有 0.50**，要擋的那組是 0.57。
chk('ヴェールカフェ × ヴェールフェリーチェ（差 41km 的那組）', fe.name_confidence('ヴェールカフェ', 'ヴェールフェリーチェ'), '')
chk('スパ × ユニバーサルスタジオジャパン（重疊率 1.00 的極端）', fe.name_confidence('スパ', 'ユニバーサルスタジオジャパン'), '')
chk('サントリー × シェラトングランデトーキョーベイホテル', fe.name_confidence('サントリー', 'シェラトングランデトーキョーベイホテル'), '')
chk('ツタンカーメン × ポケモンスカイツリータウン', fe.name_confidence('ツタンカーメン', 'ポケモンスカイツリータウン'), '')
# 不可誤殺：同名、互為簡稱、以及**含漢字的混合名**（那條路一個字都不該動）
chk('同名照樣 strong', fe.name_confidence('ポーラミュージアムアネックス', 'ポーラミュージアムアネックス'), 'strong')
chk('互為簡稱照樣 strong', fe.name_confidence('ヨコハマグランド', 'ヨコハマグランドインターコンチネンタルホテル'), 'strong')
chk('含漢字 → 不走片假名這條', fe.name_confidence('パシフィコ横浜', 'パシフィコ横浜展示ホール'), 'strong')
chk('日文漢字那條路沒變（別家仍擋下）', fe.name_confidence('目黒区美術館', '東京都写真美術館'), '')
chk('文字系統不同仍是 weak', fe.name_confidence('横浜ワールドポーターズ', 'Yokohama World Porters'), 'weak')

print('=== ⑦ 光禿禿的品牌名不單獨查（3l）===')
# `ねんりん家 大丸東京店` → 切分變體 `ねんりん家` 被 Photon 配到 **`ねんりん家 銀座本店`**
# （互為子字串 → strong），於是活動釘在銀座。⚠️ **與第一百四十五筆餐廳端
# `osm_query_key` 修過的「關鍵字取到分店名」是同一族**，只是活動這支沒修。
# ⚠️ **並列寫法不算分店**：`横浜ワールドポーターズ / 西武渋谷店` 切出的
# `横浜ワールドポーターズ` 是**另一個完整的場地**（而且它現在查得到、座標正確），
# 擋掉它等於把一筆對的變成退回地區中心。判準是「掉的那一截**不以並列分隔符開頭**」。
chk('ねんりん家：掉的整截是〜店 → 算純分店剝除', fe.branch_only('ねんりん家 大丸東京店', 'ねんりん家'), True)
chk('東武百貨店 池袋店 → 同上', fe.branch_only('東武百貨店 池袋店', '東武百貨店'), True)
chk('斜線並列不算（掉的那截以 / 開頭）', fe.branch_only('横浜ワールドポーターズ / 西武渋谷店', '横浜ワールドポーターズ'), False)
chk('頓號並列也不算', fe.branch_only('鬼怒川河畔、橋本運動公園店', '鬼怒川河畔'), False)
calls = []
def stub2(query, allowed=None):
    calls.append(query)
    return None
fe.geocode_osm = fe.geocode_photon = fe.geocode_google = stub2
fe.GEO_CACHE.clear()
fe.geocode('ねんりん家 大丸東京店', '', '東京23區')
chk('光禿禿的 ねんりん家 沒有被單獨查', 'ねんりん家' in calls, False)
chk('但「品牌名＋行政區」那一段仍在（第一百四十四筆靠它修好東武百貨店）', 'ねんりん家 東京都' in calls, True)
calls.clear()
fe.GEO_CACHE.clear()
fe.geocode('横浜ワールドポーターズ / 西武渋谷店', '', '橫濱')
chk('並列切出的那一段照舊單獨查', '横浜ワールドポーターズ' in calls, True)

print('=== ⑧ 兩輪制：Nominatim 掃完所有寫法，Photon 才上（3m）===')
# `成田ゆめ牧場` 的正解一直都在後面的段位（`成田ゆめ牧場 千葉県` Nominatim 回牧場本體），
# 只是 Photon 在第一段就用「成田市幸町的直營冰淇淋店」搶答了（名字一模一樣，
# 兩道守門都攔不住）。⚠️ **這不是把 Photon 關掉，是不讓它搶答**——同 2026-08-28
# 「含括號的字串不給 Photon 回答」那條的推廣。
osm_calls, photon_calls = [], []
def osm_stub(query, allowed=None):
    osm_calls.append(query)
    return (35.871056, 140.397736, 'strong') if query == '成田ゆめ牧場 千葉県' else None
def photon_stub(query, allowed=None):
    photon_calls.append(query)
    return (35.78252, 140.315991, 'strong') if query == '成田ゆめ牧場' else None
fe.geocode_osm, fe.geocode_photon = osm_stub, photon_stub
fe.geocode_google = lambda q, a=None: None
fe.GEO_CACHE.clear()
got = fe.geocode('成田ゆめ牧場', '', '千葉')
chk('拿到的是 Nominatim 後段那個（牧場本體）', got[:2], (35.871056, 140.397736))
chk('Nominatim 有機會跑到後面的段位', '成田ゆめ牧場 千葉県' in osm_calls, True)
chk('Photon 一次都沒被問到（第一輪就命中）', photon_calls, [])
# 反向：Nominatim 整輪都查無時，Photon 仍然要上場（它救回過場地，不可整個關掉）
osm_calls.clear(); photon_calls.clear()
fe.geocode_osm = lambda q, a=None: (osm_calls.append(q), None)[1]
fe.GEO_CACHE.clear()
got2 = fe.geocode('成田ゆめ牧場', '', '千葉')
chk('Nominatim 全查無 → Photon 補位照常生效', got2[:2], (35.78252, 140.315991))
chk('且 Photon 是在 Nominatim 掃完之後才被問', len(osm_calls) >= 2, True)

print('=== ④ 市町村撞名靠地區桶消歧義（單位 O-2，2026-09-04）===')
# ⚠️ 這一組**完全不打網路**：city_of／city_name_of 只是清單比對。
chk('PREF_CITIES 是 47 縣', len(fe.PREF_CITIES), 47)
chk('市町村共 1741 筆（總務省令和6年版，扣掉北方領土六村）',
    sum(len(v) for v in fe.PREF_CITIES.values()), 1741)
chk('CITY_PREF 的值是 tuple（不是單一縣的字串）',
    all(isinstance(v, tuple) for v in fe.CITY_PREF.values()), True)
chk('全國同名的市町村有 25 組',
    sum(1 for v in fe.CITY_PREF.values() if len(v) > 1), 25)
chk('府中市同時屬於東京都與広島県', sorted(fe.CITY_PREF['府中市']), ['広島県', '東京都'])

def cty(venue, area):
    hit = fe.city_of(venue, fe.AREA_PREF_OK.get(area))
    return hit[1] if hit else None

# 撞名：同一個名字在兩個桶要給出兩個不同答案（舊版必定有一邊是錯的）
chk('府中市 × 東京多摩 → 東京都', cty('府中の森芸術劇場 府中市', '東京多摩'), '東京都')
chk('府中市 × 廣島 → 広島県', cty('府中市文化センター', '廣島'), '広島県')
chk('高山村 × 北關東 → 群馬県（長野不在該桶）', cty('高山村やまびこ', '北關東'), '群馬県')
chk('美里町 × 埼玉 → 埼玉県（宮城・熊本不在該桶）', cty('美里町中央公民館', '埼玉'), '埼玉県')
# 撞名且兩個縣同屬一個桶 → 必須放棄，退回縣級（30km）而不是猜一個（可能數百km）
chk('金山町 × 東北 → None（山形與福島同屬東北桶）', cty('金山町体育館', '東北'), None)
chk('池田町 × 北陸甲信越 → None（福井與長野同桶）', cty('池田町ハーブセンター', '北陸甲信越'), None)
# 新補的縣要真的認得出來
chk('札幌市 × 北海道 → 北海道', cty('札幌市時計台', '北海道'), '北海道')
chk('名古屋市 × 名古屋 → 愛知県', cty('名古屋市科学館', '名古屋'), '愛知県')
chk('静岡市 × 東海 → 静岡県（原本靜岡只收 8 個東端市町村）', cty('静岡市美術館', '東海'), '静岡県')
# 最長匹配不可退步
chk('那須塩原市要贏過大田原市', fe.city_name_of('那須塩原市那須野が原公園'), '那須塩原市')
# ⚠️ city_name_of 不受撞名影響：那兩處呼叫端只要「名字」，
# 讓它因為撞名而回空，只會靜默少掉一個查詢段位（表現成「這個場地查不到座標」）
chk('city_name_of 對撞名的市町村照樣回名字', fe.city_name_of('府中市文化センター'), '府中市')
chk('city_name_of 對同桶撞名也照樣回名字', fe.city_name_of('金山町体育館'), '金山町')
# 政令市的区不收（收了沒有增益，市名本來就更長）
chk('札幌市中央区 → 命中更長的「札幌市」', fe.city_name_of('札幌市中央区北1条'), '札幌市')
chk('北方領土六村不在清單裡', [c for c in ('色丹村','留夜別村','紗那村','蘂取村','留別村')
                              if c in fe.CITY_PREF], [])

print('=== ⑤ 反查複驗（單位 T-4，2026-09-04）===')
chk('PREF_BY_CODE 是 47 個都道府縣', len(fe.PREF_BY_CODE), 47)
chk('muniCd 前兩碼 13 → 東京都', fe.PREF_BY_CODE['13'], '東京都')

# ── reverse_pref 的三態（把 http_get 換掉，完全不打網路）
_real_get = fe.http_get
def fake_get(payload):
    def g(url, headers=None, timeout=None):
        if payload is Exception: raise TimeoutError('boom')
        return payload
    return g

fe.http_get = fake_get('{"results":{"muniCd":"13101","lv01Nm":"丸の内一丁目"}}')
chk('反查成功 → (True, 縣名)', fe.reverse_pref(35.68, 139.76), (True, '東京都'))
fe.http_get = fake_get('{}')
chk('境外／遠洋回空 → (True, None)', fe.reverse_pref(35.85, 129.22), (True, None))
fe.http_get = fake_get('not json at all')
chk('回傳不是 JSON → (False, None)＝查詢失敗', fe.reverse_pref(35.0, 139.0), (False, None))
fe.http_get = fake_get(Exception)
chk('逾時 → (False, None)＝查詢失敗', fe.reverse_pref(35.0, 139.0), (False, None))
fe.http_get = fake_get('{"results":{"muniCd":"99999"}}')
chk('代碼認不得 → (False, None)（我們的表過期了，不是資料錯）',
    fe.reverse_pref(35.0, 139.0), (False, None))
fe.http_get = _real_get

# ── reverify_coords：三種去向
fe.REVERIFY_WAIT = 0
def one(area='東京23區', geo='precise', lat=35.68, lng=139.76, rv=None):
    ev = {'id': 'x1', 'area': area, 'geo': geo, 'geo_v': fe.GEO_VERSION,
          'lat': lat, 'lng': lng, 'venue_ja': 'テスト会場',
          'date_start': '2026-09-10', 'date_end': '2026-09-20'}
    if rv: ev['geo_rv'] = rv
    return ev

def run(evs, answer):
    fe.reverse_pref = lambda la, ln: answer
    fe.GEO_STATS.clear()
    fe.reverify_coords(evs)
    return evs

# (a) 縣相合 → 原樣保留 ＋ 蓋上 geo_rv
e = run([one()], (True, '東京都'))[0]
chk('(a) 縣相合 → geo 不動', e['geo'], 'precise')
chk('(a) 縣相合 → geo_rv 寫上今天', e.get('geo_rv'), fe.TODAY.isoformat())

# (b) 縣不合 → 降級成 area ＋ 座標換成退回鏈的
e = run([one()], (True, '静岡県'))[0]
chk('(b) 縣不合 → 降級成 area', e['geo'], 'area')
chk('(b) 縣不合 → 座標真的換掉了', (e['lat'], e['lng']) != (35.68, 139.76), True)
chk('(b) 縣不合 → 也記下驗證日（不會每輪重驗同一筆）', e.get('geo_rv'), fe.TODAY.isoformat())
chk('(b) 有計數', fe.GEO_STATS.get('reverify_demoted'), 1)

# (c) 回空（境外／遠洋／水域）→ 一律降級
#     ⚠️ 曾經加過「近岸水域放行」的例外（横浜港的座標真的在碼頭外海面上、而且是對的），
#     但全站 799 筆實測證明它站不住：該降級的大山崎離桶內縣廳 16.1km、
#     不該降級的多摩川河川敷 16.3km，**距離門檻分辨不出來**。
#     回空的只有 2 筆，而誤降級的代價（對的變概略）遠小於漏降級（32km 的實心圖釘）。
e = run([one(area='橫濱', lat=35.4527, lng=139.6547)], (True, None))[0]
chk('(c1) 回空 → 降級（不要再加「近岸放行」的例外）', e['geo'], 'area')
e = run([one(area='東京23區', lat=35.8562, lng=129.2247)], (True, None))[0]
chk('(c2) 境外（韓國慶州）→ 降級', e['geo'], 'area')

# ── (c3)～(c6) 單位 T-7（2026-09-06）：回空之後再往周圍探一圈 ──────────────
# ⚠️ **(c1)(c2) 那條「回空一律降級」在 2026-09-06 補上了一個前置步驟，但結論沒有被推翻**：
# `reverse_pref` 對水域一律回空，而**碼頭、河川敷、干潟上的座標完全可以是對的**
# （`横浜港(新港ふ頭、大さん橋)` 就在碼頭外海面、`荒尾干潟` 在有明海潮間帶）。
# T-4 當時沒有辦法分開它們（距離門檻分不出：大山崎 16.1km vs 多摩川河川敷 16.3km），
# 所以選了「一律降級」這個安全的失敗方向。T-7 換一種問法——**往周圍探陸地**：
# 實測荒尾干潟在 2km 命中熊本県，而韓國慶州與日本海遠洋在 2／3／5km 全部是空的。
# ⚠️⚠️ **它不是放寬**：探到的縣照樣要過 `AREA_PREF_OK`，見 (c5)。
def probe_stub(edge_pref, edge_ok=True, seen=None):
    """原點一律回空；周圍的點回 edge_pref（edge_ok=False 代表查詢失敗）。"""
    def f(la, ln):
        if seen is not None:
            seen.append((la, ln))
        if abs(la - 35.68) < 1e-9 and abs(ln - 139.76) < 1e-9:
            return (True, None)                     # 原點：水域
        if not edge_ok:
            return (False, None)                    # 周圍：查詢失敗
        return (True, edge_pref)                    # 周圍：陸地（或 None＝仍是海）
    return f

def run_probe(ev, stub):
    fe.reverse_pref = stub
    fe.GEO_STATS.clear()
    fe.reverify_coords([ev])
    return ev

# (c3) 海岸線／碼頭：周圍探到桶內的縣 → 放行，不降級
seen = []
e = run_probe(one(), probe_stub('東京都', seen=seen))
chk('(c3) 回空但周圍是桶內的陸地 → 不降級', e['geo'], 'precise')
chk('(c3) 座標一個字都沒動', (e['lat'], e['lng']), (35.68, 139.76))
chk('(c3) 照樣記下驗證日', e.get('geo_rv'), fe.TODAY.isoformat())
chk('(c3) 有計數（沒有日誌的守門等於不知道它還活著）', fe.GEO_STATS.get('reverify_coast_pass'), 1)
chk('(c3) 第一圈第一點就命中，不必再探下去（原點 1 ＋ 1 點）', len(seen), 2)

# (c4) 真的在遠洋／境外：周圍也全是空的 → 照舊降級
e = run_probe(one(), probe_stub(None))
chk('(c4) 回空且周圍也全空 → 降級（(c1)(c2) 的結論沒有被推翻）', e['geo'], 'area')
chk('(c4) 有計數', fe.GEO_STATS.get('reverify_offshore'), 1)

# (c5) ⚠️⚠️ 最關鍵的一條：探到陸地，但那是**別的縣**（實例：富山的活動座標掉在沖繩海面）
e = run_probe(one(), probe_stub('静岡県'))
chk('(c5) 探到的縣不在桶的白名單 → 照樣降級（探測不是放寬）', e['geo'], 'area')
chk('(c5) 走的是降級那條路，不是「境外」那條', fe.GEO_STATS.get('reverify_demoted'), 1)

# (c6) 探測整輪都查詢失敗 → 不是證據，什麼都不動
#      ⚠️ 壓成「確認境外」的話，一次 GSI 抽風就會把一筆好座標降成概略位置，
#      而畫面上只是「位置變得不太準」（同 reverse_pref 三態不可壓成兩態）。
e = run_probe(one(), probe_stub(None, edge_ok=False))
chk('(c6) 探測全部查詢失敗 → geo 不動', e['geo'], 'precise')
chk('(c6) 探測全部查詢失敗 → 座標不動', (e['lat'], e['lng']), (35.68, 139.76))
chk('(c6) 探測全部查詢失敗 → geo_rv 不寫（下一輪本身就是重試）', e.get('geo_rv'), None)

# (c7) ⚠️⚠️ **界河／縣界海岸：第一個探到的是鄰縣，桶內的縣在後面幾個點上。**
#      實例就是 `多摩川河川敷`——那是東京與神奈川的界河，往北探是東京都、往南是神奈川県，
#      而活動可能屬於「川崎」桶（只接受神奈川県）。**「探到陸地就收工」會在這裡誤降級**，
#      而畫面上只是「位置變得不太準」。所以探測要一路找到桶內的縣才停。
#      📌 這一條是突變測試逼出來的：把 `nearby_land_pref` 裡的白名單檢查拿掉之後，
#      (c1)～(c6) **全部照樣通過**（呼叫端還有一道同樣的檢查，所以那個突變在那些情境下
#      沒有行為差異）——沒有這一條，那道檢查等於沒有被測到。
order = ['東京都', '東京都', '神奈川県', '神奈川県']
def edge_seq(la, ln):
    if abs(la - 35.68) < 1e-9 and abs(ln - 139.76) < 1e-9:
        return (True, None)
    return (True, order.pop(0) if order else '東京都')
e = run_probe(one(area='川崎'), edge_seq)
chk('(c7) 界河：前兩點是鄰縣、第三點才是桶內的縣 → 仍然放行', e['geo'], 'precise')
chk('(c7) 走的是海岸線放行那條路', fe.GEO_STATS.get('reverify_coast_pass'), 1)

# (d) ⚠️ 查詢失敗 → 一個位元組都不能動
e = run([one()], (False, None))[0]
chk('(d) 查詢失敗 → geo 不動', e['geo'], 'precise')
chk('(d) 查詢失敗 → 座標不動', (e['lat'], e['lng']), (35.68, 139.76))
chk('(d) 查詢失敗 → geo_rv 不寫（下一輪本身就是重試）', e.get('geo_rv'), None)

# (e) 只驗有座標、非 area、且桶有縣白名單的
pool = [one(geo='area'), one(geo='precise', lat=None), one(area='其他')]
fe.reverse_pref = lambda la, ln: (True, '静岡県')
fe.GEO_STATS.clear(); fe.reverify_coords(pool)
chk('(e) geo=area／沒座標／桶無白名單 → 都不驗', fe.GEO_STATS.get('reverify_demoted'), None)

# (f) 佇列排序：沒驗過的排最前面
seen = []
fe.reverse_pref = lambda la, ln: (seen.append(1), (True, '東京都'))[1]
old_n = fe.REVERIFY_PER_RUN; fe.REVERIFY_PER_RUN = 2
a, b, c = one(rv='2026-09-01'), one(), one(rv='2026-08-01')
a['id'], b['id'], c['id'] = 'a', 'b', 'c'
fe.GEO_STATS.clear(); fe.reverify_coords([a, b, c])
chk('(f) 每輪只驗 REVERIFY_PER_RUN 筆', len(seen), 2)
chk('(f) 沒驗過的 b 被驗到了', b.get('geo_rv'), fe.TODAY.isoformat())
chk('(f) 最久沒驗的 c 也被驗到了', c.get('geo_rv'), fe.TODAY.isoformat())
chk('(f) 最近才驗過的 a 這輪跳過', a.get('geo_rv'), '2026-09-01')
fe.REVERIFY_PER_RUN = old_n


print('=== ⑩ 退回鏈：市級來源的落點與候選鏈（單位 T-8，2026-09-06）===')
# 退回鏈是「市町村中心 → 縣中心 → 地區中心」。這一組守兩件事：
#   ① 場地名認不出市町村時，改問「這個來源在報導哪個市」（`SOURCE_CITY`）
#   ② 縣級那一段要**逐個試候選**，不可以「取第一個非空的、不合白名單就整條放棄」
# ⚠️⚠️ **兩件的失敗方式都是靜默的**：活動照樣有圖釘、照樣是半透明的概略位置，
# 只是那個點在幾十公里外（熱海的活動落在靜岡市）。
city_calls = []
def city_stub(city, pref):
    city_calls.append((city, pref))
    return (34.0, 139.0)
fe.geocode_city = city_stub

def fb(venue, area, source):
    fe.GEO_STATS.clear()
    city_calls.clear()
    coord = fe.fallback_center({'venue_ja': venue, 'area': area, 'source': source})
    return coord, dict(fe.GEO_STATS), list(city_calls)

# (a) 場地名認不出市町村 → 用來源自帶的市
c, st, calls = fb('海岸沿い特設会場', '箱根熱海', '熱海市觀光協會')
chk('(a) 場地認不出市町村 → 改用來源的市', calls, [('熱海市', '静岡県')])
chk('(a) 走的是「市町村中心(來源)」這一段', st.get('fallback_city_src'), 1)
chk('(a) 不會同時計進原本那一段', st.get('fallback_city'), None)

# (b) ⚠️ 場地名認得出來時**一律優先用場地的**——來源只說得出「這個網站在報導哪個市」，
#     而活動可能辦在鄰市（熱海市觀光協會報導伊東市的花火不是不可能）。
c, st, calls = fb('静岡県伊東市の会場', '箱根熱海', '熱海市觀光協會')
chk('(b) 場地認得出市町村 → 用場地的，不是來源的', calls, [('伊東市', '静岡県')])
chk('(b) 走的是原本那一段', st.get('fallback_city'), 1)

# (c) ⚠️⚠️ 來源的市不在這個桶的白名單 → 擋下（這張表是「猜」，而猜錯的後果是
#     把活動精準地畫到另一座城市，地雷 #3）
c, st, calls = fb('特設会場', '橫濱', '熱海市觀光協會')
chk('(c) 來源的縣不合桶 → 根本不去查那個市', calls, [])
chk('(c) 記在擋下的計數裡', st.get('fallback_city_rejected'), 1)

# (d) ⚠️⚠️ 候選鏈要逐個試。場地名寫「愛知県・滋賀県・奈良県」時 `pref_of` 回愛知県，
#     而桶是關西周邊（只收滋賀・和歌山）——舊寫法就此把 pref 設成 None、
#     **連來源自帶的滋賀県都不再問**，直接掉到最粗的地區中心。
#     ⚠️ **這一條不能比座標**：`AREA_CENTER['關西周邊']` 與滋賀縣廳**是同一個點**，
#     所以修好與沒修好**畫面上一模一樣**，只有統計看得出來走了哪一段。
c, st, calls = fb('愛知県・滋賀県・奈良県', '關西周邊', '滋賀縣觀光')
chk('(d) 場地的縣不合桶 → 換下一個候選（來源的縣），不是整條放棄', st.get('fallback_pref'), 1)
chk('(d) 因此不會掉到地區中心', st.get('fallback_area'), None)
chk('(d) 落點是滋賀縣廳', c, fe.PREF_CENTER['滋賀県'])

# (e) 三個候選都不合 → 才落到地區中心（這一段的行為沒有被改動）
c, st, calls = fb('会場未定', '關西周邊', 'コラボカフェ 動漫聯名')
chk('(e) 都問不到 → 地區中心', st.get('fallback_area'), 1)
chk('(e) 落點是桶的中心', c, fe.AREA_CENTER['關西周邊'])

# (f) ⚠️ 表本身的不變量：市町村名必須真的在 `PREF_CITIES` 裡。
#     `geocode_city` 拿它去查，**打錯一個字的後果是靜默退回縣級**（差幾十公里）。
bad = [(s, c, p) for s, (c, p) in fe.SOURCE_CITY.items()
       if c not in fe.PREF_CITIES.get(p, ())]
chk('(f) SOURCE_CITY 的市町村全部查得到（打錯字是靜默的）', bad, [])
# 來源名也要真的存在，否則這張表永遠不會被用到而看起來完全正常
known = {s.get('name') for s in fe.SOURCES}
chk('(f) SOURCE_CITY 的來源名都還在 SOURCES 裡', 
    [s for s in fe.SOURCE_CITY if s not in known], [])
chk('(f) SOURCE_PREF 的來源名也都還在（同一個道理）',
    [s for s in fe.SOURCE_PREF if s not in known], [])

print('=== ⑨ 沒有動到的東西 ===')
chk('SCHEMA_VERSION 未動', fe.SCHEMA_VERSION, 2)
chk('GEO_VERSION = 11', fe.GEO_VERSION, 11)
chk('GEO_BBOX 未動', fe.GEO_BBOX, (24.0, 122.9, 45.6, 146.0))

print('\n%d PASS / %d FAIL' % (P, F))
sys.exit(1 if F else 0)
