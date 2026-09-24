// 網站資訊（2026-09-02）：關於本站／隱私權政策／聯絡方式，三段合成一頁。
//
// 為什麼是一頁三段而不是三個覆蓋層：這三頁**是一起讀的**（想知道「這站是誰做的、
// 它拿了我什麼資料、出事找誰」是同一個問題的三面），而設定彈窗已經有兩張入口卡了，
// 再加三張會把它撐成一條長捲軸——**而這三頁其實很少人點**。
//
// ⚠️ **內文一律寫「本站」，不寫站名。** 站名日後要改（dev4 的計畫），
//    寫死的話中日文各一份、要在六個地方找它，漏一個就是新舊站名並存。
//    唯一出現站名的地方是頁首副標，那裡吃 `L.app`——**改名只要動 config 那兩行**。
//
// ⚠️ **隱私權政策裡「票券是裸連結」那一段，是 AFF_IDS 填進去那天必須改的。**
//    所以它不寫死，改成問 `AFF_DISCLOSURE`（那個值本身就是從 AFF_IDS 算出來的）
//    ——與中轉小卡的廣告標示同一個來源，不會漂移。**這是刻意不留第二個開關。**
//
// 本模組只 import 共用層（同 icons／favfood／credits 的模子），
// 而「先關設定再開這一頁」同時碰兩個模組，照規則綁在 main.js。
import { AFF_DISCLOSURE, FEATURES } from './config.js';
import { esc, t } from './util.js';

var view = document.getElementById('siteinfoView');
var body = document.getElementById('siteinfoBody');
var sub  = document.getElementById('siteinfoSub');

// 一段：標題 ＋ 若干段落／清單。`rows` 每一項是字串（段落）或陣列（項目清單）。
function secHTML(title, rows) {
  var h = '<section class="si-sec"><h3>' + esc(title) + '</h3>';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (Object.prototype.toString.call(r) === '[object Array]') {
      h += '<ul class="si-list">'
        + r.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('')
        + '</ul>';
    } else {
      h += '<p>' + esc(r) + '</p>';
    }
  }
  return h + '</section>';
}

function render() {
  var L = t();
  sub.textContent = L.app;          // ⚠️ 站名只在這裡出現一次
  body.innerHTML =
      '<div class="si-wrap">'
    + secHTML(L.siAboutH, L.siAbout)
    // 台灣版（2026-09-25，單位 K）：開放資料的顯名聲明是授權條件，放在「關於本站」正下方。
    + secHTML(L.siDataH, L.siData)
    + secHTML(L.siPhotoH, L.siPhoto)
    + secHTML(L.siPrivacyH, L.siPrivacy.map(function (r) {
        // 外部服務清單：景點照片的來源只在景點功能開著時才列（單位 D-4／K）
        return (Object.prototype.toString.call(r) === '[object Array]' && FEATURES.places)
          ? r.concat([L.siPrivacyPlaces]) : r;
      }).concat([
        // 追蹤參數的有無決定這一句（AFF_IDS）。⚠️ 票券連結只出現在景點頁與行程裡的景點，
        // 景點功能關著時站上根本沒有聯盟連結，照樣講「是聯盟連結」就不是事實（單位 K）。
        (AFF_DISCLOSURE && FEATURES.places) ? L.siPrivacyAff : L.siPrivacyBare
      ]))
    // 聯絡方式那段的信箱要是 mailto，所以不走 secHTML 的純文字路徑。
    + '<section class="si-sec"><h3>' + esc(L.siContactH) + '</h3>'
    +   '<p>' + esc(L.siContact) + '</p>'
    +   '<p class="si-mail"><a href="mailto:' + esc(L.siMail) + '">'
    +     esc(L.siMail) + '</a></p>'
    + '</section>'
    + '<p class="si-foot">' + esc(L.siFoot) + '</p>'
    + '</div>';
}

function openSiteinfo() { view.classList.add('show'); render(); }
function closeSiteinfo() { view.classList.remove('show'); }

// 語言切換後如果它開著就重畫（同 repaintCredits）
function repaintSiteinfo() { if (view.classList.contains('show')) render(); }

document.getElementById('siteinfoClose').addEventListener('click', closeSiteinfo);

export { closeSiteinfo, openSiteinfo, repaintSiteinfo };
