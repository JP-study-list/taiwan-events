// 網頁導覽（設定 → 網頁導覽）。**17 步：清單 5 → 地圖入口 1 → 地圖 2 →
// 行程入口 1 → 行程 7 → 結尾。**
// 第一批（清單）2026-08-21 上線，第二批（地圖與行程）同日接上，
// 第三批（上一步／下一步箭頭 + 兩個「入口」步驟）同日再接。
//
// ⚠️ **兩個「入口」步驟的場景刻意是 list。** 它們要指的東西（右上角地圖鈕、
// 分頁列的行程）都會被全螢幕覆蓋層（z-index 1000）蓋掉，站在目的地那個畫面上
// 根本指不到。先退回清單指給人看，下一步才真的走進去——順序因此與真人操作一致。
//
// ⚠️ **總步數一律取 STEPS.length，絕不寫死。** 第一批只有 6 步時若寫死 15，
// 使用者會走到「6/15」就結束——功能是好的，但看起來像壞掉。
//
// ⚠️ 四件事碰之前先想清楚（決策紀錄見 progress.md 第九十七、九十八筆）：
// ① **目標每一步當場用選擇器重找，不可抱著節點。** 分類列、卡片、行程頁全都是
//    innerHTML 整段重畫的，抱著舊節點的話高亮框會停在原地或框到空氣——偶發、不報錯、很難查。
// ② **導覽期間不可點真的 UI**，只能按「下一步」。放行的話使用者隨手一點畫面就變了，
//    後面每一步高亮的位置全部歪掉。遮罩因此要吃掉點擊。
// ③ **進場先把篩選暫存並清空、離場還原。** 使用者可能先搜尋過，那時卡片區可能是空的，
//    「收藏星」那一步就沒有東西可以指。篩選不寫進裝置，所以還原很單純。
// ④ **行程示範全程不寫 localStorage**（store.sandbox）。做成「不寫」而不是
//    「離場再還原」是刻意的：使用者中途關掉分頁時沒有任何程式在跑，還原救不了他。
import { store } from './store.js';
import { clearGeo } from './geofilter.js';
import { t, todayStr } from './util.js';
import { buildAreaSel, buildSideChips, closeFilter, openFilter, render, tabAll, tabFav } from './cards.js';
import { closeMapView, openMapView } from './map.js';
import { closePlan, openPlan } from './plan-ui.js';

var view=document.getElementById('tourView');
var hole=document.getElementById('tourHole');
var box=document.getElementById('tourBox');
var elN=document.getElementById('tourN');
var elH=document.getElementById('tourH');
var elP=document.getElementById('tourP');
var btnNext=document.getElementById('tourNext');
var btnPrev=document.getElementById('tourPrev');
// 「下一步」那顆在最後一步要變回文字「完成」，所以它裡面同時放著 svg 與 span，
// 由按鈕上的 .done 這個 class 決定誰出現。
// ⚠️ **絕不可用 btnNext.textContent 寫它**——那會把 svg 一起清掉，
// 之後每一步都只剩一顆空白的框，而且不會有任何錯誤訊息。
// ⚠️ **也不要改成 svg.hidden=true**：hidden 是 HTMLElement 的屬性，SVGElement 沒有，
// 賦值不會有任何效果，但讀回來是 true——測試會放行，畫面上卻是箭頭與文字並排。
var txtNext=document.getElementById('tourNextTxt');
var btnEnd=document.getElementById('tourEnd');

