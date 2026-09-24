// 清單／瀑布流：篩選列、卡片、圖片退場、欄數計算。
import { AR_MAX, AR_MIN, DATE_KEYS, SORT_KEYS, TYPES } from './config.js';
import { store } from './store.js';
import { areaLabel, dateHTML, daysLeft, esc, evById, fld, fmtDate, imgChain, mapQuery, match, t, todayStr, typeLabel } from './util.js';
// 地圖上的日期鈕（單位 さ）。**方向是 cards → datefilter，不可對調**：
// datefilter 只依賴共用層，反過來 import cards 會成環（cards → datefilter → cards）。
// 它要觸發的重畫走 main.js 注入的 setDateRepaint，不從這裡拿。
import { clearDay, syncDateBtns } from './datefilter.js';
import { clearGeo, geoActive, geoChipsHTML, geoLabels, handleGeoClick } from './geofilter.js';
import { distKm, distLabel, distSink, hasLoc, openLocPicker } from './mylocation.js';
import { newChipHTML, toggleNew } from './whatsnew.js';
import { typeIconHTML } from './icons.js';
import { expiredHTML, forgetFav, handleExpiredClick, rememberFav, soonChipHTML, toggleSoon } from './expiring.js';
import { favFoodHTML, handleFavFoodClick, setFavFoodRepaint } from './favfood.js';

