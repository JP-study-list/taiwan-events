// 行程頁畫面：三套行程卡、月曆、自己組、共用地圖、匯出圖片。
import { AREAS, FOOD_MAX, FOOD_TYPE, HOME_ZONE, LOC_KEY, OTHER_SPOT, PLACE_DIR, PLAN_MAX, SPOT_AREAS, TRIP_MAX_DAYS, ZONE_KEY } from './config.js';
import { savePlan, store } from './store.js';
import { activeOn, addDays, areaLabel, bigImgUrl, cssVar, dowOf, esc, evById, fld, foodKey, hav, hoursHTML, imgChain, isFoodId, isPlace, isRestaurant, locKnown, mapQuery, otherDayIds, proxied, t, todayStr, typeLabel, weekendDate } from './util.js';
import { tabAll, tabFav, tabPlan } from './cards.js';
import { buildOptions, hopLabel, nearestZone, planEvents, shortCount, spotLabel, spotOf, zoneLabel, zonesWithStock } from './plan-core.js';
import { hopRowHTML, meRowHTML, routeChipsHTML, routeMode, setRouteMode, wholeRowHTML } from './route.js';
import { typeIconHTML } from './icons.js';
import { qrModules } from './qr.js';
import { closeTicketSheet, ticketBtnHTML } from './tickets.js';
import { ensureFood, foodBodyHTML, foodFailed, foodLoaded, foodLoading,
         handleFoodControl, mealForAdd, planHasFood, planIdFor, planIdOf,
         setFoodGenre } from './plan-food.js';

var calYM=null;
var pickArea='',pickSpot='';
// ===== 月曆的區間選擇（訂飯店式，2026-08-27）=====
// `rangeStart` 非空＝**正在等第二下**（已經標了起日，還沒決定結束日）。
// ⚠️ 這是純畫面狀態，一個位元組都不寫進 `jpev_plan`——中途關掉分頁就沒了，
//    那正是想要的：一個懸在半空的起日不值得跨 session 保留。
var rangeStart='';
// 縮短行程的再確認（同 removeLastDay 的 delArm）：存的是「哪一段」待確認。
var shrinkArm='',shrinkArmT;
function clearRange(){
  if(!rangeStart)return;
  rangeStart='';clearTimeout(shrinkArmT);shrinkArm='';
}
var planview=document.getElementById('planview');

function pcardHTML(opt,i){
  var L=t(),h='';
  h+='<div class="pcard'+(store.planSel===i?' sel':'')+'" data-opt="'+i+'">';
  h+='<div class="pcard-h"><span class="no">'+esc(L.optNo(i+1))+'</span>'
    +'<span class="route-key" style="--rc:var(--route-'+(i+1)+')"></span>'
    +'<span>'+esc(zoneLabel(opt.stops[0]))+'</span>'
    +'<span>'+esc(L.paces[opt.pace])+'</span>'
    +(opt.fav?'<span class="star">★ '+esc(L.hasFav)+'</span>':'')+'</div>';
  opt.stops.forEach(function(e,k){
    // `data-peek` ＝照片預覽要顯示哪一筆（2026-08-27）。**這是唯一為它加的東西**，
    // 版面與其餘屬性一個位元組都沒動。⚠️ **必須把 id 寫進 DOM**：這張卡上沒有任何
    // 帶 id 的按鈕可以反查（`data-adopt` 是「第幾套」不是站），而靠列的順序去對
    // `opt.stops[k]` 會在中間穿插 `.hop` 之後失準——那種錯法是靜默的（指到隔壁那一站）。
    h+='<div class="stop" data-peek="'+esc(e.id)+'"><div class="rail">'
      +'<span class="dot" style="background:var(--c-'+e.type+')"></span><span class="bar"></span></div>'
      +'<div class="txt"><div class="nm">'+esc(fld(e,'title'))+'</div>'
      +'<div class="vn">'+esc(typeLabel(e.type))+'　'+esc(fld(e,'venue'))+'</div></div></div>';
    if(k<opt.stops.length-1){
      var n=opt.stops[k+1];
      h+='<div class="hop"><span class="rail"><i></i></span><span>'
        +esc(hopLabel(hav(e.lat,e.lng,n.lat,n.lng)))+'</span></div>';
    }
  });
  h+='<div class="pcard-f"><button data-adopt="'+i+'">'
    +esc(store.planSel===i?L.adopted:L.adopt)+'</button></div></div>';
  return h;
}

// 第六個參數 opt：目前只認 {thumb:true}，由「自己組」的景點段給。
// 有縮圖時**不畫左邊的站號欄**（瀏覽清單本來就沒有站號），否則手機上標題只剩不到一半寬。
// 料理類別的顯示文字。餐廳沒有繁中譯名以外的欄位差異，兩邊都由 `_map.json` 帶進來。
function foodGenreLabel(ev){
  return store.lang==='ja'?(ev.genre_ja||ev.genre||''):(ev.genre||ev.genre_ja||'');
}
function planRowHTML(ev,idx,act,kind,on,opt){
  var L=t(),vague=!locKnown(ev),place=isPlace(ev),food=isRestaurant(ev),thumb=!!(opt&&opt.thumb);
  // ⚠️ **餐廳那一格印的是「午餐／晚餐」而不是「餐廳」**（單位 I 決策 14）：
  // 一眼看得出這天吃兩頓的安排，而「這是一家餐廳」從店名與料理類別就看得出來。
  // 顏色一律用統一的 `--c-餐廳`，**不是 23 種料理類別各自的顏色**——行程頁要一眼分的是
  // 活動／景點／餐廳三大類，23 色會讓那三類糊在一起（決策 13，同景點方案 B 的先例）。
  var catLb=food?(ev.meal==='dinner'?L.foodDinner:L.foodLunch):typeLabel(ev.type);
  var sub='<span class="cat" style="color:var(--c-'+ev.type+')">'+esc(catLb)+'</span>';
  if(vague)sub+='<span class="vague">'+esc(L.vague)+'</span>';
  var vn=fld(ev,'venue');
  // 景點的 venue 允許與名稱本身相同（多數景點就是那棟建築），相同就不印第二次。
  // 活動維持原行為，一律印。
  // ⚠️ **餐廳一律不印 venue**：那個欄位裝的是 Google 查詢字串（店名＋據點日文），
  // 印出來會在店名底下再看到一次店名。改印料理類別與據點。
  if(food){
    if(foodGenreLabel(ev))sub+='<span>'+esc(foodGenreLabel(ev))+'</span>';
    if(ev.spot&&ev.spot!==OTHER_SPOT)sub+='<span>'+esc(spotLabel(ev.spot))+'</span>';
  }
  else if(!place)sub+='<span>'+esc(vn)+'</span>';
  else if(vn&&vn!==fld(ev,'title'))sub+='<span>'+esc(vn)+'</span>';
  // ⚠️ 景點沒有任何日期欄位，`ev.date_end<todayStr()` 對它會是 false 而「剛好」不誤標已結束
  // ——**但這裡不靠那個巧合**，明確跳過。景點永遠不會結束。
  if(!place&&!food&&ev.date_end<todayStr())sub+='<span class="vague">'+esc(L.ended)+'</span>';
  // 「查看詳情」沿用地圖彈窗那顆的文案與視覺（t().detail），兩處指的是同一件事。
  // 外連一律 target="_blank"：全螢幕模式沒有網址列，就地導航會把使用者關在外部網站出不來（地雷 #13）。
  // 刻意**不加** plan-editonly——唯讀（分享）模式下照樣看得到，外連不會讓收到連結的人改到行程。
  var links=ev.url?'<a class="detail" href="'+esc(ev.url)+'" target="_blank" rel="noopener">'
                   +esc(L.detail)+'</a>':'';
  // ⚠️ **餐廳放的是 Google 地圖連結，不是營業時間**（單位 I 決策 12）。
  // 站上有 `hours` 的餐廳只有 99／2190＝4.5%（`source_url` 更是一家官網都沒有），
  // 而 Google 上 100% 有、永遠最新，還一併解掉訂位與「今天有沒有開」。
  // 同 §1-H 排除「收門票價格」的那條原則：**做不到就不要做半套。**
  if(food)links+='<a class="detail" href="https://www.google.com/maps/search/?api=1&query='
                 +esc(encodeURIComponent(mapQuery(ev)))+'" target="_blank" rel="noopener">'
                 +esc(L.aGmap)+' →</a>';
  // 票券（單位 H，2026-09-02 改走 `tickets.js`）。**沒有可用商品就整顆不出現**：
  // 商品會下架，留一顆按了是空頁面的鈕更糟。
  // ⚠️ 舊的 `ticket_url` 單一欄位已經換掉——同一個景點在同一家平台上就可能有
  // 好幾件商品（一般入場／快速通關／組合票），一個欄位只裝得下一件。
  // 「畫面上出現哪一件」的規則整套在那一支，這裡不判斷。
  links+=ticketBtnHTML(ev,'ticket','plan');
  var det=links?'<div class="links">'+links+'</div>':'';
  // 營業時間（單位 H）。實作在 util 的 `hoursHTML()`，景點分頁的地圖彈窗用的是同一支
  // ——兩處講的是同一件事，分兩份寫必然漂移。**`place` 這道守門留在這裡**：
  // 活動天生沒有這兩個欄位，但條件寫在呼叫端才看得出「這一段是給景點的」。
  var hrs=place?hoursHTML(ev):'';
  var th='';
  if(thumb){
    // 照片是本站自己的檔案，**不經 images.weserv.nl**（同網域、版權自有，繞出去沒有必要）。
    // img 留空＝還沒拍，走中性面板＋圖示；填了但檔案不在會是破圖，
    // 那是資料錯誤而不是空狀態，由 build_places.py 在產出時就擋下來。
    th=ev.img
      ? '<img class="pth" src="'+esc(PLACE_DIR+ev.img)+'" alt="" loading="lazy">'
      : '<div class="pth pth-block">'+typeIconHTML(ev.type,26)+'</div>';
  }
  // `data-peek` ＝照片預覽要顯示哪一筆（2026-08-27）。⚠️ **不可以改成從按鈕的
  // `data-add`／`data-del` 反查**：唯讀（分享）模式下那顆按鈕根本不存在，
  // 於是收到連結的人整頁都沒有預覽——而那不會報錯，只是「怎麼滑都沒反應」。
  // 餐廳這裡帶的是 `rs-<l|d>-…`（evById 認得），所以同一家店的午餐與晚餐各自獨立。
  return '<div class="plan-row" data-peek="'+esc(ev.id)+'">'
    +(thumb?th:'<div class="idx">'+esc(idx||'')+'</div>')
    +'<div class="info"><div class="nm">'+esc(fld(ev,'title'))+'</div>'
      +'<div class="sub">'+sub+'</div>'+det+hrs+'</div>'
    +(act?'<button class="act plan-editonly'+(on?' on':'')+'" data-'+kind+'="'+esc(ev.id)+'">'
          +act+'</button>':'')
    +'</div>';
}


// ===== 跨天行程（單位 J，2026-08-26）=====
// 形狀是**一趟連續的日子**：`store.trip.days` 依日期升冪、且必定相鄰。
// 「連續」不是靠檢查維持的，是靠**只能從尾端加減天數 ＋ 改起日是整趟平移**這兩條
// 操作規則保證的——結構上生不出不連續的日期，所以不必寫一道會有人忘記呼叫的驗證。
// ⚠️ 中間那天不想排就**留空**（0 站照樣是一天）。
// ⚠️ **行程頁一次只顯示一天**（`store.plan` ＝目前選中的那一天）。地圖、最短路徑排序、
//    Google 路線、匯出圖片四樣的語義因此完全沒變，跨天沒有動到它們任何一行。

