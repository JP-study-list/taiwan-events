# project-index.md — 專案檔案索引（台灣版寄道日和）

> 用途：讓 Claude Code 開場只讀本檔即掌握結構，不重掃原始碼。
> 檔案新增／刪除／職責變動時同步更新。
> 最後校對：**2026-09-23**（初始化；此時全部程式仍是日本版原樣複製，尚未台灣化）。
>
> ⚠️ **程式內部細節（每個函式、每條地雷、「常見改動要動哪裡」）看 `_ref-kanto/project-index-kanto.md`**。
> 那份描述的正是複製過來的這批程式，但內容是日本版 2026-09-11 的狀態，**是唯讀參考，不會同步**。
> 本檔只記「台灣版自己的現況」與「那份沒有、或與那份不同的事」。改寫某支檔案之後，
> 把它的台灣版現況補進本檔，**不要回去改 `_ref-kanto/` 的任何檔案**。

---

## 一句話定位

**台灣版寄道日和**：台灣的活動・景點・餐廳（未來加飯店）地圖網站，中文與日文雙語介面。
自日本版 `kanto-events`（線上 `events.rensakobo.com`）於 2026-09-23 分出、完全獨立。
預定網址 **`events.tw.rensakobo.com`**（⚠️ 兩層子網域，HTTPS 憑證未驗證）。

**現況**：設計期間在**公開** repo `JP-study-list/taiwan-events` 開發（2026-09-23 起，未部署）。
本機另有分支 `local-history`（含日本版私有內容的舊歷史，**絕不 push**）。
所有程式、測試、文案仍是日本版的，**還不能跑出台灣的資料**；
`fetch_events.py` 的 `SOURCES`／`SOURCE_PREF`／`SOURCE_CITY` 已清空，等單位 E-4 填台灣的。

---

## 架構（沿用日本版，台灣版尚未建立任何一段）

```
【公開 runner repo】GitHub Actions（cron）      ← 尚未建立，範本在 _runner-template/
  └─ 帶 PAT 取出【私有 repo】本專案               ← 尚未建立遠端；PAT 要另申請，不能用 KANTO_PAT
  └─ fetch_events.py → events.json（累積式）
  └─ build_restaurants.py → restaurants/
  └─ build_places.py → places.json
  └─ git push 回私有 repo → 觸發 Cloudflare Pages 建置 → 網站更新
index.html（Cloudflare Pages，組建命令只複製指定檔案進 dist/）
  └─ fetch events.json／places.json；點餐廳分頁才載 restaurants/
```

- **三條資料管線互相獨立**：活動＝自動抓網站＋LLM；景點＝人工清單＋查座標（＋`--hours` 時 LLM）；餐廳＝人工清單＋查座標。
- ⚠️ 日本版查座標靠**国土地理院**（只收日本），台灣版**必須換掉**，替代方案未定、未實測。

---

## 檔案清單

### 前端（原樣複製，全部仍是日本版內容）

| 檔案 | 職責 | 台灣版待改 |
|---|---|---|
| `index.html` | HTML 骨架（752 行） | 站名、標題已改；canonical／OG 網址仍指 `events.rensakobo.com`、`description` 仍寫日本（D-2） |
| `css/style.css` | 全站樣式（2,500 行） | 大致可沿用 |
| `js/*.js` | 27 個 ES Modules，進入點 `js/main.js` | 見下 |
| `js/config.js` | **設定與中日文案的集中處**（942 行）：`AREAS` 地區桶、分類、localStorage key、雙語字串 | 站名已改（中 `寄道日和・台灣`／日 `寄道日和・台湾`）；localStorage 前綴已改 `twev_`（14 支前端檔、37 處，2026-09-23）；地區桶已換成台灣 20 桶＋五大區（E-3）；聯絡信箱 `events@rensakobo.com`；說明與隱私權文案仍寫日本（D-6） |
| `js/icons.js` | 分類圖示（Tabler 線條圖）。活動七類在 `EVENT_ICON`；台灣版「表演」＝音符、「祭典」＝亭子（2026-09-24）；景點的「神社寺廟」仍是鳥居（H） | — |
| `js/tickets.js` | Klook 票券聯盟連結組裝 | 台灣版要一組**固定**的不同標籤（例 `tw-popup`） |
| `apple-touch-icon.png`、`robots.txt`、`sitemap.xml` | iOS 圖示、SEO | `robots.txt`／`sitemap.xml` 網址指向日本版 |

### 資料管線（Python，純 stdlib；需 3.9+ 的 `zoneinfo`）