// ===== 篩選彈窗（2026-08-21 起，取代原本的左側欄）=====
// 側欄那四段（類型／時間／排序／地區）**原封搬進 #filterView，id 一個都沒改**，
// 所以下面的 buildSideChips()／buildAreaSel() 與三個點擊監聽器一行都不必動。
// 這是刻意選的最小風險路徑：搬家過程中最容易弄丟的是「離我最近」後面那顆
// 「變更」鈕之類的枝節，不動它們就不會弄丟。
var filterView=document.getElementById('filterView');
// 目前開著幾個條件，顯示在「篩選」那顆鈕上。
// **關鍵字刻意不算**：搜尋框在畫面上看得見，不需要這顆鈕替它說話。
function typeActive(){return Object.keys(store.state.type).length>0;}
function activeCount(){
  var n=0;
  if(typeActive())n++;
  if(store.state.date!=='all')n++;
  if(store.state.sort!=='default')n++;
  if(geoActive(store.state.area))n++;
  return n;
}
function openFilter(){
  // 打開時重畫一次：別處會改到同一份 state（切回「全部」分頁就會清掉分類），
  // 不同步的話彈窗裡會亮著一個其實已經沒在生效的選項。
  buildSideChips();buildAreaSel();
  filterView.hidden=false;
}
function closeFilter(){filterView.hidden=true;}
// 只重畫按鈕本身；點擊事件在初始化時綁一次，避免每次重畫都疊加一組監聽器
// `on` 是選填的「這一顆亮不亮」判定。**時間與排序不傳＝維持單選**（它們天生是單選：
// 「今天」與「這週末」同時成立沒有意義），只有分類 2026-09-03 起是多選。
function buildChips(el,pairs,key,on){
  var isOn=on||function(v){return store.state[key]===v;};
  el.innerHTML=pairs.map(function(p){
    return '<button class="side-chip'+(isOn(p[0])?' on':'')+'" data-v="'+esc(p[0])+'">'+p[1]+'</button>';
  }).join('');
}
// 分類的「亮不亮」：`''` 是「全部」，它在**什麼都沒選**時才亮。
function typeChipOn(v){return v===''?!typeActive():!!store.state.type[v];}
// 分類的切換。**分類列與彈窗共用這一份**——兩處寫兩份必然漂移，
// 而症狀是「在彈窗裡點跟在分類列上點，行為不一樣」。
function toggleType(v){
  if(v===''){store.state.type={};return;}   // 「全部」＝清掉分類這個條件
  if(store.state.type[v])delete store.state.type[v];
  else store.state.type[v]=1;
}
// ⚠️ 彈窗的分類 chip 2026-09-03 起也帶**色塊**——分類列早就有了（`.sq`），
//    兩處講的是同一組分類，只有一邊有顏色會讓人以為它們不是同一件事。
//    「全部」那顆沒有色塊（它不是一個分類）。
function typePairs(){
  return [['',esc(t().all)]].concat(TYPES.map(function(v){
    return [v,'<span class="sq" style="background:var(--c-'+v+')"></span>'
             +'<span>'+esc(typeLabel(v))+'</span>'];
  }));
}
// ⚠️⚠️ **選了具體日期時要多出一顆 chip（單位 さ，2026-09-16）。**
//    少了它，使用者在地圖上選完日期、再打開篩選彈窗，會看到「時間」那排
//    **四顆全部不亮**——看起來像日期沒生效，而它其實正在生效。
//    那正是本專案反覆踩的「兩個狀態互相說謊」。
// ⚠️ 它的文字是**算出來的**（`fmtDate`），所以 `DATE_KEYS` 與 `t().dates` 都沒有 `day`
//    這一格（見 config.js 那段註解）。
function datePairs(){
  var ps=DATE_KEYS.map(function(k){return [k,t().dates[k]];});
  if(store.state.date==='day'&&store.state.day)ps.push(['day',esc(fmtDate(store.state.day))]);
  return ps;
}
function sortPairs(){
  return SORT_KEYS.map(function(k){return [k,t().sorts[k]];});
}
function buildSideChips(){
  buildChips(document.getElementById('sideType'),typePairs(),'type',typeChipOn);
  buildChips(document.getElementById('sideDate'),datePairs(),'date');
  buildChips(document.getElementById('sideSort'),sortPairs(),'sort');
  syncLocChange();
}
// 「離我最近」選中時，chip 後面補一顆「變更」（決策 13）。
// 為什麼不是「再點一次 chip 就重設」：那看不出來。也不做常駐的設定項目——
// 99% 的時間那是噪音。而**沒有變更入口的話，設錯只能去清 localStorage，
// 那會把收藏和行程一起清掉**。
function syncLocChange(){
  var box=document.getElementById('sideSort');
  var old=box.querySelector('.loc-change');
  if(old)old.remove();
  if(store.state.sort!=='near'||!hasLoc())return;
  var b=document.createElement('button');
  b.className='loc-change';
  b.type='button';
  b.textContent=t().locChange;
  b.addEventListener('click',pickLocation);
  box.appendChild(b);
}
// 開選點地圖。**選完直接套用**（決策 12）——沒設位置時點 chip 就走到這裡，
// 使用者不必先設定、再回來點一次排序。
function pickLocation(){
  // ⚠️ **一定要先把篩選彈窗關掉。** 選點地圖是全螢幕覆蓋層，彈窗開著的話
  // 點擊會被彈窗的遮罩吃掉，症狀是「按了完全沒反應」——側欄時代踩過同一個坑
  // （抽屜 z-index 1200 壓在覆蓋層 1000 上面）。現在彈窗刻意壓在 1000 底下，
  // 就算這行漏了，結果也只是「彈窗被地圖蓋住」而不是點不到。
  // 放在這裡而不是 chip 的分支裡：「變更」鈕走的也是這個函式，兩個入口一次修完。
  closeFilter();
  openLocPicker(function(loc){
    if(loc)store.state.sort='near';
    else if(store.state.sort==='near')store.state.sort='default';   // 清掉位置就退回預設，否則排序沒有依據
    buildSideChips();
    render();
  });
}
// 地區：多選 chip 樹（2026-09-03，原本是單選 `<select>`）。
// **與餐廳頁／景點頁共用 `geoChipsHTML()`**——「同一個圈的桶必須在 AREAS 裡相鄰」
// 那條規則只有 util 的 `areaGroupsInOrder()` 一份實作。
// ⚠️ 這裡**列出全部 26 個桶**（不傳 `has`），與另外兩頁「只列有資料的」不同，
//    那是刻意的：活動每天在變，今天 0 筆的桶明天可能就有，藏起來會讓人以為那個地區
//    永遠沒有活動。**筆數照印**（0 就是 0，看得出來是「今天沒有」而不是「不涵蓋」）。
// ⚠️ 活動沒有據點欄位，`spots()` 回空陣列＝那一層不畫。
function buildAreaSel(){
  var by={};
  store.events.forEach(function(ev){if(ev.area)by[ev.area]=(by[ev.area]||0)+1;});
  document.getElementById('areaTree').innerHTML=geoChipsHTML({
    sel:store.state.area,
    count:function(a){return by[a]||0;},
    has:function(){return true;},          // 見上方註解：活動頁列出全部 26 個桶
    spots:function(){return [];}
  });
}
// 頂部分類橫排（取代原本的首頁分類卡）：帶筆數，選中加底線
function buildTypeBar(){
  var nAll=store.events.filter(function(e){return match(e,true);}).length;
  // 「新收錄」與「快結束」排在分類前面。它們與分類是**正交的篩選**，
  // 所以包成一組、右邊一條 hairline 隔開（不然會被讀成第八、第九個分類）。
  // 兩顆都可能因為 0 筆而不顯示，**整組空的時候連容器都不輸出**，
  // 免得版面上留一條孤零零的線。
  // 「篩選」自成一組排在**最前面，位置固定**——右邊那兩顆（新收錄／快結束）
  // 都可能因為 0 筆而整顆不顯示，排在它們後面的話它會忽前忽後。
  var nf=activeCount();
  var html='<span class="chip-group">'
    +'<button class="side-chip filter-chip" data-filter="1">'
    +'<svg class="ic" viewBox="0 0 24 24"><path d="M4 5h16l-6.2 7.3v6.2l-3.6 1.8v-8z"/></svg>'
    +'<span>'+esc(t().filter)+'</span>'
    +(nf?'<span class="cnt">'+nf+'</span>':'')
    +'</button></span>';
  var pre=newChipHTML()+soonChipHTML();
  html+=pre?'<span class="chip-group">'+pre+'</span>':'';
  html+='<button class="side-chip'+(typeChipOn('')?' on':'')+'" data-v="">'
    +'<span>'+t().all+'</span><span class="cnt">'+nAll+'</span></button>';
  html+=TYPES.map(function(v){
    var n=store.events.filter(function(ev){return ev.type===v&&match(ev,true);}).length;
    return '<button class="side-chip'+(typeChipOn(v)?' on':'')+'" data-v="'+v+'">'
      +'<span class="sq" style="background:var(--c-'+v+')"></span>'
      +'<span>'+esc(typeLabel(v))+'</span><span class="cnt">'+n+'</span></button>';
  }).join('');
  var tb=document.getElementById('typebar');
  // ⚠️ `innerHTML` 重畫會把 scrollLeft 歸零，而這一列是橫向捲動的（2026-08-27）。
  // 打字搜尋、切分頁、收藏都會重畫，不還原的話使用者捲到中段看分類會一直被彈回最左。
  var keep=tb.scrollLeft;
  tb.innerHTML=html;
  tb.scrollLeft=keep;
  // 選中的分類可能在畫面外（從篩選彈窗選的），要捲到它才看得見。
  // ⚠️ **只在「選中的分類真的換了」時才捲**：每次重畫都捲的話，選著「全部」打字
  // 就會被一路拉回最左，而那看起來像捲動位置自己在跳。
  // ⚠️ 多選之後「選中的是哪一個」不再是一個字串，改用排序後的鍵當比較依據。
  //    **只在真的變了時才捲**：每次重畫都捲的話，選著「全部」打字就會被一路拉回最左。
  var tkey=Object.keys(store.state.type).sort().join(',');
  if(_tbType!==tkey){_tbType=tkey;scrollTypeIntoView();}
  syncTypebarFade();
}
// 分類列橫向捲動要自己顧的兩件事（2026-08-27）
var _tbType=null;   // 上一次「選中的分類」的鍵（排序後 join），見 buildTypeBar
// 右緣淡出是唯一在說「右邊還有東西」的東西，捲到底就收起來。
function syncTypebarFade(){
  var tb=document.getElementById('typebar');
  if(!tb||!tb.parentNode)return;
  tb.parentNode.classList.toggle('has-more',tb.scrollWidth-tb.clientWidth-tb.scrollLeft>1);
}
// ⚠️ 自己算 scrollLeft，**不要用 scrollIntoView**——那會連帶捲動祖先，整頁會跟著跳
//（同 plan-ui 日期列那條，地雷 #25 的附帶教訓）。
function scrollTypeIntoView(){
  var tb=document.getElementById('typebar');
  var on=tb.querySelector('.side-chip.on');
  if(!on)return;
  // 「篩選」那組是釘住的、會蓋在最左邊，所以左界要把它的寬度算進去，
  // 否則捲過去之後那顆分類正好躲在它底下。
  var pin=tb.querySelector('.chip-group');
  var pinW=pin?pin.getBoundingClientRect().width:0;
  var cr=tb.getBoundingClientRect(),br=on.getBoundingClientRect();
  var l=br.left-cr.left+tb.scrollLeft,r=l+br.width;
  if(l<tb.scrollLeft+pinW)tb.scrollLeft=l-pinW-10;
  else if(r>tb.scrollLeft+tb.clientWidth)tb.scrollLeft=r-tb.clientWidth+10;
}