function tripDays(){return store.trip.days;}
function md(ds){var p=ds.split('-');return (+p[1])+'/'+(+p[2]);}

// 讓整趟從 `start` 開始，第 i 天就是 start+i。**這是唯一會改日期的地方。**
// ⚠️ 平移之後有些活動那天可能沒在辦——**只提示、絕不自動刪**（同「已結束的收藏」那條：
//    自動移除又變成靜默消失）。景點與餐廳沒有檔期，不必算。
function shiftTripTo(start){
  tripDays().forEach(function(day,i){day.date=addDays(start,i);});
}
function outOfRangeCount(){
  var n=0;
  tripDays().forEach(function(day){
    day.ids.forEach(function(id){
      var e=evById(id);
      if(!e||isPlace(e)||isRestaurant(e))return;      // 這兩種沒有檔期
      if(!activeOn(e,day.date))n++;
    });
  });
  return n;
}
// 進場前把整趟整理成合法狀態：至少一天、日期相鄰、起日不在過去。
// ⚠️ 起日過期時**整趟往前平移**（保住每一天與每一站），而不是把過期的那幾天丟掉。
//    這與單日時代「日期過了就改成今天」是同一個語義，只是套用到整趟。
function normalizeTrip(){
  var d=tripDays();
  if(!d.length)d.push({date:'',ids:[]});
  if(d.length>TRIP_MAX_DAYS)d.length=TRIP_MAX_DAYS;
  if(!(store.dayIdx>=0)||store.dayIdx>=d.length)store.dayIdx=0;
  var t0=todayStr();
  if(!d[0].date||d[0].date<t0)shiftTripTo(t0);
  else shiftTripTo(d[0].date);                        // 順手把相鄰性補正
}

// 上方那列日期切換。**只有一天時刻意只顯示「＋ 加一天」**——單日使用者看到的畫面
// 因此與跨天之前幾乎相同，而多天的入口仍然在（決策：單日行為不可改變）。
function buildDayBar(){
  var L=t(),d=tripDays(),box=document.getElementById('planDays'),h='';
  if(d.length>1){
    d.forEach(function(day,i){
      h+='<button class="dchip'+(i===store.dayIdx?' on':'')+'" data-day="'+i+'">'
        +'<b>'+esc(L.dayNo(i+1))+'</b>'
        +'<span>'+esc(md(day.date)+'（'+L.dow[dowOf(day.date)]+'）· '+L.dayStops(day.ids.length))+'</span>'
        +'</button>';
    });
  }
  // 唯讀（分享）模式可以切天，但不能加減天——那會改到別人的行程。
  if(!store.planRO){
    if(d.length<TRIP_MAX_DAYS)h+='<button class="dchip act" data-dayadd>'+esc(L.addDay)+'</button>';
    if(d.length>1)h+='<button class="dchip act del" data-daydel>'+esc(L.delDay)+'</button>';
  }
  box.innerHTML=h;
  // 顯示切換掛在**外層**（padding 在那裡），否則收起來還會留一條 12px 的空白。
  document.getElementById('planDaysWrap').style.display=h?'':'none';
  // 選中的那一天要捲進視野：7 天的時候它多半在畫面外，而「＋ 加一天／移除最後一天」
  // 就排在最後面。⚠️ **自己算 scrollLeft，不要用 `scrollIntoView`**——那會連帶捲動
  // 祖先，而 `.planbody` 正是一個垂直捲動容器，行程頁會莫名其妙跳位。
  var on=box.querySelector('.dchip.on');
  if(on){
    // ⚠️ **選到最後一天時直接捲到底，不要只把 chip 置中。**「＋ 加一天／移除最後一天」
    // 就排在最後一顆日期 chip 後面，置中會把它們留在邊界外（實測差 22px），
    // 於是使用者站在最後一天卻按不到「移除最後一天」——而畫面上只是「那顆沒看到」。
    if(+on.dataset.day===d.length-1)box.scrollLeft=box.scrollWidth;
    else box.scrollLeft=Math.max(0,on.offsetLeft-(box.clientWidth-on.offsetWidth)/2);
  }
}
function setDay(i){
  var d=tripDays();
  if(i<0||i>=d.length||i===store.dayIdx)return;
  store.dayIdx=i;store.planSel=-1;pickSpot='';calYM=null;clearRange();
  savePlan();refreshOptions();renderPlan();
}
function addDay(){
  var d=tripDays(),L=t();
  if(d.length>=TRIP_MAX_DAYS){planToast(L.tripFull);return;}
  d.push({date:addDays(d[d.length-1].date,1),ids:[]});
  store.dayIdx=d.length-1;                            // 加完直接跳過去，不必再點一下
  store.planSel=-1;pickSpot='';calYM=null;clearRange();
  savePlan();refreshOptions();renderPlan();
}
// ⚠️ **有站的那一天要按兩次才刪得掉。** 一次就刪等於靜默弄丟幾站——那正是本專案
//    反覆修掉的那種壞法。用既有的 toast 講清楚會連帶刪掉幾站，3 秒內再按一次才真的刪。
var delArm=0,delArmT;
function removeLastDay(){
  var d=tripDays(),L=t();
  if(d.length<=1)return;
  var n=d[d.length-1].ids.length;
  if(n>0&&!delArm){
    delArm=1;clearTimeout(delArmT);
    delArmT=setTimeout(function(){delArm=0;},3000);
    planToast(L.delDayWarn(n));return;
  }
  delArm=0;clearTimeout(delArmT);
  d.pop();
  if(store.dayIdx>=d.length)store.dayIdx=d.length-1;
  store.planSel=-1;pickSpot='';calYM=null;clearRange();
  savePlan();refreshOptions();renderPlan();
}
// localStorage 還原（main.js 呼叫）。**v1＝單日的 `{date,ids}`，v2＝`{v,i,days}`。**
// ⚠️ 舊格式一定要讀得進來，否則使用者現有的行程會歸零——而那是靜默的。
function restoreTrip(raw){
  if(!raw||typeof raw!=='object')return;
  var days=null,idx=0;
  if(raw.days instanceof Array){
    days=raw.days.filter(function(x){return x&&typeof x.date==='string'&&x.ids instanceof Array;})
                 .map(function(x){return {date:x.date,ids:capPlanIds(x.ids)};});
    idx=(typeof raw.i==='number')?raw.i:0;
  }else if(typeof raw.date==='string'&&raw.ids instanceof Array){
    days=[{date:raw.date,ids:capPlanIds(raw.ids)}];   // v1：包成一天
  }
  if(!days||!days.length)return;
  if(days.length>TRIP_MAX_DAYS)days.length=TRIP_MAX_DAYS;
  store.trip={days:days};
  store.dayIdx=(idx>=0&&idx<days.length)?idx:0;
}

function renderPlan(){
  var L=t();
  // ⚠️ **載入規則是「任何地方需要 `rs-` 開頭的 id 就載一次」**（單位 I 決策 10），
  // 不是「開行程頁時載」。今天行為完全一樣（唯一會用到的地方就是這裡與下面那一段），
  // 但等單位 K（餐廳收藏）上線時這條規則一個字都不用改。
  // 行程裡沒有餐廳的人**不會付那 76 KB**——這正是 id 前綴唯一的作用。
  if(planHasFood(store.plan.ids)&&!foodLoaded()&&!foodLoading()&&!foodFailed())
    ensureFood().then(renderPlan,renderPlan);
  planview.classList.toggle('ro',store.planRO);
  document.getElementById('planTitle').textContent=store.planRO?L.planTitleRO:L.planTitle;
  // ⚠️ 一天的時候副標與跨天之前**一字不差**；多天才改用 tripSub，
  // 否則會出現「ONE DAY ITINERARY · 第 3 天」這種自相矛盾的句子。
  var days=tripDays(),multi=days.length>1;
  document.getElementById('planSub').textContent=
    (multi?L.tripSub+' · '+L.dayNo(store.dayIdx+1)+' · ':L.planSub+' · ')
    +L.dayFmt(store.plan.date)+'（'+L.dow[dowOf(store.plan.date)]+'）';
  buildDayBar();
  document.getElementById('planClose').setAttribute('aria-label',L.aPlanClose);
  // 多天時月曆的角色變成「選旅程起日」（點下去是整趟平移），標題要跟著講清楚。
  document.getElementById('dateFoldLb').textContent=multi?L.pickRange:L.pickOtherDay;
  // ⚠️ 多天時**一定要印天數**：訂飯店的「8/26 – 8/31」是 5 晚，我們的是 6 天
  //    （最後一天還是要玩的）。差這一天在畫面上完全看不出來，只印兩個日期會讓人自己算錯。
  document.getElementById('dateCur').textContent=multi
    ? md(days[0].date)+' – '+md(days[days.length-1].date)+' · '+L.tripLen(days.length)
    : L.dayFmt(store.plan.date)+'（'+L.dow[dowOf(store.plan.date)]+'）';
  document.getElementById('mapFoldLb').textContent=L.mapCompare;
  document.getElementById('selfFoldLb').textContent=L.selfBuild;

  var qs=[['today',todayStr()],['tomorrow',addDays(todayStr(),1)],['weekend',weekendDate()]];
  var qh='';
  qs.forEach(function(q){
    // ⚠️ 比對的是**起日**而不是目前這一天：快捷鈕按下去是整趟平移。
    // 只有一天時 days[0] 就是目前這一天，行為與跨天之前相同。
    qh+='<button data-d="'+q[1]+'"'+(days[0].date===q[1]?' class="on"':'')+'>'+esc(L.quick[q[0]])+'</button>';
  });
  document.getElementById('planQuick').innerHTML=qh;
  buildCal();

  // 三套行程
  document.getElementById('optH').textContent=L.optH;
  var sh=document.getElementById('planShuffle');
  sh.textContent=store.planOpts.length?L.shuffle+' ⟳':'';
  sh.style.display=store.planOpts.length?'':'none';
  var box=document.getElementById('pcards');
  if(!store.planOpts.length){
    box.innerHTML='<div class="plan-empty">'+esc(L.noOpts)+'</div>';
  }else{
    box.innerHTML=store.planOpts.map(pcardHTML).join('');
  }
  // 大區列（單位 N）。**只有兩個以上才畫**——只剩一個的時候那一排 chip 不提供任何選擇，
  // 只是佔掉一段版面並讓人以為還有別的可按。今天實測是「首都圈／關西」兩顆。
  var zones=zonesWithStock(),zbox=document.getElementById('zoneChips');
  zbox.innerHTML=zones.length>1
    ? zones.map(function(z){
        return '<button class="zone-chip'+(z===store.planZone?' on':'')+'" data-zone="'+esc(z)+'">'
          +esc(L.zones[z]||z)+'</button>';
      }).join('')
    : '';
  document.getElementById('zoneRow').hidden=zones.length<2;
  // 「想跑遠一點」**只存在於首都圈**（定案 2）。別的大區地廣人稀，再切一次市區／郊外
  // 只會把本來就不多的候選切成兩半，而兩邊都組不出行程。
  var ft=document.getElementById('farToggle');
  ft.hidden=store.planZone!==HOME_ZONE;
  ft.textContent=store.planFar?L.farBack:L.farGo;
  ft.classList.toggle('on',store.planFar);

  // 我的行程
  var list=planEvents(),gone=store.plan.ids.length-list.length;
  document.getElementById('planListH').textContent=L.planListH;
  // 起點模式的兩顆 chip。**唯讀（分享）模式照樣顯示**，沿用「查看詳情」那顆的先例——
  // 它只影響收到連結的人自己裝置上的偏好，不會改到別人的行程。
  // 而對他來說「從我現在的位置」正是最有價值的那一顆（他跟分享者不住在一起）。
  document.getElementById('routeChips').innerHTML=routeChipsHTML();
  var lh='';
  if(!list.length&&!gone){
    lh='<div class="plan-empty">'+esc(L.planEmpty)+'</div>';
  }else{
    // 「從我現在的位置」＝把自己當第 0 站。不加這一段的話這個模式幾乎沒有價值：
    // 真正想知道的是「我家到第一站搭什麼電車」，而電車只在逐段這一側。
    if(list.length&&routeMode()==='me')lh+=meRowHTML(list[0]);
    list.forEach(function(ev,i){
      lh+=planRowHTML(ev,L.stop(i+1),'✕','del');
      if(i<list.length-1)lh+=hopRowHTML(ev,list[i+1]);
    });
    lh+=wholeRowHTML(list);       // 總點數 <3 時自己回空字串
    // ⚠️ **查不到的原因分兩種，不可混講。** 活動查不到是真的結束或下架（無解）；
    // 景點永遠不會結束，查不到只會是 places.json 沒載進來（重整就好）。
    // 混成一句「已結束」對景點是假的，而且會把有解的那個藏在無解的說法底下。
    // `pl-` 前綴讓這件事免費——不必多存任何狀態。
    if(gone>0){
      var gp=0,gf=0;
      store.plan.ids.forEach(function(id){
        if(evById(id))return;
        if(id.indexOf('pl-')===0)gp++;
        else if(isFoodId(id))gf++;
      });
      if(gone-gp-gf>0)lh+='<div class="plan-empty">'+esc(L.gone(gone-gp-gf))+'</div>';
      if(gp>0)lh+='<div class="plan-empty">'+esc(L.gonePlace(gp))+'</div>';
      // ⚠️ **餐廳查不到有兩種原因，而 `rs-` 前綴讓它們分得開**（單位 I 決策 23）：
      // 資料還沒載完（正常，等一下就有）與真的從榜單移除／歇業（要說出來）。
      // 混成一句的話，開行程頁的頭半秒每次都會閃一句「已從榜單移除」——
      // 景點當初就是因為分不出來才只能講一種說法。**絕不自動從行程刪掉**
      //（那又變成靜默消失，正是「已結束的收藏」要修的問題）。
      if(gf>0&&foodFailed())
        lh+='<div class="plan-empty">'+esc(L.restaurantLoadFail)+'</div>';
      else if(gf>0&&foodLoaded())
        lh+='<div class="plan-empty">'+esc(L.foodGone(gf))+'</div>';
    }
  }
  document.getElementById('planList').innerHTML=lh;

  renderFood(list);

  var bi=document.getElementById('planImg'),bs=document.getElementById('planShare');
  bi.textContent=L.btnImg;bs.textContent=L.btnShare;
  bi.disabled=!list.length;bs.disabled=!list.length;
  document.getElementById('planOwn').textContent=L.btnOwn;
  document.getElementById('planCta').style.display=store.planRO?'block':'none';

  buildSelf();
  renderPlanMap();
}

