# 景點照片挑圖頁（單位 H-4）

使用者在手機上挑，所以做成 claude.ai 上的網頁，不是日本版那個本機網頁（`pick_photos.py serve`）。

- `index.html`：挑圖頁。挑的結果存在頁面資料庫 `pick/a00`～`a19`（`p` = 景點 id → 檔名｜`"-"` 都不要｜`""` 取消了建議）。
- `data/`：縮圖包（`index.json`＋每個地區一個 `aNN.json`，縮圖是 data URI）。**不進版控**，由 `places_photo_tw.py build` 產生。
- `e2e.mjs`：端對端測試（手機觸控模擬、假資料庫通知亂序、每顆按鈕點得到）。

流程：

1. `python3 pick_photos.py fetch`（座標）→ `python3 pick_photos.py fetch --wiki`（名字，中文維基優先）
2. `python3 places_photo_tw.py build` → 發布這個資料夾（`index.html`＋`data/`）
3. 使用者挑完 → ArtifactData `list` 集合 `pick`（加 `out_dir`）匯出 → `python3 places_photo_tw.py export <匯出資料夾>`
4. `python3 pick_photos.py apply` → `python3 build_photos.py --src _photodl`

「先幫你選的」＝維基條目的代表照片（名字查到的第一張、條目座標沒有離太遠）。使用者沒動過的照樣算選了；動過的以使用者為準。
