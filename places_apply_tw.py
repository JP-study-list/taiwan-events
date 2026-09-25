#!/usr/bin/env python3
"""
單位 H-1 的第三段（fetch → serve → **apply**）：把確認網頁的結果寫成正式的景點清單。

    python3 places_apply_tw.py <確認結果資料夾> [輸出檔]     # 預設 → places_src/taiwan.json

<確認結果資料夾> 是確認網頁資料庫 `confirm` 集合的匯出（每區一個 aNN.json，
Claude 用 ArtifactData 的 list＋out_dir 存下來的那份）。**只收「已確認」而且選了某個候選的**；
「待確認」「都不對」一律不寫，並在最後列出來——沒確認過的東西不可以默默進正式資料。

輸出格式照 places_src/_template.json（id／title／title_ja／genre／address／url），
另外帶 H-2 要用的：lat／lng（確認過的座標，build_places.py 不必再查）、tb_id（觀光署編號）、
area（地區桶）。日文名空白的保留空字串，之後由 AI 補、再給使用者看。
"""
import json
import os
import re
import sys
from glob import glob

HERE = os.path.dirname(os.path.abspath(__file__))
CANDS = os.path.join(HERE, "places_src", "_h1_candidates.json")
OUT = os.path.join(HERE, "places_src", "taiwan.json")


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    out_path = sys.argv[2] if len(sys.argv) == 3 else OUT
    d = json.load(open(CANDS, encoding="utf-8"))
    areas = list(dict.fromkeys(r["area"] for r in d["rows"]))
    picks = {}
    for f in glob(os.path.join(sys.argv[1], "a*.json")):
        doc = json.load(open(f, encoding="utf-8"))
        doc = doc.get("data", doc)
        picks[os.path.basename(f)[:-5]] = doc.get("s", {})
    out, todo, none, ids = [], [], [], set()
    for r in d["rows"]:
        s = picks.get("a%02d" % areas.index(r["area"]), {}).get(r["name"])
        if not s or not s.get("ok"):
            todo.append(r["area"] + "：" + r["name"])
            continue
        c = s.get("c", -1)
        if c == -2 and s.get("lat") is not None:
            # 使用者自己貼的座標（網頁的「自己貼座標」）。地址沿用第一個候選，沒有就留空。
            base = r["cands"][0] if r["cands"] else {}
            cand = {"lat": s["lat"], "lng": s["lng"], "src": "own", "addr": base.get("addr", ""),
                    "url": base.get("url", ""), "id": base.get("id", "")}
        elif c is None or c < 0 or c >= len(r["cands"]):
            none.append(r["area"] + "：" + r["name"])
            continue
        else:
            cand = r["cands"][c]
        pid = (s.get("id") or r["id"]).strip()
        if not pid.startswith("pl-") or pid in ids:
            sys.exit("景點編號有問題（不是 pl- 開頭或重複）：%s %s" % (r["name"], pid))
        ids.add(pid)
        out.append({"id": pid, "title": r["name"], "title_ja": (s.get("ja") or "").strip(),
                    "genre": s.get("g") or r["genre"], "area": r["area"],
                    # 網頁上地址後面的「（門牌）（只到鄉鎮中心…）」是給使用者看的備註，不進資料
                    "address": re.sub(r"（(門牌|只到路名|只到鄉鎮中心.*|來源頁座標)）$", "", cand.get("addr", "")).strip(), "url": cand.get("url", ""),
                    "lat": cand["lat"], "lng": cand["lng"],
                    "src": cand["src"], "tb_id": cand.get("id", ""), "img": ""})
    json.dump({"_readme": "單位 H-1 確認網頁產出（places_apply_tw.py）。欄位說明見 _template.json；"
                          "lat/lng 是使用者確認過的座標。", "places": out},
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("寫入 %d 筆 → %s" % (len(out), out_path))
    if todo:
        print("還沒確認 %d 筆（沒有寫入）：%s" % (len(todo), "、".join(todo)))
    if none:
        print("都不對 %d 筆（沒有寫入，要另外補）：%s" % (len(none), "、".join(none)))


if __name__ == "__main__":
    main()
