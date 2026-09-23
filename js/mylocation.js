// 「我的位置」（2026-08-14，單位 A）。決策紀錄見 development-plan-v3.md §1-A。
//
// 一句話：使用者在地圖上點一個點存起來，清單多一個「離我最近」的排序。
// 2026-08-14 第二輪：那個點也可以按一顆鈕由裝置定位帶出來。**只是「座標從哪來」多一條路**
// ——排序、距離、沉底規則一行都沒改，而且定位結果一樣要按「確定」才存。
//
// 三條不可違反的規則（都是決策，不是實作偏好）：
// 1. **位置永遠不離開裝置。** 只寫 localStorage，不進 ?plan= 分享連結（那邊只編
//    {date,ids}），不送給任何服務。
// 2. **不做反向地理編碼、不顯示任何地名。** 介面就是地圖＋一個標記——標記比任何
//    文字都準確，而且畫面上永遠不出現地名，隱私才算徹底閉環（決策 11）。
//    順帶避開第三個外部依賴，以及 Nominatim 被限速時標籤變空白的失敗樣態。
// 3. **距離只當排序，不當篩選**（決策 8）。排序不會讓活動消失，篩選會——而全站
//    18.5% 的座標誤差在 5～117km，拿它擋掉活動是「壞掉但看起來正常」。
//
// 依賴方向：config → store → util → **mylocation** → cards。
// 這裡不 import cards，開完地圖要重畫是走 openLocPicker(cb) 的 cb 回去，避免環。
import { LOC_ACC_ZOOM, LOC_FAR_KM, LOC_GEO_OPTS, LOC_KEY, LOC_VIEW, LOC_VIEW_ZOOM, LOC_ZOOM, LOC_ZOOM_SET } from './config.js';
// hav() 與 T.km() 都是現成的——硬規則寫明距離計算與文案不新增來源。
import { hav, t } from './util.js';

// ===== 狀態 =====
var loc = (function(){
  try{
    var s = JSON.parse(localStorage.getItem(LOC_KEY) || 'null');
    if (s && typeof s.lat === 'number' && typeof s.lng === 'number') return s;
  }catch(e){}
  return null;
})();

function myLoc(){ return loc; }
function hasLoc(){ return !!loc; }

// ===== 開場視野（單位 Y-4，2026-09-07）=====
// **問題不是「z 太小」，是 `fitBounds` 在全日本尺度下已經沒有資訊量。**
// Y-4 原本寫「地圖開場縮到 z=9，看得到房總半島」，那是 2026-08-12 量的
// ——當時餐廳只有 198 家、全在東京，是一筆八王子的離群點把視野撐開的。
// **開桶到 26 個之後那個描述整個失效**：三張地圖的資料都從石垣島（124.1°E）
// 跨到北海道（145.0°E）＝約 **20° 經度**，實測 390px 手機上 `fitBounds`
// 三張**全部給 z=4**，4894 家餐廳叢集成幾個大圓圈。
// ⚠️ **所以「排除離群點」那條舊建議也失效了**——那不是離群點，是真的有資料。
//
// 做法：**只在 `fitBounds` 已經散得太開時才改用「我的位置」。**
// ⚠️⚠️ **不可以無條件套用**：使用者篩了「沖繩」時 `fitBounds` 到沖繩才是對的，
// 而那時 zoom 本來就夠大、這道自然不會觸發——**篩選狀態一個字都不必讀**。
// ⚠️ 硬規則不變：`twev_loc` 只在裝置上用來設一次視野，**不送任何服務、不反查地名**。
var HOME_FIT_ZOOM = 8;   // fitBounds 低於這個就算「散得太開」（見下方那張表）

