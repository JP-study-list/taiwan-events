// 收藏的時間性。兩件事，共用同一份隨身備份（twev_favmeta）：
//
//   ①「快結束」chip —— 收藏的活動剩 EXPIRE_DAYS 天內就要結束，主動喊一聲。
//      卡片上本來就有「剩 N 天」（30 天內顯示），但那是**看到了才知道**的資訊，
//      而清單照活動日期排，你收藏的那幾筆散在七百多張卡片裡，等於沒說。
//
//   ② 已結束的收藏 —— 活動結束後 merge_events 會把它從 events.json 剔除，
//      收藏存的是 id，查無此人時卡片就**靜默消失**。這一段讓它說得出去哪了。
//
// 判定本身（isExpiring）刻意留在 util——它與 match() 是同一條邏輯，
// 分兩處寫必然漂移。這裡只管 chip 的 HTML、備份的讀寫、與那份清單的畫面。
import { FAVMETA_KEY } from './config.js';
import { store } from './store.js';
import { esc, evById, isExpiring, t, todayStr } from './util.js';

// ===== 隨身備份 =====
function saveFavMeta(){
  try{ localStorage.setItem(FAVMETA_KEY,JSON.stringify(store.favMeta)); }catch(e){}
}
function initFavMeta(){
  var m=null;
  try{ m=JSON.parse(localStorage.getItem(FAVMETA_KEY)||'null'); }catch(e){}
  store.favMeta=(m&&typeof m==='object'&&!(m instanceof Array))?m:{};
}
// 記一筆。欄位刻意只有三個——這是備查用的最小紀錄，不是第二份資料庫。
function rememberFav(ev){
  if(!ev)return;
  store.favMeta[ev.id]={t:ev.title||'',tj:ev.title_ja||'',e:ev.date_end||''};
  saveFavMeta();
}
function forgetFav(id){
  if(store.favMeta[id]){delete store.favMeta[id];saveFavMeta();}
}
// 資料到齊後刷新一次：標題每天都會被 LLM 重新解讀、結束日也可能被改，
// **趁活動還在的時候把最新的存下來**，等它消失就沒機會了。
// 順手清掉「已經不在收藏裡」的殘留（使用者按掉星星時已經刪過，這是保險）。
function syncFavMeta(){
  if(!store.events.length)return;          // 資料還沒到就什麼都不要動
  var dirty=false;
  store.favs.forEach(function(id){
    var ev=evById(id);
    if(!ev)return;
    var old=store.favMeta[id];
    if(old&&old.t===ev.title&&old.tj===(ev.title_ja||'')&&old.e===ev.date_end)return;
    store.favMeta[id]={t:ev.title||'',tj:ev.title_ja||'',e:ev.date_end||''};
    dirty=true;
  });
  Object.keys(store.favMeta).forEach(function(id){
    if(store.favs.indexOf(id)===-1){delete store.favMeta[id];dirty=true;}
  });
  if(dirty)saveFavMeta();
}

// ===== ① 快結束 chip =====
// 用完整的 match() 會把它自己的篩選也算進去，所以這裡**只用 isExpiring**：
// 這個數字要回答「我收藏的有幾筆快結束了」，不受目前分類／地區／關鍵字影響。
// 那與「新收錄」不同是刻意的——新收錄是全站清單的一個子集，
// 快結束則是對收藏這個固定母體的提醒，跟著篩選跳動只會讓人搞不懂它在數什麼。
function soonCount(){
  return store.events.filter(isExpiring).length;
}
function soonChipHTML(){
  var n=soonCount();
  // 0 筆整顆不顯示（沒有收藏、或收藏的都還久），
  // ⚠️ **但自己開著時一律顯示**，否則篩到 0 筆就沒有回路可以關掉它。
  if(!n&&!store.state.onlySoon)return '';
  return '<button class="side-chip soon-chip'+(store.state.onlySoon?' on':'')+'" data-soon="1">'
    +'<span>'+esc(t().soonEnd)+'</span><span class="cnt">'+n+'</span></button>';
}
function toggleSoon(){ store.state.onlySoon=!store.state.onlySoon; }
function clearSoon(){ store.state.onlySoon=false; }