function buildCal(){
  var L=t(),t0=todayStr(),tp=t0.split('-'),td=tripDays(),pd=td[0].date.split('-');
  // 區間的**兩端實心、中間淺底**——「這一段從哪到哪」要一眼看得出來。
  // 單日時兩端是同一格，畫出來與跨天之前一字不差。
  // ⚠️ **正在等第二下時（rangeStart 有值）畫的是「選擇中」的樣子**：焦點給新的起點，
  //    既有那一趟整段退成 `in`。兩者都畫成實心的話畫面上會有三個一樣重的格子，
  //    而使用者分不出哪個是「現在的行程」哪個是「我剛點的」。
  var isOn={},isIn={};
  if(rangeStart){
    isOn[rangeStart]=1;
    td.forEach(function(x){if(x.date!==rangeStart)isIn[x.date]=1;});
  }else{
    isOn[td[0].date]=1;isOn[td[td.length-1].date]=1;
    td.forEach(function(x,i){if(i&&i<td.length-1)isIn[x.date]=1;});
  }
  // 「維持現在天數」的建議結束日（虛線框）。點它＝整趟平移、站全部保留。
  // ⚠️ 它在程式裡**不是特殊分支**——點它走的是與點任何一格完全相同的那條路，
  //    只是算出來的天數剛好不變。這裡出的只有一個 class 和下面那行提示文字。
  // ⚠️ 單日時不給（維持 1 天的結束日就是起日自己，框在同一格上沒有意義）。
  var keep=(rangeStart&&td.length>1)?addDays(rangeStart,td.length-1):'';
  // ⚠️ 跨月時 keep 那一格根本不在這個月的月曆上，框不出來——所以提示行要**把日期寫出來**，
  //    否則使用者不知道該往下個月翻。
  var hint=document.getElementById('calHint');
  if(!rangeStart){hint.hidden=true;hint.textContent='';}
  else{hint.hidden=false;hint.textContent=keep?L.pickEndKeep(td.length,md(keep)):L.pickExtend;}
  if(!calYM)calYM=[+pd[0],+pd[1]];
  var y=calYM[0],m=calYM[1];
  document.getElementById('calMon').textContent=L.monFmt(y,m);
  var lead=new Date(y,m-1,1).getDay(),days=new Date(y,m,0).getDate();
  document.getElementById('calPrev').disabled=(y<+tp[0])||(y===+tp[0]&&m<=+tp[1]);
  var counts=[],max=0,i,ds;
  for(i=1;i<=days;i++){
    ds=y+'-'+String(m).padStart(2,'0')+'-'+String(i).padStart(2,'0');
    counts.push(shortCount(ds));
    if(counts[i-1]>max)max=counts[i-1];
  }
  var h='';
  L.dow.forEach(function(d){h+='<div class="dow">'+esc(d)+'</div>';});
  for(i=0;i<lead;i++)h+='<div class="day pad"></div>';
  for(i=1;i<=days;i++){
    ds=y+'-'+String(m).padStart(2,'0')+'-'+String(i).padStart(2,'0');
    var past=ds<t0,c=counts[i-1];
    var lv=(!c||!max)?0:(c>=max*0.66?3:(c>=max*0.33?2:1)),dots='';
    for(var j=0;j<lv;j++)dots+='<i></i>';
    h+='<button class="day'+(past?' past':'')+(isOn[ds]?' on':'')
      +(isIn[ds]?' in':'')+(ds===keep?' keep':'')+'"'
      +(past?' disabled':'')+' data-d="'+ds+'">'
      +'<span>'+i+'</span><span class="dots">'+dots+'</span></button>';
  }
  document.getElementById('cal').innerHTML=h;
}

// ---- 自己組：地區 → 據點 → 清單 ----
function buildSelf(){
  var L=t();
  var live=store.events.filter(function(e){return activeOn(e,store.plan.date);});
  var byArea={},byAreaP={};
  live.forEach(function(e){byArea[e.area]=(byArea[e.area]||0)+1;});
  store.places.forEach(function(p){byAreaP[p.area]=(byAreaP[p.area]||0)+1;});
  var ah='';
  AREAS.forEach(function(a){
    // ⚠️ 出現條件是「有活動**或**有景點」。只看活動的話，某地區當天沒活動時
    // 那顆按鈕整個不出現，於是那裡的景點永遠點不到——功能做了等於沒做，
    // 而且畫面上完全看不出來。點進去後活動那段顯示空狀態即可：
    // **空狀態說得出話，比按鈕消失好。**
    if(!byArea[a]&&!byAreaP[a])return;
    // 數字**只數活動**（景點天天都在，數它沒有資訊量）；為 0 時整個不印，
    // 顯示「箱根熱海 0」看起來像壞了。
    ah+='<button data-area="'+esc(a)+'"'+(pickArea===a?' class="on"':'')+'>'
      +esc(areaLabel(a))+(byArea[a]?'<span class="n">'+byArea[a]+'</span>':'')+'</button>';
  });
  document.getElementById('areaPick').innerHTML=ah||('<div class="plan-empty">'+esc(L.noneToday)+'</div>');
  document.getElementById('selfCur').textContent=
    pickArea?(pickSpot?spotLabel(pickSpot):areaLabel(pickArea)):'';

  // 有據點的桶（東京23區／大阪／京都）才細分據點，見 config 的 SPOT_AREAS
  var sp=document.getElementById('spotPick');
  if(SPOT_AREAS[pickArea]){
    var bySpot={},bySpotP={};
    live.forEach(function(e){
      if(e.area!==pickArea)return;
      var s=spotOf(e)||OTHER_SPOT;
      bySpot[s]=(bySpot[s]||0)+1;
    });
    // 景點段吃據點篩選（選了澀谷卻列出上野的景點是噪音，而行程演算法整套以距離為核心），
    // 所以「只有景點沒有活動」的據點也要有按鈕，否則同樣點不到。
    store.places.forEach(function(p){
      if(p.area!==pickArea)return;
      var s=spotOf(p)||OTHER_SPOT;
      bySpotP[s]=(bySpotP[s]||0)+1;
    });
    var keys=Object.keys(bySpot);
    Object.keys(bySpotP).forEach(function(k){if(keys.indexOf(k)<0)keys.push(k);});
    keys.sort(function(a,b){return (bySpot[b]||0)-(bySpot[a]||0);});
    var sh='<div class="pick-row"><button data-spot=""'+(pickSpot?'':' class="on"')+'>'
      +esc(L.allSpots)+'</button>';
    keys.forEach(function(k){
      sh+='<button data-spot="'+esc(k)+'"'+(pickSpot===k?' class="on"':'')+'>'
        +esc(spotLabel(k))+(bySpot[k]?'<span class="n">'+bySpot[k]+'</span>':'')+'</button>';
    });
    sp.innerHTML=sh+'</div>';
    sp.style.display='';
  }else{
    sp.style.display='none';pickSpot='';
  }

  var sel=selfList();
  // 收藏提醒：使用者要的是「選區的時候就跳出來」，而不是另做一個加入收藏的入口
  var favHere=sel.filter(function(e){return store.favs.indexOf(e.id)>-1;});
  var fn=document.getElementById('favNote');
  if(pickArea&&favHere.length){
    fn.innerHTML=esc(L.favHere(favHere.length,pickSpot?spotLabel(pickSpot):areaLabel(pickArea)))
      +'<br>'+favHere.map(function(e){return '<b>★</b> '+esc(fld(e,'title'));}).join('<br>');
    fn.style.display='';
  }else fn.style.display='none';

  document.getElementById('browseH').textContent=
    pickArea?L.browseH(sel.length,pickSpot?spotLabel(pickSpot):areaLabel(pickArea))
            :L.pickAreaFirst;
  // 已在行程裡的要看得出來並且可以按掉。少了這個回饋，使用者對著已加入的活動
  // 再按一次「＋」會毫無反應，是典型的靜默失效。
  document.getElementById('planBrowse').innerHTML=
    pickArea?(sel.length?sel.map(function(e){
                var inPlan=store.plan.ids.indexOf(e.id)>-1;
                return planRowHTML(e,'',inPlan?'✓':'＋',inPlan?'del':'add',inPlan);
              }).join('')
                        :'<div class="plan-empty">'+esc(L.noneHere)+'</div>')
            :'';

  // 常設景點（單位 H）。**與活動分成兩段**而不是混排：上面那段照結束日排序，
  // 景點沒有結束日，混進去就得替它捏一個值，而任何捏出來的值都是說謊。
  // 沒選地區時整段收掉（與活動段一致）；選了地區但這裡沒有景點時**說一句話不要消失**
  // ——區塊靜默消失就看不出功能有沒有做。
  var pl=selfPlaces();
  // ⚠️ **兩種「沒有景點」要分開**：全站一筆景點都沒有（還沒放清單、或 places.json 沒上線）
  // 就整段不出現——否則每個地區都會看到一句空承諾。**有景點但這一區沒有**才說話，
  // 那時「區塊靜默消失」才真的會讓人看不出功能有沒有做（決策 13、H-45）。
  var show=!!pickArea&&store.places.length>0;
  document.getElementById('placesSec').style.display=show?'':'none';
  if(show){
    document.getElementById('placesH').textContent=
      L.placesH(pl.length,pickSpot?spotLabel(pickSpot):areaLabel(pickArea));
    document.getElementById('planPlaces').innerHTML=
      pl.length?pl.map(function(e){
        var inPlan=store.plan.ids.indexOf(e.id)>-1;
        return planRowHTML(e,'',inPlan?'✓':'＋',inPlan?'del':'add',inPlan,{thumb:true});
      }).join('')
               :'<div class="plan-empty">'+esc(L.noPlacesHere)+'</div>';
  }
}
// 景點清單。**沒有日期條件**（景點天天都在），其餘篩選與活動段完全相同。
// 排序用名稱：沒有結束日可排，而隨機或依檔案順序會讓同一個地區每次進來順序不同。
function selfPlaces(){
  if(!pickArea)return [];
  return store.places.filter(function(p){
    if(p.area!==pickArea)return false;
    if(SPOT_AREAS[pickArea]&&pickSpot)
      return (spotOf(p)||OTHER_SPOT)===pickSpot;
    return true;
  }).sort(function(a,b){return fld(a,'title')<fld(b,'title')?-1:1;});
}
function selfList(){
  if(!pickArea)return [];
  return store.events.filter(function(e){
    if(!activeOn(e,store.plan.date)||e.area!==pickArea)return false;
    if(SPOT_AREAS[pickArea]&&pickSpot)
      return (spotOf(e)||OTHER_SPOT)===pickSpot;
    return true;
  }).sort(function(a,b){return a.date_end<b.date_end?-1:1;});
}