function cardHTML(ev){
  var media;
  if(ev.img){
    // 破圖退回、小圖示換色塊、依照片比例定卡高，全部交給 wireImage()
    var chain=imgChain(ev);
    media='<img src="'+esc(chain[0])+'" alt="" loading="lazy" referrerpolicy="no-referrer"'
      +' data-type="'+esc(ev.type)+'" data-fb="'+esc(chain.slice(1).join(' '))+'">';
  }else{
    media=blockHTML(ev.type);
  }
  var dl=daysLeft(ev.date_end);
  var soon='';
  if(dl>=0&&dl<=30){
    soon='<span class="soon'+(dl<=1?' last':'')+'">'
      +(dl===0?t().endToday:t().remain(dl))+'</span>';
  }
  var favOn=store.favs.indexOf(ev.id)>-1?' on':'';
  var approx=(ev.geo==='area'||ev.geo==='uncertain');
  var mq=mapQuery(ev);
  var pin='<svg viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>'
    +'<circle cx="12" cy="10" r="3"/></svg>';
  // 距離**只在「離我最近」這個排序下顯示**（決策 14）：排序必須可解釋，
  // 否則沉底看起來像 bug；但在其他排序下它是無關資訊。
  // 沉底那組（geo==='area'）的 distLabel 回空字串，維持既有的「概略位置」寫法（決策 15）。
  var dist=(store.state.sort==='near')?distLabel(ev):'';
  // **距離取代地區，不是加在它後面。** 三個東西擠一行時場地名會被壓掉：
  // 實測 390px 兩欄，加一欄距離會讓「場地名被截斷」的卡片從 60/300 增加到 111/300。
  // 讓地區退場的理由是它在這個排序下資訊量最低——你已經知道自己在哪，
  // 「12 km」比「東京23區」有用，而地區本來就還在側欄篩選裡。
  // 這也正是 §1-B 決策 12 把 .ar 這個位置預留給 A 的意思。
  // **沉底那組沒有距離可放，所以維持顯示地區**（決策 15）。
  var placeInner=pin+'<span class="v">'+esc(fld(ev,'venue'))+'</span>'
    +(dist?'<span class="dist">'+esc(dist)+'</span>'
          :'<span class="ar">'+esc(areaLabel(ev.area))+'</span>');
  var place=mq
    ? '<button class="place maplink'+(approx?' approx':'')+'" data-q="'+esc(mq)+'"'
      +' aria-label="'+t().aGmap+'"'+(approx?' title="'+t().approx+'"':'')+'>'+placeInner+'</button>'
    : '<span class="place'+(approx?' approx':'')+'">'+placeInner+'</span>';

  return '<a class="card" href="'+esc(ev.url)+'" target="_blank" rel="noopener">'
    +'<div class="ph">'+media+'</div>'
    +'<div class="body">'
      +'<div class="meta">'
        +'<span class="cat" style="color:var(--c-'+ev.type+')">'
          +'<span class="sq" style="background:var(--c-'+ev.type+')"></span>'
          +esc(typeLabel(ev.type))+'</span>'
        +'<span class="when">'+dateHTML(ev)+'</span>'+soon
      +'</div>'
      +'<button class="fav'+favOn+'" data-id="'+esc(ev.id)+'" aria-label="'+t().aFav+'">★</button>'
      +'<h2>'+esc(fld(ev,'title'))+'</h2>'
      +place
    +'</div></a>';
}

