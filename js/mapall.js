// js/mapall.js — 疊圖模式：活動＋景點＋餐廳同時顯示在一張地圖上（單位 く，2026-09-10）。
//
// ⚠️⚠️ **方向是 mapall → {cards, map, places, restaurants}，那四個都不知道它的存在。**
//    （同 tour.js 對 cards／map／plan-ui、mapswitch 對三張地圖的關係。）
//    它自己不擁有任何資料、任何篩選狀態、任何彈窗內容——**全部向那三個模組要**。
//    ⚠️ 這不是潔癖：**複製一份的話兩邊會各自演化**，而漏改一邊的症狀是
//    「同一個篩選在單張地圖與疊圖上結果不一樣」，兩邊各自看起來都完全正常。
//
// **設計上的四個決定**（原型量過才定的，數字見 development-plan-v4.md §7-く）：
//
//  1. ⚠️⚠️ **叢集合成一個圈**（使用者原話：「圈表示的就是那邊有東西」）。
//     原型實測「三組各自叢集」在全關東那一眼 **64 個圈裡有 31 個被別的圈蓋掉一半以上**
//     （單張地圖是 0），合成之後 **31 → 0**。代價是個別圖釘變少
//     （z9 19→6、z13 17→11、**z16 只掉 14→12**）——損失集中在遠景，
//     而那裡本來就看不出形狀。**不要改回三組。**
//  2. **形狀分家**：活動水滴、景點圓、餐廳圓角方。
//     ⚠️ **形狀接手「這是哪一種」，顏色因此可以繼續講「這是哪一類」**
//     ——景點當初選單一色的目的（一眼認出這不是活動）由形狀保住，
//     所以餐廳 22 色與活動 7 色一個都不必丟。
//     ⚠️⚠️ **2026-09-11 起形狀是全站一致的，不是疊圖獨有的**（使用者決定）：
//     單張地圖上景點也是圓、餐廳也是方，所以**切換過來不會變形**。
//     形狀因此寫在 CSS 的型別 class 上（`.pin.place-pin` / `.pin.restaurant-pin`），
//     這一支不再傳任何形狀參數——**形狀是型別的屬性，不是模式的參數**。
//     ⚠️ 使用者同時決定**圓與方都不加尖端**：精確位置是點開才看的東西。
//  3. **不記狀態**：每次都要從切換器進來（同三張地圖的 legendOpen 不寫 localStorage）。
//  4. **沒有第二套篩選**：三種各自沿用自己那一頁的篩選狀態，這裡只提供入口。
import { LOC_VIEW, LOC_VIEW_ZOOM, PLACE_TYPE, TYPES } from './config.js';
import { genreIconHTML, placeIconHTML, typeIconHTML } from './icons.js';
import { keepMapView, store, takeMapView } from './store.js';
import { cssVar, esc, pinColor, t, typeLabel } from './util.js';
import { fitFromMyLoc } from './mylocation.js';
import { activeCount, openFilter } from './cards.js';
import { eventMarkers, wireEventPopup } from './map.js';
import { openPlacesFilter, placeMarkers, placesFilterCount, wirePlacesPopup } from './places.js';
import { ensureRestaurants, openRestaurantFilter, restaurantFilterCount,
         restaurantMarkers, wireRestaurantPopup } from './restaurants.js';

var allView=document.getElementById('allView');
var afView=document.getElementById('allFilterView');
var allMap=null, layer=null;
var LEGEND_ICON=10;

// 三種各一份「怎麼開篩選」「有幾個條件」。⚠️ **順序就是畫面上的順序**，
// 與切換器那三格一致（活動→景點→餐廳）。
var KINDS=[
  {k:'ev', open:openFilter,           count:activeCount},
  {k:'pl', open:openPlacesFilter,     count:placesFilterCount},
  {k:'rs', open:openRestaurantFilter, count:restaurantFilterCount}
];

