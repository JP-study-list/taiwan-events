// 全站地圖（地圖頁）。行程頁自己的小地圖在 plan-ui.js。
import { IMG_W_THUMB, TYPES } from './config.js';
import { typeIconHTML } from './icons.js';
import { keepMapView, store, takeMapView } from './store.js';
import { areaLabel, esc, fld, fmtDate, imgChain, match, pinColor, t, typeLabel } from './util.js';
import { fitFromMyLoc } from './mylocation.js';

// ===== 地圖 =====
var map=null,markerLayer=null;
// 與 restaurants.js 同一組數值（圖釘 26／圖釘內 14／圖例內 10）。**兩張地圖刻意一致**，
// 使用者在兩個分頁之間切換時，圖釘大小不一樣會看起來像兩個不同的網站。
var PIN_SIZE=26, PIN_ICON=14, LEGEND_ICON=10;

// 叢集圓圈。大小隨數量分三段，數字愈多圈愈大，一眼看得出哪裡熱鬧。
function clusterIcon(cluster){
  var n=cluster.getChildCount();
  var size=n<10?32:(n<100?38:44);
  return L.divIcon({
    className:'',
    html:'<div class="cl" style="width:'+size+'px;height:'+size+'px">'+n+'</div>',
    iconSize:[size,size],iconAnchor:[size/2,size/2]
  });
}

function initMap(){
  if(map)return;
  map=L.map('map',{zoomControl:true}).setView([35.55,139.65],10);
  // 圖磚維持 OSM；深色模式在 CSS 對 .leaflet-tile-pane 套濾鏡轉深，
  // 不換圖磚服務（不新增外部依賴，也不必處理另一家的使用條款與標示要求）。
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:18,attribution:'© OpenStreetMap'
  }).addTo(map);
  // 叢集群組。664 個圖釘全部畫出來時，中階手機拖曳只有 17fps（實測），
  // 而且其中 273 個是完全疊在別人底下、永遠點不到的。叢集同時解掉這兩件事。
  // **markercluster 載不到時自動退回原本的 layerGroup**，地圖不會整個壞掉。
  markerLayer=(typeof L.markerClusterGroup==='function')
    ? L.markerClusterGroup({
        maxClusterRadius:50,        // 預設 80 太黏，50 讓圖釘早一點散開
        showCoverageOnHover:false,  // 預設會畫出涵蓋範圍多邊形，在滿版彩色圖磚上太吵
        spiderfyOnMaxZoom:true,     // 放到最大仍重疊時展成一圈——宇都宮那 48 個靠這個才點得到
        chunkedLoading:true,        // 分批加入，避免一次塞完卡住主執行緒
        iconCreateFunction:clusterIcon
      })
    : L.layerGroup();
  markerLayer.addTo(map);
  // 彈窗的圖片是點開才建立的，所以只在這裡綁一次，不必為 664 個圖釘各綁一份。
  map.on('popupopen',function(e){wireEventPopup(e.popup);});
}

// 圖釘 2026-08-14 由 20px 放大到 26px 並放進分類圖示（使用者要求）。
// **20px 塞不下**：扣掉白邊只剩約 11px，底片（動漫）與店面（市集）那種細節會糊成一團。
// 尺寸與錨點三個值要一起改，少改一個圖釘就會偏離它指的座標。
function pinIcon(type,approx){
  return L.divIcon({
    className:'',
    html:'<div class="pin event-pin'+(approx?' approx':'')+'" style="background:'+pinColor(type)+'">'
      +typeIconHTML(type,PIN_ICON)+'</div>',
    iconSize:[PIN_SIZE,PIN_SIZE],iconAnchor:[PIN_SIZE/2,PIN_SIZE],popupAnchor:[0,-PIN_SIZE+2]
  });
}