// 沒圖時的分類色塊（台灣版 2026-09-24，單位 N）：淡色底＋分類圖示＋分類名。
// 使用者看 _probe/n-noimg.png 對照圖選的 C 案。底色只帶一點分類色（CSS 的 --block-tint），
// 仍守著原本「不要整片分類色、免得比真照片搶眼」的原則。**兩個入口共用這一支**（無圖、破圖退回）。
function blockHTML(ty){
  return '<div class="block" style="color:var(--c-'+esc(ty)+')">'+typeIconHTML(ty,40)
    +'<span>'+esc(typeLabel(ty))+'</span></div>';
}

// 把 <img> 換成分類色塊（來源把圖刪了，或抓到的其實是網站 logo）
function showBlock(img){
  var ph=img.parentNode;
  if(!ph)return;
  var ty=img.getAttribute('data-type')||'';
  ph.style.aspectRatio='1.39';          // 無圖時退回固定比例
  var tmp=document.createElement('div');
  tmp.innerHTML=blockHTML(ty);
  ph.replaceChild(tmp.firstChild,img);
}

function wireImage(img){
  var settled=false;
  function fail(){
    if(settled)return;
    var fb=(img.getAttribute('data-fb')||'').split(' ').filter(Boolean);
    if(fb.length){                       // 還有候選網址就換下一個
      var nxt=fb.shift();
      img.setAttribute('data-fb',fb.join(' '));
      img.src=nxt;
      return;
    }
    settled=true;
    showBlock(img);
  }
  function ok(){
    if(settled)return;
    settled=true;
    var w=img.naturalWidth,h=img.naturalHeight;
    // 只濾掉真正的小圖示（網站 logo 之類）。門檻看長邊而非寬度，
    // 直式海報（176x264）才不會被當成圖示丟掉。
    if(w&&Math.max(w,h)<200){showBlock(img);return;}
    if(!w||!h)return;
    // 卡高跟著照片實際比例走——不再把照片裁進統一的框。
    // 因此原本「直式圖鋪一層模糊底填滿 16:9」的補救機制已不需要，連同 4 處
    // backdrop-filter 一併移除（那層模糊本來只是為了填框而存在）。
    var r=Math.min(Math.max(h/w,AR_MIN),AR_MAX);
    var ph=img.parentNode;
    if(ph)ph.style.aspectRatio=(1/r).toFixed(4);
  }
  img.addEventListener('load',ok);
  img.addEventListener('error',fail);
  if(img.complete){if(img.naturalWidth)ok();else fail();}
}