// ===== 地圖 =====
function clusterIcon(cluster){
  var n=cluster.getChildCount();
  var size=n<10?32:(n<100?38:44);
  return L.divIcon({
    className:'',
    html:'<div class="cl" style="width:'+size+'px;height:'+size+'px">'+n+'</div>',
    iconSize:[size,size],iconAnchor:[size/2,size/2]
  });
}
function initAllMap(){
  if(allMap)return;
  allMap=L.map('allMap',{zoomControl:true}).setView(LOC_VIEW,LOC_VIEW_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:18,attribution:'© OpenStreetMap'
  }).addTo(allMap);
  // ⚠️⚠️ **彈窗接線要依 `_kind` 分派。** 三種彈窗混在同一張地圖上，而它們的接線
  //    完全不同（活動只接圖片退場、景點與餐廳還有「加進行程」那顆會就地換掉自己的鈕）。
  //    ⚠️ **不可以靠「彈窗裡有沒有某個 class」去猜**：活動與景點的縮圖都是 `img.pth`。
  allMap.on('popupopen',function(e){
    var k=e.popup._source&&e.popup._source._kind;
    if(k==='pl')wirePlacesPopup(e.popup);
    else if(k==='rs')wireRestaurantPopup(e.popup);
    else wireEventPopup(e.popup);
  });
}
// 叢集**只有一組**（見檔頭第 1 點）。⚠️ 每次重畫換一個新群組而不是 clearLayers，
// 沿用餐廳頁那個做法：已開啟 popup 的舊群組在 clearLayers 之後會留下第三方元件的內部狀態。
function makeLayer(markers){
  if(typeof L.markerClusterGroup==='function'){
    var g=L.markerClusterGroup({
      maxClusterRadius:50,showCoverageOnHover:false,
      spiderfyOnMaxZoom:true,        // 三種疊在一起時同一點更容易撞，這個更不能關
      chunkedLoading:true,           // 7300 個一次塞完會卡住主執行緒
      iconCreateFunction:clusterIcon
    });
    g.addLayers(markers);
    return g;
  }
  return L.layerGroup(markers);      // markercluster 載不到時地圖不會整個壞掉
}

function renderAll(){
  initAllMap();
  if(layer)allMap.removeLayer(layer);
  // ⚠️ **三支都是那三個模組自己的圖釘工廠**（`eventMarkers`／`placeMarkers`／
  //    `restaurantMarkers`），所以篩選、彈窗、顏色、圖示全部與單張地圖逐字相同。
  // ⚠️ 餐廳那一支**不會自己去載 `_map.json`**——沒載好就回空陣列，
  //    載入由 `openAll()` 負責等（見那裡）。
  var markers=eventMarkers()
    .concat(placeMarkers())
    .concat(restaurantMarkers());
  var pts=markers.map(function(m){var ll=m.getLatLng();return [ll.lat,ll.lng];});
  layer=makeLayer(markers);
  layer.addTo(allMap);
  // ⚠️ **副標只印一個數字**，不印「N 活動・N 景點・N 餐廳」：那一格實測只有 122px，
  //    三段會折行把頂欄撐高，切換地圖的瞬間下面的地圖就會上下跳（單位 き-1 修過一次）。
  document.getElementById('allSub').textContent=t().allCount(pts.length);
  buildLegend();
  syncFilterBtn();
  // 開場視野：與三張地圖同一套（單位 き-2 的 takeMapView ＋ 單位 Y-4 的 fitFromMyLoc）。
  // ⚠️ **keep 在這裡取一次**，不可以放進下面那個函式裡——它會被呼叫兩次，
  //    第二次拿不到就被 fitBounds 蓋回全日本，看起來像「切過來沒有保留視野」。
  // ⚠️ **只有真的有點時才消費**：餐廳是按需載入的，第一次進來 pts 可能還是空的。
  var keep=pts.length?takeMapView():null;
  function fitView(){
    allMap.invalidateSize();
    if(keep){allMap.setView([keep.lat,keep.lng],keep.z,{animate:false});return;}
    if(!pts.length)return;                       // 沒有點就不要動視野（不製造空地圖）
    if(fitFromMyLoc(allMap,pts,[40,40]))return;
    allMap.fitBounds(pts,{padding:[40,40],maxZoom:13});
  }
  fitView();
  setTimeout(fitView,60);
}
// 疊圖開著才重畫。⚠️ **三個模組的篩選都會呼叫到這裡**（由 main.js 注入），
// 少了它，在疊圖模式改篩選會變成「彈窗選得動、關掉之後地圖一模一樣」（單位 き-1 那條）。
function renderAllIfOpen(){
  if(allView.classList.contains('show'))renderAll();
}

// ===== 圖例 =====
// 展開的是哪一段。⚠️ **一次只開一段**（手風琴）：三段全開實測 615.9px，
// 而地圖只有 710.9px 高＝吃掉 87%。**這是疊圖獨有的行為**，那三張地圖各自的
// `legendOpen` 一個字都沒改（它們各自只有一段，沒有這個問題）。
// **不寫 localStorage**（同那三張）。
var openSection='';
// 外層那顆「類別」展開了沒（單位 こ-2）。⚠️ **與 openSection 同一個規矩：不寫 localStorage**
// ——每次從切換器進來都是收著的。重畫會重建整塊 innerHTML，所以狀態要記在這裡。
var boxOpen=false;

