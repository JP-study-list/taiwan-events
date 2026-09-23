// 餐廳分頁：**兩層載入**。開分頁只抓 restaurants/_map.json（輕量索引，每家約 174 bytes），
// 完整資料等到真的要顯示時才按檔載入。2000 家時索引約 340KB，完整資料則是 2MB 分散在
// 二十個檔——一次抓齊會讓開分頁卡住好幾秒。
//
// 資料物件只有一份：索引載入時展開成完整形狀（缺的欄位是 undefined），
// 詳細檔到齊後用 Object.assign 就地補上並標 `_full`。**所以所有算繪函式不必分兩套**，
// 只是在 `_full` 之前少顯示幾個欄位。
//
// 這個模組擁有餐廳資料、據點篩選、地圖與清單的全部狀態；其他模組只透過
// refreshRestaurants() 要它在語言／明度變動後重繪，不跨模組改寫內部變數。
import { AR_MAX, AR_MIN, IMG_W_THUMB, OTHER_SPOT, RESTAURANT_LIST, SPOTS } from './config.js';
import { genreIconHTML } from './icons.js';
import { keepMapView, store, takeMapView } from './store.js';
import { awardsHTML, cssVar, esc, geoMatch, mapQuery, pinColor, planFoodIdOf, proxied, t, typeColor } from './util.js';
import { clearGeo, geoActive, geoChipsHTML, handleGeoClick, newGeoSel, spotText } from './geofilter.js';
import { favFoodCount, isFavFood, syncFavFood, toggleFavFood } from './favfood.js';
import { fitFromMyLoc } from './mylocation.js';

var restaurantView=document.getElementById('restaurantView');
var restaurantMapPanel=document.getElementById('restaurantMapPanel');
var restaurantListPanel=document.getElementById('restaurantListPanel');
var restaurantStatus=document.getElementById('restaurantStatus');
// 篩選彈窗（2026-09-03 第二輪：三個下拉 → 一顆鈕＋多選彈窗）。
// ⚠️ 全部要在檔頭取，理由見下面 restaurantSwitch 那條註解。
var rfView=document.getElementById('restaurantFilterView');
var rfBtn=document.getElementById('restaurantFilterBtn');
var rfCount=document.getElementById('restaurantFilterCount');
var rfArea=document.getElementById('rfArea');
var rfGenre=document.getElementById('rfGenre');
var favOnlyBtn=document.getElementById('restaurantFavOnly');
var tabRestaurant=document.getElementById('tabRestaurant');
// ⚠️ **這一個一定要跟其他幾個一樣在檔頭取。** 它原本宣告在檔案最下面的初始化那一段，
//    而 `syncRestaurantUi()` 比那一行更早跑得到——`var` 雖然會提升，值卻是 undefined，
//    於是膠囊**靜默地不畫**（畫面上只是「那顆鈕不見了」，和被 RESTAURANT_LIST 關掉一模一樣）。
var restaurantSwitch=document.getElementById('restaurantSwitch');

var restaurants=[];              // 索引展開後的物件，詳細資料到齊時就地補上
var detailFiles=[];              // _map.json 的 files[]，索引 = 記錄的 _f
var genreMeta=[];                // [{zh,ja,n}]，類別下拉與圖例用，不必等詳細檔
var awardDict=[];                // _map.json 的 awards[]：[guide,tier,year] 的字典，見 expandSlim
var filePromise={};              // 檔案索引 → Promise，避免同一個檔重複抓
var loaded=false,loading=false,loadError=false,loadPromise=null;
var viewMode='map',previousTab='tabAll';
// 地理選擇（圈／桶／據點，多選）與類別（多選）。**都不進 store**——同 favOnly，
// 只有本模組讀寫。形狀與判定在 js/geofilter.js。
// ⚠️ **刻意不記進 localStorage**：餐廳頁每次都是從分頁點進來的，記住上次的篩選
//    會讓人打開看到一張不是自己選的地圖，而畫面上沒有任何地方說得出原因。
//    （行程頁的大區記憶是另一回事——那是設定，而且它自己那一列一直看得見。）
var geoSel=newGeoSel();
// ⚠️ 空的 = **不篩選**，不是零筆（同 geoSel.areas）。把最後一個取消掉之後
//    應該退回「全部」，不是對著一張空地圖。
var genreSel={};
function genreActive(){return Object.keys(genreSel).length>0;}
function genreOk(r){return !genreActive()||!!genreSel[r.genre];}
var favOnly=false;   // 「只看收藏」（單位 K）。**不進 store**——只有本模組讀寫。
var restaurantMap=null,restaurantMarkerLayer=null,listCols=0;
var legendOpen=false;            // 圖例的類別段是否展開；重畫圖例時要還原它
// 「加進行程」的處理函式（單位 I 決策 17②）。**由 main.js 注入，本模組不 import plan-ui。**
// ⚠️ 方向不可對調：plan-food 已經 import 本模組（要複用下面那個 _map.json 載入器），
// 而 plan-ui import plan-food——這裡再 import plan-ui 就成環了。
// 同 mylocation 的 openLocPicker(cb)／settings 的 initSettings(cb)：**誰擁有那個動作，
// 誰就把函式交過來**。沒注入時整顆鈕不出現（而不是按了沒反應）。
var foodAddHandler=null;
function setFoodAddHandler(fn){foodAddHandler=fn;}
// 這家店是不是已經在行程裡。**判斷在 util 的 planFoodIdOf()**（2026-08-27 整併）：
// 同一件事有三個地方要問（這裡、行程頁的候選清單、收藏清單那顆「＋」），
// 各寫一份必然漂移，而症狀是「那顆鈕的狀態跟行程對不起來」。
function inPlanFood(r){return !!planFoodIdOf(r.id);}

