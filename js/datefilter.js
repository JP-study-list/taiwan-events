// 地圖上的日期鈕（單位 さ，2026-09-16）。點它開一張月曆小卡，選一天，
// 那天沒在辦的活動就不顯示。
//
// ⚠️⚠️ **只有活動地圖與疊圖兩張有這顆鈕，景點與餐廳沒有——這是查證過的不是省事。**
//    實查 `places.json` 736 筆，`date_*` 欄位 **0 個**；餐廳同樣沒有。它們是常設的，
//    本來就沒有檔期，所以日期在那兩張地圖上**沒有東西可以篩**。放上去會是一顆
//    「按得開、選得動、關掉之後畫面一模一樣」的鈕——本專案最怕的那一種壞法。
//    📌 唯一沾得上邊的是景點的 `holiday`（332 筆有值），但那是**照抄原文的自由文字**
//    （「月曜休（祝日の場合翌日）」），而 `build_places.py` 那條規則明講公休日
//    **不可以收緊成星期幾**（teamLab 一個月只休一個週二，硬轉成週規則會得到
//    **錯的答案而且看起來永遠正確**）。所以「那天有開的景點」用現在的資料做不出來。
//
// ⚠️⚠️ **月曆是自己畫的，而第一版不是——那次用原生 `<input type="date">`，
//    2026-09-16 當天就被推翻。** 原因很硬：**原生選擇器彈出來的月曆是瀏覽器 UI，
//    CSS 完全碰不到**，而使用者要的正是「按開之後的月曆大一點」。
//    自己畫的風險（本專案在月曆上踩過四次誤判）**靠三件事壓下來**：
//    ①只選一天，沒有區間、沒有平移、沒有「維持天數」那些分支
//    ②樣式與中日文月份／星期**沿用行程頁那個月曆既有的** `.cal*` 與 `L.dow`／`L.monFmt`
//    ③尺寸走 `.datesheet` 變體，**`.cal` 本身一個宣告都沒動**（動了行程頁會跟著變）。
//
// ⚠️ **這個模組只依賴共用層**（config／store／util），與 `icons`／`favfood`／`tickets`
//    同一個模子——所以誰都能用它，而它不會把任何畫面模組拖進來成環。
//    改了日期之後要重畫的是「清單＋三張地圖」，那份清單同時碰好幾個模組、
//    照規則屬於 `main.js`，故走注入（`setDateRepaint`），同 `setMapRepaint` 的做法。
//
// ⚠️ **狀態沒有第二份。** 日期就寫進既有的 `store.state.date`／`store.state.day`，
//    所以「地圖上選了日期，回到清單也是同一套」天生成立，而篩選彈窗那排「時間」
//    chip 與這顆鈕講的是同一件事——**不會出現兩個狀態互相說謊**。
//
// ⚠️ **刻意不寫 localStorage。** 日期是「我現在在想哪一天」而不是一項設定：
//    記住的話，下次進站會對著一張莫名其妙少了一半圖釘的地圖，**而畫面上看不出為什麼**。
//    （大區 `twev_zone` 記住是對的——那是設定，性質不同。）
import { store } from './store.js';
import { activeOn, esc, fmtDate, match, t, todayStr } from './util.js';

// 兩顆鈕的容器 id。**只有這兩個**，理由見檔頭。
var BOXES = ['evDate', 'allDate'];

// 月曆現在翻到哪一個月，`[年, 月]`。**每次開小卡都重設**（見 openSheet），
// 所以它不需要跟著日期一起清——⚠️ 行程頁那個 `calYM` 因為是常駐面板，
// 才需要在切天／改起日時清掉。兩者的生命週期不同，別照抄那邊的清除點。
var viewYM = null;

// 改了日期之後重畫（清單＋開著的那張地圖）。由 main.js 注入。
// ⚠️ 少了它，選完日期會變成「鈕上的文字變了，但地圖與清單都沒動」
//    ——看起來像這顆鈕只是個裝飾。
var repaint = null;
function setDateRepaint(fn) { repaint = fn; }

// 選定某一天。**空值一律轉去 clearDay()**：`date==='day'` 而 `day===''` 是一個
// 會讓畫面整片空白的狀態（見 util 的 match() 那一段），不要讓它成立。
function setDay(d) {
  if (!d) { clearDay(); return; }
  store.state.date = 'day';
  store.state.day = d;
  if (repaint) repaint();
}

// 清掉日期。⚠️ **只有「現在真的在篩日期」時才把 `date` 改回 `all`**——
// 否則從「進行中」那條路進來清一次，會順手把使用者的「進行中」也關掉。
function clearDay() {
  if (store.state.date === 'day') store.state.date = 'all';
  store.state.day = '';
  if (repaint) repaint();
}

