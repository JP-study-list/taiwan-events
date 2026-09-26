const list=await (await fetch('http://127.0.0.1:9241/json/list')).json();
const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);let id=0;const P={};
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&P[m.id]){P[m.id](m);delete P[m.id];}};
await new Promise(r=>ws.onopen=r);
const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;P[i]=res;ws.send(JSON.stringify({id:i,method,params}));setTimeout(()=>rej(new Error('timeout '+method)),15000);});
const ev=async x=>(await send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:x})).result.result.value;
await send('Network.setCacheDisabled',{cacheDisabled:true});
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
await send('Page.navigate',{url:'http://127.0.0.1:8931/_shot.html'});
await new Promise(r=>setTimeout(r,3000));
console.log('env',await ev(`matchMedia('(pointer:coarse)').matches`));
// 逐段捲動，檢查畫面內每個可點元素的中心點是不是點得到自己
const res=await ev(`(async()=>{const bad=[];let total=0;const H=innerHeight;
 for(let y=0;y<document.documentElement.scrollHeight;y+=H*0.8){scrollTo(0,y);await new Promise(r=>setTimeout(r,30));
  for(const el of document.querySelectorAll('input,button,select,a,label.cand')){const b=el.getBoundingClientRect();
   if(b.width===0||b.top<0||b.bottom>H)continue;total++;const cx=b.left+b.width/2,cy=b.top+b.height/2;const hit=document.elementFromPoint(cx,cy);
   if(!hit||!(el===hit||el.contains(hit)||hit.contains(el)||(hit.closest&&hit.closest('label')===el.closest('label')&&el.closest('label')))){bad.push((el.tagName+'.'+el.className+' '+(el.textContent||el.value||'').trim().slice(0,12))+' → '+(hit?hit.tagName+'.'+hit.className:'null')+' @'+Math.round(cy));}}}
 return {total,bad:[...new Set(bad)].slice(0,20)};})()`);
console.log(JSON.stringify(res,null,1));
// 實際點一個候選 → 有沒有換選
const r2=await ev(`(async()=>{scrollTo(0,0);await new Promise(r=>setTimeout(r,50));const card=document.querySelector('.card');const labs=card.querySelectorAll('label.cand');const target=labs[1];target.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,50));const b=target.getBoundingClientRect();return {name:card.dataset.n,x:b.left+20,y:b.top+b.height/2,before:[...labs].findIndex(l=>l.classList.contains('sel'))};})()`);
await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r2.x,y:r2.y}]});
await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
await new Promise(r=>setTimeout(r,300));
console.log('tap',r2.name,'before',r2.before,'after',await ev(`[...[...document.querySelectorAll('.card')].find(c=>c.dataset.n===${JSON.stringify(r2.name)}).querySelectorAll('label.cand')].findIndex(l=>l.classList.contains('sel'))`));
ws.close();
