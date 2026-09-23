// 跨模組共享的可變狀態。
// **ES Modules 的 import 是唯讀綁定**——`import { events }` 之後再寫 `events = [...]`
// 會直接 TypeError。所以凡是會被重新賦值的狀態一律收進這一個物件，寫成 store.events = …。
// 只在單一模組內用到的狀態（curCols、calYM、pickArea、pmap…）不放這裡，留在自己的模組。
import { HOME_ZONE, LANG_KEY, PLAN_KEY, PLAN_VER } from './config.js';

export const store = {
  // view 只剩 list / fav：原本的 home（6 格分類入口頁）已移除，
  // 瀑布流本身就是入口，分類改成頂部橫排文字篩選，少一次點擊。
  // ⚠️ `type` 與 `area` **2026-09-03 由字串改成多選**（篩選彈窗換成 chip 樹那一輪）：
  //    `type` 是 `{分類名:1}`、空的＝不篩選；`area` 的形狀見 `js/geofilter.js` 的
  //    `newGeoSel()`（`{areas:{桶:1}, spots:{桶:{據點:1}}}`，活動沒有據點所以 spots 永遠空）。
  // ⚠️⚠️ **這裡刻意寫字面值而不 import `newGeoSel()`**：store → geofilter → util → store 會成環。
  //    要重設請呼叫 geofilter 的 `clearGeo(store.state.area)`（就地清空，不必再造一個物件）。
  // ⚠️ 這一份不進 localStorage，所以改形狀沒有相容問題（九個 key 裡沒有它）。
  // ⚠️ `date` **2026-09-16 起多第五種值 `'day'`**（單位 さ，地圖上的日期鈕）：
  //    那時真正的日期放在 `day`（`'YYYY-MM-DD'`），其餘四種值 `day` 一律是空字串。
  //    ⚠️⚠️ **`date:'day'` 而 `day:''` 是一個不該存在的狀態**——`match()` 會拿空字串
  //    去比檔期，結果是**全部篩掉、畫面一片空白而且沒有任何錯誤訊息**。
  //    所以 `match()` 對它的處理是「視同沒選」，改動這裡之前先讀那一段。
  //    ⚠️ 為什麼不把日期字串直接塞進 `date`：全站有四處在做 `t().dates[state.date]`
  //    的查表，塞進去會全部查不到而印出 undefined。兩個意思就給兩格（同 `url`／`aff_url`）。
  state: { type:{}, date:'all', day:'', sort:'default', area:{areas:{},spots:{}}, kw:'', view:'list', onlyNew:false, onlySoon:false },
  events: [],
  // 常設景點（單位 H）。**刻意獨立於 events**：全站有 12 個地方吃的是 events 陣列本身
  // （清單、地圖、篩選、新收錄、快結束、三套行程），景點不在裡面就天生看不到，
  // 一行過濾都不用寫。反過來 concat 進 events 只要一行，但那 12 處要逐一過濾，
  // 漏一處就外洩到瀏覽動線。行程還原走 evById()，改那一個函式就全部支援。
  places: [],
  // 餐廳（單位 I）。**只有真的需要時才會有內容**——plan-food.js 的 ensureFood()
  // 在「行程裡有 rs- 開頭的 id」或「使用者展開了『加一頓飯』」時才去載 restaurants/_map.json
  // （壓縮後 76 KB＝首頁載入量的 +45%）。載過就不再載。
  // ⚠️ **載入規則刻意寫成一般形式**（「任何地方需要 rs- 的 id 就載一次」）而不是
  // 「開行程頁時載」：今天行為一樣，等單位 K（餐廳收藏）上線時一個字都不用改。
  // 裡面放的是**轉接過的**記錄（id 帶 rs- 前綴、type 是 '餐廳'），不是 _map.json 的原始形狀。
  restaurants: [],
  // 「比這一天更晚收錄的算新」。由 whatsnew.js 在初始化時從 jpev_seen 算出來，
  // 之後整個 session 不再變動（同一天內重複進站不推進，見 config.js 的 SEEN_KEY）。
  // 放進 store 是為了讓 util 的 match() 讀得到而**不必 import whatsnew**——
  // whatsnew 需要 util 的 t()／esc()，反過來 import 會成環。
  newSince: '',
  meta: { updated:'', count:0 },
  favs: [],
  // 收藏活動的隨身備份 { <id>: {t,tj,e} }，由 expiring.js 讀寫。
  // 放 store 的理由與 newSince 相同：util 的 match() 用不到它，但 cards 與 expiring
  // 都要，而 expiring 已經 import util 了，反向 import 會成環。
  favMeta: {},
  // 收藏的餐廳（單位 K）。**清單與隨身備份合而為一**：每一筆是
  // {id, n:店名, g:類別, gj:類別日文, a:地區, s:據點, aw:徽章}，收藏當下就把畫面上
  // 那幾樣一起存下來。所以**收藏分頁不必載那 76 KB 的 _map.json** 就畫得出來，
  // 而那家店日後從榜單消失時也還說得出它叫什麼（同 favMeta 的理由）。
  // ⚠️ **與 store.favs 分家是刻意的**，理由見 config.js 的 FAVR_KEY。
  favR: [],
  // ===== 跨天行程（單位 J，2026-08-26）=====
  // **一趟連續的日子**：`days` 依日期升冪、且保證相鄰（加減天數只能從尾端，改起日是整趟平移）。
  // ⚠️ **`store.plan` 不在這個字面量裡**，它在下面被定義成「目前選中的那一天」的存取器。
  //    這樣做的理由是全站有 51 處在讀 `store.plan.date` 或 `store.plan.ids`，
  //    而**真相只能有一份**（就是 `trip.days`）。存取器讓那 51 處一行都不必改，
  //    同時不會生出第二份會跟它對不起來的資料——那正是本專案反覆踩過的坑。
  // ⚠️ 中間那天不想排就**留空**（0 站照樣是一天），不要為了「刪掉中間那天」而讓日期不連續。
  trip: { days:[{date:'',ids:[]}] },
  dayIdx: 0,
  // ===== 三張地圖之間的切換（2026-08-27）=====
  // ⚠️ **捲動位置必須共用同一份**：覆蓋層開著時首頁的卡片是 display:none、頁面高度歸零，
  //    所以「關掉這張、打開那張」時若讓第二張自己重存一次，存到的會是 0
  //    ——最後關掉地圖就回到清單最頂端而不是原來看的位置，而**畫面上看不出是壞的**。
  //    三個覆蓋層（地圖／景點／餐廳）因此都改讀寫這一個值。
  overlayScroll: 0,
  // 切換進行中：這一段期間不重存也不還原捲動位置（理由同上）。由 mapswitch.js 開關。
  mapSwitching: false,
  // 切換三張地圖時帶過去的視野（單位 き-2，2026-09-09）：`{lat,lng,z}`，沒有就是 null。
  // ⚠️ **三張地圖是三個各自獨立的 Leaflet 實例**，而每一張在開場時都會自己重算視野
  //    （fitBounds／fitFromMyLoc）——所以在活動地圖上放大到澀谷、切到餐廳，
  //    看到的會是整個日本。這一格就是「上一張看的是哪裡」。
  // ⚠️ **只有從切換器過來的那一次會寫**（close 時看 mapSwitching），
  //    從分頁列或右上角地圖鈕開的一律清掉——否則殘留的舊視野會在下一次篩選時被誤用。
  mapView: null,
  planRO: false,          // 從分享連結進來的唯讀模式
  planFar: false,         // 「想跑遠一點」：切到鎌倉湘南／箱根熱海／富士山周邊
  // 行程頁的大區（單位 N，2026-09-03）。**全域、切天不重設**——一趟旅行不會今天在東京、
  // 明天在福岡，而切天時把它重設回首都圈，等於使用者每換一天就要再選一次。
  // ⚠️ **切大區時一定要把 planFar 一起歸零**（plan-ui 的 setPlanZone 就是這麼做的）：
  //    planFar 也是全域狀態，帶著 true 切過去會拿到一個與使用者預期無關的池子，
  //    **而畫面上完全看不出來**（單位 J 的 A/B 就是被它弄髒的）。
  // 初值由 main.js 在資料到齊後決定（讀 jpev_zone，第一次進站才用 jpev_loc 猜）。
  planZone: HOME_ZONE,
  planOpts: [],
  planSel: -1,
  // 導覽的行程示範用的沙盒旗標（2026-08-21，第二批）。**開著時 savePlan() 一個位元組都不寫。**
  // ⚠️ 做成「不寫」而不是「離場再還原」是刻意的：使用者**中途關掉分頁時沒有任何程式在跑**，
  // 還原那條路救不了他，而沒寫過就沒有東西要救。
  sandbox: false,
  lang: (function(){
    try{
      var s = localStorage.getItem(LANG_KEY);
      if (s === 'zh' || s === 'ja') return s;      // 使用者選過就尊重他的選擇
    }catch(e){}
    var n = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^ja/i.test(n) ? 'ja' : 'zh';           // 首次進站依瀏覽器語言判斷
  })()
};