function wireImages(root){
  var imgs=root.querySelectorAll('img[data-fb]');
  for(var i=0;i<imgs.length;i++)wireImage(imgs[i]);
}

// 排序。資料本身已依 (date_start, date_end) 升冪，但篩選後仍明確排一次，
// 免得日後後端排序改了、前端跟著飄。
function sortList(list){
  var d=todayStr();
  function cmp(a,b){return a<b?-1:a>b?1:0;}
  var by={
    // 沒照片的整組沉底，組內仍照日期排。**只有這個排序這麼做**——另外三種是使用者
    // 帶著明確目的去選的（「快結束」是想知道還來不來得及），照片好不好看在那時候
    // 不該蓋過他要找的東西。
    // ⚠️ **判準只能是 `img` 欄位空不空**：破圖與「其實是網站 logo」是 wireImage() 在
    // 圖載完之後才知道的，而 loading="lazy" 讓畫面外的圖根本還沒開始載——要等它就得
    // 在使用者眼前重排一次卡片。沉底≠丟掉，同 'near' 那組的道理。
    'default':function(a,b){
      var na=a.img?0:1, nb=b.img?0:1;
      if(na!==nb)return na-nb;
      return cmp(a.date_start,b.date_start)||cmp(a.date_end,b.date_end);
    },
    // 快結束的排前面——「還來不來得及」是這群使用者最在意的
    'ending':function(a,b){
      return cmp(a.date_end,b.date_end)||cmp(a.date_start,b.date_start);
    },
    // 尚未開始的優先（規劃行程用），組內再依開始日由近到遠
    'starting':function(a,b){
      var pa=(a.date_start>d)?0:1, pb=(b.date_start>d)?0:1;
      if(pa!==pb)return pa-pb;
      return cmp(a.date_start,b.date_start)||cmp(a.date_end,b.date_end);
    },
    // 離我最近。**geo==='area' 那批整組沉底，但組內仍按距離排**（決策 9）——
    // 它們的座標是退回市町村／縣／地區中心的，誤差最多 117km，
    // 把它們混進前段等於用一個可能差一百公里的數字宣稱「這個比較近」。
    // 沉底≠丟掉：排序不讓任何活動消失，那是決策 8 排除「距離當篩選」的同一個理由。
    'near':function(a,b){
      var sa=distSink(a)?1:0, sb=distSink(b)?1:0;
      if(sa!==sb)return sa-sb;
      var da=distKm(a), db=distKm(b);
      if(da===null)da=Infinity;      // 連座標都沒有的排在最後面
      if(db===null)db=Infinity;
      return (da-db)||cmp(a.date_start,b.date_start)||cmp(a.date_end,b.date_end);
    }
  };
  return list.sort(by[store.state.sort]||by['default']);
}