// ---- 共用地圖：三套一起比較（展開才初始化，不浪費圖磚請求）----
var pmap=null,pLayer=null;
function renderPlanMap(){
  var body=document.getElementById('mapBody');
  // 收合時不畫（不浪費圖磚請求）。**但桌面版地圖是常駐的**（CSS 直接 display:block），
  // 不可依賴摺疊狀態：`.open` 一旦被移除，地圖就默默停止更新，而 CSS 仍讓它看得見，
  // 於是畫面留著上一次的舊路線——資料是對的、畫面是舊的，又一個「壞掉但看起來正常」。
  if(!planWide()&&!body.classList.contains('open'))return;
  if(!pmap){
    pmap=L.map('planMap',{zoomControl:false}).setView([35.55,139.65],10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {maxZoom:18,attribution:'© OpenStreetMap'}).addTo(pmap);
    pLayer=L.layerGroup().addTo(pmap);
  }
  pmap.invalidateSize();
  pLayer.clearLayers();
  // 已經有行程就顯示行程（採用之後需求從「比較」變成「怎麼走」）；
  // 還沒有就把三套疊上去比較，選中的實心、其餘空心。
  var mine=planEvents().filter(locKnown),routes;
  if(mine.length)routes=[{stops:mine,on:true,route:store.planSel>=0?store.planSel+1:0}];
  else routes=store.planOpts.map(function(o,i){
    return {stops:o.stops,on:(store.planSel<0?i===0:i===store.planSel),route:i+1};
  });
  var pts=[];
  routes.forEach(function(r){
    var line=[],routeColor=r.route?cssVar('--route-'+r.route):cssVar('--ink');
    r.stops.forEach(function(e,i){
      line.push([e.lat,e.lng]);
      // **只用選中那套來決定視野。** 三套常散在東京到橫濱之間（相隔數十公里），
      // 若把全部塞進畫面，各站之間那 1~5km 會擠成一團，等於什麼都看不出來。
      // 對焦選中的那套才看得到路線形狀；其他兩套照樣畫（空心），在附近就看得到。
      if(r.on)pts.push([e.lat,e.lng]);
      L.marker([e.lat,e.lng],{
        icon:L.divIcon({className:'',
          html:'<div class="rpin'+(r.on?'':' dim')+'" style="--rc:'+esc(routeColor)+'">'+(i+1)+'</div>',
          iconSize:[20,20],iconAnchor:[10,10]}),
        zIndexOffset:r.on?1000:0
      // ⚠️ **餐廳的 `venue` 裝的是 Google 查詢字串（店名＋據點日文），不可以印出來**
      // ——會在店名底下再看到一次店名。改印「午餐／晚餐・料理類別」。
      }).addTo(pLayer).bindPopup(
        '<b>'+esc(fld(e,'title'))+'</b><br>'
        +esc(isRestaurant(e)
          ? [(e.meal==='dinner'?t().foodDinner:t().foodLunch),foodGenreLabel(e)]
              .filter(Boolean).join('・')
          : fld(e,'venue')));
    });
    if(line.length>1)L.polyline(line,{
      color:routeColor,weight:r.on?2.5:1.5,
      opacity:r.on?1:0.75,dashArray:r.on?null:'4,4'
    }).addTo(pLayer);
  });
  document.getElementById('mapCur').textContent=
    mine.length?t().mapMine:(store.planOpts.length?t().mapOpts(store.planOpts.length):'');
  if(pts.length)pmap.fitBounds(pts,{padding:[30,30],maxZoom:15});
}

// ===== 加進行程前先問日期（2026-08-26 由 places.js 移到這裡共用）=====
// ⚠️ **原本這段在 places.js**，單位 I 讓餐廳分頁也要問同一件事。分兩處寫必然漂移
//（同 `hoursHTML`／`isNew` 判定留在共用層的理由），故整段搬到擁有 `store.plan.date`
// 的這裡，景點與餐廳都呼叫 `askPlanDate()`。
// ⚠️ **DOM 的 id 原封沿用 `placesDate*`**：它們散在 HTML 與 CSS 裡，改名的收益只有好看
//（同 `.side-chip` 名稱裡那個側欄時代的 `side`）。但那幾個節點**已經從 `#placesView`
// 裡面搬到最上層**，否則餐廳頁開著時它會被關在一個 `display:none` 的容器裡。
function planDateReady(){
  return !!store.plan.date&&store.plan.date>=todayStr();
}
var dateSheet=document.getElementById('placesDate');
var dateOK=null,dateCancel=null;
function askPlanDate(onPick,onCancel){
  var L=t();
  dateOK=onPick||null;dateCancel=onCancel||null;
  document.getElementById('placesDateH').textContent=L.placesPickDate;
  document.getElementById('placesDateOtherLb').textContent=L.placesOtherDay;
  document.getElementById('placesDateCancel').textContent=L.placesCancel;
  var qs=[['today',todayStr()],['tomorrow',addDays(todayStr(),1)],['weekend',weekendDate()]];
  document.getElementById('placesDateQuick').innerHTML=qs.map(function(q){
    return '<button data-d="'+q[1]+'">'+esc(L.quick[q[0]])+'</button>';
  }).join('');
  var inp=document.getElementById('placesDateInput');
  inp.min=todayStr();inp.value='';
  dateSheet.hidden=false;
}
function closeDateSheet(){
  var cb=dateCancel;
  dateSheet.hidden=true;dateOK=null;dateCancel=null;
  if(cb)cb();
}
function pickDate(d){
  if(!d||d<todayStr())return;
  var cb=dateOK;
  // 這張小卡只在「沒有日期或日期已過」時才會出現，所以整趟本來就還沒定案；
  // 走同一條平移的路，行程永遠只有一個地方在改日期。
  shiftTripTo(d);store.dayIdx=0;store.planSel=-1;savePlan();
  dateSheet.hidden=true;dateOK=null;dateCancel=null;
  if(cb)cb();
}
document.getElementById('placesDateQuick').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  pickDate(b.dataset.d);
});
document.getElementById('placesDateInput').addEventListener('change',function(){
  pickDate(this.value);
});
document.getElementById('placesDateCancel').addEventListener('click',closeDateSheet);
// 點面板外面也關掉——這張問日期的小卡沒有「不選也可以繼續」的狀態，
// 而使用者對半透明遮罩的直覺就是「點旁邊會關」。
dateSheet.addEventListener('click',function(e){
  if(e.target===dateSheet)closeDateSheet();
});

var toastT;
function planToast(msg){
  var el=document.getElementById('planToast');
  el.textContent=msg;el.classList.add('show');
  clearTimeout(toastT);
  toastT=setTimeout(function(){el.classList.remove('show');},1900);
}

