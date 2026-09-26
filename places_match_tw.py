#!/usr/bin/env python3
"""
單位 H-1：把使用者圈好的景點名單（places_src/_picked-*.json）對到實際地點，產生候選給確認網頁用。

    python3 places_match_tw.py            # → places_src/_h1_candidates.json

三段式（fetch → serve → apply）的第一段。**這支只產生候選，不寫任何正式資料**：
使用者在確認網頁逐筆選定之後，才由 apply 那一步寫進 places_src/。

每筆景點產生：
  ① 觀光署「景點－觀光資訊資料庫」（資料集 7777）裡名稱相近的紀錄，最多 5 筆（同縣市內找）
  ② ①最好的一筆不夠像時，再用 Photon（OSM 全文搜尋）找，最多 5 筆，只收台灣、同縣市
  ③ 猜好的分類（照名稱關鍵字，網頁上可改）
  ④ 日文名：中文維基有日文條目的，用日文條目名稱（網頁上可改）
  ⑤ 景點編號 `pl-` ＋ 拼音。⚠️ 上線後不可改（行程分享連結存的是它），所以在確認頁一起給使用者看。
     拼音用 pypinyin（只有開發時要，網站本身不需要）；沒裝時退回觀光署的 AttractionID。

⚠️ 觀光署的資料是各縣市自己填的，**很有名的地方也可能不在裡面**（實測鵝鑾鼻、駁二、龍虎塔、
彩虹眷村、海生館都沒有），所以 ② 那條路是必要的，不是備援。
"""
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from glob import glob

import fetch_events as fe   # 共用 http_get（含 GOV_SSL）、pref_gate、AREA_PREF_OK

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(HERE, "places_src")
OUT = os.path.join(SRC_DIR, "_h1_candidates.json")
TB_URL = "https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Attraction-json.zip"
TB_CACHE = os.path.join(SRC_DIR, "_tb_attraction_cache.json")   # 不進版控（.gitignore）
UA = {"User-Agent": "taiwan-events/2.0 (+https://github.com/JP-study-list/taiwan-events)"}

# 名單的地區 → 觀光署資料的縣市欄位
AREA_CITY = {"台北": ["臺北市"], "新北": ["新北市"], "基隆": ["基隆市"], "桃園": ["桃園市"],
             "新竹": ["新竹縣", "新竹市"], "宜蘭": ["宜蘭縣"], "苗栗": ["苗栗縣"], "台中": ["臺中市"],
             "彰化": ["彰化縣"], "南投": ["南投縣"], "雲林": ["雲林縣"], "嘉義": ["嘉義縣", "嘉義市"],
             "台南": ["臺南市"], "高雄": ["高雄市"], "屏東": ["屏東縣"], "花蓮": ["花蓮縣"],
             "台東": ["臺東縣"], "澎湖": ["澎湖縣"], "金門": ["金門縣"], "馬祖": ["連江縣"]}

