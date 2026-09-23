#!/usr/bin/env node
/**
 * 票券聯盟連結的離線回歸（2026-09-03 新增，第四支常設測試，單位 U-1）。
 *
 * **它守的是一族「違反了也完全看不出來」的規則。** Klook 官方 custom_tag_guide
 * 對聯盟連結有四條硬性規定，而**違反時全部是靜默的**——連結照樣打得開、
 * 打開的照樣是對的那件商品，只是佣金算不到（或帳號被停權）：
 *
 * 1. ⚠️⚠️ **`k_site` 必須是整串網址的最後一個參數**（原文：Must be placed as the last
 *    query parameter in the entire URL）。**這是規定不是排版風格**——日後要加參數
 *    一律加在 `aff_label1` 後面、`k_site` 前面。**接在後面會壞，而且很可能是靜默的。**
 * 2. `k_site` 只支援 `www.klook.com`，且必須 URL 編碼（`s.klook.com` 的短網址不計成效）。
 * 3. `aff_label1` 只放「版面位置」那四個值。⚠️ 標籤組合有 2,000 個上限，超過之後
 *    **不報錯、只是標籤變空的**；而放使用者／事件層級的資料是**會被停權的等級**。
 * 4. `aid` 要正確，否則整條連結等於白給。
 *
 * ⚠️ **站上沒有任何地方看得出這幾件事**：`aff_label1` 不會回顯在轉址目標上，
 * 只有 Klook 後台看得到。所以唯一能守住它的東西就是這支測試。
 *
 * ⚠️ **它呼叫的是產品真正的那個 `linkOf`**（`js/tickets.js` 為此 export 它），
 * 不是在這裡照著規則重寫一份——那等於自己跟自己對答案。
 *
 * 涵蓋四組：
 *   A 規則   —— 兩條路都測（`AFF_REDIRECT` 開＝後台方法 2；關＝方法 3 的 `?aid=`）
 *   B 真實資料 —— `places.json` 裡每一件票券實際會送出去的連結
 *   C 突變   —— 故意造五種違規字串，確認檢查器**真的抓得到**（否則 A、B 全過也證明不了事）
 *   D 過濾與排序 —— `usable()` 的三種「不能」與 `mainTickets()` 的順序
 *
 * **完全不打網路，一秒跑完。** `node test_tickets.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FAIL = [];
function chk(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (!cond && extra !== undefined ? '   ' + extra : ''));
  if (!cond) FAIL.push(label);
}

// ── 最小 DOM stub ──────────────────────────────────────────────
// `js/tickets.js` 在頂層抓 `#ticketSheet` 並掛一個委派監聽器（三處的鈕共用它）。
// ⚠️ **`getElementById` 一定要回 `null`**：模組裡是 `if(sheet){…}`，回一個假物件
// 反而會讓它去綁 `#ticketCancel` 的監聽器而炸掉。
globalThis.document = { getElementById: () => null, addEventListener: () => {} };
try {   // 只為了消掉 Node 的 localStorage 實驗性警告；store.js 自己有 try/catch
  Object.defineProperty(globalThis, 'localStorage',
    { value: { getItem: () => null, setItem: () => {} }, configurable: true });
} catch { /* 覆蓋不了就算了，store.js 接得住 */ }

const { AFF_IDS, AFF_REDIRECT, PLATFORMS } = await import('./js/config.js');
const { linkOf, mainTickets, ticketBtnHTML } = await import('./js/tickets.js');

const AID = AFF_IDS.klook;
const WHERE_OK = ['popup', 'sheet', 'plan', 'pick'];
const REDIRECT_PREFIX = 'https://affiliate.klook.com/redirect?';
const K = 'https://www.klook.com/zh-TW/activity/37909-aqua-world/';