// ===== 加一頓飯（單位 I）=====
// ⚠️ 這一段**只在「行程至少有一站」時出現**（決策 21）：一站都沒有的時候列任何餐廳
// 都是亂猜，而一顆按下去說「請先加一站」的鈕不如不要有。
// **摺疊起來**（同「自己組」「在地圖上比較」），展開才去載那 76 KB。
function renderFood(list){
  var L=t(),sec=document.getElementById('foodSec');
  var show=!store.planRO&&list.length>0;
  sec.style.display=show?'':'none';
  if(!show)return;
  document.getElementById('foodFoldLb').textContent=L.foodH;
  var n=store.plan.ids.filter(function(id){return !!foodKey(id);}).length;
  document.getElementById('foodCur').textContent=n?L.restaurantCount(n):'';
  if(document.getElementById('foodBody').classList.contains('open'))renderFoodBody(list);
}
function renderFoodBody(list){
  if(!foodLoaded()&&!foodLoading()&&!foodFailed())ensureFood().then(afterFoodLoad,afterFoodLoad);
  document.getElementById('foodList').innerHTML=foodBodyHTML(list||planEvents());
}
function afterFoodLoad(){
  // 載完之後整頁重畫：行程列裡的餐廳（如果有）與這一段都要跟著出現。
  if(planview.classList.contains('show'))renderPlan();
}
// 「＋／✓」。**加入一律走 addToPlan()**，移除走與行程列同一條路。
function toggleFood(baseId){
  var pid=planIdOf(baseId);
  if(pid){removeStop(pid);return;}
  // 目前選中的那一餐已經有店就換去空著的那一格；兩格都滿了照樣送進 addToPlan，
  // 由它那道上限守門說「一天最多 2 家餐廳」——**提示只有一個來源**。
  if(addToPlan(planIdFor(baseId,mealForAdd()))){store.planSel=-1;renderPlan();}
}
function removeStop(id){
  var i=store.plan.ids.indexOf(id);
  if(i>-1){store.plan.ids.splice(i,1);store.planSel=-1;savePlan();renderPlan();}
}
// ⚠️ **上限有兩套**（單位 I 決策 2）：活動與景點合計 PLAN_MAX=4，餐廳另給 FOOD_MAX=2，
// 所以一天最多 6 站。**兩句提示必須分開**——說「一天最多 4 站」卻擋下第 3 家餐廳，
// 使用者只會覺得壞了。
// ⚠️ 上限的語義是**「每天最多」**而不是「這個行程最多」：今天跑起來一模一樣，
// 跨天（單位 J）那天差很多。
// ⚠️ **兩套上限要分開截**（單位 I 決策 2）。整串一律 `slice(0,PLAN_MAX)` 的話，
// 一份 4 站＋2 餐的行程**會少掉兩站，而且看不出少了什麼**——
// 這條同時管 localStorage 還原（main.js）與 `?plan=` 分享連結，兩處都不可以自己切。
function capPlanIds(ids){
  var evIds=[],fdIds=[];
  (ids||[]).forEach(function(x){
    if(typeof x!=='string')return;
    if(x.indexOf('rs-')===0){if(fdIds.length<FOOD_MAX)fdIds.push(x);}
    else if(evIds.length<PLAN_MAX)evIds.push(x);
  });
  return evIds.concat(fdIds);
}
function addToPlan(id){
  if(store.planRO||store.plan.ids.indexOf(id)>-1)return false;
  // ⚠️ **跨天重複要擋下來並說出是第幾天**（單位 J）。只擋活動與景點——`otherDayIds()`
  // 刻意跳過餐廳（兩天都去同一家是合理的選擇）。只有一天時它回空物件，等於這一段不存在。
  var od=otherDayIds();
  if(od[id]){planToast(t().dupOtherDay(od[id]));return false;}
  var food=isFoodId(id);
  var nFood=0;
  store.plan.ids.forEach(function(x){if(foodKey(x))nFood++;});
  if(food){
    // 同一家店不可以同時當午餐與晚餐——兩者是不同的行程 id，`indexOf` 擋不住。
    var key=foodKey(id);
    for(var i=0;i<store.plan.ids.length;i++)
      if(foodKey(store.plan.ids[i])===key){planToast(t().foodDup);return false;}
    if(nFood>=FOOD_MAX){planToast(t().foodFull);return false;}
  }else if(store.plan.ids.length-nFood>=PLAN_MAX){
    planToast(t().planFull);return false;
  }
  store.plan.ids.push(id);savePlan();
  return true;
}
// 餐廳分頁的彈窗按下「加進行程」時走這裡（由 main.js 注入給 restaurants.js）。
// ⚠️ **一定先問日期，不可預設今天**（決策 18，同景點那顆）：餐廳跟景點一樣是
// 「哪天去都行」的東西，默默排進今天等於幫使用者決定，而且**那張行程會安安靜靜地
// 排在今天，他不會發現**。已經有有效日期就不再問。
// ⚠️ **第三個參數 `meal` 是選填的**（單位 K）：收藏清單那條路會先問午餐／晚餐，
// 所以直接指定；餐廳分頁彈窗那條路不傳，維持既有行為（沿用行程頁選中的那一餐，
// 已占用就自動換去空著的那一格）。
function requestAddFood(baseId,done,meal){
  function fin(){if(done)done();}
  var pid=planIdOf(baseId);
  if(pid){removeStop(pid);fin();return;}
  // 先確保 store.restaurants 有內容——沒有的話 evById 查不到，
  // 加進去的那一站會在行程頁顯示成「查不到」。
  ensureFood().then(function(){
    // ⚠️ **載完之後要確認這家店還在榜單上**（單位 K）。收藏可能是好幾個月前按的，
    // 而那家店會因為改地址、歇業或榜單換年度而從 `_map.json` 消失
    // （餐廳 id 是「店名＋地址」算出來的）。不擋的話會加進一個**永遠顯示
    // 「已從榜單移除」的死站**，而使用者在收藏清單上看不出自己剛剛做了什麼。
    // 既有那條路（餐廳分頁彈窗）的 baseId 一定來自畫面上的圖釘，所以這道守門
    // 對它零影響。
    var listed=false;
    for(var i=0;i<store.restaurants.length;i++)
      if(store.restaurants[i].id==='rs-'+baseId){listed=true;break;}
    if(!listed){planToast(t().favFoodOff);fin();return;}
    function add(){
      if(addToPlan(planIdFor(baseId,meal||mealForAdd())))store.planSel=-1;
      if(planview.classList.contains('show'))renderPlan();
      fin();
    }
    if(!planDateReady()){askPlanDate(add,fin);return;}
    add();
  },function(){planToast(t().restaurantLoadFail);fin();});
}
function adoptOption(i){
  var o=store.planOpts[i];if(!o)return;
  store.planSel=i;
  store.plan.ids=o.stops.slice(0,PLAN_MAX).map(function(e){return e.id;});
  savePlan();renderPlan();
}
function refreshOptions(){
  store.planOpts=buildOptions();store.planSel=-1;
}

// ===== 大區的選擇與記憶（單位 N，2026-09-03）=====
// ⚠️ **切大區一定要把 planFar 一起歸零。** 它是全域狀態、切天也不會重設（單位 J 的 A/B
//    就是被它弄髒的），帶著 true 切到關西會拿到「非核心桶」那個池子——在關西那等於全部，
//    使用者按過的「想跑遠一點」還亮著卻又看不到那顆鈕（它只在首都圈顯示）。
//    **歸零是唯一不會讓兩個狀態互相說謊的做法。**
function setPlanZone(z){
  if(!z||z===store.planZone)return;
  store.planZone=z;
  store.planFar=false;
  try{localStorage.setItem(ZONE_KEY,z);}catch(e){}
  refreshOptions();renderPlan();
}
// 進站時決定大區。**順序：記住的 → 用「我的位置」猜 → 首都圈。**
// ⚠️ 一定要在 store.events／store.places 到齊之後呼叫：兩件事都要資料
//    （驗證記住的那個還有沒有存貨、以及拿站點座標猜最近的大區）。
// ⚠️ **記住的大區若變空就退回首都圈**：活動會過期、景點會被移掉，
//    不退的話使用者會對著一片空白的三張卡，而畫面上沒有任何地方說得出原因。
// ⚠️ jpev_loc 只在這裡讀來比對距離，**座標不送出、畫面不出現地名**（硬規則不破例）。
function initPlanZone(){
  var stock=zonesWithStock(),saved=null;
  try{saved=localStorage.getItem(ZONE_KEY);}catch(e){}
  if(saved&&stock.indexOf(saved)>-1){store.planZone=saved;return;}
  if(!saved){
    var loc=null;
    try{loc=JSON.parse(localStorage.getItem(LOC_KEY)||'null');}catch(e){}
    if(loc&&typeof loc.lat==='number'&&typeof loc.lng==='number'){
      var z=nearestZone(loc.lat,loc.lng);
      // 猜出來的**不寫進 localStorage**：那是推測不是使用者的選擇。他自己按過一次才記住。
      if(z&&stock.indexOf(z)>-1){store.planZone=z;return;}
    }
  }
  store.planZone=HOME_ZONE;
}

// 桌面版（≥1024px）地圖常駐在右欄。**這個斷點必須與 CSS 那條 media query 一致**，
// 改一邊就要改另一邊，否則會出現「CSS 排成兩欄但 JS 沒把地圖打開」的空白右欄。
function planWide(){
  return !!(window.matchMedia&&window.matchMedia('(min-width:1024px)').matches);
}
// renderPlanMap() 只在 #mapBody 帶 .open 時才畫，所以桌面得把展開狀態同步過去；
// 縮回手機寬度時還原成收合，讓手機的行為與改版前完全相同。
function syncPlanMapFold(wide){
  var b=document.getElementById('mapBody'),h=document.getElementById('mapFold');
  if(!b)return;
  if(wide){b.classList.add('open');if(h)h.setAttribute('aria-expanded','true');}
  else{b.classList.remove('open');if(h)h.setAttribute('aria-expanded','false');}
}
// 行程頁與地圖頁一樣是整頁覆蓋層，底下那幾百張卡片看不見卻仍要瀏覽器維護。
// 做法與 map.js 的 openMapView/closeMapView 完全一致（連 display:none 而非
// content-visibility 的理由都相同，見 CLAUDE.md 地雷 #18），故捲動位置也要自己存還原。
var savedScroll=0;
function openPlan(){
  var before=tripDays()[0].date;
  clearRange();
  normalizeTrip();
  if(tripDays()[0].date!==before)calYM=null;
  savedScroll=window.scrollY||window.pageYOffset||0;
  document.body.classList.add('plan-open');
  planview.classList.add('show');
  tabAll.classList.remove('on');tabFav.classList.remove('on');tabPlan.classList.add('on');
  if(!store.planRO&&!store.planOpts.length)refreshOptions();
  if(planWide())syncPlanMapFold(true);   // 必須在 renderPlan() 之前，它會連帶畫地圖
  renderPlan();
}
function closePlan(){
  clearRange();
  // 票券中轉小卡掛在最上層 DOM，行程頁藏起來它不會跟著消失（同景點頁那條）。
  closeTicketSheet();
  // ⚠️ **照片預覽要在這裡收掉。** 那個節點在 `.planview` 裡面，關掉行程頁時它會跟著
  //    被 display:none 藏起來——**但 `.show` 與 `peekId` 還留著**，於是下次開行程頁
  //    會有一張上次的照片直接掛在畫面上。看起來像閃退，而且完全不報錯。
  hidePeek();
  planview.classList.remove('show');
  document.body.classList.remove('plan-open');
  tabPlan.classList.remove('on');
  (store.state.view==='fav'?tabFav:tabAll).classList.add('on');
  // 等卡片重新排版完再捲回去，否則頁面還沒長高、捲不到原位
  requestAnimationFrame(function(){window.scrollTo(0,savedScroll);});
}
// 分享連結：`?plan=<第1天>|<第2天>&d=<起日>`，每一天內用逗號分隔。
// ⚠️ **舊連結天生相容**：沒有 `|` 就只切出一段＝一天，而 `d` 的語義（那一天／起日）
//    在單日時完全相同。已經發出去的連結照樣打得開。
// ⚠️ **這個格式發布之後就不可以再改**（同景點的 `pl-` 與餐廳的 `rs-` 前綴）：
//    別人手上那條連結存的就是這一串。
function shareUrl(){
  var q=tripDays().map(function(d){return d.ids.join(',');}).join('|');
  return location.origin+location.pathname+'?plan='+q+'&d='+tripDays()[0].date;
}

// 逐字量寬換行。中日文逐字斷行本來就正確，英文會斷在字中但行程卡上多是專名，可接受。
function wrapText(ctx,text,maxW){
  var out=[],line='';
  for(var i=0;i<text.length;i++){
    var ch=text.charAt(i);
    if(line&&ctx.measureText(line+ch).width>maxW){out.push(line);line=ch;}
    else line+=ch;
  }
  if(line)out.push(line);
  return out;
}

