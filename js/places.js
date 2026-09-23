// 景點分頁（第五個分頁，2026-08-20）。全螢幕覆蓋層、**地圖優先且只有地圖**。
//
// 與餐廳頁的三個刻意差異，改動前先看懂：
//   1. **沒有兩層載入。** 景點只有 67 筆／約 31KB，而且 `main.js` 開站時就與
//      `events.json` 並行抓好了（那是 H1 定的：`?plan=` 分享連結一進站就要查得到景點）。
//      這裡只是把 `store.places` 畫出來，**不 fetch 任何東西**。
//   2. ~~沒有清單模式~~ **2026-09-02（L4）開了清單**。當初不做的理由是
//      「67 筆全部沒有照片，瀑布流會是一面文字牆」——**照片進來之後那個前提就沒了**
//      （現在 128/177 有照片）。⚠️ 餐廳頁的 `RESTAURANT_LIST` 仍然關著，
//      因為那邊的照片還是很少，**兩邊的判準是同一條：有沒有照片撐得起瀑布流。**
//   3. **篩選只有地區一個下拉。** 小類不做篩選：六類共用同一個圖釘顏色，
//      它們是「這是什麼」的資訊而不是「我要找什麼」的維度，圖例就夠了。
//
// ⚠️ **圖釘顏色一律 `--pin-景點`，小類只用圖示區分**（使用者 2026-08-20 拍板的方案 B）。
// 所以本模組完全不需要新的 CSS 顏色變數，新增小類也不必動 CSS——
// 但相對地 `icons.js` 的 `PLACE_ICON` 少一個，那一類在地圖上就分不出來了。
import { AR_MAX, AR_MIN, PLACE_DIR, PLACE_GENRES, PLACE_TYPE } from './config.js';
import { placeIconHTML, worldHeritageIconHTML } from './icons.js';
import { keepMapView, savePlan, store, takeMapView } from './store.js';
import { areaLabel, esc, fld, geoMatch, hoursHTML, pinColor, t } from './util.js';
import { clearGeo, geoActive, geoChipsHTML, handleGeoClick, newGeoSel } from './geofilter.js';
import { meUrl } from './route.js';
import { addToPlan, askPlanDate, closeDateSheet, planDateReady } from './plan-ui.js';
import { closeTicketSheet, ticketBtnHTML } from './tickets.js';
import { fitFromMyLoc } from './mylocation.js';

var placesView=document.getElementById('placesView');
// 篩選彈窗（2026-09-03，取代原本的地區下拉）
var pfView=document.getElementById('placesFilterView');
var pfBtn=document.getElementById('placesFilterBtn');
var pfCount=document.getElementById('placesFilterCount');
var pfArea=document.getElementById('pfArea');
var pfGenre=document.getElementById('pfGenre');
var placesStatus=document.getElementById('placesStatus');
var tabPlaces=document.getElementById('tabPlaces');
var placesSwitch=document.getElementById('placesSwitch');

// 地理選擇（圈／桶，多選）與小類（多選）。形狀與判定在 js/geofilter.js。
// ⚠️ **這是本模組自己的狀態，刻意不共用 `store.state.area`**：那個是活動清單的篩選，
//    兩邊連動會讓使用者在景點頁選了地區、回到清單發現活動也被篩了。
// ⚠️ **景點沒有據點**（places.json 沒有 spot 欄位），所以那一層天生不會出現
//    ——`spots()` 一律回空陣列，geoChipsHTML 自己就不畫那一塊，不必特判。
// ⚠️ 與餐廳頁一樣**不記進 localStorage**：分頁是點進來的，記住上次會讓人
//    打開看到一張不是自己選的地圖。
var geoSel=newGeoSel();
var genreSel={};
function genreActive(){return Object.keys(genreSel).length>0;}
function genreOk(p){return !genreActive()||!!genreSel[p.genre];}
var placesMap=null,markerLayer=null,previousTab='tabAll';
var dataSettled=false;      // main.js 那兩份資料是否已經有結果（成功或失敗都算）
var legendOpen=false;       // 圖例的小類段是否展開；重畫圖例時要還原它（同 restaurants.js）
// 清單／地圖（2026-09-02，L4）。**開場是地圖**：這一頁的入口叫「景點地圖」，
// 而且地圖才是它跟活動清單的差異所在。⚠️ 與餐廳頁一樣**不寫 localStorage**——
// 這是「現在在看哪一份」不是一項設定（同三個 legendOpen 的理由）。
var viewMode='map';
var listCols=0;             // 目前畫了幾欄，resize 時欄數沒變就不必重畫

// 圖釘 26／圖釘內 14／圖例內 10。**與 map.js、restaurants.js 同一組數值**：
// 三張地圖的圖釘大小不一樣會看起來像三個不同的網站。
var PIN_SIZE=26, PIN_ICON=14, LEGEND_ICON=10;
// 世界遺產星號：圖釘上 11px、圖例裡 10px（與小類色塊裡的圖示同寬，兩行才對得齊）。
var WH_PIN=11, WH_LEGEND=10;

function genreLabel(p){
  return store.lang==='ja'?(p.genre_ja||p.genre):(p.genre||p.genre_ja);
}
// 小類的日文名一律**從資料本身取**（`places.json` 每一筆都自帶 `genre_ja`），
// 前端不維護第二張對照表——管線的 GENRES 才是單一真相來源。
function genreJaOf(g){
  for(var i=0;i<store.places.length;i++){
    if(store.places[i].genre===g&&store.places[i].genre_ja)return store.places[i].genre_ja;
  }
  return g;
}
// ⚠️ 2026-09-03 起判定走 `geofilter.js` 的 `geoMatch()`，**這裡不再自己判一次**
//    ——「選了圈就比對它底下的所有桶」那條規則原本在本檔、cards、restaurants
//    各有一份，漏改一處的症狀是「某一頁選了圈卻篩不出東西」而其他頁正常。
function inArea(p){return geoMatch(p,geoSel);}
function filtered(){
  return store.places.filter(function(p){return geoMatch(p,geoSel)&&genreOk(p);});
}
// 只套地理、不套小類（小類 chip 的筆數母體）與反過來（地區 chip 的母體）。
// ⚠️ **兩邊必須相反**，都扣的話「已經選中的那一個」以外全部顯示 0，
//    看起來像那些地區沒有景點——而它只是被自己這一次的選擇算掉了。
function inGeoOnly(){return store.places.filter(function(p){return geoMatch(p,geoSel);});}
function inGenreOnly(){return store.places.filter(genreOk);}

