// 餐廳收藏（單位 K，2026-08-27）。三件事：
//
//   ① 收藏本身的讀寫 —— 第九個 localStorage key `twev_favr`。
//   ② 收藏分頁下方那一段「收藏的餐廳」清單。
//   ③ 從那份清單一鍵加進行程（先問午餐／晚餐）。
//
// ⚠️ **本模組只 import config／store／util，不 import 任何畫面模組。** 這不是潔癖：
// 那份清單畫在 cards.js 裡，而 plan-ui 已經 import cards——這裡再 import plan-ui
// 就成環（cards → favfood → plan-ui → cards）。所以「加進行程」的處理函式
// **由 main.js 注入**，同餐廳彈窗那顆鈕的做法（setFoodAddHandler）。
//
// ⚠️ **收藏當下就把畫面上那幾樣一起存下來**（店名、類別、據點、徽章），
// 於是這一段**不必為了顯示而載那 76 KB 的 `restaurants/_map.json`**，
// 而那家店日後從榜單消失時也還說得出它叫什麼（同 expiring.js 的隨身備份）。
// 真的要「加進行程」時才會載——那正是單位 I 決策 10 那條「需要 rs- 的 id 就載一次」，
// 一個字都不必改。
import { FAVR_KEY, FOOD_TYPE, OTHER_SPOT, T } from './config.js';
import { store } from './store.js';
import { areaLabel, awardsHTML, esc, foodMeal, planFoodIdOf, t, typeColor } from './util.js';

// 正在問「哪一餐」的那家店（原始 id）。**不進 store**——只有本模組讀寫。
var asking='';
// 「加進行程」的處理函式，由 main.js 注入（見本檔開頭）。沒注入時那顆鈕整顆不出現，
// 而不是按了沒反應。
var addHandler=null;
function setFavFoodAddHandler(fn){addHandler=fn;}

// ===== ① 收藏的讀寫 =====
function saveFavFood(){
  try{ localStorage.setItem(FAVR_KEY,JSON.stringify(store.favR)); }catch(e){}
}
function initFavFood(){
  var a=null;
  try{ a=JSON.parse(localStorage.getItem(FAVR_KEY)||'null'); }catch(e){}
  store.favR=(a instanceof Array)?a.filter(function(x){return x&&x.id;}):[];
}
// 餐廳記錄 → 收藏要存的最小紀錄。
// ⚠️ **吃兩種形狀**：餐廳分頁給的是 `_map.json` 展開後的原始記錄（`name_ja`、id 不帶前綴），
// 行程頁的候選清單給的是 plan-food 轉接過的（`title`、id 是 `rs-<原始 id>`）。
// 兩邊都會呼叫這裡，所以正規化只寫這一處——分兩套必然漂移。
function favRec(r){
  if(!r)return null;
  var id=String(r.id||'').replace(/^rs-/,'');
  if(!id)return null;
  return {
    id:id,
    n:r.name_ja||r.title||'',
    g:r.genre||'', gj:r.genre_ja||'',
    a:r.area||'', s:r.spot||'',
    // 徽章連同文字一起存。**這就是「不必載 76 KB 也畫得出來」的那一半**——
    // `_map.json` 的 `w` 是編號，要靠頂層字典才展得開，而字典就在那 76 KB 裡面。
    aw:(r.awards instanceof Array)?r.awards.map(function(a){
      return {guide:a.guide||'',tier:a.tier||'',year:a.year||''};
    }):[]
  };
}
function favIndex(baseId){
  var id=String(baseId||'').replace(/^rs-/,'');
  for(var i=0;i<store.favR.length;i++)if(store.favR[i].id===id)return i;
  return -1;
}
function isFavFood(baseId){return favIndex(baseId)>-1;}
function favFoodCount(){return store.favR.length;}
// 收藏／取消。回傳**收藏之後的狀態**（true＝現在是收藏的），呼叫端用它決定鈕要不要亮。
function toggleFavFood(r){
  var rec=favRec(r);
  if(!rec)return false;
  var i=favIndex(rec.id);
  if(i>-1){store.favR.splice(i,1);saveFavFood();return false;}
  store.favR.push(rec);saveFavFood();return true;
}
// 目前這一輪已知的「榜單上有哪些店」。**兩條路都會餵它**：餐廳分頁自己的載入器
// （原始形狀）與行程頁的 `store.restaurants`（轉接過的形狀）——`favRec()` 兩種都吃。
// ⚠️ **null 代表「還沒載，不知道」**，與「載了但查不到」是兩件事，不可以混：
// 前者要閉嘴，後者才說「已從榜單移除」。
var known=null;

