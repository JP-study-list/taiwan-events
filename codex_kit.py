#!/usr/bin/env python3
"""codex_kit.py — 與「給 Codex 的資料夾」之間的同步工具（2026-08-22）。

Codex **不進這個 repo**（使用者 2026-08-22 決定）。它在一個獨立資料夾工作，
本程式負責兩個方向的搬運：

    export  專案 ──▶ 資料夾   把規範、範本與「已經收過的清單」送過去
    intake  資料夾 ──▶ 專案   把它交回來的新檔收進 places_src/ 並跑一次管線

⚠️ **為什麼要有這支，而不是叫 Codex 直接改 places_src/**
分開資料夾之後，「已經收過哪些」那份清單變成**複製過去的快照**，而快照會過期。
過期的後果不是報錯，是 Codex **把上個月才加的景點再收一次**——它取的 id 不一樣，
所以管線的撞名檢查抓不到，**地圖上會冒出兩顆重疊的圖釘**。
`export` 每次重產那份清單，就是在防這件事。**開工前按一下**。

⚠️ **清單的母體是 `places_src/` 不是 `places.json`。**
`places.json` 只有「已經上線的」，**預收（關東以外，暫不輸出）不在裡面**。
拿它當母體的話，Codex 會把自己上一輪收的大阪景點整批再收一次。

⚠️ **Codex 只產新檔、永遠不改既有檔**（規範裡也這樣寫）。所以 `intake` 只做
「搬進來」不做「合併」——檔名對 `build_places.py` 沒有任何功能意義，
它讀 `places_src/` 底下所有非 `_` 開頭的 `.json`，多一個檔完全正常。
這樣 Codex 不可能弄壞既有那六個已經查證過的檔，也不會產生格式雜訊。

用法（多半由兩顆 .command 雙擊觸發，見 progress.md 第一百零七筆）：

    python3 codex_kit.py export     更新給 Codex 的資料
    python3 codex_kit.py intake     收 Codex 交回來的檔案並跑管線
    python3 codex_kit.py intake --dry-run   只檢查不搬動
"""

import argparse, json, os, re, shutil, subprocess, sys, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'places_src')
OUT = os.path.join(ROOT, 'places.json')
KIT_SRC = os.path.join(ROOT, 'codex_kit')        # 規範正本（進 git）
DEFAULT_KIT = os.path.expanduser('~/Projects/kanto-places-codex')
INBOX_NAME = '交回這裡'
LIST_NAME = '現有景點.json'

# 送過去的三份文件。**正本在 codex_kit/，那邊才是要改的地方。**
COPY_FILES = [(os.path.join(KIT_SRC, 'AGENTS.md'), 'AGENTS.md'),
              (os.path.join(KIT_SRC, '_CODEX.md'), '_CODEX.md'),
              (os.path.join(SRC, '_template.json'), '_template.json')]

ID_RE = re.compile(r'^pl-[a-z0-9-]{1,40}$')


# ═══ export ═══════════════════════════════════════════════════════════

def slim_list():
    """已經收過的景點（**含預收**），精簡成比對重複需要的欄位。

    刻意不送整份 places.json（68KB）：Codex 每次開工都要讀它，而它只需要
    「這個景點收過沒有」。少送的那些欄位（座標、營業時間）對判斷重複毫無幫助，
    卻是每一輪都要付的 token。
    """
    import build_places as bp
    rows, files = bp.load_sources()
    online = set()
    if os.path.exists(OUT):
        with open(OUT, encoding='utf-8') as f:
            online = {p['id'] for p in json.load(f).get('places', [])}
    out, by_area, by_genre = [], {}, {}
    for r in rows:
        pid = (r.get('id') or '').strip()
        rec = {'id': pid,
               'title': r.get('title', ''), 'title_ja': r.get('title_ja', ''),
               'genre': r.get('genre', ''), 'address': r.get('address', ''),
               'url': r.get('url', ''),
               'status': '已上線' if pid in online else '預收'}
        out.append(rec)
        by_genre[rec['genre']] = by_genre.get(rec['genre'], 0) + 1
    # 地區分布只有已上線的算得出來（預收沒有地區桶），所以從 places.json 取。
    if os.path.exists(OUT):
        with open(OUT, encoding='utf-8') as f:
            for p in json.load(f).get('places', []):
                by_area[p['area']] = by_area.get(p['area'], 0) + 1
    out.sort(key=lambda r: r['id'])
    return out, files, by_area, by_genre