function genreLabel(r){
  return store.lang==='ja'?(r.genre_ja||r.genre):(r.genre||r.genre_ja);
}
function genreJaOf(g){
  // 類別的日文名由 _map.json 的 genres[] 提供，**不必等詳細檔**——
  // 類別下拉與圖例在開分頁的第一秒就要能顯示。
  for(var i=0;i<genreMeta.length;i++)if(genreMeta[i].zh===g)return genreMeta[i].ja;
  return g;
}
// 據點顯示名。**實作在 geofilter.js**（2026-09-03 整併）——彈窗與彈窗外都要用，
// 而同一條規則存在兩處必然漂移。這裡只留一個轉接名，本檔既有的四處呼叫不必改。
function spotLabel(v){return spotText(v);}
function budgetValue(r){
  // 舊檔的 budget 帶著「預算 」前綴，新檔只存純金額；兩種都容忍，顯示時一律去掉前綴。
  var dinner=String(r.budget||'').replace(/^(?:預算|予算)\s*/, '').trim();
  var lunch=String(r.budget_lunch||'').replace(/^(?:預算|予算)\s*/, '').trim();
  // 午餐與晚餐同價時不重複列出（來源有 11 家兩欄一樣，列兩次只是噪音）。
  if(dinner&&lunch&&lunch!==dinner)return dinner+'（'+t().restaurantLunch+' '+lunch+'）';
  return dinner||lunch;
}
function hoursHTML(r){
  // 營業時間／公休日只有部分榜單有（燒肉那份沒有），缺就整段不出現。
  // 來源的營業時間長度差很多（整週時刻表可達 400 字），攤開會把卡片撐爛，
  // 故預設只留「營業時間」四個字，按了才展開全文。用原生 <details> 不必自己寫開合。
  var rows=[];
  var hours=[r.hours,r.hours_note].filter(Boolean).join('　');
  if(hours)rows.push('<details class="hfold"><summary>'+esc(t().restaurantHours)+'</summary>'
    +'<div>'+esc(hours)+'</div></details>');
  // 公休日通常很短（「水」「月、火」），留在外面一眼可見；偶爾很長才夾兩行。
  if(r.holiday)rows.push('<div class="clip" title="'+esc(r.holiday)+'"><span>'
    +esc(t().restaurantHoliday)+'</span> '+esc(r.holiday)+'</div>');
  return rows.length?'<div class="restaurant-hours">'+rows.join('')+'</div>':'';
}
function restaurantQuery(r){
  // 沿用 util.js 的 mapQuery()；餐廳沒有 venue 欄位，故把「店名＋地址」映射成
  // 它既有的日文場地輸入。沒有地址的那一筆仍會用店名搜尋，不會誤用 null 座標。
  return mapQuery({
    venue_ja:[r.name_ja,r.address].filter(Boolean).join(' '),
    venue:r.name_ja||'',area:r.area,lat:r.lat,lng:r.lng
  });
}
function googleMapUrl(r){
  return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(restaurantQuery(r));
}
// 徽章的 HTML 在 util.js（2026-08-27 搬過去）：單位 K 的收藏清單也要印它，
// 而那個模組不能 import 本模組（cards → favfood → restaurants 會成環）。