// ⚠️ **這個門檻是量出來的**（390px 寬、padding 36，可用 318px）：
//   z=4 → 視野約 2,500km（整個日本）   z=7 → 約 310km（跨好幾個縣）
//   z=8 → 約 155km（一個縣的尺度）      z=10 → 約 39km（LOC_ZOOM，一座城市）
// 8 的意思是「視野超過約 160km 寬就已經看不出哪裡有東西」。
// **往下調會讓一整個地方（東北、九州）也被判成夠聚焦**，那正是最該接手的情形。

/**
 * 開場視野：`fitBounds` 散得太開時改用「我的位置」。
 *
 * 回 `true` 代表視野已經設好、**呼叫端不要再 fitBounds**；回 `false` 代表照舊。
 *
 * ⚠️⚠️ **回 false 之前這裡可能已經 setView 過一次，那是刻意的。**
 * 「我的位置附近到底有沒有點」唯一誠實的問法是**用真實視野去問**
 * （`map.getBounds()`），而那要先把視野設過去——猜一個「半徑 20km」的數字
 * 會在不同螢幕尺寸上錯（手機直式的緯度視野是經度的兩倍以上）。
 * 呼叫端會在**同一個同步區塊裡**立刻 `fitBounds` 蓋掉它，瀏覽器不會重繪中間狀態，
 * 所以畫面不會閃。**日後若把呼叫端改成非同步（await／setTimeout），這裡就會閃一下。**
 *
 * ⚠️ **「附近沒有點就不插手」這道守門不可省。** 少了它，住在資料稀疏的地方
 * （或出國）的人開場會看到**一張完全空的地圖**——那比看整個日本更糟，
 * 因為整個日本至少看得出哪裡有東西。失敗方向要落在「退回現況」這一邊。
 */
function fitFromMyLoc(map, pts, padding){
  if (!loc || !pts.length) return false;
  var pad = L.point(padding[0], padding[1]);
  // 已經夠聚焦（多半是使用者自己篩過了）就別插手。
  if (map.getBoundsZoom(L.latLngBounds(pts), false, pad) >= HOME_FIT_ZOOM) return false;
  map.setView([loc.lat, loc.lng], LOC_ZOOM, {animate:false});
  var b = map.getBounds();
  for (var i = 0; i < pts.length; i++) if (b.contains(pts[i])) return true;
  return false;
}

function saveLoc(v){
  loc = v;
  try{
    if (v) localStorage.setItem(LOC_KEY, JSON.stringify(v));
    else localStorage.removeItem(LOC_KEY);
  }catch(e){}
}

// ===== 距離 =====
// 沉底判定。界線刻意畫在 geo==='area'，**不是 locKnown()**（決策 10）：
// locKnown() 答的是「圖釘要不要半透明」，這裡問的是「能不能算距離」。
// uncertain 那 23 筆是真的查到了、只是名稱弱比對，公里級完全可用；
// 而 area 那 118 筆是退回市町村／縣／地區中心，誤差可達 117km，
// 「排在第三名」本身就是一種宣稱，所以整組沉底。
function distSink(ev){
  return ev.geo === 'area'
      || typeof ev.lat !== 'number' || typeof ev.lng !== 'number';
}

// 原始距離，供排序用。沒設位置或沒座標回 null。
// **沉底那組照樣算得出來**——它們整組排最後，但組內仍依距離排（決策 9）。
function distKm(ev){
  if (!loc) return null;
  if (typeof ev.lat !== 'number' || typeof ev.lng !== 'number') return null;
  return hav(loc.lat, loc.lng, ev.lat, ev.lng);
}

// 卡片上要不要印公里數。**沉底那組一律不印**（決策 15）——
// 有數字就是在假裝知道，那些活動維持現有的 .approx +「概略位置」寫法。
function distLabel(ev){
  if (!loc || distSink(ev)) return '';
  var d = distKm(ev);
  return d === null ? '' : t().km(d);
}

// ===== 選點地圖 =====
// 結構與全站地圖同款的整頁覆蓋層。Leaflet 已經載了，零新依賴。
var lmap = null, lmarker = null, draft = null, doneCb = null;
var locview = document.getElementById('locview');

