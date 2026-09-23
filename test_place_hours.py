#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""景點營業時間「分批」的離線回歸測試（單位 あ-1，2026-09-04）。**不打網路。**

    python3 test_place_hours.py

⚠️⚠️ **這支存在的理由很具體：本機跑不了 `--hours`（沒有 LLM 金鑰），
所以分批邏輯在上線之前沒有任何別的辦法可以驗。** 同 `test_osm_places.py`
當初的理由（接功能那天 Overpass 整個下午不通，沒有它就分不清是程式錯還是連不上）。

守的是四件事，每一件都寫著「不那樣做會怎樣」：

  1. **每輪只碰 N 筆**，其餘的一個欄位都不准動。
  2. **排隊用 `hours_tried` 不是 `hours_checked`**——後者抓失敗時刻意不更新（H-38），
     拿它排隊的話那幾筆穩定抓不到的會永遠釘在佇列最前面、每輪重試、永遠不讓位，
     **而統計會顯示「這輪抓了 N 筆」，看起來跟正常輪替一模一樣**。
  3. **`hours_tried` 一定要在 `CARRY` 裡**，否則每輪都從空的開始重排，
     於是每個月抓的永遠是同樣那前 N 筆，**一樣看起來完全正常**。
  4. **時間預算用完要乾淨收工**，而且不可以動到沒輪到的那幾筆。

