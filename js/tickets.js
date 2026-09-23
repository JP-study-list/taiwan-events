// 票券連結（單位 M，2026-09-02）。**只依賴共用層（config／store／util）**，
// 所以景點彈窗、景點詳情卡與行程列三處都能用它——同 `icons.js`／`favfood.js`／
// `credits.js` 的模子。⚠️ **它不可以 import 任何畫面模組**：`plan-ui` 已經 import
// 它，反過來就成環。
//
// 為什麼是一支模組而不是三段複製：「哪一筆商品要出現在畫面上」這條規則
// （挑主要那張、狀態壞掉的當作沒有、追蹤網址優先）三處講的是同一件事，
// 分三份寫必然漂移——同 `hoursHTML()`／`awardsHTML()` 收進共用層的理由。
//
// ⚠️ **資料形狀刻意不是「一個景點一個網址」**（那是 2026-08-19 的舊 `ticket_url`）。
// 同一個景點在同一家平台上就可能有好幾件商品（一般入場、快速通關、組合票），
// 一個欄位只裝得下一件，日後要展開就得把整批重抓一次。現在存得下全部、
// 畫面上只出一件，**兩邊都不必回頭重來**。
import { AFF_DISCLOSURE, AFF_IDS, AFF_REDIRECT, PLATFORMS } from './config.js';
import { store } from './store.js';
import { esc, t } from './util.js';

var sheet=document.getElementById('ticketSheet');
var sheetList=document.getElementById('ticketList');
var openFor=null;   // 目前這張中轉小卡是哪個景點的（null＝沒開）

function platformName(key){
  for(var i=0;i<PLATFORMS.length;i++)if(PLATFORMS[i].key===key)return PLATFORMS[i].name;
  // ⚠️ **認不得的平台照樣顯示出來**（顯示它的 key）。丟掉才是危險的：那條連結
  // 會從畫面上靜默消失，而資料裡明明有——沒有人會發現。同圖例對「管線有、
  // config 忘了補」的小類的處理：讓它排在最後，但看得見。
  return key||'';
}
function platformRank(key){
  for(var i=0;i<PLATFORMS.length;i++)if(PLATFORMS[i].key===key)return i;
  return PLATFORMS.length;   // 表上沒有的一律排在後面
}
// 票種只是一句顯示文字。**認不得就不印**，不要猜成「一般入場券」——
// 猜錯的話使用者會以為買到的是單館門票，而那正是組合票要講清楚的事。
function typeLabel(tk){
  var m=t().ticketTypes||{};
  return m[tk.type]||'';
}

