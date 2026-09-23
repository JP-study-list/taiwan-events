// 行程的路線外連（單位 D）。做的事只有「把 Google 地圖的網址先組好」——
// **不需要金鑰、不產生費用**（官方：You don't need a Google API key to use Maps URLs），
// 真正算路線的是使用者自己的 Google 地圖。決策紀錄見 development-plan-v3.md §1-D。
//
// ⚠️ 為什麼要分成「逐段」與「整趟」兩種連結：
// **Google 的 waypoints 不支援大眾運輸**，所以「一個網址帶完整行程」與「用電車」
// 只能二選一。逐段走電車（東京真正的移動方式），整趟走開車（唯一能一次看完多站的）。
import { ROUTE_KEY, WALK_KM, WAYPOINT_MAX } from './config.js';
import { hopLabel } from './plan-core.js';
import { esc, hav, mapQuery, t } from './util.js';

var DIR='https://www.google.com/maps/dir/?api=1';

// 模式只有這個模組讀寫（plan-ui 只呼叫下面的函式），故**不進 store**——
// store.js 註解訂的界線就是「只在單一模組內用的狀態留在自己的模組」。
var _mode=(function(){
  try{
    var s=localStorage.getItem(ROUTE_KEY);
    if(s==='first'||s==='me')return s;
  }catch(e){}
  return 'first';                       // 預設從第一站，理由見下方 meUrl
})();
function routeMode(){return _mode;}
function setRouteMode(m){
  _mode=(m==='me')?'me':'first';
  try{localStorage.setItem(ROUTE_KEY,_mode);}catch(e){}
}

// **用場地名而非我們存的座標**：查不到座標的活動存的是地區中心點（車站），
// 用座標會指錯地方。這是 util.js 的 mapQuery 已經處理好的事，沿用即可。
function q(ev){return encodeURIComponent(mapQuery(ev));}
function hasXY(e){
  return e&&typeof e.lat==='number'&&typeof e.lng==='number'
    &&isFinite(e.lat)&&isFinite(e.lng);
}

// 站→站。**交通方式跟著 hopLabel 的判斷走**——同一列已經寫了「步行可達」，
// 點下去卻給一段電車轉乘，等於在說「剛剛那句別信」。
// 算不出距離時退回電車（都市移動的常態），不會沒有連結。
function legUrl(a,b){
  var walk=hasXY(a)&&hasXY(b)&&hav(a.lat,a.lng,b.lat,b.lng)<=WALK_KM;
  return DIR+'&origin='+q(a)+'&destination='+q(b)
    +'&travelmode='+(walk?'walking':'transit');
}
// 第 0 段（「從我現在的位置」模式才有）。**origin 整個不寫**——Google 的規則是
// 「Defaults to most relevant starting location, such as device location」。
// 這就是本模式的全部實作：**不讀 jpev_loc、不送任何座標出去**，
// 所以「我的位置永遠不離開裝置」那條硬規則完全不受影響（§1-A）。
// 也因此**不能拿它當預設**：使用者人在台灣時，它會算出台灣→東京的荒謬路線，
// 而且連結不會報錯，是靜默給錯答案。
function meUrl(b){
  return DIR+'&destination='+q(b)+'&travelmode=transit';
}
// 整趟。**travelmode=driving 必須明寫**：不寫的話 Google 會沿用使用者上次用的模式，
// 萬一是大眾運輸，**waypoints 會被靜默忽略**——連結照常打開、路線照常出現，
// 但中間站全部不見了。正是本專案最怕的那種壞法。
function wholeUrl(stops){
  if(!stops||stops.length<2)return '';
  var mid=stops.slice(0,-1),last=stops[stops.length-1],u=DIR;
  if(_mode!=='me')u+='&origin='+q(mid.shift());
  u+='&destination='+q(last)+'&travelmode=driving';
  if(mid.length)u+='&waypoints='+mid.map(q).join('%7C');
  return u;
}
// 這一趟會用掉幾個 waypoint（＝中間站）。'me' 模式沒有 origin，所以第一站也算中間站。
function midCount(stops){
  if(!stops||stops.length<2)return 0;
  return stops.length-1-(_mode==='me'?0:1);
}
// ⚠️ **Google 的中間站上限，超過就整批靜默消失**（地雷 #20）。
// 官方只寫一句「Waypoints are not supported on all Google Maps products; in those cases
// this parameter will be ignored」——**被忽略時不會報錯**：連結照常打開、路線照常畫出來，
// 只是中間站全部不見了。**手機 3、桌機 9，一律照手機守**（偵測裝置不可靠）。
//
// 單位 I 把一天的上限從 4 站放寬到 6 站（活動／景點 4 ＋ 餐廳 2），實測：
//   4 站：first 2 ✅ / me 3 ✅（現況剛好用滿）
//   5 站：first 3 ✅ / me 4 ❌
//   6 站：first 4 ❌ / me 5 ❌
// 定案是**超限就不顯示這顆鈕**，原地換一句話（決策 5）。**逐段電車完全不受影響。**
// 另外兩個選項（自動改用第一站模式／拆成兩段）今天就已經半失效，
// 而住宿與跨天只會讓站數繼續往上長。
function overWaypointLimit(stops){return midCount(stops)>WAYPOINT_MAX;}
// 整趟只在「總點數 ≥3」時才有意義。點數不足時它與逐段連到**同一段路**，
// 差別只有交通方式，而開車那顆在東京比較差——等於放一顆比隔壁差的重複按鈕。
// 一條規則同時蓋掉兩種模式：'first' 要 3 站、'me' 要 2 站（自己算一個點）。
function showWhole(stops){
  return !!stops&&stops.length>=2&&stops.length+(_mode==='me'?1:0)>=3
    &&!overWaypointLimit(stops);
}

