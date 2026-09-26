// 景點照片挑圖頁的端對端測試（單位 H-4）。手機觸控模擬＋假資料庫（通知亂序，地雷 21）。
// 用法：在 places_src/_h4_photo/ 起 server（埠 8931，要先跑 places_photo_tw.py build），
//       Chrome 除錯埠 9241，然後 node e2e.mjs [頁面檔名，預設 index.html]
const PAGE = process.argv[2] || 'index.html';
const list = await (await fetch('http://127.0.0.1:9241/json/list')).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); let id = 0; const P = {};
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && P[m.id]) { P[m.id](m); delete P[m.id]; } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; P[i] = res; ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => rej(new Error('timeout ' + method)), 20000); });
const ev = async x => { try { return (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: x })).result.result.value } catch (e) { return 'ERR ' + e.message } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
await send('Page.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
// 假資料庫：寫入後的通知「一下慢一下快」，讓舊通知晚於新通知抵達（亂序）
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const KEY='fakedb';const load=()=>JSON.parse(localStorage.getItem(KEY)||'{}');const save=d=>localStorage.setItem(KEY,JSON.stringify(d));const L=[];
const emit=d=>{for(const f of L)f({docs:Object.entries(d).map(([id,b])=>({id,data:()=>b}))});};
const db={doc(p){const id=p.split('/')[1];return{set:async data=>{const d=load();d[id]=JSON.parse(JSON.stringify(data));save(d);const copy=JSON.parse(JSON.stringify(d));await new Promise(r=>setTimeout(r,150));window.__n=(window.__n||0)+1;setTimeout(()=>emit(copy),window.__n%2?1600:250);}}},
collection(){return{onSnapshot(f){L.push(f);setTimeout(()=>emit(load()),50);return()=>{}}}}};window.claude={use:async n=>n==='db'?db:null};})();` });
const U = 'http://127.0.0.1:8931/' + PAGE;
const go = async () => { await send('Page.navigate', { url: U }); for (let i = 0; i < 40; i++) { await sleep(250); if (await ev(`document.querySelectorAll('.card').length>0`) === true) break; } await sleep(400); };
await send('Page.navigate', { url: U }); await sleep(800); await ev(`localStorage.clear()`); await go();
const res = []; const check = (n, c, i) => res.push((c ? 'PASS ' : 'FAIL ') + n + (i !== undefined ? '  ' + (typeof i === 'string' ? i : JSON.stringify(i)) : ''));
// 真的觸控點下去；點之前捲進畫面並確認那一點打到的就是它（被蓋住＝回 false）。
// 邊界容許 1px：捲到最底邊時下緣是 844.05 對 844，小數誤差曾讓打得到的按鈕被判成畫面外（2026-09-26）
const tap = async sel => { const p = await ev(`(async()=>{const el=${sel};if(!el)return {ok:false,why:'no el'};el.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,120));const b=el.getBoundingClientRect();const x=b.left+b.width/2,y=b.top+b.height/2;const h=document.elementFromPoint(x,y);return {x,y,ok:!!h&&(el===h||el.contains(h))&&b.top>=-1&&b.bottom<=innerHeight+1,why:h&&(h.tagName+'.'+h.className),top:b.top,bottom:b.bottom,H:innerHeight}})()`);
  if (!p || !p.ok) { console.error('tap miss', sel.slice(0, 70), JSON.stringify(p)); return false; }
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] }); await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250); return true; };
const dbAll = () => ev(`(()=>{const d=JSON.parse(localStorage.getItem('fakedb')||'{}');const o={};for(const v of Object.values(d))Object.assign(o,v.p||{});return o;})()`);
const cardSt = cid => ev(`(()=>{const c=document.querySelector('.card[data-id="${cid}"]');if(!c)return null;return {st:c.querySelector('.st').textContent,on:[...c.querySelectorAll('.ph')].findIndex(x=>x.classList.contains('on')),skip:c.classList.contains('skip')}})()`);

check('環境：假資料庫連上、觸控模式', (await ev(`document.querySelector('#mode').textContent`)).includes('已連線') && await ev(`matchMedia('(pointer:coarse)').matches`) === true);
const intro = await ev(`document.querySelector('#intro').textContent`);
check('頁首寫出要挑幾筆', /要你挑的有 \d+ 筆/.test(intro), intro.slice(0, 60));
const todo0 = +(await ev(`document.querySelector('#nTodo').textContent`));
const cards = await ev(`[...document.querySelectorAll('.card')].filter(c=>c.querySelectorAll('.ph').length>=2).slice(0,3).map(c=>c.dataset.id)`);
check('預設畫面有可挑的卡片（每張至少 2 張候選，取 3 張卡）', cards.length === 3, cards);
const [A, B, C] = cards;
const fileOf = (cid, i) => ev(`(()=>{const c=document.querySelector('.card[data-id="${cid}"]');return c.querySelectorAll('.ph img')[${i}] && c.dataset.id})()`);
// T1 點 A 的第 1 張
check('T1 A 第 1 張點得到', await tap(`document.querySelector('.card[data-id="${A}"] button.pick[data-i="0"]')`));
let s = await cardSt(A); check('T1 A 顯示選好了、第 1 張打勾', s && s.st === '選好了' && s.on === 0, s);
// T2 立刻換成第 2 張、再點 B 的第 1 張、再點 C 的「都不要」（連續操作，通知亂序）
check('T2 A 第 2 張點得到', await tap(`document.querySelector('.card[data-id="${A}"] button.pick[data-i="1"]')`));
check('T2 B 第 1 張點得到', await tap(`document.querySelector('.card[data-id="${B}"] button.pick[data-i="0"]')`));
check('T2 C 都不要點得到', await tap(`document.querySelector('.card[data-id="${C}"] [data-skip]')`));
await sleep(4000);        // 等所有亂序通知都到齊
const sA = await cardSt(A), sB = await cardSt(B), sC = await cardSt(C);
check('T2 亂序通知之後畫面沒被蓋回', sA.on === 1 && sB.on === 0 && sC.skip && sC.st === '都不要', { sA, sB, sC });
let d = await dbAll();
const fA1 = await ev(`(()=>{const k=document.querySelector('#areas .chip.on').dataset.k;return JSON.parse(localStorage.getItem('twph_v1'))[k]['${A}']})()`);
check('T2 資料庫與畫面一致（A 是第 2 張的檔名、C 是都不要）', d[A] === fA1 && typeof d[B] === 'string' && d[B].length > 3 && d[C] === '-', { A: d[A], B: d[B], C: d[C] });
const todo1 = +(await ev(`document.querySelector('#nTodo').textContent`));
check('T2 「還沒挑」少了 3', todo1 === todo0 - 3, [todo0, todo1]);
// T3 點已選的那張＝取消
await tap(`document.querySelector('.card[data-id="${B}"] button.pick[data-i="0"]')`); await sleep(2500);
s = await cardSt(B); d = await dbAll();
check('T3 再點一次取消：畫面還沒選、資料庫空字串', s.st === '還沒選' && s.on === -1 && d[B] === '', { s, db: d[B] });
// T4 放大 → 選這張
check('T4 放大鏡點得到', await tap(`document.querySelector('.card[data-id="${B}"] button.zoom[data-z="1"]')`));
check('T4 放大畫面出現', await ev(`!document.querySelector('#box').hidden`) === true);
check('T4 「選這張」點得到', await tap(`document.querySelector('#box [data-bpick]')`));
s = await cardSt(B); check('T4 選好第 2 張、放大畫面關掉', s.on === 1 && await ev(`document.querySelector('#box').hidden`) === true, s);
await sleep(2500);
// T5 清掉本機紀錄重開 → 從資料庫還原
await ev(`localStorage.removeItem('twph_v1')`); await go();
const r5 = [await cardSt(A), await cardSt(B), await cardSt(C)];
check('T5 重開後從資料庫還原', r5[0] && r5[0].on === 1 && r5[1].on === 1 && r5[2].skip, r5);
// T6 先幫你選的：預設打勾、點掉之後變還沒選
check('T6 「先幫你選的」點得到', await tap(`document.querySelector('#views .chip[data-v=sug]')`));
const S = await ev(`(document.querySelector('.card')||{}).dataset?.id||null`);
if (S) {
  s = await cardSt(S); check('T6 建議那張預設打勾', s.st === '先幫你選的' && s.on === 0, s);
  await tap(`document.querySelector('.card[data-id="${S}"] button.pick[data-i="0"]')`); await sleep(2500);
  s = await cardSt(S); d = await dbAll(); check('T6 點掉建議：還沒選、資料庫空字串', s.st === '還沒選' && d[S] === '', { s, db: d[S] });
} else check('T6 這個地區有先幫你選的', false, '沒有，換一個地區測');
// T7 換地區（載入另一份資料檔）
const k2 = await ev(`document.querySelectorAll('#areas .chip')[1].dataset.k`);
check('T7 地區鈕點得到', await tap(`document.querySelectorAll('#areas .chip')[1]`)); await sleep(1500);
check('T7 換地區後有卡片', await ev(`document.querySelectorAll('.card').length>0 && document.querySelector('#areas .chip.on').dataset.k==='${k2}'`) === true);
// T8 手機可點檢查（全部三種顯示 × 目前地區）
await tap(`document.querySelector('#views .chip[data-v=all]')`); await sleep(500);
const bad = await ev(`(async()=>{const bad=[];const H=innerHeight;for(let y=0;y<document.documentElement.scrollHeight;y+=H*0.8){scrollTo(0,y);await new Promise(r=>setTimeout(r,30));
 for(const el of document.querySelectorAll('button')){if(el.closest('#box'))continue;const b=el.getBoundingClientRect();if(b.width===0||b.top<0||b.bottom>H)continue;const h=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);if(!h||!(el===h||el.contains(h)))bad.push((el.closest('.card')||{}).dataset?.id+' '+el.className);}}return [...new Set(bad)];})()`);
const nBtn = await ev(`document.querySelectorAll('button').length`);
check('T8 手機上每顆按鈕都點得到', Array.isArray(bad) && bad.length === 0, `${nBtn} 顆；點不到：` + (bad || []).slice(0, 5).join('、'));
check('T8 沒有橫向捲動', await ev(`document.documentElement.scrollWidth<=innerWidth`) === true);
console.log(res.join('\n')); ws.close(); process.exit(0);