⚠️ H-38（抓不到就保留上次的值、逐欄保留）也一起守著——分批不可以把它弄壞。
"""
import sys
import build_places as bp

PASS = FAIL = 0


def ck(cond, label):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print('  FAIL  %s' % label)


# ── 測試替身 ────────────────────────────────────────────────────────
# `always_fail` 的那幾筆代表「穩定的資料問題」（沒填 hours_url、首頁抽不到），
# **不是偶發的網路逾時**——這正是它與 reverify_coords 的差別，也是第 2 條的來源。

def install_fakes(always_fail=()):
    bp.PLACE_WAIT = 0
    bp.fetch_page = lambda url: 'ページ'
    def fake_extract(chain, rec, page):
        if rec['id'] in always_fail:
            return '', '', '沒有找到營業時間'
        return '9:00-17:00', '月曜休', ''
    bp.extract_hours = fake_extract


def set_today(d):
    bp.fe.TODAY = __import__('datetime').date.fromisoformat(d)


def mk(i, **kw):
    r = {'id': 'pl-%02d' % i, 'title': '景點%02d' % i, 'title_ja': '景点%02d' % i,
         'url': 'https://example.invalid/%d' % i, 'no_hours': False}
    r.update(kw)
    return r


def ids(recs):
    return [r['id'] for r in recs]


# ═══ 1. 每輪只碰 N 筆 ═══════════════════════════════════════════════
print('1. 每輪只碰 N 筆')
install_fakes()
set_today('2026-09-10')
bp.HOURS_PER_RUN, bp.HOURS_BUDGET_SEC = 3, 3600
recs = [mk(i) for i in range(10)]
info = bp.run_hours(recs, chain=object())
touched = [r for r in recs if r.get('hours_tried')]
ck(len(touched) == 3, '這輪應該只輪到 3 筆，實際 %d' % len(touched))
ck(info['queued'] == 3 and info['pool'] == 10, '統計：排入 3／母體 10')
ck(info['never'] == 7, '還沒輪到過應為 7，實際 %d' % info['never'])
untouched = [r for r in recs if not r.get('hours_tried')]
ck(all(not r.get('hours') and not r.get('hours_fail') for r in untouched),
   '沒輪到的那 7 筆一個欄位都不該被動到')

# ═══ 2. no_hours 不進母體 ══════════════════════════════════════════
print('2. no_hours 不進母體')
install_fakes()
set_today('2026-09-10')
bp.HOURS_PER_RUN = 100
recs = [mk(i) for i in range(5)] + [mk(90 + i, no_hours=True) for i in range(3)]
info = bp.run_hours(recs, chain=object())
ck(info['pool'] == 5, '母體應扣掉 no_hours 的 3 筆，實際 %d' % info['pool'])
ck(len(info['skip']) == 3, 'skip 應為 3')
ck(info['never'] == 0, 'no_hours 不算「還沒輪到」，否則進度永遠停在還有 3 筆')
ck(all(not r.get('hours_tried') for r in recs if r['no_hours']),
   'no_hours 那幾筆不該被蓋上 hours_tried')

# ═══ 3. 輪替：連跑幾輪要輪得完，而且不重複 ═════════════════════════
print('3. 輪替')
install_fakes()
bp.HOURS_PER_RUN, bp.HOURS_BUDGET_SEC = 3, 3600
recs = [mk(i) for i in range(10)]
seen = []
for n, day in enumerate(('2026-09-10', '2026-10-10', '2026-11-10', '2026-12-10')):
    set_today(day)
    before = {r['id']: r.get('hours_tried') for r in recs}
    bp.run_hours(recs, chain=object())
    seen.append([r['id'] for r in recs if r.get('hours_tried') != before[r['id']]])
flat = [i for round_ in seen for i in round_]
ck(len(set(flat)) == 10, '10 筆應全部輪到過，實際 %d 筆' % len(set(flat)))
ck(seen[0] == ['pl-00', 'pl-01', 'pl-02'] and seen[1] == ['pl-03', 'pl-04', 'pl-05'],
   '第二輪應該換人，實際 %s' % seen[1])
# ⚠️ 第四輪是 3 筆不是 1 筆，**佇列本來就會補滿**——這正是「每月重新確認」的意思：
# 沒輪過的 pl-09 排第一，後面接最舊的 pl-00／pl-01 開始下一圈。
# （這一項第一版寫成「四輪合計 10 人次」而 FAIL，是測試錯了不是程式錯了。）
ck(len(flat) == 12, '四輪合計應為 12 人次（佇列每輪補滿），實際 %d' % len(flat))
# ⚠️ 比集合不比順序：`seen` 是照 recs 的順序收集的，不是佇列順序。
ck(set(seen[3]) == {'pl-09', 'pl-00', 'pl-01'},
   '第四輪應是「沒輪過的 pl-09 ＋ 最舊的 pl-00/01」，實際 %s' % seen[3])

# ═══ 4. ⚠️ 陷阱：穩定抓不到的那幾筆不可以霸佔佇列 ══════════════════
print('4. 穩定抓不到的不可以霸佔佇列（拿 hours_checked 排隊就會這樣）')
install_fakes(always_fail={'pl-00', 'pl-01'})
bp.HOURS_PER_RUN, bp.HOURS_BUDGET_SEC = 2, 3600
recs = [mk(i) for i in range(6)]
rounds = []
for day in ('2026-09-10', '2026-10-10', '2026-11-10'):
    set_today(day)
    before = {r['id']: r.get('hours_tried') for r in recs}
    bp.run_hours(recs, chain=object())
    rounds.append([r['id'] for r in recs if r.get('hours_tried') != before[r['id']]])
ck(rounds[0] == ['pl-00', 'pl-01'], '第一輪先輪到那兩筆（它們最舊）')
ck(rounds[1] == ['pl-02', 'pl-03'],
   '⚠️ 第二輪必須換人。實際 %s——若回到 pl-00/01，就是拿 hours_checked 排隊了' % rounds[1])
ck(rounds[2] == ['pl-04', 'pl-05'], '第三輪繼續往下，實際 %s' % rounds[2])
fails = [r for r in recs if r['id'] in ('pl-00', 'pl-01')]
ck(all(r.get('hours_fail') == 1 for r in fails),
   '⚠️ 抓不到的只該被試一次，不是每輪都試（連續失敗計數會虛胖成 3）')
ck(all(not r.get('hours_checked') for r in fails),
   'hours_checked 抓失敗時不可更新（H-38，它的意思是「這天我確認過內容」）')
ck(all(r.get('hours_tried') for r in fails),
   'hours_tried 抓失敗時一定要更新，那正是它與 hours_checked 分家的全部理由')

# ═══ 5. H-38：抓不到保留上次的值，逐欄保留 ═════════════════════════
print('5. H-38 沒被分批弄壞')
install_fakes(always_fail={'pl-00'})
bp.HOURS_PER_RUN, bp.HOURS_BUDGET_SEC = 5, 3600
recs = [mk(0, hours='10:00-18:00', holiday='火曜休', hours_checked='2026-08-21')]
set_today('2026-09-10')
bp.run_hours(recs, chain=object())
r = recs[0]
ck(r['hours'] == '10:00-18:00' and r['holiday'] == '火曜休', '抓不到要保留上次的值')
ck(r['hours_checked'] == '2026-08-21', '抓不到不可以更新 hours_checked')
ck(r['hours_tried'] == '2026-09-10', '抓不到仍要更新 hours_tried')

# ═══ 6. 時間預算用完要乾淨收工 ═════════════════════════════════════
print('6. 時間預算')
install_fakes()
bp.HOURS_PER_RUN, bp.HOURS_BUDGET_SEC = 5, -1
recs = [mk(i) for i in range(5)]
set_today('2026-09-10')
info = bp.run_hours(recs, chain=object())
ck(info['budget_stop'] is True, '預算用完要記在統計裡（否則看不出這輪沒跑完）')
ck(all(not r.get('hours_tried') for r in recs), '被預算擋下的不可以被蓋上 hours_tried')
ck(info['never'] == 5, '沒輪到就還是「還沒輪到過」')

# ═══ 7. hours_tried 必須進 CARRY（否則分批靜默失效）═══════════════
print('7. CARRY：跨輪繼承')
ck('hours_tried' in bp.CARRY, 'hours_tried 必須在 CARRY 裡')
install_fakes()
bp.HOURS_PER_RUN, bp.HOURS_BUDGET_SEC = 2, 3600
base = [mk(i) for i in range(6)]
set_today('2026-09-10')
bp.run_hours(base, chain=object())
# 模擬「寫出 places.json → 下個月重讀 → normalize() 依 CARRY 繼承」整條來回
skel = {'id': '', 'type': '景點', 'genre': '博物館', 'genre_ja': '博物館',
        'title': '', 'title_ja': '', 'venue': '', 'venue_ja': '', 'area': '東京23區',
        'lat': 35.0, 'lng': 139.0, 'geo': 'precise', 'img': '', 'url': '',
        'build_v': bp.BUILD_VERSION, 'address': ''}
written = []
for r in base:
    o = dict(skel); o.update({k: r[k] for k in ('id', 'title', 'title_ja', 'url')})
    for k in bp.CARRY:
        if r.get(k):
            o[k] = r[k]
    written.append(o)
nxt = [mk(i) for i in range(6)]
for fresh, old in zip(nxt, written):          # ＝ normalize() 裡那個 CARRY 迴圈
    for k in bp.CARRY:
        if old.get(k):
            fresh[k] = old[k]
set_today('2026-10-10')
before = {r['id']: r.get('hours_tried') for r in nxt}
bp.run_hours(nxt, chain=object())
moved = [r['id'] for r in nxt if r.get('hours_tried') != before[r['id']]]
ck(moved == ['pl-02', 'pl-03'],
   '⚠️ 下個月要接著往下輪，實際 %s——若回到 pl-00/01，就是 CARRY 沒帶 hours_tried' % moved)

print('\n%d PASS / %d FAIL' % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
