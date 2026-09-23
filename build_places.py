#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""常設景點管線 —— 把「名稱＋地址＋連結」整理成前端能用的 places.json。

三支管線的分工（**彼此完全獨立，不要想成同一件事**）：
  fetch_events.py       自動抓活動（來源是 64 個網站，每天變，要 LLM 與金鑰）
  build_restaurants.py  整理餐廳清單（人工放清單，每月跑，只打国土地理院）
  build_places.py       整理常設景點（人工放清單，每月跑）← 本檔

本程式做兩件事：
  **座標與地區**（H1）　每次都做，只打国土地理院，不需要任何金鑰、有快取時 0 秒。
  **營業時間**（H2）　　**只在 `--hours` 時做**，去景點官網抓，需要 LLM 金鑰。

⚠️ **營業時間刻意要旗標才抓。** 你在本機加一筆景點時不該去抓 30 頁官網（慢、
而且本機沒有 `GEMINI_API_KEY`，抽取那段一定失敗）。每月的 workflow 才帶 `--hours`。
沒帶旗標時既有的營業時間**原封不動保留**——輸出檔會被當成資料重讀，任何
「不從既有值繼承」的欄位，重跑一次就會被清掉，而且沒有任何錯誤訊息。

⚠️ **刻意不擴充 build_restaurants.py**（計畫書明確排除：那是動到已上線且穩定的管線）。
但地址→地區桶那段邏輯**用 import 共用而不是抄一份**：那段已經被 300 家餐廳
實測過（含郡下町村、政令指定都市、只到區級的偵測），抄一份就變成「改一邊要改兩邊」，
而漏改的症狀是「景點歸到錯的地區桶」——地圖上跟正確的長得一模一樣。
本程式**只讀不改** build_restaurants.py。

用法：
    python3 build_places.py            # 座標沿用快取，只查新的（**不碰營業時間**）
    python3 build_places.py --recheck  # 強制重查全部座標
    python3 build_places.py --hours    # 連營業時間一起抓（每月的 workflow 用這個）
    python3 build_places.py --dry-run  # 只報告不寫 places.json（快取照存，它是工作檔）

輸出：
    places.json                    前端資料（**產出檔，不可手改**）
    places_src/_geocache.json      座標快取（GSI 限速 1 req/s，有它重跑是 0 秒）
    _probe/places_report.txt       需人工處理的清單