// ===== 裝置定位（第二輪，2026-08-14）=====
// 「座標從哪來」多一條路而已——排序、距離、沉底全部沿用上面那套，一行都沒改。
//
// **安全來源才有 geolocation。** 非 HTTPS 時 Chrome 仍留著 navigator.geolocation，
// 只是呼叫必定失敗，所以要看 isSecureContext 而不是看物件在不在。
var GEO_OK = !!(navigator.geolocation && window.isSecureContext);
var locHereBtn = document.getElementById('locHere');
var locating = false;
var geoErr = '';        // '' / 'denied' / 'fail'
var draftFar = false;   // 目前這個標記是不是離活動範圍很遠

// 精度 → zoom。**桌機是 IP／Wi-Fi 推算，誤差可達數十公里**，一律飛到 z=15
// 會讓畫面看起來像抓得很準。地圖縮得多遠本身就是誠實的表態，故不另外印精度數字。
// 拿不到 accuracy 時退回 LOC_ZOOM_SET，不要當成最準的那一段。
function zoomForAccuracy(acc){
  if (typeof acc !== 'number' || !isFinite(acc)) return LOC_ZOOM_SET;
  for (var i = 0; i < LOC_ACC_ZOOM.length; i++){
    if (acc <= LOC_ACC_ZOOM[i][0]) return LOC_ACC_ZOOM[i][1];
  }
  return LOC_ZOOM_SET;
}

// 離活動範圍很遠？**提示但不擋**（使用者拍板）。
// 判斷放在 setDraft 裡，所以**手動點到很遠的地方一樣會提示**——手動點到台灣
// 和定位到台灣一樣荒謬，寫在共用的地方等於零額外分支。
function isFar(p){
  return hav(p.lat, p.lng, LOC_VIEW[0], LOC_VIEW[1]) > LOC_FAR_KM;
}

function locPin(){
  return L.divIcon({
    className: '',
    html: '<div class="locpin"></div>',
    iconSize: [22, 22], iconAnchor: [11, 22]
  });
}

function setDraft(latlng){
  draft = { lat: latlng.lat, lng: latlng.lng };
  draftFar = isFar(draft);
  geoErr = '';            // 手動點或定位成功，都代表上一則錯誤過去了
  if (lmarker) lmarker.setLatLng(latlng);
  else lmarker = L.marker(latlng, { icon: locPin() }).addTo(lmap);
  syncLocUI();
}

// 抓當下位置。**成功也只是放一個標記，不直接存**——使用者仍要按「確定」，
// 這樣才看得到抓到哪、還能拖著微調（走的是同一個 setDraft，取消與清除全部免費繼承）。
// 失敗時標記維持原狀，原本設好的位置不會被弄丟。
function locateMe(){
  // lmap 為 null 代表選點地圖還沒建起來。實務上按不到（鈕在覆蓋層裡、且只有
  // syncLocUI 會把它顯示出來），但少了這道守門，失敗樣態是 setView 丟未捕捉的 TypeError。
  if (locating || !GEO_OK || !lmap) return;
  locating = true;
  geoErr = '';
  syncLocUI();
  navigator.geolocation.getCurrentPosition(function(pos){
    locating = false;
    var c = pos.coords;
    lmap.setView([c.latitude, c.longitude], zoomForAccuracy(c.accuracy));
    setDraft({ lat: c.latitude, lng: c.longitude });   // 內含 syncLocUI
  }, function(err){
    locating = false;
    // code 1 = PERMISSION_DENIED，要引導回手動路徑；其餘（無法取得／逾時）共用一句。
    geoErr = (err && err.code === 1) ? 'denied' : 'fail';
    syncLocUI();
  }, LOC_GEO_OPTS);
}