// ===== 篩選彈窗（2026-09-03，取代原本的地區下拉）=====
// ⚠️ 這裡原本是 `buildPlacesAreaSel()`——「圈當 optgroup、底下有多個桶才給整個…」
//    那個迴圈的**第三份複本**（cards.js 與 restaurants.js 各有一份）。
//    現在三處統一走 util 的 `areaGroupsInOrder()`（在 geoChipsHTML 裡），
//    「同一個圈的桶必須相鄰」那條規則從此只有一份實作。
function buildPlacesFilter(){
  var byArea={};
  inGenreOnly().forEach(function(p){if(p.area)byArea[p.area]=(byArea[p.area]||0)+1;});
  pfArea.innerHTML=geoChipsHTML({
    sel:geoSel,
    count:function(a){return byArea[a]||0;},
    // ⚠️ 景點沒有據點欄位，這一層天生是空的（回空陣列＝那一塊不畫）。
    spots:function(){return [];}
  });
  // 小類：**照 PLACE_GENRES 的順序**，與圖例一致；表上沒有的接在後面
  //（管線新增小類而 config 忘了補時仍看得到，同 buildPlacesLegend 的做法）。
  var pool=inGeoOnly(),present={};
  pool.forEach(function(p){if(p.genre)present[p.genre]=(present[p.genre]||0)+1;});
  var order=PLACE_GENRES.filter(function(g){return present[g];});
  Object.keys(present).forEach(function(g){if(order.indexOf(g)<0)order.push(g);});
  // ⚠️ **刻意不給色塊**（餐廳頁那邊有）：景點的七個小類**共用同一個圖釘顏色**，
  //    只用圖示區分（當初的方案 B，為了保住「一眼看出這是景點不是活動」）。
  //    給它色塊會是七個一模一樣的方塊——在畫面上等於說謊。使用者 2026-09-03 確認不做顏色。
  pfGenre.innerHTML=order.map(function(g){
    var label=store.lang==='ja'?genreJaOf(g):g;
    return '<button type="button" class="side-chip'+(genreSel[g]?' on':'')+'"'
      +' data-genre="'+esc(g)+'"><span>'+esc(label)+'</span>'
      +'<span class="cnt">'+present[g]+'</span></button>';
  }).join('');
  document.getElementById('pfDone').textContent=t().showN(filtered().length);
}
// 鈕上的數字＝**幾個條件**（地區 1 ＋ 小類 1），與餐廳頁和活動頁的 activeCount() 一致。
function syncPlacesFilterBtn(){
  var n=placesFilterCount();
  document.getElementById('placesFilterLabel').textContent=t().filter;
  pfCount.textContent=n;
  pfCount.hidden=!n;
}
function openPlacesFilter(){buildPlacesFilter();pfView.hidden=false;}
// 疊圖模式（單位 く）要在自己的篩選卡上印「這一種目前有幾個條件」。
// ⚠️ **與 syncPlacesFilterBtn 是同一條算式，抽出來共用**——分兩份寫的話，
// 日後多一種條件會出現「景點頁說 2 個、疊圖說 1 個」而兩邊各自看起來都正常。
function placesFilterCount(){return (geoActive(geoSel)?1:0)+(genreActive()?1:0);}
function closePlacesFilter(){pfView.hidden=true;}