// 資料到齊時刷新備份。店名、類別與徽章都可能在下一次跑管線時改（去重合併、
// 新的一年入選），**趁那家店還在的時候把最新的存下來**——同 expiring 的 syncFavMeta。
// ⚠️ **查不到的一律不動**：那可能只是 `_map.json` 還沒載，不是那家店不見了。
function syncFavFood(records){
  var list=(records&&records.length)?records:store.restaurants;
  if(!list.length)return;
  var by={},dirty=false;
  list.forEach(function(r){by[String(r.id).replace(/^rs-/,'')]=r;});
  known=by;
  store.favR.forEach(function(f,i){
    var r=by[f.id];
    if(!r)return;
    var next=favRec(r);
    if(JSON.stringify(next)===JSON.stringify(f))return;
    store.favR[i]=next;dirty=true;
  });
  if(dirty)saveFavFood();
}
// 這家店還在榜單上嗎。⚠️ **資料還沒載就一律回 true**（＝不說話）：那時每一筆都「查不到」，
// 照算的話整份清單會掛滿「已從榜單移除」——同 goneList() 在 store.events 空時回空陣列，
// 失敗方向要往「什麼都不說」那一邊倒。
function stillListed(id){
  if(!known)return true;
  return Object.prototype.hasOwnProperty.call(known,id);
}

// ===== ② 收藏分頁那一段 =====
function genreLabel(f){
  return store.lang==='ja'?(f.gj||f.g):(f.g||f.gj);
}
// 據點優先、沒有據點才退回地區。**「銀座」比「東京23區」有用**，而 `其他` 是資料值
// 不是地名（同 plan-food 組 Google 查詢字串那條），不可以印出來。
function placeLabel(f){
  if(f.s&&f.s!==OTHER_SPOT)
    return store.lang==='ja'&&T.ja.spots?(T.ja.spots[f.s]||f.s):f.s;
  return f.a?areaLabel(f.a):'';
}
// 哪一餐已經有店了。收藏清單問餐別時要把那一顆標成不可選——
// 不擋的話會排出兩家午餐，而行程列上看起來完全正常。
function mealUsed(){
  var used={};
  store.plan.ids.forEach(function(id){
    var m=foodMeal(id);
    if(m)used[m]=1;
  });
  return used;
}
function rowHTML(f){
  var L=t(),color=typeColor(FOOD_TYPE);
  var pid=planFoodIdOf(f.id);
  var off=!stillListed(f.id);
  var sub='<span class="cat" style="color:'+color+'">'+esc(genreLabel(f))+'</span>';
  var pl=placeLabel(f);
  if(pl)sub+='<span>'+esc(pl)+'</span>';
  // 那家店從榜單消失時**只說一句話，絕不自動從收藏刪掉**——自動刪又變成靜默消失，
  // 正是這份備份要修的問題（同「已結束的收藏」）。
  if(off)sub+='<span class="favfood-off">'+esc(L.favFoodOff)+'</span>';
  var aw=(f.aw&&f.aw.length)?awardsHTML({awards:f.aw},color):'';
  var info='<div class="info"><div class="nm">'+esc(f.n||f.id)+'</div>'
    +'<div class="sub">'+sub+'</div>'
    +(aw?'<div class="restaurant-awards plan-food-aw">'+aw+'</div>':'')
    +'</div>';
  var acts='',x;
  if(asking===f.id){
    // 就地問「哪一餐」。⚠️ **問而不猜是使用者的決定**：從餐廳分頁彈窗加進來時沒有這一步
    // （那邊沿用行程頁選中的餐別），這條新路才問。
    // ⚠️ **自成一列**（`flex-basis:100%`）：擠在店名右邊的話，長店名會被壓到折兩行，
    // 而那時使用者正在看的就是「我要為哪一家店選餐別」。
    var used=mealUsed();
    acts='<div class="favfood-ask-bar">'
      +'<span class="favfood-ask">'+esc(L.favFoodMeal)+'</span>'
      +'<button class="side-chip" data-fr-meal="lunch"'+(used.lunch?' disabled':'')+'>'
        +esc(L.foodLunch)+'</button>'
      +'<button class="side-chip" data-fr-meal="dinner"'+(used.dinner?' disabled':'')+'>'
        +esc(L.foodDinner)+'</button></div>';
    // ⚠️ **問到一半時「×」是取消，不是刪掉收藏。** 同一顆鈕在兩種狀態下做兩件事很危險，
    // 而這裡的危險是不對稱的：按錯的代價一邊是「白按一下」，另一邊是**收藏就沒了**。
    x='<button class="favfood-x" data-fr-cancel="1" aria-label="'+esc(L.placesCancel)+'">×</button>';
  }else{
    if(addHandler&&!store.planRO&&!off)
      acts='<button class="act'+(pid?' on':'')+'" data-fr-add="'+esc(f.id)+'"'
        +' aria-label="'+esc(L.aFavFoodAdd)+'">'+(pid?'✓':'＋')+'</button>';
    x='<button class="favfood-x" data-fr-del="'+esc(f.id)+'"'
      +' aria-label="'+esc(L.aFavFoodRemove)+'">×</button>';
  }
  // ⚠️ **順序：問餐別時 `×` 要排在那一列之前**（它自成一列會換行，排在後面就掉到第三行），
  // 其餘時候一律「＋」在左、`×` 在最右——刪除永遠放最外側。
  return '<div class="favfood-row'+(asking===f.id?' asking':'')+'">'
    +info+(asking===f.id?x+acts:acts+x)+'</div>';
}
// 只在收藏分頁出現，且沒有收藏餐廳時整段不印（同「已結束的收藏」）。
function favFoodHTML(){
  if(store.state.view!=='fav')return '';
  if(!store.favR.length)return '';
  // 重畫這一段的時機，正好就是「資料可能剛到齊」的時機（載完餐廳會整頁重畫）。
  // syncFavFood() 本身是冪等的、沒東西可更新時一個位元組都不寫。
  syncFavFood();
  var L=t();
  // **新收藏的排在最上面。** 存的時候是 push（同 store.favs），顯示時才反過來——
  // 反過來存會讓「最近收藏的」這個語義藏在陣列順序裡，讀 localStorage 的人看不出來。
  return '<div class="favfood-head"><h3>'+esc(L.favFoodH)+'</h3>'
    +'<span class="favfood-n">'+esc(L.restaurantCount(store.favR.length))+'</span></div>'
    +store.favR.slice().reverse().map(rowHTML).join('');
}