# 分類（單位 H-3）。**順序就是判斷順序**：先比對到的先贏，所以窄的寫前面。
# 「古蹟老屋」是動工時加的第 13 類：赤崁樓、安平古堡、紅毛城、華山、駁二這種
# 「歷史建築或老屋再利用」，原本 12 類沒有一類貼得上（詳見 progress.md）。
GENRE_RULES = [
    ("動物園水族館", r"動物園|水族館|海洋館|海生館|海洋生物|Xpark|昆蟲館|鳥園|動物樂園"),
    ("樂園", r"樂園|遊樂|六福村|小人國|九族文化村|劍湖山|義大世界|頑皮世界|麗寶"),
    ("觀光工廠", r"觀光工廠|工廠|酒廠|釀造|牙膏|米粉|醬油|餅乾|茶文化館|香腸|糕餅|巧克力共和國|手信|洋傘|優格"),
    ("農場牧場", r"農場|牧場|莊園|果園|茶園|梅花鹿|水豚|萌寵|橙香森林|山林|綠意山莊|卓也小屋|天空之城|綠世界|可可|秘密花園|玫瑰森林|山上人家"),
    ("老街夜市", r"夜市|老街|商圈|[^大]街$|迪化街|市場|西門町|一中|三多|桂花巷|飛機巷"),
    ("溫泉", r"溫泉|冷泉|地熱"),
    ("美術館", r"美術館|藝術|藝文|藝苑|美術"),
    ("博物館", r"博物館|博物院|文物館|故事館|展示館|探索館|科學|紀念館|文化館|史前|文學館|歷史|天文|鐵道|戰史館|教育館|圖書館|化石|太陽館|考古"),
    ("古蹟老屋", r"古堡|赤崁|億載|紅毛城|領事館|古厝|書院|官邸|將軍府|總統府|園邸|林家|宮保第|城門|迎曦門|北門|總兵署|巡檢司|洋樓|文創|眷村|新村|聚落|衖事|糖廠|慶修院|神社|松園|審計|林百貨|得月樓|莒光樓|砲|坑道|戰車|茶室|十村|車庫"),
    ("寺廟宮廟", r"寺|宮|廟|祠|殿|巖|教堂|聖殿|佛光山|城隍"),
    ("地標展望", r"101|大樓|展望|觀景|燈塔|塔|橋|車站|機場|85|光之穹頂|站|平交道|大道"),
    ("自然景觀", r"湖|潭|瀑布|海岸|濕地|沙洲|島|灣|峽谷|森林遊樂區|國家公園|月世界|玄武岩|摩西|風櫃|隧道|步道|山|岩|草原|海|漁港|綠色隧道|大草原"),
    ("公園", r"公園|園區|廣場|草悟道|綠園道|植物園|森林"),
]
GENRES = [g for g, _ in GENRE_RULES]


def guess_genre(name):
    for g, pat in GENRE_RULES:
        if re.search(pat, name):
            return g
    return "公園"


def norm(s):
    s = (s or "").replace("臺", "台")
    s = re.sub(r"[\s（）()_＿・\-－‧．.、,，]", "", s)
    s = re.sub(r"^(國立|市立|縣立|台北市立|新北市立|台中市立|台南市立|高雄市立)", "", s)
    return s.replace("觀光", "")


def bigrams(s):
    return {s[i:i + 2] for i in range(len(s) - 1)} or {s}


def score(q, name):
    """0～100。完全相同 100；一邊包含另一邊 70～95；其餘用雙字組重疊。"""
    a, b = norm(q), norm(name)
    if not a or not b:
        return 0
    if a == b:
        return 100
    if len(a) >= 2 and len(b) >= 2 and (a in b or b in a):
        return max(70, 95 - 3 * abs(len(a) - len(b)))
    # 字依序出現在對方名稱裡：「台南孔廟」⊂「臺南孔子廟」、「華山1914文創園區」⊂「…文化創意產業園區」。
    # 雙字組重疊對這種「中間插字」的縮寫幾乎是 0 分，實測 30 筆沒候選裡有好幾筆是這樣漏的。
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 3 and subseq(short, long_):
        return max(60, 85 - 2 * (len(long_) - len(short)))
    ba, bb = bigrams(a), bigrams(b)
    return round(100 * len(ba & bb) / len(ba | bb) * 0.9)


def subseq(s, t):
    it = iter(t)
    return all(ch in it for ch in s)