"""

import argparse, json, os, re, sys, time, unicodedata
import urllib.error

# 兩支都是**只讀不改**：本程式不動它們，它們也不知道本程式存在。
# build_restaurants  → 「地址 → 縣／市區町村 → 地區桶」與 GSI 查詢那幾個純函式
# fetch_events       → Jina 抓頁面的死連結判讀、LLM 遞補鏈（H-35：零新金鑰、零新依賴）
import build_restaurants as br
import fetch_events as fe

ROOT = os.path.dirname(os.path.abspath(__file__))
# ⚠️ **收件匣與快取必須放在發布目錄外面**（地雷 #14 同款錯誤）：
# Cloudflare 的組建命令會把整個 places/ 資料夾複製進 dist/，
# 原始清單放進去等於把它發布到自家網域下。places_src/ 不在複製清單裡。
SRC = os.path.join(ROOT, 'places_src')
OUT = os.path.join(ROOT, 'places.json')
PHOTO_DIR = os.path.join(ROOT, 'places')          # 照片，會被發布
CACHE_PATH = os.path.join(SRC, '_geocache.json')
REPORT_DIR = os.path.join(ROOT, '_probe')

SCHEMA_VERSION = 1
# 正規化邏輯的版本。**改動欄位對應或座標判定後 +1**，既有資料才會重查。
# 與 fetch_events.py 的 GEO_VERSION、build_restaurants.py 的 BUILD_VERSION 同一個道理。
BUILD_VERSION = 1

# 「範圍外」這個原因的標記字串（2026-08-22）。**它與其他擋下原因必須分得開**：
# 範圍外是**正確的過濾＋刻意的預收**（大阪的景點，等地區桶開通就會上線），
# 其餘（地址缺、小類認不得、查不到座標）是**該修的資料缺陷**。
# 兩者混在同一段逐筆列出的話，收了幾百筆預收之後，真正要處理的那幾筆就淹掉了
# ——同 build_restaurants.py 的 scope_status() 把 outside 與 unknown 分開的理由。
PENDING_TAG = '不在涵蓋範圍'

# 前端的分類值。**與 js/config.js 的 PLACE_TYPE、css 的 --c-景點／--pin-景點、
# js/icons.js 的 EVENT_ICON 是同一個字串**，改這裡就要一起改那三處。
PLACE_TYPE = '景點'

# 小類（2026-08-20）。**大類 `type` 永遠是「景點」不動，小類另立一欄。**
# 兩段式（景點・神社寺廟）是使用者要的：大類負責「這是景點不是活動」的區隔，
# 小類負責景點內部的細分。
# ⚠️ **不要為了「更精確」而把 type 改成小類值**：行程頁是靠 type 認出景點列的，
# 改了之後那裡就得多一個「哪些 type 算景點」的判斷——那是新增一個以後會漏掉的地方。
#
# **鍵是繁中（資料值），值是日文（顯示用）**，與餐廳的 GENRES 同一個做法。
# 兩者都寫進輸出檔，前端不必再維護第二張對照表（單一真相來源）。
#
# ⚠️ **顏色刻意不隨小類分家**（使用者 2026-08-20 決定的方案 B）：圖釘一律
# `--pin-景點`，小類只用圖示區分。理由有三——①「一眼看出這是景點不是活動」
# 這個識別要保住 ②色相圈已經很擠（餐廳 23 類把它用滿了，見 CLAUDE.md）
# ③圖例改成「圖示對照表」照樣有內容。**所以新增小類不需要動任何 CSS 變數。**
GENRES = {
    '神社寺廟':   '神社・寺院',
    '博物館':     '博物館',
    '美術館':     '美術館',
    '公園庭園':   '公園・庭園',
    '水族館動物園': '水族館・動物園',
    '地標展望':   'ランドマーク・展望',
    # 2026-08-21 開的第七類。瀑布、溪谷、洞窟、岩場這種「沒有建物、人是去看地形的」，
    # 塞進「公園庭園」會與六義園那種人造庭園頂著同一個圖示。**開新小類不必動任何
    # CSS 變數**（方案 B：六個小類本來就同色），成本只有 js/icons.js 的一個圖示。
    '自然景勝':   '自然・景勝地',
    # 2026-09-03 開的第八類（單位 R 挖出來的）。溫泉旅館的日歸入浴、砂湯、
    # 溫泉主題設施——**七個小類沒有一個貼得上**：塞「公園庭園」會與六義園頂著
    # 同一個圖示，塞「自然景勝」又不是地形。實測 Klook 那 212 件裡就有 11 件是這種，
    # 而日本到處都是。**開新小類不必動任何 CSS 變數**（方案 B：小類本來就同色）。
    '溫泉':       '温泉',
}

# 寫法差異的容錯。**由 GENRES 自動生成反查表再疊上這張**，所以 GENRES 加一行
# 不必記得改第二處——手寫兩張表的話，漏改的症狀是「填了正確類別卻說不認得」。
GENRE_ALIAS = {
    '神社': '神社寺廟', '寺廟': '神社寺廟', '寺院': '神社寺廟', '神社寺院': '神社寺廟',
    '寺': '神社寺廟', '神社・寺': '神社寺廟',
    '博物館美術館': '', '美術館博物館': '',   # 空值＝刻意不猜，見 resolve_genre
    '公園': '公園庭園', '庭園': '公園庭園', '公園・庭園': '公園庭園',
    '水族館': '水族館動物園', '動物園': '水族館動物園', '水族館・動物園': '水族館動物園',
    '地標': '地標展望', '展望': '地標展望', '展望台': '地標展望',
    'ランドマーク・展望': '地標展望',
    '自然': '自然景勝', '景勝': '自然景勝', '景勝地': '自然景勝',
    '滝': '自然景勝', '瀑布': '自然景勝', '渓谷': '自然景勝', '溪谷': '自然景勝',
    '洞窟': '自然景勝', '自然・景勝地': '自然景勝',
    '温泉': '溫泉', '湯': '溫泉', '日帰り温泉': '溫泉', '砂湯': '溫泉',
    'スパ': '溫泉', '銭湯': '溫泉', '露天風呂': '溫泉', '溫泉設施': '溫泉',
}
_GENRE_LOOKUP = {}
for _zh, _ja in GENRES.items():
    _GENRE_LOOKUP[_zh] = _zh
    _GENRE_LOOKUP[_ja] = _zh

# id 規則（H-31）：pl- 前綴讓它與活動 id（12 碼 hex）格式不同，**永不相撞**。
# ⚠️ 這條正規表達式要與 js/plan-ui.js 的 readSharedPlan() 那條一致，
# 那裡是分享連結的白名單，比這裡寬鬆一點沒關係、嚴格一點會讓分享的景點憑空消失。
ID_RE = re.compile(r'^pl-[a-z0-9-]{1,40}$')

REQUIRED = ('id', 'title', 'title_ja', 'address', 'url')
# H2 會寫、H1 不碰的欄位。**一定要從既有 places.json 繼承**，否則 H2 上線後
# 每次重跑都會把上個月抓到的營業時間清掉，而且不會有任何錯誤訊息。
# ⚠️ `hours_fail` 也在裡面：**它是「連續幾次抓不到」的計數，不繼承就永遠是 0**，
# 「連續 2 次才提醒」那條規則（H-38）等於不存在，而且不會有任何錯誤訊息。
# 歸零時不會被寫進輸出檔（out_record 只寫非空值），所以正常情況下看不到它。
# ⚠️ `hours_tried` 也在裡面，而且**不繼承它，分批就整個失效**（單位 あ，2026-09-04）：
# 它是「上一次輪到這一筆是什麼時候」，佇列就是照它由舊到新排的。不繼承的話每輪
# 都從空的開始，於是每個月抓的永遠是同樣那前 N 筆，後面的人一輩子輪不到——
# **而統計會顯示「這輪抓了 N 筆」，看起來完全正常**。
CARRY = ('hours', 'holiday', 'hours_checked', 'hours_fail', 'hours_tried')

# ===== 票券聯盟（單位 M，2026-09-02）=====
# ⚠️ **舊的 `ticket_url` 單一欄位已經換成 `tickets` 陣列。**
# 同一個景點在同一家平台上就可能有好幾件商品（一般入場、快速通關、組合票），
# 一個欄位只裝得下一件——日後想展開就得把整批商品重抓一次。
# 換掉的代價是零：實測 177 筆一個都沒填過 `ticket_url`。
#
# ⚠️ **`url` 與 `aff_url` 一定要分兩欄。** 站上現在放的是裸連結，
# 日後換成帶追蹤碼的網址時，單一欄位等於把原始網址整批覆蓋掉，
# **而那是日後要驗「這件商品還在不在」唯一的依據**。
# 同 build_restaurants.py「絕不可改寫 r['address']」那條。
TICKET_PLATFORMS = ('klook', 'kkday')
TICKET_TYPES = ('admission', 'premium', 'combo')
TICKET_STATUS = ('active', 'inactive', 'unknown')


GSI_WAIT = 1.1        # 国土地理院沒有明文限速，沿用 Nominatim 的 1 req/s 保守值

# ── OSM 補位（GSI 只到大字／町名時的最後一手）─────────────────────
# 整套網路、快取與五道守門在 `build_restaurants.py`，**這裡只提供「這個 POI
# 算不算數」那道白名單**。⚠️ **不要把那支複製過來**，同 parse_address／area_of
# 共用的理由：抄一份就變成改一邊要改兩邊，而漏改的症狀是「圖釘掛在隔壁」，
# 在地圖上跟正確的長得一模一樣。
#
# ⚠️ **白名單是 (標籤鍵, 值) 的配對，不是只看鍵。** 只看 `tourism` 的話，
# 「富岳風穴」5km 內那三個 `tourism=information`（解說牌與地圖看板，名字裡就寫著
# 富岳風穴）會全部過關 → 候選變四個 → 「剛好一個」那道把它整個放棄。
# 實測用配對之後只剩 `natural=cave_entrance` 一個，一次就中。
#
# 這份表是**實測出來的**（2026-08-21 拿那 7 筆 approx 逐一打 Overpass 看回什麼），
# 不是照 OSM wiki 抄的。日後某一類救不回來，先去看它在 OSM 實際掛的是什麼標籤，
# **不要憑印象往裡面加值**——多一個值就多一種「候選變兩個而整筆放棄」的機會。
OSM_PLACE_TAGS = {
    '神社寺廟': {('amenity', 'place_of_worship')},
    '博物館':   {('tourism', 'museum'), ('amenity', 'arts_centre')},
    '美術館':   {('tourism', 'museum'), ('tourism', 'gallery')},
    '公園庭園': {('leisure', 'park'), ('leisure', 'garden'),
                 ('leisure', 'nature_reserve')},
    '自然景勝': {('natural', 'cave_entrance'), ('natural', 'waterfall'),
                 ('natural', 'peak'), ('waterway', 'waterfall'),
                 ('tourism', 'attraction')},
    '水族館動物園': {('tourism', 'zoo'), ('tourism', 'aquarium'),
                     ('tourism', 'theme_park'), ('tourism', 'attraction')},
    '地標展望': {('tourism', 'attraction'), ('tourism', 'viewpoint'),
                 ('man_made', 'tower'), ('historic', 'castle')},
}

# 景點名稱裡拿掉就查得更準的段。與餐廳的 OSM_GENERIC_SEG 是同一條原則
# （**完全比對**，不可當子字串砍），但字不一樣——景點沒有「本店／支店」，
# 有的是行政區與山名前綴。
OSM_PLACE_GENERIC_SEG = {'公園', '神社', '寺', '美術館', '博物館', '記念館'}
# ⚠️ 這一組現行 107 筆**一個都沒踩到**（名稱裡沒有空白分段的泛用詞），
# 留著是預防性的，且**完全比對**——當子字串砍會把「三峯神社」整個砍掉。

# **整輪花在 Overpass 上的時間上限。刻意比餐廳那支的 600 秒短。**
# 理由是這支會被使用者在本機隨手跑（加一筆景點就跑一次），而 Overpass 掛掉的
# 那種日子，一筆最壞會卡到兩個端點各逾時一次（實測約 90 秒）——照 600 秒算
# 等於加一筆景點要等十分鐘，那會讓人以為程式當掉了。
# 候選本來就只有個位數，**這裡放棄的代價只是「這個月維持概略位置」**，
# 而失敗不寫快取，下一輪本身就是重試。
OSM_TIME_BUDGET_S = 240

# ── 營業時間（H2）的參數 ───────────────────────────────────────────
HOURS_PAGE_CHARS = 200000   # Jina 回來的整頁上限（見 fetch_page 的註解，這個數字有理由）
HOURS_EXCERPT_MAX = 12000   # 真正送進 LLM 的節錄上限
HOURS_WINDOW = 500          # 關鍵字前後各取幾個字
HOURS_MAX = 200             # hours 欄位字數上限（超過截斷並列進報表）
HOLIDAY_MAX = 140           # holiday 欄位字數上限（英文寫法很長，80 會切在句子中間）
HOURS_RETRY = 3             # Jina 抓取的重試次數
HOURS_FAIL_ALERT = 2        # 連續幾次抓不到才在 log 提醒（H-38：畫面完全不變）
PLACE_WAIT = 4              # 每筆之間等幾秒。與 fetch_events 的 SOURCE_WAIT 同一個理由：
                            # 撞到的是「每分鐘文字量」而不是「每天呼叫次數」（地雷 #17）
                            # ⚠️ **2026-09-09（單位 あ-2）由 8 降到 4。** 4 秒下打 Jina
                            # 每分鐘不到 3 次、離免費層 20 RPM 還很遠（JINA_API_KEY 從未設定），
                            # 送進模型的只有 HOURS_EXCERPT_MAX（12,000 字）的節錄，
                            # 每分鐘文字量約是活動那條管線的三分之一。
                            # ⚠️⚠️ **它現在直接決定每輪吃得下幾筆。** HOURS_PER_RUN 放大之後
                            # 唯一的閘是 HOURS_BUDGET_SEC。依 2026-09-09 實測的每筆 15.7 秒
                            # （其中 4 秒是這個等待），4 小時預算下 4 秒約 900 筆、
                            # 改回 8 秒約 730 筆。**要調回去之前先算那個數字**，
                            # 不是只看「等久一點比較保險」——那會靜默地讓每輪少抓近兩百筆。

# ── 分批（單位 あ-1，2026-09-04）──────────────────────────────────
# 景點從 67 筆長到 459 筆之後，2026-09-04 那班 schedule **跑滿 60 分鐘被砍**，
# 而逾時的 conclusion 是灰色的 `cancelled` 不是紅色的 `failure`＝**不會有任何通知**。
# ⚠️⚠️ **每筆實測 26.2 秒**（8/21 那輪 85 筆跑了 37 分 5 秒），不是計畫書推的 8 秒
# ——PLACE_WAIT 只佔三成，其餘是 Jina 抓整頁（上限 20 萬字、最多重試 3 次）＋ LLM 抽取。
# 於是 419 筆要 3 小時、使用者說的 2000 筆要 13 小時（GitHub 單一 job 硬上限 6 小時）。
# **分批是必要條件不是優化。** 形狀抄 fetch_events 的 reverify_coords()（單位 T-4）。
# ✅ **2026-09-09 線上實測（run 34308673989）：644 筆跑 2h48m35s＝每筆 15.7 秒。**
# ⚠️ **改動前預估的 22.3 秒高估了 42%**，因為那是拿 8/21 那輪 85 筆（26.2 秒）推的
# ——那批是精選的關東景點、頁面大、hours_url 幾乎都填好，而這輪 159 筆是失敗的，
# **失敗比成功快**。⚠️ **不要把 15.7 當成穩定值**：把 hours_url 補起來、成功率提高之後會再變慢。
# 依 15.7 秒算，4 小時預算跑得完約 900 筆。**2000 筆時仍然一輪抓不完**
# （2000 × 15.7 ≒ 8.7 小時 > GitHub 單一 job 的 6 小時硬上限，每月一輪要 2～3 個月輪一遍），
# 那時要把「輪完一遍」拉回一個月，唯一的路是**提高頻率**（改公開 repo 的 cron），
# 不是再調這兩個數字——4 小時是 6 小時硬上限扣掉收工餘裕之後的結果。
HOURS_PER_RUN = 2000        # 每輪最多抓幾筆（挑「最久沒輪到過的」）。
                            # ⚠️⚠️ **這是防呆的第二道，不是真正的閘**（2026-09-09，單位 あ-2）。
                            # 舊值 500 綁在「當時母體 419 筆＝一輪補完」上，而母體長到 644 之後
                            # 它的意思變成「每輪砍掉 144 筆」——**設它的目的與它實際在做的事
                            # 已經對不起來了**，而且它比時間預算先觸發（4 小時 × 8 秒＝約 547 筆 > 500）。
                            # 真正對應到硬限制（GitHub 單一 job 6 小時）的是 HOURS_BUDGET_SEC，
                            # 這個數字只要大到不擋路就好。
                            # ⚠️ **景點會一直長，別再把它設成「剛好比現在的母體大一點」**
                            # ——那等於每加一批景點就要回來改一次，而漏改是靜默的（只是抓得比較少，
                            # 統計上看起來跟正常輪替一模一樣）。
HOURS_BUDGET_SEC = 4 * 3600  # 整輪時間預算：超過就乾淨收工，剩下的下一輪排最前面。
                            # ⚠️ **一定要比 places.yml 的 timeout-minutes 小一截**，
                            # 靠它收工而不是靠那個閘——被閘砍掉是 cancelled（灰色、
                            # 沒有通知），而且 places.json 與統計一個字都寫不出來。


# ═══ 座標快取 ═══════════════════════════════════════════════════════

class Cache:
    """{完整地址: {lat,lng,title} 或 null}。null 代表「查過而且查不到」，

    ——**這個負向紀錄要留著**，否則每次重跑都會重新去問那幾個查不到的地址。
    """

    def __init__(self, path):
        self.path = path
        self.data = {}
        self.hits = 0
        self.misses = 0
        self.fails = 0        # GSI 查詢失敗（不寫快取，下輪自動重試）
        self.osm_hits = 0     # OSM 補位：快取命中
        self.osm_calls = 0    # OSM 補位：真的打了 Overpass
        self.osm_fail = 0     # OSM 補位：查詢失敗（不寫快取）
        self.osm_skipped = 0  # OSM 補位：時間預算用完，跳過
        self.osm_spent = 0.0
        self.osm_ep_fail = {}  # 每個端點各自的失敗次數
        if os.path.exists(path):
            try:
                with open(path, encoding='utf-8') as f:
                    self.data = json.load(f)
            except Exception as e:
                print('[warn] 快取讀取失敗，這次全部重查：%s' % e, file=sys.stderr)

    def lookup(self, addr):
        """地址 → 座標。**查詢失敗不寫快取**，與 `build_restaurants.GeoCache.lookup` 同一條規則。

        ⚠️ **`br.gsi_search` 自 2026-08-20 起回的是 `(查詢成功?, 結果)` 兩個值**
        （第九十四筆為了「GSI 打一次嗝就把地址永久判死」而改）。這裡當時沒有跟著改，
        於是拿到 tuple 又直接寫進快取——**症狀是加新景點時整支炸掉**
        （`TypeError: tuple indices must be integers`）。既有 67 筆全在快取裡、
        走的是上面那條 `key in self.data`，所以**這個洞躺了整整一天沒被發現**：
        每月的 `places.yml` 只要沒有新地址就照常跑完。同地雷 #19 第 2 點——
        兩支管線共用程式，而沒有任何機制會互相檢查。
        """
        key = br.norm_text(addr)
        if key in self.data:
            self.hits += 1
            return self.data[key]
        ok, g = br.gsi_search(key)
        self.misses += 1
        time.sleep(GSI_WAIT)
        if not ok:
            # 失敗不寫快取，**下一輪本身就是重試**。寫進去等於一次逾時永久放棄。
            self.fails += 1
            return None
        self.data[key] = g
        return g

    def lookup_poi(self, name, lat, lng, addr, accept):
        """OSM 補位。與地址查詢**共用同一個快取檔**（鍵加 `osm:` 前綴）。

        ⚠️ **刻意不開第二個快取檔**（同 `build_restaurants` 那支的理由）：
        公開 repo 的 `places.yml` 是逐項 `git add` 的，新開一個檔就得同時改
        另一個 repo，**而漏改沒有任何警訊**——只會每個月重打 Overpass，
        它又常常回 busy，於是這幾筆的座標每月在「大字中心」與「真正的位置」
        之間跳。同地雷 #19 第 2 點。

        ⚠️ **查詢失敗不寫快取**：Overpass 逾時／502 很常見（2026-08-21 實測
        `overpass.kumi.systems` 連續回 502、`overpass-api.de` 第一次 TLS 握手
        被丟掉、第二次就成功），把那種情況當成「OSM 沒有這個景點」記下來，
        等於一次逾時就永久放棄這一筆。**下個月那一輪本身就是重試。**
        """
        key = 'osm:%s@%.4f,%.4f' % (br.norm_text(name), lat, lng)
        if key in self.data:
            self.osm_hits += 1
            return self.data[key]
        if self.osm_spent >= OSM_TIME_BUDGET_S:
            self.osm_skipped += 1
            return None
        t0 = time.time()
        ok, res = br.osm_poi_search(name, lat, lng, addr,
                                    self.osm_ep_fail, accept)
        self.osm_spent += time.time() - t0
        if not ok:
            # **失敗次數要進統計，不能只有 stderr 的 [warn]**：這條路最可能的
            # 死法就是端點把我們擋掉，而那時管線一切正常、統計照印，
            # 只是永遠救不回任何一筆——沒有人會發現它從來沒生效過。
            self.osm_fail += 1
            return None
        self.osm_calls += 1
        self.data[key] = res
        time.sleep(3.0)          # 對 Overpass 客氣一點（它是免費的共用服務）
        return res

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1, sort_keys=True)


# ═══ 地址 ═══════════════════════════════════════════════════════════

def addr_variants(addr):
    """由細到粗的查詢候選。第一個是原地址，之後逐段砍掉尾巴。

    實測 GSI 對「…2-24-12 渋谷スクランブルスクエア 45F」這種帶大樓與樓層的
    地址處理得很好（餐廳那 3,224 筆快取裡多數都帶大樓名），所以這幾個候選
    平常用不到；留著是為了少數寫法特別的地址，**而且只會往粗的方向退**
    ——退到只剩市區町村時 `title_too_coarse` 會把它降級成 approx，不會假裝很準。
    """
    a = br.norm_text(addr)
    out = [a]
    parts = a.split(' ')
    while len(parts) > 1:
        parts = parts[:-1]
        v = ' '.join(parts)
        if v not in out:
            out.append(v)
    # 再退一步：只留到「數字-數字-數字」為止（砍掉黏在一起沒有空格的大樓名）
    m = re.match(r'^(.*?\d+(?:[-‐-―]\d+)*)', a)
    if m and m.group(1) not in out:
        out.append(m.group(1))
    return out


def geocode(addr, cache):
    """回 (lat, lng, geo, note)。查不到回 (None, None, None, 說明)。

    `geo` 沿用活動與餐廳那套三值語義：
      precise  番地／丁目級（100〜300m 以內），前端畫實心圖釘
      approx   只匹配到市區町村（＝可能是區公所座標），前端畫半透明＋「概略位置」
    """
    first_note = ''
    for i, v in enumerate(addr_variants(addr)):
        g = cache.lookup(v)
        used = v
        # ── 京都的通り名（2026-09-07，單位 S）─────────────────────────
        # `京都府京都市下京区烏丸通七条下る東塩小路町721-1` 這種寫法，
        # `<某>通<某><方位>[入下上][ルる]` 夾在「区」與町名之間。GSI 有兩種下場，
        # **兩種在報表上長得一模一樣**（都是 approx ＋「可能是區公所座標」）：
        #   ①整串解析不下去 → 查無
        #   ②**把通り名當成町名** → 實測京都塔的 title 回「下京区烏丸」，
        #     那是一條路不是町，座標落在真正的塔以北 **600m**
        # **餐廳端 2026-08-29 已修**（`strip_kyoto_street`，40 筆 approx → precise、
        # 0 筆變差），這裡只是把同一支函式接到景點的兩個入口上——
        # **共用不是抄一份**：同一條規則存在兩處，漏改一處的症狀是
        # 「餐廳修好了、景點還歪著」，而兩邊各自看起來都正常。
        # ⚠️⚠️ **只當後備，絕不可無條件改寫。** 實測京都 494 家餐廳裡
        # **有 56 家「已經查得到」也符合這條規則**，其中
        # `東大路通丸太町上ル東側聖護院西町12` 剝完會留下半截的「東側」。
        # 當後備才保證那批一個位元組都不動——同「排在原名之後」那條原則。
        if not g:
            g2, cand = kyoto_stripped(v, cache)
            if g2:
                g, used = g2, cand
        elif br.title_too_coarse(g['title']):
            # ⚠️ **剝完仍然粗就維持原判，寧可掛 approx 也不要猜**
            # （地雷：富岳風穴把小字拿掉會拿到 `precise`，但離真正的風穴 1.85km）。
            g2, cand = kyoto_stripped(v, cache)
            if g2 and not br.title_too_coarse(g2['title']):
                g, used = g2, cand
        if not g:
            if not first_note:
                first_note = '查無此地址'
            continue
        if br.title_too_coarse(g['title']):
            # **不要為了拿到 precise 而繼續往下退**：候選是由細到粗的，
            # 後面只會更粗。這裡就是這個地址能到的最深了。
            return (g['lat'], g['lng'], 'approx',
                    '地址只查到「%s」，可能是區公所座標' % g['title'])
        if used != v:
            note = '剝掉京都的通り名，改查「%s」' % used
        else:
            note = '' if i == 0 else '砍到「%s」才查到' % v
        return g['lat'], g['lng'], 'precise', note
    return None, None, None, first_note or '查無此地址'


def kyoto_stripped(v, cache):
    """剝掉京都的通り名再查一次，回 `(結果, 用的查詢字串)`；不適用回 `(None, '')`。

    ⚠️ **判斷「剝完夠不夠細」留在呼叫端**，因為兩個入口的標準不同：
    原地址查無時，剝完就算仍是町名級也照樣採用（有座標總比沒有好，後面
    會判成 approx）；原地址「查得到但太粗」時，**剝完必須真的變細才換**
    ——不然等於拿一個同樣粗的答案去換另一個，白多打一次 GSI。
    這與 `build_restaurants.py` 那兩個呼叫點是一字對一字的。

    ⚠️ **絕不可以改寫 `rec['address']`**：`id` 是使用者自己填的沒錯，但
    地址是報表與日後校對的依據，而且 `_geocache.json` 以完整地址為鍵。
    這裡回的只是「拿去查的字串」。
    """
    cand = br.strip_kyoto_street(v)
    if not cand:
        return None, ''
    return cache.lookup(cand), cand


# ═══ OSM 補位 ═══════════════════════════════════════════════════════

_PAREN_RE = re.compile(r'[（(][^）)]*[）)]')
_SPLIT_RE = re.compile(r'[ 　・]+')


def osm_place_key(name):
    """景點名 → 拿去 Overpass 比對的關鍵字，取不出就回空字串（＝不查）。

    與餐廳的 `osm_query_key` 是同一件事，但**規則不同，所以另寫一支**：

    1. **先剝掉括號附註**。`亀岩の洞窟(濃溝の滝)` 整串當關鍵字會查不到——
       OSM 那個點叫 `亀岩の洞窟`，多出來的括號讓正規表達式比不中。
       （同 `fetch_events.simplify_venue` 的「查詢用簡化名」那條。）
    2. **`・` 也算分隔**。`横浜・八景島シーパラダイス` 切成
       `横浜` ／ `八景島シーパラダイス`，取後者。
    3. **最長的一段；一樣長就取最後一段。** ⚠️ 這一條與餐廳那支不同，
       而且是必要的：`鋸山 日本寺` 兩段都是 3 個字，取第一段會拿「鋸山」
       去查——那是**一座山**，白名單裡沒有 `natural=peak`（神社寺廟類），
       於是零候選、整筆放棄。日文的「大範圍＋本體」是前者在前，取最後一段才對。

    ⚠️ **太短的一律不查**（同餐廳）：日文 2 字、英文 3 字是下限。
    """
    n = _PAREN_RE.sub(' ', br.norm_text(name))
    segs = [x for x in _SPLIT_RE.split(n) if x]
    segs = [x for x in segs if x not in OSM_PLACE_GENERIC_SEG]
    if not segs:
        return ''
    best = ''
    for x in segs:                      # 最長；一樣長時後面的蓋掉前面的
        if len(x) >= len(best):
            best = x
    if not br.OSM_KEY_SAFE_RE.match(best):
        return ''
    if br.LATIN_ONLY_RE.match(best):
        return best if len(best.replace(' ', '')) >= 3 else ''
    return best if len(best) >= 2 else ''


def osm_accept(genre):
    """回一個 `accept(tags)`：這個 POI 是不是「這個小類」該有的東西。

    白名單查不到（例如日後管線多開一類卻忘了補這張表）就回一個
    **永遠拒絕**的判斷式——那時這條路只是不生效，景點維持 approx。
    **失敗方向是安全的那一邊**，不會掛出一個猜來的座標。
    """
    tags = OSM_PLACE_TAGS.get(genre, set())

    def ok(t):
        return any(t.get(k) == v for k, v in tags)
    return ok


def osm_rescue(rec, cache):
    """GSI 只到大字／町名時，問一次 OSM 有沒有這個景點。

    回 (救到了嗎, 說明)。**救不到就什麼都不動**，那一筆維持 approx。
    """
    key = osm_place_key(rec['title_ja'])
    if not key:
        return False, ''
    g = cache.lookup_poi(key, rec['lat'], rec['lng'], rec['address'],
                         osm_accept(rec['genre']))
    if not g:
        return False, ''
    d = br.meters(rec['lat'], rec['lng'], g['lat'], g['lng'])
    rec['lat'], rec['lng'], rec['geo'] = g['lat'], g['lng'], 'precise'
    # ⚠️ **這個標記要寫進 places.json，不能只留在這一輪的記憶體裡。**
    # 補位成功之後 `geo` 就是 `precise`，下一輪會走「沿用」那條捷徑
    # ——不留下來的話，報表的【OSM 補位】那段**只會出現這一次，之後永遠是空的**，
    # 看起來像這條路沒再生效過。這比完全不記還糟。
    rec['geo_src'] = 'osm'
    return True, 'OSM 補位「%s」，離大字中心 %dm' % (g['name'], round(d))


# ═══ 讀取清單 ═══════════════════════════════════════════════════════

def load_sources():
    """讀 places_src/ 底下所有 .json（`_` 開頭的跳過，範本因此不會被當成資料）。"""
    rows, files = [], []
    if not os.path.isdir(SRC):
        return rows, files
    for name in sorted(os.listdir(SRC)):
        if not name.endswith('.json') or name.startswith('_'):
            continue
        path = os.path.join(SRC, name)
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print('[warn] %s 讀取失敗（跳過）：%s' % (name, e), file=sys.stderr)
            continue
        items = data.get('places') if isinstance(data, dict) else data
        if not isinstance(items, list):
            print('[warn] %s 沒有 places 陣列（跳過）' % name, file=sys.stderr)
            continue
        files.append(name)
        for row in items:
            if isinstance(row, dict):
                row['_src'] = name
                rows.append(row)
    return rows, files


def load_existing():
    """既有 places.json，用來繼承 H2 寫的欄位（見 CARRY）。"""
    if not os.path.exists(OUT):
        return {}
    try:
        with open(OUT, encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print('[warn] 既有 places.json 讀取失敗：%s' % e, file=sys.stderr)
        return {}
    return {p['id']: p for p in data.get('places', []) if p.get('id')}


# ═══ 正規化 ═════════════════════════════════════════════════════════

def resolve_genre(raw):
    """小類字串 → (繁中資料值, 錯誤訊息)。認不得就回錯誤，**絕不猜**。

    與餐廳的「認不得就整筆跳過並列進報表」同一條原則：小類決定圖示與圖例，
    猜錯的後果是地圖上一個景點頂著別類的圖示——**看起來完全正常，只是錯的**。

    `博物館美術館` 這種舊的合併寫法刻意回錯誤而不是二選一：那是使用者以前的
    分法，2026-08-20 拆成兩類了，硬猜等於幫他決定。
    """
    v = br.norm_text(raw or '')
    if not v:
        return '', '缺少必填欄位 genre（小類）'
    hit = _GENRE_LOOKUP.get(v)
    if hit:
        return hit, ''
    if v in GENRE_ALIAS:
        alias = GENRE_ALIAS[v]
        if alias:
            return alias, ''
        return '', ('類別「%s」太籠統（2026-08-20 已拆成「博物館」與「美術館」），請指定其中一個' % v)
    return '', ('類別「%s」不認得，可用：%s' % (v, '／'.join(GENRES)))


def clean_tickets(row):
    """清單裡的 `tickets` → (乾淨的清單, 問題列表)。

    ⚠️ **一筆商品有毛病只丟那一筆，不擋整個景點**——這與 `genre` 認不得就整筆擋下
    是刻意相反的：小類決定圖示，沒有它那個景點在地圖上是錯的；而票券只是加值，
    景點少了它照樣完整。**擋掉整筆的代價（景點從網站上消失）遠大於少一條連結。**

    ⚠️ **但被丟掉的一定要逐筆列進報表。** 靜默丟掉的話，清單裡明明填了連結、
    網站上卻沒有那顆鈕，而畫面上完全看不出來——本專案最貴的教訓全部是這一族。
    """
    raw = row.get('tickets')
    if not raw:
        return [], []
    if not isinstance(raw, list):
        return [], ['tickets 必須是陣列（一個景點可以有好幾件商品）']
    out, bad = [], []
    for i, tk in enumerate(raw):
        where = 'tickets[%d]' % i
        if not isinstance(tk, dict):
            bad.append('%s 不是物件' % where)
            continue
        plat = br.norm_text(tk.get('platform', '')).lower()
        url = br.norm_text(tk.get('url', ''))
        aff = br.norm_text(tk.get('aff_url', ''))
        ttype = br.norm_text(tk.get('type', '')).lower()
        status = br.norm_text(tk.get('status', '')).lower() or 'active'
        if plat not in TICKET_PLATFORMS:
            # 認不得就擋這一筆並說出可用的值，**不猜**——猜錯會讓連結掛在錯的
            # 平台名底下，而使用者要點下去才知道。
            bad.append('%s 平台「%s」不認得，可用：%s'
                       % (where, plat or '(空白)', '／'.join(TICKET_PLATFORMS)))
            continue
        if not url and not aff:
            bad.append('%s 沒有任何網址（url 與 aff_url 都空）' % where)
            continue
        if ttype and ttype not in TICKET_TYPES:
            # ⚠️ 城市／區域 Pass 會落在這裡，**那是刻意的**：Pass 涵蓋好幾個景點，
            # 掛在單一景點底下會讓人以為那是這個景點的門票。要收 Pass 得先想清楚
            # 它掛在哪（行程頁），不是在這裡放行。
            bad.append('%s 票種「%s」不認得，可用：%s' % (where, ttype, '／'.join(TICKET_TYPES)))
            continue
        if status not in TICKET_STATUS:
            bad.append('%s 狀態「%s」不認得，可用：%s' % (where, status, '／'.join(TICKET_STATUS)))
            continue
        rec = {'platform': plat, 'name': br.norm_text(tk.get('name', '')),
               'type': ttype or 'admission', 'url': url, 'aff_url': aff,
               'status': status}
        if tk.get('primary'):
            rec['primary'] = True
        chk = br.norm_text(tk.get('checked', ''))
        if chk:
            rec['checked'] = chk
        out.append(rec)
    # 同一個平台有好幾件時，**最多只有一件能是主要的**。兩件都標的話畫面上會
    # 看哪一件先出現而定——那是一個「看起來正常但每次都可能不一樣」的結果。
    for plat in TICKET_PLATFORMS:
        mains = [r for r in out if r['platform'] == plat and r.get('primary')]
        if len(mains) > 1:
            bad.append('平台 %s 有 %d 件都標了 primary，只能有一件' % (plat, len(mains)))
            for r in mains[1:]:
                r.pop('primary', None)
    return out, bad


def normalize(row, prev, cache, recheck, no_osm=False):
    """一筆清單 → (輸出記錄, 問題列表)。問題非空就代表這筆不會輸出。"""
    bad = []
    osm_note = ''
    rec = {}
    for k in ('id', 'title', 'title_ja', 'address', 'url',
              'venue', 'venue_ja', 'img', 'hours_url'):
        rec[k] = br.norm_text(row.get(k, ''))
    # 票券（單位 M）。⚠️ **問題不進 `bad`**：`bad` 非空代表整筆不輸出，
    # 而一條壞掉的票券連結不該讓一個景點從網站上消失（見 clean_tickets 的說明）。
    # 它走自己的路進報表。
    rec['tickets'], rec['_ticket_bad'] = clean_tickets(row)
    # 「這個景點本來就沒有常規營業時間」（例：東京晴空塔逐日公告、官網自己寫
    # 「隨時可能變更恕不另行通知」）。**與「抓不到」是兩件事，必須分開。**
    # 混在一起的話，報表上那句「連續 N 次抓不到」每個月都會為同一筆亮一次，
    # 而永遠在響的警報等於沒有警報——真正壞掉的那筆會淹在裡面。
    rec['no_hours'] = bool(row.get('no_hours'))
    # 「這個景點是世界遺產的構成資產」。**與小類 `genre` 正交**——一個景點可以
    # 同時是「公園庭園」和世界遺產，所以它是旗標不是第八個小類。
    # ⚠️ **刻意只存布林、不存「屬於哪一項」**：登錄名稱（`日光の社寺`）只有日文，
    # 存了就變成一個沒有繁中的資料值，與地雷 #7b「資料值一律繁中」打架；
    # 而且同一個欄位會同時扛「是不是」與「是哪一個」兩件事。日後真要顯示
    # 名稱，另開第二個欄位即可，不衝突。
    rec['world_heritage'] = bool(row.get('world_heritage'))

    for k in REQUIRED:
        if not rec[k]:
            bad.append('缺少必填欄位 %s' % k)
    if rec['id'] and not ID_RE.match(rec['id']):
        bad.append('id「%s」不合規則（要 pl- 開頭 ＋ 小寫英數連字號）' % rec['id'])
    # 小類：**必填、單選、認不得就擋下**（使用者 2026-08-20 決定）。
    # 擋下而不是留空，理由與座標查不到一樣——沒有小類的景點在圖例上無處可歸，
    # 而圖釘會頂著一個沒有圖示的空殼，看起來像程式壞了。
    genre, gerr = resolve_genre(row.get('genre'))
    if gerr:
        bad.append(gerr)
    else:
        rec['genre'] = genre
        rec['genre_ja'] = GENRES[genre]
    if bad:
        return rec, bad

    # venue 沒填就沿用名稱本身（多數景點就是那棟建築）。
    # ⚠️ **venue_ja 不只是顯示文字**：mapQuery() 拿的就是它，而行程路線的
    # Google 地圖網址是用它組的。空著會讓導航查詢變成空字串。
    if not rec['venue']:
        rec['venue'] = rec['title']
    if not rec['venue_ja']:
        rec['venue_ja'] = rec['title_ja']

    pref, city = br.parse_address(rec['address'])
    area = br.area_of(pref, city)
    # 兩種原因分開講：地址解析得出來只是不在範圍內（大阪的景點）＝**預收**；
    # 解析不出來（地址只寫到縣級或根本沒寫）＝該修的資料缺陷。
    if not area and not (pref and city):
        bad.append('地址解析不出縣或市區町村：%s' % rec['address'])
        return rec, bad
    if not area:
        # ── 預收（2026-08-22，使用者決定）─────────────────────────────
        # 範圍外的景點**先收進來、照樣查座標，只是不輸出到 places.json**。
        # ⚠️ **舊版在這裡就 return，於是連一次 GSI 都不會打**——資料會安安靜靜
        # 躺在 places_src/ 裡，地址對不對沒有任何人驗過，直到地區桶開通那天
        # 才一次爆出一堆問題，而當初查資料的脈絡早就沒了。
        # 現在照查，換到的兩件事：①地址現在就被驗證（查不到會進【擋下】）
        # ②座標寫進 _geocache.json（以完整地址為鍵），**開通那天重跑是 0 次查詢、
        # 立刻上線**。
        # `bad` 仍然非空，所以它不會進 places.json——這一點與舊版完全相同。
        rec['_pending'] = '%s %s' % (pref, city)
        bad.append('%s（%s）' % (PENDING_TAG, rec['_pending']))
    rec['area'] = area
    rec['type'] = PLACE_TYPE

    # 座標：既有的 precise 且版本相同就沿用（與餐廳、活動同一個增量規則）。
    old = prev.get(rec['id'])
    if (not recheck and old and old.get('geo') == 'precise'
            and old.get('build_v') == BUILD_VERSION
            and br.norm_text(old.get('address', '')) == rec['address']):
        rec['lat'], rec['lng'], rec['geo'] = old['lat'], old['lng'], 'precise'
        # 沿用座標就要一起沿用「這個座標是怎麼來的」。漏了它等於每個月
        # 在報表上把一筆推論來的座標洗成一般的 precise。
        if old.get('geo_src'):
            rec['geo_src'] = old['geo_src']
        note = ''
        reused = True
    else:
        lat, lng, geo, note = geocode(rec['address'], cache)
        reused = False
        if lat is None:
            # **查不到座標就不輸出。** 沒有座標的景點在行程裡會讓距離計算變 NaN、
            # 排序與地圖全部失效——寧可它不出現、報表上叫人去修地址。
            # 景點只有幾十筆，人工修得動；活動有幾百筆才需要「退回地區中心」那套。
            bad.append('查不到座標（%s）' % note)
            return rec, bad
        rec['lat'], rec['lng'], rec['geo'] = lat, lng, geo
        # GSI 只到大字／町名時的最後一手：問 OSM 有沒有這個景點。
        # ⚠️ **只在 approx 時才問**——precise 已經是番地級，再問一次只會
        # 多打一次 Overpass、還多一個「猜錯」的機會。
        # ⚠️ **預收的不問 OSM，這不是省事是防撞。** Overpass 有一道 240 秒的
        # 全域時間預算（OSM_TIME_BUDGET_S），用完就跳過剩下的。預收可能有幾百筆，
        # 讓它們跟真的會顯示在地圖上的景點搶同一個預算，結果會是
        # **在地圖上的那幾筆 approx 被跳過、永遠留在概略位置**，而報表只會說
        # 「時間預算用完跳過 N 筆」——看不出來是被預收擠掉的。
        # 預收現在需要的是「地址對不對」（GSI 那一段已經給了），不是圖釘精度。
        # 等地區桶開通，它們就變成 in-range，那時自然會走這條路。
        if geo == 'approx' and not no_osm and not rec.get('_pending'):
            hit, why = osm_rescue(rec, cache)
            if hit:
                osm_note = why
                # ⚠️ **舊的 note 一定要清掉。** 它是「地址只查到某某大字，可能是
                # 區公所座標」，而座標已經被換成 OSM 的了——留著它，報表的
                # 【參考】那段（條件是 `_note` 非空且 `geo=='precise'`）會把這 6 筆
                # 全部列成「查詢時砍過地址才查到」，**配上一句已經不成立的說明**。
                # 這一筆的故事由【OSM 補位】那段負責講。
                note = ''

    rec['build_v'] = BUILD_VERSION
    # H2 的欄位一律從既有輸出繼承（本程式不產生它們）
    for k in CARRY:
        if old and old.get(k):
            rec[k] = old[k]
    # 標了「本來就沒有」就把失敗計數清掉。**要清在這裡不是清在 run_hours**，
    # 否則不帶 --hours 的那條路（使用者本機加景點）會讓舊計數一直掛著，
    # 標記之後看起來像沒生效。
    if rec['no_hours']:
        rec.pop('hours_fail', None)
        # ⚠️ **連舊的營業時間一起清掉。** 前端根本不讀 `no_hours`（它只看有沒有 `hours`），
        # 所以留著上次抓到的值等於「標了完全沒有效果」——畫面照樣顯示那串舊資料。
        # 新江之島水族館就是這樣：官網只有一張逐期日期表，標了 no_hours 卻還掛著
        # 「8月16日～8月31日 9:00～18:00…」被截斷的半句話。
        for k in ('hours', 'holiday', 'hours_checked', 'hours_tried'):
            rec.pop(k, None)
    rec['_note'] = note
    # ⚠️ **OSM 補位要獨立記一欄、報表要逐筆列出。** 它救回來的那幾筆 `geo`
    # 是 `precise`，混進一般的 precise 裡就**沒有任何地方看得出這一筆走過推論
    # 這條路**——而這條路是「名稱比對＋剛好一個」，比 GSI 的番地級弱一階。
    rec['_osm'] = osm_note
    rec['_reused'] = reused
    rec['_pref'] = pref
    rec['_src'] = row.get('_src', '')
    # ⚠️ **一定要回 `bad` 而不是寫死 `[]`。** 舊版寫死是因為當時每一條失敗路徑
    # 都提早 return，走到這裡的 bad 必定是空的——**但那是巧合不是保證**。
    # 2026-08-22 加預收時就踩到了：範圍外那條刻意不提早 return（要繼續查座標），
    # 訊息 append 進 bad 之後在這裡被整個丟掉，於是三筆京都大阪的景點
    # **帶著空字串的 area 一路寫進 places.json**，統計上還顯示「輸出 108 筆」。
    # 同 build_restaurants.py 的 `status` 曾被寫死成「營業中」——**寫死而不從
    # 變數讀，就是在賭日後沒有人新增分支。**
    return rec, bad


def out_record(rec):
    """輸出檔的欄位與順序。底線開頭的內部欄位不輸出。

    ⚠️ **日期欄位一個都不寫**（連空字串都不給，H-24）：前端 `ev.date_end<todayStr()`
    在 undefined 時為 false，不會誤標「已結束」；而捏一個 9999-12-31 那種假值
    會跟著景點跑進日後每一處讀日期的地方，且永遠看起來合法。
    """
    o = {'id': rec['id'], 'type': rec['type'],
         'genre': rec['genre'], 'genre_ja': rec['genre_ja'],
         'title': rec['title'], 'title_ja': rec['title_ja'],
         'venue': rec['venue'], 'venue_ja': rec['venue_ja'],
         'area': rec['area'], 'lat': rec['lat'], 'lng': rec['lng'],
         'geo': rec['geo'], 'img': rec['img'], 'url': rec['url'],
         'build_v': rec['build_v'], 'address': rec['address']}
    # 票券（單位 M）。**空的就整個欄位不寫**（同 no_hours／world_heritage）——
    # 177 筆裡多數暫時沒有商品，補一個空陣列只會讓檔案變大。
    if rec.get('tickets'):
        o['tickets'] = rec['tickets']
    if rec.get('hours_url'):
        o['hours_url'] = rec['hours_url']
    if rec.get('no_hours'):
        o['no_hours'] = True
    # 只在 true 時寫出去（同 no_hours）。**不寫 false**——105 筆裡只有 5 筆是，
    # 補上 100 個 `false` 只會讓檔案變大而且每一筆都要多讀一行才知道「不是」。
    if rec.get('world_heritage'):
        o['world_heritage'] = True
    if rec.get('geo_src'):
        # 目前只有 'osm' 一種。前端不讀它，它是給報表與人看的來源標記。
        o['geo_src'] = rec['geo_src']
    for k in CARRY:
        if rec.get(k):
            o[k] = rec[k]
    return o


# ═══ 營業時間（H2）═══════════════════════════════════════════════════
#
# 每月一次去景點官網抓「常規營業時間」與「公休日」。**只在 --hours 時執行。**
#
# 抓取與抽取兩段都沿用 fetch_events.py 已經跑了幾個月的東西（H-35）：軟性 404 判讀、
# LLM 遞補鏈（Gemini → GitHub Models）、回應解析與模型淘汰規則。零新金鑰、零新依賴。
#
# ⚠️ **抽錯與抽對在畫面上長得一模一樣**（計畫書 H-22 已記，使用者知情）。
# 所以這一段的每一道守門都是為了「寧可沒有，不要錯的」：抽不到就空字串、
# 頁面上找不到那個時刻就整個丟掉、只取常規的不取臨時公告。
# **空字串的後果只是畫面上不顯示營業時間（H1 本來就是這樣）；錯的後果是使用者白跑一趟。**


def fetch_page(url):
    """Jina Reader 抓純文字。回 None 代表這次抓不到（保留舊值，不清空）。

    ⚠️ **刻意不直接用 fe.fetch_page_text()，差別只有一個字數上限，但那個上限是關鍵。**
    活動來源頁 40,000 字綽綽有餘（那是列表頁，活動就在前段）；景點官網不是——
    實測 teamLab 首頁整頁 139,657 字，而營業時間在第 115,405 個字，
    用 40,000 去截**永遠抓不到，而且失敗長得像「這一頁沒寫營業時間」**。
    死連結與 HTTP 錯誤的判讀仍然是 fetch_events 那一套（那才是有 know-how 的部分）。
    """
    # ⚠️ **`x-locale` 一定要送。** 這是 Jina 自己的參數，用來設定它那台無頭瀏覽器的語系；
    # 不送的話它看起來就是個美國來的訪客，**多語系網站會回英文版**——實測上野動物園
    # 拿回來的是「9:30am - 5:00pm」「Closed on Mondays (If Monday is a national holiday…)」，
    # 而同一個網址自己 curl 是日文。模型照抄原文沒有錯，錯在餵給它的就是英文。
    # 後果不只是語言：英文寫法長得多，公休日 201 字直接撞上 HOLIDAY_MAX 被截斷。
    # （註：`Accept-Language: ja` 沒有用，那是給來源站看的，Jina 不會轉送。）
    headers = {'User-Agent': 'Mozilla/5.0', 'x-locale': 'ja-JP'}
    if fe.JINA_API_KEY:
        headers['Authorization'] = 'Bearer ' + fe.JINA_API_KEY
    for attempt in range(HOURS_RETRY):
        try:
            text = fe.http_get('https://r.jina.ai/' + url, timeout=90, headers=headers)
            # 軟性 404（HTTP 200 的「找不到頁面」）是日文網站的常態，長度檢查完全擋不住。
            if fe.is_dead_page(text):
                print('  [hours] 頁面是死連結或錯誤頁：%s' % url)
                return None
            if len(text.strip()) > 200:
                code = fe.source_http_error(text)
                if code:
                    # 429／403／5xx 只是被限速或暫時故障，Jina 這時往往仍拿得到內容（地雷 #6d）。
                    print('  [hours] 來源站回 HTTP %s，但已取得 %d 字，照常使用' % (code, len(text)))
                return text[:HOURS_PAGE_CHARS]
            print('  [hours] 內容過短（%d 字），重試' % len(text))
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            print('  [hours] Jina 抓取失敗（%d/%d）：%s' % (attempt + 1, HOURS_RETRY, e))
        if attempt < HOURS_RETRY - 1:
            time.sleep(fe.RETRY_WAIT)
    return None


# 節錄用的關鍵字。**寧寬勿窄**：多命中幾段只是節錄長一點，漏掉就整筆抓不到。
# 英文也要收——雖然 `fetch_page` 已改送 `x-locale: ja-JP`（多數站因此回日文），
# 但本來就只有英文版的頁面還是存在，而且那個 header 哪天失效時，
# 這份清單是唯一還撐得住的東西。
HOURS_KEY_RE = re.compile(
    r'営業時間|開館|閉館|開園|閉園|開門|閉門|開堂|拝観|入館|入園|入場|開場|'
    # ⚠️ **展望室這類設施用的是「室」不是「館／園」**（2026-08-21）。少了這四個詞，
    # 東京都廳展望室那一頁雖然明明白白寫著「開室時間 9時30分～22時00分」，
    # 節錄卻只撈得到展望室**裡面那幾家店舖**的「営業時間」——於是模型看到的素材
    # 從頭到尾都是店舖的時間。**它連續失敗 5 次，而 hours_url 其實一直是對的那一頁。**
    r'開室|閉室|休室|入室|'
    r'最終受付|受付時間|利用時間|営業日|休館|休園|休業|定休|休み|無休|'
    r'opening\s*hours?|open\s*hours?|business\s*hours?|closing|closed|admission',
    re.I)


def hours_excerpt(text):
    """整頁 → 只留關鍵字前後那幾段。

    **不是為了省錢，是為了抓得到。** 官網動輒十幾萬字（導覽列、活動輪播、頁尾、
    多語系選單），整頁送進去會讓真正那一行淹在雜訊裡，而且一定超過模型的胃口。
    一個關鍵字都沒命中時退回開頭那一段——寧可讓模型自己看一眼，
    也不要在這裡就替它判定「這頁沒寫」。
    """
    spans = []
    for m in HOURS_KEY_RE.finditer(text):
        a, b = max(0, m.start() - HOURS_WINDOW), min(len(text), m.end() + HOURS_WINDOW)
        if spans and a <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], b)      # 重疊就併起來，不要切成一堆碎片
        else:
            spans.append([a, b])
    if not spans:
        return text[:HOURS_EXCERPT_MAX]
    out, total = [], 0
    for a, b in spans:
        chunk = text[a:b][:HOURS_EXCERPT_MAX - total]
        out.append(chunk)
        total += len(chunk)
        if total >= HOURS_EXCERPT_MAX:
            break
    return '\n……\n'.join(out)


def hours_prompt(rec, excerpt):
    return """你是營業時間抽取器。以下是日本景點「%s」官方網站的節錄，
