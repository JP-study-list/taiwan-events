// 無狀態小工具：跳脫／日期／距離／圖片網址／顏色與明暗／雙語顯示／篩選判定。
// match() 放這裡是刻意的——它原本在清單模組，
// 但地圖也要用，會造成 map ⇄ cards 互相 import。放共用層就沒有環。
import { AREAS, AREA_GROUPS, EXPIRE_DAYS, FOOD_TYPE, IMG_W, PLAN_ZONES, T } from './config.js';
import { store } from './store.js';

// 分類色**只在 CSS 定義一處**，這裡即時讀出來給地圖圖釘與圖例用。
// 以前 CSS 與 JS 各存一份，改色必須兩邊同步（舊地雷 #7）；
// 雙色模式上線後那個坑會變成兩倍大（淺色深色各一組），故改成單一來源。
var _rootStyle=null;
// 讓其他模組清掉快取。**不可讓外部直接寫 _rootStyle**——ES Modules 的
// import 是唯讀綁定，跨模組賦值會在執行期直接 TypeError。
function resetStyleCache(){ _rootStyle=null; }
function typeColor(v){
  if(!_rootStyle)_rootStyle=getComputedStyle(document.documentElement);
  return (_rootStyle.getPropertyValue('--c-'+v)||'').trim()||'#888';
}

// 地圖圖釘與圖例的顏色。與 typeColor 分家的理由見 CSS 的 --pin-* 註解：
// 文字要的是對比度（AA 4.5），圖釘要的是在彩色底圖上的辨識度，兩者最佳解不同。
// 深色模式的 --pin-* 指回 --c-*，所以這支在深色下的結果與改動前完全一致。
function pinColor(v){
  if(!_rootStyle)_rootStyle=getComputedStyle(document.documentElement);
  return (_rootStyle.getPropertyValue('--pin-'+v)||'').trim()||typeColor(v);
}

// iOS 全螢幕模式下狀態列的底色。**必須跟著 data-theme 走，不能用 media 版的 theme-color**
// —— 手動選了深色但系統仍是淺色時，media 版會讓狀態列亮著、底下內容是暗的。
// 值一律現讀 CSS 的 --paper，與 typeColor 同一個道理：調色盤只存在 CSS 一處。
function syncThemeColor(){
  if(!_rootStyle)_rootStyle=getComputedStyle(document.documentElement);
  var c=(_rootStyle.getPropertyValue('--paper')||'').trim();
  if(c)document.getElementById('themeColor').setAttribute('content',c);
}