// ===== 地圖 =====
function restaurantClusterIcon(cluster){
  var n=cluster.getChildCount();
  var size=n<10?32:(n<100?38:44);
  return L.divIcon({
    className:'',
    html:'<div class="cl" style="width:'+size+'px;height:'+size+'px">'+n+'</div>',
    iconSize:[size,size],iconAnchor:[size/2,size/2]
  });
}
// 圖釘 26px、圖示 14px（2026-08-13）。**活動地圖那邊仍是 20px**——放大只套在
// `.pin.restaurant-pin`，因為餐廳有 21 個類別、光靠顏色分不完，需要塞一個形狀進去；
// 活動只有 6 個分類，顏色就夠，放大只會讓圖釘互相擋。
var PIN_SIZE=26, PIN_ICON=14, LEGEND_ICON=10;
// ⚠️ **餐廳的圖釘是圓角方**（2026-09-11，單位 く 第二輪，全站一致不分模式）。
// 形狀寫在 CSS 的 `.pin.restaurant-pin` 上，這裡不必再傳任何東西。
function restaurantPinIcon(r,approx){
  // 顏色跟著類別走（CSS 的 --pin-<類別>）。**不可寫死某個類別**——多一份榜單就多一種顏色，
  // 寫死會讓新類別全部畫成燒肉色。讀不到就退回 typeColor()，與活動地圖同一套做法。
  // 圖示同理：`genreIconHTML` 查不到就回空字串，該類別維持「只有顏色」。
  return L.divIcon({
    className:'',
    html:'<div class="pin restaurant-pin'+(approx?' approx':'')+'" style="background:'
      +pinColor(r.genre)+'">'+genreIconHTML(r.genre,PIN_ICON)+'</div>',
    iconSize:[PIN_SIZE,PIN_SIZE],iconAnchor:[PIN_SIZE/2,PIN_SIZE],popupAnchor:[0,-(PIN_SIZE-2)]
  });
}
function wireRestaurantPopupImg(img){
  var done=false;
  function fail(){
    if(done)return;done=true;
    var d=document.createElement('div');
    d.className='pth pth-block';
    d.textContent=img.getAttribute('data-label')||'';
    d.style.color=img.getAttribute('data-color')||'';
    if(img.parentNode)img.parentNode.replaceChild(d,img);
  }
  function ok(){
    if(done)return;
    if(img.naturalWidth&&Math.max(img.naturalWidth,img.naturalHeight)<200){fail();return;}
    done=true;
  }
  img.addEventListener('load',ok);
  img.addEventListener('error',fail);
  if(img.complete){if(img.naturalWidth)ok();else fail();}
}
function restaurantPopupHTML(r,approx){
  var thumb=r.img
    ? '<img class="pth restaurant-popup-img" src="'+esc(proxied(r.img,IMG_W_THUMB))+'" alt=""'
      +' referrerpolicy="no-referrer" data-label="'+esc(genreLabel(r))+'"'
      +' data-color="'+esc(typeColor(r.genre))+'">'
    : '<div class="pth pth-block" style="color:'+typeColor(r.genre)+'">'+esc(genreLabel(r))+'</div>';
  var place=[spotLabel(r.spot),r.address].filter(Boolean).join('・');
  // 「加進行程」（單位 I）。**唯讀（分享）模式與尚未注入處理函式時整顆不出現**——
  // 不可以留一顆按了沒反應的鈕（同景點彈窗那顆的規則）。
  // class 沿用景點彈窗的 `.places-add`：兩處是同一顆按鈕的同一個狀態機，
  // 名稱裡的 places 是它第一次出現的地方，不改名的理由同 `.side-chip`。
  var added=inPlanFood(r);
  // 收藏星（單位 K）。**與「加進行程」並排在同一列**，不掛到標題旁邊——
  // 標題那行是店名，塞一顆鈕進去會讓長店名折行的位置變得無法預期。
  // ⚠️ 這顆**不受唯讀模式影響**：唯讀說的是「這是別人分享的行程」，
  // 而收藏是使用者自己的東西，兩件事無關。
  var fav=isFavFood(r.id);
  var favBtn='<button class="places-fav'+(fav?' on':'')+'" data-food-fav="'+esc(r.id)+'"'
    +' aria-label="'+esc(fav?t().aFavFoodOn:t().aFavFood)+'">★</button>';
  var add=(foodAddHandler&&!store.planRO)
    ? '<button class="places-add'+(added?' on':'')
      +'" data-food-add="'+esc(r.id)+'">'
      +esc(added?t().placesAdded:t().placesAdd)+'</button>' : '';
  return '<div class="pop restaurant-pop">'
    +'<div class="pop-main">'+thumb
      +'<div class="pop-txt"><h3>'+esc(r.name_ja)+'</h3>'
        +'<div class="restaurant-budget"><span>'+esc(t().restaurantBudget)+'</span> '
          +esc(budgetValue(r))+'</div>'
        +'<div class="restaurant-awards">'+awardsHTML(r)+'</div>'
      +'</div>'
    +'</div>'
    +hoursHTML(r)
    +(place?'<div class="restaurant-address">'+esc(place)+'</div>':'')
    +(approx?'<div class="approxnote">'+esc(t().restaurantApproxNote)+'</div>':'')
    +'<div class="places-acts">'+add+favBtn+'</div>'
    +'<a href="'+esc(googleMapUrl(r))+'" target="_blank" rel="noopener">'
      +esc(t().aGmap)+' →</a></div>';
}
function initRestaurantMap(){
  if(restaurantMap)return;
  restaurantMap=L.map('restaurantMap',{zoomControl:true}).setView([35.68,139.75],11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:18,attribution:'© OpenStreetMap'
  }).addTo(restaurantMap);
  restaurantMap.on('popupopen',function(e){
    wireRestaurantPopup(e.popup);
    // 詳細資料還沒到就先顯示索引有的部分（店名、類別），載完再換內容重接一次。
    var rec=e.popup._source&&e.popup._source._rec;
    if(rec&&!rec._full)loadDetailFile(rec._f).then(function(){
      if(!restaurantMap.hasLayer(e.popup))return;   // 使用者已經關掉了
      e.popup.setContent(restaurantPopupHTML(rec,rec.geo==='approx'));
      wireRestaurantPopup(e.popup);                 // setContent 換掉了整個 DOM
    }).catch(function(){});
  });
}
function wireRestaurantPopup(popup){
  var el=popup.getElement();
  if(!el)return;
  var img=el.querySelector('img.restaurant-popup-img');
  if(img)wireRestaurantPopupImg(img);
  // ⚠️ **不要用 `popup.update()`**。Leaflet 的 update() 會拿原始內容重繪，
  // 把 <details> 的展開狀態與監聽器一起清掉——按下去看起來像沒反應。
  // 要換內容一律用 setContent，換完記得重新呼叫本函式接監聽器。
  var fold=el.querySelector('details.hfold');
  if(fold)fold.addEventListener('toggle',function(){
    if(fold.open&&fold.scrollIntoView)fold.scrollIntoView({block:'nearest'});
  });
  // 收藏星（單位 K）。⚠️ **只換這顆鈕的 class 與 aria-label，不 setContent**——
  // 重畫整個彈窗會把 <details> 的展開狀態清掉（2026-08-12 踩過），而收藏這件事
  // 只影響這一顆的樣子。`stopPropagation()` 的理由同下面那顆。
  var favB=el.querySelector('.places-fav');
  if(favB)favB.addEventListener('click',function(e){
    e.stopPropagation();
    var rec=popup._source&&popup._source._rec;
    var on=toggleFavFood(rec);
    favB.classList.toggle('on',on);
    favB.setAttribute('aria-label',on?t().aFavFoodOn:t().aFavFood);
    // 「只看收藏」開著時取消收藏 → 那顆圖釘就該消失，所以整張地圖重畫。
    // **重畫會關掉這個彈窗**，而那正是使用者剛剛要求的（他把這家店移出了目前的視野）。
    // ⚠️ **不可以寫死 renderRestaurantMap()**（單位 く）：同一支接線現在也跑在疊圖那張上，
    // 而那時餐廳頁根本沒開——重畫一張看不見的地圖，畫面上那顆圖釘不會消失。
    if(favOnly){
      if(restaurantView.classList.contains('show'))renderRestaurantMap();
      if(allRepaint)allRepaint();
    }
    syncFavOnlyChip();
  });
  var add=el.querySelector('.places-add');
  // ⚠️ **`stopPropagation()` 不可省**（景點彈窗 2026-08-20 實測抓到的同一個坑）：
  // 這顆鈕按下去會 `setContent` 換掉整個彈窗內容——**事件還在往上冒泡，
  // 原本的目標節點卻已經被拔掉了**，於是 Leaflet 那道「這一下是點在彈窗裡」的判斷
  // 對不上，這一下被當成「點到地圖」而把彈窗關掉。症狀是「按了加進行程，
  // **行程真的加到了**，但彈窗整個消失」——看起來像閃退，
  // 而且因為功能有生效，很容易被當成單純的視覺問題放過去。
  if(add)add.addEventListener('click',function(e){
    e.stopPropagation();
    if(!foodAddHandler)return;
    var rec=popup._source&&popup._source._rec;
    foodAddHandler(add.getAttribute('data-food-add'),function(){
      // ⚠️ **問彈窗自己在哪張地圖上，不要問 restaurantMap**（單位 く）：
      // 疊圖那張跑的是同一支接線，寫死的話那裡按「加進行程」永遠 early return，
      // **行程真的加到了但彈窗不會翻成「✓」**——看起來像按鈕壞了。
      if(!popup._map)return;                                      // 使用者已經關掉了
      popup.setContent(restaurantPopupHTML(rec,rec&&rec.geo==='approx'));
      wireRestaurantPopup(popup);
    });
  });
}
function makeRestaurantMarkerLayer(markers){
  if(typeof L.markerClusterGroup==='function'){
    var layer=L.markerClusterGroup({
      maxClusterRadius:50,showCoverageOnHover:false,spiderfyOnMaxZoom:true,
      // 餐廳只有 99 個可定位點，一次 addLayers 足夠快；每次篩選換一個新群組，
      // 避免已開啟 popup 的舊群組在 clearLayers 後留下第三方元件內部狀態。
      iconCreateFunction:restaurantClusterIcon
    });
    layer.addLayers(markers);
    return layer;
  }
  return L.layerGroup(markers);
}
function filteredRestaurants(){
  return restaurants.filter(function(r){
    if(favOnly&&!isFavFood(r.id))return false;
    return geoMatch(r,geoSel)&&genreOk(r);
  });
}
// 目前地理選擇底下的餐廳（不含類別）——類別 chip 的筆數與圖例以它為母體。
function inArea(){
  return restaurants.filter(function(r){return geoMatch(r,geoSel);});
}
// 反過來：只套類別、不套地理——地區 chip 的筆數以它為母體，
// ⚠️ **否則選了東京之後其他每個地區都會顯示 0**，看起來像那些地區沒有資料。
function inGenre(){
  return restaurants.filter(genreOk);
}
// 「只看收藏」（單位 K）。⚠️ **一家都沒收藏時整顆不出現**——按了會得到一張空地圖，
// 而空地圖看起來就像壞了。但**開著的時候一定顯示**（就算剛好取消到 0 家），
// 否則那顆鈕會連同它自己的開關狀態一起消失，使用者沒有回路把它關掉。
function syncFavOnlyChip(){
  if(!favOnlyBtn)return;
  var show=favOnly||favFoodCount()>0;
  favOnlyBtn.hidden=!show;
  favOnlyBtn.textContent=t().restaurantFavOnly;
  favOnlyBtn.classList.toggle('on',favOnly);
}
// ⚠️ 2026-09-03 起吃一個母體參數，兩個呼叫端都傳「目前地區底下的餐廳」：
//    類別下拉不該列出這個地區一家都沒有的類別（點下去是空地圖），
//    而圖例要描述的是**地圖上實際看得到的東西**。不傳＝全部，行為與以前相同。
function presentGenres(pool){
  var seen={},out=[];
  (pool||restaurants).forEach(function(r){
    if(r.genre&&!seen[r.genre]){seen[r.genre]=1;out.push(r.genre);}
  });
  return out;
}
function buildRestaurantLegend(){
  // 圖例列出目前資料裡實際存在的類別，各自一個色點；最後兩行仍是精確／概略。
  // 只剩一個類別時不必列類別（那時顏色不帶資訊量）。
  var genres=presentGenres(inArea()).filter(function(g){return !genreActive()||genreSel[g];});
  var multi=genres.length>1;
  // 色塊裡放與圖釘同一個圖示。**圖例是唯一能查「這個圖案是什麼」的地方**，
  // 地圖上有圖示而圖例沒有，等於給了一個沒有對照表的符號。
  var rows=multi?genres.map(function(g){
    return '<div><span class="dot" style="background:'+pinColor(g)+'">'
      +genreIconHTML(g,LEGEND_ICON)+'</span>'
      +esc(store.lang==='ja'?genreJaOf(g):g)+'</div>';
  }).join(''):'';
  // **類別那段收合起來**（2026-08-14）。8 個類別時圖例是 10 行約 226px，手機上吃掉
  // 三分之一的地圖，而類別只會愈加愈多（接米其林後上看十幾個）。收起來只剩三行，
  // **不管日後幾個類別，收合高度都一樣**。展開另有 max-height 上限，超過就內部捲動。
  // 精確／概略那兩行留在外面常駐——它們是每次看地圖都用得到的，且永遠只有兩行。
  var html=multi
    ? '<details class="legend-genres"'+(legendOpen?' open':'')+'>'
        +'<summary>'+esc(t().restaurantGenre)+' '+genres.length+'</summary>'
        +'<div class="legend-rows">'+rows+'</div></details>'
    : '';
  // 多類別時，精確／概略那兩行改用中性墨色——沿用某個類別的顏色會與上面的類別色點
  // 長得一模一樣，讀起來像「精確位置＝燒肉」。只有一個類別時才用它自己的顏色。
  var c=multi?cssVar('--ink-2'):pinColor(genres.length===1?genres[0]:'燒肉');
  html+='<div><span class="dot" style="background:'+c+'"></span>'+esc(t().restaurantPrecise)+'</div>'
    +'<div><span class="dot approx" style="background:'+c+'"></span>'+esc(t().approx)+'</div>';
  var box=document.getElementById('restaurantLegend');
  box.innerHTML=html;
  // **每次重畫都要重接監聽器**：innerHTML 換掉整個節點，舊的跟著沒了
  //（與彈窗那個 <details> 同一個坑）。`toggle` 事件不會冒泡，所以委派在容器上沒有用。
  // 記住展開狀態的理由：切換類別／據點都會重畫圖例，不記的話使用者開著的它會自己合起來。
  var fold=box.querySelector('details.legend-genres');
  if(fold)fold.addEventListener('toggle',function(){legendOpen=fold.open;});
}
// 疊圖模式（單位 く）的重畫掛勾，由 main.js 注入。方向是 mapall → restaurants。
var allRepaint=null;
function setRestaurantsAllRepaint(fn){allRepaint=fn;}