// ── 檢查器：一條「方法 2」的連結有沒有違反那四條 ──────────────────
// 回問題陣列（空陣列＝合規）。C 組會拿故意做壞的字串餵它，確認它真的會出聲。
function redirectIssues(link, wantWhere) {
  if (typeof link !== 'string' || !link.startsWith(REDIRECT_PREFIX))
    return ['不是走 affiliate.klook.com 的轉址網址：' + link];
  const qs = link.slice(REDIRECT_PREFIX.length);
  const bad = [];
  const i = qs.indexOf('k_site=');
  if (i < 0) bad.push('沒有 k_site');
  // 規定 1：k_site 之後不可以再有任何參數
  else if (qs.slice(i).includes('&')) bad.push('k_site 後面還有別的參數（官方明訂它必須在最後）');
  const u = new URL(link);
  const site = u.searchParams.get('k_site') || '';
  // 規定 2：指向 www.klook.com，而且原始字串裡必須是編碼過的
  if (!site.startsWith('https://www.klook.com/')) bad.push('k_site 不是 www.klook.com：' + site);
  const rawSite = i < 0 ? '' : qs.slice(i + 'k_site='.length);
  if (rawSite.includes('://') || rawSite.includes('/')) bad.push('k_site 沒有 URL 編碼：' + rawSite);
  // 規定 4：aid
  if (u.searchParams.get('aid') !== AID) bad.push('aid 不是 ' + AID + '：' + u.searchParams.get('aid'));
  // 規定 3：標籤只放版面位置
  const lab = u.searchParams.get('aff_label1');
  if (!WHERE_OK.includes(lab) && lab !== 'other') bad.push('aff_label1 不是合法值：' + lab);
  if (wantWhere !== undefined && lab !== wantWhere) bad.push('aff_label1 應為 ' + wantWhere + '，實際 ' + lab);
  // 順序：aid → aff_label1 → k_site（k_site 在最後是規定，前兩個的順序是本站的寫法）
  const order = [...u.searchParams.keys()].join(',');
  if (order !== 'aid,aff_label1,k_site') bad.push('參數順序不是 aid,aff_label1,k_site：' + order);
  return bad;
}

console.log('\n=== A. 連結組裝規則 ===');
// ⚠️ **第一項先問「現在走的是哪一條路」**：`AFF_REDIRECT` 決定 linkOf 產出的形狀，
// 不先確認的話，日後有人把它關掉，下面整組斷言會變成在測另一件事而且全部照過。
chk('環境檢查：AID 有填、且現在走的是後台方法 2（轉址）',
  !!AID && AFF_REDIRECT === true, 'AID=' + JSON.stringify(AID) + ' AFF_REDIRECT=' + AFF_REDIRECT);

for (const w of WHERE_OK) {
  const bad = redirectIssues(linkOf({ platform: 'klook', url: K }, w), w);
  chk('where="' + w + '" 產出的連結完全合規', bad.length === 0, bad.join('；'));
}
chk('認不得的位置回 other（不是空字串——空的在後台跟「沒帶標籤」分不出來）',
  new URL(linkOf({ platform: 'klook', url: K }, 'nowhere')).searchParams.get('aff_label1') === 'other',
  linkOf({ platform: 'klook', url: K }, 'nowhere'));
chk('沒給位置也回 other',
  new URL(linkOf({ platform: 'klook', url: K })).searchParams.get('aff_label1') === 'other');

// 商品網址本身帶 query 時，編碼後不可以把 & 洩漏到外層（否則 k_site 就不是最後一個了）
const withQ = 'https://www.klook.com/zh-TW/activity/1-x/?spm=abc&foo=bar';
chk('商品網址自己帶 query 時，& 有被編碼、k_site 仍是最後一個參數',
  redirectIssues(linkOf({ platform: 'klook', url: withQ }, 'popup'), 'popup').length === 0,
  linkOf({ platform: 'klook', url: withQ }, 'popup'));

chk('s.klook.com 短網址原樣送出（短網址不計成效，寧可少賺也不送假的追蹤連結）',
  linkOf({ platform: 'klook', url: 'https://s.klook.com/abc' }, 'popup') === 'https://s.klook.com/abc');
chk('非 Klook 平台原樣送出（KKday 的參數規則還不知道，猜錯＝佣金全部算不到）',
  linkOf({ platform: 'kkday', url: 'https://www.kkday.com/zh-tw/product/1' }, 'popup')
  === 'https://www.kkday.com/zh-tw/product/1');
chk('aff_url 優先於自己組（給「網址真的不一樣」的平台留的後路）',
  linkOf({ platform: 'klook', url: K, aff_url: 'https://example.com/x' }, 'popup') === 'https://example.com/x');
chk('沒有網址就回空字串', linkOf({ platform: 'klook', url: '' }, 'popup') === '');