// 現在是不是真的在篩某一天。**兩個條件都要**，理由同上。
function dayOn() { return store.state.date === 'day' && !!store.state.day; }

var ymd = function (y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
};

// ===== 小卡 =====
var sheet = document.getElementById('dateView');

function openSheet() {
  // 開在「目前選的那個月」，沒選就開在這個月。
  // ⚠️ **每次開都重設**，不要記住上次翻到哪——記住的話，清掉日期再開一次
  //    會停在一個與現況無關的月份，而畫面上只像「月曆自己跳到十二月」。
  //    （行程頁那個月曆 2026-08-27 就踩過「開在行程起日那個月」造成的誤判。）
  var base = dayOn() ? store.state.day : todayStr();
  var p = base.split('-');
  viewYM = [+p[0], +p[1]];
  buildCal();
  sheet.hidden = false;
}
function closeSheet() { sheet.hidden = true; }

// 這一個月每一天各有幾筆。**母體是「其餘條件底下」的活動**（篩了沖繩就算沖繩的），
// ⚠️⚠️ 但**不能把日期自己算進去**——算進去的話，選好日期再打開月曆會變成
//    「只有選中的那一天有點、其餘三十天全是 0」，看起來像月曆壞了。
//    那正是 `match()` 的第三個參數 `ignoreDate` 存在的理由（同 `ignoreType`）。
// **先算一次池子再逐日數**：31 天各跑一次 match() 是 5 萬多次字串比對，
// 而 `activeOn` 只是兩次字串比較。
function countsOf(y, m) {
  var pool = store.events.filter(function (e) { return match(e, false, true); });
  var days = new Date(y, m, 0).getDate(), out = [], i, j, ds, n;
  for (i = 1; i <= days; i++) {
    ds = ymd(y, m, i); n = 0;
    for (j = 0; j < pool.length; j++) if (activeOn(pool[j], ds)) n++;
    out.push(n);
  }
  return out;
}

function buildCal() {
  var L = t(), t0 = todayStr(), tp = t0.split('-');
  var y = viewYM[0], m = viewYM[1];
  document.getElementById('dfMon').textContent = L.monFmt(y, m);
  // ⚠️ **不讓使用者翻到過去的月份**：已經結束的活動會被管線從 `events.json` 剔除，
  //    所以過去的日期給的是一個殘缺的答案（只剩「那天開始、到今天還沒結束」的那些）
  //    ——**看起來完全正常，只是不對**。同一個理由，過去的格子也 disabled。
  document.getElementById('dfPrev').disabled = (y < +tp[0]) || (y === +tp[0] && m <= +tp[1]);
  var lead = new Date(y, m - 1, 1).getDay(), days = new Date(y, m, 0).getDate();
  // ⚠️⚠️ **刻度是「這個月的最少～最多」，不是「0～最多」——而這是量出來才改的。**
  //    照行程頁那個月曆的寫法（`c>=max*0.66 ? 3 : c>=max*0.33 ? 2 : 1`）在這裡
  //    **幾乎沒有鑑別力**：全站每天都有 695～1108 筆活動，實測 30 天裡 **24 天是三顆點、
  //    其餘 6 天兩顆、一顆的一天都沒有**——看起來每天都一樣忙，等於白畫。
  //    改成相對於當月的最小值之後是 11／11／8，篩地區時也分得開（廣島 6／12／12）。
  // 📌 **為什麼可以與行程頁不一致**：兩邊問的問題不同。那邊的池子是「這個地區這一天
  //    排得進行程的站」（幾筆到幾十筆，0 是常態），問的是「這天有沒有東西可排」；
  //    這邊是全站上千筆，問的是「這個月哪幾天比較熱鬧」。**同一種畫法、不同的母體，
  //    刻度本來就該跟著母體走。**
  // ⚠️ `c===0` 永遠是 0 顆點（「一顆」與「沒有」要分得出來）；整個月都一樣多時
  //    一律給中間那階——那時沒有哪一天比較忙，硬分高低是說謊。
  var counts = countsOf(y, m), max = 0, min = Infinity, i;
  for (i = 0; i < counts.length; i++) {
    if (counts[i] > max) max = counts[i];
    if (counts[i] < min) min = counts[i];
  }
  var h = '';
  L.dow.forEach(function (d) { h += '<div class="dow">' + esc(d) + '</div>'; });
  for (i = 0; i < lead; i++) h += '<div class="day pad"></div>';
  for (i = 1; i <= days; i++) {
    var ds = ymd(y, m, i), past = ds < t0, c = counts[i - 1];
    var lv = 0, dots = '';
    if (c > 0) {
      if (max <= min) lv = 2;                       // 整個月一樣多：沒有哪天比較忙
      else { var r = (c - min) / (max - min); lv = r >= 0.66 ? 3 : (r >= 0.33 ? 2 : 1); }
    }
    for (var j = 0; j < lv; j++) dots += '<i></i>';
    h += '<button type="button" class="day' + (past ? ' past' : '')
      + (ds === t0 ? ' today' : '') + (ds === store.state.day ? ' on' : '') + '"'
      + (past ? ' disabled' : '') + ' data-d="' + ds + '" data-n="' + c + '">'
      + '<span>' + i + '</span><span class="dots">' + dots + '</span></button>';
  }
  document.getElementById('dfCal').innerHTML = h;
  syncNote();
}

