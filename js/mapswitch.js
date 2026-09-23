// 三張地圖（活動／景點／餐廳）之間的切換器（2026-08-27）。左上角是標題，右上角是這一顆。
//
// **它不記任何狀態。** 三個覆蓋層裡各放一份，而每一份選中的永遠是它自己那一格
// （活動地圖裡選「活動」、景點地圖裡選「景點」、餐廳地圖裡選「餐廳」），
// 所以那三段 HTML 是固定的——只有換語言時才需要重畫。
//
// ⚠️ **方向是 mapswitch → {map, places, restaurants}，那三個都不知道它的存在**
//    （同 tour.js 對 cards／map／plan-ui 的關係）。切換＝呼叫那兩個模組自己的
//    open／close，所以各自的篩選、圖例、彈窗、分頁列高亮全部沿用既有行為，
//    一行都不必在這裡重寫。
// ⚠️ **捲動位置走 store.overlayScroll ＋ store.mapSwitching**（見 store.js 那段）：
//    切換的中途重存會存到 0，最後關掉地圖就回到清單最頂端，而畫面上看不出是壞的。
import { store } from './store.js';
import { esc, t } from './util.js';
import { closeMapView, openMapView } from './map.js';
import { closePlaces, openPlaces } from './places.js';
import { closeRestaurants, openRestaurants } from './restaurants.js';
import { closeAll, openAll } from './mapall.js';

// 圖示**抄自底部分頁列的那三顆**（格狀＝活動、圖釘＝景點、餐具＝餐廳），因為它們
// 在使用者眼裡已經是這三件事。⚠️ 那三顆的 svg 寫在 index.html 裡，換圖案時要一起換這裡
// ——同一個意思長成兩種圖案，比沒有圖案更難認。
var ICONS={
  ev:'<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/>'
    +'<rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  pl:'<path d="M9 11a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/>'
    +'<path d="M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z"/>',
  rs:'<path d="M5 3v6a3 3 0 0 0 6 0V3M8 3v18M16 3v18M16 3c3 1 4 4 4 7v2h-4"/>',
  // 「全部」＝疊圖模式（單位 く，2026-09-10）。Tabler 的 stack-2，
  // **三層剛好對應三種資料**，而且它與另外三格那種「一個東西」的圖示形式不會撞。
  // ⚠️ **這一格非有圖示不可**：窄螢幕（389px／日文 479px）那兩條 media query 會把文字
  //    藏起來只留圖示，沒有圖示的格子會變成一個空格（`.viewswitch` 2026-08-28 踩過）。
  // ⚠️ **2026-09-11 起它排在最前面**（使用者決定），見下方 `VIEWS` 那段。
  all:'<path d="M12 4l-8 4l8 4l8 -4z"/><path d="M4 12l8 4l8 -4"/><path d="M4 16l8 4l8 -4"/>'
};

// box＝那個覆蓋層裡的容器 id；view＝覆蓋層本身（用來判斷現在開著的是哪一張）。
// ⚠️⚠️ **這個陣列的順序就是畫面上四格的順序**（`segHTML` 直接 map 它）。
//    **2026-09-11 使用者把「全部」移到第一個**，其餘三格維持原本的相對順序。
//    ⚠️ `current()` 與 `buildMapSwitch()` 也遍歷它，但兩者都與順序無關
//    （同時只會有一個覆蓋層是 `.show`，而每個容器各畫各的）。
//    ⚠️ **別在別處用索引去取某一格**（`.mapswitch-seg[3]` 那種）——一改順序就指到別的地方，
//    而畫面上完全看不出來。要指定哪一格一律用 `[data-k="…"]`。
var VIEWS=[
  // ⚠️ **這一格與另外三格性質不同**：那三格各是「一種資料」，這一格是「三種一起」。
  //    但它在這裡的介面完全一樣（一個覆蓋層 ＋ open／close），所以 `go()`／`current()`
  //    一行都不必改——**這正是「切換＝呼叫對方自己的 open／close」那個設計的回報**。
  {k:'all', box:'mapSwitchAll', view:'allView', open:openAll, close:closeAll},
  {k:'ev', box:'mapSwitchEv', view:'mapview',        open:openMapView,     close:closeMapView},
  {k:'pl', box:'mapSwitchPl', view:'placesView',     open:openPlaces,      close:closePlaces},
  {k:'rs', box:'mapSwitchRs', view:'restaurantView', open:openRestaurants, close:closeRestaurants}
];

function byKey(k){
  for(var i=0;i<VIEWS.length;i++)if(VIEWS[i].k===k)return VIEWS[i];
  return null;
}
// 現在開著的是哪一張。**問 DOM 而不是自己記一個變數**：三個覆蓋層本來就可以從
// 別的入口打開（右上角地圖鈕、底部分頁列），自己記的那份遲早會與畫面對不起來。
function current(){
  for(var i=0;i<VIEWS.length;i++){
    var el=document.getElementById(VIEWS[i].view);
    if(el&&el.classList.contains('show'))return VIEWS[i];
  }
  return null;
}

function go(k){
  var cur=current(),to=byKey(k);
  if(!cur||!to||cur.k===k)return;      // 按的就是現在這一張：什麼都不做
  store.mapSwitching=true;
  try{ cur.close(); to.open(); }
  finally{ store.mapSwitching=false; } // 中途丟例外也要收乾淨，否則捲動位置從此不再存
}

function segHTML(active){
  var lb=t().mapSwitch;
  return VIEWS.map(function(v){
    var on=v.k===active;
    return '<button type="button" class="mapswitch-seg'+(on?' on':'')+'" data-k="'+v.k+'"'
      +(on?' aria-current="true"':'')+'>'
      +'<svg viewBox="0 0 24 24" aria-hidden="true">'+ICONS[v.k]+'</svg>'
      +'<b>'+esc(lb[v.k])+'</b></button>';
  }).join('');
}

// 三個容器一次畫齊。**換語言後要再叫一次**（main.js 的 applyLang）。
function buildMapSwitch(){
  VIEWS.forEach(function(v){
    var box=document.getElementById(v.box);
    if(!box)return;
    box.setAttribute('role','group');
    box.setAttribute('aria-label',t().aMapSwitch);
    box.innerHTML=segHTML(v.k);
    // **每次重畫都要重接監聽器**：innerHTML 換掉整個節點，舊的跟著沒了（同 buildLegend）。
    var segs=box.querySelectorAll('.mapswitch-seg');
    for(var i=0;i<segs.length;i++){
      segs[i].addEventListener('click',function(){go(this.getAttribute('data-k'));});
    }
  });
}

export { buildMapSwitch };