// 彈窗縮圖的退場：候選網址逐一嘗試，全部失敗才換成分類色塊。
// **刻意不與 cards.js 的 wireImage 共用**——那個還要依照片實際比例改寫卡高（.ph 的
// aspect-ratio），而彈窗縮圖是固定的正方形，共用等於把不需要的邏輯也帶進來。
function wirePopupImg(img){
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
    var ty=img.getAttribute('data-type')||'';
    var d=document.createElement('div');
    d.className='pth pth-block';
    d.style.color='var(--c-'+ty+')';
    d.textContent=typeLabel(ty);
    if(img.parentNode)img.parentNode.replaceChild(d,img);
  }
  function ok(){
    if(settled)return;
    // 長邊 <200px 多半是網站 logo 而非活動照片（與卡片同一條門檻）
    if(img.naturalWidth&&Math.max(img.naturalWidth,img.naturalHeight)<200){fail();return;}
    settled=true;
  }
  img.addEventListener('load',ok);
  img.addEventListener('error',fail);
  // 已在快取裡的圖不會再觸發 load/error，要當場判定
  if(img.complete){if(img.naturalWidth)ok();else fail();}
}

function popupHTML(ev,approx){
  var dateTxt=ev.date_start===ev.date_end
    ? fmtDate(ev.date_start)
    : fmtDate(ev.date_start)+' - '+fmtDate(ev.date_end);
  var chain=imgChain(ev,IMG_W_THUMB);
  var thumb=chain.length
    ? '<img class="pth" src="'+esc(chain[0])+'" alt="" referrerpolicy="no-referrer"'
      +' data-type="'+esc(ev.type)+'" data-fb="'+esc(chain.slice(1).join(' '))+'">'
    : '<div class="pth pth-block" style="color:var(--c-'+esc(ev.type)+')">'+typeLabel(ev.type)+'</div>';
  return '<div class="pop">'
    +'<div class="pop-main">'+thumb
      +'<div class="pop-txt">'
        +'<h3>'+esc(fld(ev,'title'))+'</h3>'
        +'<div class="m">'+typeLabel(ev.type)+'・'+dateTxt+'<br>'
          +esc(areaLabel(ev.area))+' '+esc(fld(ev,'venue'))+'</div>'
      +'</div>'
    +'</div>'
    +(approx?'<div class="approxnote">'+t().approxNote+'</div>':'')
    +'<a href="'+esc(ev.url)+'" target="_blank" rel="noopener">'+t().detail+'</a></div>';
}

// 彈窗內容換過就要重接（同 places.js 的 wirePlacesPopup）。**抽成具名函式**是因為
// 疊圖模式（單位 く）那張地圖上三種彈窗混在一起，要由呼叫端依 `_kind` 分派。
function wireEventPopup(popup){
  var el=popup.getElement();
  var img=el&&el.querySelector('img.pth');
  if(img)wirePopupImg(img);
}

// 目前篩選底下的活動圖釘。⚠️⚠️ **疊圖模式與這張地圖共用同一份，是「抽出來」不是「複製」**
// ——複製的話兩邊會各自演化，而漏改一邊的症狀是「兩張地圖各自看起來都正常，
// 只是同一個篩選在疊圖上少了幾筆」，沒有任何錯誤訊息。
// `_kind` 是給疊圖那張分派彈窗接線與圖例用的，單張地圖上沒有人讀它。
function eventMarkers(){
  var out=[];
  store.events.forEach(function(ev){
    if(!match(ev))return;
    if(typeof ev.lat!=='number'||typeof ev.lng!=='number')return;
    var approx=(ev.geo==='area'||ev.geo==='uncertain');
    var m=L.marker([ev.lat,ev.lng],{icon:pinIcon(ev.type,approx)});
    m.bindPopup(popupHTML(ev,approx),{minWidth:246,maxWidth:246});
    m._kind='ev';
    out.push(m);
  });
  return out;
}