// ===== ③ 點擊 =====
// **回報有沒有真的改到東西**，由呼叫端（cards.js）決定要不要重畫——
// 本模組不 import cards（那會成環），同 expiring 的 handleExpiredClick。
function handleFavFoodClick(e){
  var q=function(sel){return e.target.closest?e.target.closest(sel):null;};
  var cancel=q('[data-fr-cancel]');
  if(cancel){asking='';return true;}
  var del=q('[data-fr-del]');
  if(del){
    var i=favIndex(del.getAttribute('data-fr-del'));
    if(i>-1){store.favR.splice(i,1);saveFavFood();}
    if(asking===del.getAttribute('data-fr-del'))asking='';
    return true;
  }
  var add=q('[data-fr-add]');
  if(add){
    var id=add.getAttribute('data-fr-add');
    // 已經在行程裡的話那顆是「✓」，按下去就是移除——與行程頁的候選清單同一個狀態機。
    // 移除同樣走注入的處理函式（它認得「已在行程裡就移除」）。
    if(planFoodIdOf(id)){if(addHandler)addHandler(id,repaint);return false;}
    asking=id;
    return true;
  }
  var meal=q('[data-fr-meal]');
  if(meal){
    if(meal.disabled)return false;
    var mid=asking;asking='';
    if(mid&&addHandler)addHandler(mid,repaint,meal.getAttribute('data-fr-meal'));
    return true;
  }
  return false;
}
// 加進行程之後由 plan-ui 回叫。**只重畫這一段**——它可能發生在日期小卡關閉之後，
// 而那時整頁的 render 已經跑完了。
var repaintCb=null;
function setFavFoodRepaint(fn){repaintCb=fn;}
function repaint(){ if(repaintCb)repaintCb(); }

export { favFoodCount, favFoodHTML, handleFavFoodClick, initFavFood, isFavFood,
         setFavFoodAddHandler, setFavFoodRepaint, syncFavFood, toggleFavFood };
