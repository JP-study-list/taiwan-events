const list=await (await fetch('http://127.0.0.1:9241/json/list')).json();
const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);let id=0;const P={};
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&P[m.id]){P[m.id](m);delete P[m.id];}};
await new Promise(r=>ws.onopen=r);
const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;P[i]=res;ws.send(JSON.stringify({id:i,method,params}));setTimeout(()=>rej(new Error('timeout '+method)),20000);});
const ev=async x=>{try{return (await send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:x})).result.result.value}catch(e){return 'ERR '+e.message}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const KEY='fakedb';const load=()=>JSON.parse(localStorage.getItem(KEY)||'{}');const save=d=>localStorage.setItem(KEY,JSON.stringify(d));const L=[];
const emit=d=>{for(const f of L)f({docs:Object.entries(d).map(([id,b])=>({id,data:()=>b,metadata:{hasPendingWrites:false}}))});};
const db={doc(p){const id=p.split('/')[1];return{set:async data=>{const d=load();d[id]=JSON.parse(JSON.stringify(data));save(d);const copy=JSON.parse(JSON.stringify(d));await new Promise(r=>setTimeout(r,150));window.__n=(window.__n||0)+1;setTimeout(()=>emit(copy),window.__n%2?1400:300);}}},
collection(){return{onSnapshot(f){L.push(f);setTimeout(()=>emit(load()),50);return()=>{}}}}};window.claude={use:async n=>n==='db'?db:null};})();`});
const U='http://127.0.0.1:8931/_p.html';
await send('Page.navigate',{url:U});await sleep(1200);await ev(`localStorage.clear()`);await send('Page.navigate',{url:U});await sleep(2500);
const res=[];const check=(n,c,i)=>res.push((c?'PASS ':'FAIL ')+n+(i?'  '+i:''));
check('環境：假資料庫連上、觸控模式',(await ev(`document.querySelector('#mode').textContent`)).includes('已連線')&&await ev(`matchMedia('(pointer:coarse)').matches`));
check('預設顯示 263 格（我翻的）',(await ev(`document.querySelectorAll('input[data-k]').length`))===263);
const tap=async sel=>{const p=await ev(`(async()=>{const el=${sel};el.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,80));const b=el.getBoundingClientRect();const x=b.left+Math.min(24,b.width/2),y=b.top+b.height/2;const h=document.elementFromPoint(x,y);return {x,y,ok:!!h&&(el===h||el.contains(h))};})()`);
 await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(200);return p.ok;};
// T1 改第 3 格 → 直接點篩選鈕「你改過的」
const n=await ev(`document.querySelectorAll('input[data-k]')[2].dataset.n`);
check('T1 輸入框點得到',await tap(`document.querySelectorAll('input[data-k]')[2]`));
await ev(`document.querySelectorAll('input[data-k]')[2].select()`);await send('Input.insertText',{text:'テスト改名'});
check('T1 篩選鈕點得到',await tap(`document.querySelector('#filters .chip[data-f=chg]')`));await sleep(2500);
const db0=async()=>ev(`(()=>{const d=JSON.parse(localStorage.getItem('fakedb')||'{}');const o={};for(const v of Object.values(d))Object.assign(o,v.j||{});return o;})()`);
let d=await db0();check('T1 資料庫存到改過的名字',d[n]==='テスト改名',JSON.stringify(d));
check('T1 篩選「你改過的」顯示 1 格',(await ev(`document.querySelectorAll('input[data-k]').length`))===1);
// T2 清空 → 回到原本譯名、資料庫移除
await ev(`(()=>{const i=document.querySelector('input[data-k]');i.value='';i.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(2500);
d=await db0();check('T2 清空後資料庫移除、回到原譯名',!(n in d),JSON.stringify(d));
// T3 再改一次 → 清掉頁面快取重開 → 從資料庫還原
await tap(`document.querySelector('#filters .chip[data-f=ai]')`);await ev(`(()=>{const i=document.querySelectorAll('input[data-k]')[5];i.value='再改一次';i.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(2500);
await ev(`localStorage.removeItem('twja_v1')`);await send('Page.navigate',{url:U});await sleep(2500);
check('T3 重開後從資料庫還原',(await ev(`document.querySelectorAll('input[data-k]')[5].value`))==='再改一次');
// T4 手機可點檢查
const bad=await ev(`(async()=>{const bad=[];const H=innerHeight;for(let y=0;y<document.documentElement.scrollHeight;y+=H*0.8){scrollTo(0,y);await new Promise(r=>setTimeout(r,20));
 for(const el of document.querySelectorAll('input,button')){const b=el.getBoundingClientRect();if(b.width===0||b.top<0||b.bottom>H)continue;const h=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);if(!h||!(el===h||el.contains(h)))bad.push(el.dataset.n||el.textContent);}}return [...new Set(bad)];})()`);
check('T4 手機上每格都點得到',bad.length===0,bad.slice(0,5).join('、'));
check('T4 沒有橫向捲動',(await ev(`document.documentElement.scrollWidth<=innerWidth`))===true);
console.log(res.join('\n'));ws.close();