// 行程卡的照片**只能走代理網址**（images.weserv.nl）。
// 代理會回 Access-Control-Allow-Origin: *，所以 fetch → createImageBitmap
// 畫進 canvas 不會污染。直連原圖沒有那個標頭，畫下去 canvas 就永久污染、
// toBlob 直接丟 SecurityError（已實測），故候選鏈刻意只留代理那幾條，
// **不可比照 imgChain 加上直連退路**（見 CLAUDE.md 地雷 #15）。
function planPhotoUrls(ev){
  if(!ev.img)return [];
  // 景點照片是本站自己的檔案（相對路徑），**丟進代理會找不到檔案**，
  // 匯出的行程圖片上那一格就是空的。同網域對 canvas 本來就安全（沒有跨域污染問題），
  // 這正是「照片自己拍、放自家 repo」的好處之一。
  if(isPlace(ev))return [PLACE_DIR+ev.img];
  var big=bigImgUrl(ev.img);
  return big?[proxied(big),proxied(ev.img)]:[proxied(ev.img)];
}
function loadPhoto(ev){
  var urls=planPhotoUrls(ev),i=0;
  function next(){
    if(i>=urls.length)return Promise.resolve(null);
    var u=urls[i++];
    return fetch(u,{mode:'cors'})
      .then(function(r){return r.ok?r.blob():Promise.reject(0);})
      .then(function(b){return createImageBitmap(b);})
      .catch(function(){return next();});
  }
  return next();
}
function drawCover(ctx,bm,x,y,w,h,r){
  var s=Math.max(w/bm.width,h/bm.height),dw=bm.width*s,dh=bm.height*s;
  ctx.save();ctx.beginPath();
  if(ctx.roundRect)ctx.roundRect(x,y,w,h,r);else ctx.rect(x,y,w,h);
  ctx.clip();
  ctx.drawImage(bm,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
  ctx.restore();
}
// 匯出圖上那顆 QR 指向的網址：**只編這一天**，因為圖上畫的就是這一天。
// ⚠️ 刻意不用 shareUrl()（那是整趟）：圖上寫著 8/30 四站、掃出來卻是四天，
//    兩邊對不起來。而單日的形狀 `?plan=<ids>&d=<日期>` **就是舊格式**，
//    所以這裡完全沒有動到「發布後不可再改」的分享連結格式。
// ⚠️ id 取自**畫出來的那份清單**而不是 store.plan.ids：後者可能含已經查不到的站，
//    用它會變成「圖上三站、掃到四站」。
function dayShareUrl(list){
  var ids=list.map(function(ev){return ev.id;});
  return location.origin+location.pathname+'?plan='+ids.join(',')+'&d='+store.plan.date;
}
// 把 QR 一格一格畫進 canvas。**不載任何圖**，所以完全沒有跨域污染的問題（地雷 #15）。
// ⚠️ **靜區（四周 4 格白邊）不可省**，少了就掃不到，而**畫面上完全看不出來**。
// ⚠️ 一格固定 QR_PX 個像素（整數），不要改成「縮放到固定寬度」——
//    除不盡時格子邊緣會被反鋸齒糊掉，那正是掃不到的另一個看不出來的原因。
//    代價是整塊的寬度會隨網址長短變（實測 196～260px），版面已經吃得下。
function drawQR(ctx,m,x,y){
  var n=m.length,side=(n+QR_QUIET*2)*QR_PX,r,c;
  ctx.fillStyle=QR_LIGHT;ctx.beginPath();
  if(ctx.roundRect)ctx.roundRect(x,y,side,side,10);else ctx.rect(x,y,side,side);
  ctx.fill();
  ctx.fillStyle=QR_DARK;
  for(r=0;r<n;r++)for(c=0;c<n;c++){
    if(m[r][c])ctx.fillRect(x+(c+QR_QUIET)*QR_PX,y+(r+QR_QUIET)*QR_PX,QR_PX,QR_PX);
  }
  return side;
}
function exportPlanImg(){
  var L=t(),list=planEvents();
  if(!list.length)return;
  var btn=document.getElementById('planImg'),label=btn.textContent;
  btn.disabled=true;btn.textContent=L.imgMaking;
  function done(){btn.disabled=false;btn.textContent=label;}
  Promise.all(list.map(loadPhoto))
    .then(function(bms){drawPlanCard(list,bms);done();})
    .catch(function(){done();planToast(L.imgFail);});
}
// ⚠️ **每格 5px 是量出來的，不是挑的。** 決定「掃不掃得到」的是**顯示時每格有幾個像素**
//    （要 ≳2px），而不是糾錯等級——實測拉到 Q 反而更差（格子變多、每格更小）。
//    1080 寬的圖被縮到 600px 時，4px 剛好掉到 2.2px 邊緣；5px 可以撐到 500px。
//    代價是最壞情況那塊由 260px 變 325px（佔圖寬 30%），版面實測仍放得下。
var QR_PX=5,QR_QUIET=4,QR_GAP=46,QR_TX=30;
// ⚠️⚠️ **QR 一律是「深色格子壓在淺色底上」，不跟著晝夜翻面。**
//    深色模式下若跟著翻面（淺格子壓深底），**畫面上看起來完全正常，但掃不到**
//    ——實測兩個解碼器都讀不出來，把整張圖反轉之後才讀得到。
//    所以這兩個值是刻意寫死的。**這與地雷 #7「顏色只留在 CSS」不衝突**：
//    那條講的是「同一個顏色的單一來源」，而這裡是掃描器的硬性要求、與主題無關。
//    ⚠️ 淺色模式下它們與 `--paper`／`--ink` 相同，所以淺色的圖一個像素都沒變；
//    改動 `:root` 那兩個變數時**不必**回來同步這裡。
var QR_DARK='#1A1917',QR_LIGHT='#FBFAF7';
function drawPlanCard(list,bms){
  var L=t();
  // ⚠️ **匯出的圖一律走淺色，不跟著使用者的晝夜設定**（2026-08-27）。
  //    理由是這張圖要離開 App：收到的人看到的是「寄件者當時的設定」，與他自己無關；
  //    而 QR 為了掃得到本來就被迫墊淺色底板，深色卡片上等於白方塊配黑底的混搭。
  // ⚠️ **做法刻意不是「把 data-theme 切成 light 再切回來」**：站上有十處 .18s 的
  //    color／background 轉場，而讀顏色會強制樣式重算，那些轉場會被觸發、畫面真的會閃。
  //    改成拿一個掛著 `.theme-light` 的臨時節點去讀，**完全不碰 documentElement**。
  // ⚠️ 也刻意**不把這十三個顏色寫死**：改配色時那份會過期，而且不會有任何地方報錯
  //    （晝夜預覽卡那條記載過同一個代價，而這裡是 13 個不是 6 個）。
  var ref=document.createElement('div');
  ref.className='theme-light';
  ref.style.cssText='position:absolute;width:0;height:0;overflow:hidden;';
  document.body.appendChild(ref);
  var rs=getComputedStyle(ref);
  function lv(n,fb){return (rs.getPropertyValue(n)||'').trim()||fb;}
  var paper=lv('--paper','#FBFAF7'),ink=lv('--ink','#1A1917'),
      ink2=lv('--ink-2','#6E6A63'),line=lv('--line','#E5E1D8'),
      surface=lv('--surface','#FFFFFF');
  // 分類色一次讀完就把節點收掉——`rs` 是即時的，節點拿掉之後就讀不到值了。
  var cmap={};
  list.forEach(function(ev){if(!(ev.type in cmap))cmap[ev.type]=lv('--c-'+ev.type,ink2);});
  ref.parentNode.removeChild(ref);
  var F_TTL='"Noto Serif TC","Shippori Mincho",serif',
      F_NUM='"Archivo",system-ui,sans-serif',
      F_BODY='"Noto Sans TC",system-ui,sans-serif';
  var W=1080,PAD=88,TH=184,GAPX=30,TX=PAD+TH+GAPX,TW=W-TX-PAD,GAPY=40;
  var cv=document.createElement('canvas'),ctx=cv.getContext('2d');
  ctx.font='500 40px '+F_TTL;
  var rows=list.map(function(ev,i){
    var lines=wrapText(ctx,fld(ev,'title'),TW);
    return {ev:ev,bm:bms[i],lines:lines,h:Math.max(TH,74+(lines.length-1)*52+46)};
  });
  var y=PAD+126,h=y;
  rows.forEach(function(r,i){h+=r.h+(i<rows.length-1?GAPY:0);});
  // QR 必須先算：整塊的高度取決於網址長短（愈長格子愈多），而畫布高度要現在就定。
  var qrUrl=dayShareUrl(list),qrM=qrModules(qrUrl);
  var qrSide=qrM?(qrM.length+QR_QUIET*2)*QR_PX:0;
  // 景點照片的出處（2026-09-02）。**只有真的畫了景點照片才留這一行**——
  // 沒有照片就沒有要標的東西，白留一行空白。
  // ⚠️ 這行是 CC BY／CC BY-SA 的標示義務跟著圖走：這張圖會離開 App 被分享出去，
  //    而站上那頁「圖片出處」它帶不走。逐筆列出作者在這裡放不下（一天最多 4 個景點），
  //    故指向網站；完整的作者與授權在設定 → 圖片出處。
  var credH=list.some(function(ev,i){return bms[i]&&isPlace(ev);})?34:0;
  cv.width=W;cv.height=Math.round(h+(qrSide?QR_GAP+qrSide+64:PAD+52)+credH);
  ctx.fillStyle=paper;ctx.fillRect(0,0,W,cv.height);
  ctx.textBaseline='alphabetic';
  ctx.fillStyle=ink2;ctx.font='500 22px '+F_NUM;
  ctx.fillText(L.planSub,PAD,PAD+26);
  ctx.fillStyle=ink;ctx.font='500 46px '+F_TTL;
  ctx.fillText(L.dayFmt(store.plan.date)+'（'+L.dow[dowOf(store.plan.date)]+'）',PAD,PAD+84);
  ctx.strokeStyle=line;ctx.lineWidth=2;
  ctx.beginPath();ctx.moveTo(PAD,PAD+110);ctx.lineTo(W-PAD,PAD+110);ctx.stroke();
  rows.forEach(function(r,i){
    var col=cmap[r.ev.type]||ink2;
    if(r.bm){
      drawCover(ctx,r.bm,PAD,y,TH,TH,10);
    }else{
      ctx.fillStyle=surface;ctx.beginPath();
      if(ctx.roundRect)ctx.roundRect(PAD,y,TH,TH,10);else ctx.rect(PAD,y,TH,TH);
      ctx.fill();
      ctx.fillStyle=col;ctx.font='400 26px '+F_BODY;ctx.textAlign='center';
      ctx.fillText(typeLabel(r.ev.type),PAD+TH/2,y+TH/2+9);
      ctx.textAlign='left';
    }
    ctx.fillStyle=ink2;ctx.font='500 20px '+F_NUM;
    ctx.fillText(L.stop(i+1),TX,y+26);
    ctx.fillStyle=ink;ctx.font='500 40px '+F_TTL;
    r.lines.forEach(function(ln,k){ctx.fillText(ln,TX,y+74+k*52);});
    var my=y+74+(r.lines.length-1)*52+30;
    ctx.fillStyle=col;ctx.fillRect(TX,my,14,14);
    ctx.font='400 24px '+F_BODY;
    ctx.fillText(typeLabel(r.ev.type),TX+26,my+13);
    ctx.fillStyle=ink2;
    ctx.fillText(areaLabel(r.ev.area)+(locKnown(r.ev)?'':'　'+L.vague),
                 TX+46+ctx.measureText(typeLabel(r.ev.type)).width,my+13);
    y+=r.h;
    if(i<rows.length-1){
      ctx.strokeStyle=line;ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(PAD,y+GAPY/2);ctx.lineTo(W-PAD,y+GAPY/2);ctx.stroke();
      y+=GAPY;
    }
  });
  if(qrSide){
    ctx.strokeStyle=line;ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(PAD,h+QR_GAP/2);ctx.lineTo(W-PAD,h+QR_GAP/2);ctx.stroke();
    var fy=h+QR_GAP,tx=PAD+qrSide+QR_TX;
    drawQR(ctx,qrM,PAD,fy);
    ctx.fillStyle=ink;ctx.font='500 28px '+F_BODY;
    ctx.fillText(L.qrHint,tx,fy+qrSide/2-6);
    ctx.fillStyle=ink2;ctx.font='500 21px '+F_NUM;
    ctx.fillText('events.rensakobo.com',tx,fy+qrSide/2+32);
  }else{
    ctx.fillStyle=ink2;ctx.font='500 21px '+F_NUM;
    ctx.fillText('events.rensakobo.com',PAD,cv.height-credH-PAD+18);
  }
  if(credH){
    ctx.fillStyle=ink2;ctx.font='400 18px '+F_BODY;
    ctx.fillText(L.planCredit,PAD,cv.height-24);
  }
  // 有照片後改存 JPEG：同一張圖 PNG 會大上一倍有餘。底色已填滿，不需要透明度。
  cv.toBlob(function(blob){
    if(!blob){planToast(L.imgFail);return;}
    var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='plan-'+store.plan.date+'.jpg';
    document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.parentNode.removeChild(a);},1000);
    planToast(L.imgSaved);
  },'image/jpeg',0.92);
}