// ===== 地圖 =====
function placesClusterIcon(cluster){
  var n=cluster.getChildCount();
  var size=n<10?32:(n<100?38:44);
  return L.divIcon({
    className:'',
    html:'<div class="cl" style="width:'+size+'px;height:'+size+'px">'+n+'</div>',
    iconSize:[size,size],iconAnchor:[size/2,size/2]
  });
}
// ⚠️ **叢集在這裡不是為了效能，是為了「點得到」**（2026-08-20 實測後由使用者拍板）。
// 67 筆的效能毫無問題，但開場那一眼是整個關東（z≈7），**58 個圖釘疊在別人底下**；
// 就算篩到東京23區也還有 12 個。那正是地雷 #18 的病，只是換一個資料集。
// 所以**不要因為「只有 67 筆」就把叢集拿掉**——筆數不是它存在的理由。
function makePlacesLayer(markers){
  if(typeof L.markerClusterGroup==='function'){
    var layer=L.markerClusterGroup({
      maxClusterRadius:50,showCoverageOnHover:false,
      spiderfyOnMaxZoom:true,          // 上野那四筆相距 140~300m，靠這個才點得到
      iconCreateFunction:placesClusterIcon
    });
    layer.addLayers(markers);
    return layer;
  }
  return L.layerGroup(markers);        // markercluster 載不到時地圖不會整個壞掉
}
// ⚠️ **景點的圖釘是圓的**（2026-09-11，單位 く 第二輪，全站一致不分模式）。
// 形狀寫在 CSS 的 `.pin.place-pin` 上，這裡不必再傳任何東西——**形狀是型別的屬性，
// 不是模式的參數**。⚠️ 圓不旋轉，所以圖示那條 45 度補償只掛在 `.event-pin` 上。
function placePinIcon(p,approx){
  // 顏色**不隨小類變**：一律 `--pin-景點`。圖示才是小類的辨識手段。
  var html='<div class="pin place-pin'+(approx?' approx':'')+'" style="background:'
    +pinColor(PLACE_TYPE)+'">'+placeIconHTML(p.genre,PIN_ICON)+'</div>';
  // 世界遺產的星號（2026-08-22）。**與小類正交**——一個景點可以同時是「公園庭園」
  // 和世界遺產，所以它疊在圖釘上而不是換一個圖示。
  //
  // ⚠️ **星號絕對不能掛進 `.pin` 裡面。** 那個 div 是 `transform:rotate(-45deg)`
  // 的水滴，在它裡面寫「右上角」，畫出來會跑到**正上方**，而且星星自己是歪 45 度的
  // （類別圖示就是靠 `.gi{transform:rotate(45deg)}` 轉回來才正的）。
  // 所以外面多包一層**不旋轉**的 `.place-pin-wrap`，「右上角」才是字面意義的右上角。
  // 這一層同時讓餐廳／活動圖釘共用的那組 `.pin` 規則一個字都不必動。
  if(p.world_heritage)
    html='<div class="place-pin-wrap">'+html
      +'<span class="wh-badge">'+worldHeritageIconHTML(WH_PIN)+'</span></div>';
  return L.divIcon({
    className:'',
    html:html,
    // ⚠️ **三個值維持原狀。** 星號是刻意讓它溢出這個框的（Leaflet 對 divIcon 不裁切），
    // 框本身仍是 26×26 的圖釘——改了其中一個而沒改另外兩個，圖釘就會偏離它指的座標。
    iconSize:[PIN_SIZE,PIN_SIZE],iconAnchor:[PIN_SIZE/2,PIN_SIZE],popupAnchor:[0,-(PIN_SIZE-2)]
  });
}
function inPlan(p){return store.plan.ids.indexOf(p.id)>-1;}
// 彈窗與詳情卡的**共用內容**（單位 M，2026-09-02）。
// ⚠️ **兩處刻意共用一份**：它們講的是同一個景點，分兩份寫必然漂移
// （同 `hoursHTML()` 被彈窗與行程列共用的理由）。差別只有 `big`：
// 詳情卡把照片放大成整張卡的寬度，彈窗維持 64px 縮圖。
function placeBodyHTML(p,approx,big){
  var L=t();
  // 縮圖：`img` 空字串＝還沒拍（正常空狀態），走中性面板＋小類圖示。
  // 本站自己的檔案，**不經 images.weserv.nl**（同網域，繞出去沒有必要）。
  var thumb=p.img
    ? '<img class="pth" src="'+esc(PLACE_DIR+p.img)+'" alt="" loading="lazy">'
    : '<div class="pth pth-block" style="color:var(--c-'+PLACE_TYPE+')">'
      +placeIconHTML(p.genre,26)+'</div>';
  // 詳情卡的大圖。**沒有照片時不留一塊空白**——那 49 筆走的是同一個中性面板，
  // 只是放大，與卡片上看到的東西一致。
  var hero=big
    ? '<div class="place-sheet-ph">'+(p.img
        ? '<img src="'+esc(PLACE_DIR+p.img)+'" alt="">'
        : '<div class="block" style="color:var(--c-'+PLACE_TYPE+')">'
          +placeIconHTML(p.genre,42)+'</div>')+'</div>'
    : '';
  var vn=fld(p,'venue'),title=fld(p,'title');
  // 多數景點的 venue 就是它自己，相同就不印第二次（同 planRowHTML 的處理）。
  var line2=esc(genreLabel(p))+'・'+esc(areaLabel(p.area))
    +(vn&&vn!==title?'<br>'+esc(vn):'');
  // 點開一顆帶星星的圖釘，彈窗裡如果什麼都不說，那顆星就永遠沒有解釋。
  // **另起一行不併進 line2**：小類與地區是「這是什麼」，世界遺產是外部的認定，
  // 兩者性質不同（同餐廳頁把榜單徽章與類別分開的做法）。
  var wh=p.world_heritage
    ? '<div class="wh-tag">'+worldHeritageIconHTML(12)+esc(L.worldHeritage)+'</div>' : '';
  // 「加進行程」在唯讀（分享）模式下整顆不出現。**不可以留一顆按了沒反應的鈕**
  // ——`addToPlan()` 在 planRO 時會直接回 false，而使用者看不出為什麼。
  // 要脫離唯讀模式的入口在行程頁的「自己排一個」，與 `.plan-editonly` 同一條規則。
  var add=store.planRO?''
    : '<button class="places-add'+(inPlan(p)?' on':'')+'" data-pid="'+esc(p.id)+'">'
      +esc(inPlan(p)?L.placesAdded:L.placesAdd)+'</button>';
  var links='';
  if(p.url)links+='<a href="'+esc(p.url)+'" target="_blank" rel="noopener">'+esc(L.official)+'</a>';
  // 票券（單位 M）。**沒有可用商品就整顆不出現**——不做成灰掉的死鈕：
  // 商品會下架，能按但按了是空頁面比沒有這顆更糟。
  // 兩家以上時它是一顆會跳中轉小卡的 `<button>`，一家時就是純外連，
  // 兩種長相都由 `tickets.js` 決定，這裡不判斷。
  // `big` 分得出這是詳情卡還是地圖彈窗，追蹤標籤就用它——
  // ⚠️ 傳的是**語義**不是 class（見 tickets.js 的 whereLabel）。
  links+=ticketBtnHTML(p,'',big?'sheet':'popup');
  // 導航沿用 route.js 的 `meUrl()`：**origin 整個留白**交給 Google 抓裝置定位，
  // 所以這裡與「我的位置永遠不離開裝置」那條硬規則完全無關（不讀 jpev_loc、不送座標）。
  links+='<a href="'+esc(meUrl(p))+'" target="_blank" rel="noopener">'+esc(L.routeGo)+'</a>';
  // ⚠️ 詳情卡的關閉鈕沿用既有的「關閉」字串（`aLocClose` 的值就是「關閉／閉じる」），
  // **不另開一組**——同景點切換器沿用 `restaurantList`／`restaurantMap` 的理由。
  var close=big
    ? '<button type="button" class="place-sheet-close" id="placeSheetClose"'
      +' aria-label="'+esc(L.aLocClose)+'">'
      +'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
    : '';
  return close+hero
    +'<div class="pop-main">'+(big?'':thumb)
      +'<div class="pop-txt"><h3>'+esc(title)+'</h3><div class="m">'+line2+'</div>'+wh+'</div>'
    +'</div>'
    +hoursHTML(p)
    +(approx?'<div class="approxnote">'+esc(L.placesApproxNote)+'</div>':'')
    +(add?'<div class="places-acts">'+add+'</div>':'')
    +'<div class="places-links">'+links+'</div>';
}
function placePopupHTML(p,approx){
  return '<div class="pop places-pop">'+placeBodyHTML(p,approx,false)+'</div>';
}
// ===== 清單／瀑布流（2026-09-02，L4）=====