function t(){return T[store.lang];}
function typeLabel(v){return t().types[v]||v;}
function areaLabel(v){return t().areas[v]||v;}
// ===== 圈（地區桶上面那一層，見 config.js 的 AREA_GROUPS）=====
// 桶 → 圈 的反查表，載入時建一次。**沒被任何圈認領的桶回空字串**，
// 呼叫端一律當「沒有群組」處理，不會消失（config.js 規則 2）。
var _GROUP_OF={};
Object.keys(AREA_GROUPS).forEach(function(g){
  AREA_GROUPS[g].forEach(function(a){if(!_GROUP_OF[a])_GROUP_OF[a]=g;});
});
function groupOfArea(a){return _GROUP_OF[a]||'';}
function groupLabel(v){return t().groups[v]||v;}
// 一筆資料在不在目前的地理篩選裡（多選，形狀見 js/geofilter.js 的 newGeoSel()）。
// **要 `rec.area` 與 `rec.spot` 兩個欄位**：活動與景點沒有 spot，傳 undefined 也正確
// ——那時它永遠落在「這個桶沒有選任何據點」那條路上。
// ⚠️ **放在 util 而不是 geofilter**：`match()` 要用它，而 geofilter 已經 import util。
function geoMatch(rec,sel){
  if(!sel)return true;
  if(Object.keys(sel.areas).length&&!sel.areas[rec.area])return false;
  var sp=sel.spots[rec.area];
  if(sp&&Object.keys(sp).length&&!sp[rec.spot])return false;
  return true;
}
function areaMatch(ev){return geoMatch(ev,store.state.area);}
// 地區下拉的 `<option>`，活動頁與餐廳頁共用（2026-09-03）。
// ⚠️⚠️ **「同一個圈的桶必須在 `AREAS` 裡相鄰」這條規則就活在這個函式裡**：它以 AREAS 為主迴圈、
//    **圈名一變就關掉 optgroup**，圈被拆散的話畫面上會冒出**兩個同名群組、各自帶一個「整個關西」**
//    ——**看起來只像選單有點怪，不會有任何錯誤訊息**（CLAUDE.md 26 個桶那條）。
//    抄第二份等於這條規則存在兩處，所以餐廳頁不自己寫一版。
// - `has(area)`：這個桶要不要列出來。預設全列（活動頁就是這樣，行為與 2026-09-03 之前一字不差）。
// - `count(桶名或圈名)`：要印的筆數，回 null／undefined 就不印（活動頁不印、餐廳頁印）。
// ⚠️ 要不要開 optgroup 看的是「**列得出來的**桶有幾個」而不是圈的總成員數——
//    只剩一個桶時多一層「整個關西」等於一個與底下那格完全同義的選項。
//    活動頁 `has` 恆真，兩者相等，故行為不變。
// ⚠️⚠️ **這個函式是「圈的桶必須相鄰」那條規則的唯一實作**（2026-09-03 抽出來）。
//    回傳分好段的結構 `[{group:'東京'|'', areas:[...]}, …]`，
//    **三張地圖的篩選彈窗都吃它**（`geofilter.js` 的 `geoChipsHTML` 與 `geoLabels`）。
//    抄第二份的症狀是畫面上冒出兩個同名群組，而**不會有任何錯誤訊息**。
//    相鄰性本身由 `test_areas.py` 把關。
// ⚠️ 2026-09-03 之前還有一個 `areaOptionsHTML()` 畫 `<select>` 的 `<optgroup>`，
//    **三頁都改成 chip 樹之後它就沒有消費者了，已一併移除**（連同只有它在用的
//    `areaInSel`／`areaOrGroupLabel`／`groupAllLabel`）。
// ⚠️ 「列得出來的桶只有一個」就不算一個群組（`want=''`）：那時「整個埼玉」與「埼玉」
//    結果一模一樣，放兩個只會讓人以為有差別。連續的無群組桶會併進同一段，那是對的。
function areaGroupsInOrder(has){
  var keep=has||function(){return true;};
  var list=AREAS.filter(function(a){return keep(a);});
  var n={};
  list.forEach(function(a){var g=groupOfArea(a);if(g)n[g]=(n[g]||0)+1;});
  var out=[],cur=null;
  list.forEach(function(a){
    var g=groupOfArea(a);
    var want=(g&&n[g]>1)?g:'';
    if(!cur||cur.group!==want){cur={group:want,areas:[]};out.push(cur);}
    cur.areas.push(a);
  });
  return out;
}
// 活動內容：日文模式優先取日文欄位；舊資料沒有日文時自動退回中文，不會空白
function fld(ev,k){
  if(store.lang==='ja'&&ev[k+'_ja'])return ev[k+'_ja'];
  return ev[k]||'';
}

// Google 地圖查詢字串。**用場地名而非我們存的座標**——查不到座標的活動，
// 存的其實是地區中心點（車站），用座標會指錯地方；而 Google 自己找得到那些場地。
// 台灣版（2026-09-24）：一律用**中文原名**（台灣地點的最佳查詢語言），與畫面顯示語言無關。
// ⚠️ 日本版是 `venue_ja||venue`——那邊日文才是原文；台灣版的 venue_ja 是 AI 譯文，拿去查會查歪。
// 景點與餐廳（plan-food.js／restaurants.js）的 venue 與 venue_ja 填的是同一個字串，不受影響。
function mapQuery(ev){
  var v=(ev.venue||ev.venue_ja||'')
    .replace(/[（(][^）)]*[）)]/g,'')                       // 括號附註對搜尋沒幫助
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g,function(c){              // 全形英數轉半形
      return String.fromCharCode(c.charCodeAt(0)-0xFEE0);
    })
    .replace(/\s+/g,' ').trim();
  if(v)return v+' '+(T.zh.areas[ev.area]||ev.area);
  if(typeof ev.lat==='number'&&typeof ev.lng==='number')return ev.lat+','+ev.lng;
  return '';
}