document.getElementById('planClose').addEventListener('click',closePlan);

function bindFold(hid,bid,after){
  var h=document.getElementById(hid),b=document.getElementById(bid);
  h.addEventListener('click',function(){
    var open=b.classList.toggle('open');
    h.setAttribute('aria-expanded',open?'true':'false');
    if(open&&after)after();
  });
}
// ⚠️ **改起日 ＝ 整趟平移**（使用者定案）。一趟旅行往後挪一天是很自然的動作，
// 而只改第一天會讓後面幾天的日期與它斷開，「連續」就得另外維護。
// ⚠️ 平移後有些活動那天沒在辦時**只提示、不自動刪**：自動刪又變成靜默消失。
function setPlanDate(d){
  if(!d)return;
  shiftTripTo(d);
  pickSpot='';savePlan();
  refreshOptions();renderPlan();
  var n=outOfRangeCount();
  if(n>0)planToast(t().shifted(n));
}
// 從 s 走到 e 是幾天（含頭尾算 1）。⚠️ **刻意用 addDays 逐日走，不用 Date 相減**：
// 有夏令時間的時區會讓「毫秒差 / 86400000」差一天，而本站的日期一律是字串（地雷 #1）。
// 只走到上限再多一步就夠——再遠都一律當「太長」，不必算出真正的天數。
function rangeLen(s,e){
  var n=1,d=s;
  while(d<e&&n<=TRIP_MAX_DAYS){d=addDays(d,1);n++;}
  return d<e?TRIP_MAX_DAYS+1:n;
}
// 套用一段日期（月曆點第二下走這裡）。
// ⚠️ **站永遠跟著「第幾天」走，不跟著日期走**：第 1 天的站還是第 1 天的站，
//    只是那天換了個日期。這與 shiftTripTo 的語義完全一致——改日期不會讓站搬家。
// ⚠️ **縮短時被砍的是尾端那幾天**，而且有站的話要按兩次才真的砍
//    （同 removeLastDay）：一次就砍等於一口氣靜默弄丟好幾天的站。
function applyRange(s,e){
  var L=t(),d=tripDays(),n=rangeLen(s,e),capped=0;
  if(n>TRIP_MAX_DAYS){n=TRIP_MAX_DAYS;capped=1;}
  var key=s+'~'+n;
  if(n<d.length){
    var lost=0,i;
    for(i=n;i<d.length;i++)lost+=d[i].ids.length;
    if(lost>0&&shrinkArm!==key){
      shrinkArm=key;clearTimeout(shrinkArmT);
      shrinkArmT=setTimeout(function(){shrinkArm='';},3000);
      planToast(L.shrinkWarn(n+1,d.length,lost));
      return 0;                                       // 沒套用：呼叫端要讓月曆留著
    }
  }
  clearTimeout(shrinkArmT);shrinkArm='';
  // 天數有變才動 planSel／calYM，只是平移就不動——這樣「整趟往後挪」與跨天之前
  // 的 setPlanDate 行為一字不差，而加減天數則沿用 addDay／removeLastDay 的行為。
  var resized=(n!==d.length);
  if(n<d.length)d.length=n;
  while(d.length<n)d.push({date:'',ids:[]});
  if(resized){
    if(store.dayIdx>=d.length)store.dayIdx=d.length-1;
    store.planSel=-1;
  }
  shiftTripTo(s);
  pickSpot='';savePlan();
  refreshOptions();renderPlan();
  // ⚠️ 截斷的提示要**印出實際變成哪一天**：只說「最多 7 天」使用者不知道發生了什麼。
  if(capped)planToast(L.tripCapped(md(s),md(tripDays()[n-1].date)));
  else{
    var oor=outOfRangeCount();
    if(oor>0)planToast(L.shifted(oor));
  }
  return 1;
}
// 日期切換列。**切天／加天／減天三顆綁在同一個容器上**（它整段被 innerHTML 重畫，
// 所以監聽器掛在不會被換掉的容器上，綁一次就夠）。
document.getElementById('planDays').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-dayadd')){addDay();return;}
  if(b.hasAttribute('data-daydel')){removeLastDay();return;}
  if(b.dataset.day!==undefined)setDay(+b.dataset.day);
});
document.getElementById('planQuick').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  calYM=null;clearRange();setPlanDate(b.dataset.d);
});
// 選好整段就把月曆收起來，讓三套行程浮上來（月曆佔掉手機畫面三分之一）
function closeDateFold(){
  document.getElementById('dateBody').classList.remove('open');
  document.getElementById('dateFold').setAttribute('aria-expanded','false');
}
// 月曆＝**訂飯店式的區間選擇**（2026-08-27）：點起日、點結束日，中間整段高亮。
// ⚠️ **單日時第一下立刻生效**（與跨天之前一字不差）；多天時第一下只標起點、行程
//    完全不動——後者若照單日那樣立刻套用，會把整趟塌成一天，而那是靜默的。
document.getElementById('cal').addEventListener('click',function(e){
  var b=e.target.closest('.day');if(!b||!b.dataset.d)return;
  var d=b.dataset.d;
  // 第二下：點在起日或它之後 → 這一下就是結束日，套用整段。
  // ⚠️ 點到**更早**的日子一律當成「重新標起日」（同飯店月曆），不是反向區間。
  if(rangeStart&&d>=rangeStart){
    var s=rangeStart;rangeStart='';
    // 回 0 ＝縮短待確認，只跳了提示還沒套用：把起點放回去，讓人再點一次同一格。
    if(!applyRange(s,d)){rangeStart=s;buildCal();return;}
    closeDateFold();
    return;
  }
  rangeStart=d;
  // ⚠️ **單日時刻意不收合月曆**（跨天之前是點完就收）。收了的話「再選一天延長成多天」
  //    這條路對單日使用者永遠碰不到，而單日正是多數人——等於功能做了大半的人用不到。
  //    提示行會說明它為什麼還開著。
  if(tripDays().length===1)setPlanDate(d);
  else buildCal();
});
// ⚠️ **換月絕對不可以清掉 rangeStart**：8/30 → 9/2 這種跨月區間，本來就得先翻到
//    下個月才點得到結束日。這兩顆完全不碰它是刻意的。
document.getElementById('calPrev').addEventListener('click',function(){
  calYM=(calYM[1]===1)?[calYM[0]-1,12]:[calYM[0],calYM[1]-1];buildCal();
});
document.getElementById('calNext').addEventListener('click',function(){
  calYM=(calYM[1]===12)?[calYM[0]+1,1]:[calYM[0],calYM[1]+1];buildCal();
});
// 使用者自己把日期區收起來時，「選擇中」也一起清掉——留著的話下次展開會停在一個
// 他早就忘記的起點上。⚠️ 用 setTimeout 讓 bindFold 的 toggle 先跑完再看狀態：
// 兩個監聽器掛在同一顆按鈕上，先後取決於 main.js 什麼時候呼叫 bindFold，不該依賴它。
document.getElementById('dateFold').addEventListener('click',function(){
  setTimeout(function(){
    if(!document.getElementById('dateBody').classList.contains('open')&&rangeStart){
      clearRange();buildCal();
    }
  },0);
});
document.getElementById('planShuffle').addEventListener('click',function(){
  refreshOptions();renderPlan();
});
document.getElementById('farToggle').addEventListener('click',function(){
  store.planFar=!store.planFar;refreshOptions();renderPlan();
});
document.getElementById('zoneRow').addEventListener('click',function(e){
  var b=e.target.closest('[data-zone]');if(!b)return;
  setPlanZone(b.dataset.zone);
});
document.getElementById('pcards').addEventListener('click',function(e){
  var ad=e.target.closest('[data-adopt]');
  if(ad){adoptOption(+ad.dataset.adopt);return;}
  var c=e.target.closest('.pcard');if(!c)return;
  store.planSel=+c.dataset.opt;          // 點卡片只是選中（地圖跟著高亮），要按「採用」才進行程
  renderPlan();
});
document.getElementById('planList').addEventListener('click',function(e){
  var b=e.target.closest('[data-del]');if(!b)return;
  var i=store.plan.ids.indexOf(b.dataset.del);
  if(i>-1){store.plan.ids.splice(i,1);store.planSel=-1;savePlan();renderPlan();}
});
// 狀態在 route.js、重畫是這裡的事，所以綁在這裡（「事件綁定跟著它操作的模組走」）。
// #routeChips 本身不會被換掉（只換 innerHTML），故綁一次就夠。
document.getElementById('routeChips').addEventListener('click',function(e){
  var b=e.target.closest('[data-rmode]');if(!b)return;
  if(b.dataset.rmode===routeMode())return;
  setRouteMode(b.dataset.rmode);
  renderPlan();
});
document.getElementById('areaPick').addEventListener('click',function(e){
  var b=e.target.closest('[data-area]');if(!b)return;
  pickArea=(pickArea===b.dataset.area)?'':b.dataset.area;
  pickSpot='';buildSelf();
});
document.getElementById('spotPick').addEventListener('click',function(e){
  var b=e.target.closest('[data-spot]');if(!b)return;
  pickSpot=b.dataset.spot;buildSelf();
});
function browseClick(e){
  var a=e.target.closest('[data-add]');
  if(a){if(addToPlan(a.dataset.add)){store.planSel=-1;renderPlan();}return;}
  var d=e.target.closest('[data-del]');       // 已加入的按一下就移除
  if(!d)return;
  var i=store.plan.ids.indexOf(d.dataset.del);
  if(i>-1){store.plan.ids.splice(i,1);store.planSel=-1;savePlan();renderPlan();}
}
// 「加一頓飯」那一段。**「＋」與其餘控制項分開處理**：加入必須走 addToPlan()
// （上限、提示、唯讀守門三件事都在裡面），而餐別 chip／看更多是 plan-food 自己的狀態。
var foodBody=document.getElementById('foodBody');
foodBody.addEventListener('click',function(e){
  var a=e.target.closest('[data-food-add]');
  if(a){toggleFood(a.getAttribute('data-food-add'));return;}
  if(handleFoodControl(e))renderFoodBody();
});
foodBody.addEventListener('change',function(e){
  if(e.target&&e.target.id==='foodGenre'&&setFoodGenre(e.target.value))renderFoodBody();
});
document.getElementById('planBrowse').addEventListener('click',browseClick);
// 景點段與活動段的行為完全相同（加入／移除），故直接共用同一個處理函式。
document.getElementById('planPlaces').addEventListener('click',browseClick);