function initLocMap(){
  if (lmap) return;
  lmap = L.map('locmap', { zoomControl: true }).setView(LOC_VIEW, LOC_VIEW_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap'
  }).addTo(lmap);
  lmap.on('click', function(e){ setDraft(e.latlng); });
}

// 提示文字與三顆鈕的狀態都跟著「現在有沒有標記」走。
// 提示只有一行，故四種訊息共用它，優先序由急到緩：**錯誤 → 很遠 → 已選 → 初始**。
// 錯誤排最前是因為它是「剛剛按下去發生的事」，蓋掉它等於使用者按了沒反應。
function syncLocUI(){
  var L2 = t();
  var hint = L2.locHint;
  if (geoErr) hint = (geoErr === 'denied') ? L2.locDenied : L2.locFail;
  else if (draft && draftFar) hint = L2.locFar;
  else if (draft) hint = L2.locHintSet;
  document.getElementById('locHint').textContent = hint;
  document.getElementById('locOK').disabled = !draft;
  document.getElementById('locClear').hidden = !loc;
  locHereBtn.hidden = !GEO_OK;
  locHereBtn.disabled = locating;
  locHereBtn.textContent = locating ? L2.locHereWait : L2.locHere;
}

// 靜態文字（語言切換時 main.js 會呼叫）
function applyLocLang(){
  var L2 = t();
  document.getElementById('locTitle').textContent = L2.locTitle;
  document.getElementById('locNote').textContent = L2.locNote;
  document.getElementById('locOK').textContent = L2.locOK;
  document.getElementById('locClear').textContent = L2.locClear;
  document.getElementById('locClose').setAttribute('aria-label', L2.aLocClose);
  if (locview.classList.contains('show')) syncLocUI();
}

// 覆蓋層開著時把背後那幾百張卡片藏起來（body.loc-open，CSS 與地圖／行程／餐廳同一條選擇器）。
// 代價是頁面高度歸零會讓捲動位置跑掉，故自己存起來、關閉時還原——與 openMapView 同一套。
var savedScroll = 0;

// cb(loc|null)：使用者按了確定或清除才呼叫，直接關掉（✕）不呼叫。
function openLocPicker(cb){
  doneCb = cb || null;
  draft = loc ? { lat: loc.lat, lng: loc.lng } : null;
  draftFar = !!draft && isFar(draft);
  geoErr = '';            // 上次開啟時的錯誤不該跟著這次
  locating = false;
  savedScroll = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add('loc-open');
  locview.classList.add('show');
  initLocMap();
  if (lmarker){ lmap.removeLayer(lmarker); lmarker = null; }
  if (loc){
    lmap.setView([loc.lat, loc.lng], LOC_ZOOM_SET);
    lmarker = L.marker([loc.lat, loc.lng], { icon: locPin() }).addTo(lmap);
  }else{
    lmap.setView(LOC_VIEW, LOC_VIEW_ZOOM);
  }
  applyLocLang();
  // 覆蓋層剛從 display:none 變出來，Leaflet 這時量到的容器尺寸還是 0
  setTimeout(function(){ lmap.invalidateSize(); }, 80);
}

function closeLocPicker(){
  locview.classList.remove('show');
  document.body.classList.remove('loc-open');
  requestAnimationFrame(function(){ window.scrollTo(0, savedScroll); });
}

function finish(v){
  saveLoc(v);
  closeLocPicker();
  var cb = doneCb; doneCb = null;
  if (cb) cb(loc);
}

document.getElementById('locClose').addEventListener('click', function(){
  doneCb = null;              // 直接關掉＝什麼都不改
  closeLocPicker();
});
document.getElementById('locOK').addEventListener('click', function(){
  if (draft) finish(draft);
});
document.getElementById('locClear').addEventListener('click', function(){
  finish(null);
});
locHereBtn.addEventListener('click', locateMe);

export { applyLocLang, distKm, distLabel, distSink, fitFromMyLoc, hasLoc, myLoc, openLocPicker };