def do_export(kit):
    os.makedirs(os.path.join(kit, INBOX_NAME), exist_ok=True)
    recs, files, by_area, by_genre = slim_list()
    pend = len([r for r in recs if r['status'] == '預收'])
    body = {
        '_readme': [
            '這是已經收過的景點清單，**含還沒上線的預收**（看 status 欄）。',
            '新增景點之前先比對這份，不要重複收——兩種都算收過。',
            '⚠️ 這是複製過來的快照。看 更新時間，過期就請人重新匯出。',
            '⚠️ 不要改這個檔，下次同步會被覆蓋。',
        ],
        '更新時間': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        'summary': {
            'count': len(recs), '已上線': len(recs) - pend, '預收': pend,
            '地區分布（已上線）': dict(sorted(by_area.items(), key=lambda kv: -kv[1])),
            '小類分布': dict(sorted(by_genre.items(), key=lambda kv: -kv[1])),
            '來源檔': files,
        },
        'places': recs,
    }
    path = os.path.join(kit, LIST_NAME)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(body, f, ensure_ascii=False, indent=1)
    print('[kit] %s：%d 筆（已上線 %d／預收 %d），%.1f KB'
          % (LIST_NAME, len(recs), len(recs) - pend, pend,
             os.path.getsize(path) / 1024))
    for src, name in COPY_FILES:
        if not os.path.exists(src):
            print('[kit] ⚠ 找不到 %s，跳過' % src, file=sys.stderr)
            continue
        shutil.copy2(src, os.path.join(kit, name))
        print('[kit] 已同步 %s' % name)
    print('[kit] 完成 → %s' % kit)
    return 0


# ═══ intake ═══════════════════════════════════════════════════════════

def check_file(path, known_ids):
    """搬進來之前先檢查。**壞的檔不要進 places_src/。**

    ⚠️ **一定要在搬動之前檢查。** 搬進去才發現 id 撞名的話，`build_places.py`
    會整支中止（H-31 的設計，撞名＝兩個景點合而為一），而那個壞檔已經躺在
    places_src/ 裡了——**下一次跑管線照樣中止**，人得自己去找出是哪個檔。
    """
    errs = []
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        return ['不是合法的 JSON：%s' % e], []
    items = data.get('places') if isinstance(data, dict) else data
    if not isinstance(items, list):
        return ['沒有 places 陣列'], []
    ids = []
    for i, row in enumerate(items, 1):
        if not isinstance(row, dict):
            errs.append('第 %d 筆不是物件' % i)
            continue
        pid = (row.get('id') or '').strip()
        tag = pid or '第 %d 筆' % i
        if not pid:
            errs.append('%s 沒有 id' % tag)
        elif not ID_RE.match(pid):
            errs.append('%s 的 id 不合規則（要 pl- 開頭 ＋ 小寫英數連字號）' % tag)
        elif pid in known_ids:
            errs.append('%s 的 id 與既有景點重複（%s）' % (tag, known_ids[pid]))
        elif pid in ids:
            errs.append('%s 的 id 在同一個檔裡出現兩次' % tag)
        else:
            ids.append(pid)
        for k in ('title', 'title_ja', 'url', 'genre'):
            if not (row.get(k) or '').strip():
                errs.append('%s 缺少必填欄位 %s' % (tag, k))
        # ⚠️ `address` 是「留空要有交代」而不是必填。**規範（_CODEX.md 步驟 2）
        # 明講「官網找不到完整地址就留空並在 `_note` 註明，不要用不完整的湊」**
        # ——自然地景（鳥取砂丘、藏王御釜、四萬十川）本來就沒有番地，
        # 逼它填只會逼出一個「精確的錯誤」，那是本專案最貴的一族。
        # 這裡曾經寫成必填，而 check_file 是「整檔有一筆錯就整檔不收」，
        # 於是 49 筆照規範留空的把同檔 266 筆正確資料一起擋在門外（2026-09-05）。
        # 留空但沒有 `_note` 仍然要擋——那分不出是「查過沒有」還是「忘了填」。
        if not (row.get('address') or '').strip() and not (row.get('_note') or '').strip():
            errs.append('%s 的 address 留空卻沒有 _note 說明原因' % tag)
        # 管線自己會算的欄位，填了代表 Codex 沒照規範走——**擋下來問清楚**，
        # 因為那多半代表它「推測」了座標或地區，而那正是最危險的一種資料。
        for k in ('lat', 'lng', 'geo', 'area', 'type', 'date_start', 'date_end'):
            if k in row:
                errs.append('%s 填了管線自己會算的欄位 %s（不該出現）' % (tag, k))
    return errs, ids


