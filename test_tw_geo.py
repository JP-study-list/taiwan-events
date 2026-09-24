#!/usr/bin/env python3
"""台灣版查座標的離線回歸（2026-09-24 新增，單位 E-5）。

**守的是「壞掉但看起來完全正常」的那幾件事**——全部不打網路，一秒跑完：
`python3 test_tw_geo.py`

- 地址拆錯 → 查不到 → 默默退回區中心或縣市中心（半透明圖釘，看起來只是「概略位置」）。
  更糟的是**區拆錯**：只給縣市時「臺南市中西區中正路1號」會配到玉井區的中正路1號（差 30km），
  而且因為配到門牌，標成**精確**。
- 台／臺沒統一 → 縣市守門認不出縣名就**放行**、名稱比對分數被拉低。
- 兄弟設施被判成同一個地方（「…旗津分館」對「…總館」字元重疊 0.78）→ 自信的錯座標。
- 文化部的圖片網址兩段黏在一起。
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('fe_tw_test', os.path.join(ROOT, 'fetch_events.py'))
fe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fe)

FAIL = []


def chk(label, got, want):
    ok = got == want
    print(('  PASS  ' if ok else '  FAIL  ') + label + ('' if ok else '   got=%r want=%r' % (got, want)))
    if not ok:
        FAIL.append(label)


print('[1] 地址拆解 parse_tw_addr（實際出現過的寫法）')
for addr, want in [
    ('臺中市40453 臺中市北區館前路1號', ('臺中市', '北區', '館前路', '1')),        # 縣市與郵遞區號交錯
    ('100臺北市中正區南海路49號', ('臺北市', '中正區', '南海路', '49')),            # 郵遞區號開頭
    ('台南市中西區中正路1號', ('臺南市', '中西區', '中正路', '1')),                 # 台→臺
    ('臺北市中正區中山南路21-1號，信義路側', ('臺北市', '中正區', '中山南路', '21-1')),  # 逗號後的附註
    ('內湖區瑞光路548巷15號5樓', (None, '內湖區', '瑞光路548巷', '15')),           # 沒寫縣市、巷、樓層
    ('承德路三段131號', (None, None, '承德路三段', '131')),                       # 只有路
    ('新竹縣五峰鄉16鄰331-1號', ('新竹縣', '五峰鄉', None, '331-1')),              # 鄰、沒有路名
    ('新竹縣竹北市光明六路10號', ('新竹縣', '竹北市', '光明六路', '10')),            # 縣轄市
    ('臺北市信義區菸廠路88號B1', ('臺北市', '信義區', '菸廠路', '88')),
    ('高雄市路竹區', ('高雄市', '路竹區', None, None)),
]:
    chk(addr, fe.parse_tw_addr(addr), want)

print('[2] 縣市判斷 county_of／縣市守門 pref_gate（台／臺）')
chk('地址開頭的縣市優先（後面出現別的縣市不算）', fe.county_of('新北市板橋區文化路，近臺北市'), '新北市')
chk('場地名寫「台」也認得', fe.county_of('', '台東縣池上鄉'), '臺東縣')
chk('守門：結果寫「台南市」、白名單寫「臺南市」→ 放行', fe.pref_gate('台南市政府, 安平區, 台南市', ('臺南市',)), True)
# ⚠️ 上面那項**沒有鑑別力**：守門認不出縣名時本來就放行，拿掉台→臺統一照樣 PASS（突變測試抓到的）。
#    真正有鑑別力的是這項：沒統一的話「台北市」認不出來 → 放行 → 臺北的結果給了新北桶。
chk('守門：結果寫「台北市」→ 不給新北桶', fe.pref_gate('台北市政府, 信義區, 台北市', ('新北市',)), False)
chk('守門：新北市的結果不給臺北桶', fe.pref_gate('新北市政府, 板橋區, 新北市', ('臺北市',)), False)
chk('PREF_TO_AREA：連江縣 → 馬祖', fe.PREF_TO_AREA.get('連江縣'), '馬祖')

print('[3] 名稱比對 name_confidence（中文）')
for q, f, want in [
    ('國立臺灣文學館', '國立台灣文學館', 'strong'),                         # 台／臺
    ('衛武營國家藝術文化中心音樂廳', '衛武營國家藝術文化中心', 'strong'),        # 館內的一個廳
    ('臺中國家歌劇院大劇院', '臺中國家歌劇院', 'strong'),
    ('亞洲大學現代美術館', '亞洲大學附屬現代美術館', 'strong'),               # 中間多了修飾語
    ('高雄市立圖書館旗津分館', '高雄市立圖書館總館', ''),                   # ⚠️ 兄弟設施
    ('國立臺灣美術館', '國立臺灣博物館', ''),                              # ⚠️ 兄弟設施
    ('華山1914文化創意產業園區', '松山文創園區', ''),
]:
    chk('%s ↔ %s' % (q, f), fe.name_confidence(q, f), want)

print('[4] 文化部資料的清洗')
chk('圖片網址兩段黏在一起 → 取後段',
    fe._moc_img('https://cloud.culture.twhttps://cloud.culture.tw/e_new_upload/a.jpg'),
    'https://cloud.culture.tw/e_new_upload/a.jpg')
chk('正常的圖片網址不動', fe._moc_img('https://cloud.culture.tw/b.jpg'), 'https://cloud.culture.tw/b.jpg')
chk('內部主機名稱的圖片網址（http://data-service/…）不採用', fe.clean_img_url('http://data-service/api/collection/image/x?uid=1'), '')
chk('  公開網域的照常', fe.clean_img_url('https://kinmen.travel/image/44541/640x480'), 'https://kinmen.travel/image/44541/640x480')
# 只比對**會生效的寫法**（說明文字裡提到 countrycodes=jp 不算）
src = open(os.path.join(ROOT, 'fetch_events.py'), encoding='utf-8').read()
chk('程式碼裡沒有日本的國別過濾', [x for x in ('"&countrycodes=jp"', '!= "JP"') if x in src], [])

print('[5] 地址查詢一定帶「區」（攔下實際送出的網址，不打網路）')
# ⚠️ 只給縣市時「臺南市中西區中正路1號」配到玉井區（差 30km、而且標成精確）。
sent = []
real_get, real_sleep = fe.http_get, fe.time.sleep
fe.http_get = lambda url, headers=None, timeout=60: (sent.append(url), '[]')[1]
fe.time.sleep = lambda s: None
try:
    fe.GEO_CACHE.clear()
    fe.geocode_addr_tw('臺南市中西區中正路1號', None, ('臺南市',))
    from urllib.parse import urlparse, parse_qs
    q = parse_qs(urlparse(sent[-1]).query) if sent else {}
    chk('送出的查詢帶了區名', q.get('city'), ['中西區'])
    chk('送出的查詢帶了縣市', q.get('state'), ['臺南市'])
    chk('門牌與路名放在 street', q.get('street'), ['1 中正路'])
    chk('只查台灣', q.get('countrycodes'), ['tw'])
finally:
    fe.http_get, fe.time.sleep = real_get, real_sleep
chk('国土地理院複驗維持停用（E-5 換成台灣的反查之前）', fe.REVERIFY_PER_RUN, 0)

print('[5b] 場館名的查詢寫法 venue_variants_tw（Photon 對寫法很挑）')
vv = fe.venue_variants_tw
chk('剝樓層（「一樓廣場玻璃屋」）', vv('台北三創生活園區一樓廣場玻璃屋')[-1], '三創生活園區')
chk('拿掉館內的廳（衛武營…音樂廳 → 衛武營…中心）', '衛武營國家藝術文化中心' in vv('衛武營國家藝術文化中心音樂廳'), True)
chk('文化創意產業園區 → 文創園區／華山1914', {'華山1914文創園區', '華山1914'} <= set(vv('台北華山1914文化創意產業園區')), True)
chk('⚠️ 原名一定排第一（「臺中」是館名的一部分）', vv('臺中國家歌劇院大劇院')[0], '臺中國家歌劇院大劇院')
chk('⚠️ 「臺南美術館」不可以剝成「美術館」（剝完不到 4 字不試）', vv('臺南美術館'), ['臺南美術館'])

print('[6] 跨來源去重 dedupe_events（2026-09-24，Actions 實跑 1,441 筆裡 26 組可疑）')
def E(title, src, venue, d0, d1, lat=25.0, lng=121.5, area='台北', **kw):
    return dict(title=title, source=src, venue=venue, date_start=d0, date_end=d1, lat=lat, lng=lng, area=area,
                id=title + d0, url=kw.get('url', ''), img=kw.get('img', ''), desc='', addr='')
out, n = fe.dedupe_events([
    # 座標刻意拉開 >1km（鄉的代表點 vs 園區本身），讓「只寫鄉鎮區」成為唯一的合併理由
    E('「世紀初戀．楊麗花」歌仔戲特展', '觀光署活動', '五結鄉', '2025-12-25', '2027-10-25', lat=24.685, lng=121.773, area='宜蘭', img='x.jpg'),
    E('世紀初戀－楊麗花歌仔戲特展', '文化部藝文活動', '國立傳統藝術中心宜蘭園區', '2027-01-01', '2027-10-25', lat=24.686, lng=121.824, area='宜蘭'),
])
chk('只寫鄉鎮區（五結鄉）＋標題標點不同 → 合成一筆', (n, len(out)), (1, 1))
chk('  留文化部那筆、補上觀光署的圖', (out[0]['source'], out[0]['img'], out[0]['date_start']), ('文化部藝文活動', 'x.jpg', '2025-12-25'))
out, n = fe.dedupe_events([
    E('大英博物館鉅獻《埃及之王：法老》', '文化部藝文活動', '臺南市奇美博物館', '2026-01-29', '2026-12-31', area='台南'),
    E('大英博物館鉅獻《埃及之王：法老》', '文化部藝文活動', '臺南市奇美博物館', '2027-01-01', '2027-01-10', area='台南'),
])
chk('拆成兩段的展期（12/31 接 1/1）→ 合成一筆、期間接起來', (n, out[0]['date_start'], out[0]['date_end']), (1, '2026-01-29', '2027-01-10'))
out, n = fe.dedupe_events([
    E('狂美《璀璨經典百老匯II》交響音樂會', '文化部藝文活動', '國家音樂廳', '2026-10-01', '2026-10-01', lat=25.036, lng=121.518),
    E('狂美《璀璨經典百老匯II》交響音樂會', '文化部藝文活動', '臺北市中山堂中正廳', '2026-10-08', '2026-10-08', lat=25.043, lng=121.510),
])
chk('⚠️ 巡演：不同場地、不同日期 → 不可合併', n, 0)
out, n = fe.dedupe_events([
    E('新手村 節目', '文化部藝文活動', '臺中國家歌劇院中劇院', '2026-07-30', '2026-12-31', lat=24.162, lng=120.640, area='台中'),
    E('新手村 節目', '文化部藝文活動', 'Legacy Taichung', '2026-09-18', '2026-09-25', lat=24.150, lng=120.662, area='台中'),
])
chk('⚠️ 同期但不同場館（相距 >1km）→ 不可合併', n, 0)
# ⚠️ 上面幾項都是「場地對不上」，**日期那條沒被考驗到**（突變測試抓到：拿掉日期檢查照樣全過）。
out, n = fe.dedupe_events([
    E('金門坑道音樂節', '觀光署活動', '翟山坑道', '2026-05-01', '2026-05-03', area='金門'),
    E('金門坑道音樂節', '觀光署活動', '翟山坑道', '2026-11-06', '2026-11-08', area='金門'),
])
chk('⚠️ 同場地、上下半年各一場（日期隔半年）→ 不可合併', n, 0)

print()
if FAIL:
    print('%d 項失敗：%s' % (len(FAIL), '、'.join(FAIL)))
    sys.exit(1)
print('全部通過')