function renderMap(){
  initMap();
  markerLayer.clearLayers();
  var markers=eventMarkers();
  var pts=markers.map(function(m){var ll=m.getLatLng();return [ll.lat,ll.lng];});
  // 一次全部加入。逐一 addLayer 會讓叢集每加一顆就重算一次。
  if(markerLayer.addLayers)markerLayer.addLayers(markers);
  else markers.forEach(function(m){markerLayer.addLayer(m);});
  // ⚠️ **印的是 `pts.length`（真的畫出圖釘的）不是 `list.length`（篩選後的筆數）**
  // ——上面那行 `typeof ev.lat!=='number'` 會跳過沒有座標的活動，兩個數字因此可能不同。
  // 統一成「這張地圖上有幾個」是單位 き-1 的一部分，三張地圖同一個口徑。
  // 📌 2026-09-09 實查：活動 1620 筆、景點 736 筆**都是 0 筆沒座標**，餐廳只有 1 筆，
  // 所以今天三張的數字一個都沒變——這一行是為了日後真的出現時不說謊。
  document.getElementById('mapSub').textContent=t().count(pts.length);
  // 開場視野：`fitBounds` 散得太開時改用「我的位置」（單位 Y-4）。
  // ⚠️ **三張地圖共用 `fitFromMyLoc` 一份**，改它等於三頁一起變——那是刻意的
  // （同 `js/geofilter.js` 三頁共用篩選）。分三份寫必然漂移。
  // ⚠️ 從另一張地圖切過來時**沿用它的視野**（單位 き-2），不重算。
  // **只有真的有點時才消費**：資料還沒到的那一次 pts 是空的，若在那時消費掉，
  // 等資料到了再跑一次就沒得用了，視野會被 fitBounds 蓋回全日本。
  var keep=pts.length?takeMapView():null;
  if(keep){map.setView([keep.lat,keep.lng],keep.z,{animate:false});}
  else if(pts.length&&!fitFromMyLoc(map,pts,[40,40])){map.fitBounds(pts,{padding:[40,40],maxZoom:13});}
  setTimeout(function(){map.invalidateSize();},80);
}

// 地圖開著才重畫（單位 き-1）。**由 cards.js 在每次篩選變動後呼叫**，因為活動的篩選
// 彈窗屬於 cards，而地圖屬於這裡——少了這條線，地圖上那顆篩選鈕會變成「按了沒反應」。
// ⚠️ 刻意不重畫圖例：活動的圖例永遠是同樣七個分類，不隨篩選改變（餐廳與景點的會）。
function renderMapIfOpen(){
  if(mapview.classList.contains('show'))renderMap();
}

// 圖例的分類段是否展開；重畫圖例時要還原它（同 restaurants.js／places.js 的 legendOpen）。
// **不寫進 localStorage**：它是「這次看地圖時我把它打開了」，不是一項設定。
var legendOpen=false;

function buildLegend(){
  // 色塊裡放與圖釘同一個圖示。**地圖上有圖示，圖例就一定要有**——
  // 圖例是唯一能查「這個圖案是什麼」的地方（與餐廳圖例同一條規則）。
  var rows=TYPES.map(function(v){
    return '<div><span class="dot drop" style="background:'+pinColor(v)+'">'
      +typeIconHTML(v,LEGEND_ICON)+'</span>'+typeLabel(v)+'</div>';
  }).join('');
  // **分類那段收合起來**（2026-08-27，第三張地圖；三角形、高度上限與分隔線
  // 整套沿用餐廳／景點頁的 `.legend-genres`，CSS 是同一份三頁並列的選擇器）。
  // ⚠️ **這裡的理由與另外兩頁不同**：活動分類**永遠是六個**（新增一個要同步改五處），
  // 不會像餐廳那樣愈接愈多。收合純粹是為了手機上的地圖高度，以及三張地圖行為一致。
  var html='<details class="legend-genres"'+(legendOpen?' open':'')+'>'
    +'<summary>'+esc(t().type)+' '+TYPES.length+'</summary>'
    +'<div class="legend-rows">'+rows+'</div></details>';
  // 概略位置那一行留在收合區外面常駐（同另外兩頁）：它是每次看地圖都用得到的，
  // 而且永遠只有一行。⚠️ **刻意不比照景點頁改成「真的有才印」**——那會動到這次
  // 範圍外的行為，而活動資料幾乎每天都有一批 geo==='area'。
  // ⚠️ 它也是 `drop`（單位 こ-1）：這一行講的是**半透明的水滴圖釘**，
  // 形狀跟著走才對得上。半透明本身不變。
  html+='<div style="margin-top:3px;opacity:.65"><span class="dot drop" style="background:'
    +'var(--ink-3);opacity:.5"></span>'+t().approx+'</div>';
  var box=document.getElementById('mapLegend');
  box.innerHTML=html;
  // **每次重畫都要重接監聽器**：innerHTML 換掉整個節點，舊的跟著沒了。
  // `toggle` 事件**不會冒泡**，所以委派在容器上沒有用（餐廳頁 2026-08-14 踩過）。
  // 記住展開狀態的理由：切語言與切晝夜都會重畫圖例（main.js 兩處），
  // 不記的話使用者開著的它會自己合起來。
  var fold=box.querySelector('details.legend-genres');
  if(fold)fold.addEventListener('toggle',function(){legendOpen=fold.open;});
}