// ===== 行程列的照片預覽（2026-08-27）=====
// 三處共用同一個節點與同一段程式：我的行程、三套推薦卡、「自己組」的候選（活動與景點）。
// 桌機滑上去停一下浮出、手機點一下彈出。**既有版面一個像素都沒動**——列裡沒有多出
// 任何欄位，多出來的只有一個 `data-peek` 屬性。
// ⚠️ **綁在 `#planview` 上，不是綁在那三個清單容器上**：它們都是 innerHTML 整段重畫的
//    （光是點一下三套卡就會重畫一次），綁在列上或重畫的容器裡都會在那一刻靜默失效。
//    `#planview` 本身永遠不會被換掉。
// ⚠️ **「加一頓飯」的候選列不在範圍內**（使用者決定）。它走的是 plan-food.js 自己的
//    `rowHTML`、沒有 `data-peek`，所以這裡天生碰不到，不必寫一行排除。
// ⚠️ **導覽期間不必特別擋**：`.tourview` 是整片 fixed 的遮罩，滑鼠事件根本到不了這裡。
//    日後若導覽改成不吃事件，這裡最壞也只是彈出一張被遮罩蓋住的照片，無害。
var peek=document.getElementById('planPeek');
// 這台裝置停得住嗎。⚠️ **不要判 UA**：接了鍵盤的 iPad、觸控筆電那些都會猜錯，
// 而 `(hover:hover)` 問的正好就是這件事本身。
var canHover=!!(window.matchMedia&&window.matchMedia('(hover: hover)').matches);
var PEEK_DELAY=180;   // 停多久才浮出。少了它，快速掃過一排會連發好幾個請求、閃一串「載入中」
var peekT=null,peekWant='',peekId='',peekSeq=0,peekX=0,peekY=0;
// 這一筆最後載成功的是哪個網址（**空字串＝確定沒有照片**，與 undefined＝還沒問過不同，
// 同 favfood 的 `known` 為 null 那條）。第二次滑上去就不必再閃一次「載入中」。
var peekMemo={};

function peekBlock(msg){return '<div class="peek-block">'+esc(msg)+'</div>';}

// 照片來源分兩條，與 `planRowHTML` 的縮圖分支同一套判斷：
// 景點是本站自己的檔案（同網域、版權自有），**不經 images.weserv.nl**；
// 活動走既有的三層候選鏈（代理大圖 → 直連大圖 → 原網址）。
// ⚠️ **餐廳一律回空陣列**：行程頁載的 `_map.json` 只有九個欄位，連 `img` 都沒有。
// ⚠️ **代理寬度刻意用預設的 IMG_W(900)、不另訂小尺寸**：那與清單卡片是**同一個網址**，
//    而使用者多半是從清單把活動加進行程的——於是直接命中瀏覽器快取、零延遲。
function peekChain(ev){
  if(!ev)return [];
  if(isPlace(ev))return ev.img?[PLACE_DIR+ev.img]:[];
  return imgChain(ev);
}

// 手機：被點的那一列在畫面下半部時，浮窗改貼上緣，免得蓋住使用者剛剛點的東西。
// ⚠️ **判準用「點擊的 y 座標」而不是那一列的位置**：點三套卡會先觸發重畫（既有行為），
//    那時列節點已經被換掉、`getBoundingClientRect()` 全回 0，於是永遠判成上半部。
//    手指的位置不會被重畫影響，而且它本來就是我們真正想避開的那一點。
function placeTouchPeek(clickY){
  if(canHover)return;
  peek.classList.toggle('at-top', clickY > window.innerHeight/2);
}

function showPeek(id,clickY){
  var L=t();
  peekId=id;peek.classList.add('show');
  if(clickY!==undefined)placeTouchPeek(clickY);
  var memo=peekMemo[id];
  if(memo!==undefined){        // 問過了，直接畫，不再閃一次「載入中」
    peek.innerHTML=memo?'<img src="'+esc(memo)+'" alt="">':peekBlock(L.peekNone);
    placePeek();return;
  }
  var chain=peekChain(evById(id));
  if(!chain.length){peekMemo[id]='';peek.innerHTML=peekBlock(L.peekNone);placePeek();return;}
  peek.innerHTML=peekBlock(L.loading);
  placePeek();
  // ⚠️ **先在背景載好再換上去**，不要直接把 `<img>` 塞進去等它自己畫——那會先出現一個
  //    空框、再突然長高，而桌機的浮窗是跟著滑鼠的，那一下跳動看起來像閃爍。
  var seq=++peekSeq,i=0,probe=new Image();
  probe.onload=function(){
    if(seq!==peekSeq)return;   // 已經滑到別列去了，這張沒人要了
    peekMemo[id]=chain[i];
    peek.innerHTML='<img src="'+esc(chain[i])+'" alt="">';
    placePeek();               // 高度變了要重新定位，否則直式照片會掉出畫面下緣
  };
  probe.onerror=function(){
    if(seq!==peekSeq)return;
    if(++i<chain.length){probe.src=chain[i];return;}   // 換下一個候選網址
    peekMemo[id]='';peek.innerHTML=peekBlock(L.peekNone);placePeek();
  };
  probe.src=chain[0];
}

function hidePeek(){
  peekSeq++;                   // 作廢還在路上的那張圖
  peekWant='';peekId='';
  peek.classList.remove('show');
  clearTimeout(peekT);peekT=null;
}

// 跟著滑鼠，但不可以跑出畫面：靠近右緣就翻到左邊、上下超出就貼邊。
// ⚠️ **只有桌機寫 inline 定位。** 手機版的位置全部由 CSS 的 `@media (hover:none)` 決定，
//    這裡寫進去 inline 會永遠贏、把那整段蓋掉（導覽的高亮框踩過同一個坑）。
function placePeek(){
  if(!canHover)return;
  var gap=16,w=peek.offsetWidth||280,h=peek.offsetHeight||96;
  var left=peekX+gap;
  if(left+w>window.innerWidth-8)left=peekX-gap-w;
  if(left<8)left=8;
  var top=peekY-h/2;
  if(top+h>window.innerHeight-8)top=window.innerHeight-8-h;
  if(top<8)top=8;
  peek.style.left=left+'px';peek.style.top=top+'px';
}

if(canHover){
  // `mouseover` 而不是 `mouseenter`——後者不冒泡，委派收不到。
  planview.addEventListener('mouseover',function(e){
    // 按鈕、外連、營業時間收合區：滑到它們上面就把照片收掉。那時使用者的目標是那顆
    // 東西，跳一張圖只會擋路；而**收掉**（不是原地不動）才不會讓照片賴在畫面上。
    if(e.target.closest('button,a,details')){hidePeek();return;}
    var r=e.target.closest('[data-peek]');
    if(!r){hidePeek();return;}
    var id=r.getAttribute('data-peek');
    // ⚠️ **比對的是 `peekWant` 不是 `peekId`。** 一列裡有好幾個子元素，滑鼠在列內移動
    //    時 mouseover 會一直重複觸發——只看「已經顯示的那筆」的話，等待中的計時器
    //    會被自己不斷重設，於是**永遠等不到浮出來**。
    if(id===peekWant)return;
    hidePeek();
    peekWant=id;
    peekT=setTimeout(function(){showPeek(id);},PEEK_DELAY);
  });
  planview.addEventListener('mousemove',function(e){
    peekX=e.clientX;peekY=e.clientY;
    if(peekId)placePeek();
  });
  planview.addEventListener('mouseleave',hidePeek);
}else{
  // 手機：點一下彈出、再點任何地方收掉。
  // ⚠️ **不阻斷冒泡也不 preventDefault**：三套卡「點卡片＝選中那一套」是既有行為，
  //    照樣要成立（那一段的監聽器綁在 `#pcards` 上，比這裡先跑）。照片是額外的。
  planview.addEventListener('click',function(e){
    if(e.target.closest('button,a,details')){hidePeek();return;}
    // 點浮窗自己＝收起來。它是唯一會蓋在列上面的東西，不給關的話使用者得先猜要點哪裡。
    if(peek.contains(e.target)){hidePeek();return;}
    var r=e.target.closest('[data-peek]');
    if(!r){hidePeek();return;}
    var id=r.getAttribute('data-peek');
    if(id===peekId){hidePeek();return;}   // 再點同一列＝收起來
    hidePeek();showPeek(id,e.clientY);
  });
  // ⚠️ **捲動要監聽 `document` 的捕獲階段**：行程頁的內容是在 `.planbody` 裡捲的，
  //    而 `scroll` 不冒泡到 window——綁在 window 上完全收不到（導覽踩過同一條）。
  document.addEventListener('scroll',function(){if(peekId)hidePeek();},true);
}

document.getElementById('planImg').addEventListener('click',exportPlanImg);
document.getElementById('planShare').addEventListener('click',function(){
  var u=shareUrl(),L=t();
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(u).then(function(){planToast(L.copied);},
      function(){planToast(L.copyFail);});
  }else{
    // 舊 Safari／非安全來源沒有 clipboard API，退回選取複製
    var ta=document.createElement('textarea');
    ta.value=u;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');planToast(L.copied);}
    catch(err){planToast(L.copyFail);}
    document.body.removeChild(ta);
  }
});
document.getElementById('planOwn').addEventListener('click',function(){
  store.planRO=false;savePlan();
  if(history.replaceState)history.replaceState(null,'',location.pathname);
  refreshOptions();renderPlan();
});

// 分享連結：?plan=<第1天>|<第2天>&d=YYYY-MM-DD（起日）
// ⚠️ **舊連結沒有 `|`，split 之後就是一段＝一天**，所以完全不必特別處理相容性。
function readSharedPlan(){
  if(location.search.indexOf('plan=')<0)return false;
  var m=/[?&]plan=([^&]*)/.exec(location.search);
  var d=/[?&]d=(\d{4}-\d{2}-\d{2})/.exec(location.search);
  if(!m||!m[1])return false;
  function okId(s){
    // 活動 id 是 md5 前 12 碼；景點是 pl- 開頭的 slug（單位 H）；
    // 餐廳是 rs-l-／rs-d- 開頭（單位 I）。
    // ⚠️ **每加一種資料就要記得在這裡放行**：這道白名單擋在「查不到就說一句話」之前，
    // 被擋掉的 id 連錯誤訊息都不會有，那一站直接憑空消失——景點當初就踩過這個坑。
    return /^[0-9a-f]{6,32}$/.test(s)||/^pl-[a-z0-9-]{1,40}$/.test(s)
      ||/^rs-[ld]-[0-9a-f]{6,32}$/.test(s);
  }
  var start=d?d[1]:todayStr();
  var segs=decodeURIComponent(m[1]).split('|').slice(0,TRIP_MAX_DAYS);
  var total=0;
  var days=segs.map(function(seg,i){
    var ids=capPlanIds(seg.split(',').filter(okId));
    total+=ids.length;
    return {date:addDays(start,i),ids:ids};          // 連續：第 i 天就是起日 +i
  });
  if(!total)return false;
  store.planRO=true;
  store.trip={days:days};store.dayIdx=0;
  return true;
}

// ⚠️ `addToPlan` 是**唯一**可以往行程加一站的入口（景點分頁也走它）。
// 它已經處理好 PLAN_MAX=4 的上限與滿了的提示，以及唯讀（分享）模式不可寫入。
// **不要在別的模組自己 push store.plan.ids**——那三件事會漏掉其中一件，
// 而漏掉的症狀是「按了沒反應」或「一天排出五站」，兩種都看不出是哪裡壞的。
// closePlan 對外開放是給網頁導覽用的（2026-08-21 第二批）：示範完要自己把行程頁收掉。
// **方向是 tour → plan-ui，plan-ui 不知道 tour 的存在**（同 places.js 那條）。
export { addToPlan, askPlanDate, bindFold, capPlanIds, closeDateSheet, closePlan, initPlanZone, openPlan, planDateReady, planWide, planview, pmap, readSharedPlan, renderFoodBody, renderPlan, renderPlanMap, requestAddFood, restoreTrip, syncPlanMapFold };