// 步驟文案**中日各一份，寫在這裡不放 config.js 的 T**：導覽的句子比介面標籤長太多，
// 塞進去會讓那張對照表難讀。介面用字（「下一步」「結束導覽」）仍在 T，因為 applyLang 要換它們。
//
// `sel` 是選擇器陣列（多個時取聯集當高亮範圍）；`null` 代表這一步不指任何東西
// （開場與結尾兩張卡片）。
// `scene` 是這一步要站在哪個畫面上（list／sheet／map／plan），換場由 SCENES 負責。
// `act` 在進入這一步時跑一次，用來讓畫面真的動（採用一套行程、展開自己組）。
var STEPS=[
  { sel:null,
    zh:{h:'歡迎使用寄道日和・台灣',
        p:'這裡幫你找台灣的展覽、祭典與活動，還能把一天的行程排好。花一分鐘帶你看一遍。'},
    ja:{h:'寄道日和・台湾へようこそ',
        p:'台湾の展覧会・祭り・イベントが探せて、一日のプランまで組めます。1 分ほどでご案内します。'} },

  { sel:['.tabbar'],
    zh:{h:'這個網站分五塊', p:'由左至右：活動、收藏、行程、餐廳、景點。'},
    ja:{h:'サイトは 5 つ', p:'左から、イベント・お気に入り・プラン・レストラン・スポット。'} },

  { sel:['.searchbar','.typebar'],
    zh:{h:'找到你想看的',
        p:'直接搜尋，或用上面的分類。最前面那顆「篩選」還能挑時間、地區與排序。'},
    ja:{h:'見たいものを探す',
        p:'検索するか、上のジャンルから。先頭の「絞り込み」で期間・エリア・並び順も選べます。'} },

  { sel:['#cards .fav'],
    zh:{h:'喜歡的先收起來', p:'點一下星星就收藏，之後在「收藏」分頁隨時找得到。'},
    ja:{h:'気になったら保存', p:'星をタップするとお気に入りに入り、「お気に入り」タブでいつでも見られます。'} },

  // 「離我最近」在篩選彈窗的排序那一段，所以這一步的場景是 sheet。
  // 導覽層 z-index 高於彈窗，蓋得住；彈窗自己那層遮罩則由 body.tour-on 關掉，
  // 否則兩層疊起來會暗得過頭。
  { sel:['#sideSort .side-chip[data-v="near"]'], scene:'sheet',
    zh:{h:'照距離排序',
        p:'設定一個常出發的地方，活動就會由近而遠排。位置只留在這台裝置，不會上傳，也不會出現在分享連結裡。'},
    ja:{h:'近い順に並べる',
        p:'よく出発する場所を設定すると、近い順に並びます。位置はこの端末にのみ保存され、送信も共有もされません。'} },

  // ===== 地圖（入口 1 步 + 地圖 2 步）=====
  // ⚠️ **這一步的場景是 list 不是 map**：地圖鈕在頂欄，地圖打開之後那顆就被覆蓋層
  // （z-index 1000）蓋住了，指不到。所以先退回清單指給人看，下一步才真的走進去。
  // 使用者 2026-08-21 的原話：「先聚焦在右上角的地圖，讓人知道要點地圖，不會太突然進去。」
  { sel:['#mapBtn'], scene:'list',
    zh:{h:'想看地圖就按這裡', p:'右上角這顆會把所有活動畫在地圖上，適合先看有哪些在附近。'},
    ja:{h:'地図はここから', p:'右上のボタンで、すべてのイベントを地図に表示します。近くで何があるか探すのに便利です。'} },

  // ⚠️ **這一步一定要先把圖例展開**（2026-08-27 起分類段預設是收合的）。
  // 不展開的話高亮框裡只有一行「活動分類 6」，而文案講的是那六個顏色與圖示
  // ——**看起來完全正常，只是文不對題**，而且沒有任何錯誤訊息。
  { sel:['#mapLegend'], scene:'map', act:openMapLegend,
    zh:{h:'地圖上一眼看出在哪裡',
        p:'六種分類各有自己的顏色與圖示。半透明的圖釘代表只知道大概位置。'},
    ja:{h:'地図で場所をつかむ',
        p:'6 つのジャンルにそれぞれ色とアイコン。半透明のピンはおおよその位置です。'} },

  // 叢集圓圈是 markercluster 非同步分批加進來的，所以這一步很依賴 waitFor 的重找。
  // **指最大的那一顆**，不要用 querySelector 拿 DOM 上的第一顆——那多半是北關東
  // 某個「6」，而這一步要講的正是「數字愈大愈熱鬧」，指小的等於自己削弱例子。
  { sel:[biggestCluster], scene:'map',
    zh:{h:'圓圈裡的數字',
        p:'那一帶有幾個活動。點一下就散開，放大地圖也會自動分開。'},
    ja:{h:'丸の中の数字',
        p:'その辺りのイベント数です。タップすると広がり、拡大しても自動で分かれます。'} },

  // ===== 行程（入口 1 步 + 行程 7 步）=====
  // ⚠️ **場景是 list**，理由同地圖入口那步、而且更硬：分頁列是 z-index 800，
  // 地圖覆蓋層是 1000——**地圖開著的時候分頁列根本看不見**（地雷 #18 那條的另一面）。
  // 所以這一步會先把地圖收掉、回到清單，走出來的順序才跟真人操作一樣：
  // 關掉地圖 → 分頁列露出來 → 指著「行程」 → 進去。
  { sel:['#tabPlan'], scene:'list',
    zh:{h:'行程在這一頁', p:'從下面的分頁列進去，選一天就能開始排。'},
    ja:{h:'プランはこのタブ', p:'下のタブから入って、日付を選べば組み始められます。'} },

  // 這一段全程在沙盒裡：使用者原本的行程原封不動，示範用的是一份空的今日行程。
  // ⚠️ 月曆自 2026-08-27 起是**區間選擇**（點起日、點結束日）。文案若還停在「挑別天」，
  //    高亮框框住的東西與說的話就對不起來——文不對題但完全不報錯（同第 7 步的教訓）。
  { sel:['#planQuick','#dateFold'], scene:'plan',
    zh:{h:'行程從選日期開始', p:'今天、明天、這個週末，或展開月曆，點起日與結束日就能一次排好幾天。'},
    ja:{h:'プランはまず日付から', p:'今日・明日・今週末。カレンダーを開いて開始日と終了日を選べば、数日分をまとめて組めます。'} },

  // ⚠️ **指第一張卡，不要指整個 #pcards。** 三張卡疊起來比一整個畫面還高，
  // 那時「洞」等於整片螢幕、一點都沒有壓暗，高亮完全失去意義（320×568 實拍確認）。
  // 文案因此明講「這是第一套，往下還有兩套」——底下那兩張是暗的但看得見。
  { sel:['#pcards .pcard'], scene:'plan',
    zh:{h:'三套排好的行程',
        p:'區域與節奏都不一樣：悠閒兩站、標準三站、充實四站。這是第一套，往下還有兩套。'},
    ja:{h:'3 つのプランを用意',
        p:'エリアもペースも別々。ゆったり 2 か所・標準 3 か所・しっかり 4 か所。これは 1 つ目、下にあと 2 つあります。'} },

  { sel:['#planShuffle'], scene:'plan',
    zh:{h:'不喜歡就換一批', p:'每次都從當天的活動裡重新抽，按到滿意為止。'},
    ja:{h:'気に入らなければ引き直し', p:'その日のイベントから毎回選び直します。納得いくまでどうぞ。'} },

  { sel:['#pcards .pcard-f button'], scene:'plan',
    zh:{h:'選定就按採用', p:'這套就會變成你的行程。'},
    ja:{h:'決めたら「採用」', p:'このプランがあなたのプランになります。'} },

  // ⚠️ 這一步的 act 會**真的按下「採用」**（走真的那條路：adoptOption → savePlan → renderPlan），
  // 只是 savePlan 被沙盒擋住。不真的按的話，下一句「這就是你的行程」底下是一片空的。
  { sel:['#planList'], scene:'plan', act:adoptFirst,
    zh:{h:'這就是你的行程',
        p:'站與站之間標了距離，還能直接查怎麼去。想拿掉某一站就按右邊的 ✕。'},
    ja:{h:'これがあなたのプラン',
        p:'各スポット間の距離と行き方が出ます。外したい場所は右の ✕ で削除できます。'} },

  { sel:['#areaPick'], scene:'plan', act:openSelf,
    zh:{h:'也可以自己挑',
        p:'選一個地區，就會列出當天有什麼活動，還有那一帶的常設景點可以加進來。'},
    ja:{h:'自分で選ぶこともできます',
        p:'エリアを選ぶとその日のイベントが並び、近くの定番スポットも追加できます。'} },

  { sel:['#planImg','#planShare'], scene:'plan',
    zh:{h:'帶著走',
        p:'存成一張圖，或複製連結傳給同行的人——他打開就看得到同一份行程。'},
    ja:{h:'持ち歩く',
        p:'画像として保存するか、リンクをコピーして同行者に送れば同じプランが開けます。'} },

  { sel:null,
    zh:{h:'就這樣，開始逛吧', p:'隨時可以從右上角的齒輪重新看這份導覽。'},
    ja:{h:'準備完了です', p:'右上の歯車からいつでも見直せます。'} }
];

