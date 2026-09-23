// 進入點：跨模組的事件接線與初始化。
// 只有「會同時碰到兩個以上模組」的綁定放這裡，其餘留在各自模組。
import { LANG_KEY, PLAN_KEY, THEME_KEY } from './config.js';
import { store } from './store.js';
import { resetStyleCache, syncThemeColor, t } from './util.js';
import { buildAreaSel, buildSideChips, colCount, curCols, render, setMapRepaint, tabAll, tabFav, tabPlan } from './cards.js';
import { buildLegend, mapview, renderMap, renderMapIfOpen } from './map.js';
import { bindFold, initPlanZone, openPlan, planWide, planview, pmap, readSharedPlan, renderFoodBody, renderPlan, renderPlanMap, requestAddFood, restoreTrip, syncPlanMapFold } from './plan-ui.js';
import { refreshRestaurants, setFoodAddHandler, setRestaurantsAllRepaint } from './restaurants.js';
import { placesDataSettled, refreshPlaces, setPlacesAllRepaint } from './places.js';
import { applyLocLang } from './mylocation.js';
import { initSeen } from './whatsnew.js';
import { clearSoon, initFavMeta, syncFavMeta } from './expiring.js';
import { initFavFood, setFavFoodAddHandler } from './favfood.js';
import { buildThemePick, closeSettings, initSettings, openSettings } from './settings.js';
import { openCredits, repaintCredits } from './credits.js';
import { openSiteinfo, repaintSiteinfo } from './siteinfo.js';
import { buildMapSwitch } from './mapswitch.js';
import { setDateRepaint } from './datefilter.js';
import { refreshAll, renderAllIfOpen } from './mapall.js';
import { startTour, tourStepCount } from './tour.js';

'use strict';
try{store.favs=JSON.parse(localStorage.getItem('jpev_favs')||'[]');}catch(e){store.favs=[];}
initFavMeta();
// 收藏的餐廳（單位 K）。**清單與備份是同一個 key**，所以讀進來就直接畫得出來，
// 不必等 restaurants/_map.json（那 76 KB 只有真的要加進行程時才載）。
initFavFood();

// ⚠️ **還原整趟，不是還原一天**（單位 J）。舊格式 `{date,ids}` 與新格式 `{v,i,days}`
// 都由 plan-ui 的 restoreTrip() 認，**舊的一定要讀得進來**，否則使用者現有的行程會歸零
// ——而那是靜默的，畫面上只會看到「我上次排的東西不見了」。
// 兩套上限（活動景點 4 ＋ 餐廳 2）的截法也在那裡（capPlanIds），
// **絕不可以在這裡自己寫 `slice(0,PLAN_MAX)`**：那會讓存好的餐廳安靜地不見。
try{ restoreTrip(JSON.parse(localStorage.getItem(PLAN_KEY)||'null')); }catch(e){}

