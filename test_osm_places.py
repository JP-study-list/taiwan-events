#!/usr/bin/env python3
"""OSM 補位的五道守門，離線回歸測試。

**這支不碰網路，所以 Overpass 掛掉的日子也跑得動**——而那正是需要它的日子：
2026-08-21 接這個功能時，兩個端點整個下午都在 502／丟 TLS 握手，
沒有這支就完全無法分辨「程式對不對」與「今天連不上」。

裡面的標籤組是那天從 Overpass **實際撈到**的（不是編的），涵蓋六種
會混進來的雜訊：公車站、路口、步道、解說牌、停車場、大佛。

    python3 test_osm_places.py     # 全過回 0，有錯回 1

⚠️ **`osm_pick` 的 `addr` 一定要傳真的地址。** 傳空字串的話
`osm_addr_conflict` 會把「OSM 有標 addr:city」的候選全部剔除
（`'君津市' not in ''` 為真）——**測試自己造出一個假失敗**，
而它長得就像程式壞了。第一版就是這樣白追了一輪。
"""
import math
import sys

import build_restaurants as br
import build_places as bp


def at(la, lo, dn, de):
    """從 (la, lo) 往北 dn 公尺、往東 de 公尺。"""
    return (la + dn / 111000.0,
            lo + de / (111000.0 * math.cos(math.radians(la))))


# (景點名, 小類, GSI 給的大字中心, 地址, [(北, 東, name, tags)], 期待挑中的 name)
CASES = [
    ('富岳風穴', '自然景勝', (35.503521, 138.685104),
     '山梨県南都留郡富士河口湖町西湖青木ヶ原2068-1', [
         (3500, 0, '富岳風穴前', {'highway': 'traffic_signals'}),
         (3560, 0, '富岳風穴', {'highway': 'bus_stop'}),
         (3563, 5, '富岳風穴', {'highway': 'bus_stop'}),
         (3743, 0, '富岳風穴', {'barrier': 'toll_booth'}),
         (3823, 0, '富岳風穴', {'natural': 'cave_entrance'}),
         # ⚠️ 這兩個就是「白名單只看 tourism 這個鍵」會出事的地方：
         # 解說牌與地圖看板的 name 裡就寫著景點全名。
         (3591, 0, '富岳風穴', {'information': 'map', 'tourism': 'information'}),
         (3785, 0, '天然記念物 富岳風穴',
          {'information': 'board', 'tourism': 'information'}),
     ], '富岳風穴'),

    ('袋田の滝', '自然景勝', (36.751102, 140.391998),
     '茨城県久慈郡大子町袋田3-19', [
         (2001, 0, '袋田の滝', {}),                       # 只有名字，沒有分類標籤
         (1219, 0, '袋田の滝入口', {'junction': 'yes'}),
         (2026, 0, '袋田の滝', {'tourism': 'attraction'}),
         (1923, 0, '袋田の滝胎内観音', {'historic': 'wayside_shrine'}),
         (1952, 0, '袋田の滝トンネル', {'highway': 'footway', 'tunnel': 'yes'}),
         (900, 0, '茨城交通バス 袋田の滝(滝本)⇒袋田駅',
          {'route': 'bus', 'type': 'route'}),
     ], '袋田の滝'),

    # node（tourism=attraction）與 way（waterway=waterfall）是同一個地方的兩筆
    # 資料。靠 osm_pick 那條「擠在 50m 內就當成一個」收掉，否則「剛好一個」
    # 會把它白白放棄。
    ('亀岩の洞窟(濃溝の滝)', '自然景勝', (35.201393, 140.074387),
     '千葉県君津市笹1954-17', [
         (2197, 0, '亀岩の洞窟', {'tourism': 'attraction', 'addr:city': '君津市'}),
         (2197, 20, '濃溝の滝・亀岩の洞窟', {'waterway': 'waterfall'}),
     ], '亀岩の洞窟'),

    ('三峯神社', '神社寺廟', (35.920311, 138.934265),
     '埼玉県秩父市三峰298-1', [
         (131, 0, '三峯神社', {'highway': 'bus_stop'}),
         (650, 0, '三峯神社表参道', {'highway': 'path'}),
         (720, 0, '三峯神社',
          {'amenity': 'place_of_worship', 'religion': 'shinto'}),
     ], '三峯神社'),

    # OSM 裡**只有三個公車站**叫マザー牧場，牧場本體沒有被畫成 POI。
    # 正確結果是「救不到」，維持概略位置。**這一筆是這份測試的重點之一**：
    # 白名單放寬到 highway=bus_stop 就會把圖釘掛到 1.8km 外的站牌上。
    ('マザー牧場', '水族館動物園', (35.234219, 139.951263),
     '千葉県富津市田倉940-3', [
         (1803, 0, 'マザー牧場', {'highway': 'bus_stop'}),
         (1797, 0, 'マザー牧場', {'highway': 'bus_stop'}),
         (1790, 0, 'マザー牧場',
          {'highway': 'bus_stop', 'public_transport': 'platform'}),
     ], None),

    # 關鍵字取「日本寺」而不是「鋸山」，見 osm_place_key 的第 3 條。
    # 大佛（historic=monument）刻意不在神社寺廟的白名單裡——收了就變兩個候選。
    ('鋸山 日本寺', '神社寺廟', (35.153008, 139.837219),
     '千葉県安房郡鋸南町元名184', [
         (569, 0, '日本寺大仏', {'historic': 'monument'}),
         (494, 0, '鋸山日本寺案内図',
          {'information': 'map', 'tourism': 'information'}),
         (475, 0, '鋸山日本寺無料駐車場', {'amenity': 'parking'}),
         (544, 0, '日本寺',
          {'amenity': 'place_of_worship', 'denomination': 'soto'}),
     ], '日本寺'),

    # ⚠️ 關鍵字是「八景島シーパラダイス」，所以 Overpass 根本不會回
    # 「シーパラダイスタワー」（tourism=attraction，108m 外）。
    # 關鍵字若取成「シーパラダイス」就會多一個候選而整筆被放棄。
    ('横浜・八景島シーパラダイス', '水族館動物園', (35.336521, 139.644135),
     '神奈川県横浜市金沢区八景島', [
         (143, 0, '横浜・八景島シーパラダイス', {'tourism': 'theme_park'}),
     ], '横浜・八景島シーパラダイス'),
]


def main():
    fail = 0
    for name, genre, (la, lo), addr, els, want in CASES:
        js = {'elements': [
            dict(zip(('lat', 'lon'), at(la, lo, dn, de)),
                 tags=dict(tg, name=nm))
            for dn, de, nm, tg in els]}
        got = br.osm_pick(js, name, la, lo, addr, bp.osm_accept(genre))
        gn = got['name'] if got else None
        ok = gn == want
        fail += 0 if ok else 1
        print('%-4s %-22s key=%-20s → %s'
              % ('OK' if ok else 'FAIL', name, bp.osm_place_key(name), gn))
    print('\n失敗 %d／共 %d' % (fail, len(CASES)))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