// 目前篩選底下的餐廳圖釘。⚠️⚠️ **疊圖模式與這張地圖共用同一份**（抽出來不是複製）。
// ⚠️ 呼叫端要自己確定 `_map.json` 已經載好了——這一支不會去載，它只是把現有的資料變成圖釘。
function restaurantMarkers(){
  var out=[];
  filteredRestaurants().forEach(function(r){
    if(typeof r.lat!=='number'||typeof r.lng!=='number'||!r.geo)return;
    var approx=r.geo==='approx';
    var marker=L.marker([r.lat,r.lng],{icon:restaurantPinIcon(r,approx)});
    // **內容傳函式而不是字串**：Leaflet 只在開啟時才呼叫它。
    // 2000 個圖釘若在建立時就組好 HTML，光那件事就要幾百毫秒。
    marker.bindPopup(function(){return restaurantPopupHTML(r,approx);},
                     {minWidth:252,maxWidth:272});
    marker._rec=r;
    marker._kind='rs';
    out.push(marker);
  });
  return out;
}

function renderRestaurantMap(){
  initRestaurantMap();
  if(restaurantMarkerLayer)restaurantMap.removeLayer(restaurantMarkerLayer);
  var markers=restaurantMarkers();
  var pts=markers.map(function(m){var ll=m.getLatLng();return [ll.lat,ll.lng];});
  // 叢集用 addLayers 批次加入；fallback 也用 layerGroup(markers)，不逐顆 addLayer。
  restaurantMarkerLayer=makeRestaurantMarkerLayer(markers);
  restaurantMarkerLayer.addTo(restaurantMap);
  // ⚠️ **一律只印一個數字，而且是「地圖上真的有幾家」**（單位 き-1，2026-09-09）。
  // 舊版在 mapped < total 時印「地圖上 4894 家・共 4895 家」，那是三張地圖裡唯一誠實的
  // 寫法，但也是唯一長這樣的——**使用者 2026-09-09 明確同意「那間沒有座標的餐廳消失沒問題」**，
  // 三張因此統一成同一個口徑：這張地圖上有幾個。
  // 📌 順帶解掉一個既有風險：舊的那一行 145.7px，而右上角放了切換器之後那一格只剩 122px，
  // **它會折成兩行、把頂欄撐高 17px**，於是切換地圖的瞬間下面的地圖會上下跳。
  // 現在不論資料怎麼變都只有一個數字，那個風險從此不存在。
  // ⚠️ 清單模式那一行（syncRestaurantUi）仍然印 `list.length`，那是對的：
  // 沒有座標的店在清單上看得到，兩種模式印不同的數字各自都誠實。
  document.getElementById('restaurantSub').textContent=t().restaurantCount(pts.length);
  buildRestaurantLegend();
  // **先 invalidateSize 再 fitBounds**：面板剛顯示時容器尺寸還是 0×0，
  // 在那之前算 bounds 會退回最小縮放——實測開場看到的是整個關東而不是東京。
  // 60ms 後再做一次，因為覆蓋層的過場動畫可能讓第一次仍量到舊尺寸。
  // ⚠️⚠️ keep 在這裡取一次，**不可以放進 fitRestaurantView 裡面**——它會被呼叫兩次
  // （見 places.js 同一處的說明）。**只有真的有點時才消費**：餐廳的 _map.json 是按需載入的，
  // 開場那一次 pts 本來就是空的，在那時消費掉等於整件事白做。
  var keep=pts.length?takeMapView():null;
  function fitRestaurantView(){
    restaurantMap.invalidateSize();
    // 從另一張地圖切過來時沿用它的視野（單位 き-2）。⚠️ early return，同下面那條。
    if(keep){restaurantMap.setView([keep.lat,keep.lng],keep.z,{animate:false});return;}
    // 開場視野：`fitBounds` 散得太開時改用「我的位置」（單位 Y-4，共用一份）。
    // ⚠️⚠️ **「沒有點」那條要先 return，不可以掛成 `else`**——見 `places.js` 同一處的說明
    // （`fitFromMyLoc` 回 true 會掉進那個 else，剛設好的視野被初始值蓋回去）。
    if(!pts.length){restaurantMap.setView([35.68,139.75],11);return;}
    if(!fitFromMyLoc(restaurantMap,pts,[36,36]))
      restaurantMap.fitBounds(pts,{padding:[36,36],maxZoom:14});
  }
  fitRestaurantView();
  setTimeout(fitRestaurantView,60);
}