// ===== 靜態文字 =====
function applyLang(){
  var L=t();
  document.documentElement.lang=L.htmlLang;
  // ⚠️ 不是 `L.app`：分頁與搜尋結果上的標題要講得出這個站在做什麼（SEO）。
  //    退回 `L.app` 是保險，不是預期路徑。見 config.js 的 `pageTitle`。
  document.title=L.pageTitle||L.app;
  function set(id,v){document.getElementById(id).textContent=v;}
  set('appname',L.app); set('region',L.region);
  set('lbType',L.type); set('lbDate',L.date); set('lbSort',L.sort); set('lbArea',L.area);
  set('lbUpdated',L.updated); set('lbSource',L.source);
  set('filterTitle',L.filterTitle); set('filterClear',L.clearFilter);
  set('settingsTitle',L.settingsTitle); set('lbTheme',L.theme); set('settingsDone',L.done);
  // ⚠️ **不可以寫 set('tourBtn',…)**：那顆現在是入口卡（圖示＋標題＋副標＋箭頭），
  //    而 set() 走 textContent，會把圖示與副標一起清光。標題與副標各自一個 id。
  //    同 tour.js 那顆「上一步／下一步」不可再用 textContent 寫它的理由。
  //    ⚠️ guideSub 是**函式**（副標要講共幾步），步數向 tour.js 要、不寫死。
  set('lbGuide',L.guide); set('tourBtnT',L.guideStart);
  set('tourBtnS',L.guideSub(tourStepCount()));
  // ⚠️ 同 tourBtn：creditsBtn 是入口卡，**不可以 set('creditsBtn',…)**（會清掉圖示與箭頭）
  set('lbCredits',L.credits); set('creditsBtnT',L.creditsStart);
  set('creditsBtnS',L.creditsSub); set('creditsTitle',L.creditsTitle);
  document.getElementById('creditsClose').setAttribute('aria-label',L.aCreditsClose);
  repaintCredits();          // 它開著的時候換語言，整頁要重畫
  // ⚠️ 同 tourBtn／creditsBtn：siteinfoBtn 是入口卡，**不可以 set('siteinfoBtn',…)**
  set('lbSiteinfo',L.siteinfo); set('siteinfoBtnT',L.siteinfoStart);
  set('siteinfoBtnS',L.siteinfoSub); set('siteinfoTitle',L.siteinfoTitle);
  document.getElementById('siteinfoClose').setAttribute('aria-label',L.aSiteinfoClose);
  repaintSiteinfo();         // 同上：它開著的時候換語言，整頁要重畫
  set('mapTitle',L.mapTitle);
  document.getElementById('sourceInfo').innerHTML=L.sourceInfo;
  document.getElementById('kw').placeholder=L.searchPh;
  document.getElementById('updated').textContent=
    store.meta.updated?L.total(store.meta.updated,store.meta.count):L.loading;
  var lb=document.getElementById('langBtn');
  lb.textContent=L.other; lb.setAttribute('aria-label',L.aLang);
  document.getElementById('gearBtn').setAttribute('aria-label',L.aSettings);
  document.getElementById('mapBtn').setAttribute('aria-label',L.aMap);
  document.getElementById('mapClose').setAttribute('aria-label',L.aClose);
  document.getElementById('tabAll').setAttribute('aria-label',L.aAll);
  document.getElementById('tabFav').setAttribute('aria-label',L.aFav);
  document.getElementById('tabPlan').setAttribute('aria-label',L.aTabPlan);
  // 餐廳與景點兩顆分頁鈕的 aria-label 由各自模組的 syncXxxUi() 設（下面兩行的
  // refreshRestaurants／refreshPlaces 會叫到），這裡不重複設一次。
  buildThemePick();
  // 三張地圖右上角的切換器（2026-08-27）。**三個容器一次畫齊**，不必等那張地圖被打開
  // ——它只有換語言時會變。
  buildMapSwitch();
  buildSideChips(); buildAreaSel();
  applyLocLang();
  refreshRestaurants();
  refreshPlaces();
  refreshAll();
  // 行程頁開著就一起換語言（與地圖同一個做法，見 setLang）
  if(document.getElementById('planview').classList.contains('show'))renderPlan();
}

function setLang(l){
  if(l===store.lang)return;
  store.lang=l;
  try{localStorage.setItem(LANG_KEY,l);}catch(e){}
  applyLang(); render();
  if(document.getElementById('mapview').classList.contains('show')){
    buildLegend(); renderMap();       // 地圖開著就一起換
  }
}
document.getElementById('langBtn').addEventListener('click',function(){
  setLang(store.lang==='zh'?'ja':'zh');
});

// 明度換了之後要重畫的四處。**圖釘與圖例的顏色是 JS 產生的字串**，不會跟著
// CSS 變數走，所以清單那邊會自己變、這四處不會。
// 兩個入口共用它：設定彈窗裡的外觀 chip（settings.js 用 callback 交回來）
// 與下面的系統明度監聽。⚠️ **少接一處的症狀是「切了深色但圖釘還是淺色的」。**
function repaintTheme(){
  if(mapview.classList.contains('show')){buildLegend();renderMap();}
  if(planview.classList.contains('show'))renderPlanMap();
  refreshRestaurants();
  refreshPlaces();
  refreshAll();
}
initSettings(repaintTheme);
document.getElementById('gearBtn').addEventListener('click',openSettings);

// 網頁導覽（2026-08-21）。**綁在 main 而不是 settings.js**：它要先關掉設定彈窗、
// 再叫另一個模組開始，同時碰兩個模組，照規則屬於這裡。
// settings.js 因此維持「不 import 任何畫面模組」。
document.getElementById('tourBtn').addEventListener('click',function(){
  closeSettings();
  startTour();
});