var PAD=8;              // 高亮框比目標大一圈，讓它不緊貼著內容
var GAP=16;             // 文字框與高亮框之間的距離
var WAIT_FRAMES=40;     // 目標最多等幾幀（約 0.7 秒）
var SCENE_SETTLE=220;   // 換場之後先等一下再找目標（見下方說明）
var cur=-1;
var seq=0;              // 每次 show() 遞增：換場等待期間按了下一步時，舊的排程自己作廢
var saved=null;         // 進場前的篩選狀態，離場時原樣還原
var demo=null;          // 行程示範的沙盒：原本的行程收在這裡

// ===== 場景 =====
// 每一步宣告自己站在哪個畫面上，換場時關掉舊的、打開新的。
// **地圖與行程頁都是 z-index 1000 的全螢幕覆蓋層，導覽層是 1400，蓋得住。**
var SCENES={
  list:{},
  sheet:{enter:openFilter,leave:closeFilter},
  map:{enter:openMapView,leave:closeMapView},
  plan:{enter:enterPlan,leave:leavePlan}
};
var scene='list';
function setScene(to){
  if(to===scene)return false;
  var from=SCENES[scene];
  if(from&&from.leave)from.leave();
  scene=to;
  var s=SCENES[to];
  if(s&&s.enter)s.enter();
  return true;
}