// ===== 瀑布流清單 =====
function restaurantCardHTML(r){
  var media=r.img
    ? '<img src="'+esc(proxied(r.img))+'" alt="" loading="lazy" referrerpolicy="no-referrer"'
      +' data-restaurant-img data-label="'+esc(genreLabel(r))+'"'
      // 破圖時要換成替代面板，而那個面板得知道自己是什麼類別的顏色。
      // **顏色跟著記錄走、不寫在 CSS 裡**（寫死會讓新類別全部畫成第一個類別的色）。
      +' data-color="'+esc(typeColor(r.genre))+'">'
    : '<div class="block" style="color:'+typeColor(r.genre)+'">'+esc(genreLabel(r))+'</div>';
  return '<article class="restaurant-card">'
    +'<div class="ph restaurant-ph">'+media+'</div>'
    +'<div class="restaurant-card-body">'
      +'<div class="restaurant-card-meta">'
        +'<span style="color:'+typeColor(r.genre)+'">'+esc(genreLabel(r))+'</span>'
        +'<span>'+esc(spotLabel(r.spot))+'</span></div>'
      +'<h2>'+esc(r.name_ja)+'</h2>'
      +'<div class="restaurant-budget"><span>'+esc(t().restaurantBudget)+'</span> '
        +esc(budgetValue(r))+'</div>'
      +hoursHTML(r)
      +'<div class="restaurant-awards">'+awardsHTML(r)+'</div>'
      +'<a class="restaurant-gmap" href="'+esc(googleMapUrl(r))+'" target="_blank" rel="noopener">'
        +esc(t().aGmap)+' →</a>'
    +'</div></article>';
}
function showRestaurantBlock(img){
  var ph=img.parentNode;if(!ph)return;
  ph.style.aspectRatio='1.39';
  var d=document.createElement('div');
  d.className='block';d.textContent=img.getAttribute('data-label')||'';
  d.style.color=img.getAttribute('data-color')||'';
  ph.replaceChild(d,img);
}
function wireRestaurantImage(img){
  var done=false;
  function fail(){if(done)return;done=true;showRestaurantBlock(img);}
  function ok(){
    if(done)return;done=true;
    var w=img.naturalWidth,h=img.naturalHeight;
    if(w&&Math.max(w,h)<200){showRestaurantBlock(img);return;}
    if(!w||!h)return;
    var ratio=Math.min(Math.max(h/w,AR_MIN),AR_MAX);
    if(img.parentNode)img.parentNode.style.aspectRatio=(1/ratio).toFixed(4);
  }
  img.addEventListener('load',ok);img.addEventListener('error',fail);
  if(img.complete){if(img.naturalWidth)ok();else fail();}
}
function restaurantColCount(){
  var box=document.getElementById('restaurantCards');
  var w=box?box.getBoundingClientRect().width:window.innerWidth;
  if(w>=1180)return 5;if(w>=760)return 4;if(w>=460)return 3;return 2;
}
function renderRestaurantList(){
  var list=filteredRestaurants();
  // 清單要顯示預算、營業時間、徽章，全都在詳細檔裡。**先載齊再畫**，
  // 否則會先畫一輪空卡片再重畫，視覺上像閃一下。篩了類別就只載那一個檔。
  if(list.some(function(r){return !r._full;})){
    loading=true;syncRestaurantUi();
    ensureDetail(list).then(function(){
      loading=false;syncRestaurantUi();
      if(viewMode==='list')renderRestaurantList();
    }).catch(function(){
      loading=false;loadError=true;syncRestaurantUi();
    });
    return;
  }
  var n=restaurantColCount(),cols=[];
  listCols=n;
  for(var i=0;i<n;i++)cols.push([]);
  list.forEach(function(r,idx){cols[idx%n].push(restaurantCardHTML(r));});
  var box=document.getElementById('restaurantCards');
  box.innerHTML=cols.map(function(col){
    return '<div class="restaurant-col">'+col.join('')+'</div>';
  }).join('');
  var imgs=box.querySelectorAll('img[data-restaurant-img]');
  for(var j=0;j<imgs.length;j++)wireRestaurantImage(imgs[j]);
  document.getElementById('restaurantEmpty').style.display=list.length?'none':'block';
  document.getElementById('restaurantSub').textContent=t().restaurantCount(list.length);
}

