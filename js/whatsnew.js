// 「新收錄」（單位 C）。要解決的問題：站上有七百多個活動、每天多約 27 個，
// 而清單是照**活動日期**排的，所以新抓到的會散落在整份清單裡——
// 使用者沒有任何辦法知道哪些是自己還沒看過的。抓到了但沒被看到，等於沒抓到。
//
// 判定資料來自管線發下的 `first_seen`（首次收錄日，發下就不再重算）。
// 這個模組只管三件事：造訪日的讀寫與推進、chip 的 HTML、切換。
// 判定本身在 util 的 isNew()——它與 match() 是同一條邏輯，分兩處寫必然漂移。
import { SEEN_KEY } from './config.js';
import { store } from './store.js';
import { esc, isNew, match, t, todayStr } from './util.js';

// 造訪紀錄：{last:這次造訪日, prev:上次造訪日}，比較一律拿 prev。
//
// ⚠️ **同一天內重複進站絕對不能推進。** 直覺寫法是「進站就把上次造訪時間更新成
// 現在」，但那樣使用者第一次進來看五秒就關掉，第二次進來「新的」全部歸零——
// 典型的壞掉但看起來完全正常。所以只有 last !== 今天（＝跨日）才推進。
//
// 中間隔幾天沒來也對：8/15 沒來、8/16 來，last 還停在 8/13，
// 於是 prev=8/13，三天份的新活動一次都看得到。
function initSeen(){
  var today=todayStr(), rec=null;
  try{ rec=JSON.parse(localStorage.getItem(SEEN_KEY)||'null'); }catch(e){}
  if(!rec||typeof rec!=='object'||!rec.last){
    // 第一次來的人沒有「上次」。基準訂在今天＝**全部視為看過**，
    // 否則七百多筆全是新的，chip 點下去跟沒篩選一樣（那顆按鈕會看起來壞掉）。
    // 隔天再來就正常了，而這個功能本來就是給回訪的人用的。
    rec={last:today,prev:today};
  }else if(rec.last!==today){
    rec={last:today,prev:rec.last};
  }
  store.newSince=rec.prev;
  try{ localStorage.setItem(SEEN_KEY,JSON.stringify(rec)); }catch(e){}
}

// 目前篩選條件下有幾筆新的。**用完整的 match() 而不是 match(ev,true)**：
// 使用者選了「展覽」時，這個數字要回答「展覽裡有幾筆新的」。
// 兩種狀態下都正確——篩選開著時 match() 本身已經只回新的，再 && 一次不變。
function newCount(){
  return store.events.filter(function(ev){return match(ev)&&isNew(ev);}).length;
}

// 分類列最前面那顆。沿用 .side-chip（純文字＋選中加底線），不是新增一套樣式。
function newChipHTML(){
  var n=newCount();
  // 0 筆時整顆不顯示：第一次來的人、以及當天沒有新增時，都不會看到一顆
  // 點下去是空白的按鈕。
  // ⚠️ **但篩選開著時一律顯示**，否則使用者篩到 0 筆（例如再選一個分類）
  // 就沒有任何回路可以把它關掉。
  if(!n&&!store.state.onlyNew)return '';
  return '<button class="side-chip new-chip'+(store.state.onlyNew?' on':'')+'" data-new="1">'
    +'<span>'+esc(t().newly)+'</span><span class="cnt">'+n+'</span></button>';
}

function toggleNew(){ store.state.onlyNew=!store.state.onlyNew; }

export { initSeen, newChipHTML, newCount, toggleNew };