// ===== 行程示範的沙盒 =====
// ⚠️ **示範一律從乾淨的空行程開始。** 使用者已經排滿 4 站的話，「採用」按下去
// 畫面不會有任何動靜，那兩步等於白講。
// ⚠️ **原本的行程只存在記憶體裡，而且全程不寫 localStorage**（store.sandbox）。
// 所以中途關掉分頁也不會有事——沒寫過就沒有東西要救。
function enterPlan(){
  var body=document.getElementById('selfBody');
  // ⚠️ **收起來的必須是整趟（store.trip），不是 store.plan**（單位 J，2026-08-26）。
  // `store.plan` 只是「目前那一天」的存取器——存它再還原回去，會把使用者排了好幾天的
  // 旅程**塌成一天，其餘幾天靜默消失**，而畫面上看起來完全正常。
  demo={trip:store.trip,dayIdx:store.dayIdx,ro:store.planRO,sel:store.planSel,
        opts:store.planOpts,far:store.planFar,
        self:body.classList.contains('open')};
  store.sandbox=true;
  store.planRO=false;                       // 分享連結進來的唯讀模式下也要示範得動
  store.trip={days:[{date:todayStr(),ids:[]}]};store.dayIdx=0;
  store.planSel=-1;store.planOpts=[];store.planFar=false;
  openPlan();                               // planOpts 是空的，openPlan 會自己重算三套
}
function leavePlan(){
  closePlan();
  if(!demo)return;
  var body=document.getElementById('selfBody'),h=document.getElementById('selfFold');
  body.classList.toggle('open',demo.self);  // 「自己組」的收合狀態也要還原
  h.setAttribute('aria-expanded',demo.self?'true':'false');
  store.trip=demo.trip;store.dayIdx=demo.dayIdx;
  store.planRO=demo.ro;store.planSel=demo.sel;
  store.planOpts=demo.opts;store.planFar=demo.far;
  store.sandbox=false;
  demo=null;
}
// **按的是真的那顆按鈕**，不另外複製一份採用邏輯——那裡有 PLAN_MAX 與 store.planSel
// 要處理，複製一份必然漂移。已經有站點時不重按（使用者往回走不會再觸發一次）。
function adoptFirst(){
  if(store.plan.ids.length)return;
  var b=document.querySelector('#pcards .pcard-f button');
  if(b)b.click();
}
// 地圖圖例的分類段（2026-08-27 起預設收合）。**直接設 `open` 而不是 click summary**：
// summary 的點擊會被導覽的遮罩吃掉（規則②：導覽期間不可點真的 UI）。
// 展開狀態記在 `map.js` 的模組變數裡、**不進 localStorage**，所以導覽結束後
// 使用者這一輪看到的圖例是開著的，重整就回到預設收合——不必在離場時還原。
function openMapLegend(){
  var d=document.querySelector('#mapLegend details.legend-genres');
  if(d&&!d.open)d.open=true;
}
function openSelf(){
  var body=document.getElementById('selfBody'),h=document.getElementById('selfFold');
  if(body.classList.contains('open'))return;
  body.classList.add('open');
  h.setAttribute('aria-expanded','true');
}