// 圖片出處（2026-09-02）。理由與導覽那顆一模一樣：先關設定彈窗再開覆蓋層，
// 同時碰兩個模組，所以綁在這裡而不是 settings.js。
document.getElementById('creditsBtn').addEventListener('click',function(){
  closeSettings();
  openCredits();
});

// 網站資訊（2026-09-02）。理由同上面兩顆：先關設定彈窗再開覆蓋層。
document.getElementById('siteinfoBtn').addEventListener('click',function(){
  closeSettings();
  openSiteinfo();
});

tabAll.addEventListener('click',function(){
  store.state.view='list';store.state.type={};store.state.kw='';document.getElementById('kw').value='';
  // 「快結束」的母體是收藏，留著它在「全部」分頁等於一個看不出來的隱形條件
  // （畫面只剩那幾張卡，分頁列卻亮在全部）。切回全部就一併關掉。
  clearSoon();
  buildSideChips();
  tabAll.classList.add('on');tabFav.classList.remove('on');
  render();window.scrollTo(0,0);
});
tabFav.addEventListener('click',function(){
  store.state.view='fav';tabFav.classList.add('on');tabAll.classList.remove('on');
  render();window.scrollTo(0,0);
});

// 換欄數才重畫；單純寬度變化不動，避免捲動位置亂跳
var rt,wasPlanWide=planWide();
window.addEventListener('resize',function(){
  clearTimeout(rt);
  rt=setTimeout(function(){
    if(colCount()!==curCols)render();
    // 行程頁的兩欄／單欄是 CSS 切的，但地圖的展開狀態與 Leaflet 的尺寸得自己接。
    var w=planWide();
    if(w!==wasPlanWide){
      wasPlanWide=w;
      syncPlanMapFold(w);
      if(planview.classList.contains('show'))renderPlanMap();
    }else if(pmap&&planview.classList.contains('show')){
      // 沒跨斷點、只是欄寬變了：**只重算尺寸不重畫**——重畫會 fitBounds，
      // 把使用者手動縮放／拖曳過的視野重置掉。
      pmap.invalidateSize();
    }
  },160);
});

// 使用者開著頁面把系統切換成深色時要跟著變。
// **這件事以前是 media query 自動處理的**，改用 data-theme 之後必須自己接回來，
// 否則「跟隨系統」只在載入當下成立一次。有手動偏好時則不覆蓋。
if(window.matchMedia){
  var mqDark=window.matchMedia('(prefers-color-scheme:dark)');
  var onScheme=function(){
    var pref=null;
    try{pref=localStorage.getItem(THEME_KEY);}catch(e){}
    if(pref!=='light'&&pref!=='dark'){
      document.documentElement.setAttribute('data-theme',mqDark.matches?'dark':'light');
      buildThemePick();                 // 設定彈窗裡亮著的那顆要跟著換
    }
    resetStyleCache();                    // 分類色可能變了，重新讀 CSS 變數
    syncThemeColor();                   // 狀態列底色也跟著換
    repaintTheme();
  };
  if(mqDark.addEventListener)mqDark.addEventListener('change',onScheme);
  else if(mqDark.addListener)mqDark.addListener(onScheme);
}

tabPlan.addEventListener('click',openPlan);
bindFold('dateFold','dateBody');
bindFold('mapFold','mapBody',renderPlanMap);
bindFold('selfFold','selfBody');
// 「加一頓飯」（單位 I）。**展開才去載那 76 KB 的 restaurants/_map.json**，
// 與地圖那一段「展開才初始化」是同一個做法。
bindFold('foodFold','foodBody',renderFoodBody);