def do_intake(kit, dry_run):
    inbox = os.path.join(kit, INBOX_NAME)
    if not os.path.isdir(inbox):
        print('[kit] 找不到 %s' % inbox, file=sys.stderr)
        return 1
    files = sorted(n for n in os.listdir(inbox)
                   if n.endswith('.json') and not n.startswith('_'))
    if not files:
        print('[kit] %s 裡沒有 .json 檔，沒有東西可收' % INBOX_NAME)
        return 0

    import build_places as bp
    rows, _ = bp.load_sources()
    known = {(r.get('id') or '').strip(): r.get('_src', '') for r in rows}

    ok, bad = [], []
    for name in files:
        errs, ids = check_file(os.path.join(inbox, name), known)
        if errs:
            bad.append((name, errs))
        else:
            ok.append((name, len(ids)))
            for i in ids:                       # 同一批裡的檔彼此也要比對
                known[i] = name

    for name, errs in bad:
        print('[kit] ⛔ %s 有問題，**沒有收進來**：' % name)
        for e in errs[:20]:
            print('        → %s' % e)
        if len(errs) > 20:
            print('        …另有 %d 項' % (len(errs) - 20))
    for name, n in ok:
        print('[kit] ✅ %s：%d 筆，檢查通過' % (name, n))

    if not ok:
        print('[kit] 沒有任何檔案通過檢查，管線不跑。')
        return 1
    if dry_run:
        print('[kit] --dry-run：不搬動、不跑管線。')
        return 0

    for name, _n in ok:
        dst = os.path.join(SRC, name)
        if os.path.exists(dst):
            # ⚠️ **絕不覆蓋。** 同名多半代表上一批已經收過了，蓋掉等於
            # 把人工修過的內容洗掉，而且沒有任何錯誤訊息。
            print('[kit] ⚠ places_src/%s 已存在，跳過（請先改名）' % name, file=sys.stderr)
            continue
        shutil.move(os.path.join(inbox, name), dst)
        print('[kit] 已收進 places_src/%s' % name)

    print('[kit] ── 跑管線 ──')
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'build_places.py')],
                       cwd=ROOT)
    report = os.path.join(ROOT, '_probe', 'places_report.txt')
    if os.path.exists(report):
        print('[kit] 報表：%s' % report)
        subprocess.run(['open', '-t', report])
    return r.returncode


def main():
    ap = argparse.ArgumentParser(description='與「給 Codex 的資料夾」同步')
    ap.add_argument('action', choices=['export', 'intake'])
    ap.add_argument('--kit', default=DEFAULT_KIT, help='那個資料夾的路徑')
    ap.add_argument('--dry-run', action='store_true', help='intake：只檢查不搬動')
    a = ap.parse_args()
    if a.action == 'export':
        return do_export(a.kit)
    return do_intake(a.kit, a.dry_run)


if __name__ == '__main__':
    sys.exit(main())