// ⚠️ **沒有照片的景點整組沉底**（使用者指定）。判準與活動清單的 'default' 排序
// 一字不差：**只看 `img` 欄位空不空**。破圖要等瀏覽器把圖載完才知道，而
// `loading="lazy"` 讓畫面外的圖根本還沒開始載——要等它就得在使用者眼前重排一次。
// **沉底不是丟掉**：那 49 筆照樣看得到，只是排在後面。
// ⚠️ 組內維持原順序（`sort` 在現代引擎是穩定的），所以同一個地區的景點不會跳來跳去。
function sortedForList(){
  return filtered().slice().sort(function(a,b){
    return (a.img?0:1)-(b.img?0:1);
  });
}

function placesColCount(){
  var box=document.getElementById('placesCards');
  var w=box?box.getBoundingClientRect().width:window.innerWidth;
  if(w>=1180)return 5;if(w>=760)return 4;if(w>=460)return 3;return 2;
}

function placeCardHTML(p){
  var L=t();
  // 本站自己的檔案，**不經 images.weserv.nl**（同網域，繞出去沒有必要）——
  // 與彈窗縮圖同一條規則。沒有照片就走中性面板＋小類圖示，
  // ⚠️ **顏色一律 --c-景點**：小類不分色（方案 B），別照抄餐廳頁那套「顏色跟著記錄走」。
  var media=p.img
    ? '<img src="'+esc(PLACE_DIR+p.img)+'" alt="" loading="lazy" data-place-img>'
    : '<div class="block" style="color:var(--c-'+PLACE_TYPE+')">'
      +placeIconHTML(p.genre,30)+'</div>';
  var wh=p.world_heritage
    ? '<span class="wh-tag">'+worldHeritageIconHTML(11)+esc(L.worldHeritage)+'</span>' : '';
  // ⚠️ **照片區是一顆真的 `<button>`，不是加了 role 的 div**（單位 M，2026-09-02）：
  // 鍵盤與螢幕閱讀器天生就能用，自己補 tabindex／keydown 只會少做一半。
  // **只有照片可點、標題不可點**（使用者指定），所以按鈕包的就是 `.ph` 本身。
  return '<article class="place-card">'
    +'<button type="button" class="ph" data-open="'+esc(p.id)+'"'
    +' aria-label="'+esc(fld(p,'title'))+'">'+media+'</button>'
    +'<div class="place-card-body">'
      +'<div class="place-card-meta"><span class="g">'+esc(genreLabel(p))+'</span>'
        +'<span>'+esc(areaLabel(p.area))+'</span></div>'
      +'<h2>'+esc(fld(p,'title'))+wh+'</h2>'
      +hoursHTML(p)
    +'</div></article>';
}

// 依照片實際比例定卡高，夾在 AR_MIN~AR_MAX 之間（與活動、餐廳兩套瀑布流同一組值）。
// ⚠️ **這批照片多數比 AR_MAX 還寬**（實測中位 1.50、最大 1.88），所以會被
// `object-fit:cover` 裁掉左右——那是知情的取捨：三套瀑布流的卡片比例一致，
// 比「景點卡特別扁」更重要。要改就三套一起改。
function wirePlaceImage(img){
  function ok(){
    var w=img.naturalWidth,h=img.naturalHeight;
    if(!w||!h)return;
    var ratio=Math.min(Math.max(h/w,AR_MIN),AR_MAX);
    if(img.parentNode)img.parentNode.style.aspectRatio=(1/ratio).toFixed(4);
  }
  img.addEventListener('load',ok);
  if(img.complete&&img.naturalWidth)ok();
}

function renderPlacesList(){
  var list=sortedForList();
  var n=placesColCount(),cols=[];
  listCols=n;
  for(var i=0;i<n;i++)cols.push([]);
  list.forEach(function(p,idx){cols[idx%n].push(placeCardHTML(p));});
  var box=document.getElementById('placesCards');
  box.innerHTML=cols.map(function(c){return '<div class="places-col">'+c.join('')+'</div>';}).join('');
  var imgs=box.querySelectorAll('img[data-place-img]');
  for(var j=0;j<imgs.length;j++)wirePlaceImage(imgs[j]);
  var empty=document.getElementById('placesEmpty');
  empty.textContent=t().placesNone;
  empty.style.display=list.length?'none':'block';
}

// ===== 景點詳情卡（單位 M，2026-09-02）=====
// 瀑布流的卡片點照片就開這張。**內容與地圖彈窗是同一份**（`placeBodyHTML`），
// 差別只有照片放大成整張卡的寬度、以及多一顆關閉鈕。
//
// ⚠️ **每張卡都點得開，不是「有票的才點得開」**（使用者拍板）：177 張卡片長得
// 一模一樣，若只有一部分按下去有反應，其餘那些在使用者眼裡就是壞掉的。
//
// ⚠️ **層級 1150：壓在覆蓋層（1000）之上、日期小卡與票券中轉小卡（1200）之下。**
// 反過來的話，從詳情卡按「加進行程」跳出來的日期小卡會被它蓋住，
// 而畫面上只會看到「按了沒反應」——同地雷 #21 那個側欄蓋住選點地圖的坑。
var placeSheet=document.getElementById('placeSheet');
var placeSheetBox=document.getElementById('placeSheetBox');
var sheetRec=null;             // 目前開著的是哪一筆（null＝沒開）

