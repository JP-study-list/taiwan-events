# progress.md — 開發歷史（台灣版寄道日和）

> 反向時間序（最新在上）。每次改檔即更新。
> 欄位：日期 / 類型（新增·修正·重構）/ 影響檔案 / 摘要 / 原因 / 待辦
>
> ⚠️ **日本版的完整開發歷史在 `_ref-kanto/progress-kanto.md`**（2026-09-23 原樣複製，1.3 MB）。
> 那是**參考資料不是本專案的紀錄**：開場 SOP 讀的「最新 3～5 筆」一律指本檔，
> 不要去讀那一份的開頭當成本專案的進度。要查某個做法當初為什麼那樣決定，再去那邊搜尋。

---

## 2026-09-23（第六筆）

- 類型：修正（**單位 D-1 站名、D-3 localStorage 前綴**）
- 影響檔案：`index.html`、`js/config.js`、`js/tour.js`、`css/style.css`（註解）、`js/` 共 14 支（前綴）、
  `CLAUDE.md` §6b §8、`development-plan.md`、`project-index.md`、本檔
- 摘要：
  - D-3：`jpev_` → `twev_`，10 種鍵、37 處，全是寫死的完整鍵名（沒有拼接），逐字替換。
    台灣版沒有使用者，不需要搬舊資料。
  - D-1（使用者 2026-09-23 看對照圖決定）：中文 `寄道日和・台灣`、日文 `寄道日和・台湾`；
    副標沿用 `YORIMICHI BIYORI`；分頁標題「寄道日和・台灣｜台灣展覽、祭典與活動地圖」
    （日文「…｜台湾の展覧会・祭り・イベント地図」）。改了 config 中日兩組、`<title>`、`og:title`、
    `og:site_name`、iOS 主畫面名、導覽第一步的標題與那一句說明。
  - 量測（320px）：站名 169.7px／可用 292px，不換行；副標 `YORIMICHI BIYORI` 餘 50px，
    `· TAIWAN` 缺 12px、`YORIMICHI BIYORI TAIWAN` 缺 3px（不採用）。對照圖在 `_probe/d1-compare.png`（不進版控）。
  - 新開 D-6（其餘寫著日本的介面文案，約 36 行）、D-7（iPhone 實機確認主畫面名稱會不會被截斷）；
    `description` 文案併進 D-2。
- 驗證（Chrome headless＋CDP，假資料放 scratchpad）：
  - D-3 共 10 項：寫入的鍵全是 `twev_`、沒有 `jpev_`；系統固定深色時存 `twev_theme=light`
    會變淺、存 `twev_lang` 會切語言；**對照組**只存舊的 `jpev_` 鍵則完全沒效果。
  - D-1 共 20 項：靜態 HTML 四處、中日兩語的分頁標題／頂欄／副標／導覽標題，320px 不換行不截斷，JS 錯誤 0。
  - ⚠️ **測試自己錯了三次，三次都長得像產品壞了**（已補進 CLAUDE.md §6b）：
    ① `load()` 只等 300ms，讀到上一頁；② **別的專案也在用 8899 埠**，瀏覽器被導到對方的伺服器
    （localStorage 冒出 `poke-change/v1`）；③ `python3 -m http.server` 等候佇列只有 5，
    約 1/8 的載入有模組被 `ERR_CONNECTION_RESET`、整頁 JS 不跑。改用專用埠 8931／9241、
    綁 127.0.0.1、佇列 128 的伺服器之後才全過。
- 待辦/已知問題：D-2、D-4～D-7 見 `development-plan.md`。

---

## 2026-09-23（第五筆）

- 類型：修正（**單位 C：工具去日本化防呆**）
- 影響檔案：`codex_kit.py`、`build_photos.py`、`pick_photos.py`、`build_restaurants.py`、`fetch_events.py`、
  `development-plan.md`、`project-index.md`、`CLAUDE.md` §8、本檔
