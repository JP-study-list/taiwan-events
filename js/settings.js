// 設定彈窗（右上齒輪，2026-08-21）：外觀（晝夜）＋ 網站資訊（資料更新／資料來源）。
// 這三樣原本分散在兩處——晝夜是右上一顆獨立的鈕，兩段資訊在左側欄底部。
//
// ⚠️ **晝夜切換牽動的重繪刻意不放在這裡。** 地圖圖例、行程地圖、餐廳、景點的圖釘
// 顏色都是 JS 產生的字串，不會跟著 CSS 變數走，所以切換後那四處都要重畫——
// 那份清單同時碰四個模組，照規則屬於 main.js。本模組只負責「按了哪一顆」，
// 重繪由 initSettings() 收下的 callback 交回去（同 mylocation 的 openLocPicker）。
// 少了這層，settings 就得 import map／plan-ui／restaurants／places 四個模組。
import { THEME_KEY } from './config.js';
import { curTheme, esc, resetStyleCache, syncThemeColor, t } from './util.js';

var view=document.getElementById('settingsView');
var pick=document.getElementById('themePick');
var _onTheme=null;

function initSettings(onTheme){_onTheme=onTheme;}

// 兩張預覽卡而不是一顆切換鈕：彈窗裡看得到全部選項，不必猜「點了會變成什麼」。
// **2026-08-27 由兩顆 .side-chip 換成預覽卡**——原本與篩選彈窗的類型／時間／排序
// 共用同一套樣式，但外觀是「二選一的模式開關」、篩選是「條件」，語義不同卻長得一樣。
// 現在每張卡直接把那個主題的樣子畫出來（迷你的兩欄瀑布流），不必想像。
//
// ⚠️ **卡片內部的顏色全在 CSS 裡、而且是刻意寫死的十六進位**，理由與代價見
// css/style.css 的 `.theme-pick` 那一段。這裡只出結構，一個顏色都不碰。
//
// 迷你版面兩張卡完全相同（顏色由 .theme-pv-light／-dark 決定），故只寫一份。
// 左欄矮、右欄高——兩欄不等高才是瀑布流看起來的樣子。
var PV_MINI=
   '<span class="pv-col">'
  +  '<span class="pv-ph" style="height:26px"></span>'
  +  '<span class="pv-t"></span>'
  +  '<span class="pv-meta"><span class="pv-sq"></span><span class="pv-t short"></span></span>'
  +'</span>'
  +'<span class="pv-col">'
  +  '<span class="pv-ph" style="height:38px"></span>'
  +  '<span class="pv-t"></span>'
  +  '<span class="pv-t short"></span>'
  +'</span>';

function buildThemePick(){
  var cur=curTheme();
  pick.innerHTML=[['light',t().themeLight],['dark',t().themeDark]].map(function(p){
    var on=cur===p[0];
    // aria-pressed：卡片的選中狀態只靠外框與字重表達，那是純視覺的。
    // （篩選 chip 沒有這個屬性，因為它們的選中還有底線＋文字色兩層，
    //   而且那一組是既有元件，這一輪不動它。）
    return '<button class="theme-pv theme-pv-'+p[0]+(on?' on':'')+'"'
      +' data-v="'+p[0]+'" aria-pressed="'+(on?'true':'false')+'">'
      +'<span class="pv-frame">'+PV_MINI+'</span>'
      +'<span class="pv-lbl">'+esc(p[1])+'</span>'
      +'</button>';
  }).join('');
}

pick.addEventListener('click',function(e){
  var b=e.target.closest('.theme-pv');if(!b)return;
  var next=b.dataset.v, cur=curTheme();
  // **點到已經亮著的那顆也要寫進 localStorage**：目前的明度可能是跟隨系統來的，
  // 使用者點下去的意思是「我就要這個」，寫進去才固定得住。
  try{localStorage.setItem(THEME_KEY,next);}catch(err){}
  if(next===cur){buildThemePick();return;}
  document.documentElement.setAttribute('data-theme',next);
  resetStyleCache();          // 分類色變了，重新讀 CSS 變數
  syncThemeColor();           // 全螢幕模式下狀態列的底色
  buildThemePick();
  if(_onTheme)_onTheme();     // 地圖／行程／餐廳／景點的圖釘重畫，交回 main.js
});

function openSettings(){buildThemePick();view.hidden=false;}
function closeSettings(){view.hidden=true;}

// 點方框以外的地方關閉，與篩選彈窗、景點頁的日期小卡同一個手勢
view.addEventListener('click',function(e){if(e.target===view)closeSettings();});
document.getElementById('settingsDone').addEventListener('click',closeSettings);

export { buildThemePick, closeSettings, initSettings, openSettings };