// ===== 目標 =====
// 回 null＝這一步本來就不指任何東西；回空陣列＝該指的東西**不在畫面上**（要跳過）。
// 兩者不可混為一談：前者是正常的卡片，後者是缺角。
// `sel` 的每一項可以是選擇器字串，也可以是**自己挑一個節點回來的函式**
// （叢集圓圈那步要挑最大的那一顆，選擇器辦不到）。
function targets(s){
  if(!s.sel)return null;
  var out=[];
  s.sel.forEach(function(q){
    var e=(typeof q==='function')?q():document.querySelector(q);
    if(e)out.push(e);
  });
  return out;
}
// 地圖上數字最大的那顆叢集圓圈。找不到就回 null（那一步會被跳過，不會高亮到空氣）。
function biggestCluster(){
  var best=null,bn=-1;
  var all=document.querySelectorAll('#map .cl');
  for(var i=0;i<all.length;i++){
    var n=parseInt(all[i].textContent,10)||0;
    if(n>bn){bn=n;best=all[i];}
  }
  return best;
}
// 目標可能還沒生出來：叢集圓圈是 markercluster 非同步分批加進地圖的，
// 行程頁的內容也要等 renderPlan 跑完。所以最多重找 WAIT_FRAMES 幀再放棄。
function waitFor(s,n,cb){
  var els=targets(s);
  if(!els||els.length===s.sel.length||n>=WAIT_FRAMES)return cb(els);
  requestAnimationFrame(function(){waitFor(s,n+1,cb);});
}
function union(els){
  var r=els[0].getBoundingClientRect();
  var o={top:r.top,bottom:r.bottom,left:r.left,right:r.right};
  els.forEach(function(e){
    var b=e.getBoundingClientRect();
    o.top=Math.min(o.top,b.top); o.bottom=Math.max(o.bottom,b.bottom);
    o.left=Math.min(o.left,b.left); o.right=Math.max(o.right,b.right);
  });
  return o;
}

