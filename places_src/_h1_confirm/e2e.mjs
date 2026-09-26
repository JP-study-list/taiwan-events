const PAGE=process.argv[2];
const list=await (await fetch('http://127.0.0.1:9241/json/list')).json();
const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);let id=0;const P={};
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&P[m.id]){P[m.id](m);delete P[m.id];}};
await new Promise(r=>ws.onopen=r);
const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;P[i]=res;ws.send(JSON.stringify({id:i,method,params}));setTimeout(()=>rej(new Error('timeout '+method)),20000);});
const ev=async x=>{try{return (await send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:x})).result.result.value}catch(e){return 'ERR '+e.message}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable');await send('Runtime.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});
await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
// 假資料庫：寫入 150ms 完成，但「存好了」的通知 700ms 後才回來，而且帶的是當時的內容 → 會跟後面的寫入亂序
await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const KEY='fakedb';const load=()=>JSON.parse(localStorage.getItem(KEY)||'{}');const save=d=>localStorage.setItem(KEY,JSON.stringify(d));const L=[];
const emit=d=>{for(const f of L)f({docs:Object.entries(d).map(([id,b])=>({id,data:()=>b,metadata:{hasPendingWrites:false}}))});};
const db={doc(p){const id=p.split('/')[1];return{set:async data=>{const d=load();d[id]=JSON.parse(JSON.stringify(data));save(d);const copy=JSON.parse(JSON.stringify(d));await new Promise(r=>setTimeout(r,150));window.__n=(window.__n||0)+1;setTimeout(()=>emit(copy),window.__n%2?1400:300);}}},
collection(){return{onSnapshot(f){L.push(f);setTimeout(()=>emit(load()),50);return()=>{}}}}};
window.claude={use:async n=>n==='db'?db:null};})();`});
await send('Page.navigate',{url:'http://127.0.0.1:8931/'+PAGE});await sleep(1500);
await ev(`localStorage.clear()`);await send('Page.navigate',{url:'http://127.0.0.1:8931/'+PAGE});await sleep(2500);
const center=async sel=>ev(`(async()=>{const el=${sel};if(!el)return null;el.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,80));const b=el.getBoundingClientRect();const x=b.left+Math.min(20,b.width/2),y=b.top+b.height/2;const hit=document.elementFromPoint(x,y);return {x,y,ok:!!hit&&(el===hit||el.contains(hit)),inView:b.top>=0&&b.bottom<=innerHeight};})()`);
const click=async p=>{for(const type of ['mouseMoved','mousePressed']){await send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});}await sleep(120);await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});};
const dbDoc=async()=>ev(`JSON.parse(localStorage.getItem('fakedb')||'{}').a00?.s||{}`);
const res=[];const check=(name,cond,info)=>{res.push((cond?'PASS ':'FAIL ')+name+(info?'  '+info:''));};
const modeTxt=await ev(`document.querySelector('#mode').textContent+' / claude='+typeof window.claude`);check('環境：假資料庫已連上',String(modeTxt).includes('已連線'),modeTxt);
// T1 選另一個候選 → 按確認（真實滑鼠）
const n1=await ev(`document.querySelector('.card').dataset.n`);
const r1=await center(`document.querySelectorAll('.card')[0].querySelectorAll('label.cand')[1]`);check('T1 候選在畫面內且點得到',r1&&r1.ok&&r1.inView);
await click(r1);await sleep(250);
const g1=await center(`[...document.querySelectorAll('.card')].find(c=>c.dataset.n===${JSON.stringify(n1)}).querySelector('.go')`);await click(g1);
await sleep(2000);   // 讓延遲的舊通知全部回來
let d=await dbDoc();check('T1 '+n1+' 資料庫存成已確認、選第 2 個',d[n1]?.ok===true&&d[n1]?.c===1,JSON.stringify(d[n1]));
// T1b 確認之後在同一區再做別的事（選下一張卡的候選）→ 舊通知若把狀態蓋回去，這一下會把錯的狀態存進資料庫
const rb=await center(`document.querySelectorAll('.card')[0].querySelectorAll('label.cand')[0]`);await click(rb);await sleep(2500);
d=await dbDoc();check('T1b 同區再操作後 '+n1+' 仍是已確認',d[n1]?.ok===true,JSON.stringify(d[n1]));
check('T1 畫面上不再是待確認',(await ev(`!![...document.querySelectorAll('.card')].find(c=>c.dataset.n===${JSON.stringify(n1)})`))===false);
// T2 貼座標後「直接」按確認（不先離開輸入框）
const n2=await ev(`document.querySelector('.card').dataset.n`);
const x2=await center(`document.querySelector('.card input[data-f=xy]')`);await click(x2);await sleep(100);
await send('Input.insertText',{text:'25.0651, 121.5423'});await sleep(100);
const g2=await center(`document.querySelector('.card .go')`);await click(g2);await sleep(2000);
d=await dbDoc();check('T2 '+n2+' 自己貼的座標存進去且已確認',d[n2]?.ok===true&&d[n2]?.c===-2&&d[n2]?.lat===25.0651,JSON.stringify(d[n2]));
// T3 改分類＋日文名後按確認
const n3=await ev(`document.querySelector('.card').dataset.n`);
await ev(`(()=>{const s=document.querySelector('.card select');s.value='自然景觀';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(200);
const j3=await center(`document.querySelector('.card input[data-f=ja]')`);await click(j3);await sleep(80);
await ev(`document.querySelector('.card input[data-f=ja]').value=''`);await send('Input.insertText',{text:'テスト名'});await sleep(80);
const g3=await center(`document.querySelector('.card .go')`);await click(g3);await sleep(2000);
d=await dbDoc();check('T3 '+n3+' 分類與日文名都存進去',d[n3]?.ok===true&&d[n3]?.g==='自然景觀'&&d[n3]?.ja==='テスト名',JSON.stringify(d[n3]));
// T4 清掉頁面自己的快取重開 → 從資料庫還原
const before=await ev(`nOk.textContent`);
await ev(`localStorage.removeItem('twconfirm_v1');localStorage.removeItem('twconfirm_v2')`);await send('Page.navigate',{url:'http://127.0.0.1:8931/'+PAGE});await sleep(2500);
check('T4 重開後從資料庫還原（已確認數不變）',(await ev(`nOk.textContent`))===before,'重開前 '+before+' 重開後 '+(await ev(`nOk.textContent`)));
console.log(res.join('\n'));ws.close();