function paintPlaceSheet(p){
  placeSheetBox.innerHTML=placeBodyHTML(p,p.geo==='approx',true);
  // 內容每次重畫都要重接監聽器（同彈窗的 `wirePlacesPopup`）。
  var btn=placeSheetBox.querySelector('.places-add');
  if(btn)btn.addEventListener('click',function(){
    onAddClick(p.id,function(){paintPlaceSheet(p);});
  });
  var cl=placeSheetBox.querySelector('.place-sheet-close');
  if(cl)cl.addEventListener('click',closePlaceSheet);
  // 營業時間展開時把它捲進視野（同彈窗；這張卡自己是捲動容器）。
  var fold=placeSheetBox.querySelector('details.hours');
  if(fold)fold.addEventListener('toggle',function(){
    if(fold.open&&fold.scrollIntoView)fold.scrollIntoView({block:'nearest'});
  });
}
function openPlaceSheet(p){
  sheetRec=p;
  paintPlaceSheet(p);
  placeSheet.hidden=false;
  placeSheetBox.scrollTop=0;      // 上一次捲到營業時間，這次要從頭看起
  document.addEventListener('keydown',onSheetKey);
}
function closePlaceSheet(){
  if(!placeSheet||placeSheet.hidden)return;
  placeSheet.hidden=true;sheetRec=null;
  document.removeEventListener('keydown',onSheetKey);
}
// 監聽器只在開著的時候掛（同 tour.js 與票券小卡），關掉就收。
//
// ⚠️ **上面還蓋著別的小卡時，這一下 Esc 不是要關詳情卡**（2026-09-02 實測抓到）。
// 票券中轉小卡與日期小卡（都是 1200）都是**從這張詳情卡按出來的**，而三者的
// keydown 全掛在 document 上——不擋的話一下 Esc 會**同時關掉兩層**：
// 使用者只想收掉「在哪裡買票」，結果連他正在看的景點一起不見了。
// 日期小卡更糟：它自己沒有 Esc，於是底下的詳情卡被關掉、它自己還浮在畫面上。
// **判準是「我上面有沒有東西」，不是「是誰按的」**——日後再加第三張小卡，
// 只要它也在這一層之上，就補進這個清單。
function onSheetKey(e){
  if(e.key!=='Escape')return;
  var over=['ticketSheet','placesDate'];
  for(var i=0;i<over.length;i++){
    var el=document.getElementById(over[i]);
    if(el&&!el.hidden)return;
  }
  closePlaceSheet();
}

// 切換器。**每次重畫都要重接監聽器？不用**——監聽器做委派掛在容器上（見檔尾），
// 這裡只出格子。⚠️ DOM ref 在檔頭取，不要放檔尾：`syncPlacesUi()` 比它先跑
// （餐廳頁 2026-08-28 就因為宣告在檔尾而讓膠囊靜默不畫）。
function buildPlacesViewSwitch(){
  if(!placesSwitch)return;
  placesSwitch.setAttribute('role','group');
  placesSwitch.setAttribute('aria-label',t().aViewSwitch);
  // ⚠️ 標籤沿用 restaurantList／restaurantMap，**刻意不另開一組字串**：
  // 它們就是「清單」與「地圖」兩個通用詞，複製一份等於同一句話存在兩處。
  placesSwitch.innerHTML=[['list',t().restaurantList],['map',t().restaurantMap]]
    .map(function(m){
      var on=viewMode===m[0];
      return '<button type="button" class="viewswitch-seg'+(on?' on':'')+'"'
        +' data-mode="'+m[0]+'"'+(on?' aria-current="true"':'')+'>'+esc(m[1])+'</button>';
    }).join('');
}

function setPlacesMode(m){
  if(m===viewMode)return;
  viewMode=m;
  placesView.classList.toggle('list-mode',m==='list');
  buildPlacesViewSwitch();
  if(!store.places.length){syncPlacesUi();return;}
  if(m==='list')renderPlacesList();
  else{
    // ⚠️ 地圖在 display:none 底下量不到尺寸，**要等它顯示出來的下一幀才 invalidateSize**，
    // 否則圖釘會整批畫在左上角（同 openPlaces 那個 requestAnimationFrame）。
    requestAnimationFrame(function(){
      initPlacesMap();placesMap.invalidateSize();renderPlacesMap();
    });
  }
}

function initPlacesMap(){
  if(placesMap)return;
  placesMap=L.map('placesMap',{zoomControl:true}).setView([35.68,139.75],9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:18,attribution:'© OpenStreetMap'
  }).addTo(placesMap);
  placesMap.on('popupopen',function(e){wirePlacesPopup(e.popup);});
}
// 彈窗內容換過就要重接一次（`setContent` 會換掉整個 DOM）。
// ⚠️ **不可以用 `popup.update()`**：它拿原始字串重繪，會把 `<details>` 的展開狀態
// 與監聽器一起清掉，按下去看起來像沒反應（餐廳頁 2026-08-12 踩過）。
function wirePlacesPopup(popup){
  var el=popup.getElement();
  if(!el)return;
  var fold=el.querySelector('details.hours');
  if(fold)fold.addEventListener('toggle',function(){
    if(fold.open&&fold.scrollIntoView)fold.scrollIntoView({block:'nearest'});
  });
  var btn=el.querySelector('.places-add');
  // ⚠️ **`stopPropagation()` 不可省，而且原因不直覺**（2026-08-20 實測抓到）：
  // 這顆鈕按下去會走 `repaintPopup()`，而它用 `setContent` 換掉整個彈窗內容
  // ——**事件還在往上冒泡，原本的目標節點卻已經被拔掉了**，於是 Leaflet 那道
  // 「這一下是點在彈窗裡」的判斷（`disableClickPropagation` 掛在內容節點上）對不上，
  // 這一下被當成「點到地圖」，`closePopupOnClick` 就把彈窗關掉。
  // 症狀是「按了加進行程，行程真的加到了，但彈窗整個消失」——看起來像閃退，
  // 而且**因為行程確實加成功了，很容易被當成只是視覺問題放過去**。
  if(btn)btn.addEventListener('click',function(e){
    e.stopPropagation();
    onAddClick(btn.getAttribute('data-pid'),function(){repaintPopup(popup);});
  });
}
function repaintPopup(popup){
  var rec=popup._source&&popup._source._rec;
  if(!rec)return;
  popup.setContent(placePopupHTML(rec,rec.geo==='approx'));
  wirePlacesPopup(popup);
}
// 目前篩選底下的景點圖釘。⚠️⚠️ **疊圖模式（單位 く）與這張地圖共用同一份**——
// 抽出來不是複製，所以「同一個篩選在兩張地圖上結果不一樣」這種靜默漂移不可能發生。
function placeMarkers(){
  var out=[];
  filtered().forEach(function(p){
    if(typeof p.lat!=='number'||typeof p.lng!=='number')return;
    var approx=p.geo==='approx';
    var m=L.marker([p.lat,p.lng],{icon:placePinIcon(p,approx)});
    // 內容傳函式而非字串：Leaflet 只在開啟時才呼叫它，
    // 而「加進行程」的按鈕狀態必須是**點開那一刻**的（中間可能在行程頁被刪掉了）。
    m.bindPopup(function(){return placePopupHTML(p,approx);},{minWidth:242,maxWidth:262});
    m._rec=p;
    m._kind='pl';
    out.push(m);
  });
  return out;
}