// 選中那天的實際筆數。格子上的點只分三階，這一行是唯一說得出「選這天會剩多少」的地方。
function syncNote() {
  var n = document.getElementById('dfNote');
  if (!dayOn()) { n.textContent = ''; return; }
  var c = store.events.filter(function (e) {
    return match(e, false, true) && activeOn(e, store.state.day);
  }).length;
  n.textContent = fmtDate(store.state.day) + '　' + t().count(c);
}

// 兩顆鈕的文字與清除鈕。**由 cards.js 的 render() 尾端呼叫**（同 syncMapFilterBtn），
// 因為每一條會改到篩選的路徑最後都會走到那裡——包括換語言、清除全部、切分頁。
// ⚠️ **鈕上一定要顯示選的是哪一天。** 不顯示的話，切走再回來會對著一張
//    少了一半圖釘的地圖，而**畫面上沒有任何東西在說原因**。
function syncDateBtns() {
  var on = dayOn(), L = t();
  BOXES.forEach(function (id) {
    var box = document.getElementById(id); if (!box) return;
    var pick = box.querySelector('.dpick');
    var lab = box.querySelector('.dlab');
    var clr = box.querySelector('.dclr');
    lab.textContent = on ? fmtDate(store.state.day) : L.dateBtn;
    box.classList.toggle('on', on);
    pick.setAttribute('aria-label', L.aDateBtn);
    clr.hidden = !on;
    clr.setAttribute('aria-label', L.aDateClear);
  });
  // 小卡開著的時候也要跟上（例如在小卡裡按了「清除日期」）
  document.getElementById('dfTitle').textContent = L.dateSheetT;
  document.getElementById('dfClear').textContent = L.dateClear;
  document.getElementById('dfDone').textContent = L.done;
  if (!sheet.hidden) { buildCal(); }
}

// ===== 接線（只綁一次）=====
BOXES.forEach(function (id) {
  var box = document.getElementById(id); if (!box) return;
  box.querySelector('.dpick').addEventListener('click', openSheet);
  // ⚠️ 鈕上那顆「✕」是**就地清掉**，不開小卡——它已經是一個明確的意圖，
  //    再跳一張要人再按一次的卡等於多一步而沒有多給任何選擇（同單位 M
  //    「一家平台也跳中轉小卡」那條的相反情形：那裡多一步是為了廣告標示，這裡沒有）。
  box.querySelector('.dclr').addEventListener('click', clearDay);
});
// 月份切換。⚠️ **委派不上去**：這兩顆是固定的節點，直接綁。
document.getElementById('dfPrev').addEventListener('click', function () {
  viewYM = (viewYM[1] === 1) ? [viewYM[0] - 1, 12] : [viewYM[0], viewYM[1] - 1];
  buildCal();
});
document.getElementById('dfNext').addEventListener('click', function () {
  viewYM = (viewYM[1] === 12) ? [viewYM[0] + 1, 1] : [viewYM[0], viewYM[1] + 1];
  buildCal();
});
// 格子：**委派在容器上**（每次重畫都整個換掉，掛在格子上一重畫就失效）。
document.getElementById('dfCal').addEventListener('click', function (e) {
  var b = e.target.closest('.day'); if (!b || b.disabled || !b.dataset.d) return;
  setDay(b.dataset.d);
  closeSheet();      // 選完就收——單日選擇沒有「還要再選一下」的第二步
});
document.getElementById('dfClear').addEventListener('click', function () {
  clearDay(); closeSheet();
});
document.getElementById('dfDone').addEventListener('click', closeSheet);
// 點方框以外的地方關閉，與篩選彈窗、景點頁的日期小卡同一個手勢
sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });

export { clearDay, closeSheet, dayOn, setDateRepaint, setDay, syncDateBtns };