console.log('\n=== A2. 另一條路：AFF_REDIRECT=false（後台方法 3）===');
// ⚠️ **這條路隨時可能被切回去**（CLAUDE.md：「要換回去只改 AFF_REDIRECT=false，
// 資料層一個字都不必動」），所以它也要有測試——否則切回去的那天等於整組沒有守門。
// 做法：把 js/ 複製到暫存目錄、改那一行、import 那一份。**repo 裡的檔案不動。**
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpev-tickets-'));
try {
  fs.cpSync(path.join(ROOT, 'js'), path.join(tmp, 'js'), { recursive: true });
  const cfgPath = path.join(tmp, 'js', 'config.js');
  const src = fs.readFileSync(cfgPath, 'utf8');
  const swapped = src.replace('var AFF_REDIRECT=true;', 'var AFF_REDIRECT=false;');
  chk('環境檢查：暫存副本裡真的把 AFF_REDIRECT 改掉了（沒改成功的話下面等於在重測方法 2）',
    swapped !== src);
  fs.writeFileSync(cfgPath, swapped);
  const m3 = await import(pathToFileURL(path.join(tmp, 'js', 'tickets.js')).href);
  const l3 = m3.linkOf({ platform: 'klook', url: K }, 'popup');
  chk('方法 3：直接在商品網址後面加 ?aid=', l3 === K + '?aid=' + AID, l3);
  const l3q = m3.linkOf({ platform: 'klook', url: withQ }, 'popup');
  chk('方法 3：網址已經有 query 時改用 &', l3q === withQ + '&aid=' + AID, l3q);
  chk('方法 3：不經過 affiliate.klook.com（少一次轉址，滑過去看到的就是 klook.com）',
    !l3.includes('affiliate.klook.com'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== B. 真實資料：places.json 裡每一件票券 ===');
const places = JSON.parse(fs.readFileSync(path.join(ROOT, 'places.json'), 'utf8'));
const list = Array.isArray(places) ? places : places.places;
// 合法值從 build_places.py 讀，**不在這裡另存一份**——同一件事有兩個版本，
// 漏改的那一份就會開始說謊（同 test_areas.py 守三份 AREAS 的理由）。
const py = fs.readFileSync(path.join(ROOT, 'build_places.py'), 'utf8');
const tupleOf = (name) => {
  const m = new RegExp(name + "\\s*=\\s*\\(([^)]*)\\)").exec(py);
  return m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
};
const OK_PLATFORM = tupleOf('TICKET_PLATFORMS'), OK_TYPE = tupleOf('TICKET_TYPES'), OK_STATUS = tupleOf('TICKET_STATUS');
chk('環境檢查：從 build_places.py 讀到合法值（讀不到的話下面整組是空跑）',
  OK_PLATFORM.length && OK_TYPE.length && OK_STATUS.length,
  JSON.stringify([OK_PLATFORM, OK_TYPE, OK_STATUS]));

const withTickets = list.filter(p => (p.tickets || []).length);
let nTk = 0, linkBad = [], dataBad = [];
for (const p of withTickets) {
  const primaryPerPlatform = {};
  for (const tk of p.tickets) {
    nTk++;
    const w = p.id + ' / ' + (tk.name || tk.type || '?');
    if (!OK_PLATFORM.includes(tk.platform)) dataBad.push(w + '：平台不認得 ' + tk.platform);
    if (tk.type && !OK_TYPE.includes(tk.type)) dataBad.push(w + '：票種不認得 ' + tk.type);
    if (tk.status && !OK_STATUS.includes(tk.status)) dataBad.push(w + '：狀態不認得 ' + tk.status);
    if (!PLATFORMS.some(x => x.key === tk.platform)) dataBad.push(w + '：config 的 PLATFORMS 表上沒有 ' + tk.platform);
    if (tk.primary) primaryPerPlatform[tk.platform] = (primaryPerPlatform[tk.platform] || 0) + 1;
    if (tk.platform === 'klook') {
      // ⚠️ 資料層存的必須是**乾淨的商品網址**：殘留 gclid／UTM 會拿不到佣金，
      //    而畫面上完全看不出來（連結照樣打得開）。
      if (!/^https:\/\/www\.klook\.com\//.test(tk.url || '')) dataBad.push(w + '：url 不是 www.klook.com：' + tk.url);
      if (/[?&](gclid|utm_|aid=)/.test(tk.url || '')) dataBad.push(w + '：url 殘留追蹤參數：' + tk.url);
    }
    // 真正會送出去的那條連結
    if (!tk.aff_url && tk.platform === 'klook' && AFF_REDIRECT) {
      const bad = redirectIssues(linkOf(tk, 'popup'), 'popup');
      if (bad.length) linkBad.push(w + '：' + bad.join('；'));
    }
  }
  for (const k in primaryPerPlatform)
    if (primaryPerPlatform[k] > 1) dataBad.push(p.id + '：' + k + ' 有 ' + primaryPerPlatform[k] + ' 件 primary（只能有一件）');
}
chk('有票券的景點數 > 0（讀不到資料的話下面全部是空跑）', withTickets.length > 0, withTickets.length);
chk('全部 ' + nTk + ' 件票券送出去的連結都合規', linkBad.length === 0, linkBad.slice(0, 5).join(' ｜ '));
chk('資料層本身乾淨（平台／票種／狀態／網址／primary）', dataBad.length === 0, dataBad.slice(0, 5).join(' ｜ '));

console.log('\n=== C. 突變：檢查器真的抓得到嗎 ===');
// ⚠️ **沒有這一組，A、B 全過也證明不了任何事**——本專案踩過「測試通過但什麼都沒測到」
// （2026-08-29 座標守門那次）。這裡故意造五種違規字串，逐一確認檢查器會出聲。
const good = linkOf({ platform: 'klook', url: K }, 'popup');
const mutants = [
  ['k_site 後面多接一個參數', good + '&utm_source=x'],
  ['k_site 沒有 URL 編碼', REDIRECT_PREFIX + 'aid=' + AID + '&aff_label1=popup&k_site=' + K],
  ['aid 被改掉', good.replace('aid=' + AID, 'aid=999999')],
  ['aff_label1 放了使用者層級的資料（會被停權的那種）',
    REDIRECT_PREFIX + 'aid=' + AID + '&aff_label1=user-12345&k_site=' + encodeURIComponent(K)],
  ['k_site 排在最前面（順序錯）',
    REDIRECT_PREFIX + 'k_site=' + encodeURIComponent(K) + '&aid=' + AID + '&aff_label1=popup'],
];
for (const [name, mut] of mutants)
  chk('抓得到：' + name, redirectIssues(mut).length > 0);
chk('對照組：沒動過的連結不會被誤報', redirectIssues(good, 'popup').length === 0, good);

console.log('\n=== D. 哪一件會出現在畫面上 ===');
const rec = (tks) => ({ id: 'pl-t', tickets: tks });
chk('狀態不是 active 的當作沒有', mainTickets(rec([{ platform: 'klook', url: K, status: 'inactive' }])).length === 0);
chk('兩個網址都空的當作沒有', mainTickets(rec([{ platform: 'klook', url: '', aff_url: '' }])).length === 0);
chk('根本不是物件的當作沒有', mainTickets(rec(['x', null, 3])).length === 0);
const two = mainTickets(rec([
  { platform: 'klook', url: K, name: '甲' },
  { platform: 'klook', url: K, name: '乙', primary: true },
]));
chk('同平台 primary 排前面（其餘維持資料裡的順序）', two.length === 2 && two[0].name === '乙',
  two.map(t => t.name).join(','));
chk('一件也會出現（2026-09-02 起一家平台也跳中轉小卡，入口只有一條路）',
  mainTickets(rec([{ platform: 'klook', url: K }])).length === 1);
chk('零件時那顆鈕整顆不出現（不做成灰掉的死鈕）', ticketBtnHTML(rec([]), 'ticket', 'popup') === '');
const html = ticketBtnHTML(rec([{ platform: 'klook', url: K }]), 'ticket', 'nowhere');
chk('鈕上的 data-where 也走同一套正規化（認不得→other）', html.includes('data-where="other"'), html);

console.log();
if (FAIL.length) {
  console.log(FAIL.length + ' 項失敗：' + FAIL.join('、'));
  process.exit(1);
}
console.log('全部通過（' + nTk + ' 件票券、' + withTickets.length + ' 個景點）');