function renderPlacesMap(){
  initPlacesMap();
  if(markerLayer)placesMap.removeLayer(markerLayer);
  var markers=placeMarkers();
  var pts=markers.map(function(m){var ll=m.getLatLng();return [ll.lat,ll.lng];});
  markerLayer=makePlacesLayer(markers);
  markerLayer.addTo(placesMap);
  buildPlacesLegend();
  syncPlacesUi();
  // **先 invalidateSize 再 fitBounds**：面板剛顯示時容器還是 0×0，
  // 在那之前算 bounds 會退回最小縮放。60ms 後再做一次，因為覆蓋層的過場
  // 可能讓第一次仍量到舊尺寸（與餐廳頁同一個坑）。
  // ⚠️⚠️ **keep 要在這裡取一次，不可以放進 fitPlacesView 裡面**（單位 き-2）：
  // 那個函式**會被呼叫兩次**（立刻一次、60ms 後再一次），在裡面消費的話第二次就拿不到，
  // 於是視野被 fitBounds 蓋回全日本——**而畫面上只是「切過去又跳掉了」，像功能沒做**。
  // **只有真的有點時才消費**：資料還沒到的那一次 pts 是空的（見 map.js 同一處）。
  var keep=pts.length?takeMapView():null;
  function fitPlacesView(){
    placesMap.invalidateSize();
    // 從另一張地圖切過來時沿用它的視野（單位 き-2）。⚠️ 照樣 early return，
    // 理由與下面那條 dangling else 一模一樣。
    if(keep){placesMap.setView([keep.lat,keep.lng],keep.z,{animate:false});return;}
    // 開場視野：`fitBounds` 散得太開時改用「我的位置」（單位 Y-4，共用一份）。
    // ⚠️⚠️ **「沒有點」那條要先 return，不可以掛成 `else`**（2026-09-07 實測抓到）：
    // 寫成 `if(pts.length&&!fitFromMyLoc(...)) fitBounds(); else setView(初始值)` 的話，
    // **`fitFromMyLoc` 回 true 也會掉進那個 else**，剛設好的視野立刻被初始值蓋回去。
    // 症狀極具欺騙性——畫面上還是「開場在東京」，只有 zoom 停在初始的 9（該是 10）。
    if(!pts.length){placesMap.setView([35.68,139.75],9);return;}
    if(!fitFromMyLoc(placesMap,pts,[36,36]))
      placesMap.fitBounds(pts,{padding:[36,36],maxZoom:14});
  }
  fitPlacesView();
  setTimeout(fitPlacesView,60);
}

// ===== 圖例 =====
// **這是一張「圖示對照表」，不是色塊表**：小類的方塊顏色一模一樣（都是
// `--pin-景點`），唯一在變的是裡面的圖示。方塊仍然保留，因為圖例要長得跟地圖上
// 看到的東西一樣——只印一個墨色線條圖，使用者還得自己換算成白線條的彩色圖釘。
//
// **小類那段收合起來**（2026-08-27，使用者要求；做法與樣式整套沿用餐廳頁的
// `.legend-genres`，兩頁共用同一份 CSS）。全關東時是 7 個小類 ＋ 世界遺產 ＝ 8 行
// 約 185px，手機上吃掉四分之一的地圖；收起來剩 2 行約 60px，而且**不管日後
// 幾個小類，收合高度都一樣**。世界遺產／概略位置那兩行留在外面常駐——
// 它們本來就是條件性的（真的有才印），且永遠只有一行。
function buildPlacesLegend(){
  var list=filtered(),present={};
  list.forEach(function(p){if(p.genre)present[p.genre]=1;});
  // 先照 PLACE_GENRES 排，再把表上沒有的接在後面——管線新增小類而 config 忘了補，
  // 後果只是它排在最後，**不會從圖例上靜默消失**（同 buildAreaSel 那條規則）。
  var order=PLACE_GENRES.filter(function(g){return present[g];});
  Object.keys(present).forEach(function(g){if(order.indexOf(g)<0)order.push(g);});
  var c=pinColor(PLACE_TYPE);
  var rows=order.map(function(g){
    return '<div><span class="dot" style="background:'+c+'">'+placeIconHTML(g,LEGEND_ICON)
      +'</span>'+esc(store.lang==='ja'?genreJaOf(g):g)+'</div>';
  }).join('');
  // **只有一個小類時不收合**（篩到川崎那種只有兩筆的地區就會發生）：收起來是一行
  // 標題、展開也是一行內容，多一顆要點的三角形卻一個像素都沒省。
  var html=order.length>1
    ? '<details class="legend-genres"'+(legendOpen?' open':'')+'>'
        +'<summary>'+esc(t().placesGenre)+' '+order.length+'</summary>'
        +'<div class="legend-rows">'+rows+'</div></details>'
    : rows;
  // 世界遺產那一行。**照「概略位置」的既有規則：當前篩選裡真的有才印。**
  // 色塊那一格刻意留空底——這一行要解釋的是**那顆星**，不是一種圖釘，
  // 但寬度仍與上面的小類色塊一致（14px），三行才對得齊。
  if(list.some(function(p){return p.world_heritage;})){
    html+='<div style="margin-top:3px"><span class="dot wh-dot">'
      +worldHeritageIconHTML(WH_LEGEND)+'</span>'+esc(t().worldHeritage)+'</div>';
  }
  // 概略位置那一行**只在真的有 approx 時才印**（目前 67 筆全部 precise）。
  // 常駐一行永遠對不到任何圖釘的說明，只是佔掉手機上的地圖。
  if(list.some(function(p){return p.geo==='approx';})){
    html+='<div style="margin-top:3px"><span class="dot approx" style="background:'
      +c+'"></span>'+esc(t().approx)+'</div>';
  }
  var box=document.getElementById('placesLegend');
  box.innerHTML=html;
  // **每次重畫都要重接監聽器**：innerHTML 換掉整個節點，舊的跟著沒了。
  // `toggle` 事件**不會冒泡**，所以委派在容器上沒有用（餐廳頁 2026-08-14 踩過）。
  // 記住展開狀態的理由：切地區、切語言、切晝夜都會重畫圖例，不記的話使用者
  // 開著的它會自己合起來。
  var fold=box.querySelector('details.legend-genres');
  if(fold)fold.addEventListener('toggle',function(){legendOpen=fold.open;});
}