def load_tb():
    if os.path.exists(TB_CACHE) and time.time() - os.path.getmtime(TB_CACHE) < 7 * 86400:
        return json.load(open(TB_CACHE, encoding="utf-8"))
    # 壓縮檔要原始位元組，不能走 fe.http_get（它會解碼成字串）。
    # GOV_SSL 在 import fetch_events 時已裝成全域 opener，政府網站的憑證照樣過得了。
    with urllib.request.urlopen(urllib.request.Request(TB_URL, headers=UA), timeout=180) as r:
        raw = r.read()
    z = zipfile.ZipFile(io.BytesIO(raw))
    data = json.loads(z.read("AttractionList.json").decode("utf-8-sig"))["Attractions"]
    keep = []
    for x in data:
        a = x.get("PostalAddress") or {}
        keep.append({"id": x["AttractionID"], "name": x["AttractionName"],
                     "city": a.get("City") or "", "town": a.get("Town") or "",
                     "addr": (a.get("City") or "") + (a.get("Town") or "") + (a.get("StreetAddress") or ""),
                     "lat": x.get("PositionLat"), "lng": x.get("PositionLon"),
                     "url": x.get("WebsiteURL") or "", "status": x.get("ServiceStatus"),
                     "imgs": len(x.get("Images") or [])})
    json.dump(keep, open(TB_CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    return keep


def tb_candidates(name, pool):
    parts = [name] + [p for p in re.split(r"[・（）()]", name) if len(p) >= 2 and p != name]
    scored = []
    for x in pool:
        s = max(score(p, x["name"]) for p in parts)
        if s >= 45:
            scored.append((s, x))
    scored.sort(key=lambda t: -t[0])
    return [dict(x, src="tb", score=s) for s, x in scored[:5]]


PHOTON_CACHE = os.path.join(SRC_DIR, "_h1_photon_cache.json")   # 不進版控；重跑不必再等限速
_pc = None


def photon_candidates(name, area):
    global _pc
    if _pc is None:
        _pc = json.load(open(PHOTON_CACHE, encoding="utf-8")) if os.path.exists(PHOTON_CACHE) else {}
    key = area + "|" + name
    if key not in _pc:
        _pc[key] = _photon(name, area)
        json.dump(_pc, open(PHOTON_CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    if not _pc[key]:
        # 帶縣市反而查不到的（Photon 把「臺北市」當成要比對的字）→ 不帶縣市再查一次，縣市守門照樣在。
        k2 = key + "|nocounty"
        if k2 not in _pc:
            _pc[k2] = _photon(name, area, with_county=False)
            json.dump(_pc, open(PHOTON_CACHE, "w", encoding="utf-8"), ensure_ascii=False)
        return _pc[k2]
    return _pc[key]


def _photon(name, area, with_county=True):
    allowed = fe.AREA_PREF_OK.get(area)
    county = AREA_CITY[area][0]
    lat_min, lng_min, lat_max, lng_max = fe.GEO_BBOX
    q = re.split(r"[（(]", name)[0].replace("・", " ") + (" " + county if with_county else "")
    url = ("https://photon.komoot.io/api/?limit=8&lang=default"
           f"&bbox={lng_min},{lat_min},{lng_max},{lat_max}&q=" + urllib.parse.quote(q))
    try:
        data = json.loads(fe.http_get(url, headers=UA, timeout=30))
    except Exception as e:   # 查不到就是沒有候選，不中斷
        print("  [photon] 失敗 %s：%s" % (name, e))
        return []
    finally:
        time.sleep(1.1)
    out = []
    for f in data.get("features") or []:
        p = f.get("properties", {})
        if p.get("countrycode") != "TW":
            continue
        where = " ".join(str(p.get(k, "")) for k in ("state", "county", "city", "district"))
        if not fe.pref_gate(where, allowed):
            continue
        lng, lat = f["geometry"]["coordinates"][:2]
        nm = p.get("name") or ""
        out.append({"src": "osm", "name": nm, "addr": where.strip() + " " + (p.get("street") or ""),
                    "lat": round(lat, 6), "lng": round(lng, 6), "score": score(name, nm),
                    "kind": "%s=%s" % (p.get("osm_key", ""), p.get("osm_value", ""))})
    out.sort(key=lambda c: -c["score"])
    return out[:5]


MANUAL = os.path.join(SRC_DIR, "_h1_manual.json")


def manual_candidate(area, name):
    """觀光署與地圖搜尋都沒候選的，用人工查到的地址查座標（見 _h1_manual.json）。"""
    if not os.path.exists(MANUAL):
        return []
    m = json.load(open(MANUAL, encoding="utf-8"))["spots"].get(area + "|" + name)
    if not m:
        return []
    lat, lng, how = m.get("lat"), m.get("lng"), "來源頁座標"
    if lat is None:
        r = fe.geocode_addr_tw(m["addr"], AREA_CITY[area][0], fe.AREA_PREF_OK.get(area))
        if r:
            lat, lng, how = r[0], r[1], "門牌" if r[2] == "strong" else "只到路名"
        else:
            county, district, _, _ = fe.parse_tw_addr(m["addr"])
            c = fe.geocode_district_tw(district, county or AREA_CITY[area][0])
            if not c:
                return []
            lat, lng, how = c[0], c[1], "只到鄉鎮中心（要自己看地圖）"
    return [{"src": "web", "name": name, "addr": m["addr"] + "（" + how + "）", "lat": lat, "lng": lng,
             "score": 80, "ref": m.get("ref", ""), "note": m.get("note", "")}]


def ja_names(titles):
    """中文維基標題 → 日文維基標題（有日文條目才有）。一次 45 筆，查不到就是空字串。"""
    res = {}
    titles = list(dict.fromkeys(t for t in titles if t))
    for i in range(0, len(titles), 45):
        part = titles[i:i + 45]
        u = "https://zh.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
            {"action": "query", "titles": "|".join(part), "prop": "langlinks", "lllang": "ja", "lllimit": "max",
             "redirects": 1, "format": "json", "variant": "zh-tw"})
        try:
            d = json.loads(fe.http_get(u, headers=UA, timeout=60))
        except Exception as e:
            print("  [wiki] 失敗：%s" % e)
            continue
        q = d.get("query", {})
        m = {x["from"]: x["to"] for x in q.get("normalized", []) + q.get("redirects", [])}
        ja = {}
        for p in q.get("pages", {}).values():
            ll = p.get("langlinks") or []
            if ll:
                ja[p["title"]] = ll[0].get("*", "")
        for t in part:
            k = t
            while k in m:
                k = m[k]
            if ja.get(k):
                res[t] = ja[k]
        time.sleep(1)
    return res


def slug(name, used, fallback):
    try:
        from pypinyin import lazy_pinyin
    except ImportError:
        s = fallback.lower()
    else:
        base = re.split(r"[（(]", name)[0]
        s = "".join(lazy_pinyin(base))
        s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or fallback.lower()
    s = "pl-" + s
    out, n = s, 2
    while out in used:
        out, n = "%s-%d" % (s, n), n + 1
    used.add(out)
    return out


def main():
    picked = sorted(glob(os.path.join(SRC_DIR, "_picked-*.json")))[-1]
    areas = json.load(open(picked, encoding="utf-8"))["areas"]
    tb = load_tb()
    print("[h1] 名單 %s；觀光署景點 %d 筆" % (os.path.basename(picked), len(tb)))
    by_city = {}
    for x in tb:
        by_city.setdefault(x["city"], []).append(x)
    rows, used, osm_used = [], set(), 0
    for area, names in areas.items():
        pool = [x for c in AREA_CITY[area] for x in by_city.get(c, [])]
        for name in names:
            cands = tb_candidates(name, pool)
            best = cands[0]["score"] if cands else 0
            if best < 90:          # 觀光署找不到夠像的 → 地圖搜尋補候選
                cands += photon_candidates(name, area)
                osm_used += 1
            if not cands:
                cands = manual_candidate(area, name)
            rows.append({"area": area, "name": name, "genre": guess_genre(name), "cands": cands})
        print("  %s %d 筆" % (area, len(names)))
    titles = []
    for r in rows:
        titles.append(re.split(r"[・（(]", r["name"])[0])
        titles += [c["name"] for c in r["cands"][:1] if c["src"] == "tb"]
    ja = ja_names(titles)
    for r in rows:
        first = re.split(r"[・（(]", r["name"])[0]
        tbname = next((c["name"] for c in r["cands"][:1] if c["src"] == "tb"), "")
        r["ja"] = ja.get(first) or ja.get(tbname) or ""
        r["id"] = slug(r["name"], used, next((c["id"] for c in r["cands"] if c.get("id")), "x"))
        # 建議＝分數最高的那一個（同分取前面）。觀光署或地圖搜尋的名稱幾乎一樣（≥90）時，
        # 使用者 2026-09-26 同意**直接算確認**，確認頁預設不顯示，只給他看其餘的。
        if r["cands"]:
            bi = max(range(len(r["cands"])), key=lambda k: (r["cands"][k]["score"], -k))
            r["sug"] = bi
            b = r["cands"][bi]
            r["auto"] = b["src"] in ("tb", "osm") and b["score"] >= 90
    json.dump({"genres": GENRES, "rows": rows}, open(OUT, "w", encoding="utf-8"),
              ensure_ascii=False, indent=0)
    good = sum(1 for r in rows if r["cands"] and r["cands"][0]["score"] >= 90)
    none = sum(1 for r in rows if not r["cands"])
    print("[h1] %d 筆：觀光署有很像的 %d／用地圖搜尋補的 %d／完全沒候選 %d／有日文名 %d → %s"
          % (len(rows), good, osm_used, none, sum(1 for r in rows if r["ja"]), OUT))


if __name__ == "__main__":
    sys.exit(main())