// ===== 介面與延遲載入 =====
function orderedSpots(pool){
  var present={};
  (pool||restaurants).forEach(function(r){if(r.spot)present[r.spot]=1;});
  var out=Object.keys(SPOTS).filter(function(v){return present[v];});
  Object.keys(present).forEach(function(v){
    if(v!==OTHER_SPOT&&!Object.prototype.hasOwnProperty.call(SPOTS,v))out.push(v);
  });
  out.sort(function(a,b){
    var ai=Object.keys(SPOTS).indexOf(a),bi=Object.keys(SPOTS).indexOf(b);
    if(ai>-1&&bi>-1)return ai-bi;if(ai>-1)return -1;if(bi>-1)return 1;
    return a.localeCompare(b,'zh-Hant');
  });
  if(present[OTHER_SPOT])out.push(OTHER_SPOT);
  return out;
}
// ===== 篩選彈窗（2026-09-03 第二輪）=====
// ⚠️ **兩邊的筆數母體是相反的**：地區 chip 扣掉類別、類別 chip 扣掉地理。
//    都扣的話「已經選中的那一個」以外全部顯示 0（因為兩個條件互斥），
//    看起來像那些地區沒有資料——而它只是被自己這一次的選擇算掉了。
//    ⚠️ 兩者都**不扣「只看收藏」**：那是暫時的檢視狀態，讓它改寫每一格數字會讓人以為資料變少。
function areaCountMap(){
  var m={};
  inGenre().forEach(function(r){if(r.area)m[r.area]=(m[r.area]||0)+1;});
  return m;
}
// 某個桶底下的據點與筆數，照 SPOTS 的表序、「其他」永遠排最後。
// ⚠️ 這裡要**扣掉類別但不扣地理**中「別的桶」的影響——所以直接從這個桶自己的資料算。
function spotsOf(a){
  var pool=inGenre().filter(function(r){return r.area===a;});
  return orderedSpots(pool).map(function(v){
    return [v,pool.filter(function(r){return r.spot===v;}).length];
  });
}
function buildFilterSheet(){
  var counts=areaCountMap();
  rfArea.innerHTML=geoChipsHTML({
    sel:geoSel,
    count:function(a){return counts[a]||0;},
    spots:spotsOf
  });
  // 類別：母體是目前的地理選擇，不然選了福岡還會看到「壽司 · 386」那種全國數字。
  var pool=inArea();
  var seen={},order=[];
  pool.forEach(function(r){if(r.genre&&!seen[r.genre]){seen[r.genre]=1;order.push(r.genre);}});
  rfGenre.innerHTML=order.map(function(g){
    var n=pool.filter(function(r){return r.genre===g;}).length;
    var label=store.lang==='ja'?genreJaOf(g):g;
    // 色塊：**與地圖圖例同一個顏色來源**（`pinColor` 讀 `--pin-<類別>`，
    // 那是給地圖辨識度用的那一組，不是文字用的 `--c-*`——地雷 #7）。
    // ⚠️ 用 `.sq` 這個既有 class，活動頁的分類列早就在用同一套（6px 方塊接在名字前面），
    //    所以 CSS 一行都不必新增，兩處也不會漂移。
    // ⚠️ **色塊不跟著選中與否改變**：它說的是「這一類在地圖上長什麼顏色」，
    //    不是「選了沒」——選中與否照舊由文字與底線表達。
    // ⚠️ 這是 JS 產生的顏色字串，**不會跟著 CSS 變數自動更新**（地雷 #7）；
    //    晝夜切換時靠 `refreshRestaurants()` → `syncRestaurantUi()` → 這裡重畫。
    return '<button type="button" class="side-chip'+(genreSel[g]?' on':'')+'"'
      +' data-genre="'+esc(g)+'">'
      +'<span class="sq" style="background:'+pinColor(g)+'"></span>'
      +'<span>'+esc(label)+'</span>'
      +'<span class="cnt">'+n+'</span></button>';
  }).join('');
  document.getElementById('rfDone').textContent=t().showN(filteredRestaurants().length);
}
// 工具列那顆鈕上的數字。**算「幾個條件」不是「選了幾項」**（沿用活動頁 activeCount()）：
// 選了 5 個地區顯示 5 的話，讀起來像「篩掉很多」而不是「開了幾個條件」。
// ⚠️ 0 的時候整顆數字 hidden——`.cnt` 沒有自己的 display，所以瀏覽器預設的
//    `[hidden]{display:none}` 在這裡是有效的（不像 .side-chip 那幾個要自己補）。
function syncFilterBtn(){
  var n=restaurantFilterCount();
  document.getElementById('restaurantFilterLabel').textContent=t().filter;
  rfCount.textContent=n;
  rfCount.hidden=!n;
}
// 「清單／地圖」的膠囊分段（2026-08-28，原本是一顆寫著「點了會變成什麼」的鈕）。
// ⚠️ **語意跟著形狀翻面了**：膠囊寫的是「現在在看哪一個」，永遠有一格是亮的
//    ——那正是 CLAUDE.md 地雷 #26 挑這個語彙的條件（2 段、段數固定、標籤短、必有一格選中）。
// ⚠️ **外觀共用 `.mapswitch` 那份 CSS**（選擇器並列），但**沒有圖示**，
//    所以它不吃那兩條窄螢幕的 media query，見 css 那段註解。
// ⚠️ 監聽器**掛在容器上做委派**，不是掛在每一格：這裡每次 syncRestaurantUi() 都會重畫
//    `innerHTML`，掛在格子上就得記得每次重接（buildLegend／mapswitch 都踩過那條）。
//    容器本身從頭到尾是同一個節點，委派因此一次綁定就夠。
function buildViewSwitch(){
  if(!restaurantSwitch)return;
  restaurantSwitch.setAttribute('role','group');
  restaurantSwitch.setAttribute('aria-label',t().aViewSwitch);
  restaurantSwitch.innerHTML=[['list',t().restaurantList],['map',t().restaurantMap]]
    .map(function(m){
      var on=viewMode===m[0];
      return '<button type="button" class="viewswitch-seg'+(on?' on':'')+'"'
        +' data-mode="'+m[0]+'"'+(on?' aria-current="true"':'')+'>'+esc(m[1])+'</button>';
    }).join('');
}
function syncRestaurantUi(){
  tabRestaurant.setAttribute('aria-label',t().aRestaurant);
  document.getElementById('restaurantClose').setAttribute('aria-label',t().aRestaurantClose);
  document.getElementById('restaurantTitle').textContent=t().restaurantTitle;
  document.getElementById('rfTitle').textContent=t().filterTitle;
  document.getElementById('rfAreaH').textContent=t().area;
  document.getElementById('rfGenreH').textContent=t().restaurantGenre;
  document.getElementById('rfClear').textContent=t().clearFilter;
  buildViewSwitch();
  document.getElementById('restaurantEmpty').textContent=t().restaurantEmpty;
  if(loaded)buildFilterSheet();
  syncFilterBtn();syncFavOnlyChip();
  restaurantStatus.textContent=loadError?t().restaurantLoadFail:t().restaurantLoading;
  restaurantStatus.classList.toggle('show',loading||loadError);
}
function setViewMode(mode){
  // 清單關掉時一律鎖在地圖。切換鈕已經藏起來（見下方初始化），這裡是第二道
  // ——日後若有別的路徑呼叫 setViewMode('list')，不必記得也不會漏。
  if(!RESTAURANT_LIST)mode='map';
  viewMode=mode;
  var listMode=mode==='list';
  restaurantView.classList.toggle('list-mode',listMode);
  restaurantMapPanel.setAttribute('aria-hidden',listMode?'true':'false');
  restaurantListPanel.setAttribute('aria-hidden',listMode?'false':'true');
  syncRestaurantUi();
  if(!loaded)return;
  if(listMode)renderRestaurantList();else renderRestaurantMap();
}
// ===== 兩層載入 =====
// 第一層：_map.json（索引）。開分頁就抓，地圖與兩個下拉靠它就能畫。
// 第二層：各榜單檔（詳細）。點開彈窗或切到清單時才按需載入。
// **跨年度同店的合併已經在管線裡做完**（build_restaurants.py 的 dedupe），
// 前端不再自己 merge——2000 家時在瀏覽器裡做那件事太貴，而且管線做得到更好
// （它有 GSI 驗證過的座標可以挑）。

