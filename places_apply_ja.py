#!/usr/bin/env python3
"""
把景點日文名寫回 places_src/taiwan.json（單位 H-2 的日文名那一段）。

    python3 places_apply_ja.py <ja 匯出資料夾>

初稿在 places_src/_h2_ja/names.json（日文維基條目名＋Claude 翻的）；使用者在審閱頁改過的
存在該頁資料庫 `ja` 集合（Claude 用 ArtifactData 的 list＋out_dir 匯出，每區一個 aNN.json）。
**改過的優先，沒改的用初稿。** 名稱對不上的（清單改名了）會列出來、不寫。
"""
import json
import os
import sys
from glob import glob

HERE = os.path.dirname(os.path.abspath(__file__))
LIST = os.path.join(HERE, "places_src", "taiwan.json")
DRAFT = os.path.join(HERE, "places_src", "_h2_ja", "names.json")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    draft = {(r["a"], r["n"]): r for r in json.load(open(DRAFT, encoding="utf-8"))}
    edits = {}
    for f in glob(os.path.join(sys.argv[1], "a*.json")):
        doc = json.load(open(f, encoding="utf-8"))
        doc = doc.get("data", doc)
        edits[os.path.basename(f)[:-5]] = doc.get("j", {})
    data = json.load(open(LIST, encoding="utf-8"))
    n_edit = n_draft = 0
    miss = []
    for p in data["places"]:
        r = draft.get((p["area"], p["title"]))
        if not r:
            miss.append(p["area"] + "：" + p["title"])
            continue
        v = edits.get(r["k"], {}).get(p["title"])
        if v:
            p["title_ja"], n_edit = v.strip(), n_edit + 1
        else:
            p["title_ja"], n_draft = r["ja"], n_draft + 1
    json.dump(data, open(LIST, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("日文名寫入：使用者改過 %d／照初稿 %d → %s" % (n_edit, n_draft, LIST))
    if miss:
        print("初稿裡找不到（沒寫）：" + "、".join(miss))


if __name__ == "__main__":
    main()