請抽出這個景點的**常規**營業時間與公休日。

規則：
1. **照抄原文，不要翻譯、不要改寫、不要換算格式。**
   網頁寫「午前9時～午後5時」就照抄「午前9時～午後5時」，不要改成「9:00-17:00」。
   網頁是英文就照抄英文。
2. hours：常規的營業／開館／開門時間。季節或月份不同時一起寫進來
   （例：「9:00～17:00（10月～3月は9:30～16:30）」）。最終入場時間可以帶上。
   **最多 %d 字**，超過就只留最主要的那一段。
   ⚠️ **一定要寫出具體時刻。** 只有說明句不算——例如「日の出、日の入りにあわせて
   毎月変わります」「季節により異なります」，那種情況請往下找頁面上**實際列出的時間**
   （例如逐月列出的「8月 午前5時00分～午後6時00分」），真的找不到才填空字串。
   ⚠️ **只抄時間本身，不要連句尾一起抄。** 頁面寫「午前6時～午後5時となっております。」
   請寫成「午前6時～午後5時」。
3. holiday：公休日（例：「月曜日」「年中無休」「12月29日～1月1日」）。**最多 %d 字**。
   頁面沒寫就填空字串，**不要因為「這種設施大概都休週一」就自己補**。
4. **只要常規的。** 臨時休館、設備検査による休館、特別開館、活動期間限定的延長營業、
   某個特展專屬的時間，一律不要——本程式一個月才跑一次，臨時公告寫進去多半已經過期，
   而過期的公告比沒有更糟。