// ---- HTML ----
// 外連一律 target="_blank"：全螢幕模式沒有網址列，就地導航會把使用者關在外部網站（地雷 #13）。
function goLink(href,label){
  return '<a class="go" href="'+esc(href)+'" target="_blank" rel="noopener">'
    +esc(label)+'</a>';
}
// 段間那一列。左邊放距離，右邊放連結——「0.4 km・步行可達」本身就在幫使用者
// 省下一次點擊（不必點開才知道走路就到）。
function hopRowHTML(a,b){
  var d=(hasXY(a)&&hasXY(b))
    ?'<span class="d">'+esc(hopLabel(hav(a.lat,a.lng,b.lat,b.lng)))+'</span>':'';
  return '<div class="plan-hop">'+d+goLink(legUrl(a,b),t().routeGo)+'</div>';
}
// 第 0 段。**沒有距離**——我們不知道使用者在哪（那正是不碰 jpev_loc 換來的），
// 而沒有數字就是誠實地不知道（同 §1-A 決策 15）。左邊改放模式名稱，
// 一來這一列上面沒有站、光一顆按鈕看不出從哪到哪，二來兼作「模式生效」的回饋。
function meRowHTML(b){
  return '<div class="plan-hop">'
    +'<span class="d">'+esc(t().routeFromMe)+'</span>'
    +goLink(meUrl(b),t().routeGo)+'</div>';
}
function wholeRowHTML(stops){
  // **超限時說一句話，不是靜靜地少一顆鈕**：那顆鈕本來就在的人會以為壞了，
  // 而真正的替代方案（上面逐段的「怎麼去」）就在同一個畫面上，值得指過去。
  // ⚠️ 這一句**只在「本來會有」的情況下印**——站數本來就不足時維持原本的空字串。
  if(overWaypointLimit(stops)&&stops&&stops.length+(_mode==='me'?1:0)>=3)
    return '<div class="plan-whole over">'+esc(t().routeAllTooMany)+'</div>';
  if(!showWhole(stops))return '';
  return '<div class="plan-whole">'+goLink(wholeUrl(stops),t().routeAll)+'</div>';
}
// 兩顆 chip 而不是一顆兩段切換鈕：使用者要看到「目前是什麼」，
// 而一顆按鈕上寫現況會被讀成動作（「按下去就會從第一站開始」）。
// 沿用側欄與分類列的 .side-chip（純文字 + 選中加底線），不是新增一套樣式。
function routeChipsHTML(){
  var L=t(),m=_mode;
  function chip(v,lb){
    return '<button class="side-chip'+(m===v?' on':'')+'" data-rmode="'+v+'">'
      +esc(lb)+'</button>';
  }
  return '<div class="route-chips">'
    +chip('first',L.routeFromFirst)+chip('me',L.routeFromMe)+'</div>';
}

export { hopRowHTML, legUrl, meRowHTML, meUrl, midCount, overWaypointLimit, routeChipsHTML, routeMode,
         setRouteMode, showWhole, wholeRowHTML, wholeUrl };