// ===== ② 已結束的收藏 =====
// 收藏的 id 在 events 裡查不到 → 它從資料裡消失了。分兩種原因，**不可混為一談**：
//   ended —— 結束日已過，正常，這正是使用者該知道的「它結束了」
//   off   —— 結束日還沒到卻不見了，那是來源移除或去重的副作用（地雷 #8），是異常
// 只印一個總數的話，異常就會被正常的那堆淹掉——本專案在「範圍外 vs 地址不完整」
// 上踩過同一個坑。沒有備份紀錄的（功能上線前就收藏的）一律回 unknown，不猜。
function goneKind(m){
  if(!m||!m.e)return 'unknown';
  return m.e<todayStr()?'ended':'off';
}
function goneList(){
  // ⚠️ **資料還沒到齊時一律回空。** store.events 是空的時候每一筆收藏都「查不到」，
  // 照算的話載入中會閃出一整片「已結束」。events.json 真的讀取失敗時也走這條，
  // 什麼都不顯示——失敗方向是安全的。
  if(!store.events.length)return [];
  var out=[];
  store.favs.forEach(function(id){
    if(evById(id))return;
    var m=store.favMeta[id]||null;
    out.push({id:id,meta:m,kind:goneKind(m)});
  });
  // 有結束日的照日期新到舊，沒有的排最後
  out.sort(function(a,b){
    var ea=(a.meta&&a.meta.e)||'', eb=(b.meta&&b.meta.e)||'';
    if(!ea&&!eb)return 0;
    if(!ea)return 1;
    if(!eb)return -1;
    return ea<eb?1:ea>eb?-1:0;
  });
  return out;
}
function goneName(m){
  if(!m)return '';
  return (store.lang==='ja'&&m.tj)?m.tj:(m.t||m.tj||'');
}
// 只在收藏分頁出現。它是一份備查名單而不是內容，混進「全部」只會變成噪音。
function expiredHTML(){
  if(store.state.view!=='fav')return '';
  var list=goneList();
  if(!list.length)return '';
  var L=t();
  var rows=list.map(function(g){
    var nm=goneName(g.meta);
    var tag=g.kind==='ended'?L.goneEnded:g.kind==='off'?L.goneOff:L.goneUnknown;
    return '<div class="expired-row">'
      +'<span class="expired-tag'+(g.kind==='off'?' off':'')+'">'+esc(tag)+'</span>'
      +'<span class="expired-name">'+esc(nm||L.goneUnknown)+'</span>'
      +'<button class="expired-x" data-gone="'+esc(g.id)+'" aria-label="'+esc(L.aGoneRemove)+'">×</button>'
      +'</div>';
  }).join('');
  return '<div class="expired-head"><h3>'+esc(L.goneTitle)+'</h3>'
    +'<button class="expired-clear" data-gone-all="1">'+esc(L.goneClear)+'</button></div>'
    +rows;
}
// 點擊處理。**回傳有沒有真的改到東西**，由呼叫端決定要不要重畫——
// 這個模組不 import cards（那會成環，同 mylocation 那個做法）。
// ⚠️ 一律只從收藏移除，**絕不自動清**：自動清掉就又變成靜默消失，
// 那正是這一整段要修的問題。
function handleExpiredClick(e){
  var all=e.target.closest('[data-gone-all]');
  if(all){
    goneList().forEach(function(g){dropFav(g.id);});
    persistFavs();
    return true;
  }
  var one=e.target.closest('[data-gone]');
  if(one){
    dropFav(one.dataset.gone);
    persistFavs();
    return true;
  }
  return false;
}
function dropFav(id){
  var i=store.favs.indexOf(id);
  if(i>-1)store.favs.splice(i,1);
  forgetFav(id);
}
function persistFavs(){
  try{localStorage.setItem('twev_favs',JSON.stringify(store.favs));}catch(e){}
  store.planOpts=[];     // 行程一會優先錨定收藏，收藏變了就重新產生
}

export { clearSoon, expiredHTML, forgetFav, handleExpiredClick, initFavMeta, rememberFav, soonChipHTML, soonCount, syncFavMeta, toggleSoon };