function legendRow(kind,color,label){
  return '<div><span class="'+dotClass(kind)+'" style="'+dotStyle(kind,color)+'">'
    +'</span>'+esc(label)+'</div>';
}
// 形狀對照表：**一行常駐、排在最上面**，因為在疊圖模式裡「這是哪一種」才是新資訊。
// ⚠️ **它刻意留在收合區外面**（單位 こ-2）：三段類別收起來之後，
//    這一行是唯一還看得見的東西，而它正是疊圖獨有的那個資訊。
// ⚠️ **色塊一律中性墨色**：活動有 7 種顏色、餐廳有 22 種，挑任何一種來代表整類都是說謊
//    （同餐廳圖例在多類別時把「精確／概略」那兩行改成中性墨色的理由）。
function shapeRows(){
  var c=cssVar('--ink-2')||'#666';
  var lb=t().mapSwitch;
  // ⚠️ **形狀不在這裡寫死**（單位 こ-1，2026-09-11）：三種形狀集中在 `dotClass`／
  //    `DOT_R` 一處，這一行與底下三段類別因此永遠一致。**先前這裡自己寫了一份水滴**，
  //    而類別那邊是 2px 圓角方——同一塊圖例上下打架，正是 こ-1 要修的事。
  return ['ev','pl','rs'].map(function(k){return legendRow(k,c,lb[k]);}).join('');
}
// 三段小類。⚠️ **地圖上有圖示，圖例就一定要有**——這是全站規則（圖例是唯一能查
// 「這個圖案是什麼」的地方），所以疊圖不能只留形狀那三行就交差。
// ⚠️ 標籤直接從記錄上讀 `genre_ja`（`places.json` 與 `_map.json` 每一筆都自帶），
//    **前端不維護第二張對照表**——同 places.js／restaurants.js 各自那一行的做法。
function genreLabelOf(rec){
  return store.lang==='ja'?(rec.genre_ja||rec.genre):(rec.genre||rec.genre_ja);
}
// ⚠️ 色塊的圓角跟著那一種的圖釘走（圖例要長得跟地圖上看到的東西一樣）。
// 活動維持既有的 2px——**它的圖釘是水滴，而圖例色塊從來不是水滴**，那是既有的簡化，
// 這一輪沒有改（要改的話色塊得旋轉，三份圖例都要動，範圍外）。
// ⚠️ 餐廳是 3px 不是 6px——**圓角要按比例換算**（圖釘 26px/6px＝0.23，色塊 14px 對應 3px）。
// 照抄 6px 的話色塊會圓到像景點，見 css 的 `.restaurant-legend .dot`。
var DOT_R={ev:'', pl:'50%', rs:'3px'};
// ⚠️ **活動走 CSS 的 `.drop` 而不是行內樣式**（單位 こ-1）：水滴要旋轉，而**裡面的圖示
//    得轉回來**，行內樣式選不到子元素。⚠️ 那條 CSS 刻意是 `.map-legend .dot.drop`
//    而不是改 `.map-legend .dot`——後者會連景點與餐廳一起轉成菱形，見 css/style.css。
function dotClass(kind){return kind==='ev'?'dot drop':'dot';}
function dotStyle(kind,color){
  return 'background:'+color+(DOT_R[kind]?';border-radius:'+DOT_R[kind]:'');
}
function section(key,title,rows,n){
  if(!n)return '';
  return '<details class="legend-genres" data-sec="'+key+'"'+(openSection===key?' open':'')+'>'
    +'<summary>'+esc(title)+' '+n+'</summary>'
    +'<div class="legend-rows">'+rows+'</div></details>';
}
function buildLegend(){
  var L=t(),html='';
  // 活動：**永遠列全部七個分類**（與活動地圖一致——它的圖例刻意不隨篩選改變）。
  html+=section('ev',L.mapSwitch.ev+'・'+L.type,TYPES.map(function(v){
    return '<div><span class="'+dotClass('ev')+'" style="'+dotStyle('ev',pinColor(v))+'">'
      +typeIconHTML(v,LEGEND_ICON)+'</span>'+esc(typeLabel(v))+'</div>';
  }).join(''),TYPES.length);
  // 景點與餐廳：**只列現在地圖上真的有的**（與那兩頁的圖例一致）。
  var pl=[],plSeen={},rs=[],rsSeen={};
  if(layer)layer.getLayers().forEach(function(m){
    var r=m._rec;if(!r||!r.genre)return;
    if(m._kind==='pl'&&!plSeen[r.genre]){plSeen[r.genre]=1;pl.push(r);}
    if(m._kind==='rs'&&!rsSeen[r.genre]){rsSeen[r.genre]=1;rs.push(r);}
  });
  // ⚠️ 景點的色塊**全部同一個顏色**（`--pin-景點`，方案 B）——看到一整排同色不是 bug。
  var plColor=pinColor(PLACE_TYPE);
  html+=section('pl',L.mapSwitch.pl+'・'+L.placesGenre,pl.map(function(r){
    return '<div><span class="'+dotClass('pl')+'" style="'+dotStyle('pl',plColor)+'">'
      +placeIconHTML(r.genre,LEGEND_ICON)+'</span>'+esc(genreLabelOf(r))+'</div>';
  }).join(''),pl.length);
  html+=section('rs',L.mapSwitch.rs+'・'+L.restaurantGenre,rs.map(function(r){
    return '<div><span class="'+dotClass('rs')+'" style="'+dotStyle('rs',pinColor(r.genre))+'">'
      +genreIconHTML(r.genre,LEGEND_ICON)+'</span>'+esc(genreLabelOf(r))+'</div>';
  }).join(''),rs.length);
  // 概略位置：**跟著三段類別一起收進外層**（單位 こ-2）。
  // ⚠️ **這與活動地圖那條「概略位置刻意常駐在收合區外面」不同，是知情的取捨**：
  //    疊圖這裡收合區外面已經有形狀那一行，再掛一行就回到「三行以上」；
  //    而半透明圖釘的解釋展開一下就看得到。**另外三張地圖一個字都沒動。**
  // ⚠️ **三種形狀各出一顆**（使用者 2026-09-11 決定「半透明維持，形狀跟著一起改」）。
  //    疊圖裡每一種形狀都已經有意思了，**只放一顆等於在說「只有那一種會是概略位置」**
  //    ——而三種都會。半透明本身是它真正要解釋的事，一個字都沒動。
  html+='<div class="approxline" style="margin-top:3px;opacity:.65">'
    +['ev','pl','rs'].map(function(k){
        return '<span class="'+dotClass(k)+'" style="'+dotStyle(k,'var(--ink-3)')+';opacity:.5"></span>';
      }).join('')
    +esc(L.approx)+'</div>';
  // 外層：把上面那三段＋概略位置整個收進一顆「類別」（單位 こ-2）。
  // ⚠️ **收起來只剩兩行**：形狀那一行 ＋ 這顆 summary。實測 390px 下圖例由
  //    154×173 變成 219×61，佔地圖高 **24% → 8%**。
  // ⚠️ **class 不可以用 `legend-genres`**：下面那支手風琴是拿它選節點的，
  //    外層混進去會被當成第四段，於是「開外層就把內層全收掉」——而畫面上只像
  //    「點了沒反應」。三角形的樣式靠 CSS 並列進共用那一段，不複製第二份。
  var box=document.getElementById('allLegend');
  box.innerHTML='<div class="shapeline">'+shapeRows()+'</div>'
    +'<details class="legendbox"'+(boxOpen?' open':'')+'>'
    +'<summary>'+esc(L.allLegendGenre)+'</summary>'+html+'</details>';
  // ⚠️ **每次重畫都要重接監聽器**（innerHTML 換掉整個節點），而且
  //    **`toggle` 事件不會冒泡**，委派在容器上沒有用——三張地圖都踩過這一條。
  var lb=box.querySelector('details.legendbox');
  lb.addEventListener('toggle',function(){boxOpen=lb.open;});
  var ds=box.querySelectorAll('details.legend-genres');
  Array.prototype.forEach.call(ds,function(d){
    d.addEventListener('toggle',function(){
      if(!d.open){if(openSection===d.getAttribute('data-sec'))openSection='';return;}
      openSection=d.getAttribute('data-sec');
      // 手風琴：開一段就把另外兩段收起來（見 openSection 那段註解的 87%）。
      Array.prototype.forEach.call(ds,function(o){if(o!==d)o.open=false;});
    });
  });
}