// ===== 加進行程：先問日期 =====
// ⚠️ **不可以預設今天**（使用者指定）。景點是「哪天去都可以」的東西，
// 使用者點下去時腦子裡想的多半是某個週末；默默塞進今天等於幫他決定，
// 而且那張行程會安安靜靜地排在今天，他不會發現。
// ⚠️ **那張小卡本身在 plan-ui**（2026-08-26 起，單位 I 讓餐廳分頁也要問同一件事）。
// 分兩處寫必然漂移，故整段移到擁有 `store.plan.date` 的那一支，這裡只呼叫。
// ⚠️ 第二個參數是**「加完之後要重畫哪一塊」的函式**，不是彈窗物件（2026-09-02 改）：
// 同一顆「加進行程」現在有兩個家——地圖彈窗與詳情卡，而兩者的重畫方式不同。
// 把重畫交回呼叫端，這裡就不必知道自己被誰按下（同 `initSettings(cb)` 的做法）。
function onAddClick(id,redraw){
  if(!id)return;
  var i=store.plan.ids.indexOf(id);
  if(i>-1){                      // 已加入的按一下就移除（同「自己組」的回饋方式）
    store.plan.ids.splice(i,1);
    store.planSel=-1;savePlan();
    if(redraw)redraw();
    return;
  }
  if(!planDateReady()){
    askPlanDate(function(){doAdd(id,redraw);});
    return;
  }
  doAdd(id,redraw);
}
function doAdd(id,redraw){
  // **一定要走 plan-ui 的 addToPlan()**：上限 4 站、滿了的提示、唯讀模式的守門
  // 全都在那裡面。自己 push 會漏掉其中一件。
  if(addToPlan(id))store.planSel=-1;   // 行程已經不是某一套原案了
  if(redraw)redraw();
}
// ===== 介面 =====
function syncPlacesUi(){
  var L=t();
  tabPlaces.setAttribute('aria-label',L.aPlaces);
  document.getElementById('placesClose').setAttribute('aria-label',L.aPlacesClose);
  document.getElementById('placesTitle').textContent=L.placesTitle;
  document.getElementById('pfTitle').textContent=L.filterTitle;
  document.getElementById('pfAreaH').textContent=L.area;
  document.getElementById('pfGenreH').textContent=L.placesGenre;
  document.getElementById('pfClear').textContent=L.clearFilter;
  buildPlacesFilter();syncPlacesFilterBtn();
  buildPlacesViewSwitch();
  document.getElementById('placesSub').textContent=
    dataSettled?L.placesCount(filtered().length):L.placesLoading;
  // 狀態訊息分三種，**不可混成一句**：還在載入（等一下就好）／整份讀不到
  //（重整或稍後再來）／這個地區沒有景點（換一個地區）。混講會讓有解的看起來無解。
  var msg='';
  if(!dataSettled)msg=L.placesLoading;
  else if(!store.places.length)msg=L.placesLoadFail;
  // ⚠️ 清單模式下這句交給 #placesEmpty 講，**這裡就要閉嘴**——
  //    兩個地方同時說「這個地區沒有景點」會像壞掉。載入中與讀不到仍然由這裡講
  //    （那兩種狀態下清單面板本來就是空的，沒有第二個聲音）。
  else if(!filtered().length&&viewMode!=='list')msg=L.placesNone;
  placesStatus.textContent=msg;
  placesStatus.classList.toggle('show',!!msg);
}
function setActiveTab(id){
  var tabs=document.querySelectorAll('.tabbar .tab');
  for(var i=0;i<tabs.length;i++)tabs[i].classList.toggle('on',tabs[i].id===id);
}
function openPlaces(){
  var active=document.querySelector('.tabbar .tab.on');
  previousTab=active&&active.id!=='tabPlaces'?active.id:(store.state.view==='fav'?'tabFav':'tabAll');
  // 切換到另一張地圖時**不可以重存**：那時卡片是藏起來的、頁面高度為 0，
  // 存到的會是 0，最後關掉就回到清單最頂端而不是原來看的位置（見 store.mapSwitching）。
  if(!store.mapSwitching){
    store.overlayScroll=window.scrollY||window.pageYOffset||0;
    store.mapView=null;   // 不是切換過來的＝全新開場，丟掉殘留的視野（單位 き-2）
  }
  setActiveTab('tabPlaces');
  document.body.classList.add('places-open');
  placesView.classList.add('show');
  syncPlacesUi();
  placesView.classList.toggle('list-mode',viewMode==='list');
  if(viewMode==='list'){
    if(store.places.length)renderPlacesList();
    return;
  }
  requestAnimationFrame(function(){
    initPlacesMap();placesMap.invalidateSize();
  });
  if(store.places.length)renderPlacesMap();
}
function closePlaces(){
  keepMapView(placesMap);   // 把現在看的位置交給下一張地圖（單位 き-2）
  closeDateSheet();
  // ⚠️ 兩張小卡都掛在最上層 DOM，**不在 `#placesView` 裡面**，所以覆蓋層藏起來
  // 它們不會跟著消失——留著就是一張浮在清單上、關不掉的卡片。
  closePlaceSheet();closeTicketSheet();
  placesView.classList.remove('show');
  document.body.classList.remove('places-open');
  setActiveTab(previousTab||'tabAll');
  // 覆蓋層是 display:none，頁面高度會歸零，故捲動位置自己存自己還原（同地圖與行程頁）。
  // 切換到另一張地圖時不還原（下一張馬上就會蓋上來，還原只會白跑一次；
  // 真正該還原的是最後那一次關閉）。
  if(!store.mapSwitching)requestAnimationFrame(function(){window.scrollTo(0,store.overlayScroll);});
}
// 語言／明度變動後重畫。圖釘與圖例是 JS 產生的顏色字串，不會跟著 CSS 變數走。
function refreshPlaces(){
  syncPlacesUi();
  // ⚠️ 疊圖那張也要跟著換語言／換配色（圖釘顏色是 JS 產生的字串，不會跟著 CSS 變數走）。
  if(allRepaint)allRepaint();
  if(!store.places.length||!placesView.classList.contains('show'))return;
  // 開著的詳情卡也要跟著換語言／換配色（它的內容是 JS 產生的字串，
  // 不會跟著 CSS 變數或 `store.lang` 自己變）。
  if(sheetRec)paintPlaceSheet(sheetRec);
  if(viewMode==='list')renderPlacesList();else renderPlacesMap();
}
// main.js 在兩份資料都有結果之後呼叫一次（成功或失敗都要呼叫）。
// **沒有這個訊號就分不出「還在載入」與「讀不到」**，而那兩句話對使用者的意義完全不同。
function placesDataSettled(){
  dataSettled=true;
  refreshPlaces();
}