- 摘要：
  - C-1／C-2：`DEFAULT_KIT`、`SRC_DEFAULT` 改成 `None`，沒指定路徑就停下來說明要用 `--kit`／`--src`。
    **沒有改成「台灣的某個路徑」**：那兩個資料夾要看單位 L（要不要接外部代理）與 H（原圖放哪），還沒定。
    ⚠️ 盤點時多找到一處：`pick_photos.py assign` 也吃 `build_photos.SRC_DEFAULT`，一起擋。
  - C-3：`kanto-events-*` 兩處與 `fetch_events.py` 送給查座標服務的 `jp-events/2.0` 四處，
    改成 `taiwan-events-*`，聯絡網址用 GitHub repo（網站網址要到單位 A 才定）。
  - `fetch_events.py` 檢查圖片時送的 `Referer` 是網站網域，跟著網址走，歸進 D-2。
- 驗證：三條「沒給路徑」都停下來並印出說明（exit 1）；給了路徑照常運作（`codex_kit export --kit`
  寫出五樣東西、`build_photos --src` 空資料夾正常結束、`--todo` 不需要路徑照舊）。
  ⚠️ 第一次測 `build_photos` 是**假通過**：它先因為沒有 `places.json` 停下，根本沒走到新檢查；
  改成在 scratchpad 複製一份、放空的 `places.json` 才真的測到。UA 實際 import 印出確認；
  三支離線測試照樣全過。
- 待辦/已知問題：無。

---

## 2026-09-23（第四筆）

- 類型：重構（**改成公開 repo 開發，並從乾淨起點開始**）
- 影響檔案：`fetch_events.py`、`.gitignore`、`development-plan.md`、`project-index.md`、`CLAUDE.md` §8、本檔
- 摘要：使用者調整順序：**先在公開 repo 開發 → 設計結束後拆成私有＋公開 → 私有的再上 Cloudflare**，
  Cloudflare 相關（單位 F、A）放最後。推上去之前查到舊歷史裡有日本版私有 repo 的東西，
  使用者選「乾淨起點再公開」：
  - `_ref-kanto/` 加進 `.gitignore`，只留本機。
  - `fetch_events.py` 清空 `SOURCES`（日本 138 個來源的網址與逐一調校註解，共 476 行）、
    `SOURCE_PREF`、`SOURCE_CITY`，台灣版本來就要整份換掉（單位 E-4）。
  - 舊歷史改名成本機分支 `local-history`（不推、不刪），新的 `main` 從單一 commit 開始。
- 原因：公開之後歷史收不回來，拆分之後也一樣；日本版的 repo 是私有的（`gh` 實查 PRIVATE）。
- 驗證：推之前掃過整棵樹，沒有任何金鑰字樣（Google／GitHub／Jina／Groq 金鑰格式、私鑰、Apps Script 網址）；
  清空後 `fetch_events.py` 仍可 import，剩下 11 個網址全是 API 端點；
  `test_areas`／`test_osm_places`／`test_place_hours` 三支照樣全過。
- 待辦/已知問題：`fetch_events.py` 的註解裡仍散見日本來源名稱（沒有網址），判斷不值得逐條清。

---

## 2026-09-23（第三筆）

- 類型：新增（**初始化**）
- 影響檔案：`project-index.md`（新）、`development-plan.md`（新）、`CLAUDE.md`（§5、§6b、§8）、本檔
- 摘要：
  - 建 `project-index.md`：只記台灣版現況＋每支檔案「還有哪裡綁日本」，程式內部細節指向
    `_ref-kanto/project-index-kanto.md`（不重抄那份 2,955 行）。
  - 建 `development-plan.md` 當**唯一的待辦來源**，編號從 A 重新開始。把第一、二筆散落的待辦
    收成 A～L 十二個單位（A 憑證實測、B 建 repo、C 工具路徑防呆、D 前端品牌網址、E 活動管線台灣化、
    F Cloudflare 與 workflow、G 測試、H 景點、I 餐廳、J 飯店、K 法規、L AGENTS.md）。
  - `CLAUDE.md`：§5 待辦來源改指新檔；§6b 專案路徑改成本專案（Windows 那台尚未建立）；
    §8 補基本資料與 secrets 指標，並註明日本版 §8 的前端地雷要去 `_ref-kanto/` 查。
  - 訪談定案（使用者 2026-09-23）：待辦放 `development-plan.md`；repo 名
    `JP-study-list/taiwan-events`＋`taiwan-events-runner`；**首發只做活動**；站名**「寄道日和・台灣」**。