function expandSlim(s,i){
  // 索引用單字母縮寫省空間，這裡展開成與詳細檔一致的欄位名，
  // 這樣所有算繪函式不必分兩套，只是在 `_full` 之前少幾個欄位可顯示。
  return {id:s.id,name_ja:s.n,genre:s.g,genre_ja:genreJaOf(s.g),
          area:s.a,spot:s.s,lat:s.lat,lng:s.lng,geo:s.geo,
          awards:slimAwards(s.w),
          _f:s.f||0,_full:false};
}
// `w` 是榜單字典的編號陣列（2026-08-26）。展開成與詳細檔**同一個形狀**，
// 這樣 `awardsHTML()` 一個字都不必改，行程頁的候選清單也不必自己寫第二套規則。
// ⚠️ **字典裡沒有 `url`**（徽章不是連結，`awardsHTML` 從來沒用過它）——
// 少了它就少一個「兩個地方各存一份」的機會。詳細檔到齊時 `loadDetailFile()`
// 會用完整的 awards 就地覆蓋掉這一份，那時 url 自然就有了。
function slimAwards(w){
  if(!(w instanceof Array))return [];
  return w.map(function(i){
    var a=awardDict[i];
    return a?{guide:a[0],tier:a[1],year:a[2]}:null;
  }).filter(Boolean);
}
function ensureRestaurants(){
  if(loaded)return Promise.resolve(restaurants);
  if(loadPromise)return loadPromise;
  loading=true;loadError=false;syncRestaurantUi();
  var bust='?t='+Date.now();
  loadPromise=fetch('restaurants/_map.json'+bust)
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
    .then(function(idx){
      detailFiles=idx.files||[];
      genreMeta=idx.genres||[];
      // ⚠️ **一定要在 expandSlim 之前指派**：那個函式當場就要拿它查表，
      // 晚一行的話展開出來的 awards 會全是空陣列——而畫面上只是「徽章沒出現」，
      // 不會有任何錯誤訊息。
      awardDict=idx.awards||[];
      restaurants=(idx.restaurants||[]).map(expandSlim);
      loaded=true;loading=false;loadError=false;
      // 收藏的餐廳（單位 K）：**索引一到就順手刷新那份隨身備份**。
      // ⚠️ 沒有這一行的話，備份只有在「行程頁載過餐廳」時才會更新
      // （那條路填的是 `store.restaurants`），而餐廳分頁明明已經把同一份資料抓下來了。
      // 它同時也是「這家店還在不在榜單上」的唯一依據——沒餵它就永遠不敢說話。
      syncFavFood(restaurants);
      syncRestaurantUi();
      if(restaurantView.classList.contains('show'))setViewMode(viewMode);
      return restaurants;
    })
    .catch(function(err){
      loading=false;loadError=true;loadPromise=null;syncRestaurantUi();
      throw err;
    });
  return loadPromise;
}
function loadDetailFile(i){
  if(filePromise[i])return filePromise[i];
  var name=detailFiles[i];
  if(!name)return Promise.resolve();
  var byId={};
  restaurants.forEach(function(r){byId[r.id]=r;});
  filePromise[i]=fetch('restaurants/'+name+'?t='+Date.now())
    .then(function(r){if(!r.ok)throw new Error(name+' HTTP '+r.status);return r.json();})
    .then(function(d){
      (d.restaurants||[]).forEach(function(rec){
        var cur=byId[rec.id];
        // 就地補欄位而不是換掉物件——地圖的 marker 已經抓著舊參考了。
        if(cur){for(var k in rec)if(k!=='id')cur[k]=rec[k];cur._full=true;}
      });
    })
    .catch(function(err){
      filePromise[i]=null;      // 失敗不要卡住，下次還能重試
      throw err;
    });
  return filePromise[i];
}
function ensureDetail(recs){
  // 只載這批記錄真正需要的檔。全部類別的清單會載齊，篩了類別就只載一個。
  var need={};
  recs.forEach(function(r){if(!r._full)need[r._f]=1;});
  var idx=Object.keys(need);
  if(!idx.length)return Promise.resolve();
  return Promise.all(idx.map(function(i){return loadDetailFile(+i);}));
}
function setActiveTab(id){
  var tabs=document.querySelectorAll('.tabbar .tab');
  for(var i=0;i<tabs.length;i++)tabs[i].classList.toggle('on',tabs[i].id===id);
}
function openRestaurants(){
  var active=document.querySelector('.tabbar .tab.on');
  previousTab=active&&active.id!=='tabRestaurant'?active.id:(store.state.view==='fav'?'tabFav':'tabAll');
  // 切換到另一張地圖時**不可以重存**：那時卡片是藏起來的、頁面高度為 0，
  // 存到的會是 0，最後關掉就回到清單最頂端而不是原來看的位置（見 store.mapSwitching）。
  if(!store.mapSwitching){
    store.overlayScroll=window.scrollY||window.pageYOffset||0;
    store.mapView=null;   // 不是切換過來的＝全新開場，丟掉殘留的視野（單位 き-2）
  }
  viewMode='map';
  setActiveTab('tabRestaurant');
  document.body.classList.add('restaurant-open');
  restaurantView.classList.add('show');
  document.getElementById('restaurantSub').textContent=t().restaurantLoading;
  setViewMode('map');
  requestAnimationFrame(function(){
    initRestaurantMap();restaurantMap.invalidateSize();
  });
  ensureRestaurants().catch(function(){});
}
function closeRestaurants(){
  keepMapView(restaurantMap);   // 把現在看的位置交給下一張地圖（單位 き-2）
  restaurantView.classList.remove('show');
  document.body.classList.remove('restaurant-open');
  setActiveTab(previousTab||'tabAll');
  // 切換到另一張地圖時不還原（下一張馬上就會蓋上來，還原只會白跑一次；
  // 真正該還原的是最後那一次關閉）。
  if(!store.mapSwitching)requestAnimationFrame(function(){window.scrollTo(0,store.overlayScroll);});
}
function refreshRestaurants(){
  syncRestaurantUi();
  // ⚠️ 疊圖那張也要跟著換語言／換配色（同 refreshPlaces 那條）。
  if(allRepaint)allRepaint();
  if(loaded&&restaurantView.classList.contains('show')){
    if(viewMode==='map')renderRestaurantMap();else renderRestaurantList();
  }
}