// ===== 篩選：一顆鈕開一個分三段的彈窗 =====
// ⚠️⚠️ **這裡沒有第二套篩選狀態**：三張卡各自開的就是那一頁既有的篩選彈窗，
//    所以「在疊圖改了條件、回到單張地圖也是同一套」天生成立，不必同步任何東西。
function syncFilterBtn(){
  var n=0;
  KINDS.forEach(function(x){n+=x.count();});
  document.getElementById('allFilterLabel').textContent=t().filter;
  var c=document.getElementById('allFilterCount');
  c.textContent=n;c.hidden=!n;
}
function buildFilterSheet(){
  var L=t();
  document.getElementById('afTitle').textContent=L.filterTitle;
  document.getElementById('afDone').textContent=L.done;
  // ⚠️ **入口卡（`.tour-card`）而不是篩選 chip**：這三張是「進去改條件」的**動作**，
  //    而 chip 的語彙是「條件」本身（地雷 #26）。長得一樣使用者就分不出按下去會怎樣。
  document.getElementById('afCards').innerHTML=KINDS.map(function(x){
    var n=x.count();
    return '<button type="button" class="tour-card" data-k="'+x.k+'">'
      +'<span class="ic"><svg viewBox="0 0 24 24">'
        +'<path d="M4 5h16l-6.2 7.3v6.2l-3.6 1.8v-8z"/></svg></span>'
      +'<span class="tx"><span class="tt">'+esc(L.mapSwitch[x.k])+'</span>'
        +'<span class="sb">'+esc(n?L.allFilterN(n):L.allFilterAny)+'</span></span>'
      +'<span class="cv"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>'
      +'</button>';
  }).join('');
}
function openAllFilter(){buildFilterSheet();afView.hidden=false;}
function closeAllFilter(){afView.hidden=true;}