- 原因：CLAUDE.md §1 的初始化流程；第二筆留的「待辦清單放哪」由使用者決定。
- 驗證：只動文件，未改任何程式；`git status` 確認只有上述四個檔案有變動。
- 待辦/已知問題：全部在 `development-plan.md` §0-D。下一步建議順序 C（防呆，幾分鐘）→ B → F → A。

---

## 2026-09-23（第二筆）

- 類型：新增（補齊參考資料與記憶）
- 影響檔案：`_ref-kanto/CLAUDE-kanto.md`、`_ref-kanto/project-index-kanto.md`、
  `_ref-kanto/development-plan-v3-kanto.md`、`_ref-kanto/development-plan-v4-kanto.md`、本檔；
  repo 外：本專案的記憶資料夾（`~/.claude/projects/-Users-rensa-Projects-taiwan-events/memory/`）
- 摘要：第一筆漏帶了四樣，使用者確認後補上：
  - **日本版完整 `CLAUDE.md`（含 §8）**。⚠️ 第一筆刻意只帶 §0～§7，**那個判斷是錯的**：
    前端是同一份程式，§8 的前端地雷（z-index 被蓋住、`[hidden]` 藏不掉、QR 深色掃不到、
    iOS 主畫面、地圖卡頓…）台灣版照樣會踩。**要改前端時先去那份搜尋相關段落。**
  - **`project-index.md`**：每支檔案的用途＋「常見改動要動哪裡」，描述的正是複製過來的程式。
  - **計畫書 v3／v4**：飯店（單位 F）與 SEO／文章（單位 Z）的規劃與查證可參考。
    ⚠️ **只是參考、不是本專案的待辦來源**。
  - **15 條跨 session 記憶**（使用者的工作習慣：白話解釋、不要順手 push、人工確認做成網頁、
    視覺決定先拍對照…）。記憶按資料夾分開存，不複製的話新 session 一條都看不到。
    `codex-collects-places-externally` 已加註「日本版專用」。
- 原因：`_ref-kanto/` 底下全部是**唯讀參考**，日本版之後的更新不會自動同步過來。
- 待辦/已知問題：初始化時決定本專案自己的待辦清單放哪（不要沿用 `development-plan-v4-kanto.md`）。

---

## 2026-09-23（第一筆）

- 類型：新增（**專案誕生：自日本版 kanto-events 分出**）
- 影響檔案：全部（原樣複製），`CLAUDE.md`（只帶 §0～§7）、`AGENTS.md`、本檔、
  `_ref-kanto/progress-kanto.md`、`_runner-template/`、`places_src/_template.json`、
  `restaurants_src/_template.json`
- 摘要：使用者決定做**台灣版寄道日和**，另開全新資料夾，**日本版 kanto-events 一個位元組都沒動**
  （複製過程只讀不寫，做完 `git status` 乾淨）。今天的討論與定案全部記在下面，
  **這些原本只存在日本版專案的記憶裡，新資料夾的 session 看不到，所以寫進來。**
- 原因：見下方「為什麼另開專案」。

### ✅ 已定案（使用者 2026-09-23 決定）

1. **另開獨立專案**，不混進日本版任何現有檔案。接受 Cloudflare 每月多約 **30 次**建置。
2. **網址：`events.tw.rensakobo.com`**。
3. **「台灣版」＝活動・景點・飯店・法規全部換成台灣的**，不是語言切換。
4. **台灣版同樣要做中文與日文介面。**
5. 本機資料夾 `/Users/rensa/Projects/taiwan-events`，已 `git init`（尚無遠端、未 push）。

### 為什麼另開專案（討論結論）

- 日本版**除了前端之外全部綁日本**：138 個活動來源、国土地理院（只收日本）、
  1,741 個市町村清單、JST 時區、26 個地區桶、`CLAUDE.md` §8 上百條日本地雷。
  混在一起任何共用的改動都可能弄壞線上的日本版。