// 餐廳分頁彈窗那顆「加進行程」（單位 I 決策 17②）。**綁在這裡而不是在 restaurants.js
// 裡 import plan-ui**：那會成環（plan-ui → plan-food → restaurants）。
// 同 initSettings(cb)／openLocPicker(cb)：擁有那個動作的模組把函式交過來。
setFoodAddHandler(requestAddFood);
// 收藏清單那顆「＋」（單位 K）。理由與上面那行一模一樣：favfood 不能 import plan-ui
// （cards → favfood → plan-ui → cards 會成環），所以由這裡把函式交過去。
setFavFoodAddHandler(requestAddFood);
// 活動地圖第二列那顆篩選鈕改了條件之後，地圖上的圖釘要跟著變（單位 き-1）。
// **理由與上面兩行同一族**：cards 與 map 是同一層的並列模組，誰都不該 import 對方，
// 所以由這裡把函式交過去。⚠️ 少了它，那顆鈕會變成「彈窗開得起來、選得動、
// 關掉之後地圖一模一樣」——清單其實已經篩好了，所以不會報錯，只是看起來沒有用。
// ⚠️ **疊圖模式（單位 く）也吃這三份篩選**，所以三個模組改完條件都要順手通知它。
// 少了任何一個，症狀都是「在疊圖上改了那一種的條件，關掉彈窗發現地圖沒跟上」
// ——而那一頁自己完全正常。**三行是同一件事，要加就三行一起加。**
setMapRepaint(function(){renderMapIfOpen();renderAllIfOpen();});
// 地圖上那顆日期鈕改了之後要重畫（單位 さ，2026-09-16）。**與上面那行同一族**：
// datefilter 只依賴共用層、不 import cards（那會成環），所以由這裡把函式交過去。
// ⚠️ **一定要先 buildSideChips()**：篩選彈窗「時間」那排會多出或少掉「具體日期」那一顆，
//    不重畫的話會變成「地圖上在篩 9/20，彈窗裡四顆卻都不亮」——兩個狀態互相說謊。
// ⚠️ render() 尾端自己會叫 mapRepaint（活動地圖＋疊圖）與 syncDateBtns()，這裡不必重複。
setDateRepaint(function(){buildSideChips();render();});
setPlacesAllRepaint(renderAllIfOpen);
setRestaurantsAllRepaint(renderAllIfOpen);

var sharedPlan=readSharedPlan();

// ===== 初始化 =====
// 造訪日要在第一次 render 之前算好——chip 的筆數靠 store.newSince 判定，
// 晚一步的話第一次畫出來的分類列不會有它（events 還沒到，但 render 會再跑一次）。
initSeen();
applyLang();
syncThemeColor();
render();

// **兩份資料並行載入，兩個都到齊才渲染。**（單位 H）
// ⚠️ 景點刻意**不比照餐廳那樣「點進分頁才抓」**：`?plan=` 分享連結一進站就直接開行程頁，
// 延遲載入會讓「景點資料載入失敗」那句話在完全正常的情況下每一次都出現。
// places.json 約 10KB，而 events.json 是 648KB，不值得省；重的是照片而照片本來就 lazy。
var evP=fetch('events.json?t='+Date.now()).then(function(r){return r.json();});
// 景點是附加內容、活動才是本體：**它失敗不可以卡住全站**，
// store.places 留空即可（畫面上就是沒有景點段，活動一切照常）。
var plP=fetch('places.json?t='+Date.now())
  .then(function(r){return r.ok?r.json():null;})
  .catch(function(){return null;});

Promise.all([evP,plP])
  .then(function(res){
    var data=res[0],pdata=res[1];
    store.places=(pdata&&pdata.places)||[];
    store.events=data.events||[];
    store.meta.updated=data.updated_at||'';
    store.meta.count=data.count||store.events.length;
    document.getElementById('updated').textContent=t().total(store.meta.updated,store.meta.count);
    // **趁活動還在的時候**把收藏的標題與結束日刷新一次；等它被剔除就問不到了。
    // 必須排在 render() 之前——「已結束的收藏」那一段就是拿這份備份畫的。
    syncFavMeta();
    // 行程頁的大區（單位 N）。**必須排在這裡**：它要驗證「記住的那個大區還有沒有存貨」，
    // 也要拿站點座標猜最近的大區，兩件事都得等 events／places 到齊。
    // 資料讀取失敗那條路刻意不呼叫——那時每個大區都是空的，維持預設的首都圈即可。
    initPlanZone();
    render();
    // 景點分頁要知道「資料已經有結果了」才分得出「還在載入」與「讀不到」。
    // ⚠️ **成功與失敗兩條路都要呼叫**：這裡不呼叫的話，events.json 掛掉時
    // 景點頁會永遠停在「載入中…」——那正是本專案最怕的「壞掉但看起來正常」。
    placesDataSettled();
    // 分享連結進來的行程要等資料到齊才畫得出來（活動內容全靠 id 去 events 裡查）
    if(sharedPlan)openPlan();
  })
  .catch(function(){
    document.getElementById('updated').textContent=t().loadFail;
    placesDataSettled();
  });