// ===== 定位 =====
// 每次都重新查一次目標（規則①），所以捲動與轉向時直接再叫一次就好。
function place(){
  if(cur<0)return;
  var s=STEPS[cur];
  var els=targets(s);
  if(!els){                       // 開場／結尾：洞縮成 0×0（畫面仍全暗），方框置中
    hole.className='tour-hole none';
    // ⚠️ **inline style 一定要清掉，光加 class 沒有用**：上一步是直接寫
    // hole.style.width／height 的，inline 永遠贏過 .tour-hole.none 那條 CSS。
    // 少了這一行，結尾那張卡片上會留著上一步那個洞——遮罩中間橫著一條亮帶，
    // 而它看起來只是「畫面怪怪的」，不像壞掉（2026-08-21 第二批實拍抓到）。
    hole.style.top=hole.style.left=hole.style.width=hole.style.height='';
    box.style.top=Math.max(GAP,(window.innerHeight-box.offsetHeight)/2)+'px';
    return;
  }
  if(!els.length)return;
  var r=union(els), vh=window.innerHeight, bh=box.offsetHeight;
  // 文字框自動避開目標：哪一側塞得下就放哪一側，兩側都塞不下就選空間大的那側。
  // **不要改成固定在底部**——第一個目標就是畫面最底下的分頁列，會被直接蓋住。
  var roomA=r.top-PAD-GAP, roomB=vh-(r.bottom+PAD+GAP);
  var below=(roomB>=bh)?true:((roomA>=bh)?false:(roomB>roomA));
  var top=below?(r.bottom+PAD+GAP):(r.top-PAD-GAP-bh);
  top=Math.max(GAP,Math.min(top,vh-bh-GAP));
  box.style.top=top+'px';
  // ⚠️ **目標比畫面還高時（行程那一段在 320×568 上就是），兩側都塞不下文字框。**
  // 這時**裁掉洞被文字框壓住的那一段**，而不是讓文字框蓋在內容上——
  // 蓋住的話使用者正在被介紹的那一列有一半看不到，而畫面看起來只是「有點擠」。
  var t0=r.top-PAD, b0=r.bottom+PAD;
  if(top<b0&&top+bh>t0){
    if(below)b0=Math.min(b0,top-GAP); else t0=Math.max(t0,top+bh+GAP);
  }
  hole.className='tour-hole';
  hole.style.top=t0+'px';
  hole.style.left=(r.left-PAD)+'px';
  hole.style.width=(r.right-r.left+PAD*2)+'px';
  hole.style.height=Math.max(0,b0-t0)+'px';
}

// 捲動與轉向時重新定位。**刻意不鎖 body 捲動**：iOS 上的捲動鎖有自己的坑，
// 而重新定位既簡單又不會有那些副作用。
// ⚠️ 捲動要用**捕獲階段**監聽 document：行程頁的內容是在 .planbody 裡面捲的，
// 而 scroll 事件不會冒泡到 window——只聽 window 的話，行程頁一捲高亮框就留在原地。
var pending=false;
function onMove(){
  if(pending)return;
  pending=true;
  requestAnimationFrame(function(){pending=false;place();});
}

// ===== 步進 =====
// dir：1＝往前、-1＝往回。**方向要一路帶到 paint()**，理由見那裡。
function show(i,dir){
  var s=STEPS[i],my=++seq;
  dir=dir||1;
  var moved=setScene(s.scene||'list');
  if(s.act)s.act();
  // 換場之後先讓畫面安定下來再找目標：地圖那邊 renderMap() 有一個 80ms 的
  // invalidateSize，會在我們量完之後把圖釘整批位移——高亮框就框到空氣了。
  var go=function(){
    if(my!==seq)return;                      // 等待期間使用者又按了下一步／結束
    waitFor(s,0,function(els){
      if(my!==seq)return;
      paint(i,s,els,dir);
    });
  };
  if(moved)setTimeout(go,SCENE_SETTLE); else go();
}
function paint(i,s,els,dir){
  dir=dir||1;
  // 該指的東西不在畫面上 → 跳過，不要高亮到空氣。
  // ⚠️ **跳的方向要跟著使用者走的方向**。一律 i+1 的話，往回走時會被彈回原來那一步，
  // 症狀是「按了上一步完全沒反應」——而且它只在某幾步偶發，很難查。
  if(els&&!els.length){
    var j=i+dir;
    if(j>=0&&j<STEPS.length)return show(j,dir);
    return (dir<0)?show(0,1):end();                // 往回走到頭就停在第一步
  }
  cur=i;
  var last=(i===STEPS.length-1);
  var L=s[store.lang]||s.zh;
  elH.textContent=L.h;
  elP.textContent=L.p;
  elN.textContent=(i+1)+'/'+STEPS.length;          // 總步數取實際長度，不寫死
  // 最後一步的右鈕變回文字「完成」：箭頭看不出「按了會結束」。切的是 hidden 不是文字。
  btnNext.classList.toggle('done',last);
  txtNext.textContent=t().done;
  btnNext.setAttribute('aria-label',last?t().done:t().tourNext);
  btnPrev.setAttribute('aria-label',t().tourPrev);
  // 第一步沒有上一步。**停用而不是隱藏**——隱藏的話右箭頭會跳一次位置。
  btnPrev.disabled=(i===0);
  btnEnd.textContent=t().tourEnd;
  btnEnd.hidden=last;                              // 最後一步只剩「完成」，不必再給結束
  if(els&&!inView(els)){
    els[0].scrollIntoView({block:'center'});
    requestAnimationFrame(function(){requestAnimationFrame(place);});
  }else place();
}
function inView(els){
  var r=union(els);
  return r.top>=0&&r.bottom<=window.innerHeight;
}
function next(){
  if(cur+1<STEPS.length)show(cur+1,1); else end();
}
// 上一步。cur 為 0 時按鈕本來就是停用的，這裡再擋一次（鍵盤或程式呼叫也走這條）。
function prev(){
  if(cur>0)show(cur-1,-1);
}