- 附帶好處：本專案有一份**乾淨、小得多的 `CLAUDE.md`**（日本版那份 32 萬字、每次開場都要載入）。

### 為什麼不共用網址（使用者最初的想法是共用網址＋切換）

- ⚠️ **SEO**：搜尋引擎只認網址。共用網址、靠按鈕切換＝ Google 只看到一個網站，
  台灣版「自己的 SEO」不可能成立（同日本版單位 Z-9 hreflang 卡住的原因）。
- ⚠️ **localStorage 綁網域**：同網域下台灣版的收藏會寫進日本版同一個 key，
  日本版的 `goneList()` 會把台灣的 id 當成「已結束的收藏」列出來
  （同日本版餐廳收藏另開 `jpev_favr` 的理由）。
- **採用做法**：各自一個網域，兩邊的設定頁放一個「切換到台灣版／日本版」的**連結**。
  使用者一樣有切換的感覺，SEO、收藏、Cloudflare 專案天生分開。

### ⚠️⚠️ 動工前一定要先做：驗 HTTPS 憑證

`events.tw.rensakobo.com` 是**兩層**子網域。Cloudflare 免費的 Universal SSL 只蓋一層
（`*.rensakobo.com`），兩層不在範圍內。**Pages 的自訂網域可能會為它單獨發一張憑證，
但沒有查證過。** 驗法不必寫程式：第一次部署時在 Pages 加上這個自訂網域，
看憑證狀態會不會變成有效、瀏覽器開起來有沒有「不安全」。
- 會 → 照這個網址走。
- 不會 → 付費的進階憑證，或改一層網址（例如 `tw-events.rensakobo.com`）。
- ⚠️ **網址是這整件事最不可逆的決定**：搜尋索引、分享連結、使用者瀏覽器裡的收藏與行程
  全綁在網址上，換掉就全部歸零而且搬不了。**上線前定案。**

### 前端：先複製，代價是雙份維護

- 這次是**原樣複製**日本版前端（零風險、可反悔）。代價：日後加功能要兩邊各做一次，
  **漏改一邊不會有任何警訊**。
- 另一條路（兩版共用一份前端、用設定檔切換）長期最省，但要先大改線上日本版，
  把站名、地區、寶可夢分類、Klook、隱私權文案等日本專屬的東西抽出去。
- 判斷：兩版多半不會一直「完全一樣」（台灣大概沒有寶可夢那一類、票券平台與大區會不同、
  台灣版有飯店而日本版沒有），會自然分岔。**等兩版都穩定再決定要不要抽共用。**

### 中日雙語：原文與譯文的方向跟日本版相反

- ⚠️⚠️ **活動 `id` 要用「中文標題」算**。日本版用日文標題，因為那是原文、譯名每天會被
  LLM 重新翻（日本版地雷 #8：id 漂移會讓收藏與分享連結靜默失效）。
  **台灣版原文是中文，日文才是會漂移的譯文。** 照抄日本版的算法等於把漂移帶進來。
- 地名、場館名要有日文版本讓日本旅客查得到，資料來源與翻譯方式要重新設計。

### 其他動工前要知道的

- **localStorage 前綴不要沿用 `jpev_`**（例如改 `twev_`）。就算不同網域不會撞，
  成本幾乎是零，萬一日後改同網域也不出事。
- **時區**：`Asia/Taipei`（UTC+8）。日本版全站是 `Asia/Tokyo`，`fetch_events.py` 裡寫死的要改。
- **查座標**：国土地理院只收日本、用不了。台灣沒有同等好用又免金鑰的地址查詢服務，
  **這段要重新找、重新實測**，不能照搬。Nominatim／Photon／Overpass（OSM）全球都能用。
- **飯店是全新功能**：日本版的住宿聯盟（單位 F）從來沒動工，沒有現成程式可複製。
- **法規兩套都可能要看**（⚠️ 推測的方向，**未查證**）：台灣的個資法、公平會對推薦廣告的規範；
  而台灣版有日文介面、對象含日本旅客，日本的ステマ規制可能照樣適用。
  **開始放聯盟連結之前要實際查一次。** 現有的廣告標示與隱私權文案是照日本法規寫的。