function activeFilterHTML(){
  var tags=[];
  geoLabels(store.state.area).forEach(function(x){tags.push(x);});
  // ⚠️ `'day'` 不在 `t().dates` 裡（它的文字是算出來的），照舊查表會印出 undefined。
  //    `day` 空的時候什麼都不印——那個狀態不該存在，但寧可少一個標籤，
  //    也不要印出 `NaN月NaN日`（`''.split('-')` 就是那個下場）。
  if(store.state.date==='day'){if(store.state.day)tags.push(fmtDate(store.state.day));}
  else if(store.state.date!=='all')tags.push(t().dates[store.state.date]);
  if(store.state.sort!=='default')tags.push(t().sorts[store.state.sort]);
  if(!tags.length)return '';
  return tags.map(function(x){return '<span class="tagf">'+esc(x)+'</span>';}).join('')
    +'<button class="clear" id="clearF">'+t().clear+'</button>';
}

// 欄數依「內容區實際寬度」而非視窗寬度決定。
// 側欄一收合，內容就多出 264px，欄數必須跟著加——用 innerWidth 算不出這件事。
function colCount(){
  var el=document.getElementById('cards');
  var w=el?el.getBoundingClientRect().width:window.innerWidth;
  if(w>=1180)return 5;
  if(w>=760) return 4;
  if(w>=460) return 3;
  return 2;
}

var curCols=0;
function render(){
  document.getElementById('activefilter').innerHTML=activeFilterHTML();
  var cf=document.getElementById('clearF');
  if(cf)cf.addEventListener('click',function(){
    // ⚠️ `day` 要跟著 `date` 一起清（單位 さ）。漏掉的話「清除」之後條件數歸零、
    //    畫面看起來全清了，而 `state.day` 還留著等下一次被誤用。
    store.state.type={};clearGeo(store.state.area);store.state.date='all';store.state.day='';store.state.sort='default';store.state.kw='';
    document.getElementById('kw').value='';
    buildAreaSel();buildSideChips();render();
  });
  document.getElementById('empty').textContent=t().empty;
  buildTypeBar();

  var list=sortList(store.events.filter(function(ev){return match(ev);}));
  document.getElementById('total').textContent=t().count(list.length);
  // 「顯示 N 筆」。彈窗蓋住畫面時看不到篩出什麼，這個數字就是唯一的回饋，
  // 而它跟著每一次 render 走，所以永遠是對的。
  document.getElementById('filterDone').textContent=t().showN(list.length);

  // 依序輪流放進各欄，而不是填滿第一欄再換下一欄——
  // 這樣由左至右的閱讀順序仍貼近日期排序，錯落感則來自照片高度不同。
  var n=colCount(); curCols=n;
  var cols=[];for(var i=0;i<n;i++)cols.push([]);
  list.forEach(function(ev,idx){cols[idx%n].push(cardHTML(ev));});
  var box=document.getElementById('cards');
  box.innerHTML=cols.map(function(c){return '<div class="col">'+c.join('')+'</div>';}).join('');
  wireImages(box);
  // 收藏的餐廳（單位 K）與「已結束的收藏」都接在瀑布流後面，只在收藏分頁有內容。
  // **順序是「收藏的餐廳」在前**：它是內容，而已結束那份是備查名單。
  var ff=favFoodHTML(), ex=expiredHTML();
  document.getElementById('favFood').innerHTML=ff;
  document.getElementById('expired').innerHTML=ex;
  // ⚠️ **這句話的條件是「整頁真的什麼都沒有」，不是「活動 0 筆」。**
  // 只收藏餐廳時活動本來就是 0 筆，照舊判斷會在餐廳清單底下再補一句
  // 「沒有符合條件的活動」——而 #empty 在 DOM 上排在那兩段**之後**，
  // 所以那句話會長在清單下面，看起來像「這一頁沒東西」而它明明有東西。
  // 所以要等這兩段算完才判得出來，這也是它排在最後的原因。
  // 篩選掉全部活動時仍有回饋：搜尋列右邊的「N 個活動」一直都在。
  document.getElementById('empty').style.display=(list.length||ff||ex)?'none':'block';
  // 活動地圖第二列那顆篩選鈕（單位 き-1）。**接在 render 的尾巴上**，因為每一條會改到
  // 篩選的路徑最後都會走到這裡（chip、地區、清除、切分頁、換語言都是）。
  syncMapFilterBtn();
  // 兩張地圖上那顆日期鈕（單位 さ）。**接在這裡的理由與上面那顆篩選鈕一模一樣**：
  // 每一條會改到篩選的路徑最後都會走到 render()——chip、地區、清除、切分頁、換語言。
  syncDateBtns();
  // ⚠️⚠️ **地圖開著時改篩選，圖釘一定要跟著變。** 少了這一行，那顆新的篩選鈕會變成
  // 「按了、彈窗開了、選了、關掉之後地圖一模一樣」——而清單其實已經篩好了，
  // 所以它不會報錯、看起來就只是「這顆鈕沒有用」。
  // ⚠️ 走 callback 而不是 `import { renderMap }`：cards 與 map 是同一層的並列模組
  // （同 setFavFoodRepaint／initSettings(cb)／setFoodAddHandler 的做法）。
  if(mapRepaint)mapRepaint();
}
// 地圖那顆篩選鈕的文字與條件數。**條件數與清單頁那顆共用 activeCount()**——
// 分兩份算的話，兩顆長得一樣的鈕會顯示不同的數字，而兩邊各自看起來都正常。
function syncMapFilterBtn(){
  var lb=document.getElementById('mapFilterLabel');if(!lb)return;
  lb.textContent=t().filter;
  var c=document.getElementById('mapFilterCount'),n=activeCount();
  c.textContent=n;c.hidden=!n;
}
// 地圖開著時要重畫它。由 main.js 注入（見 render 尾端那段註解）。
var mapRepaint=null;
function setMapRepaint(fn){mapRepaint=fn;}