// 一筆商品能不能拿來當購買入口。
// ⚠️ **三種「不能」要一起擋**：狀態不是 active（下架或還沒查）、兩個網址都空、
// 根本不是物件。少擋一種的後果都一樣——畫面上出現一顆按了是空頁面的鈕，
// 而那比沒有這顆鈕更糟（v3 §1-H 決策 25 就是為此把票券與官網拆成兩個欄位）。
function usable(tk){
  if(!tk||typeof tk!=='object')return false;
  if(tk.status&&tk.status!=='active')return false;
  return !!(tk.aff_url||tk.url);
}
// 實際要送使用者去的網址。三層，由具體到一般：
//   ① `aff_url` 逐筆填的（給「網址真的不一樣」的平台留的後路）
//   ② 有設定 `AFF_IDS[平台]` → 由乾淨網址自己組出聯盟連結
//   ③ 都沒有 → 就是乾淨的商品網址（裸連結，現況）
//
// ⚠️ **原始網址永遠留在資料裡**（資料層 `url`／`aff_url` 兩欄分開存）：
// 只留一個欄位的話，換成帶追蹤碼的那天就把原始網址整批覆蓋掉，
// 而日後要驗「這件商品還在不在」只剩那個網址可用。
// **也因為乾淨網址還在，Klook 兩種產生方式（`?aid=` 與後台的 redirect 網址）
// 永遠都換得回來**——那是同一個字串的兩種包裝，不是兩份資料。
// 這顆鈕長在哪裡。**只有這四個值**，而且刻意是 ASCII 短字串——它會進網址，
// 也會出現在 Klook 後台的報表上，中文與空白只會讓那份報表難讀。
//
// ⚠️ **不可以拿 `cls`（CSS class）當標籤**：那是外觀，改個樣式就會把計費報表
//    的分類一起改掉，而且沒有任何警訊。所以 `where` 是獨立的一個參數。
// ⚠️ 認不得就回 'other'**不要送空字串**——空的那一格在報表上跟「沒帶標籤」
//    分不出來，而那正是我們想知道的事（哪個位置有用）。
// ⚠️ **名字不可以叫 `label`**：`ticketBtnHTML` 裡有一個區域變數 `var label`
//    （按鈕上的文字）會遮蔽它，那一行就變成「把字串當函式呼叫」——
//    而 `node --check` 看不出來，只有真的按下去才會炸。
var WHERE_OK={popup:1,sheet:1,plan:1,pick:1};
function whereLabel(where){
  return WHERE_OK[where]?where:'other';
}
function linkOf(tk,where){
  if(tk.aff_url)return tk.aff_url;
  var url=tk.url||'';
  var id=AFF_IDS[tk.platform];
  if(!id||!url)return url;
  if(tk.platform==='klook'){
    // ⚠️ **`s.klook.com` 的短網址不會計算成效**，所以只認 www 那種；
    //    不是的話原樣送出去（寧可少賺，不要送出一個看起來有效卻追蹤不到的連結）。
    if(url.indexOf('//www.klook.com/')<0)return url;
    // 後台「方法 2」：經 affiliate.klook.com 轉址，可帶三個自訂標籤。
    // 以下四條是 Klook 官方 custom_tag_guide 的**硬性規定**（2026-09-02 逐條核對過）：
    //
    // ⚠️⚠️ **`k_site` 必須是整串網址的最後一個參數**（原文：Must be placed as the
    //    last query parameter in the entire URL）。**這是規定不是排版風格**——
    //    日後要加參數一律加在 `aff_label1` 後面、`k_site` 前面。接在後面會壞，
    //    而且很可能是靜默的。
    // ⚠️ **`k_site` 只支援 `www.klook.com`**（上面那道守門就是為此），且必須 URL 編碼。
    // ⚠️ **標籤組合有 2,000 個上限，超過會「靜默失效」**——原文說超額後任何新組合
    //    `will be ignored and treated as the default blank set`，**不會報錯，
    //    只是標籤變空的**。我們固定只有 4 個組合（見 WHERE_OK），佔 0.2%。
    //    **所以絕對不要把景點 id 那種「每筆一個值」的東西放進標籤**：
    //    177 個景點 × 4 個位置 = 708 個組合，一口氣吃掉 35% 配額。
    // ⚠️⚠️ **標籤禁止放使用者或事件層級的資料**（原文：not for tagging user or
    //    event-level data，且 `accounts demonstrating inappropriate usage may be
    //    denied`）——**這是會被停權的等級**。session id、使用者 id、時間戳、
    //    單次點擊編號一律不可以。我們放的是「版面位置」，正好是它說的 traffic source。
    //
    // ✅ **`aff_label2`／`aff_label3` 省略是官方寫法**：文件自己的三個範例
    //    （首頁側欄／EDM／QR code）都沒有 `aff_label3`，配額那段也明講 `aff_label3=`
    //    空值算一個合法組合。實測後台收到的正是「標籤1: popup／標籤2:（空）」。
    // 實測那一跳會回 302 並在目標網址補上 `aff_klick_id`（＝點擊已被登記）
    // 與 `aff_adid`／`utm_campaign`，同時種一個 `kepler_id` cookie。
    // ⚠️ **標籤不會回顯在轉址目標上**，所以「它到底有沒有進後台」**只有後台看得到**
    //    ——這是本站唯一驗不了的一環，別以為連結會了就代表標籤也記到了。
    //    失敗方向是安全的：最壞情況是標籤被忽略，`aid` 照樣計佣金。
    if(AFF_REDIRECT){
      return 'https://affiliate.klook.com/redirect?aid='+encodeURIComponent(id)
        +'&aff_label1='+encodeURIComponent(whereLabel(where))
        +'&k_site='+encodeURIComponent(url);
    }
    // 後台「方法 3」：網址直接加 `?aid=`。少一次轉址，滑過去看到的就是 klook.com。
    return url+(url.indexOf('?')>-1?'&':'?')+'aid='+encodeURIComponent(id);
  }
  // ⚠️ **其他平台沒有規則就原樣送出**，絕不憑印象猜一個參數名——
  // 猜錯的結果是「連結正常、佣金全部算不到」，而畫面上完全看不出來。
  return url;
}

