# 景點日文名確認（claude.ai/artifact/6ngJk2BYAnmx161awD1vPD）

- `names.json`：363 筆的日文名初稿（100 筆日文維基條目名 `src:wiki`、263 筆 Claude 翻的 `src:ai`，由 `jaconv.py` 產生）。
- `tw-ja.html`：審閱頁。使用者改過的存在頁面資料庫 `ja/a00`～`a19`（`j` = 中文名 → 改過的日文名；沒改的不存）。
- `e2e.mjs`：端對端測試（假資料庫、通知亂序、觸控模擬）。2026-09-26 10 項全過。
- 套用：`python3 places_apply_ja.py <ja 匯出資料夾>` → 寫回 `places_src/taiwan.json` 的 `title_ja`。