// ===== 事件綁定（只綁一次）=====
document.getElementById('sideType').addEventListener('click',function(e){
  var b=e.target.closest('.side-chip');if(!b)return;
  toggleType(b.dataset.v);
  buildSideChips();render();
});
document.getElementById('sideDate').addEventListener('click',function(e){
  var b=e.target.closest('.side-chip');if(!b)return;
  // 具體日期那一顆是**再點一次就取消**（它是這排唯一一顆選中了還能再點的）。
  // 走 datefilter 的 clearDay() 而不是自己寫兩行——清日期的規則只能有一份，
  // 分兩處寫的話，日後改了一邊會變成「從彈窗清跟從地圖清，結果不一樣」。
  // ⚠️ clearDay() 自己會呼叫重畫，所以這裡直接 return，不要再 render 一次。
  if(b.dataset.v==='day'){clearDay();return;}
  store.state.date=b.dataset.v;
  // ⚠️⚠️ **切到其他時間條件時一定要把日期一起清掉。** 少了這一行，`state.day` 會
  //    留在原地：畫面上看起來是「進行中」，但下次只要有任何一條路把 date 設回 'day'，
  //    就會套用一個使用者早就忘記的日期——而且沒有任何警訊。
  store.state.day='';
  buildSideChips();render();
});
document.getElementById('sideSort').addEventListener('click',function(e){
  var b=e.target.closest('.side-chip');if(!b)return;
  // 還沒設位置就點「離我最近」→ 先開選點地圖，選完由 pickLocation 直接套用。
  // **此時不要先把 sort 設成 near**：使用者可能按 ✕ 離開，那樣排序會變成沒有依據的空轉。
  if(b.dataset.v==='near'&&!hasLoc()){pickLocation();return;}
  store.state.sort=b.dataset.v;
  buildSideChips();render();window.scrollTo(0,0);
});

// 捲動與改變視窗大小都要重算淡出。**綁在容器本身**，所以 innerHTML 重畫清不掉它。
document.getElementById('typebar').addEventListener('scroll',syncTypebarFade,{passive:true});
window.addEventListener('resize',syncTypebarFade);
document.getElementById('typebar').addEventListener('click',function(e){
  var b=e.target.closest('.side-chip');if(!b)return;
  // 「新收錄」與「快結束」與分類共用這條分類列，但它們是另外的維度——
  // **必須先攔下來**，否則會落到最後那行、把 state.type 設成 undefined
  // （所有分類都篩不到）。
  // 「篩選」只是入口，不是篩選狀態——攔下來就回去，別往下走到設分類那行。
  if(b.dataset.filter){openFilter();return;}
  if(b.dataset.new){toggleNew();}
  else if(b.dataset.soon){
    toggleSoon();
    // 「快結束」講的是收藏，所以打開時順手切到收藏分頁。
    // 不切的話會變成：分頁列亮在「全部」，畫面卻只剩三張卡——
    // 看不出自己在哪，也看不出那三張是怎麼來的。
    if(store.state.onlySoon){
      store.state.view='fav';
      tabFav.classList.add('on');tabAll.classList.remove('on');
    }
  }
  else{toggleType(b.dataset.v);}
  buildSideChips();render();window.scrollTo(0,0);
});

