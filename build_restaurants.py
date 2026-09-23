#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""餐廳資料管線 —— 把「清單」整理成「地圖能用的資料」。

與 fetch_events.py 的分工：
  fetch_events.py  自動抓活動（來源是網站，每天變）
  build_restaurants.py  整理餐廳清單（來源是人工放進 restaurants_src/ 的檔案，不常變）

**這支程式不去任何地方取得「哪些店上榜」。** 名單由使用者放進 restaurants_src/，
本程式只負責名單進來之後的事：修編碼、正規化欄位、重驗座標、算地區與據點、
跨榜單去重、輸出前端資料。

用法：
    python3 build_restaurants.py            # 全量（座標沿用快取，只查新的）
    python3 build_restaurants.py --recheck  # 強制重驗全部座標
    python3 build_restaurants.py --dry-run  # 只報告不寫檔

輸出：
    restaurants/<年>_<類別>_<地區>.json   正規化後的榜單檔（人可讀、可稽核）
    restaurants/_map.json                 前端地圖用的輕量索引（只含關東）
    restaurants/index.json                清單檔（自動產生）
    _probe/restaurants_report.txt         需人工複查的清單
"""

import argparse, hashlib, json, math, os, re, sys, time, unicodedata
import urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(ROOT, 'restaurants')          # 產出，會被發布到網站
# ⚠️ **收件匣與快取必須放在 restaurants/ 外面**：Cloudflare 的組建命令是
# `cp -r … restaurants dist/`，整個資料夾都會上線。把原始清單放進去等於
# 把它發布到自家網域下（地雷 #14 的同款錯誤）。
SRC = os.path.join(ROOT, 'restaurants_src')      # 你放清單的地方，不發布
CACHE_PATH = os.path.join(SRC, '_geocache.json')
REPORT_DIR = os.path.join(ROOT, '_probe')

SCHEMA_VERSION = 1
# 正規化邏輯的版本。**改動欄位對應或座標驗證後 +1**，既有資料才會重跑。
# 與 fetch_events.py 的 GEO_VERSION 同一個道理（地雷 #4）。
BUILD_VERSION = 2

# 座標可接受的誤差：我們的座標與 GSI 由地址算出的座標差多少以內算「一致」。
# 100m 是使用者訂的驗收標準；超過就標記待查，不自動改寫。
COORD_TOLERANCE_M = 100
# 差超過這個距離視為「明顯錯誤」，直接改用 GSI 的座標。
COORD_REPLACE_M = 500

GSI_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q='
UA = 'kanto-events-restaurants/1.0 (+https://events.rensakobo.com)'

# ── OSM 補位（2026-08-20）────────────────────────────────────────────
# **GSI 只查得到「大字」、連番地重組也救不回來時的最後一手**。鄉下的地址
# （`千葉県君津市大戸見296`）在 GSI 的資料庫裡只收到聚落層級，於是圖釘落在
# 村子中心、實測差 0.6〜1.5km。而那些店 OpenStreetMap 常常是有的——
# 但**要用「店名＋地理範圍」聯合查詢**（地雷 #3d），不能拿店名去問地址解析器。
#
# ⚠️ **絕不可改用 Nominatim／Photon**：那兩個是檢索器，一定會給你「最像的」。
# 實測這三筆鄉下地址 Nominatim 全部查無，而 Overpass 直接掃原始資料就找到了。
# **兩個端點，主站不通就換備援**。理由不是龜毛：這支每月跑在 GitHub Actions 的
# 共用 IP 上，而 overpass-api.de 對被大量使用的 IP 會**直接把 TLS 握手丟掉**
# （本機實測連 `/api/status` 都連不上，同時鏡像站一切正常）。
# ⚠️ **被擋的失敗是靜默的**——管線照跑、統計照印，只是這幾家永遠留在
# 「地址不夠細」，沒有任何人會發現這條路從來沒生效過。
# ⚠️ **順序就是優先序，第三個是最後一手**（2026-08-21 加，使用者同意）。
# 那天兩個主端點整個下午都不通（主站丟 TLS 握手、kumi 一路 502，`curl` 也一樣，
# 所以不是 Python 的問題），而這個公開鏡像是唯一答得出來的。
# ⚠️ **不要為了「多幾個更保險」而亂加端點**：`overpass.osm.ch` 實測**回 HTTP 200
# 但 elements 是空的**——它只收瑞士的資料。那種端點比掛掉還糟，因為
# 「查詢成功、查無結果」會被寫進快取，等於**永久判定「OSM 沒有這個地方」**。
# 加新端點前務必先拿一個「一定查得到」的日本 POI 打一次，確認它真的有全球資料。
OVERPASS_URLS = ('https://overpass-api.de/api/interpreter',
                 'https://overpass.kumi.systems/api/interpreter',
                 'https://maps.mail.ru/osm/tools/overpass/api/interpreter')
# 候選必須落在 GSI 那個大字中心的多少公尺內。5km 是「同一個聚落與鄰近範圍」的量級，
# 實測救回的三筆位移 606m／1185m／1556m 都在裡面。
# ⚠️ **這個預設值是給景點用的，不要為了餐廳去動它**（`build_places.py` 走
# `br.osm_poi_search` 共用這支）：景點救回的富岳風穴位移 **3,823m**、
# 亀岩の洞窟 2,198m、袋田の滝 2,026m，收窄等於把它們弄丟而且是靜默的
# （退回 approx，畫面上只是多一行「概略位置」）。餐廳那把尺見 `OSM_RADIUS_FOOD`。
OSM_RADIUS_M = 5000
# **餐廳專用的半徑**（2026-08-29）。餐廳的地址是市區的町名，GSI 給的町名中心
# 離店本來就近；而 5km 之下同名的別家店太容易剛好只有一個而被採信——
# 實測 `松之助 京都本店` 配到 3.2km 外另一家真的叫「松之助」的餐廳、
# `ブルー ファー ツリー` 配到 3.1km 外的「ブルーデル」，**兩筆在地圖上
# 都跟正確的長得一模一樣**。
# ⚠️ **2500 是量出來的不是挑的**：既有 15 筆正確的補位最遠 1,779m（ミスリム），
# 而錯的兩筆是 2,885m 與 3,094m——這個值讓正確的一筆都不掉、錯的兩筆自己死。
# ⚠️ **不要為了「多救幾家鄉下的店」往上調**：那正是 5km 已經證明會出事的區間。
OSM_RADIUS_FOOD = 2500
# 比對店名前要拿掉的分隔符。**中黑點一定要算進來**（同 `same_place()` 的正規化）：
# OSM 常寫 `エム・エス・アッシュ` 而榜單寫 `エム エス アッシュ`。
NAME_SEP_RE = re.compile(r'[\s\u3000・･]+')
# 這個 POI 是不是「吃的」。**通不過就丟掉**——名稱撞到學校、車站、橋的機率
# 遠高於撞到另一家餐廳（實測用「青」去查就撈回 3.5km 外的「青松学園」）。
OSM_AMENITY = {'restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream',
               'food_court', 'biergarten'}
OSM_SHOP = {'bakery', 'confectionery', 'pastry', 'deli', 'chocolate',
            'ice_cream', 'coffee', 'tea', 'butcher', 'seafood', 'food'}
# OSM 若自己標了市區町村而與我們的地址對不上，直接剔除這個候選。
OSM_ADDR_KEYS = ('addr:city', 'addr:town', 'addr:village')
# **整輪花在 Overpass 上的時間上限**。一筆最壞會卡到兩個端點各逾時一次（約 2 分鐘），
# 而鄉下的清單只會愈加愈多——沒有這道閘，某天它就會把 workflow 的 60 分鐘撐爆，
# 而那時**連活動以外的餐廳資料都不會更新**。超過就跳過剩下的，下個月再說：
# 失敗方向一樣是安全的（維持概略位置，不會寫進錯的東西）。
OSM_TIME_BUDGET_S = 600

# ── 地區桶 ──────────────────────────────────────────────────────────
# **必須與 js/config.js 的 AREAS 完全一致**，且只能新增或拆分，不能改名或合併
# （地雷 #16：桶名是白名單，改名等於下次執行就刪光那批資料）。
# 2026-08-28 第一批擴張（dev4）：大阪、京都各涵蓋該府全域。
# ⚠️⚠️ **同一個圈的桶必須在這份清單裡相鄰**——`js/cards.js` 的 `buildAreaSel` 是
# 「以 AREAS 為主迴圈、圈名一變就關掉 optgroup」，圈被拆散的話畫面上會冒出
# **兩個同名群組、各自帶一個「整個關西」**，而那看起來只像是選單有點怪。
# 2026-09-02 就差點踩到：新桶若一律接在尾端，神戶／奈良／關西周邊會與大阪／京都
# 隔開。**所以那三個插在京都之後，其餘 11 個才接在尾端**（既有 12 個的相對順序未動）。
# 2026-09-02 全日本開桶（dev4 核心）：一次補上其餘 14 個桶，47 都道府県都有歸宿。
# ⚠️ **這一份必須與 fetch_events.py 與 js/config.js 的 AREAS 逐字相同**（三份，改一處要改三處）。
# ⚠️ **開桶＝那些縣的餐廳當天上線**（資料早就躺在詳細檔裡，只是被這份白名單擋著）。
AREAS = ['東京23區', '東京多摩', '橫濱', '川崎', '鎌倉湘南', '箱根熱海',
         '富士山周邊', '埼玉', '千葉', '北關東',
         '大阪', '京都', '神戶', '奈良', '關西周邊',
         '北海道', '東北', '北陸甲信越', '名古屋', '東海',
         '廣島', '山陰山陽', '四國', '福岡', '九州', '沖繩']

TOKYO_23 = set('千代田 中央 港 新宿 文京 台東 墨田 江東 品川 目黒 大田 世田谷 渋谷 '
               '中野 杉並 豊島 北 荒川 板橋 練馬 足立 葛飾 江戸川'.split())
KANAGAWA_YOKOHAMA = {'横浜市'}
KANAGAWA_KAWASAKI = {'川崎市'}
KANAGAWA_SHONAN = {'鎌倉市', '藤沢市', '茅ヶ崎市', '逗子市', '葉山町', '大磯町', '平塚市'}
HAKONE_ATAMI = {'箱根町', '熱海市', '湯河原町', '真鶴町', '伊東市'}
FUJI = {'富士吉田市', '御殿場市', '山中湖村', '河口湖町', '富士河口湖町', '忍野村',
        '裾野市', '小山町', '鳴沢村'}
KITAKANTO_PREF = {'茨城県', '栃木県', '群馬県'}

# 縣名 → 地區桶（只處理「整個縣就是一個桶」的情況）
# ⚠️ **靜岡・山梨・神奈川・東京不在這張表裡**，它們要先看市區町村（見 area_of）。
PREF_AREA = {'埼玉県': '埼玉', '千葉県': '千葉',
             '茨城県': '北關東', '栃木県': '北關東', '群馬県': '北關東',
             '大阪府': '大阪', '京都府': '京都',
             # ── 2026-09-02 全日本 ─────────────────────────────────
             '北海道': '北海道',
             '青森県': '東北', '岩手県': '東北', '宮城県': '東北',
             '秋田県': '東北', '山形県': '東北', '福島県': '東北',
             '新潟県': '北陸甲信越', '富山県': '北陸甲信越', '石川県': '北陸甲信越',
             '福井県': '北陸甲信越', '長野県': '北陸甲信越',
             '愛知県': '名古屋',
             '岐阜県': '東海', '三重県': '東海',
             '兵庫県': '神戶', '奈良県': '奈良',
             '滋賀県': '關西周邊', '和歌山県': '關西周邊',
             '広島県': '廣島',
             '岡山県': '山陰山陽', '山口県': '山陰山陽',
             '鳥取県': '山陰山陽', '島根県': '山陰山陽',
             '徳島県': '四國', '香川県': '四國', '愛媛県': '四國', '高知県': '四國',
             '福岡県': '福岡',
             '佐賀県': '九州', '長崎県': '九州', '熊本県': '九州',
             '大分県': '九州', '宮崎県': '九州', '鹿児島県': '九州',
             '沖縄県': '沖繩'}

# ── 據點（必須與 js/config.js 的 SPOTS / SPOT_R 一致）─────────────────
SPOTS = {
    '澀谷': (35.6580, 139.7016), '新宿': (35.6896, 139.7006), '池袋': (35.7295, 139.7109),
    '上野': (35.7141, 139.7774), '淺草': (35.7148, 139.7967), '押上晴空塔': (35.7101, 139.8107),
    '銀座': (35.6717, 139.7650), '東京車站': (35.6812, 139.7671), '日本橋': (35.6839, 139.7745),
    '六本木': (35.6627, 139.7314), '赤坂': (35.6745, 139.7368), '台場': (35.6297, 139.7763),
    '豐洲': (35.6549, 139.7967), '秋葉原': (35.6984, 139.7731), '品川': (35.6285, 139.7387),
    '惠比壽': (35.6467, 139.7101), '目黑': (35.6339, 139.7157), '中目黑': (35.6440, 139.6989),
    '下北澤': (35.6613, 139.6680), '清澄白河': (35.6817, 139.7996), '汐留': (35.6640, 139.7597),
    '表參道': (35.6652, 139.7126), '兩國': (35.6959, 139.7930), '後樂園': (35.7056, 139.7519),
    # ── 東京 +3（2026-09-10，單位 Y-2）──────────────────────────────
    # 落進「其他」的 310 家裡，有 109 家聚在這三個生活圈（各 57／26／26）。
    # ⚠️ **只開這三個是使用者的決定**：中野（21 家）與三軒茶屋（20 家）同樣達標，
    # **這一輪刻意不開**，日後要補時中心點是 (35.7054,139.6677) 與 (35.6339,139.6613)。
    # ⚠️ 大阪・京都・名古屋的「其他」**救不動、不要試**：最密的 1.8km 圈分別只有
    # 13／5／8 家（實測），開了也收不到人。這三個桶落單的是散在郊區的甜點與麵店。
    # 實測東京 1721 家：其他 310 → 214、覆蓋 82% → 88%，
    # **最大據點仍是銀座 203**（沒有任何據點超過 200 的驗收標準照樣成立）。
    # ⚠️ 飯田橋離新宿只有 2.25km（既有據點之間也有這個距離），靠就近取勝分界；
    # 實測被搶走的只有新宿 -3、赤坂 -3、後樂園 -7，全是邊界上兩邊都算得到的店。
    '飯田橋・神樂坂': (35.7012, 139.7211), '自由之丘・尾山台': (35.6070, 139.6665),
    '荻窪・西荻': (35.7039, 139.6182),

    # ── 大阪 12（2026-08-28，dev4 第一批）────────────────────────────
    # ⚠️ **大阪核心區比東京密**：1.8km 半徑之下，梅田～北新地～堂島～淀屋橋～北濱
    # 全落在同一圈內，只放一個「梅田」會一口氣吃掉 450 家（東京最大的銀座才 220），
    # 那時據點篩選等於沒有。故北側刻意用相鄰據點切開，靠 spot_of 的「就近取勝」自動分界。
    # **驗收標準：沒有任何一個據點超過 200 家**（＝不超過東京現況的最大值）。
    # 實測 720 家：最大是北新地・堂島 172、淀屋橋・北濱 136，覆蓋 87%。
    '梅田': (34.7025, 135.4959), '北新地・堂島': (34.6950, 135.4945),
    '淀屋橋・北濱': (34.6928, 135.5045), '中崎町・天神橋': (34.7090, 135.5075),
    '心齋橋・南船場': (34.6753, 135.5006), '難波・道頓堀': (34.6665, 135.5011),
    '堀江': (34.6725, 135.4950), '谷町・上町': (34.6820, 135.5130),
    '天王寺・阿倍野': (34.6455, 135.5138), '京橋・都島': (34.6968, 135.5341),
    # ⚠️ 這兩個**餐廳很少甚至沒有**（大阪港 0 家、住吉・長居 9 家），留著是因為
    # **據點不只服務餐廳頁**——海遊館、住吉大社、長居植物園都在這裡，而景點與活動
    # 也要靠據點分區。同京都的嵐山（5 家）與伏見稻荷（1 家）。
    '大阪港・天保山': (34.6547, 135.4290), '住吉・長居': (34.6128, 135.5025),

    # ── 京都 13（2026-08-28，dev4 第一批）────────────────────────────
    # 實測 479 家：最大是烏丸御池 144，覆蓋 95%。
    # ⚠️ **「京都御苑・下鴨」不可合成一個據點**：實測京都御苑離烏丸御池只有 1.69km，
    # 本來就被吃得到；放在御苑與下鴨的中點反而兩端都落空（覆蓋 90% vs 93%）。
    # 故這一格專職下鴨，御苑交給烏丸御池。
    '京都車站': (34.9858, 135.7588), '四條河原町': (35.0037, 135.7688),
    '祇園・東山': (35.0035, 135.7760), '烏丸御池': (35.0100, 135.7597),
    '岡崎・平安神宮': (35.0160, 135.7830), '西陣・紫野': (35.0300, 135.7450),
    '下鴨・北大路': (35.0400, 135.7720), '西院・壬生': (35.0043, 135.7315),
    # 以下四個同樣是「餐廳少但景點在那裡」。少了金閣寺・衣笠那一格，
    # 金閣寺・龍安寺・仁和寺三個世界遺產會一起落單。
    '嵐山': (35.0095, 135.6770), '伏見稻荷': (34.9671, 135.7727),
    '銀閣寺・北白川': (35.0270, 135.7982), '金閣寺・衣笠': (35.0355, 135.7220),
    '宇治': (34.8914, 135.8074),

    # ── 名古屋 9（2026-09-02，dev4 全日本開桶）──────────────────────
    # ⚠️ **本輪只有名古屋開據點，其餘 13 個新桶都不開**，判準是既有的實測值：
    # 現行「埼玉 106 家」「橫濱 101 家」都沒有據點而運作正常，所以門檻在 100 出頭；
    # 新桶裡只有**名古屋市單一城市就 248 家**明顯超過（福岡市 137、札幌 132、
    # 神戶市 84 都在可接受範圍）。**等某個桶長過那條線再補，不要現在先寫。**
    # 實測 277 家（愛知全縣）：最大是榮 52，覆蓋 77%（名古屋市內 85%），
    # 遠低於「沒有據點超過 200 家」的驗收標準。
    # ⚠️ 名駅・伏見・榮・大須四個在 1.8km 內互相重疊，靠 spot_of 的就近取勝自動分界
    # ——合成一個「名古屋中心」會一口氣吃掉 147 家（同大阪梅田那條的理由，只是輕一級）。
    # 金山（8 家）與大曾根（5 家）餐廳很少但**德川園・德川美術館・熱田神宮在那裡**，
    # 留著的理由同大阪港・天保山與京都的伏見稻荷。
    '名古屋車站': (35.1706, 136.8816), '伏見': (35.1690, 136.8975),
    '榮': (35.1681, 136.9080), '大須': (35.1595, 136.9020),
    '東區・白壁': (35.1810, 136.9160), '今池・千種': (35.1690, 136.9350),
    '覺王山': (35.1690, 136.9500), '金山': (35.1430, 136.9006),
    '大曾根': (35.1890, 136.9370),
}
SPOT_R = 1.8
OTHER_SPOT = '其他'

# ── 類別對照（羅馬字 ↔ 繁中 ↔ 日文）──────────────────────────────
# 新增類別時在這裡加一行，並記得補 css/style.css 的 --c-/--pin- 配色。
# 榜單 slug → (顯示名稱, 等級)。**slug 一個蘿蔔一個坑地代表「榜單＋等級」**，
# 所以 michelin 拆成 michelinbib／michelin1／michelin2/michelin3——
# 米其林同一年同一類別會有多個等級，若 slug 只寫 michelin，等級就得逐店標一百次。
#
# ⚠️ **這張表只是後備與驗證**。真正的權威是清單檔裡的 `meta` 區塊：
# 榜單的正式名稱與官方榜單頁網址，程式沒有辦法自己知道，只有整理清單的人知道。
# slug 不在這張表裡也還是會被接受（只要 `meta.guide` 有填），
# 加進來的好處是「打錯字時會被抓到」。
GUIDES = {
    'tabelog100':  ('食べログ百名店', '百名店'),
    'michelin1':   ('米其林指南', '一星'),
    'michelin2':   ('米其林指南', '二星'),
    'michelin3':   ('米其林指南', '三星'),
    'michelinbib': ('米其林指南', '必比登推介'),
    'gaultmillau': ('Gault&Millau', '入選'),
    'oad':         ('OAD Top Restaurants', '入選'),
    'east50':      ("Asia's 50 Best Restaurants", '入選'),
}

GENRES = {
    'yakiniku': ('燒肉', '焼肉'),
    'sukiyaki': ('壽喜燒', 'すき焼き'),
    'italian':  ('義式料理', 'イタリアン'),
    'izakaya':  ('居酒屋', '居酒屋'),
    'ramen':    ('拉麵', 'ラーメン'),
    'sushi':    ('壽司', '寿司'),
    'soba':     ('蕎麥麵', 'そば'),
    'udon':     ('烏龍麵', 'うどん'),
    'french':   ('法式料理', 'フレンチ'),
    'tempura':  ('天婦羅', '天ぷら'),
    'tonkatsu': ('炸豬排', 'とんかつ'),
    'yakitori': ('燒鳥', '焼き鳥'),
    'curry':    ('咖哩', 'カレー'),
    'chinese':  ('中華料理', '中華料理'),
    'gyoza':    ('餃子', '餃子'),
    'hamburg':  ('漢堡排', 'ハンバーグ'),
    'bread':    ('麵包', 'パン'),
    'sweets':   ('甜點', 'スイーツ'),
    'steak':    ('牛排', 'ステーキ'),
    'bistro':   ('小酒館', 'ビストロ'),
    'teishoku': ('定食', '定食'),
    # 第 22 類（2026-08-14 為了接米其林而開）。米其林東京佔比最大的就是這一類，
    # 不收等於收了一半。色相取現有最寬的空隙（壽喜燒 252°→居酒屋 275° 的中點 264°）。
    # **刻意沒給圖示**：Tabler 沒有縮到 14px 還認得出的和食圖案，硬給會跟拉麵的碗撞，
    # 而「一個會被誤讀的圖示比沒有圖示更糟」。
    'washoku':  ('日本料理', '日本料理'),

    # 第 23 類（2026-08-14 為了接咖啡廳榜單而開）。
    # ⚠️ **色相圈到這裡已經滿了**——22 個類別平均每格 16 度、最擠 10.7 度，
    # 再插一個色相只會讓某一組更擠。故這一類改用**明度**分家：深焙咖啡棕
    # （淺色 `#513324`，比所有既有類別都暗一階），而不是硬擠一個新色相。
    # ΔE 對最近的天婦羅是 21.5，遠高於既有最擠的一組（法式 ↔ 壽喜燒 8.5）。
    # 圖示是 Tabler 的 mug（杯身＋側把手），與三種麵的碗形一眼分得開。
    'cafe':     ('咖啡廳', 'カフェ'),

    # ⚠️ **這張表刻意不是一對一的**（2026-08-13 使用者決定）。
    # slug 是「檔名用的鍵」，值是「前端顯示的類別」，兩者不必相同——
    # 披薩榜單維持自己的檔名（`2025_tabelog100_pizza_japan.json`，榜單來源才追得回去），
    # 但前端併進義式料理：同一個顏色、同一個圖示、篩選選單只出現一次、家數加總。
    # **不要把它「修正」成 ('披薩','ピザ')**——那會多出一個沒有配色的類別（靜默變灰），
    # 而且義式料理的圖示本來就是 Tabler 的 pizza 圖示，兩者在地圖上會長得一模一樣。
    # 「這是披薩榜單」這件事沒有消失，它在店卡的 awards 徽章上（來自 meta.guide）。
    'pizza':    ('義式料理', 'イタリアン'),
}

# 行內 `genre` 欄位的別名（2026-08-14）。**存在理由是不同榜單的標法不一樣**：
# `GENRES` 的日文值抄的是食べログ的寫法，米其林同一件事寫法不同，差一個字就查無。
# 少了這張表，那些筆會全部落進「類別不明」而被跳過——看起來會像程式壞了。
GENRE_ALIAS = {
    '鮨': '壽司',              # 米其林用「鮨」，食べログ用「寿司」
    'すし': '壽司',
    '焼鳥': '燒鳥',            # GENRES 存的是「焼き鳥」，差一個「き」
    'やきとり': '燒鳥',
    '割烹': '日本料理',
    '懐石': '日本料理',
    '懷石': '日本料理',
    '会席': '日本料理',
    '和食': '日本料理',
    'ピザ': '義式料理',        # 沿用既有的「披薩併進義式」規則
    '披薩': '義式料理',
    'ピッツァ': '義式料理',
    '喫茶店': '咖啡廳',        # 食べログ另有「喫茶店」百名店，與カフェ是兩份榜單但同一類
    '喫茶': '咖啡廳',
    'カフェ・喫茶': '咖啡廳',
    '珈琲': '咖啡廳',
    'コーヒー': '咖啡廳',
    '咖啡': '咖啡廳',
}

# 檔名第三段填這個＝這份榜單混了各種類別，每一行自己標（米其林就是這種）。
MIXED_GENRE = 'mixed'


def _build_genre_lookup():
    """由 `GENRES` 自動生成反查表：slug／繁中／日文三種寫法都指到同一組類別。

    **自動生成而不是手寫第二張表**——手寫的話 `GENRES` 加一行就得記得改兩個地方，
    而漏改的症狀是「填了正確類別卻被當成不認得」。
    """
    lut = {}
    for slug, (zh, ja) in GENRES.items():
        for key in (slug, zh, ja):
            lut[key.lower()] = (zh, ja)
    for alias, zh in GENRE_ALIAS.items():
        # 別名指到繁中類別名，再由上面那層查出 (zh, ja)。拼錯就在啟動時炸，不會靜默失效。
        lut[alias.lower()] = lut[zh.lower()]
    return lut


GENRE_LOOKUP = _build_genre_lookup()


def resolve_genre(value):
    """把使用者填的類別轉成 (繁中, 日文)。認不得回 None。

    三種寫法都接受（`sushi`／`壽司`／`寿司`）外加 `GENRE_ALIAS`。
    **認不得時回 None 而不是硬給一個值**：沒有對應類別＝沒有顏色也沒有圖示，
    圖釘會靜默變灰，寧可跳過該筆並列進報表（2026-08-14 使用者決定）。
    """
    v = norm_text(value).lower()
    return GENRE_LOOKUP.get(v)


# ═══ 工具 ═══════════════════════════════════════════════════════════

def fix_mojibake(s):
    """修復「UTF-8 被當成 Latin-1 讀」的亂碼。

    使用者從各種工具產出的檔案常帶這種壞法（`åæµ·é` 其實是 `北海道`）。
    壞法是可逆的：把字元當 Latin-1 編回 bytes 再用 UTF-8 解。
    **只在確定變好時才採用**——否則正常的中日文會被破壞。
    """
    if not isinstance(s, str) or not s:
        return s
    # 亂碼的特徵：出現大量 Latin-1 補充區的字元（Ã Â Ã¥ ã 等）
    if not re.search(r'[À-ÿ]{2,}', s):
        return s
    try:
        fixed = s.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s
    # 修好的字串應該含 CJK；沒有的話代表猜錯了，維持原樣。
    if re.search(r'[぀-ヿ一-鿿]', fixed):
        return fixed
    return s


def deep_fix(obj):
    if isinstance(obj, dict):
        return {k: deep_fix(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [deep_fix(v) for v in obj]
    return fix_mojibake(obj)


def meters(a, b, c, d):
    r = 6371000.0
    p1, p2 = math.radians(a), math.radians(c)
    dp, dl = math.radians(c - a), math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def norm_text(s):
    return unicodedata.normalize('NFKC', str(s or '')).strip()


# ═══ 地址解析 ═══════════════════════════════════════════════════════

PREF_RE = re.compile(r'^\s*(北海道|東京都|京都府|大阪府|.{2,3}県)')
# 郡名要先跳過再抓市區町村。少了 `(?:.{1,5}?郡)?` 這段，「神奈川県足柄下郡湯河原町」
# 要從縣名數到第 8 個字才碰到「町」，超出 {1,6} 就整個比不中 → city 空字串 →
# `area_of` 回空 → 該店被歸進「判不出地區」而**從畫面上靜默消失**（實測漏掉湯河原町、
# 富士河口湖町各一家，兩個都在涵蓋範圍的名單裡）。郡下的町村是全國常態，
# 範圍一擴大會整批中招。
# 郡那段是**選配且非貪婪**，所以「福島県郡山市」不會被誤吃（沒有第二個「郡」可收尾，
# 整組略過，仍抓到郡山市）。
CITY_RE = re.compile(
    r'(?:北海道|東京都|京都府|大阪府|.{2,3}県)\s*(?:.{1,5}?郡)?\s*(.{1,6}?[市区町村])')


def parse_address(addr):
    """從完整地址取出 (縣, 市區町村)。取不出就回空字串。"""
    a = norm_text(addr).replace('　', ' ')
    m = PREF_RE.match(a)
    pref = m.group(1) if m else ''
    m2 = CITY_RE.search(a)
    city = m2.group(1) if m2 else ''
    # 政令指定都市（横浜市西区）取到「市」為止即可
    if city.endswith('区') and pref and pref != '東京都':
        m3 = re.search(r'(.{2,4}市)', a)
        if m3:
            city = m3.group(1)
    return pref, city


def area_of(pref, city):
    """決定顯示用的地區桶。不在涵蓋範圍內回空字串（資料保留但不上地圖）。"""
    if not pref:
        return ''
    if pref == '東京都':
        if city.endswith('区'):
            return '東京23區' if city[:-1] in TOKYO_23 else ''
        return '東京多摩' if city else ''
    if pref == '神奈川県':
        if city in KANAGAWA_YOKOHAMA:
            return '橫濱'
        if city in KANAGAWA_KAWASAKI:
            return '川崎'
        if city in KANAGAWA_SHONAN:
            return '鎌倉湘南'
        if city in HAKONE_ATAMI:
            return '箱根熱海'
        return ''
    if pref in ('静岡県', '山梨県'):
        if city in HAKONE_ATAMI:
            return '箱根熱海'
        if city in FUJI:
            return '富士山周邊'
        # 2026-09-02 全日本開桶：這兩縣的其餘部分不再落空。
        # 靜岡（濱松・伊豆・掛川）→ 東海；山梨（甲府・勝沼・昇仙峽）→ 北陸甲信越。
        # ⚠️ 順序不可對調：熱海與富士五湖的判定要排在前面，否則會被整縣的規則吃掉。
        return '東海' if pref == '静岡県' else '北陸甲信越'
    return PREF_AREA.get(pref, '')


def is_closed(r):
    return '歇業' in (r.get('status') or '')


def scope_status(r):
    """判定一筆記錄會不會出現在前端：`inside`／`closed`／`outside`／`unknown`。

    **進不了 `_map.json` 有三種原因，必須分開看**（後三者的差異在「要不要處理」）：

    - `closed`：已歇業。**使用者決定不顯示在地圖上**，但資料保留（見下）。
    - `outside`：縣與市區町村都解析得出來，只是不在涵蓋範圍（大阪的店）。
      **這是正確的過濾，不必處理** —— 日後擴大範圍重跑就會出現。
    - `unknown`：地址缺失，或只寫到縣級（「東京都」）而解析不出市區町村。
      **這是資料缺陷，要人工補**。

    混在一起只印一個總數的話，你分不出「範圍外 300 家」裡有幾家其實是地址壞了
    ——又一個「壞掉但看起來正常」。這也是為什麼判準要同時要求 `pref` 與 `locality`：
    只有縣名的地址（「東京都」）算不完整，不算範圍外。

    **歇業排在最前面**：一家倒了的東京店，`area` 是有值的，不先判就會被當成 inside。
    """
    if is_closed(r):
        return 'closed'
    if r['area']:
        return 'inside'
    return 'outside' if (r['pref'] and r['locality']) else 'unknown'


def spot_of(lat, lng):
    if lat is None or lng is None:
        return OTHER_SPOT
    best, bestd = OTHER_SPOT, SPOT_R
    for name, (a, b) in SPOTS.items():
        d = meters(lat, lng, a, b) / 1000.0
        if d < bestd:
            best, bestd = name, d
    return best


# ═══ 座標驗證（国土地理院）══════════════════════════════════════════

class GeoCache:
    """地址 → 座標的快取。**沒有這個，每次跑都要重打 GSI 幾千次。**"""

    def __init__(self, path):
        self.path = path
        self.data = {}
        if os.path.exists(path):
            try:
                self.data = json.load(open(path, encoding='utf-8'))
            except Exception:
                print('[warn] 座標快取損毀，重新建立', file=sys.stderr)
        self.hits = self.misses = self.gsi_fail = 0
        # OSM 的計數與 GSI 分開。混在一起的話「GSI 查詢 N 次」那行就不再是
        # GSI 的次數了，而那行是公開摘要 grep 得到的（地雷 #19 第 2 點）。
        self.osm_hits = self.osm_calls = self.osm_skipped = self.osm_fail = 0
        # 端點各自的失敗次數。**總數看不出「是哪一個在擋我們」**——
        # 主站每次都試、鏡像只在主站失敗時才試，所以兩個數字要分開看。
        self.osm_ep_fail = {}
        self.osm_spent = 0.0

    def lookup(self, addr):
        """地址 → 座標。**查詢失敗不寫快取**，理由與 `lookup_poi` 一模一樣。

        ⚠️ 這裡曾把 `gsi_search` 的失敗當成「查無」記進快取，於是 GSI 打一次嗝
        就永久放棄那個地址——而那家店在網站上直接消失（見 `gsi_search` 的說明）。
        不寫快取的話，**下一輪本身就是重試**。
        """
        key = norm_text(addr)
        if not key:
            return None
        if key in self.data:
            self.hits += 1
            return self.data[key]
        self.misses += 1
        ok, res = gsi_search(key)
        time.sleep(1.0)          # 對 GSI 客氣一點（失敗也要等，別追著打）
        if not ok:
            # **失敗次數要進統計，不能只有 stderr 的 [warn]**：同 osm_fail 的理由。
            self.gsi_fail += 1
            return None
        self.data[key] = res
        return res

    def lookup_poi(self, name, lat, lng, addr):
        """OSM 店家位置，與地址查詢**共用同一個快取檔**（鍵加 `osm:` 前綴）。

        ⚠️ **刻意不開第二個快取檔**：公開 repo 的 workflow 是逐項 `git add` 的
        （`restaurants_src/_geocache.json` 寫死在那一行），新開一個檔就得同時改
        另一個 repo，而漏改沒有任何警訊——只會每個月重打 Overpass，
        它又常常回 busy，於是這些店的座標每月在「村子中心」與「店門口」之間跳。

        ⚠️ **查詢失敗不寫快取**（`ok=False`）：Overpass 逾時很常見，
        把它當成「這家 OSM 沒有」記下來，等於一次逾時就永久放棄這家店。
        """
        key = 'osm:%s@%.4f,%.4f' % (norm_text(name), lat, lng)
        if key in self.data:
            self.osm_hits += 1
            return self.data[key]
        if self.osm_spent >= OSM_TIME_BUDGET_S:
            self.osm_skipped += 1
            return None
        t0 = time.time()
        ok, res = osm_poi_search(name, lat, lng, addr, self.osm_ep_fail,
                                 radius=OSM_RADIUS_FOOD)
        self.osm_spent += time.time() - t0
        if not ok:
            # **失敗次數要進統計，不能只有 stderr 的 [warn]**：這條路最可能的死法
            # 就是端點把我們擋掉，而那時管線一切正常、只是永遠救不回任何一家。
            self.osm_fail += 1
            return None
        self.osm_calls += 1
        self.data[key] = res
        time.sleep(3.0)          # 對 Overpass 客氣一點（它是免費的共用服務）
        return res

    def save(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1)


WARD_ONLY_RE = re.compile(r'^.{1,4}区$')
# 番地／丁目的證據。**認「丁目」與阿拉伯數字，刻意不認漢數字**：
# GSI 的丁目級 title 一律寫成「神南一丁目」（帶著「丁目」兩個字），
# 而漢數字本身在町名裡太常見——`六本木`／`八重洲`／`二ノ平`／`三軒茶屋` 都有，
# 認了它們就會把這些「只到町名」的 title 當成有番地放行，正是這一關要擋的事。
ADDR_NUM_RE = re.compile(r'丁目|[0-9０-９]')


def title_too_coarse(title):
    """GSI 只匹配到市區町村（＝回了區公所／市公所座標）就回 True。

    **這是本管線最危險的一種壞法**：地址只寫到「東京都港区」時 GSI 照樣回 200、
    照樣給座標，統計上是「成功查到」，**錯的看起來跟對的一模一樣**（地雷 #3c 同款）。

    判準用 **GSI 回的 `title`（它實際匹配到的地址）而不是我們送進去的字串**——
    實測 `東京都千代田区一番町` 是完整的町名但以「町」結尾，猜輸入會誤殺它；
    看 title 就知道 GSI 匹配到哪一層：

        東京都渋谷区神南1-1-1 → 東京都渋谷区神南一丁目１番１号   番地級，準
        東京都渋谷区神南1     → 東京都渋谷区神南一丁目           丁目級，100〜300m，可接受
        東京都港区            → 東京都港区                       **市區町村級，km 級誤差**

    三種要抓：①title 剛好等於「縣＋市區町村」②政令指定都市只到區
    （`神奈川県横浜市西区`，`parse_address` 會把 city 取到「横浜市」，故殘餘是「西区」）
    ③**只到大字／町名**（`神奈川県足柄下郡箱根町仙石原`），殘餘非空但沒有任何番地。
    """
    t = norm_text(title)
    if not t:
        return False
    pref, city = parse_address(t)
    if not pref or not city:
        return False
    rest = t[len(pref):].lstrip()
    # **切到市區町村之後要用 find 不能用 startswith**：郡下的町村，縣名與町名之間
    # 還隔著郡名（`和歌山県西牟婁郡白浜町`），startswith 比不中就整段留著，
    # 於是「只到町級」的 title 被當成有番地 → 標成 precise，正是這個函式要擋的事。
    i = rest.find(city)
    rest = rest[i + len(city):].lstrip() if i >= 0 else rest
    if not rest or WARD_ONLY_RE.match(rest):
        return True
    # ③ **大字／町名級**：切完之後連一個番地的證據都沒有（`仙石原`／`馬渡`／`六本木`）。
    # 舊版只看「還剩不剩字」，而大字名剛好會剩字，於是 km 級誤差被標成 precise，
    # 報表上顯示「全部 precise、零待查」——實測 POLA 美術館差 1.6km、
    # 國營常陸海濱公園差 2.1km，**錯的看起來跟對的一模一樣**（同上面那條的老問題）。
    return not ADDR_NUM_RE.search(rest)


# 括號整段先剝掉再抽番地。米其林的清單把註記塞在番地前面
# （`恵比寿(次のビルを除く)2-23-3`、`八重洲(2丁目)2-2-1`），
# 而括號裡實測從來沒有番地（全站 3290 個地址，0 筆）。
PAREN_RE = re.compile(r'[（(][^）)]*[）)]')
# 番地：`2-23-3`／`9-7-1`。連字號有四種寫法（NFKC 只會把全形減號轉成半形，
# 長音符與數學減號都留著），所以比對時全收、輸出時統一成半形。
BANCHI_HYPHEN_RE = re.compile(r'\d+[-−ー―]\d+(?:[-−ー―]\d+)?')
BANCHI_PLAIN_RE = re.compile(r'\d+')
# 緊接著 F／階 的數字是**樓層不是番地**（`3-4F`、`2階`）。
FLOOR_TAIL_RE = re.compile(r'^[Ff階]')


def banchi_of(addr):
    """從地址抽出番地（`9-7-1`）。抽不出、或抽出來沒把握就回空字串。

    ⚠️ **有 `x-y` 但全被判成樓層時直接放棄，不可退回「第一個純數字」**。
    退回的話 `赤坂ビル3-4F` 會抽出 `3`，組成 `東京都港区赤坂3`，
    GSI 回「赤坂三丁目」——**丁目級會通過 `title_too_coarse`**，
    於是一個猜出來的位置被標成 `precise`，正是本管線最怕的「自信的錯誤」。
    現有資料 0 筆屬於這種，但新清單隨時會來。
    """
    a = PAREN_RE.sub('', norm_text(addr))
    hits = [m for m in BANCHI_HYPHEN_RE.finditer(a)
            if not FLOOR_TAIL_RE.match(a[m.end():m.end() + 1])]
    if hits:
        return re.sub(r'[-−ー―]', '-', hits[0].group(0))
    if BANCHI_HYPHEN_RE.search(a):
        return ''
    m = BANCHI_PLAIN_RE.search(a)
    if m and not FLOOR_TAIL_RE.match(a[m.end():m.end() + 1]):
        return m.group(0)
    return ''


def refine_query(addr, coarse_title):
    """GSI 只匹配到町名時，用「它回的 title ＋ 原地址的番地」組一個新查詢。

    **關鍵是 title 本身就是 GSI 正規化過的町名**（`東京都港区赤坂`），
    所以不必去猜怎麼剝括號、怎麼砍夾在中間的大樓名——那是猜不完的
    （`赤坂ミッドタウン・タワー(45階)9-7-1`、`虎ノ門虎ノ門ヒルズステーションタワー(49階)2-6-2`），
    把雜訊整個丟掉、只留町名與番地反而穩。實測東京 27 家全部由 approx 救回 precise。

    組出來與原地址相同時回空字串（那只是白打一次 GSI，鄉下的
    `千葉県君津市大戸見296` 就是這種）。
    """
    t = norm_text(coarse_title)
    b = banchi_of(addr)
    if not t or not b:
        return ''
    cand = t + b
    return '' if cand == norm_text(addr) else cand


# 京都的「通り名」地址：`<某>通<某><方位>入ル` 夾在「区」與「町名」之間，
# 例如 `京都府京都市下京区木津屋橋通烏丸西入ル東塩小路町579`。
# **GSI 整串解析不下去、直接回查無**，所以連 refine_query 都沒得重組
# （它要拿 GSI 回的 title，而這裡根本沒有 title）。
_KYOTO_WARD_RE = re.compile(r'市[^\s]*?区')
_KYOTO_STREET_RE = re.compile(r'(?:通り?).*?(?:[東西南北]入[ルる]?|[上下][ルる]?(?=[^\sルる]))')


def strip_kyoto_street(addr):
    """剝掉京都的通り名那一段，回傳新的查詢地址；不適用時回空字串。

    `京都府京都市下京区木津屋橋通烏丸西入ル東塩小路町579`
        → `京都府京都市下京区東塩小路町579`

    與 `refine_query` 是同一種做法：**把雜訊整段丟掉，不是猜怎麼剝**。
    文法很規則（`通` ＋ `[東西南北]入[ルる]?` 或 `[上下][ルる]`），
    所以不必像大樓名那樣一種一種試。

    ⚠️⚠️ **呼叫端必須「原地址查無時才用它」，不可以無條件改寫。**
    實測京都 494 家店裡，**已經查得到的有 56 家也符合這條規則**，
    而其中像 `東大路通丸太町上ル東側聖護院西町12` 剝完會留下半截的「東側」。
    當後備才保證那批一個位元組都不動——同「排在原名之後」那條原則。

    ⚠️ **絕不可以改寫 `r['address']` 本身**：`id` 是 `md5(店名|地址)`，
    動了地址等於全站 id 一次全變、使用者的收藏與分享連結一起失效。
    這裡回的只是「拿去查的字串」。
    """
    if '京都市' not in addr:
        return ''
    m = _KYOTO_WARD_RE.search(addr)
    if not m:
        return ''
    head, tail = addr[:m.end()], addr[m.end():]
    m2 = _KYOTO_STREET_RE.match(tail) or _KYOTO_STREET_RE.search(tail)
    # 通り名一定緊接在「区」後面。離太遠代表比對到的是大樓名裡的字，不可剝。
    if not m2 or m2.start() > 6:
        return ''
    cand = head + tail[m2.end():]
    return '' if cand == addr else cand


def gsi_search(addr):
    """国土地理院地址搜尋。回 `(查詢成功?, {'lat':…, 'lng':…, 'title':…} 或 None)`。

    §3c 的教訓：**只餵完整地址，絕不餵店名**——它是純地址搜尋，
    給店名會拆字比對地名，回「自信的錯誤」。

    ⚠️ **查詢失敗與「這個地址查無」必須分開回**，與 `osm_poi_search` 同一條規則。
    先前兩者都回 `None`，而 `GeoCache.lookup` 拿到什麼就寫進快取，於是
    **GSI 打一次嗝就把那個地址永久判死**——快取裡再也不會重試。
    實測踩到一次：`シグネチャー`（マンダリン オリエンタル 東京 37F）被記成查無，
    而同一棟大樓另外四種地址寫法都查得到、事後重打也立刻回番地級座標。
    症狀是**那家店在網站上完全不見**（`geo` 為 None 就畫不出圖釘），
    而統計與報表都顯示一切正常。
    """
    try:
        req = urllib.request.Request(GSI_URL + urllib.parse.quote(addr),
                                     headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            js = json.load(r)
    except Exception as e:
        print('[warn] GSI 失敗 %s：%s' % (addr[:20], e), file=sys.stderr)
        return False, None
    if not js:
        return True, None                      # 真的查無，記進快取免得每輪重打
    top = js[0]
    lng, lat = top['geometry']['coordinates']
    return True, {'lat': lat, 'lng': lng,
                  'title': top['properties'].get('title', '')}


# ── OSM 店家位置（GSI 只到大字時的最後一手）────────────────────────

# 關鍵字裡有正規表達式的特殊字元就整個不查（Overpass 的 `~` 是 regex 比對）。
# 寧可不查也不要送出一個會被當成萬用字元的關鍵字。
OSM_KEY_SAFE_RE = re.compile(r'^[^\\"\'.*+?\[\]()|^$~{}]+$')
# 分店名的尾巴。⚠️ **`商店`／`酒店`／`飯店` 刻意不算**——那是品牌本體的一部分
# （`甘味や 澤田商店` 的品牌就是「澤田商店」），砍掉會把關鍵字換成更泛用的那一段。
BRANCH_SEG_RE = re.compile(r'(?<!商)(?<!酒)(?<!飯)(本店|支店|売店|本館|別館|新館|店)$')
LATIN_ONLY_RE = re.compile(r'^[A-Za-z0-9 &\-]+$')


# 泛用到不能拿來當關鍵字的段。**取最長的一段時要先把這些拿掉**——
# 實測 `オトワ レストラン` 最長的一段是「レストラン」，拿它去查等於在
# 5km 內找「所有餐廳」，而名稱比對又會因為五個字重疊而放行（0.71）。
# 與 fetch_events.py 的 VAGUE_SEGMENTS 是同一條原則，且同樣**完全比對**。
OSM_GENERIC_SEG = {
    'レストラン', 'restaurant', 'カフェ', 'cafe', 'ダイニング', 'dining',
    'ビストロ', 'bistro', 'キッチン', 'kitchen', 'ベーカリー', 'bakery',
    '食堂', '本店', '支店', '別館', '本館', '店', '亭', '屋', '館',
    'グリル', 'grill', 'バー', 'bar', 'テラス', 'terrace',
}


def is_branch_seg(seg):
    """這一段是不是「分店名」（`祇園本店`／`新千歳空港店`／`横浜中華街新館売店`）。

    ⚠️ **`OSM_GENERIC_SEG` 擋不掉這一類**：它是完全比對，擋得掉光禿禿的
    「本店」，擋不掉「祇園本店」。而分店名幾乎一定比品牌長
    （`祇園本店` 4 字 > `泉門天` 3 字），於是「取最長的一段」會**穩定地取到
    分店名**——那等於在 5km 內找「所有叫〜祇園本店的店」。
    實測 `泉門天 祇園本店`（餃子）因此配到 `焼肉の名門 天壇 祇園本店`、
    `松之助 京都本店`（咖啡廳）配到 `麺匠 たか松 京都本店`。
    全站 5091 個店名裡有 229 個的關鍵字落在這種尾巴上。

    ⚠️ **尾巴剝掉之後必須還剩東西**：`丸正餃子店` 整段就是品牌，
    剝掉「店」剩「丸正餃子」非空 → 會被判成分店名，所以呼叫端還有一道
    「至少要留下一段」的保護（見 `osm_query_key`）。
    """
    m = BRANCH_SEG_RE.search(seg)
    return bool(m) and bool(seg[:m.start()])


def osm_query_key(name):
    """從店名取出要拿去 Overpass 比對的關鍵字，取不出就回空字串（＝不查）。

    **取最長的那一段**（以空白切）。理由是店名常是「品牌＋分店」，
    而 OSM 收的名稱與我們的寫法不會一模一樣——實測
    `阿左美冷蔵 寶登山道店` 在 OSM 叫 `天然氷蔵元 阿左美冷蔵 寶登山道店`、
    `村のピザ屋 カンパーニャ` 少一個空白、`人舟` 後面多了 `(いせん)`。
    整串比對一個都對不上，取最長的一段才穩。

    ⚠️ **太短的關鍵字一律不查**：實測拿「青 AO」的「青」去查，
    撈回 3.5km 外的「青松学園」。日文 2 字、英文 3 字是下限。

    **兩道修正（2026-08-29）**，兩道都只在「原本會取到錯東西」時才作用：

    1. **分店名不當關鍵字**（`is_branch_seg`），但**至少要留下一段**——
       `丸正餃子店 本店` 兩段都像分店名，全丟就沒得查了，那時維持原樣。
    2. **長度相同時取後面那段**。日文店名多半是「類別＋品牌」
       （`麺屋 桐龍`／`富小路 やま岸`／`高台寺 和久傳`），而**品牌在後面**；
       前面那截常是料理類別、通り名或地名，拿去查等於在找「這一帶所有的〜」。
       ⚠️ 實測 `ブルー ファー ツリー` 三段都是 3 個字，取前面的 `ブルー`
       會配到 3.1km 外的 `ブルーデル`，取 `ツリー` 則查無（正確的失敗）。
    """
    segs = [x for x in re.split(r'[ 　]+', norm_text(name)) if x]
    if not segs:
        return ''
    segs = [x for x in segs if x.lower() not in OSM_GENERIC_SEG]
    if not segs:
        return ''
    rest = [x for x in segs if not is_branch_seg(x)]
    # ⚠️ **平手時取前或取後，要跟著上面那道分支走，不可以一律取後**：
    # 丟得掉分店名時，剩下的是「類別＋品牌」→ **品牌在後**（`麺屋 桐龍` 取 `桐龍`）；
    # 丟不掉時（`丸正餃子店 第2阪奈店` 兩段都像分店名），那就是「品牌＋分店」
    # → **品牌在前**。一律取後的話這一筆會取到 `第2阪奈店`，比改動前更差。
    if rest:                                   # **至少留一段**，全是分店名就維持原樣
        key = max(reversed(rest), key=len)
    else:
        key = max(segs, key=len)
    if not OSM_KEY_SAFE_RE.match(key):
        return ''
    if LATIN_ONLY_RE.match(key):
        return key if len(key.replace(' ', '')) >= 3 else ''
    return key if len(key) >= 2 else ''


def name_close(a, b):
    """兩個店名像不像。**必須一方完整包含另一方**（去掉空白與中黑點之後）。

    這道就是擋「青 AO → 青松学園」的那一道。

    ⚠️ **2026-08-29：拿掉了「字元重疊率 ≥ OSM_MATCH_MIN」那條後路。**
    理由不是理論而是實測——既有 21 筆配對裡，靠重疊率（而非包含）過關的**只有
    三筆，而且三筆全是錯的**：`泉門天 祇園本店`→`焼肉の名門 天壇 祇園本店`（0.86）、
    `松之助 京都本店`→`麺匠 たか松 京都本店`（0.71）、
    `ブルー ファー ツリー`→`ブルーデル`（0.75）。**正確的 15 筆全部是包含關係。**
    重疊率在這條路上沒有救回任何一家，只放行了誤配。

    ⚠️ 它同時擋掉**同品牌不同分店**（`高台寺 和久傳` → 1.3km 外的 `室町和久傳`）
    與**同姓不同店**（`Nishijin Hashimoto` → `Hashimoto Coffee`）：兩邊各自
    有對方沒有的字，就不是同一家。**這比「料理類別 ↔ OSM 業態對照表」更早生效
    也更便宜**——後者對前一種完全無效（同品牌業態一樣）。

    ⚠️ **中黑點一定要一起正規化掉**，同 `same_place()` 的店名正規化：
    OSM 寫 `パティスリー　サロン・ド・テ　エム・エス・アッシュ`、我們寫
    `サロン ド テ エム エス アッシュ`，不去掉 `・` 就變成互不包含 → **誤殺一筆正確的**。

    ⚠️ **2026-08-29：我方被對方完整包含時，接合點必須落在「詞界」。**
    這道是為了擋 `いとう` → `京都洋食　ムッシュいとう`（686m 外的另一家店）。
    ⚠️ **刻意不做「料理類別 ↔ OSM 業態」對照表**：這一筆兩邊都是餐廳，業態擋不住；
    真正在說話的訊號是**我方的名字黏在對方另一個品牌詞的尾巴上**——
    `いとう` 前面接的是 `ュ`（`ムッシュ` 的一部分），而所有正確的配對，
    我方的名字要嘛從對方的開頭起算，要嘛前面就是一個分隔符：

        江畑          ⊂ 焼肉　江畑                   前面是全形空白  ✅
        阿左美冷蔵…     ⊂ 天然氷蔵元 阿左美冷蔵 寶登山道店   前面是空白    ✅
        人舟          ⊂ 人舟 (いせん)                從開頭起算    ✅
        サロン ド テ…   ⊂ パティスリー　サロン・ド・テ…       前面是全形空白  ✅
        いとう         ⊂ 京都洋食　ムッシュいとう          前面是「ュ」   ❌

    **實測既有 18 筆補位，17 筆照過、只擋掉 `いとう` 那一筆。**
    ⚠️ 誤殺的方向是安全的（退回 `approx`＝半透明＋「概略位置」），
    而放行的方向是一顆實心圖釘掛在別家店上。

    ⚠️ **另一個方向（對方比較短、我方包含對方）刻意不套這道**：那是
    `マリベル 京都本店` ⊃ `マリベル`、`三嶋亭 本店` ⊃ `三嶋亭` 這種
    「OSM 沒記分店名」的正常情況（同地雷 #3d 池袋ロフト 那條）。
    """
    x = NAME_SEP_RE.sub('', norm_text(a)).lower()
    yraw = norm_text(b)
    y = NAME_SEP_RE.sub('', yraw).lower()
    if not x or not y:
        return False
    if y in x:                       # 對方比較短：OSM 常常沒記分店名，照舊放行
        return True
    return _contained_at_boundary(x, yraw)


def _contained_at_boundary(x, yraw):
    """`x`（已去分隔符、小寫）是否出現在 `yraw` 裡，且起點落在詞界。

    詞界＝對方名稱的開頭，或前一個字元是分隔符（空白／全形空白／中黑點）。
    ⚠️ **要在「原字串」上判，不可以在去掉分隔符之後判**——分隔符正是唯一的證據，
    先拿掉就什麼都不剩了。故一邊去分隔符一邊記下每個字元在原字串裡的位置。
    """
    flat, idx = [], []
    for i, ch in enumerate(yraw):
        if NAME_SEP_RE.match(ch):
            continue
        flat.append(ch.lower())
        idx.append(i)
    pos = ''.join(flat).find(x)
    if pos < 0:
        return False
    if pos == 0:
        return True
    return bool(NAME_SEP_RE.match(yraw[idx[pos] - 1]))


def osm_addr_conflict(tags, addr):
    """OSM 自己標的市區町村與我們的地址明顯矛盾就回 True（＝剔除這個候選）。

    只在 OSM 真的有標、而且標的是日文時才判。**沒標就不表態**——
    鄉下的 POI 多半沒有 addr 標籤，要求必須有等於這條路整個作廢。
    """
    a = norm_text(addr)
    for k in OSM_ADDR_KEYS:
        v = norm_text(tags.get(k, ''))
        if v and not LATIN_ONLY_RE.match(v) and v not in a:
            return True
    return False


def osm_is_food(tags):
    """這個 POI 是不是「吃的」。`osm_pick` 的預設守門。"""
    return (tags.get('amenity') in OSM_AMENITY
            or tags.get('shop') in OSM_SHOP)


def osm_poi_search(name, lat, lng, addr, ep_fail=None, accept=None, radius=None):
    """用「店名＋地理範圍」問 Overpass 有沒有這家店。

    回 `(查詢成功?, 結果或 None)`。**查詢失敗與查無結果必須分開**：
    Overpass 動不動就回「server too busy」（實測四次有兩次），
    把那種情況當成「這家店 OSM 沒有」寫進快取，等於一次逾時就永久放棄。

    ⚠️ 這是**資料庫查詢**不是地址解析（地雷 #3d）。Nominatim／Photon 對這些
    鄉下地址全部查無，而同一批資料用 Overpass 掃就在裡面。

    `accept(tags)` 是**「這個 POI 算不算數」那道守門**，不傳就用餐飲那把
    （`osm_is_food`）。⚠️ **它是參數而不是寫死的，因為 `build_places.py` 也走這條路**
    ——景點要找的是神社、洞窟、瀑布、動物園，用餐飲的白名單一個都過不了。
    **不要為此把整支複製一份到那邊**：網路、快取、五道守門的邏輯只該有一份
    （同 `parse_address`／`area_of` 共用的理由）。

    `ep_fail` 是**每個端點各自的失敗次數**（可選，傳一個 dict 進來累加）。
    ⚠️ 它存在的理由是「主站被擋」這件事在舊版**完全看不見**：兩個端點的錯誤
    共用一個變數、後者覆寫前者，於是日誌上永遠只出現最後那個端點。
    實測 `overpass-api.de` 會直接把 TLS 握手丟掉（連 `/api/status` 都不通），
    同時鏡像回 502——**那是被擋不是故障**，而這支每月跑在 GitHub Actions
    的共用 IP 上，被擋的機率不低。
    """
    key = osm_query_key(name)
    if not key:
        return True, None                      # 名字太短：算查過了，不必每次重試
    # ⚠️ **半徑是可傳入的，理由同 `accept`**：景點那支走同一個函式，而它救回的
    # 富岳風穴位移 3,823m——用餐廳那把 2.5km 的尺會把它靜默弄丟（退回 approx）。
    radius = radius or OSM_RADIUS_M
    dlat = radius / 111000.0
    dlng = radius / (111000.0 * max(0.3, math.cos(math.radians(lat))))
    bb = '%.5f,%.5f,%.5f,%.5f' % (lat - dlat, lng - dlng, lat + dlat, lng + dlng)
    q = ('[out:json][timeout:30];('
         'node["name"~"%s",i](%s);way["name"~"%s",i](%s););out center tags;'
         % (key, bb, key, bb))
    body = urllib.parse.urlencode({'data': q}).encode('utf-8')
    js, errs = None, []
    # **每個端點只試一次，不在這裡重試**。兩邊都是免費的共用服務，實測
    # 500／502／逾時都很常見，原地重試只是把時間拖長；而失敗不寫快取，
    # **下個月那一輪本身就是重試**——這家店這個月維持概略位置，下個月再救。
    for url in OVERPASS_URLS:
        host = url.split('/')[2]
        try:
            req = urllib.request.Request(url, data=body,
                                         headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                js = json.load(r)
            break
        except Exception as e:
            errs.append((host, e))
            if ep_fail is not None:
                ep_fail[host] = ep_fail.get(host, 0) + 1
    # ⚠️ **每個端點各印一行，而且「後面那個成功了」也照印。**
    # 舊版只留最後一個端點的錯誤（`last` 被覆寫），於是主站被擋時日誌上
    # **只看得到鏡像的錯**，而「主站是不是把我們擋了」正是這條路最可能的死法。
    for host, e in errs:
        print('[warn] Overpass 失敗 %s（%s）：%s' % (key[:12], host, e),
              file=sys.stderr)
    if js is None:
        return False, None
    return True, osm_pick(js, name, lat, lng, addr, accept, radius)


def osm_pick(js, name, lat, lng, addr, accept=None, radius=None):
    """從 Overpass 的回應裡挑出唯一可信的那一個，挑不出就回 None。

    **五道守門在這裡，而這個函式不碰網路**（可離線測）：
    **`accept` 認可的 POI** → 名稱對得上 → OSM 的市區町村不矛盾 → 真的在半徑內
    → 剛好一個。第一道預設是「餐飲類」，景點那支傳自己的小類白名單進來。
    """
    accept = accept or osm_is_food
    radius = radius or OSM_RADIUS_M
    cands = []
    for e in (js or {}).get('elements', []):
        t = e.get('tags', {})
        la = e.get('lat', e.get('center', {}).get('lat'))
        lo = e.get('lon', e.get('center', {}).get('lon'))
        if la is None or lo is None:
            continue
        if not accept(t):
            continue                            # 不是我們要找的那一類 POI
        if not name_close(name, t.get('name', '')):
            continue
        if osm_addr_conflict(t, addr):
            continue
        d = meters(lat, lng, la, lo)
        if d > radius:
            continue                            # bbox 是方的，這裡才是真的半徑
        cands.append({'lat': la, 'lng': lo, 'name': t.get('name', ''),
                      'dist': round(d)})
    # **OSM 常把同一家店同時畫成一個點與一棟建築**（node ＋ way），那是同一個地方
    # 的兩筆資料、不是兩家店。擠在 50m 內就當成一個，否則這種店會被下面那條
    # 「剛好一個」白白放棄——而它是很常見的畫法。
    if len(cands) > 1 and all(meters(cands[0]['lat'], cands[0]['lng'],
                                     c['lat'], c['lng']) <= 50 for c in cands[1:]):
        cands = cands[:1]
    # ⚠️ **剛好一個才採用**（同 build_photos.py 的 GPS 配對）。兩個以上時
    # 自動挑最近的那個有一半機率掛錯，而掛錯在地圖上跟正確的長得一模一樣。
    return cands[0] if len(cands) == 1 else None


# ═══ 欄位正規化 ════════════════════════════════════════════════════

# 來源檔可能是「原始形狀」（current_name/latitude…）或「已正規化」（name_ja/lat…）。
# 兩種都吃，靠欄位名判斷。
RAW_KEYS = ('current_name', 'official_name_2025', 'latitude', 'current_address')


def is_raw(row):
    return any(k in row for k in RAW_KEYS)


def split_budget(raw):
    parts = [p.strip() for p in str(raw or '').split('/')]
    dinner = parts[0] if parts else ''
    lunch = parts[1] if len(parts) > 1 else ''
    blank = {'-', '', '—'}
    return ('' if dinner in blank else dinner, '' if lunch in blank else lunch)


def clean_hours(raw, holiday):
    """整理營業時間，並把混在裡面的定休日抽出來。

    來源常帶「■ 営業時間 …■ 定休日 …」的版面標記，公休資訊重複塞在營業時間欄裡。
    **內嵌的那份有時比 regular_holiday 欄更詳細**，所以取較完整的當公休日。
    """
    s = re.sub(r'\s+', ' ', str(raw or '')).strip()
    h = re.sub(r'\s+', ' ', str(holiday or '')).strip()
    m = re.search(r'■\s*定休日\s*(.*)$', s)
    if m:
        embedded = m.group(1).strip()
        s = s[:m.start()].strip()
        if len(embedded) > len(h):
            h = embedded
    s = re.sub(r'■\s*営業時間\s*', '', s)
    s = re.sub(r'^[■●・\s]+', '', s).strip()
    if h in ('未另行標示', '未如實標示'):
        h = ''
    if s in ('未另行標示', '未如實標示'):
        s = ''
    return s, h


def parse_filename(name):
    """從檔名 <年>_<榜單>_<類別>_<地區>.json 取出四段。

    **榜單 slug 直接代表「榜單＋等級」的組合**（`tabelog100`／`michelinbib`／`michelin1`），
    這樣一個檔＝一個等級，不必逐店標 tier——米其林同一年有一星／二星／必比登，
    若 slug 只寫 `michelin`，等級就只能逐店填一百次。

    回 (year, guide_slug, genre, scope)，任一段不合就回四個 None。
    """
    base = os.path.basename(name)
    m = re.match(r'^(\d{4})_([a-z0-9]+)_([a-z]+)_([a-z]+)\.json$', base)
    if not m:
        return None, None, None, None
    return int(m.group(1)), m.group(2), m.group(3), m.group(4)


def looks_like_old_filename(name):
    """舊的三段式檔名（<年>_<類別>_<地區>）。用來給出明確錯誤而不是靜默跳過。"""
    return bool(re.match(r'^(\d{4})_([a-z]+)_([a-z]+)\.json$', os.path.basename(name)))


def guide_meta(meta, guide_slug, year):
    """決定這份榜單的 guide／tier／url／checked_at。

    **檔內的 `meta` 是權威**，`GUIDES` 只是後備與驗證用——
    使用者手上的榜單名稱與官方頁網址，程式沒有辦法自己知道。
    """
    m = meta or {}
    fb_name, fb_tier = GUIDES.get(guide_slug, ('', ''))
    return {
        'guide': norm_text(m.get('guide')) or fb_name or guide_slug,
        'tier': norm_text(m.get('tier')) or fb_tier,
        'year': int(m.get('year') or year),
        'url': norm_text(m.get('url')),
        'checked_at': norm_text(m.get('checked_at')),
    }


def normalize(row, year, genre_key, scope, gmeta):
    """把一筆原始資料轉成統一 schema。類別認不得時回 None（由呼叫端跳過並列進報表）。"""
    # **行內的 `genre` 優先於檔名**（2026-08-14）。兩個理由缺一不可：
    # ①米其林不是按類別發榜的，一份榜單裡混著壽司、法式、日本料理
    # ②**輸出檔會被 `load_sources()` 當輸入重讀**，這裡若照舊只看檔名，
    #   使用者標好的類別重跑一次就被檔名蓋掉——與 `status` 曾被寫死成「營業中」
    #   是同一個坑（見 CLAUDE.md 餐廳段）。
    row_genre = row.get('genre')
    if norm_text(row_genre):
        pair = resolve_genre(row_genre)
        if not pair:
            return None
        zh, ja = pair
    elif genre_key == MIXED_GENRE:
        return None            # mixed 檔的每一行都必須自己標
    else:
        zh, ja = GENRES.get(genre_key, (genre_key, genre_key))

    if is_raw(row):
        name = norm_text(row.get('current_name') or row.get('official_name_2025'))
        addr = norm_text(row.get('current_address'))
        lat, lng = row.get('latitude'), row.get('longitude')
        dinner, lunch = split_budget(row.get('price_range'))
        hours, holiday = clean_hours(row.get('business_hours'), row.get('regular_holiday'))
        note = norm_text(row.get('last_order_or_booking_note'))
        if note in ('未另行標示', '未如實標示'):
            note = ''
        status = norm_text(row.get('operating_status'))
        checked = norm_text(row.get('verified_at') or row.get('status_checked_at'))
        src = norm_text(row.get('source_2_url') or row.get('source_1_url'))
        award_url = norm_text(row.get('award_source_url'))
        img = img_page = img_kind = ''
    else:
        name = norm_text(row.get('name_ja'))
        addr = norm_text(row.get('address'))
        lat, lng = row.get('lat'), row.get('lng')
        dinner, lunch = row.get('budget', ''), row.get('budget_lunch', '')
        hours, holiday = row.get('hours', ''), row.get('holiday', '')
        note = row.get('hours_note', '')
        # ⚠️ **一定要讀 row 的 status，不可寫死**（2026-08-13 修）。兩個理由：
        # ① 使用者照範本填的清單走這條路，寫死等於「標了歇業卻被靜默忽略」；
        # ② 輸出檔會被 load_sources() 當輸入重新讀進來，寫死的話一家已歇業的店
        #    下次重跑就會復活成營業中——round trip 不可失真。
        status = norm_text(row.get('status')) or '營業中'
        checked = norm_text(row.get('checked_at'))
        src = norm_text(row.get('source_url'))
        # 既有輸出檔重新讀進來時，awards 已經在裡面；meta 沒給 url 就沿用它，
        # 免得改版後既有兩份榜單的官方連結憑空消失。
        aw = row.get('awards') or [{}]
        award_url = aw[0].get('url', '') if aw else ''
        img = row.get('img', '') or ''
        img_page = row.get('img_page', '') or ''
        img_kind = row.get('img_kind', '') or ''

    lat = float(lat) if isinstance(lat, (int, float)) else None
    lng = float(lng) if isinstance(lng, (int, float)) else None
    pref, city = parse_address(addr)

    return {
        'id': hashlib.md5((name + '|' + addr).encode('utf-8')).hexdigest()[:12],
        'name_ja': name,
        'genre': zh, 'genre_ja': ja,
        'budget': dinner, 'budget_lunch': lunch,
        'pref': pref, 'locality': city,
        'area': area_of(pref, city),
        'spot': '',                       # 驗完座標才算
        'address': addr,
        'lat': lat, 'lng': lng,
        'geo': None, 'geo_note': '',
        'status': status,
        'hours': hours, 'hours_note': note, 'holiday': holiday,
        'img': img, 'img_page': img_page, 'img_kind': img_kind,
        'source_url': src,
        'checked_at': checked or gmeta['checked_at'],
        'build_v': BUILD_VERSION,
        'awards': [{'guide': gmeta['guide'], 'year': gmeta['year'],
                    'tier': gmeta['tier'],
                    'url': gmeta['url'] or award_url}],
    }


# ═══ 主流程 ════════════════════════════════════════════════════════

def load_sources():
    """讀 restaurants_src/ 與既有的正規化檔。

    回 [(year, guide_slug, genre, scope, gmeta, rows, fn)]。
    `_` 開頭的檔一律跳過——`_template.json` 與 `_geocache.json` 都靠這條保護。

    ⚠️ **同名檔案在兩個資料夾都存在時，只讀 `restaurants_src/` 那份**（2026-08-13 加）。
    第一次建置完成後，來源檔與產出檔會同時存在，不擋的話同一份榜單會被讀兩次——
    實測「讀入 4 個清單檔、共 398 家」、`files[]` 出現重複項、`index.json` 把同一份列兩次。
    （前端不會壞，`home.setdefault` 讓每筆的 `f` 仍指向正確的檔，但統計與稽核檔是錯的。）

    **為什麼是來源檔贏而不是產出檔贏**：來源檔才是使用者會編輯的那一份。
    反過來的話，去修地址、標歇業、刪掉一家店**全部都不會生效**，而且沒有任何訊息
    ——那比重複讀取嚴重得多。產出檔沒有來源檔缺的東西：座標在 `_geocache.json`
    （以完整地址當鍵）、`id` 是 `md5(店名|地址)` 算得出來、`meta` 與 awards 來源檔也有。
    來源檔被刪掉（既有兩份榜單的情況）時照舊讀產出檔，round trip 的保留機制不受影響。

    ⚠️ **日後若管線開始補來源檔沒有的欄位**（例如 YOLP 抓到的照片與營業時間），
    這條規則要重新檢討——屆時產出檔會有來源檔沒有的資料，直接跳過就會弄丟。
    """
    out = []
    seen = set()
    for d in (SRC, DIR):
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith('.json') or fn.startswith('_') or fn == 'index.json':
                continue
            if fn in seen:
                print('[info] %s 在 restaurants_src/ 與 restaurants/ 都有，'
                      '以 restaurants_src/ 那份為準（那才是你會編輯的檔）' % fn, file=sys.stderr)
                continue
            path = os.path.join(d, fn)
            year, guide, genre, scope = parse_filename(fn)
            if not genre:
                if looks_like_old_filename(fn):
                    # 明確講清楚缺什麼。靜默跳過的話，使用者會以為資料放進去了
                    # 卻在地圖上找不到店——又一個「壞掉但看起來正常」。
                    print('[skip] %s 是舊的三段式檔名，要補上榜單那一段：'
                          '<年>_<榜單>_<類別>_<地區>.json，例如 2025_tabelog100_italian_tokyo.json'
                          % fn, file=sys.stderr)
                else:
                    print('[skip] 檔名不符 <年>_<榜單>_<類別>_<地區>.json：%s' % fn, file=sys.stderr)
                continue
            # `mixed` 是保留字：這份榜單混了各種類別，每一行自己標（米其林就是這種）。
            if genre != MIXED_GENRE and genre not in GENRES:
                print('[skip] 未知類別「%s」，請先加進 GENRES：%s' % (genre, fn), file=sys.stderr)
                continue
            try:
                raw = json.load(open(path, encoding='utf-8'))
            except Exception as e:
                print('[skip] 讀不了 %s：%s' % (fn, e), file=sys.stderr)
                continue
            raw = deep_fix(raw)
            rows = raw if isinstance(raw, list) else raw.get('restaurants', [])
            meta = raw.get('meta') if isinstance(raw, dict) else None
            gmeta = guide_meta(meta, guide, year)
            if guide not in GUIDES and not (meta or {}).get('guide'):
                print('[warn] 榜單「%s」不在 GUIDES 裡、檔內也沒有 meta.guide，'
                      '將直接用 slug 當榜單名稱：%s' % (guide, fn), file=sys.stderr)
            seen.add(fn)
            out.append((year, guide, genre, scope, gmeta, rows, fn))
    return out


def verify_coords(recs, cache, recheck):
    """用 GSI 由地址重算座標，與來源座標比對。

    這是整條管線最重要的一步：來源座標實測有 12% 與別筆共用（同一個 POI 被
    套到多家店），最遠錯 957km，而且每一筆都自稱驗證過。**不重驗就等於相信它。**
    """
    # 'filled'（來源沒附座標，由地址查到）與 'fixed'（來源座標偏移過大，已改寫）
    # **必須分開計**。兩者都是「把 GSI 的座標寫進去」，但意義相反：前者是正常流程，
    # 後者是抓到一筆錯資料。範本明講只要「店名＋地址」，所以每份新清單都會 100%
    # 落進 filled——先前混在 fixed 裡印成「已修正（偏移過大）」，數字被灌爆之後
    # 就再也看不出真的有偏移的那幾筆（咖哩那份一次 +100，實際偏移 0 筆）。
    stats = {'ok': 0, 'filled': 0, 'fixed': 0, 'suspect': 0,
             'nogeo': 0, 'reused': 0, 'coarse': 0, 'refined': 0, 'osm': 0,
             'kyoto': 0}
    for r in recs:
        if not recheck and r.get('geo') == 'precise' and r.get('build_v') == BUILD_VERSION:
            stats['reused'] += 1
            continue
        g = cache.lookup(r['address']) if r['address'] else None
        addr_used = r['address']
        kyoto_stripped = False
        # **京都的通り名地址：原地址查無時，剝掉那一段再查一次**（2026-08-28）。
        # 那 18 家店原本 `geo` 是 None ＝不上地圖，而清單被 RESTAURANT_LIST 關著，
        # 等於**整家店在網站上不存在**（同第九十四筆 `シグネチャー` 那種壞法）。
        # ⚠️ **只在查無時才試**，理由見 strip_kyoto_street：已經查得到的 56 家
        # 也符合這條規則，無條件改寫會把它們一起動到。
        if not g and r['address']:
            cand = strip_kyoto_street(r['address'])
            g2 = cache.lookup(cand) if cand else None
            if g2:
                g, addr_used, kyoto_stripped = g2, cand, True
                stats['kyoto'] += 1
        # **京都的通り名（第二種）：查得到，但 GSI 把「通り名」當成了町名**（2026-08-29）。
        # `木屋町通三条下る材木町187` 回的 title 是「木屋町」——那是一條路不是町，
        # 而下面的 `refine_query` 接著拿「它回的 title ＋ 原地址的番地」重組，
        # 於是組出 **`木屋町187`：材木町的門牌接到木屋町上，一個不存在的地址**。
        # 更糟的一種是 GSI 回了完全無關的町：`押小路通御幸町西入橘町612` 回「押西洞院町」
        # → 重組成 `押西洞院町612` → GSI 認了、番地級 → **判成 `precise`，
        # 而離真正的橘町 612 有 0.98km**。那正是 `title_too_coarse` 要擋的「自信的錯誤」，
        # 只是換一個入口重新長出來。
        #
        # ⚠️ **量過才動**：那 56 家「原地址查得到」的京都通り名店 **100% 落在這個分支**
        # （`title_too_coarse` 全為真），所以「只在這條路上多試一次」動到的就是這批，
        # 碰不到任何原本就查得夠細的地址——同「排在原名之後」那條原則。
        # 實打 GSI 逐筆對照：**48 家拿到番地級、且町名與地址上寫的一致**，
        # 位移最大 4.19km、中位約 0.9km；其餘 8 家剝完仍是粗的或查無，
        # 原樣落進下面既有的 refine → OSM → approx，行為一個字沒變。
        # ⚠️ **必須排在 refine 之前**：refine 的兩個輸入（`addr_used` 與 `g['title']`）
        # 都已經被通り名污染了，接在它後面等於拿錯的答案去救錯的答案。
        if g and r['address'] and title_too_coarse(g['title']):
            cand = strip_kyoto_street(addr_used)
            g2 = cache.lookup(cand) if cand else None
            if g2 and not title_too_coarse(g2['title']):
                g, addr_used, kyoto_stripped = g2, cand, True
                stats['kyoto'] += 1
        refined = False
        # **地址不夠細時不可標成 precise**：GSI 會回區公所座標而且回得很成功。
        if g and title_too_coarse(g['title']):
            # **先用「它回的町名 ＋ 原地址的番地」再查一次**（2026-08-20）。
            # 米其林的清單把註記與大樓名塞在番地前面，GSI 解析不下去就停在町名，
            # 於是 km 級誤差被標成「查到了」。詳見 refine_query 的說明。
            cand = refine_query(addr_used, g['title'])
            g2 = cache.lookup(cand) if cand else None
            if g2 and not title_too_coarse(g2['title']):
                g, refined = g2, True
                stats['refined'] += 1
            else:
                # **重組也救不回來時，最後問一次 OSM**（2026-08-20）。鄉下的地址
                # （`千葉県君津市大戸見296`）GSI 的資料庫只收到聚落層級，重組出來
                # 與原地址一模一樣，這條路到此為止——但那些店 OSM 常常是有的。
                # ⚠️ **只查看得到的店**（有地區桶的）。範圍外那 69 家前端根本不顯示，
                # 為它們每個月多打 69 次 Overpass 不划算；日後範圍擴大時 `area_of`
                # 一給出桶，它們自然就會走進這條路。
                poi = (cache.lookup_poi(r['name_ja'], g['lat'], g['lng'], r['address'])
                       if r['area'] and r['name_ja'] else None)
                if poi:
                    r['lat'], r['lng'] = poi['lat'], poi['lng']
                    r['geo'] = 'precise'
                    r['geo_note'] = ('地址只到町名，改用 OSM 的店家位置（離町名中心 %dm）'
                                     % poi['dist'])
                    r['spot'] = spot_of(r['lat'], r['lng'])
                    stats['osm'] += 1
                    continue
                # 都沒有就維持原判。**失敗方向是安全的**：
                # 座標照樣採用（總比沒有好），但降級成 approx，
                # 前端會畫成半透明＋「概略位置」，報表也會逐筆列出來。
                r['lat'], r['lng'] = g['lat'], g['lng']
                r['geo'] = 'approx'
                r['geo_note'] = ('地址只到「%s」，GSI 定位不到番地（可能是區公所座標）'
                                 % g['title'])
                r['spot'] = spot_of(r['lat'], r['lng'])
                stats['coarse'] += 1
                continue
        if not g:
            if r['lat'] is not None:
                r['geo'] = 'approx'
                r['geo_note'] = '地址查無，沿用來源座標'
                stats['suspect'] += 1
            else:
                r['geo'] = None
                # ⚠️ **兩種原因不可混為一談**（同「範圍外 vs 地址不完整」那條）：
                # 沒地址是資料缺陷、要補；有地址卻查不到是 GSI 那邊的事，下輪會重試。
                # 舊版一律寫「無地址也無座標」，而 `シグネチャー` 明明有完整地址——
                # 那句話直接把後來查原因的人帶往錯的方向（實測誤導過一次）。
                r['geo_note'] = ('有地址但 GSI 這輪沒查到（下輪會再試）'
                                 if r['address'] else '無地址也無座標')
                stats['nogeo'] += 1
            continue
        if r['lat'] is None:
            r['lat'], r['lng'] = g['lat'], g['lng']
            r['geo'] = 'precise'
            r['geo_note'] = 'GSI 地址'
            stats['filled'] += 1
        else:
            d = meters(r['lat'], r['lng'], g['lat'], g['lng'])
            if d <= COORD_TOLERANCE_M:
                r['geo'] = 'precise'
                r['geo_note'] = '與 GSI 一致（%.0fm）' % d
                stats['ok'] += 1
            elif d >= COORD_REPLACE_M:
                r['geo'] = 'precise'
                r['geo_note'] = '來源座標偏移 %.0fkm，改用 GSI 地址座標' % (d / 1000)
                r['lat'], r['lng'] = g['lat'], g['lng']
                stats['fixed'] += 1
            else:
                r['geo'] = 'approx'
                r['geo_note'] = '與 GSI 差 %.0fm，待查' % d
                stats['suspect'] += 1
        # 靠重組救回的要標出來：那個地址是**我們自己組的**，不是清單裡原本那串。
        # 日後查到一筆位置可疑時，這行是唯一看得出「它走過重組這條路」的地方。
        if refined:
            r['geo_note'] += '（原地址只到町名，補番地重查）'
        # 同上：那個地址是**我們自己剝出來的**，不是清單裡原本那串。
        # 日後查到一筆位置可疑時，這行是唯一看得出「它走過剝除通り名這條路」的地方。
        if kyoto_stripped:
            r['geo_note'] += '（原地址含通り名，剝除後重查）'
        r['spot'] = spot_of(r['lat'], r['lng'])
    return stats


def find_shared_coords(recs):
    """找出「共用座標且地址分屬不同市區町村」的組。

    ⚠️ **不能只看座標相同就報警**：同一棟大樓裡有兩家餐廳是正常的
    （實測燒肉那份有 5 組全是這種，うしごろ 兩家同址、正泰苑與東京園同棟），
    GSI 對兩者都回同一個點且誤差 0m。這是事實不是錯誤。

    真正的錯誤樣態是**同一個 POI 被套到不同縣市的店**——居酒屋那份把青森的店
    配到名古屋的座標。判準因此是「座標相同但 pref/locality 不同」。
    """
    by = {}
    for r in recs:
        if r['lat'] is None:
            continue
        by.setdefault((round(r['lat'], 6), round(r['lng'], 6)), []).append(r)
    bad = {}
    for k, group in by.items():
        if len(group) < 2:
            continue
        places = {(r['pref'], r['locality']) for r in group}
        if len(places) > 1:
            bad[k] = group
    return bad


def merge_awards(a, b):
    seen, out = set(), []
    for w in list(a) + list(b):
        k = (w.get('guide'), w.get('year'), w.get('tier'))
        if k in seen:
            continue
        seen.add(k)
        out.append(w)
    out.sort(key=lambda w: w.get('year') or 0)
    return out


FILL = ['img', 'img_page', 'img_kind', 'hours', 'hours_note', 'holiday',
        'budget', 'budget_lunch', 'source_url', 'checked_at']


# 同名記錄相距多少公尺以內視為同一家店。**這個值是量出來的不是憑感覺挑的**
# （2026-08-23，全站 5091 筆兩兩比對）：同名而地址寫法不同的配對，距離分布是
# 0〜20m 有 74 對、**20〜300m 一對都沒有**、300m 以上全是真的不同店
# （かがやき 差 6.2km、キャラウェイ 差 18.9km）。門檻落在那個空隙裡怎麼取都不會誤判，
# 取 100 是因為它同時是本專案「座標抽查可接受誤差」一直在用的標準。
# ⚠️ **不要因為「多併幾家」而放寬**：往上調就會開始吃到 300m 那一帶的京都案例，
# 而那些要靠地址修，不是靠放寬門檻。
DEDUPE_NEAR_M = 100

# 去重比對用的店名鑰匙：NFKC（全形半形統一）＋拿掉空白與中黑點。
# ⚠️ **只用於比對，絕不可拿去顯示或算 `id`**——`id` 是 `md5(店名|地址)`，
# 拿正規化過的名字去算等於全站的 id 一次全變。
# 實測救回 8 對（`鮨桂太`／`鮨 桂太`、`てんぷら近藤`／`てんぷら 近藤`、
# `ル スプートニク`／`ル・スプートニク`）。
# ⚠️ 這個鑰匙單獨用**太鬆**（同名不同店會撞在一起，實測 `ザ・ロビーラウンジ`／
# `ザ ロビーラウンジ` 分屬相隔 404km 的兩家飯店），它是**和距離那道一起**才成立的。
def dedupe_name_key(name):
    return re.sub(r'[\s　・･]', '',
                  unicodedata.normalize('NFKC', str(name or '')).lower())


def same_place(a, b):
    """兩筆是不是同一家店。地址字串一模一樣，或座標近到同一棟樓。

    ⚠️ **地址字串比對留著不動**（它是既有行為，30 組靠它合併了一年）；
    座標那道是**加上去的第二條路**，專治「同一家店、兩份榜單的地址寫法不同」：

        ラチュレ  東京都渋谷区渋谷2-2-2 青山ルカビル B1F        ← 食べログ
        ラチュレ  東京都渋谷区渋谷(次のビルを除く)2-2-2 B1F     ← 米其林

    ⚠️ **刻意不去「把地址洗乾淨再比對」**——註記有四種長相（括號、夾在中間的大樓名、
    樓層、`(2丁目)`），`refine_query` 那節已經記過一次「猜不完」。
    座標是 GSI ＋ 重組 ＋ OSM 那一整套正規化跑完的**結果**，等於現成的答案。
    ⚠️ **缺座標時只走地址那條**（回 False 而不是當成同一家）：那 19 筆沒有座標的店，
    比距離等於拿 None 去算，而「都沒座標」不是「在同一個地方」。
    """
    if a['address'] == b['address']:
        return True
    if a.get('lat') is None or b.get('lat') is None:
        return False
    return meters(a['lat'], a['lng'], b['lat'], b['lng']) <= DEDUPE_NEAR_M


def dedupe(recs):
    """跨榜單／跨年度同店合併。鍵是「店名（正規化）」＋「同地址或座標相近」。

    回傳 `(存活的記錄, {被併掉的 id: 代表它的那筆})`。

    ⚠️ **活下來的一律是先讀到的那筆**，與舊版相同——
    順序由 `load_sources()` 決定：**先 `restaurants_src/`（依檔名排序）、再 `restaurants/`
    那兩個沒有來源清單的檔**，所以 `2025_..._italian_tokyo` 的店反而會輸給 2026 年的米其林。
    那不影響正確性（awards 一樣併齊），只是代表**不能憑檔名推論誰是代表**——
    `id` 是 `md5(店名|地址)`，換人當代表就等於換一個 id。餐廳沒有收藏也沒有分享連結，
    id 變動不會弄壞使用者手上的東西，但沒有理由讓它每次重跑都跳。

    ⚠️ **那張對照表不是可有可無的**（2026-08-23 實作時踩到）。舊版靠「同地址＝同 id」
    這個巧合，被併掉那筆的 id 與代表它的那筆**剛好一樣**，於是 `write_outputs` 的
    `by_id[r['id']]` 照樣查得到，兩個檔都寫得出東西。改成比座標之後兩者的 id 不同了，
    沒有這張表的話**輸家會整筆從自己的榜單檔裡消失**——實測米其林一星那份
    276 → 221 家，而詳細檔是「資料全留」的儲存體、`index.json` 是給人看的稽核檔，
    等於一次弄壞兩個。它在畫面上完全看不出來（前端只讀 `_map.json`）。
    """
    out, buckets, alias = [], {}, {}
    for r in recs:
        group = buckets.setdefault(dedupe_name_key(r['name_ja']), [])
        prev = next((s for s in group if same_place(s, r)), None)
        if prev is None:
            group.append(r)
            out.append(r)
            continue
        alias[r['id']] = prev
        prev['awards'] = merge_awards(prev['awards'], r['awards'])
        # **任一份清單標了歇業就算歇業。** 檔案是依檔名排序讀的，所以 2024 那份會先進來；
        # 若 2025 那份說它收了，不接這一行就會被 2024 的「營業中」壓過去，店又冒回地圖上。
        if is_closed(r):
            prev['status'] = r['status']
        for f in FILL:
            if not prev.get(f) and r.get(f):
                prev[f] = r[f]
        if prev['geo'] != 'precise' and r['geo'] == 'precise':
            prev['lat'], prev['lng'], prev['geo'] = r['lat'], r['lng'], r['geo']
    return out, alias


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--recheck', action='store_true', help='強制重驗全部座標')
    ap.add_argument('--dry-run', action='store_true', help='只報告不寫檔')
    args = ap.parse_args()

    sources = load_sources()
    if not sources:
        print('restaurants/ 底下沒有可用的清單檔。')
        return 1

    all_recs, per_file, bad_genre = [], [], []
    for year, guide, genre, scope, gmeta, rows, fn in sources:
        recs = []
        for r in rows:
            rec = normalize(r, year, genre, scope, gmeta)
            if rec is None:
                # 類別認不得（或 mixed 檔漏標）。**逐筆記下來給報表**，不可靜默跳過——
                # 少一家店在畫面上看不出來，而使用者以為自己已經放進去了。
                bad_genre.append((
                    norm_text(r.get('name_ja') or r.get('current_name')) or '（無店名）',
                    fn, norm_text(r.get('genre'))))
                continue
            recs.append(rec)
        recs = [r for r in recs if r['name_ja']]
        # **已歇業的店照樣寫進詳細檔，只是不進 `_map.json`**（2026-08-13 改）。
        # 舊版在這裡就整筆濾掉，於是「標了歇業」＝那筆資料從此消失——
        # 而詳細檔就是保留的儲存體（原始清單轉換後就刪了），等於查不到
        # 「這家哪一年上榜、什麼時候收的」。與「範圍外」同一個做法：資料留著、前端不顯示。
        # meta 沒填時，從既有記錄回填，**否則寫出去的 meta 會與 awards 自相矛盾**
        # （meta.url 空著、各筆 awards 卻有網址）。既有兩份榜單就是這個情況。
        if not gmeta['url']:
            gmeta['url'] = next((a['url'] for r in recs for a in r['awards'] if a.get('url')), '')
        if not gmeta['checked_at']:
            gmeta['checked_at'] = next((r['checked_at'] for r in recs if r['checked_at']), '')
        per_file.append((fn, year, guide, genre, scope, gmeta, recs))
        all_recs.extend(recs)

    cache = GeoCache(CACHE_PATH)
    print('讀入 %d 個清單檔、共 %d 家' % (len(per_file), len(all_recs)))
    print('開始用国土地理院重驗座標…（快取 %d 筆）' % len(cache.data))
    stats = verify_coords(all_recs, cache, args.recheck)
    # **快取一律存，連 --dry-run 也要**：它是工作檔不是產出，
    # 不存的話每次試跑都要重打 GSI 幾百次（1 req/s，很痛）。
    cache.save()

    shared = find_shared_coords(all_recs)
    merged, alias = dedupe(all_recs)

    print()
    print('── 座標 ──')
    print('  與 GSI 一致        %d' % stats['ok'])
    print('  由地址查到         %d（來源未附座標）' % stats['filled'])
    print('  已改寫（偏移過大）  %d' % stats['fixed'])
    print('  待查（100〜500m）  %d' % stats['suspect'])
    print('  重組地址救回      %d（原本只到町名，補番地後查到）' % stats['refined'])
    print('  OSM 店家位置救回  %d（GSI 只到町名，改用 OSM 的店家 POI）' % stats['osm'])
    # **新增一行，既有文案一個字都不能動**（公開摘要是 grep 文案字串的，地雷 #19 第 2 點）。
    print('  通り名剝除救回    %d（京都的 <某>通<某>入ル，GSI 整串查無）' % stats['kyoto'])
    print('  ⚠ 地址不夠細      %d（只到市區町村，恐為區公所座標）' % stats['coarse'])
    print('  無座標              %d' % stats['nogeo'])
    print('  沿用（未變更）      %d' % stats['reused'])
    print('  GSI 查詢 %d 次、快取命中 %d 次' % (cache.misses, cache.hits))
    # **新增一行，既有文案一個字都不能動**（公開摘要是 grep 文案字串的，地雷 #19 第 2 點）。
    # 這行只在真的失敗過才印——平常不出現，出現就代表有地址這輪沒查成。
    if cache.gsi_fail:
        print('  ⚠ GSI 查詢失敗 %d 次（不寫快取，下輪會自動重試）' % cache.gsi_fail)
    print('  Overpass 查詢 %d 次、快取命中 %d 次、失敗 %d 次、花了 %.0f 秒%s'
          % (cache.osm_calls, cache.osm_hits, cache.osm_fail, cache.osm_spent,
             ('、超過時間預算跳過 %d 家（下個月再試）' % cache.osm_skipped)
             if cache.osm_skipped else ''))
    # **新增一行，既有文案一個字都不能動**（公開摘要 grep 文案字串，地雷 #19 第 2 點）。
    # ⚠️ 這行要回答的是「**是哪一個端點在擋我們**」——上面那個總數回答不了：
    # 主站每次都會試，鏡像只在主站失敗時才試，所以主站的次數若等於總查詢數，
    # 代表它根本沒讓我們進去（實測它會直接把 TLS 握手丟掉）。
    if cache.osm_ep_fail:
        print('  Overpass 端點失敗：' + '、'.join(
            '%s %d 次' % (h, n) for h, n in sorted(cache.osm_ep_fail.items())))
    print()
    print('── 資料 ──')
    print('  合併前 %d 家 → 合併後 %d 家（跨榜單同店 %d）'
          % (len(all_recs), len(merged), len(all_recs) - len(merged)))
    groups = {'inside': [], 'closed': [], 'outside': [], 'unknown': []}
    for r in merged:
        groups[scope_status(r)].append(r)
    inside, closed = groups['inside'], groups['closed']
    outside, unknown = groups['outside'], groups['unknown']
    print('  落在顯示範圍 %d 家、已歇業 %d 家、範圍外 %d 家、判不出地區 %d 家'
          % (len(inside), len(closed), len(outside), len(unknown)))
    if outside:
        by_pref = {}
        for r in outside:
            by_pref[r['pref']] = by_pref.get(r['pref'], 0) + 1
        # 範圍外只印縣別分布不逐筆列出：全國榜單可能有幾百家，逐筆會洗版，
        # 而且它們**不需要處理**。真正要人工看的是下面那行的 unknown。
        print('  範圍外縣別：%s' % '、'.join('%s %d' % kv for kv in
                                          sorted(by_pref.items(), key=lambda kv: -kv[1])))
    if unknown:
        print('  ⚠ 判不出地區 %d 家（地址缺失或不完整），逐筆清單見報表' % len(unknown))
    if bad_genre:
        print('  ⚠ 類別不明 %d 家（沒填或填了不認得的值，已跳過），逐筆清單見報表'
              % len(bad_genre))
    if shared:
        n = sum(len(v) for v in shared.values())
        print('  ⚠ 共用座標 %d 組、涉及 %d 家（來源資料的典型錯誤）' % (len(shared), n))

    by_area = {}
    for r in inside:
        by_area[r['area']] = by_area.get(r['area'], 0) + 1
    print('  地區分布：%s' % ('、'.join('%s %d' % kv for kv in
                              sorted(by_area.items(), key=lambda kv: -kv[1])) or '無'))

    if args.dry_run:
        print('\n（--dry-run，未寫檔）')
        return 0

    os.makedirs(REPORT_DIR, exist_ok=True)
    # id → 來源檔名。報表要指出「這家店是哪一份清單來的」，否則幾百家混在一起時
    # 你知道要補地址卻不知道要去改哪個檔。同一家店跨榜單時取第一個。
    origin = {}
    for fn, _y, _g, _ge, _s, _m, recs in per_file:
        for r in recs:
            origin.setdefault(r['id'], fn)

    write_outputs(per_file, merged, inside, alias)
    write_report(shared, merged, stats, origin, bad_genre)
    print('\n已寫出 restaurants/_map.json（%d 家）與 index.json' % len(inside))
    print('需人工複查的清單見 _probe/restaurants_report.txt')
    return 0


def write_outputs(per_file, merged, inside, alias):
    by_id = {r['id']: r for r in merged}
    sources, files, home = [], [], {}
    for fn, year, guide, genre, scope, gmeta, recs in per_file:
        # ⚠️ **被併掉的那筆要留在自己的榜單檔裡，不可讓它消失**（2026-08-23）。
        # 舊版寫 `by_id[r['id']]`，靠的是「同地址＝同 id」這個巧合——被併掉那筆的 id
        # 與代表它的那筆剛好一樣，所以兩個檔都寫得出東西。改成比座標之後兩者 id 不同了，
        # 照舊寫法**輸家會整筆從自己的榜單檔裡消失**（實測米其林一星 276 → 221 家）。
        # 那會一次弄壞兩件事：詳細檔是「資料全留」的儲存體（`load_sources` 會把它當輸入
        # 重讀，**其中兩份根本沒有來源清單，輸出檔就是唯一的備份**），
        # 而 `index.json` 是給人看的稽核檔，榜單本來 100 家、掉成 89 家就是在說謊。
        # ⚠️ **前端只讀 `_map.json`，所以這件事在畫面上完全看不出來。**
        #
        # 這裡刻意寫成「查得到合併後的就用它，查不到就用自己原本那筆」：
        # 前半維持舊版對「同 id」的行為一個位元組不變（跨年度同店仍共用同一個物件、
        # awards 已併齊），後半讓每份榜單**忠實保留自己記的店名與地址**——
        # 用贏家的物件蓋掉的話，那份榜單自己的地址寫法就永久消失了。
        keep = [by_id.get(r['id']) or r for r in recs]
        # `mixed` 檔沒有單一類別，改由實際內容統計。**不可寫 `GENRES[genre]`**，
        # 那會 KeyError（mixed 不在表裡）。
        mix = {}
        for r in keep:
            mix[r['genre']] = mix.get(r['genre'], 0) + 1
        if genre == MIXED_GENRE:
            zh, ja = '（混合）', '（混合）'
        else:
            zh, ja = GENRES[genre]
        name = '%d_%s_%s_%s.json' % (year, guide, genre, scope)
        with open(os.path.join(DIR, name), 'w', encoding='utf-8') as f:
            # **`meta` 也要寫出去**：輸出檔會被 load_sources 當輸入重新讀進來，
            # 沒有 meta 的話重跑一次就把榜單名稱與官方連結弄丟了（round trip 不可失真）。
            json.dump({'schema_version': SCHEMA_VERSION, 'build_version': BUILD_VERSION,
                       'meta': dict(gmeta, guide_slug=guide, genre=zh, area=scope),
                       'count': len(keep), 'restaurants': keep},
                      f, ensure_ascii=False, indent=1)
            f.write('\n')
        # 同一家店可能出現在多個檔（跨年度入選），詳細資料取第一個含它的檔即可
        # ——各檔存的是同一個已合併的物件，awards 已經併齊。
        idx = len(files)
        files.append(name)
        for r in keep:
            home.setdefault(r['id'], idx)
        src = {'genre': zh, 'genre_ja': ja,
               'file': name, 'count': len(keep),
               'area': scope, 'guides': [gmeta['guide']],
               'tier': gmeta['tier'], 'years': [gmeta['year']]}
        if genre == MIXED_GENRE:
            # 混合檔的稽核重點就是「裡面到底有哪些類別、各幾家」，
            # 只印一個「（混合）」等於什麼都沒說。
            src['genres'] = [{'zh': k, 'n': v} for k, v in
                             sorted(mix.items(), key=lambda kv: -kv[1])]
        sources.append(src)

    # ── 輕量索引 ──────────────────────────────────────────────────
    # 前端開地圖只載這一份：每家約 90 bytes，2000 家約 180KB，
    # 而完整資料是 2MB 且分散在二十個檔。欄位刻意用單字母縮寫，
    # `f` 是「詳細資料在 files[] 的第幾個檔」，前端據此按需載入。
    genres = {}
    for r in inside:
        g = genres.setdefault(r['genre'], {'zh': r['genre'], 'ja': r['genre_ja'], 'n': 0})
        g['n'] += 1
    # ── 榜單徽章：字典 ＋ 每家店存編號（2026-08-26，行程頁「加一頓飯」用）──
    #
    # 「被哪些指南推薦過」是本功能的核心價值，但 `awards` 原本只在詳細檔裡
    # （一檔 10～50 KB），而銀座那種地方前 12 家可能橫跨十幾個檔——為了徽章去載
    # 那些檔，代價遠大於徽章本身。
    #
    # ⚠️ **不要把 awards 整包塞進索引**：實測全站只有 **9 種** (guide, tier, year)
    # 組合，而 2190 家平均 1.03 個。整包塞是原始 +18KB／gzip +5KB，
    # 拆成「字典＋編號」則是 gzip **+668 bytes（+0.9%）**，同一件事便宜一個數量級。
    # ⚠️ **字典不放 `url`**：徽章不是連結（前端 `awardsHTML()` 根本沒用到那個欄位），
    # 放進去等於白付體積——真的要做成連結時再加，那時體積才有意義。
    # ⚠️ **順序必須是決定性的**（本管線「輸入沒變就逐位元組相同」，見檔頭）：
    # 故字典按 (guide, year, tier) 排序，而不是用出現順序。
    # ⚠️ **但 `w` 不可以跟著排序**：那 74 家雙榜單的店，詳細檔的 awards 是照合併順序
    # 排的（食べログ 在前），排序過的 `w` 會變成米其林在前——於是**同一家店在行程頁
    # 與餐廳彈窗，兩個徽章的左右順序相反**，而兩邊各自看起來都完全正常。
    # 故 `w` 沿用該筆 awards 自己的順序（去重時保留先出現的那個），
    # 它本身也是決定性的（合併順序由檔案讀取順序決定）。
    combos = sorted({(a.get('guide') or '', a.get('tier') or '', a.get('year'))
                     for r in inside for a in (r.get('awards') or [])},
                    key=lambda c: (c[0], c[2] or 0, c[1]))
    aw_idx = {c: i for i, c in enumerate(combos)}

    # **沒有座標的也要收進索引**：它上不了地圖，但仍是榜單上的一家店，
    # 清單裡不該憑空消失（前端的地圖算繪本來就會跳過 lat 非數字的）。
    slim = []
    for r in inside:
        rec = {'id': r['id'], 'n': r['name_ja'], 'g': r['genre'],
               'a': r['area'], 's': r['spot'],
               'lat': r['lat'], 'lng': r['lng'], 'geo': r['geo'],
               'f': home.get(r['id'], 0)}
        # 沒有 awards 的店就整個不寫這個鍵（同 `no_hours`／`world_heritage` 的慣例）。
        # 現況 2190 家全部都有，但這個欄位不該假設那件事永遠成立。
        w = []
        for a in (r.get('awards') or []):
            i = aw_idx[(a.get('guide') or '', a.get('tier') or '', a.get('year'))]
            if i not in w:
                w.append(i)
        if w:
            rec['w'] = w
        slim.append(rec)
    with open(os.path.join(DIR, '_map.json'), 'w', encoding='utf-8') as f:
        json.dump({'schema_version': SCHEMA_VERSION, 'count': len(slim),
                   'files': files,
                   'genres': sorted(genres.values(), key=lambda g: -g['n']),
                   'awards': [list(c) for c in combos],
                   'restaurants': slim}, f, ensure_ascii=False)
        f.write('\n')

    with open(os.path.join(DIR, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'schema_version': SCHEMA_VERSION,
                   'note': '本檔由 build_restaurants.py 自動產生，不要手改。'
                           '新增榜單請把檔案放進 restaurants_src/，'
                           '檔名 <年份>_<榜單>_<類別羅馬字>_<地區>.json。'
                           '一份榜單混了多種類別時，類別那段填 mixed，'
                           '每一筆自己加 genre 欄位。',
                   'sources': sources}, f, ensure_ascii=False, indent=2)
        f.write('\n')


def write_report(shared, merged, stats, origin=None, bad_genre=None):
    origin = origin or {}
    lines = ['需人工複查的餐廳資料', '=' * 40, '']

    # 【類別不明】排在最前面，因為它是唯一「整筆沒有進到資料裡」的一類——
    # 上面那幾類至少還躺在詳細檔，這一類連詳細檔都沒有。
    if bad_genre:
        lines.append('【類別不明】沒填 genre 或填了不認得的值，**這幾筆已整筆跳過**。'
                     '可填的寫法：slug（sushi）／繁中（壽司）／日文（寿司）：')
        for name, fn, got in bad_genre:
            lines.append('  - %s（%s）填的是：%s'
                         % (name, fn, got or '（沒填）'))
        lines.append('')

    # 【判不出地區】排在最前面：它是這份報表裡唯一「不補就永遠看不到」的一類。
    # 已歇業與範圍外都不必處理，放後面當參考。
    # ⚠️ **歇業的店不可以落進「判不出地區」那一段**——那段會叫人去補地址，
    #    對一家倒了的店是錯的指示，而且會永遠賴在報表上。`scope_status` 先判 closed 就是為此。
    unknown = [r for r in merged if scope_status(r) == 'unknown']
    if unknown:
        lines.append('【判不出地區】地址缺失或不完整（解析不出市區町村），'
                     '資料保留在詳細檔但前端不會顯示。補完地址重跑就會出現：')
        for r in unknown:
            lines.append('  - %s（%s）地址：%s'
                         % (r['name_ja'], origin.get(r['id'], '?'),
                            r['address'] or '（空白）'))
        lines.append('')

    if shared:
        lines.append('【共用座標】同一組座標被指派給多家店，每組最多只有一家是對的：')
        for (lat, lng), group in sorted(shared.items()):
            lines.append('  %.6f, %.6f' % (lat, lng))
            for r in group:
                lines.append('    - %s（%s%s）%s' % (r['name_ja'], r['pref'], r['locality'],
                                                   r['geo_note']))
        lines.append('')
    # 【OSM 補位】**一定要逐筆列出來給人看**：這條路採用的是「名稱像、範圍內、
    # 剛好一個」的推論，而**掛錯的在地圖上跟正確的長得一模一樣**（同 build_photos.py
    # 的 GPS 配對、同 title_too_coarse 那類壞法）。它們的 geo 是 precise，
    # 不列在這裡就沒有任何地方看得出它走過這條路。
    osm = [r for r in merged if r['geo'] == 'precise' and 'OSM' in r['geo_note']]
    if osm:
        lines.append('【OSM 補位】地址只到町名、GSI 給的是聚落中心，改用 OSM 的店家位置。'
                     '請抽查位移特別大的幾筆：')
        for r in sorted(osm, key=lambda r: -int(re.search(r'(\d+)m', r['geo_note']).group(1))):
            lines.append('  - %s（%s%s）%s'
                         % (r['name_ja'], r['pref'], r['locality'], r['geo_note']))
        lines.append('')

    # 【地址不夠細】要與下面的【座標待查】分開：兩者的 geo 都是 approx，但這一類
    # **是地址本身寫得不夠細**（要補到番地），另一類是座標對不上（要查證哪個對）。
    # 處理方式完全不同，混在一起等於沒報。
    coarse = [r for r in merged if r['geo'] == 'approx' and '定位不到番地' in r['geo_note']]
    if coarse:
        # **只逐筆列出會顯示在地圖上的那些**，範圍外的只印筆數與縣別分布
        # ——與【範圍外】那一段同一條理由：這份清單是要人去修的，
        # 而範圍外的店根本不會出現在前端，混進來只會把該修的那幾家淹掉
        # （加上大字級判定之後，這一類從 15 家變成 125 家，其中九成在關西與北海道）。
        shown = [r for r in coarse if scope_status(r) == 'inside']
        hidden = [r for r in coarse if scope_status(r) != 'inside']
        lines.append('【地址不夠細】GSI 只匹配到市區町村或大字，很可能是區公所／市公所的座標。'
                     '請把地址補到番地：')
        for r in shown:
            lines.append('  - %s（%s）地址：%s ／ %s'
                         % (r['name_ja'], origin.get(r['id'], '?'),
                            r['address'], r['geo_note']))
        if hidden:
            cnt = {}
            for r in hidden:
                k = r['pref'] or '（判不出）'
                cnt[k] = cnt.get(k, 0) + 1
            lines.append('  （另有 %d 家不在顯示範圍內，前端看不到，故不逐筆列出：%s）'
                         % (len(hidden),
                            '、'.join('%s %d' % kv for kv in
                                     sorted(cnt.items(), key=lambda kv: -kv[1]))))
        lines.append('')

    coarse_ids = {r['id'] for r in coarse}
    suspect = [r for r in merged if r['geo'] == 'approx' and r['id'] not in coarse_ids]
    if suspect:
        lines.append('【座標待查】與地址算出的位置差 100m 以上：')
        for r in suspect:
            lines.append('  - %s（%s%s）%s' % (r['name_ja'], r['pref'], r['locality'],
                                             r['geo_note']))
        lines.append('')
    nogeo = [r for r in merged if r['lat'] is None]
    if nogeo:
        lines.append('【無座標】不會出現在地圖上：')
        for r in nogeo:
            lines.append('  - %s' % r['name_ja'])
        lines.append('')

    # 【已歇業】逐筆列出：家數不會多，而且你會想知道是哪幾家收了。
    closed = [r for r in merged if scope_status(r) == 'closed']
    if closed:
        lines.append('【已歇業】不顯示在地圖與清單上，資料保留在詳細檔（不必處理）：')
        for r in closed:
            lines.append('  - %s（%s）%s'
                         % (r['name_ja'], origin.get(r['id'], '?'), r['status']))
        lines.append('')

    # 【範圍外】純參考，**不需要處理**。列縣別分布而不逐筆列出：全國榜單可能幾百家，
    # 逐筆會把上面那些真正要處理的項目淹掉。
    outside = [r for r in merged if scope_status(r) == 'outside']
    if outside:
        by_pref = {}
        for r in outside:
            by_pref[r['pref']] = by_pref.get(r['pref'], 0) + 1
        lines.append('【範圍外】不在目前涵蓋範圍，資料已保留在詳細檔，'
                     '日後擴大範圍重跑就會出現（不必處理）：')
        for pref, n in sorted(by_pref.items(), key=lambda kv: -kv[1]):
            lines.append('  %s %d 家' % (pref, n))

    with open(os.path.join(REPORT_DIR, 'restaurants_report.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    sys.exit(main())