var mapview=document.getElementById('mapview');
// 地圖是整頁覆蓋層，但底下那 664 張卡片仍在 DOM 裡，瀏覽器照樣要管它們——
// 實測光是把清單藏起來，拖曳地圖的中位幀就從 60ms 降到 36ms（占總改善的一半）。
// 用 display:none 而非 content-visibility：後者 Safari 18 才支援，而使用者多半用 iPhone。
// 代價是頁面高度歸零會讓捲動位置跑掉，故存起來、關閉時還原。
// ⚠️ **存在 store.overlayScroll 而不是這裡的區域變數**（2026-08-27）：三張地圖可以互相切換，
// 各存一份的話切過去的那一張會存到 0（那時卡片是藏起來的、頁面高度為 0）。
function openMapView(){
  // 切換到另一張地圖時**不可以重存**：那時卡片是藏起來的、頁面高度為 0，
  // 存到的會是 0，最後關掉就回到清單最頂端而不是原來看的位置（見 store.mapSwitching）。
  if(!store.mapSwitching){
    store.overlayScroll=window.scrollY||window.pageYOffset||0;
    // 不是從切換器過來的（分頁列、右上角地圖鈕）＝這是一次全新的開場，
    // 上一次殘留的視野要丟掉，否則它會在下一次改篩選時被誤用（單位 き-2）。
    store.mapView=null;
  }
  document.body.classList.add('map-open');
  mapview.classList.add('show');
  buildLegend();renderMap();
}
function closeMapView(){
  // 把現在看的位置交給下一張地圖（單位 き-2）。**要在 remove('show') 之前**：
  // Leaflet 的 getCenter 讀的是內部狀態、不依賴 DOM 尺寸，但順序照著寫比較不會有人來改壞。
  // ⚠️ keepMapView 自己會判斷「是不是切換過來的」，這裡不必再寫一次條件。
  keepMapView(map);
  mapview.classList.remove('show');
  document.body.classList.remove('map-open');
  // 等卡片重新排版完再捲回去，否則頁面還沒長高、捲不到原位
  // 切換到另一張地圖時不還原（下一張馬上就會蓋上來，還原只會白跑一次；
  // 真正該還原的是最後那一次關閉）。
  if(!store.mapSwitching)requestAnimationFrame(function(){window.scrollTo(0,store.overlayScroll);});
}
document.getElementById('mapBtn').addEventListener('click',openMapView);
document.getElementById('mapClose').addEventListener('click',closeMapView);

// openMapView／closeMapView 對外開放是給網頁導覽用的（2026-08-21 第二批）：
// 導覽要自己把地圖打開再指圖例與叢集。**方向是 tour → map，map 不知道 tour 的存在。**
export { buildLegend, closeMapView, eventMarkers, mapview, openMapView, renderMap, renderMapIfOpen, wireEventPopup };