tabPlaces.addEventListener('click',openPlaces);
document.getElementById('placesClose').addEventListener('click',closePlaces);
// ===== 篩選彈窗的接線（2026-09-03）=====
// ⚠️ 三個監聽器**全部委派在容器上**：chip 每次重畫都整個換掉，掛在 chip 上一重畫就失效。
// 疊圖模式（單位 く）的重畫。⚠️ **由 main.js 注入**，方向仍是 mapall → places：
// 這一支不知道疊圖那張的存在，只知道「改完之後要通知一個人」。
// 少了它，在疊圖模式按篩選會變成「彈窗開得起來、選得動、關掉之後地圖一模一樣」
// ——同單位 き-1 的 setMapRepaint 那條。
var allRepaint=null;
function setPlacesAllRepaint(fn){allRepaint=fn;}

function afterFilterChange(){
  syncPlacesUi();
  if(allRepaint)allRepaint();
  // ⚠️⚠️ **多了 `.show` 這道守門**（單位 く）：篩選現在也可以從疊圖模式改，
  // 而那時景點頁是關著的——照舊往下走會去畫一張看不見的地圖，
  // 而 `renderPlacesMap()` 裡的 `takeMapView()` 是**會消費掉的**（單位 き-2），
  // 疊圖那張要用的視野就被吃掉了。`refreshPlaces()` 早就有同一道守門。
  if(!store.places.length||!placesView.classList.contains('show'))return;
  if(viewMode==='list')renderPlacesList();else renderPlacesMap();
}
pfBtn.addEventListener('click',openPlacesFilter);
pfView.addEventListener('click',function(e){if(e.target===pfView)closePlacesFilter();});
pfArea.addEventListener('click',function(e){
  if(handleGeoClick(e,geoSel))afterFilterChange();
});
pfGenre.addEventListener('click',function(e){
  var b=e.target.closest?e.target.closest('.side-chip'):null;
  if(!b)return;
  var g=b.getAttribute('data-genre');
  if(!g)return;
  if(genreSel[g])delete genreSel[g];else genreSel[g]=1;
  afterFilterChange();
});
document.getElementById('pfDone').addEventListener('click',closePlacesFilter);
document.getElementById('pfClear').addEventListener('click',function(){
  clearGeo(geoSel);genreSel={};
  afterFilterChange();
});
// 切換器用**委派**：格子每次都被 innerHTML 換掉，直接掛在按鈕上會在重畫後失效
// （同 buildLegend／mapswitch／餐廳頁那顆的做法）。
placesSwitch.addEventListener('click',function(e){
  var b=e.target.closest('.viewswitch-seg');
  if(b)setPlacesMode(b.dataset.mode);
});
// 卡片的照片區 → 詳情卡。**委派掛在容器上**：格子每次 `renderPlacesList()` 都被
// innerHTML 整段換掉，掛在按鈕上重畫一次就失效（同切換器與圖例那條）。
document.getElementById('placesCards').addEventListener('click',function(e){
  var b=e.target.closest('.ph[data-open]');
  if(!b)return;
  var id=b.getAttribute('data-open');
  for(var i=0;i<store.places.length;i++){
    if(store.places[i].id===id){openPlaceSheet(store.places[i]);return;}
  }
});
// 點卡片外面的暗色區關掉。⚠️ 比對 `e.target===placeSheet` 而不是 closest——
// 否則點在卡片內部的空白處也會關掉。
placeSheet.addEventListener('click',function(e){
  if(e.target===placeSheet)closePlaceSheet();
});
var placesResizeTimer;
window.addEventListener('resize',function(){
  clearTimeout(placesResizeTimer);
  placesResizeTimer=setTimeout(function(){
    if(!placesView.classList.contains('show'))return;
    if(viewMode==='list'){
      // 欄數沒變就不要重畫：重畫會把所有 <img> 換掉，已經載好的圖會重新閃一次。
      if(store.places.length&&placesColCount()!==listCols)renderPlacesList();
      return;
    }
    // **只重算尺寸不重畫**：重畫會 fitBounds，把使用者手動縮放過的視野重置掉。
    if(placesMap)placesMap.invalidateSize();
  },160);
});

// openPlaces／closePlaces 對外開放的理由同 restaurants.js：給 mapswitch.js 切換用，
// 而這個模組不知道切換器的存在。
export { closePlaces, openPlaces, openPlacesFilter, placeMarkers, placesDataSettled, placesFilterCount, refreshPlaces, setPlacesAllRepaint, wirePlacesPopup };
