#!/usr/bin/env python3
"""地區桶三份清單的離線回歸（2026-09-02 新增，第三支常設測試）。

**它守的不變量只有一個：同一件事不可以有兩個版本。**

`AREAS` 存在三個檔案裡（`fetch_events.py`／`build_restaurants.py`／`js/config.js`），
`SPOTS`／`SPOT_R` 存在兩個檔案裡。⚠️ **漏改一處的症狀全部是「壞掉但看起來完全正常」**：

- 三份 `AREAS` 不一致 → 抓到的活動被 `clean_event` 整筆丟棄（前端有那個桶、後端沒有），
  或地區下拉少一個選項（後端有、前端沒有）。**兩種都沒有錯誤訊息。**
- 兩份 `SPOTS` 不一致 → 清單篩選與地圖把同一家店歸到不同據點。
- `AREA_SPEC`／`AREA_CENTER`／`AREA_ADMIN`／`AREA_PREF_OK` 少一個桶 → 那個桶的活動
  查不到座標時退到東京車站，而前端只顯示成「概略位置」。
- `AREA_GROUPS` 漏一個桶 → 那個桶在圈的介面上沒有群組標題。

**完全不打網路，一秒跑完。** `python3 test_areas.py`
"""
import importlib.util
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
FAIL = []


def load(mod_path, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, mod_path))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def chk(label, cond, extra=''):
    print(('  PASS  ' if cond else '  FAIL  ') + label + (('   ' + str(extra)) if not cond else ''))
    if not cond:
        FAIL.append(label)


def strip_comments(t):
    return re.sub(r'//[^\n]*', '', t)


def js_block(js, name, open_ch, close_ch):
    m = re.search(r'var ' + name + r'=' + re.escape(open_ch) + r'(.*?)\n' + re.escape(close_ch) + r';', js, re.S)
    assert m, name + ' 在 js/config.js 裡找不到'
    return m.group(1)