| 檔案 | 職責 | 台灣版待改 |
|---|---|---|
| `fetch_events.py` | **活動抓取唯一進入點**。兩條路：①**開放資料**（`kind: "moc"`，文化部藝文活動，`moc_events`／`moc_convert`，不經 AI 抽取）②網站＋AI 抽取（Jina → LLM → `clean_event`）。之後共用：累積合併（去重鍵優先用 `src_key`）→ 座標 → `fill_japanese`（補日文，先沿用）→ 寫 `events.json`。本機可跑 `python3 fetch_events.py --no-llm`（只跑開放資料、日文留空）。⚠️ 檔頭 `GOV_SSL` 全域放寬嚴格憑證格式（政府網站） | 138 個日本來源、`JST = ZoneInfo("Asia/Tokyo")`（第 31 行）、国土地理院、日本 bbox／市町村清單。⚠️ **`id` 要改用中文標題算** |
| `build_restaurants.py` | 餐廳管線：`restaurants_src/` → `restaurants/` | 国土地理院（UA 已改 `taiwan-events-*`） |
| `build_places.py` | 景點管線：`places_src/` → `places.json`（**import `build_restaurants`**，改那支簽章這支會炸） | 同上；地區桶 |
| `build_photos.py` | 景點照片壓縮（本機跑） | `SRC_DEFAULT` 已改成 `None`（2026-09-23）：**`--src` 必填**，台灣原圖放哪待單位 H |

### 人工確認工具（本機跑，fetch → serve 網頁 → apply 三段式）

| 檔案 | 職責 | 台灣版待改 |
|---|---|---|
| `pick_photos.py` | 景點挑圖（Commons／維基） | `assign` 同樣要 `--src`；日文維基 → 可能改中文維基 |
| `places_review.py` | 後台 hold 景點逐筆決定去留 | — |
| `hours_pick.py` | 營業時間頁逐筆確認 | 關鍵字是日文（営業時間…） |
| `klook_match.py`／`klook_scout.py` | Klook 商品候選比對（只讀 sitemap） | sitemap 範圍是日本商品 |
| `codex_kit.py`＋`codex_kit/` | 與外部 Codex 資料夾同步 | `DEFAULT_KIT` 已改成 `None`（2026-09-23）：**`--kit` 必填**。台灣版是否接外部代理待單位 L |

### 測試（六支，都不打網路）

| 檔案 | 守什麼 | 現況 |
|---|---|---|
| `test_areas.py` | 地區桶三份清單一致 | 通過（日本 26 桶） |
| `test_osm_places.py` | OSM 補位守門 | 通過 |
| `test_place_hours.py` | 營業時間分批 | 通過 |
| `test_tw_geo.py` | **台灣版查座標**（2026-09-24，E-5）：地址拆解、台／臺、縣市守門、中文名稱比對與兄弟設施、圖片網址修復、地址查詢一定帶區（攔截網址不打網路） | 通過 |
| `test_geo_gates.py` | 活動座標守門 | **失敗（缺 `events.json`，預期中）** |
| `test_tickets.mjs` | Klook 連結規則（Node） | **失敗（缺 `places.json`，預期中）** |

### 輸入範本與空資料夾

| 檔案 | 用途 |
|---|---|
| `places_src/_template.json`、`restaurants_src/_template.json` | 清單格式範本（複製去改） |
| `places/.gitkeep` | ⚠️ **不可刪**：組建命令 `cp -r places dist/` 找不到資料夾會整個建置失敗 |

### 規範與文件

| 檔案 | 用途 |
|---|---|
| `CLAUDE.md` | 開發規範（§0～§7）＋本專案技術背景（§8） |
| `project-index.md` | 本檔 |
| `progress.md` | 本專案開發歷史（反向時間序） |
| `development-plan.md` | ⭐ **唯一的待辦來源**：§0-D 工作單位總表（從 A 起編）＋ §7 各單位細節 |
| `AGENTS.md` | 外部代理護欄。⚠️ **內容仍是日本版**（路徑、分檔、筆數） |
| `_runner-template/` | 公開 runner repo 三支 workflow 的範本（`update.yml`／`restaurants.yml`／`places.yml`）。只有 secret 名稱無金鑰；**刻意不放 `.github/`** 以免被當排程跑。內容仍指向 `JP-study-list/kanto-events`、`KANTO_PAT`、JST |
| `_ref-kanto/` | ⚠️ **只在本機（`.gitignore`，不進公開 repo）**。**日本版唯讀參考**：`CLAUDE-kanto.md`（含 §8 前端地雷）、`project-index-kanto.md`、`progress-kanto.md`、`development-plan-v3/v4-kanto.md`（飯店＝單位 F、SEO＝單位 Z 的規劃可參考）。**不是本專案的待辦或進度** |

### 刻意沒複製（日本的資料）

`events.json`、`places.json`、`places/` 照片、`restaurants/`、各 `*_src/` 清單與快取、各 log。

---

## 部署（未建立）

| 項目 | 狀態 |
|---|---|
| 設計期間 | **公開** repo `JP-study-list/taiwan-events`，不部署 |
| 私有 repo＋公開 runner repo | 設計結束後拆分（範本在 `_runner-template/`） |
| Cloudflare Pages 專案 | **排在最後**，連拆分後的私有 repo。建置額度每月 500 次**整個帳號共用** |
| 自訂網域 `events.tw.rensakobo.com` | ⚠️ **第一件實作＝憑證實測**：兩層子網域不在免費 Universal SSL 範圍 |
| 組建命令 | 沿用日本版做法：只複製指定檔案進 `dist/`。**新增要上線的檔案必須同步加進組建命令** |

---

## 常見改動要動哪裡

台灣化尚未開始，暫無台灣版專屬路徑。日本版的對照表見 `_ref-kanto/project-index-kanto.md`；
開始改寫之後逐項補進本節。