- **Klook**：同一個帳號（AID 133174）應可用在台灣商品。要在後台分辨兩站，
  給台灣版一組**固定**的不同標籤（例如 `tw-popup`）。⚠️ 標籤只能是少量固定值、
  **絕不可以一筆資料一個**（2000 組上限超過會靜默失效；放使用者／事件層級資料會被停權）。
- **Cloudflare 建置額度**每月 500 次、**整個帳號共用**。
- **GitHub Actions**：沿用「私有 repo 放程式、公開 runner repo 只放 workflow」的架構
  （私有 repo 的 Actions 額度帳號共用、每月 2000 分鐘）。**要另外申請一把 PAT**，
  日本版的 `KANTO_PAT` 只授權 kanto-events。
- **Gemini 金鑰**若與日本版共用，免費額度也共用，兩邊排程要錯開。

### 這次複製了什麼

| 類別 | 內容 |
|---|---|
| 前端 | `index.html`、`css/`、`js/`（27 模組）、`apple-touch-icon.png`、`robots.txt`、`sitemap.xml` |
| 管線 | `fetch_events.py`、`build_restaurants.py`、`build_places.py`、`build_photos.py` |
| 人工確認工具 | `pick_photos.py`、`hours_pick.py`、`klook_match.py`、`klook_scout.py`、`places_review.py`、`codex_kit.py`＋`codex_kit/` |
| 測試 | 五支常設測試 |
| 規範 | `CLAUDE.md`（只有 §0～§7，§8 留空）、`AGENTS.md`、`.gitignore` |
| 輸入範本 | `places_src/_template.json`、`restaurants_src/_template.json` |
| 參考 | `_runner-template/`（公開 runner repo 三支 workflow，只有 secret 名稱、無金鑰；刻意不放在 `.github/` 底下，GitHub 不會把它們當排程跑）、`_ref-kanto/progress-kanto.md`（日本版開發歷史） |
| 空資料夾 | `places/.gitkeep`（**不可刪**：Cloudflare 組建命令 `cp -r` 找不到來源會整個建置失敗） |

**刻意沒複製**：日本的資料（`events.json`、`places.json`、`places/` 61MB 照片、`restaurants/`、
各 `*_src/` 的清單與快取）、各 log、`development-plan-v3/v4.md`、`project-index.md`、
`_probe/`、`_photodl/`。

### 驗證

- 在新資料夾跑五支測試：`test_areas`（26 桶、61 據點全過）、`test_osm_places`（7/7）、
  `test_place_hours`（26/26）通過；`test_geo_gates` 與 `test_tickets.mjs` 因為找不到
  `events.json`／`places.json` 失敗——**那是日本資料刻意沒複製，預期中的結果**。
- 這些測試守的全是日本的規則（26 桶、日本的座標守門），改成台灣之後要跟著改或重寫。

### 待辦/已知問題

- ⚠️⚠️ **兩支工具的預設路徑還指回日本，改掉之前不要在這裡跑**：
  - `codex_kit.py:38` 的 `DEFAULT_KIT = ~/Projects/kanto-places-codex`＝日本版給 Codex 的收件匣，
    在這裡跑可能把**日本的景點收進台灣專案**。
  - `build_photos.py:50` 的 `SRC_DEFAULT` 指向外接碟上**日本的原圖**。
- `AGENTS.md` 內容是日本版的（路徑、`places_src` 的分檔、105 筆等），初始化時改寫。
- `CLAUDE.md` §5、§6b 提到 `development-plan-v4.md` 與日本版單位，初始化時逐條檢視。
- User-Agent 字串還是 `kanto-events-*`（`build_restaurants.py:49`、`pick_photos.py:78`）。
- `index.html` 的 canonical、`sitemap.xml`、`robots.txt` 仍指向 `events.rensakobo.com`。
- 下一步：在本資料夾開 session，說「**初始化這個專案**」→ 建 `project-index.md`、訪談補 §8，
  第一件實作是**憑證實測**。