def main():
    fe = load('fetch_events.py', 'fe_test')
    br = load('build_restaurants.py', 'br_test')
    js = io.open(os.path.join(ROOT, 'js', 'config.js'), encoding='utf-8').read()

    js_areas = json.loads(re.search(r'var AREAS=(\[.*?\]);', js, re.S).group(1).replace("'", '"'))

    print('[1] AREAS 三份逐字相同')
    chk('fetch_events.py == build_restaurants.py', fe.AREAS == br.AREAS,
        sorted(set(fe.AREAS) ^ set(br.AREAS)))
    chk('build_restaurants.py == js/config.js', br.AREAS == js_areas,
        sorted(set(br.AREAS) ^ set(js_areas)))
    chk('桶名沒有重複', len(js_areas) == len(set(js_areas)))
    # 「其他」是舊資料的殘留值（LEGACY_AREA），不可以出現在白名單裡
    chk('白名單裡沒有「其他」', '其他' not in js_areas)

    print('[2] SPOTS 兩份逐字相同')
    body = strip_comments(js_block(js, 'SPOTS', '{', '}'))
    js_spots = {k: (float(a), float(b))
                for k, a, b in re.findall(r"'([^']+)':\[(-?[\d.]+),(-?[\d.]+)\]", body)}
    chk('據點名稱集合相同', set(br.SPOTS) == set(js_spots),
        sorted(set(br.SPOTS) ^ set(js_spots)))
    off = [k for k in br.SPOTS if k in js_spots
           and (round(br.SPOTS[k][0], 6), round(br.SPOTS[k][1], 6))
           != (round(js_spots[k][0], 6), round(js_spots[k][1], 6))]
    chk('據點座標逐一相同', not off, off)
    chk('SPOT_R 相同', br.SPOT_R == float(re.search(r'var SPOT_R=([\d.]+)', js).group(1)))

    print('[3] fetch_events.py 的四張對照表涵蓋每一個桶')
    for name in ('AREA_SPEC', 'AREA_CENTER', 'AREA_ADMIN', 'AREA_PREF_OK'):
        t = getattr(fe, name)
        chk(name, all(a in t for a in fe.AREAS), [a for a in fe.AREAS if a not in t])

    print('[4] 縣別守門（pref_gate 是守門 B 之後的最後一道防線）')
    bad = sorted({p for a in fe.AREAS for p in fe.AREA_PREF_OK[a] if p not in fe.PREF_ALL})
    chk('AREA_PREF_OK 的縣名都在 PREF_ALL 裡', not bad, bad)
    nocenter = sorted({p for a in fe.AREAS for p in fe.AREA_PREF_OK[a] if p not in fe.PREF_CENTER})
    chk('每個被接受的縣都有縣中心可退', not nocenter, nocenter)
    # 桶名一律用全名比對（「東京都」裡含著「京都」兩個字，短名會讓東京被判成京都府）
    shortname = [p for p in fe.PREF_ALL
                 if not (p.endswith('県') or p.endswith('府') or p in ('東京都', '北海道'))]
    chk('PREF_ALL 都是含後綴的全名', not shortname, shortname)

    print('[5] build_restaurants.py 的縣→桶對照')
    ghost = sorted({v for v in br.PREF_AREA.values() if v not in br.AREAS})
    chk('PREF_AREA 沒有指向不存在的桶', not ghost, ghost)
    # area_of 的抽測：每一條分支各一筆，含「刻意不涵蓋」的那一個
    cases = [
        ('愛知県', '名古屋市', '名古屋'), ('静岡県', '浜松市', '東海'),
        ('静岡県', '熱海市', '箱根熱海'), ('山梨県', '甲府市', '北陸甲信越'),
        ('山梨県', '富士吉田市', '富士山周邊'), ('東京都', '渋谷区', '東京23區'),
        ('東京都', '立川市', '東京多摩'), ('神奈川県', '横浜市', '橫濱'),
        ('沖縄県', '那覇市', '沖繩'), ('広島県', '広島市', '廣島'),
        # ⚠️ 神奈川內陸是**刻意維持不涵蓋**（使用者 2026-09-02 決定，只有 14 家餐廳）。
        # 這一筆回空字串是正確結果，不是漏掉——日後有人「順手補上」會踩到這條。
        ('神奈川県', '相模原市', ''),
    ]
    wrong = [(p, c, want, br.area_of(p, c)) for p, c, want in cases if br.area_of(p, c) != want]
    chk('area_of 的 11 個分支抽測', not wrong, wrong)

    print('[6] 前端的圈與中日對照')
    gbody = strip_comments(js_block(js, 'AREA_GROUPS', '{', '}'))
    groups = json.loads(('{' + gbody + '}').replace("'", '"'))
    flat = [b for v in groups.values() for b in v]
    chk('每個桶都被某個圈涵蓋', sorted(flat) == sorted(js_areas),
        sorted(set(js_areas) ^ set(flat)))
    chk('同一個桶不會出現在兩個圈裡', len(flat) == len(set(flat)))
    # ⚠️ `buildAreaSel` 是「圈名一變就關掉 optgroup」，所以同一個圈的桶必須在 AREAS
    # 裡相鄰。拆散的話畫面上會冒出**兩個同名群組、各自帶一個「整個○○」**——
    # 而那看起來只像選單有點怪，不會有任何錯誤訊息。
    seq, split = [], []
    for a in js_areas:
        g = next((k for k, v in groups.items() if a in v), '')
        if not seq or seq[-1] != g:
            if g and g in seq:
                split.append(g)
            seq.append(g)
    chk('同一個圈的桶在 AREAS 裡相鄰', not split, sorted(set(split)))
    # 規則 1：圈名不可與桶名相同，除非那個圈底下只有它自己（一對一的圈不會進選單）
    clash = [g for g in groups if g in js_areas and groups[g] != [g]]
    chk('圈名沒有與桶名撞名（一對一除外）', not clash, clash)
    for lang in ('zh', 'ja'):
        seg = js[js.index('  %s:{' % lang):]
        keys = re.findall(r"'([^']+)':'", re.search(r'areas:\{(.*?)\}', seg, re.S).group(1))
        chk('T.%s.areas 涵蓋 26 桶＋「其他」' % lang,
            sorted(keys) == sorted(js_areas + ['其他']),
            sorted(set(js_areas + ['其他']) ^ set(keys)))
        gkeys = re.findall(r"'([^']+)':'", re.search(r'groups:\{(.*?)\}', seg, re.S).group(1))
        chk('T.%s.groups 涵蓋每一個圈' % lang, sorted(gkeys) == sorted(groups),
            sorted(set(groups) ^ set(gkeys)))

    print()
    if FAIL:
        print('%d 項失敗：%s' % (len(FAIL), '、'.join(FAIL)))
        return 1
    print('全部通過（%d 個地區桶、%d 個據點）' % (len(js_areas), len(js_spots)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