5. 這一頁若同時寫了好幾個設施（展望台、餐廳、商店、附設美術館）的時間，
   只取**景點本體**那一個。分不出來就填空字串。
6. **抽不到就填空字串，絕對不要猜、不要用常識補。**
   空字串的後果只是畫面上不顯示營業時間（本來就是這樣），猜錯的後果是使用者白跑一趟。
7. 只輸出 JSON 陣列，裡面固定一個物件：[{"hours": "...", "holiday": "..."}]，
   不要任何其他文字。

網頁節錄：
%s""" % (rec['title_ja'], HOURS_MAX, HOLIDAY_MAX, excerpt)


_SPACE_RE = re.compile(r'\s+')
# 時刻的兩種寫法：日文的「9時」「9時30分」，與數字的「9:30」。
# ⚠️ **數字那種一定要有兩位分鐘，而且冒號前後不准有空白。** 少了這個限制，
# Jina 產出的 markdown 圖片標記 `[Image 62: 雷門側動画]` 會被當成「62 時」——
# 實測淺草寺那一頁因此多出 07: 08: 11: 30: … 61:～74: 一整排假時刻，
# 於是一組完全捏造的營業時間（午前11時～午後8時）**照樣通過驗證**。
# 這種假時刻在別的地方看不出來：頁面確實「有」那個字串，只是它不是時間。
_TIME_RE = re.compile(r'\d{1,2}\s*時(?:\s*\d{1,2}\s*分)?|\d{1,2}:\d{2}')


def _time_key(s):
    """把時刻寫法拉平成同一種：`9時30分`／`9 : 30`／全形數字 全部變 `9:30`。"""
    t = unicodedata.normalize('NFKC', s).replace('時', ':').replace('分', '')
    return _SPACE_RE.sub('', t)


def _times(s):
    """一段文字裡出現過的所有時刻（已拉平）。先做 NFKC，全形寫法才比得中。"""
    return {_time_key(m) for m in _TIME_RE.findall(unicodedata.normalize('NFKC', s))}


def hours_grounded(value, page):
    """抽出來的時間，頁面上真的找得到嗎？

    **這是擋幻覺唯一划算的一道。** 時間是客觀的：頁面上從未出現過的時刻，
    一定不是從這一頁抄來的。比對「時刻」而不是整串，因為模型會把表格拼成一句話、
    會把全形改半形——整串比對會把正確的也一起殺掉。
    一個時刻都沒有的「營業時間」（例如只回了一句說明文）同樣不算數。

    ⚠️ **一定要逐個時刻比對，不可以把整頁拉平成一個字串去找子字串。**
    那樣「8時」會在頁面的「18:00」裡命中。這條與上面 `_TIME_RE` 的註解是同一次
    實測抓出來的：兩個漏洞疊在一起時，捏造的營業時間 100% 通過。
    允許「頁面比較細」（頁面 6:30 對得上抽到的 6時），因為模型偶爾會少抄「分」；
    反過來不允許，那是憑空多出來的資訊。
    """
    want = _times(value)
    if not want:
        return False
    have = _times(page)
    return any(any(pt == vt or pt.startswith(vt) for pt in have) for vt in want)


# 截在這些字元後面就不會把一個詞切成兩半。由「句子」到「詞」由粗到細排。
_CLIP_AT = ('。', '\n', '）', ')', '、', '，', '. ', ', ', '・', ' ')


def _clip(s, limit):
    """超過上限就截斷，**但要截在斷點上並留一個省略號**。

    ⚠️ 硬切會切在單字中間，而那在畫面上**看起來像資料壞了**、不像被截斷。
    實測上野動物園的公休日 201 字，切在 80 字剛好停在
    「…substitute holiday, the pa」——沒有人看得出那是我們主動截的。
    找不到斷點時（極長的無標點字串）才退回硬切，至少省略號還在。
    """
    cut = s[:limit]
    best = -1
    for sep in _CLIP_AT:
        i = cut.rfind(sep)
        if i > best:
            best, sep_len = i, len(sep)
    if best >= limit // 2:                     # 太前面的斷點寧可不用，會丟掉太多內容
        cut = cut[:best + sep_len]
    return cut.strip().rstrip('、，,・') + '…'


def extract_hours(chain, rec, page):
    """回 (hours, holiday, note)。兩個都空代表這次沒抽到（呼叫端會當成失敗）。"""
    got = fe.llm_extract(chain, hours_prompt(rec, hours_excerpt(page)))
    if not got or not isinstance(got[0], dict):
        return '', '', '模型沒有回傳可用的結果'
    # 型別先擋一次：模型偶爾會回巢狀物件或陣列，而 holiday 沒有「時刻」可驗，
    # 不擋的話一個 dict 會被 str() 成一串大括號直接寫進畫面。
    def _s(v):
        return br.norm_text(v) if isinstance(v, str) else ''
    hours = _s(got[0].get('hours'))
    holiday = _s(got[0].get('holiday'))
    notes = []
    if hours and not hours_grounded(hours, page):
        # **丟掉而不是留著存疑**：留著就是把一個看起來很正經的錯誤放到畫面上。
        notes.append('抽到的營業時間「%s」在頁面上找不到對應的時刻，已丟棄' % hours[:40])
        hours = ''
    if len(hours) > HOURS_MAX:
        notes.append('營業時間過長（%d 字）已截斷' % len(hours))
        hours = _clip(hours, HOURS_MAX)
    if len(holiday) > HOLIDAY_MAX:
        notes.append('公休日過長（%d 字）已截斷' % len(holiday))
        holiday = _clip(holiday, HOLIDAY_MAX)
    return hours, holiday, '；'.join(notes)


def run_hours(recs, chain):
    """每輪抓 HOURS_PER_RUN 筆「最久沒輪到過的」景點的營業時間。就地改 recs。

    三條規則都直接對應 H-38：
      **抓不到 → 保留上次的值**（不清空）。失敗多半是暫時的，而清空會讓畫面上
      「這個月有下個月沒有」地閃爍，看起來就像網站壞掉。
      **逐欄保留**：這次抽到 hours 沒抽到 holiday，就只更新 hours、holiday 留舊的。
      模型每個月的措辭本來就會浮動，跟著它清掉等於製造假異動。
      **連續 HOURS_FAIL_ALERT 次（＝2 個月）抓不到才提醒，而且只提醒在 log，畫面完全不變。**

    ── 分批（單位 あ-1，2026-09-04）────────────────────────────────
    形狀抄 fetch_events 的 `reverify_coords()`（單位 T-4）：挑最久沒輪到的 N 筆、
    加一個時間預算閘、乾淨收工。**但排隊絕對不可以用 `hours_checked`。**

    ⚠️⚠️ `hours_checked` 的意思是「這天我確認過內容還是這樣」，所以
    **抓失敗時它刻意不更新**（H-38，就在下面那段）。拿它排隊的話，那幾筆
    穩定抓不到的（實測 5 筆已連續失敗 5 次、5 筆 2 次）會**永遠釘在佇列最前面**、
    每輪重試、永遠不讓位，後面的人一輩子輪不到——**而統計會顯示
    「這輪抓了 N 筆」，看起來跟正常輪替一模一樣**。
    `reverify_coords` 沒踩到這個，是因為它的失敗是**偶發的網路逾時**；
    這邊的失敗是**穩定的資料問題**（沒填 `hours_url`、首頁抽不到）。

    故另開 `hours_tried`＝「這輪有沒有輪到過」，**成功失敗一律更新**，排隊只看它。
    兩個意思就給兩個欄位，同 `url`／`aff_url`、`geo_v`／`geo_rv`。
    """
    info = {'ok': 0, 'fail': 0, 'kept': 0, 'alert': [], 'got': [], 'notes': [],
            'lost': [], 'skip': [], 'pool': 0, 'never': 0, 'queued': 0,
            'budget_stop': False}
    pool = []
    for rec in recs:
        if rec.get('no_hours'):
            # 標了就整筆跳過：不抓、不呼叫模型、**不計失敗次數**。
            # 舊計數在 normalize() 就清掉了（那條路不管帶不帶旗標都會走到）。
            # ⚠️ 它們也**不進母體**，否則進度會永遠停在「還有 40 筆沒輪到」。
            info['skip'].append(rec)
            continue
        pool.append(rec)
    # 沒輪到過的排最前面（空字串字典序最小），其餘照上次輪到的日期由舊到新。
    pool.sort(key=lambda r: r.get('hours_tried') or '')
    info['pool'] = len(pool)
    queue = pool[:HOURS_PER_RUN]
    info['queued'] = len(queue)
    t0 = time.time()
    for i, rec in enumerate(queue):
        if time.time() - t0 > HOURS_BUDGET_SEC:
            info['budget_stop'] = True
            print('  [hours] 時間預算 %d 分鐘用完，這輪停在第 %d／%d 筆；'
                  '沒輪到的下一輪會排在最前面'
                  % (HOURS_BUDGET_SEC // 60, i, len(queue)))
            break
        if i:
            time.sleep(PLACE_WAIT)
        # ⚠️ **不管成功或失敗都要蓋上「這輪輪到過」**，這正是它與 hours_checked
        # 分成兩欄的全部理由（見上方 docstring）。
        rec['hours_tried'] = fe.TODAY.isoformat()
        # hours_url 沒填就退回官網首頁（H-32）。首頁多半抽不到，但那是資料問題，
        # 報表會列出來讓人去補 hours_url，不是程式該猜的事。
        url = rec.get('hours_url') or rec['url']
        page = fetch_page(url)
        hours = holiday = ''
        note = '抓不到頁面'
        if page is not None:
            hours, holiday, note = extract_hours(chain, rec, page)
        had = bool(rec.get('hours') or rec.get('holiday'))

        if not hours and not holiday:
            n = int(rec.get('hours_fail') or 0) + 1
            rec['hours_fail'] = n
            info['fail'] += 1
            if had:
                info['kept'] += 1
            if n >= HOURS_FAIL_ALERT:
                info['alert'].append((rec, n, note))
                print('  [hours] ⚠ %s 連續 %d 次抓不到（%s）；畫面維持上次的值不變'
                      % (rec['title'], n, note or '沒有找到營業時間'))
            info['notes'].append((rec, note or '沒有找到營業時間'))
            continue

        info['ok'] += 1
        rec.pop('hours_fail', None)
        before = (rec.get('hours', ''), rec.get('holiday', ''))
        if hours:
            rec['hours'] = hours
        elif rec.get('hours'):
            info['lost'].append((rec, '這次沒抽到營業時間，沿用上次的'))
        if holiday:
            rec['holiday'] = holiday
        elif rec.get('holiday'):
            info['lost'].append((rec, '這次沒抽到公休日，沿用上次的'))
        # 查核日：**成功就更新**。它的意思是「這天我確認過還是這樣」，
        # 所以即使內容一字未改也要蓋新的（畫面上印的就是這個日期）。
        rec['hours_checked'] = fe.TODAY.isoformat()
        if note:
            info['notes'].append((rec, note))
        if (rec.get('hours', ''), rec.get('holiday', '')) != before:
            info['got'].append(rec)
    # ⚠️ **在跑完之後才算**：這個數字要回答的是「還剩幾筆沒輪到過」，
    # 跑之前算的話永遠等於母體扣掉上個月的量，看不出這一輪推進了多少。
    info['never'] = sum(1 for r in pool if not r.get('hours_tried'))
    return info


# ═══ 主流程 ═════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='不寫 places.json（快取照存）')
    ap.add_argument('--recheck', action='store_true', help='強制重查全部座標')
    ap.add_argument('--hours', action='store_true',
                    help='連營業時間一起抓（要 LLM 金鑰；每月的 workflow 用這個）')
    ap.add_argument('--no-osm', action='store_true',
                    help='跳過 OSM 補位（只影響 GSI 判成概略位置的那幾筆）')
    args = ap.parse_args()

    rows, files = load_sources()
    print('[places] 讀入 %d 個清單檔、%d 筆景點' % (len(files), len(rows)))
    if not rows:
        print('[places] places_src/ 底下沒有清單，沒有東西可做')
        return 0

    # ── id 撞名：**中止，不自動改名**（H-31）───────────────────────
    # 撞名＝兩個景點合而為一，而且畫面上看不出來（其中一個就是不見了）。
    # 這與 inherit_ids 寧可放棄沿用也要避開撞號是同一條理由。
    seen = {}
    dup = []
    for r in rows:
        i = br.norm_text(r.get('id', ''))
        if not i:
            continue
        if i in seen:
            dup.append((i, seen[i], r.get('_src', '')))
        seen[i] = r.get('_src', '')
    if dup:
        print('[places] ⛔ id 撞名，已中止（沒有寫出任何檔案）：', file=sys.stderr)
        for i, a, b in dup:
            print('         %s  同時出現在 %s 與 %s' % (i, a, b), file=sys.stderr)
        return 2

    prev = load_existing()
    cache = Cache(CACHE_PATH)
    recs, blocked, pending = [], [], []
    for row in rows:
        rec, bad = normalize(row, prev, cache, args.recheck, args.no_osm)
        if bad:
            # ⚠️ **「只是範圍外」與「範圍外而且還有別的毛病」要分開。**
            # 後者（例如大阪那筆的地址查不到座標）必須留在【擋下】逐筆列出，
            # 否則它會躲進【預收】那段的統計數字裡，而那段刻意不逐筆列。
            real = [b for b in bad if not b.startswith(PENDING_TAG)]
            entry = (rec.get('id') or '(無 id)', rec.get('title')
                     or rec.get('title_ja') or '(無名稱)',
                     row.get('_src', ''), bad)
            if real:
                blocked.append(entry)
            else:
                rec['_src'] = row.get('_src', '')
                pending.append(rec)
        else:
            recs.append(rec)
    cache.save()

    # ── 照片：填了檔名但檔案不在 ＝ 破圖。**這是資料錯誤，不是空狀態** ──
    # 前端刻意用「img 留空＝還沒拍」表示正常空狀態，所以填了卻沒放檔案
    # 是唯一會出現破圖的路。在這裡抓，比在瀏覽器上看到破圖早得多。
    missing_photo = [r for r in recs
                     if r['img'] and not os.path.exists(os.path.join(PHOTO_DIR, r['img']))]

    recs.sort(key=lambda r: r['id'])

    # ── 票券（單位 M）。**被丟掉的商品要逐筆列進報表** ──
    # 清單裡填了連結、網站上卻沒有那顆鈕，而畫面上完全看不出來——
    # 靜默丟掉是本專案最貴的那一族錯誤。⚠️ 預收的那些也要一起收，
    # 否則地區桶開通那天才發現票券填錯，當初查資料的脈絡早就沒了。
    ticket_bad = []
    for r in recs + pending:
        for b in r.get('_ticket_bad') or []:
            ticket_bad.append((r.get('title') or r.get('id') or '(無名稱)',
                               r.get('id', ''), b))

    # ── 營業時間（H2）。**只有 --hours 才做**，見檔頭說明。────────────
    hours_info = None
    if args.hours:
        chain = fe.build_provider_chain()
        if not chain:
            # ⚠️ **沒有金鑰時什麼都不要做，尤其不要把 hours_fail 全部加一。**
            # 那會讓「連續 2 次抓不到」的提醒在完全正常的情況下被觸發，
            # 而真正該提醒的那幾筆就淹在裡面了。
            print('[places] --hours 但沒有可用的 LLM 金鑰，這次不抓營業時間（既有的值原封不動）')
        else:
            todo = len([r for r in recs if not r.get('no_hours')])
            print('[places] 開始抓營業時間（母體 %d 筆，這輪最多 %d 筆、每筆間隔 %d 秒、'
                  '時間預算 %d 分鐘；另有 %d 筆已知沒有而跳過）'
                  % (todo, HOURS_PER_RUN, PLACE_WAIT, HOURS_BUDGET_SEC // 60,
                     len(recs) - todo))
            hours_info = run_hours(recs, chain)

    out = {'schema_version': SCHEMA_VERSION,
           'build_version': BUILD_VERSION,
           'count': len(recs),
           'places': [out_record(r) for r in recs]}
    # **刻意沒有時間戳**：產出要是決定性的（輸入沒變就逐位元組相同），
    # 否則每月排程都會 commit 一次、觸發一次 Cloudflare 建置（額度每月 500 次）。
    body = json.dumps(out, ensure_ascii=False, indent=1, sort_keys=False) + '\n'

    changed = True
    if os.path.exists(OUT):
        with open(OUT, encoding='utf-8') as f:
            changed = f.read() != body
    if args.dry_run:
        print('[places] --dry-run：不寫檔（%s）' % ('內容有變動' if changed else '內容無變動'))
    elif changed:
        with open(OUT, 'w', encoding='utf-8') as f:
            f.write(body)
        print('[places] 已寫出 places.json')
    else:
        print('[places] 內容無變動，不覆寫（不觸發部署）')

    approx = [r for r in recs if r['geo'] == 'approx']
    # ⚠️ **判準是 `geo_src` 不是 `_osm`**：`_osm` 只有「這一輪真的去查了」才有值，
    # 而補位成功的下一輪就走沿用捷徑了。用 `_osm` 的話這段每個月都是空的。
    osm_hit = [r for r in recs if r.get('geo_src') == 'osm']
    reused = [r for r in recs if r.get('_reused')]
    by_area = {}
    by_genre = {}
    for r in recs:
        by_area[r['area']] = by_area.get(r['area'], 0) + 1
        by_genre[r['genre']] = by_genre.get(r['genre'], 0) + 1
    # 下面這幾行會被公開紀錄 grep 走（白名單），**改文案要同步改 workflow 的 grep**。
    print('[places] 輸出 %d 筆，擋下 %d 筆' % (len(recs), len(blocked)))
    print('[places] 座標 精確 %d／概略 %d／沿用 %d，查詢 %d 次（快取命中 %d）'
          % (len(recs) - len(approx), len(approx), len(reused), cache.misses, cache.hits))
    if cache.fails:
        # **新增一行、既有文案一個字不動**（公開摘要 grep 的是文案字串，地雷 #19 第 2 點）。
        # 只在真的失敗過才印，同 build_restaurants 的「GSI 查詢失敗」那行。
        print('[places] ⚠ GSI 查詢失敗 %d 次（不寫快取，下輪會自動重試）' % cache.fails)
    if pending:
        # 預收那行同樣是**新增、不動既有文案**。⚠️ **刻意不用 ⚠ 開頭**：
        # 它不是警告，是「這些先收著，等地區桶開通就會上線」的正常狀態。
        # 混進警告裡的話，真正的警告就開始被當成背景雜訊。
        pend_approx = len([r for r in pending if r.get('geo') == 'approx'])
        print('[places] 預收 %d 筆（範圍外，座標已查、暫不輸出）：%s'
              % (len(pending), '・'.join('%s %d' % (p, n) for p, n in
                                         sorted(pending_by_pref(pending).items(),
                                                key=lambda kv: -kv[1]))))
        if pend_approx:
            print('[places] ⚠ 預收之中有 %d 筆只查到概略位置，地址要補（見報表）' % pend_approx)
    # OSM 補位的三行，**全部只在有動到時才印**（同上，既有文案一個字不動）。
    # ⚠️ **失敗那行特別重要**：這條路最可能的死法是端點把我們擋掉，
    # 而那時管線一切正常、統計照印，只是永遠救不回任何一筆。
    if cache.osm_calls or cache.osm_hits:
        print('[places] OSM 補位 共 %d 筆（這輪新救回 %d），查詢 %d 次（快取命中 %d）'
              % (len(osm_hit), len([r for r in recs if r.get('_osm')]),
                 cache.osm_calls, cache.osm_hits))
    if cache.osm_fail or cache.osm_skipped:
        print('[places] ⚠ OSM 補位 查詢失敗 %d 次／時間預算用完跳過 %d 筆'
              % (cache.osm_fail, cache.osm_skipped))
    for host, n in sorted(cache.osm_ep_fail.items()):
        print('[places] ⚠ Overpass 端點失敗 %s %d 次' % (host, n))
    # 票券那兩行是**新增的**，既有文案一個字沒動（公開摘要 grep 的是前綴
    # `^\[places\] `，地雷 #19 第 2 點）。⚠️ **只印數字與平台名**，
    # 不含景點名或商品網址，所以公開 repo 的 workflow 不必動。
    tk_recs = [r for r in recs if r.get('tickets')]
    if tk_recs:
        by_plat = {}
        for r in tk_recs:
            for tk in r['tickets']:
                by_plat[tk['platform']] = by_plat.get(tk['platform'], 0) + 1
        print('[places] 票券 %d 筆景點共 %d 件商品（%s）'
              % (len(tk_recs), sum(by_plat.values()),
                 '・'.join('%s %d' % (k, n) for k, n in sorted(by_plat.items()))))
    if ticket_bad:
        print('[places] ⚠ 票券有 %d 件被擋下（清單填了但網站上不會出現，見報表）' % len(ticket_bad))
    print('[places] 地區分布 ' + '・'.join('%s %d' % (a, n)
                                           for a, n in sorted(by_area.items(), key=lambda kv: -kv[1])))
    # 這行同樣會被公開摘要 grep 走（前綴白名單 `^\[places\] `），**只有類別名與數字**，
    # 不含景點名或網址，所以不必動公開 repo 的 workflow。
    print('[places] 類別分布 ' + '・'.join('%s %d' % (g, by_genre.get(g, 0)) for g in GENRES))
    if hours_info:
        # 這一行也會被公開紀錄 grep 走。**只印數字不印景點名**——名稱與提醒
        # 走 `  [hours]` 開頭那幾行，公開摘要的白名單是 `^\[places\] `，抓不到它們（H-40）。
        print('[places] 營業時間 抓到 %d／失敗 %d（其中沿用舊值 %d）／連續 %d 次以上抓不到 %d'
              '／已知沒有而跳過 %d'
              % (hours_info['ok'], hours_info['fail'], hours_info['kept'],
                 HOURS_FAIL_ALERT, len(hours_info['alert']), len(hours_info['skip'])))
        # ⚠️ 分批之後**沒有這一行就看不出進度**：「這輪抓了 500 筆」在輪得完
        # 與輪不完的時候長得一模一樣。⚠️ 它一樣走公開摘要的白名單（`^\[places\] `），
        # 所以**只印數字不印景點名**——改前綴要同步改公開 repo 的 places.yml（地雷 #19）。
        print('[places] 營業時間進度 母體 %d／這輪排入 %d／還沒輪到過 %d%s'
              % (hours_info['pool'], hours_info['queued'], hours_info['never'],
                 '／⚠ 時間預算用完提前收工' if hours_info['budget_stop'] else ''))
    write_report(recs, blocked, approx, missing_photo, by_area, hours_info,
                 by_genre, osm_hit, pending, ticket_bad)
    return 0


def pending_by_pref(pending):
    """預收的縣別分布。鍵是 `parse_address` 回的縣名（`_pending` 的前半段）。"""
    out = {}
    for r in pending:
        pref = (r.get('_pending') or '').split(' ')[0] or '(不明)'
        out[pref] = out.get(pref, 0) + 1
    return out


def hours_report(recs, hi):
    """營業時間那幾段。**這次抓到的值要逐筆列出來給人看**——

    統計數字看不出錯，這是本專案吃過三次虧的教訓（地雷 #3、#3e）。
    30 筆的規模看得完，而抽錯與抽對在畫面上長得一模一樣。
    """
    L = ['【營業時間】這次抓到 %d 筆、失敗 %d 筆（其中 %d 筆保留了上次的值）'
         % (hi['ok'], hi['fail'], hi['kept']), '']

    if hi['skip']:
        L.append('  已標記「沒有常規營業時間」而跳過的（不抓、不提醒，這是正常狀態）：')
        for rec in hi['skip']:
            still = '　⚠ 但它還留著上次抓到的值' if rec.get('hours') or rec.get('holiday') else ''
            L.append('    %s%s' % (rec['title'], still))
        L.append('')

    if hi['alert']:
        L.append('  ⚠ 連續 %d 次以上抓不到（畫面維持舊值不變，但值得去看一眼官網是不是改版了）：'
                 % HOURS_FAIL_ALERT)
        for rec, n, why in hi['alert']:
            # why 可能是空字串（模型回了合法的「沒有」而不是出錯）。空括號在報表上
            # 看起來像程式漏印了東西，實際上「沒有找到」本身就是答案。
            L.append('    %s：連續 %d 次（%s）' % (rec['title'], n, why or '沒有找到營業時間'))
            L.append('      hours_url → %s' % (rec.get('hours_url') or rec['url']))
        L.append('')

    if hi['got']:
        L.append('  這次有變動的（**請逐筆看一眼**，抽錯與抽對在畫面上長得一樣）：')
        for rec in hi['got']:
            L.append('    %s' % rec['title'])
            if rec.get('hours'):
                L.append('      營業 %s' % rec['hours'])
            if rec.get('holiday'):
                L.append('      公休 %s' % rec['holiday'])
        L.append('')

    if hi['notes']:
        L.append('  抽取時的狀況：')
        for rec, note in hi['notes']:
            L.append('    %s：%s' % (rec['title'], note))
        L.append('')

    if hi['lost']:
        L.append('  這次沒抽到、沿用上次值的欄位（官網改版時會這樣，連續幾個月都出現就要去看）：')
        for rec, note in hi['lost']:
            L.append('    %s：%s' % (rec['title'], note))
        L.append('')

    no_hours = [r for r in recs
                if not r.get('hours') and not r.get('holiday') and not r.get('no_hours')]
    if no_hours:
        L.append('  仍然沒有營業時間的（畫面上那一段整個不出現，不是壞掉）：')
        for r in no_hours:
            tip = '' if r.get('hours_url') else '　← 沒填 hours_url，抓的是官網首頁'
            L.append('    %s%s' % (r['title'], tip))
        L.append('')
    return L


def write_report(recs, blocked, approx, missing_photo, by_area, hours_info=None,
                 by_genre=None, osm_hit=None, pending=None, ticket_bad=None):
    """需人工處理的清單。**擋下的排最前面**——那是唯一「連資料都進不去」的一類。"""
    pending = pending or []
    os.makedirs(REPORT_DIR, exist_ok=True)
    L = ['景點管線報表（build_places.py）',
         '產出 %d 筆／擋下 %d 筆／預收 %d 筆' % (len(recs), len(blocked), len(pending)), '']

    if blocked:
        L.append('【擋下】以下沒有進 places.json，網站上看不到，要修清單：')
        for pid, title, src, bad in blocked:
            L.append('  %s（%s，來源 %s）' % (title, pid, src))
            for b in bad:
                L.append('      → %s' % b)
        L.append('')

    if ticket_bad:
        # ⚠️ **排在【擋下】後面、其餘之前**：它與【擋下】是同一種毛病——
        # 「清單裡填了，網站上沒有」，而且畫面上完全看不出來。
        # 差別只在代價：那邊掉的是整個景點，這邊掉的是一條連結。
        L.append('【票券】以下商品沒有進 places.json，網站上不會出現那顆鈕：')
        for title, pid, b in ticket_bad:
            L.append('  %s（%s）' % (title, pid))
            L.append('      → %s' % b)
        L.append('')

    if pending:
        # ⚠️ **這一段刻意只印分布，不逐筆列出**——它們是「正確的過濾」，
        # 逐筆列的話幾百筆會把上面【擋下】那幾筆真正要修的淹掉。
        # **唯一逐筆列的是查不到番地的那些**，因為那是現在就該補的地址缺陷。
        # 同 build_restaurants.py 的 scope_status()：outside 只印縣別分布、
        # unknown 逐筆列出。
        L.append('【預收】範圍外，座標已查好、暫不輸出。地區桶開通後重跑即上線：')
        for p, n in sorted(pending_by_pref(pending).items(), key=lambda kv: -kv[1]):
            L.append('  %s %d 筆' % (p, n))
        pend_approx = [r for r in pending if r.get('geo') == 'approx']
        if pend_approx:
            L.append('')
            L.append('  ↓ 這幾筆只查到概略位置（地址不夠細），**趁現在補**——'
                     '等開通那天才發現，當初查資料的脈絡早就沒了：')
            for r in pend_approx:
                L.append('    %s（%s）：%s'
                         % (r.get('title') or r.get('id'), r.get('_src', ''),
                            r.get('_note') or r.get('address', '')))
        L.append('')

    if approx:
        L.append('【概略位置】地址不夠細，前端會標「概略位置」、也不會被自動行程選中：')
        for r in approx:
            L.append('  %s：%s' % (r['title'], r.get('_note') or r['address']))
        L.append('')

    if osm_hit:
        # ⚠️ **逐筆列出，而且要印位移距離。** 這幾筆的 `geo` 是 `precise`，
        # 不列出來就沒有任何地方看得出它們走過「名稱比對＋剛好一個」這條路
        # ——那比 GSI 的番地級弱一階，值得每個月被看一眼。
        L.append('【OSM 補位】GSI 只查到大字／町名，改用 OSM 的 POI 座標：')
        for r in osm_hit:
            L.append('  %s：%s' % (r['title'],
                                   r.get('_osm') or '沿用上次補位到的座標'))
        L.append('')

    if missing_photo:
        L.append('【破圖】img 填了檔名但 places/ 底下沒有這個檔（留空才是「還沒拍」）：')
        for r in missing_photo:
            L.append('  %s → places/%s' % (r['title'], r['img']))
        L.append('')

    odd = [r for r in recs if r.get('_note') and r['geo'] == 'precise']
    if odd:
        L.append('【參考】查詢時砍過地址才查到（座標是準的，但值得看一眼）：')
        for r in odd:
            L.append('  %s：%s' % (r['title'], r['_note']))
        L.append('')

    if hours_info:
        L.extend(hours_report(recs, hours_info))

    L.append('【地區分布】')
    for a, n in sorted(by_area.items(), key=lambda kv: -kv[1]):
        L.append('  %s %d 個' % (a, n))
    L.append('')

    # **照 GENRES 的順序印而不是照筆數**，這樣某一類掉到 0 時那一行還在、看得出來
    # （照筆數排序的話它會直接消失，而「消失」在報表上與「本來就沒有」分不出來）。
    L.append('【類別分布】')
    for g in GENRES:
        L.append('  %s %d 個' % (g, (by_genre or {}).get(g, 0)))

    with open(os.path.join(REPORT_DIR, 'places_report.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(L) + '\n')


if __name__ == '__main__':
    sys.exit(main())