document.getElementById('allFilterBtn').addEventListener('click',openAllFilter);
document.getElementById('afDone').addEventListener('click',closeAllFilter);
afView.addEventListener('click',function(e){if(e.target===afView)closeAllFilter();});
// 委派：三張卡每次開彈窗都被 innerHTML 換掉（同 mapswitch／圖例的做法）。
document.getElementById('afCards').addEventListener('click',function(e){
  var b=e.target.closest?e.target.closest('.tour-card'):null;
  if(!b)return;
  var x=null;
  KINDS.forEach(function(o){if(o.k===b.getAttribute('data-k'))x=o;});
  if(!x)return;
  // ⚠️ **先收掉自己再開對方**：兩張 `.sheet` 同時開著時，上面那張的遮罩會吃掉
  //    下面那張的點擊——症狀是「篩選彈窗打得開但什麼都點不動」（地雷 #21 那一族）。
  closeAllFilter();
  x.open();
});

// ===== 開關 =====
function openAll(){
  // 切換過來的那一次**不可以重存捲動位置**：那時卡片是藏起來的、頁面高度為 0
  //（見 store.mapSwitching）。不是切換過來的＝全新的開場，殘留的視野要丟掉（單位 き-2）。
  if(!store.mapSwitching){
    store.overlayScroll=window.scrollY||window.pageYOffset||0;
    store.mapView=null;
  }
  // ⚠️ **沿用 `body.map-open`**：那個 class 做兩件事——把底下 1600 張卡片
  //    `display:none`（地雷 #18，光這一件就讓拖曳中位幀從 60ms 降到 36ms），
  //    以及把 `.sheet` 提到 1150（單位 き-1，否則篩選彈窗會開在地圖後面）。
  //    **兩件我們都要**，所以刻意不另開一個 class。
  document.body.classList.add('map-open');
  allView.classList.add('show');
  renderAll();
  // 餐廳是按需載入的（`_map.json`）。⚠️ **先畫一次再等它**：活動與景點已經在手上，
  //    等餐廳回來才畫的話，切過來會先看到一張空白地圖。
  // ⚠️ `ensureRestaurants()` 的 promise 是記憶化的，重複呼叫不會多打一次網路。
  ensureRestaurants().then(renderAllIfOpen,function(){/* 載不到就只有活動與景點，不擋畫面 */});
}
function closeAll(){
  keepMapView(allMap);            // 把現在看的位置交給下一張地圖（單位 き-2）
  allView.classList.remove('show');
  document.body.classList.remove('map-open');
  closeAllFilter();
  if(!store.mapSwitching)requestAnimationFrame(function(){window.scrollTo(0,store.overlayScroll);});
}
document.getElementById('allClose').addEventListener('click',closeAll);

// 語言／明度變動後重畫（圖釘與圖例的顏色是 JS 產生的字串，不會跟著 CSS 變數走）。
function refreshAll(){
  document.getElementById('allTitle').textContent=t().allTitle;
  document.getElementById('allClose').setAttribute('aria-label',t().aClose);
  syncFilterBtn();
  renderAllIfOpen();
}

export { allView, closeAll, openAll, refreshAll, renderAllIfOpen };