// 每個平台只留一件：標了 `primary` 的那件，沒標就是第一件可用的。
// 排序照 `PLATFORMS`，表上沒有的接在後面。
// ⚠️ **同一個平台的多件商品現在會全部列出來**（2026-09-02 使用者要求，原本是
// 「每個平台只出一件」）。理由很具體：晴空塔的單塔票與「晴空塔 × 墨田水族館」
// 組合票是**兩件不同的商品**，只出一件等於幫使用者決定他要買哪一種。
//
// ⚠️ **連帶：`name` 從選填變成幾乎必填。** 兩件並列時，若兩件的 `type` 又相同
// （東京國立博物館那兩件都是一般入場），畫面上會出現兩行一模一樣的
// 「Klook・一般入場券」——**看起來像重複的 bug，而其實是兩件不同的商品**。
// 勾選網頁對「留下兩件」的情況會要求填名稱，就是為了這件事。
//
// ⚠️ **`primary` 的意思跟著變了**：以前是「哪一件會出現」，現在是「哪一件排最前面」。
// `clean_tickets()` 那道「同一平台只能有一件 primary」仍然成立、也仍然需要——
// 兩件都標的話順序會變成看資料順序而定，那是一個「看起來正常但每次可能不一樣」的結果。
function mainTickets(rec){
  var list=(rec&&rec.tickets)||[],out=[];
  for(var i=0;i<list.length;i++)if(usable(list[i]))out.push(list[i]);
  // 平台之間照 PLATFORMS 的順序；同一平台內 primary 排前面。
  // ⚠️ 其餘維持資料裡的順序（`Array.sort` 是穩定的）——資料的順序是人在
  // 勾選網頁上決定的，不要再自己重排。
  out.sort(function(a,b){
    var d=platformRank(a.platform)-platformRank(b.platform);
    return d?d:(b.primary?1:0)-(a.primary?1:0);
  });
  return out;
}

// 三處共用的那顆鈕。`cls` 讓呼叫端指定外觀（行程列是 `ticket`，彈窗與詳情卡
// 走 `.places-links` 裡的純文字連結），行為完全一樣。
//
// - 一件以上 → 一律 `<button>`，點了跳中轉小卡（**一家平台也一樣**，2026-09-02
//              使用者改的決定，理由見下方函式內的說明）
// - 零件    → 回空字串，**整顆不出現**（不做成灰掉的死鈕）
//
// ⚠️ 外連一律 `target="_blank"`：全螢幕模式沒有網址列，就地導航會把使用者
// 關在外部網站出不來（地雷 #13）。`rel` 帶 `sponsored`——AID 已經填了
// （`AFF_IDS.klook`），所以那些連結現在真的是聯盟連結。
function ticketBtnHTML(rec,cls,where){
  var picks=mainTickets(rec);
  if(!picks.length)return '';
  var c=cls||'';
  // ⚠️ **一律是 `<button>`，即使只有一家平台**（2026-09-02 使用者改的決定）。
  //
  // 原本是「一家＝直接 `<a>`、兩家以上才跳小卡」，理由是「一家的時候跳小卡等於
  // 每次買票都多按一下，而那一下沒有給使用者任何選擇」。**現在推翻它，換來的是：
  // 廣告標示只需要存在一個地方。**
  //
  // ⚠️ 那正是 2026-09-02 那個洞的根因——標示做在小卡裡，而現實中每一筆票券都只有
  //    一家平台，於是**每一顆鈕都走另一條沒有標示的路**。一條路就沒有「漏接一條」
  //    這回事，而法規標示是最不該靠「記得兩邊都改」的東西。
  //
  // ⚠️ **所以 `#ticketAd` 從此是站上唯一的廣告標示，不可以拿掉、也不可以改成
  //    只在多家平台時顯示。** 動它之前先回來讀這一段。
  //
  // ⚠️ 代價是這顆鈕不再是連結：沒有 JS 就沒有作用。本站是 ES Modules，
  //    JS 掛掉的話整頁本來就不會 render，所以沒有退步——但別把它搬到靜態頁面上。
  return '<button type="button"'+(c?' class="'+c+'"':'')
    +' data-ticket="'+esc(rec.id)+'" data-where="'+esc(whereLabel(where))+'">'
    +esc(t().ticket)+'</button>';
}