document.getElementById('cards').addEventListener('click',function(e){
  var m=e.target.closest('.maplink');
  if(m){
    e.preventDefault();e.stopPropagation();
    window.open('https://www.google.com/maps/search/?api=1&query='
      +encodeURIComponent(m.dataset.q),'_blank','noopener');
    return;
  }
  // 卡片本身是 <a>，故收藏星要擋掉冒泡，否則會同時開啟活動頁
  var f=e.target.closest('.fav');if(!f)return;
  e.preventDefault();e.stopPropagation();
  var id=f.dataset.id,i=store.favs.indexOf(id);
  if(i>-1)store.favs.splice(i,1);else store.favs.push(id);
  try{localStorage.setItem('twev_favs',JSON.stringify(store.favs));}catch(err){}
  // 收藏的同時把標題與結束日留一份在本機。**趁活動還在的時候記**——
  // 等它從 events.json 被剔除就再也問不到了（見 expiring.js 開頭）。
  if(i>-1)forgetFav(id);else rememberFav(evById(id));
  f.classList.toggle('on');
  // 行程一會優先錨定收藏的活動，收藏變了就讓下次開啟時重新產生
  store.planOpts=[];
  if(store.state.view==='fav')render();
});

// 「已結束的收藏」那一段。**判斷邏輯全在 expiring.js**，這裡只負責接 DOM 與重畫——
// expiring 不 import cards（那會成環），所以由它回報「有沒有真的改到東西」。
document.getElementById('expired').addEventListener('click',function(e){
  if(handleExpiredClick(e))render();
});
// 「收藏的餐廳」那一段（單位 K）。做法與上面那段一模一樣：判斷全在 favfood.js，
// 這裡只接 DOM 與重畫——favfood 不 import cards（那會成環）。
// 加進行程是非同步的（可能要先載 76 KB、可能要先問日期），故另外把重畫交過去。
document.getElementById('favFood').addEventListener('click',function(e){
  if(handleFavFoodClick(e))render();
});
setFavFoodRepaint(render);

var tabAll=document.getElementById('tabAll'),tabFav=document.getElementById('tabFav');
// 地區 chip：**委派在容器上**（chip 每次重畫都整個換掉）。
document.getElementById('areaTree').addEventListener('click',function(e){
  if(handleGeoClick(e,store.state.area)){buildAreaSel();render();}
});
// 活動地圖第二列那顆篩選鈕（單位 き-1）。**綁在這裡而不是 map.js**：它開的是本模組
// 擁有的 #filterView，同一份 store.state——地圖上改了篩選，回到清單也是同一套。
document.getElementById('mapFilterBtn').addEventListener('click',openFilter);
// 點方框以外的地方關閉，與景點頁的日期小卡同一個手勢
filterView.addEventListener('click',function(e){if(e.target===filterView)closeFilter();});
document.getElementById('filterDone').addEventListener('click',closeFilter);
// 「清除條件」只清這個彈窗裡的四樣。**刻意不碰關鍵字**——搜尋框不在彈窗裡，
// 清掉一個看不見的東西會讓人以為自己按錯了。搜尋列底下那顆「清除」照舊全清。
document.getElementById('filterClear').addEventListener('click',function(){
  // ⚠️ `day` 要跟著 `date` 一起清（單位 さ），理由同搜尋列那顆「清除」。
  store.state.type={};clearGeo(store.state.area);store.state.date='all';store.state.day='';store.state.sort='default';
  buildAreaSel();buildSideChips();render();
});
document.getElementById('kw').addEventListener('input',function(){store.state.kw=this.value.trim();render();});

// ---- 事件綁定（只綁一次）----
var tabPlan=document.getElementById('tabPlan');

// openFilter 對外 export 是給 js/tour.js 用的：「離我最近」在篩選彈窗的排序那一段，
// 導覽走到那一步要先把彈窗打開才指得到。**tour 只 import cards，cards 不 import tour**，沒有環。
export { activeCount, buildAreaSel, buildSideChips, closeFilter, colCount, curCols, openFilter, render, setMapRepaint, tabAll, tabFav, tabPlan };
