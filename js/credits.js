// 圖片出處（2026-09-02）：景點照片的作者與授權一覽。
//
// 為什麼需要它：景點照片取自 Wikimedia Commons，多數是 CC BY / CC BY-SA，
// **那兩種授權要求標示作者**（CC0 與公有領域不用，但一起列出來比較好讀）。
// 我們的壓縮流程 build_photos.py 會用 `-metadata none` 把 EXIF 全清掉
// （GPS 絕不能跟著上網站），連帶把內嵌的作者資訊也清了——所以**畫面上非標不可**。
//
// ⚠️ **share-alike 不會傳染到這個網站**：CC BY-SA 只約束「照片本身的改作」，
//    單純顯示一張沒改過的照片只需要標示。已查證 Commons 官方的再利用說明。
//
// ⚠️ 資料是 `places/_credits.json`，**刻意放在 places/ 底下**：Cloudflare 的組建命令是
//    `cp -r ... places dist/`，整個資料夾一起複製，所以**不必動組建命令**——
//    那是地雷 #14 說「拆分後最容易犯的新錯」，症狀是靜默 404。
//
// ⚠️ **點開才載**。主畫面一個位元組都不多付，同餐廳分頁那條「開分頁才抓」的規矩。
//
// 本模組只 import 共用層（同 icons／favfood 的模子），所以誰都能用它；
// 而「先關設定再開出處頁」同時碰兩個模組，照規則綁在 main.js。
import { PLACE_DIR } from './config.js';
import { store } from './store.js';
import { esc, t } from './util.js';

var view = document.getElementById('creditsView');
var body = document.getElementById('creditsBody');
var sub = document.getElementById('creditsSub');

var data = null;      // null＝還沒載；{}＝載了但沒有任何照片
var loading = null;   // promise 快取，連點兩下不會抓兩次

// 授權名 → 條款網址。CC 要求「在合理可行的範圍內附上授權條款的連結」，
// 而 _credits.json 只存得到短名（Commons 的 LicenseShortName）。
// ⚠️ 對不上就回空字串**不要猜**——猜錯等於指向一份錯的授權，
//    而畫面上跟正確的長得一模一樣（同本專案「自信的錯誤」那一族）。
function licUrl(lic) {
  var s = (lic || '').trim();
  if (/^cc0/i.test(s)) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  // 例：CC BY 2.0 / CC BY-SA 4.0 / CC BY-SA 2.1 jp（最後那段是地區版本）
  var m = /^CC (BY(?:-SA)?) ([\d.]+)(?:\s+(\w+))?$/i.exec(s);
  if (!m) return '';
  return 'https://creativecommons.org/licenses/' + m[1].toLowerCase() + '/' + m[2]
    + (m[3] ? '/' + m[3].toLowerCase() : '') + '/';
}

function load() {
  if (loading) return loading;
  loading = fetch(PLACE_DIR + '_credits.json?t=' + Date.now())
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (d) { data = d && typeof d === 'object' ? d : {}; })
    // 讀取失敗與「還沒有照片」在畫面上講同一句話：兩者都是「這裡目前沒東西」，
    // 而使用者對這兩件事做不出不同的反應。
    .catch(function () { data = {}; });
  return loading;
}

function rowHTML(c) {
  var L = t();
  var name = (store.lang === 'ja' && c.title_ja) ? c.title_ja : c.title;
  var url = licUrl(c.lic);
  var lic = c.lic
    ? (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(c.lic) + '</a>'
           : esc(c.lic))
    : '';
  return '<li class="credit-row">'
    + '<span class="cr-n">' + esc(name || '') + '</span>'
    + '<span class="cr-b">' + esc(c.by || '') + '</span>'
    + '<span class="cr-l">' + lic + '</span>'
    + (c.src ? '<a class="cr-s" href="' + esc(c.src) + '" target="_blank" rel="noopener">'
             + esc(t().creditsSrc) + '</a>' : '')
    + '</li>';
}

function render() {
  var L = t();
  var ids = Object.keys(data || {});
  sub.textContent = ids.length ? L.creditsCount(ids.length) : '';
  if (!ids.length) {
    body.innerHTML = '<p class="credits-note">' + esc(L.creditsEmpty) + '</p>';
    return;
  }
  // 照景點名排序，不照 id——使用者是拿名字來找的
  ids.sort(function (a, b) {
    var x = data[a], y = data[b];
    var na = (store.lang === 'ja' && x.title_ja) ? x.title_ja : x.title;
    var nb = (store.lang === 'ja' && y.title_ja) ? y.title_ja : y.title;
    return String(na || '').localeCompare(String(nb || ''), store.lang === 'ja' ? 'ja' : 'zh-Hant');
  });
  body.innerHTML = '<p class="credits-note">' + esc(L.creditsNote) + '</p>'
    + '<ul class="credits-list">' + ids.map(function (id) { return rowHTML(data[id]); }).join('') + '</ul>';
}

function openCredits() {
  view.classList.add('show');
  body.innerHTML = '<p class="credits-note">' + esc(t().loading) + '</p>';
  sub.textContent = '';
  load().then(render);
}

function closeCredits() { view.classList.remove('show'); }

// 語言切換後如果它開著就重畫（名稱與說明都會變）
function repaintCredits() { if (data && view.classList.contains('show')) render(); }

document.getElementById('creditsClose').addEventListener('click', closeCredits);

export { closeCredits, openCredits, repaintCredits };