// ===== 選擇平台的小卡 =====
// **每一次按查票都會看到它**（2026-09-02 起，含只有一家平台的情況）。
// 它現在同時是「選平台」與「揭露這是廣告」兩件事的落腳處，而後者是法規義務——
// 見 ticketBtnHTML 那一段說明為什麼寧可多按一下。
function rowHTML(tk,where){
  var ty=typeLabel(tk);
  var nm=tk.name||'';
  return '<a class="ticket-row" href="'+esc(linkOf(tk,where))+'"'
    +' target="_blank" rel="sponsored noopener noreferrer">'
    +'<span class="ticket-row-main">'
      +'<span class="ticket-row-p">'+esc(platformName(tk.platform))+'</span>'
      +(ty?'<span class="ticket-row-t">'+esc(ty)+'</span>':'')
    +'</span>'
    +(nm?'<span class="ticket-row-n">'+esc(nm)+'</span>':'')
    +'</a>';
}
function openTicketSheet(rec,where){
  var picks=mainTickets(rec);
  // ⚠️ **一件也要開**（2026-09-02）。舊版是 `<2 return`，配合「一家走直接連結」；
  //    現在入口只有一條路，這裡擋掉的話那顆鈕會變成按了沒反應。
  if(!picks.length)return;
  openFor=rec.id;
  document.getElementById('ticketH').textContent=t().ticketPick;
  // ⚠️ `map(rowHTML)` 會把索引當第二個參數傳進去（＝`where` 變成 0、1…），
  //    所以一定要包一層。這種錯不會報錯，只會讓標籤全部變成 'other'。
  sheetList.innerHTML=picks.map(function(tk){return rowHTML(tk,where);}).join('');
  // 廣告標示。**現在整行不存在**（裸連結不是廣告，v3 §1-H 決策 5），
  // 換成帶追蹤碼的那天把 config 的 AFF_DISCLOSURE 打開就會出現在這裡。
  var ad=document.getElementById('ticketAd');
  ad.textContent=AFF_DISCLOSURE?t().ticketAd:'';
  ad.hidden=!AFF_DISCLOSURE;
  document.getElementById('ticketCancel').textContent=t().placesCancel;
  sheet.hidden=false;
  document.addEventListener('keydown',onKey);
}
function closeTicketSheet(){
  if(!sheet||sheet.hidden)return;
  sheet.hidden=true;openFor=null;
  document.removeEventListener('keydown',onKey);
}
// 監聽器只在開著的時候掛（同 tour.js 的做法），關掉就收——
// 常駐一個全域 Escape 會跟日後別的彈窗搶同一個按鍵。
function onKey(e){if(e.key==='Escape')closeTicketSheet();}

// 三處的鈕**共用一個委派監聽器**掛在 document 上。理由是那三處的 DOM 都會被
// 整段 innerHTML 換掉（彈窗 setContent、詳情卡重畫、行程列 renderPlan），
// 直接掛在按鈕上重畫一次就失效（同 buildLegend／mapswitch 那條）。
document.addEventListener('click',function(e){
  var b=e.target.closest?e.target.closest('[data-ticket]'):null;
  if(!b)return;
  var id=b.getAttribute('data-ticket'), where=b.getAttribute('data-where')||'';
  // 記錄一律從 `store.places` 查（票券目前只長在景點上）。查不到就什麼都不做，
  // 那只會發生在資料還沒載完的時候，而那時這顆鈕根本畫不出來。
  for(var i=0;i<store.places.length;i++){
    if(store.places[i].id===id){openTicketSheet(store.places[i],where);return;}
  }
});
if(sheet){
  // 點背景關掉（同日期小卡）。⚠️ 比對 `e.target===sheet` 而不是 closest——
  // 不然點在卡片內部的空白處也會關掉。
  sheet.addEventListener('click',function(e){if(e.target===sheet)closeTicketSheet();});
  document.getElementById('ticketCancel').addEventListener('click',closeTicketSheet);
  // 選了平台就把小卡收掉：連結是 target="_blank"，回到這一頁時不該還蓋著一張卡。
  sheetList.addEventListener('click',function(e){
    if(e.target.closest('.ticket-row'))closeTicketSheet();
  });
}

// ⚠️ **`linkOf` 只有 `test_tickets.mjs` 在外面用**（畫面上它只被同檔的 `rowHTML` 呼叫）。
// export 它是刻意的：Klook 官方那四條硬性規定（`k_site` 必須在最後、只認 www、
// 要 URL 編碼、標籤不可放使用者層級資料）**違反時全部是靜默的**——連結照樣打得開、
// 頁面照樣是對的商品，只是佣金算不到或帳號被停權。站上沒有任何地方看得出來，
// 而唯一能守住它的東西就是那支測試。**要測就得呼叫得到真正的那個函式**，
// 在測試裡照著規則重寫一份等於自己跟自己對答案（同「不要複製一份邏輯」那條）。
export { closeTicketSheet, linkOf, mainTickets, ticketBtnHTML };