tabRestaurant.addEventListener('click',openRestaurants);
document.getElementById('restaurantClose').addEventListener('click',closeRestaurants);
// 清單關掉時把切換器整個藏起來。用 `hidden` 而不是 CSS 的 display:none，
// 是為了讓「為什麼沒有清單」grep 得到 RESTAURANT_LIST 就找得到答案。
// ⚠️ 它現在是 `display:flex` 的 `<div>`，所以 CSS 那邊配了一條 `.viewswitch[hidden]`
//    ——少了那條，`hidden` 會被 flex 蓋過去，關掉的清單鈕照樣出現在畫面上。
restaurantSwitch.hidden=!RESTAURANT_LIST;
// 委派：容器不會被重畫，所以一次綁定就夠（格子每次 syncRestaurantUi() 都會換掉）。
// 點到已經亮著的那一格什麼都不做——同 mapswitch 的 `cur.k===k`。
restaurantSwitch.addEventListener('click',function(e){
  var seg=e.target.closest('.viewswitch-seg');
  if(!seg)return;
  var mode=seg.getAttribute('data-mode');
  if(mode!==viewMode)setViewMode(mode);
});
// ===== 篩選彈窗的接線（2026-09-03）=====
// ⚠️ 三個監聽器**全部委派在容器上**：chip 每次重畫都整個換掉，掛在 chip 上一重畫就失效。
// ⚠️ 與上面那個 sync 共用同一條算式（同 places.js 的 placesFilterCount）。
// ⚠️ **「只看收藏」刻意不算進去**：它有自己一顆看得見的鈕，而這個數字要對應的是
// 篩選彈窗裡的東西——把它算進來會出現「鈕上寫 1 個條件，打開彈窗卻什麼都沒選」。
function restaurantFilterCount(){return (geoActive(geoSel)?1:0)+(genreActive()?1:0);}
function openRestaurantFilter(){buildFilterSheet();rfView.hidden=false;}
function closeRestaurantFilter(){rfView.hidden=true;}
// 篩選（含「只看收藏」）改動之後要做的事。⚠️ **四個呼叫點一律走這一支**：
// 疊圖模式（單位 く）也吃餐廳這一份篩選，漏掉任何一個呼叫點的症狀都是
// 「在疊圖上改了條件，關掉彈窗發現地圖沒跟上」——而餐廳頁自己看起來完全正常。
function afterRestaurantFilterChange(){
  // ⚠️⚠️ **餐廳頁沒開就不可以呼叫 setViewMode**（單位 く 加的守門）：它會去畫一張
  // 看不見的地圖，而 `renderRestaurantMap()` 裡有一行 `takeMapView()`——那是**會消費掉的**
  // （單位 き-2），於是疊圖那張要用的視野被一張沒人看得到的地圖吃掉，
  // **症狀是「切過去之後視野莫名其妙跳回全日本」**，而餐廳頁自己完全正常。
  if(restaurantView.classList.contains('show'))setViewMode(viewMode);
  else syncRestaurantUi();     // 彈窗上那顆「顯示 N 筆」仍然要即時更新
  if(allRepaint)allRepaint();
}
rfBtn.addEventListener('click',openRestaurantFilter);
// 點遮罩收起來（同活動頁彈窗的行為）。
rfView.addEventListener('click',function(e){if(e.target===rfView)closeRestaurantFilter();});
rfArea.addEventListener('click',function(e){
  if(!handleGeoClick(e,geoSel))return;
  // ⚠️ **彈窗開著時也要重畫地圖**：那顆「顯示 N 筆」是唯一的即時回饋，
  //    而它的數字來自 filteredRestaurants()——只重畫彈窗的話數字會對，
  //    但關掉彈窗才發現地圖沒跟上。走 setViewMode 一次做完兩件事。
  afterRestaurantFilterChange();
});
rfGenre.addEventListener('click',function(e){
  var b=e.target.closest?e.target.closest('.side-chip'):null;
  if(!b)return;
  var g=b.getAttribute('data-genre');
  if(!g)return;
  if(genreSel[g])delete genreSel[g];else genreSel[g]=1;
  afterRestaurantFilterChange();
});
document.getElementById('rfDone').addEventListener('click',closeRestaurantFilter);
document.getElementById('rfClear').addEventListener('click',function(){
  clearGeo(geoSel);genreSel={};
  afterRestaurantFilterChange();
});
// 「只看收藏」（單位 K）。切換之後走與另外兩個篩選同一條路（setViewMode 會重畫）。
if(favOnlyBtn)favOnlyBtn.addEventListener('click',function(){
  favOnly=!favOnly;afterRestaurantFilterChange();
});
// ⚠️ 舊版在這裡有一段「換類別後把選不中的據點清掉」的守門，**多選之後不需要了**：
//    據點 chip 是**畫出來才點得到**的，而 buildFilterSheet() 每次都依當下的類別重算，
//    選不中的據點根本不會出現在畫面上。留著反而會在多選時清掉使用者還想要的據點。

var restaurantResizeTimer;
window.addEventListener('resize',function(){
  clearTimeout(restaurantResizeTimer);
  restaurantResizeTimer=setTimeout(function(){
    if(!restaurantView.classList.contains('show'))return;
    if(viewMode==='map'&&restaurantMap)restaurantMap.invalidateSize();
    else if(viewMode==='list'&&restaurantColCount()!==listCols)renderRestaurantList();
  },160);
});

// `ensureRestaurants` 與 `restaurantRecords` 給 plan-food 用。
// ⚠️ **不要另寫一份 `_map.json` 載入器**：這裡已經有第一層載入與 promise 快取
//（載過不再載、失敗可重試），複製一份等於同一份資料兩個載入器
// ——`SPOTS` 在兩支管線各一份就吃過這個虧，而漏改的症狀是兩邊看到不同的店。
// openRestaurants／closeRestaurants 對外開放是給 mapswitch.js 用的（2026-08-27）：
// 三張地圖之間的切換就是「關掉這張、打開那張」。**方向是 mapswitch → restaurants**，
// 這個模組完全不知道切換器的存在（同 map.js 對 tour 的關係）。
export { closeRestaurants, ensureRestaurants, openRestaurantFilter, openRestaurants, refreshRestaurants,
         restaurantFilterCount, restaurantMarkers, restaurantRecords, setFoodAddHandler,
         setRestaurantsAllRepaint, wireRestaurantPopup };
function restaurantRecords(){return restaurants;}