// `store.plan` ＝**目前選中的那一天**。讀寫都直接落在 `trip.days[dayIdx]` 上，
// 所以 `store.plan.ids.push(...)`／`store.plan.date=…` 這些既有寫法全部照舊有效。
// ⚠️ **setter 只換掉「這一天」，不會動到其他天。** 早期只有單日時有三處寫過
// `store.plan = {date,ids}`（main.js 還原、分享連結、導覽沙盒），跨天之後那三處都已改寫；
// 這個 setter 留著是安全網——萬一日後有人再寫一次，結果是「蓋掉目前這天」
// 而不是「整趟塌成一天」。**後者會靜默弄丟其他天，而畫面上看起來完全正常。**
function curDay(){
  var d=store.trip.days;
  if(!d.length)d.push({date:'',ids:[]});
  if(!(store.dayIdx>=0)||store.dayIdx>=d.length)store.dayIdx=0;
  return d[store.dayIdx];
}
Object.defineProperty(store,'plan',{
  enumerable:true,
  get:curDay,
  set:function(v){
    var d=curDay();
    d.date=(v&&v.date)||'';
    d.ids=(v&&v.ids)||[];
  }
});

// 切換地圖時把視野交給下一張（單位 き-2）。**兩支都在這裡，因為三張地圖共用同一份約定**
// ——分三處各寫一份必然漂移（同 fitFromMyLoc 三張共用一份的理由）。
//
// `keepMapView(m)` 由每一張地圖的 close 呼叫；⚠️ **它自己判斷 mapSwitching**，
// 所以呼叫端不必記得——漏判的後果是「從分頁列開地圖也停在上次的位置」，
// 而那看起來像「開場視野壞了」。
export function keepMapView(m){
  if(!store.mapSwitching||!m)return;
  var c=m.getCenter();
  store.mapView={lat:c.lat,lng:c.lng,z:m.getZoom()};
}
// `takeMapView()` ＝讀出來**並清掉**。⚠️ **「用完就清」是這件事的關鍵**：
// 三張地圖的視野邏輯同時也是「改篩選之後重算視野」那條路，殘留的話下一次改篩選
// 會套用一個切換當時的舊視野，**而畫面上只是「地圖沒有跟著篩選跳過去」**。
export function takeMapView(){
  var v=store.mapView;store.mapView=null;return v;
}

// ⚠️ **存的是整趟，不是目前這一天。** 只存 plan 的話，切到 Day2 加了一站再重新整理，
// Day1 就不見了——而且那是靜默的。`i` 存目前看第幾天，回站時停在同一天。
export function savePlan(){
  if (store.planRO) return;    // 唯讀是別人分享的行程，不可覆蓋使用者自己的
  if (store.sandbox) return;   // 導覽示範中：畫面照動，但不留下任何痕跡
  try{ localStorage.setItem(PLAN_KEY,
    JSON.stringify({v:PLAN_VER, i:store.dayIdx, days:store.trip.days})); }catch(e){}
}