function todayStr(){
  var d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function weekendRange(){
  var d=new Date();var day=d.getDay();var toSat=(day===0)?-1:(6-day);
  var sat=new Date(d.getFullYear(),d.getMonth(),d.getDate()+toSat);
  var sun=new Date(sat.getFullYear(),sat.getMonth(),sat.getDate()+1);
  function fmt(x){return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');}
  return [fmt(sat),fmt(sun)];
}
function daysLeft(endStr){
  var p=endStr.split('-');var end=new Date(+p[0],+p[1]-1,+p[2]);
  var n=new Date();var now=new Date(n.getFullYear(),n.getMonth(),n.getDate());
  return Math.round((end-now)/86400000);
}
function fmtDate(s){var p=s.split('-');return (+p[1])+'月'+(+p[2])+'日';}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// 卡片上的日期：已開始的活動只顯示截止日。
// 顯示起日會讓跨年活動（如 2024-12 起、2026-08 止）看起來像同一年，實測會誤導；
// 而使用者要判斷的是「現在還能不能去、什麼時候截止」。
function dateHTML(ev){
  var e=ev.date_end.split('-'), s=ev.date_start.split('-');
  var head=(ev.date_start<=todayStr())
    ? '<span class="live">'+t().live+'</span>'
    : '<span>'+s[1]+'.'+s[2]+'</span>';
  return head+' <span class="arw">&rarr;</span> <span>'+e[1]+'.'+e[2]+'</span>';
}

// 景點的營業時間／公休日。**預設收合**：照抄官網原文可能很長（實測最長 200 字），
// 而使用者在那一刻要決定的只是「去不去」。沒有這兩個欄位就整段不顯示——
// H2 還沒抓到、或這次抓失敗，兩者行為天生一致，不必為「還沒有資料」另寫一種樣子。
//
// 放在 util 而不是各自寫一份：行程頁的景點列與景點分頁的地圖彈窗顯示的是同一件事，
// 分兩處寫必然漂移（同 `isNew`／`isExpiring` 判定留在這裡的理由）。
// **樣式不共用**——`.plan-row .hours` 與 `.places-pop .hours` 各自定義，
// 因為兩處的字級與留白本來就不同；共用的是「長什麼結構、講哪幾件事」。
function hoursHTML(ev){
  if(!ev||(!ev.hours&&!ev.holiday))return '';
  var L=t(),body=ev.hours?esc(ev.hours):'';
  // 公休獨立一欄並加粗：公休日看錯是白跑一趟，比營業時間看錯嚴重。
  if(ev.holiday)body+=(body?'\n':'')+'<span class="hl">'+esc(L.holidayH)+'</span>　'+esc(ev.holiday);
  return '<details class="hours"><summary>'+esc(L.hoursH)+'</summary>'
    +'<div class="hours-body">'+body+'</div>'
    +(ev.hours_checked?'<span class="hours-chk">'+esc(L.hoursChecked(ev.hours_checked))+'</span>':'')
    +'</details>';
}

function bigImgUrl(u){
  // Walker+：/l/ 是列表縮圖（長邊 264），/l2/ 是詳情頁的大圖（長邊 400）。
  // 註：/xl/、/ll/、/o/ 都是 404，只有 /l2/ 存在，別再去試那些。
  if(u.indexOf('walkerplus.com')>-1&&u.indexOf('/l/')>-1)return u.replace('/l/','/l2/');
  // WordPress 自動產生的裁切尺寸後綴 foo-486x290.jpg → foo.jpg（原圖）。
  // 限定 /wp-content/ 才套用：TimeOut 用的 Contentful 圖床檔名也長得像尺寸後綴，
  // 但砍掉會變成 403，白白多跑兩次請求才退回。
  if(u.indexOf('/wp-content/')>-1){
    var m=u.match(/-\d{2,4}x\d{2,4}(\.[A-Za-z]{3,4})$/);
    if(m)return u.slice(0,m.index)+m[1];
  }
  // 神奈川觀光與熱海新聞用同一套 CMS，[640_640]_ 前綴代表縮圖，拿掉即原圖。
  // 該 CMS 只生成 640 這一種尺寸，[1200_1200]_ 之類會回一頁 HTML（軟性 404），別試。
  if(u.indexOf('[640_640]_')>-1)return u.replace('[640_640]_','');
  return '';
}

// 免費縮圖代理。單純換大圖會讓流量暴增 8.5 倍（最大一張 6.3MB），
// 經代理縮到 900px webp 後反而比原本更省。
// &we＝不放大，小圖照原尺寸送回，不會為了湊 900px 而虛胖。
// w 省略時用瀑布流的 IMG_W。地圖彈窗的縮圖只有 64 CSS px，
// 硬要 900px 等於為了一張看不到的解析度多付十幾倍流量，故可指定較小的寬度。
function proxied(u,w){
  return 'https://images.weserv.nl/?url='+encodeURIComponent(u.replace(/^https?:\/\//,''))
    +'&w='+(w||IMG_W)+'&we&output=webp&q=82';
}

// 候選網址鏈，前面的失敗就換下一個，全部失敗才換成色塊。
// 這樣網址換算猜錯（實測約 3 張）或代理服務掛掉時，最壞也只是退回原網址。
function imgChain(ev,w){
  var u=ev.img;
  if(!u)return [];
  var big=bigImgUrl(u);
  return big?[proxied(big,w),big,u]:[proxied(u,w),u];
}

// 「上次來之後才收錄的」。first_seen 是管線發下的首次收錄日，發下就不再重算。
// **沒有 first_seen 一律不算新**（回填之前的舊資料、或管線那邊留空的），
// 失敗方向是安全的——寧可漏標，不要讓一整批舊活動假裝是新的。
function isNew(ev){
  return !!(store.newSince&&ev.first_seen&&ev.first_seen>store.newSince);
}

// 「收藏的、而且 EXPIRE_DAYS 天內就要結束的」。判定放這裡而不放 expiring.js，
// 理由與 isNew() 一模一樣：它要被 match() 用到，分兩處寫必然漂移。
//
// ⚠️ **母體固定是收藏，與現在在哪個分頁無關。** 這顆 chip 的用途正是
// 「還沒切到收藏頁就先看到」，所以在「全部」分頁算出來的數字也必須是收藏的那幾筆。
// 已經結束的（daysLeft<0）不算——那是「已結束的收藏」那一段在管的事，
// 兩者混在一起會讓一個永遠消不掉的數字賴在 chip 上。
function isExpiring(ev){
  if(store.favs.indexOf(ev.id)===-1)return false;
  var d=daysLeft(ev.date_end);
  return d>=0&&d<=EXPIRE_DAYS;
}
// `ignoreDate`（單位 さ 第二輪，2026-09-16）＝**不看「時間」這一項條件**。
// 給日期小卡的月曆算「這一天有幾筆」用：那些點要反映**其餘條件底下**的筆數
// （篩了沖繩就該顯示沖繩的），但**不能把日期自己算進去**——算進去的話，
// 選好日期再打開月曆，會變成「只有選中的那一天有點、其餘 30 天全是 0」。
// ⚠️ 語義與既有的 `ignoreType` 完全一致（那是給分類列算每類筆數用的），
//    所以呼叫端一看就懂；**不要改成「傳一個假的 state 進來」那種寫法**，
//    全域狀態暫時改掉再改回來正是本專案被弄髒過好幾次的做法。
function match(ev,ignoreType,ignoreDate){
  if(store.state.view==='fav'&&store.favs.indexOf(ev.id)===-1)return false;
  if(store.state.onlyNew&&!isNew(ev))return false;
  if(store.state.onlySoon&&!isExpiring(ev))return false;
  // ⚠️ `state.type` 2026-09-03 起是**多選集合**（`{分類名:1}`），空的＝不篩選。
  //    `ignoreType` 仍是給分類列算「每個分類各有幾筆」用的，語義沒變。
  if(!ignoreType&&Object.keys(store.state.type).length&&!store.state.type[ev.type])return false;
  if(!areaMatch(ev))return false;
  var d=todayStr();
  if(!ignoreDate){
  if(store.state.date==='now'&&!(ev.date_start<=d&&ev.date_end>=d))return false;
  if(store.state.date==='weekend'){var w=weekendRange();if(!(ev.date_start<=w[1]&&ev.date_end>=w[0]))return false;}
  if(store.state.date==='upcoming'&&!(ev.date_start>d))return false;
  // 指定某一天（單位 さ，2026-09-16）：只留那天還在檔期內的活動。
  // **這一行就是整個功能的全部判定**——活動地圖、疊圖與首頁清單三處都走 match()，
  // 所以三處一次到位，一個字都不必在別的地方重寫（分三份寫必然漂移）。
  // ⚠️⚠️ **`day` 是空字串時視同沒選。** 少了那個 `store.state.day&&`，
  //    `date==='day'` 而 `day===''` 會拿空字串去比檔期 → **每一筆都不符合 → 畫面一片空白，
  //    而且沒有任何錯誤訊息**。正常路徑走不到（setDay 收到空值改呼叫 clearDay），
  //    這是給日後改動用的安全網。
  if(store.state.date==='day'&&store.state.day&&!activeOn(ev,store.state.day))return false;
  }
  if(store.state.kw){
    // 不管畫面顯示哪種語言，中日文關鍵字都要找得到
    var k=store.state.kw.toLowerCase();
    // 圈名也要找得到（搜「神奈川」應該找出橫濱／川崎／鎌倉湘南），中日文各一份
    var g=groupOfArea(ev.area);
    var hay=(ev.title+' '+ev.venue+' '+ev.desc+' '+ev.area+' '
      +(ev.title_ja||'')+' '+(ev.venue_ja||'')+' '+(ev.desc_ja||'')+' '
      +g+' '+(g?(T.ja.groups[g]||''):'')).toLowerCase();
    if(hay.indexOf(k)===-1)return false;
  }
  return true;
}

function curTheme(){return document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';}
function cssVar(n){
  if(!_rootStyle)_rootStyle=getComputedStyle(document.documentElement);
  return (_rootStyle.getPropertyValue(n)||'').trim();
}
function locKnown(ev){return ev.geo==='precise'||ev.geo==='ai';}
// ===== 大區（單位 N）=====
// 桶 → 大區的反查表，**由 PLAN_ZONES 自動生成**。手寫第二張表的話，日後新增一個桶
// 就得記得改兩處，而漏改的症狀是「那個桶的活動排不進任何行程」——完全靜默。
// （同 build_restaurants.py 的 GENRE_ALIAS 由 GENRES 自動生成的理由。）
// 沒有歸屬的桶回空字串：那不會等於任何大區名，所以它永遠不會被排進行程，
// **失敗方向是安全的那一邊**（漏掉幾筆活動，而不是把北海道排進東京那套）。
var _ZONE_OF=(function(){
  var m={},z,i,list;
  for(z in PLAN_ZONES){
    list=PLAN_ZONES[z];
    for(i=0;i<list.length;i++)m[list[i]]=z;
  }
  return m;
})();
function zoneOfArea(a){return _ZONE_OF[a]||'';}
function activeOn(ev,d){return ev.date_start<=d&&d<=ev.date_end;}
function venueKey(ev){return (ev.venue_ja||ev.venue||'?').trim();}
// ===== 行程裡的餐廳 id（單位 I）=====
// 形狀是 `rs-<l|d>-<原始 id>`：**前綴在前端加、查詢時剝掉，資料檔一個位元組都不動。**
// ⚠️ **為什麼非有前綴不可**：活動 id 與餐廳 id 都是 md5 前 12 碼，**長得一模一樣**，
// 沒有前綴就無法從一份行程看出裡面有沒有餐廳——於是每次開行程頁都得無條件載
// 那 76 KB 的 `restaurants/_map.json`，包含行程裡根本沒有餐廳的人。
// ⚠️ **中間那個 l／d 是午餐／晚餐**，因為餐廳「躺在 plan.ids 裡、不另開欄位」
// （決策 7），跨天（單位 J）時把 {date,ids} 包成陣列就自動跟著走；
// 而少了它就寫不出行程列上的「午餐／晚餐」，也排不出「午餐插中段、晚餐接尾」。
// ⚠️ **發布之後就再也改不了**（同景點的 pl-）：分享連結裡存的就是這一串。
var FOOD_ID_RE=/^rs-([ld])-([0-9a-f]{6,32})$/;
function isFoodId(id){return FOOD_ID_RE.test(String(id||''));}
function foodMeal(id){
  var m=FOOD_ID_RE.exec(String(id||''));
  return m?(m[1]==='l'?'lunch':'dinner'):'';
}
// 行程 id → store.restaurants 裡那筆的 id（`rs-<原始 id>`，不含餐別）。
// 同一家店的午餐與晚餐是同一筆資料，**只有行程 id 不同**。
function foodKey(id){
  var m=FOOD_ID_RE.exec(String(id||''));
  return m?'rs-'+m[2]:'';
}
function foodId(baseId,meal){return baseId.replace(/^rs-/,'rs-'+(meal==='dinner'?'d':'l')+'-');}
// 這家店現在在**目前這一天**的行程裡嗎？回它的行程 id（含餐別），不在就回空字串。
// ⚠️ **比對的是剝掉餐別之後的鍵**：同一家店的午餐與晚餐是兩個行程 id、同一筆資料，
// 只比字串會漏掉其中一種。
// ⚠️ **放共用層是因為有三個地方要問同一件事**（餐廳分頁彈窗、行程頁的候選清單、
// 收藏清單那顆「＋」）。2026-08-27 之前它在 restaurants.js 與 plan-food.js 各有一份，
// 單位 K 要問第三次時整併過來——同一條規則存在三處，漏改一處的症狀是
// 「那顆鈕的狀態跟行程對不起來」，而它自己看起來完全正常。
function planFoodIdOf(baseId){
  var key='rs-'+String(baseId||'').replace(/^rs-/,'');
  var ids=store.plan.ids;
  for(var i=0;i<ids.length;i++)if(foodKey(ids[i])===key)return ids[i];
  return '';
}

// 榜單徽章。**吃兩種形狀**：餐廳分頁的原始記錄（`awards`）與行程／收藏轉接過的記錄，
// 兩者的 awards 陣列同形（`{guide,tier,year}`），所以這裡不必分兩套。
// ⚠️ **2026-08-27 由 restaurants.js 搬到共用層**：單位 K 的收藏清單也要印徽章，
// 而它不能 import restaurants（cards → favfood → restaurants → … 會成環）。
// 複製一份才是真風險——徽章那三條「不重印等級／用・隔開／等級加粗」的規則
// 存在兩處，漏改一處就會出現兩種寫法而兩邊各自看起來都正常。
function awardsHTML(r,forceColor){
  // 徽章顏色也跟著類別走（CSS 裡不可寫死某個類別，見 --c-* 那段註解）。
  // 同一家店跨年度入選時 awards 會有多筆，這裡自然就列成多個徽章。
  // ⚠️ **`forceColor` 是給行程頁與收藏清單用的**：那兩處同框的是活動／景點／餐廳
  // 三大類、共七色，把餐廳分頁那 23 種料理色帶過去等於在那裡開第二套色彩系統。
  // 故一律傳 `--c-餐廳`；餐廳分頁不傳，行為一個位元組沒變。
  var awards=r.awards instanceof Array?r.awards:[];
  var color=forceColor||typeColor(r.genre);
  return awards.map(function(a){
    var guide=a.guide||'', tier=a.tier||'';
    // **等級已經包含在榜單名裡就不重印**。食べログ的 tier 就是「百名店」，
    // 而 guide 是「食べログ百名店」——直接串會變成「食べログ百名店 百名店 2025」。
    // 用 indexOf 而不是相等比較，因為披薩那份的 guide 是「食べログ百名店 ピザ」。
    var showTier=tier&&guide.indexOf(tier)<0;
    // 等級加粗**並且用「・」隔開**。一份米其林榜單裡「一つ星」與「ビブグルマン」
    // 是使用者唯一在意的差別，混在一長串日文裡會看不到。
    // ⚠️ 只靠一個半形空格不夠：徽章是 9.5px，兩個全形字之間的空格窄到看不出來，
    // 實測「ミシュランガイド東京ビブグルマン2026」會擠成一團（連年份都黏上去）。
    var html=esc(guide);
    if(showTier)html+=(html?'・':'')+'<b class="restaurant-tier">'+esc(tier)+'</b>';
    if(a.year)html+=(html?' ':'')+esc(String(a.year));
    return '<span class="restaurant-award" style="color:'+color+'"'
      +' aria-label="'+esc(t().restaurantAward)+'">'+html+'</span>';
  }).join('');
}

// 行程還原的唯一入口：`planEvents`／`orderStops`／行程地圖／匯出圖片／`?plan=`
// 分享連結全部經過它，所以景點與餐廳只要在這裡查得到就全部自動支援（決策 11）。
// 三份資料的 id 格式互不相同（活動是 12 碼 hex、景點是 pl- 開頭的 slug、
// 餐廳是 rs-l-／rs-d- 開頭），永不相撞。
// ⚠️ **餐廳回的是淺複本，不是 store.restaurants 裡那個物件本身**：同一家店可以同時是
// 午餐與晚餐（兩個不同的行程 id、同一筆資料），而下游（planRowHTML 的刪除鈕、
// 排序、匯出圖片）認的是 `ev.id`。回原物件的話兩者會共用同一個 id，
// **刪掉午餐會把晚餐一起刪掉**。複本只在查詢當下產生，一次 render 最多兩個。
// ===== 跨天行程（單位 J，2026-08-26）=====
// **目前這一天以外**，其他天已經排進去的 id → 那是第幾天（1-based）。
// 用途有兩個，而兩個都刻意**不含目前這一天**：
//   ① 三套推薦的候選池要濾掉它們（`plan-core.js`）——否則四天會推薦出同一個莫內展
//   ② 加入時擋下重複並說得出「已經排在第 N 天」（`plan-ui.js` 的 `addToPlan`）
// ⚠️ **不含目前這一天是關鍵**：只有一天時它回空物件，於是**單日行程的行為與跨天之前
//    逐項相同**。把目前這天也算進去的話，三套推薦會開始避開使用者剛加的站，
//    那是行為改變而不是新功能。
// ⚠️ **餐廳刻意跳過**（決策：活動與景點是「那天限定的事」，重複排就是錯；
//    而兩天都去同一家餐廳是合理的選擇，擋下來只會讓人覺得壞了）。
//    同一天內不可重複那條仍然有效，那是 `addToPlan` 既有的規則。
function otherDayIds(){
  var out={},days=store.trip.days,i,j,ids;
  for(i=0;i<days.length;i++){
    if(i===store.dayIdx)continue;
    ids=days[i].ids||[];
    for(j=0;j<ids.length;j++)if(!isFoodId(ids[j]))out[ids[j]]=i+1;
  }
  return out;
}
function evById(id){
  for(var i=0;i<store.events.length;i++)if(store.events[i].id===id)return store.events[i];
  for(var j=0;j<store.places.length;j++)if(store.places[j].id===id)return store.places[j];
  if(isFoodId(id)){
    var key=foodKey(id);
    for(var k=0;k<store.restaurants.length;k++){
      if(store.restaurants[k].id!==key)continue;
      var base=store.restaurants[k],out={};
      for(var f in base)out[f]=base[f];
      out.id=id;out.meal=foodMeal(id);
      return out;
    }
  }
  return null;
}
// 景點沒有任何日期欄位（H-24），這是判斷用的單一入口。
// **不要改成看 type**：type 是顯示語義，缺日期才是這些日期函式真正在意的事。
// ⚠️ **但餐廳也沒有日期**（單位 I），所以這裡必須把它排除掉——不排除的話
// `planRowHTML` 的景點分支（venue 去重、營業時間、跳過「已結束」）會整段誤觸發。
function isPlace(ev){return !!ev&&!ev.date_start&&ev.type!==FOOD_TYPE;}
// 餐廳判定。**看 type 而不是看缺哪個欄位**：它與景點的差別不在資料形狀
//（兩者都沒有日期），而在它是哪一大類。
function isRestaurant(ev){return !!ev&&ev.type===FOOD_TYPE;}
function hav(a,b,c,d){
  var R=6371,p=Math.PI/180,dla=(c-a)*p,dlo=(d-b)*p;
  var x=Math.sin(dla/2)*Math.sin(dla/2)
       +Math.cos(a*p)*Math.cos(c*p)*Math.sin(dlo/2)*Math.sin(dlo/2);
  return 2*R*Math.asin(Math.min(1,Math.sqrt(x)));
}
function ymd(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function addDays(s,n){var p=s.split('-');return ymd(new Date(+p[0],+p[1]-1,+p[2]+n));}
function dowOf(s){var p=s.split('-');return new Date(+p[0],+p[1]-1,+p[2]).getDay();}
// 「這個週末」：今天已是週末就用今天，否則取最近的週六。
// 原本規劃的「本週六／本週日」兩顆鈕在星期日會與「今天」完全重複（2026-08-02 實測）。
function weekendDate(){
  var t0=todayStr(),w=dowOf(t0);
  return (w===0||w===6)?t0:addDays(t0,6-w);
}
// ⚠️ 景點沒有日期欄位，`ev.date_start.split()` 會直接丟 TypeError（不是回 NaN）。
// 呼叫端 pickOne 拿它排序候選，景點一進抽選池就會炸掉整個 buildOptions()。
// 回 Infinity 代表「檔期無限長」——語義是對的，而且呼叫端的 `<=7` 判斷天生把它
// 排到短檔期後面，正是我們要的（景點天天都在，不該擠掉這天限定的活動）。
function spanDays(ev){
  if(isPlace(ev))return Infinity;
  var a=ev.date_start.split('-'),b=ev.date_end.split('-');
  return Math.round((new Date(+b[0],+b[1]-1,+b[2])-new Date(+a[0],+a[1]-1,+a[2]))/86400000)+1;
}

export { activeOn, addDays, awardsHTML, foodId, foodKey, planFoodIdOf, foodMeal, isFoodId, isPlace, isRestaurant, areaGroupsInOrder, geoMatch, areaLabel, bigImgUrl, groupLabel, groupOfArea, cssVar, curTheme, dateHTML, daysLeft, dowOf, esc, evById, fld, fmtDate, hav, hoursHTML, imgChain, isExpiring, isNew, locKnown, mapQuery, match, otherDayIds, pinColor, proxied, resetStyleCache, spanDays, syncThemeColor, t, todayStr, typeColor, typeLabel, venueKey, weekendDate, zoneOfArea };
