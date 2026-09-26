# H-1 確認網頁（claude.ai/artifact/NCx2UQMLk7vSkgV1dz63Fo）

- `tw-confirm.html`：網頁本體。發布時另外附 `candidates.json`（＝`places_src/_h1_candidates.json`），宣告 `db` 能力。
  資料存在該頁資料庫 `confirm/a00`～`a19`（每區一份：`s` = 景點名稱 → {c 候選序號（-1 都不對、-2 自己貼座標）, g, ja, id, ok, lat, lng}）。
- `e2e.mjs`：端對端測試。注入假資料庫（通知故意亂序：先存的最後回來），用真實滑鼠事件跑
  選候選＋確認、同區再操作、貼座標後直接按確認、改分類與日文名、清快取重開從資料庫還原。
  2026-09-26 修改前 3 項 FAIL（重現使用者遇到的「確認被蓋回待確認」「貼座標後按確認沒反應」），修改後 9 項全過。
- `cdp2.mjs`：手機觸控模擬下，逐段捲動檢查每個可點元素的中心點是不是點得到它自己（地雷 20）。

跑法：在這個資料夾用 8931 埠起 server（CLAUDE.md §6b 那行），Chrome 開 9241 除錯埠，
頁面要先包一層 `<!doctype html><meta viewport>`（發布時平台會自動加），再 `node e2e.mjs <包好的檔名>`。