// ===== 進場與離場 =====
function startTour(){
  // 進場前置：切回「全部」、捲到最上方、把篩選暫存並清空（規則③）
  saved={state:Object.assign({},store.state),kw:document.getElementById('kw').value};
  store.state.type={};store.state.date='all';store.state.sort='default';
  clearGeo(store.state.area);store.state.kw='';store.state.view='list';
  store.state.onlyNew=false;store.state.onlySoon=false;
  document.getElementById('kw').value='';
  syncTabs();buildSideChips();buildAreaSel();render();
  window.scrollTo(0,0);

  document.body.classList.add('tour-on');
  view.hidden=false;
  document.addEventListener('scroll',onMove,{passive:true,capture:true});
  window.addEventListener('resize',onMove);
  document.addEventListener('keydown',onKey);
  show(0,1);
}
function end(){
  seq++;                    // 讓還在等目標的排程自己作廢
  cur=-1;
  view.hidden=true;
  document.body.classList.remove('tour-on');
  setScene('list');         // 把地圖／行程頁收掉，沙盒也在這裡還原
  window.removeEventListener('resize',onMove);
  document.removeEventListener('scroll',onMove,{capture:true});
  document.removeEventListener('keydown',onKey);
  restore();
}
// 還原成進場前的樣子。整份 store.state 逐鍵寫回（不可整個換掉，其他模組抓著同一個物件）。
function restore(){
  if(!saved)return;
  var st=saved.state;
  Object.keys(st).forEach(function(k){store.state[k]=st[k];});
  document.getElementById('kw').value=saved.kw;
  saved=null;
  syncTabs();buildSideChips();buildAreaSel();render();
}
function syncTabs(){
  var fav=store.state.view==='fav';
  tabFav.classList.toggle('on',fav);
  tabAll.classList.toggle('on',!fav);
}
function onKey(e){if(e.key==='Escape')end();}

btnNext.addEventListener('click',next);
btnPrev.addEventListener('click',prev);
btnEnd.addEventListener('click',end);
// 點方框以外的地方**不關閉**：導覽的下一步就在方框裡，誤觸關掉等於前功盡棄。
// 這與篩選／設定彈窗刻意不同——那兩個是隨時可以再打開的。

// 設定彈窗那張入口卡的副標要講「共幾步」。⚠️ **對外只給函式、不給數字**，
// 理由同本檔開頭：總步數一律取 STEPS.length，寫死的那一份會在加步驟時靜默過期。
function tourStepCount(){ return STEPS.length; }

export { startTour, tourStepCount };
