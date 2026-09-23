// 行程演算法：選站、最短路徑排序、據點歸屬。**不碰 DOM**。
import { CORE_AREAS, HOME_ZONE, PACES, PLAN_ZONES, REC_MAX_KM, SPOTS, SPOT_AREAS, SPOT_R, WALK_KM } from './config.js';
import { store } from './store.js';
import { activeOn, areaLabel, evById, hav, isRestaurant, locKnown, otherDayIds, spanDays, t, venueKey, zoneOfArea } from './util.js';

function planEvents(){
  var out=[];
  store.plan.ids.forEach(function(id){var e=evById(id);if(e)out.push(e);});
  return orderStops(out);
}
// 站數最多四站，直接枚舉全部排列才保證相鄰站總距離最短；起點不固定。
// 花火固定在尾端，其餘站仍完整參與排列。缺座標時維持呼叫端原本的順序。
function orderCore(list){
  if(!list||list.length<2||list.length>4)return list;
  var free=[],tail=[];
  for(var i=0;i<list.length;i++){
    var e=list[i];
    (e.type==='煙火'?tail:free).push(e);
  }
  var best=null,bestKm=Infinity;
  function visit(path,left){
    if(!left.length){
      var cand=path.concat(tail),km=0;
      for(var k=1;k<cand.length;k++)
        km+=hav(cand[k-1].lat,cand[k-1].lng,cand[k].lat,cand[k].lng);
      if(km<bestKm){bestKm=km;best=cand;}
      return;
    }
    for(var j=0;j<left.length;j++){
      var next=left.slice(),item=next.splice(j,1)[0];
      visit(path.concat([item]),next);
    }
  }
  visit([],free);
  return best||list;
}
// ⚠️ **餐廳刻意不進上面那個窮舉排列**（單位 I 決策 20）。
// 根因是**距離算不出「幾點吃飯」**：丟進去一起排會出現兩種一看就是壞掉的結果——
// **兩家餐廳被排成連號**（同一區的店彼此本來就近）、**一開場就吃晚餐**。
// 這與「花火固定尾端」是同一條既有原則：行程本來就承認「有些站有時間性」，
// 餐廳只是第二個例子。附帶好處是六站也不會讓排列數爆掉（餐廳根本不參與窮舉）。
//
// 排法：活動與景點先排好 → **午餐插中段、晚餐接尾**，花火仍在更後面。
// 中段取 `ceil(n/2)`，所以「兩站」會排成「A → 午餐 → B」而不是「午餐 → A → B」
// ——先出門再吃飯比較像真的一天。
function weaveFood(core,lunch,dinner){
  var rest=[],fire=[];
  core.forEach(function(e){(e.type==='煙火'?fire:rest).push(e);});
  var mid=Math.ceil(rest.length/2);
  return rest.slice(0,mid).concat(lunch,rest.slice(mid),dinner,fire);
}
function orderStops(list){
  if(!list||list.length<2)return list;
  var core=[],lunch=[],dinner=[];
  for(var i=0;i<list.length;i++){
    var e=list[i];
    // 缺座標就整串原樣回傳（既有行為）。**這道守門要涵蓋餐廳**——
    // 排不出距離時，猜一個順序比維持使用者加入的順序更糟。
    if(!e||typeof e.lat!=='number'||typeof e.lng!=='number'
        ||!isFinite(e.lat)||!isFinite(e.lng))return list;
    if(isRestaurant(e))(e.meal==='dinner'?dinner:lunch).push(e);
    else core.push(e);
  }
  if(!lunch.length&&!dinner.length)return orderCore(core);
  return weaveFood(orderCore(core),lunch,dinner);
}
// 月曆密度點算「當天的短期活動數」（檔期 ≤7 天）而非全部。
// 實測七成活動檔期超過一個月（常設展每天都在），用總數畫每一格都一樣多。
function shortCount(d){
  var n=0;
  for(var i=0;i<store.events.length;i++)
    if(activeOn(store.events[i],d)&&spanDays(store.events[i])<=7)n++;
  return n;
}
function spotOf(ev){
  if(!SPOT_AREAS[ev.area]||!locKnown(ev))return '';
  var best='',bd=99;
  for(var k in SPOTS){
    var d=hav(ev.lat,ev.lng,SPOTS[k][0],SPOTS[k][1]);
    if(d<bd){best=k;bd=d;}
  }
  return bd<=SPOT_R?best:'';
}
// 「不同地區」對東京23區太粗：113 個活動散在澀谷、上野、池袋…，
// 三套都在 23 區但各在不同站周邊，其實就是三種不同的一天。故 23 區改用據點當區隔單位。
// **2026-08-28 起這件事改由 `SPOT_AREAS` 決定**（東京23區／大阪／京都）。
// ⚠️ 不改的話行程會認為「梅田和天王寺是同一區」，三套的「區域不同」就退化成
// 「整個大阪算一區」——而畫面上只是三張卡剛好都在大阪，看不出是壞的。
function zoneOf(ev){
  if(SPOT_AREAS[ev.area]){var s=spotOf(ev);return 'spot:'+(s||'其他');}
  return 'area:'+ev.area;
}
                                // 語言切換時不可跟著變，否則 pickSpot 比對會失效。
function spotLabel(s){
  var m=t().spots;
  return (m&&m[s])||s;
}
function zoneLabel(ev){
  var s=SPOT_AREAS[ev.area]?spotOf(ev):'';
  return s?spotLabel(s):areaLabel(ev.area);
}
function shuffle(a){
  for(var i=a.length-1;i>0;i--){
    var j=Math.floor(Math.random()*(i+1)),tmp=a[i];a[i]=a[j];a[j]=tmp;
  }
  return a;
}

// ---- 三套行程的產生 ----
// ⚠️ **候選池要濾掉「已經排在其他天」的站**（單位 J，2026-08-26）。不濾的話四天的行程
// 會被推薦同一個莫內展四次——而那看起來只是「這個展很紅」，一點都不像壞掉。
// **抽選演算法本身一行都沒動**，只是餵進去之前少了那幾筆（使用者指定的做法）。
// ⚠️ `otherDayIds()` **不含目前這一天**，所以單日行程的候選池與跨天之前逐筆相同。
// 「這個桶算不算在目前的候選池裡」（單位 N，2026-09-03）。**活動與景點共用同一個判斷**
// ——兩個池子講的是同一件事，分兩處寫必然漂移（同 planFoodIdOf 被搬進 util 的理由）。
//
// 兩層：先過大區，再在**首都圈裡面**沿用原本的市區／郊外二分。
// ⚠️ **首都圈以外不分市區／郊外**（定案 2）：那些大區地廣人稀，再切一次只會把本來就
//    不多的候選切成兩半，而使用者會看到兩邊都組不出行程。
// ⚠️ **`planFar=false`（市區）那條的結果與改動前逐筆相同**——CORE_AREAS 那四個桶
//    本來就全在首都圈裡。真正變的是 `planFar=true`：以前它是「所有非核心桶」，
//    **候選裡本來就混著大阪京都**（26 桶之後還會混進北海道與沖繩），現在只剩首都圈的遠處。
//    **那個改變正是單位 N 要修的東西**，不是副作用。
function inPlanZone(area){
  if(zoneOfArea(area)!==store.planZone)return false;
  if(store.planZone!==HOME_ZONE)return true;
  return store.planFar?!CORE_AREAS[area]:!!CORE_AREAS[area];
}
// 「哪些大區真的有東西可排」（單位 N）。**畫面上的大區清單是算出來的，不是寫死的。**
// ⚠️ 理由很具體：PLAN_ZONES 寫滿了七個，但今天只有首都圈與關西有存貨——中部、北海道、
//    東北、中國四國、九州沖繩**一筆活動、一筆景點都沒有**（活動等單位 O、景點等單位 P）。
//    列出來的話使用者切過去看到的是三張空卡，**那比不分大區更糟**。
//    算出來則是：O 與 P 做完的那一天，新大區自己冒出來，程式一行都不必改。
// ⚠️ **判準刻意是「有沒有存貨」而不是「今天排不排得出來」**：後者會讓大區列隨著切天
//    忽隱忽現（某天關西沒活動就整顆消失），而那看起來像壞掉。
//    所以活動這邊**不看日期**，只問「有沒有一筆有座標的活動落在這個大區」。
// ⚠️ store.events 還沒載到時回空陣列——同 goneList() 在資料空的時候必須回空的理由，
//    載入中先不畫比畫錯好，而 render 在資料到齊後本來就會再跑一次。
function zonesWithStock(){
  var seen={},i,z;
  for(i=0;i<store.events.length;i++){
    if(!locKnown(store.events[i]))continue;
    z=zoneOfArea(store.events[i].area); if(z)seen[z]=1;
  }
  for(i=0;i<store.places.length;i++){
    if(!locKnown(store.places[i]))continue;
    z=zoneOfArea(store.places[i].area); if(z)seen[z]=1;
  }
  return Object.keys(PLAN_ZONES).filter(function(k){return seen[k];});
}
// 「離這個座標最近的大區」（單位 N，只在第一次進站猜一次）。
// ⚠️ **刻意不建一張大區中心座標表**：那會是第二個「兩邊要同步」的坑，而 config.js 早就
//    為了同一個理由拒絕把 AREA_CENTER 複製進前端（見 LOC_VIEW 的註解）。
//    資料自己就是座標來源——找離使用者最近的那一個站點，看它在哪個大區。
//    好處是**新地區開通後自動生效**，而且天生只會猜到「真的有存貨」的大區。
// ⚠️ 座標只在裝置上比對，**不送出、不反查地名**（twev_loc 的硬規則不破例）。
function nearestZone(lat,lng){
  var best=null,bd=Infinity,i,z,d,arr=[store.events,store.places],k,list;
  for(k=0;k<arr.length;k++){
    list=arr[k];
    for(i=0;i<list.length;i++){
      if(!locKnown(list[i]))continue;
      z=zoneOfArea(list[i].area); if(!z)continue;
      d=hav(lat,lng,list[i].lat,list[i].lng);
      if(d<bd){bd=d;best=z;}
    }
  }
  return best;
}
function optionPool(){
  var used=otherDayIds();
  return store.events.filter(function(ev){
    if(used[ev.id])return false;
    if(!activeOn(ev,store.plan.date)||!locKnown(ev))return false;   // 排不了路線的不進自動行程
    return inPlanZone(ev.area);
  });
}
// 常設景點的候選池（單位 H）。條件與 optionPool 相同**只差沒有日期那一條**——
// 景點天天都在，`activeOn` 對它一律回 false（沒有 date_start），所以它永遠不會
// 自己跑進 optionPool，必須像這樣明確注入。
function placePool(){
  var used=otherDayIds();                                           // 同上：其他天排過的景點不再推薦
  return store.places.filter(function(p){
    if(used[p.id])return false;
    if(!locKnown(p))return false;                                   // 只有概略位置的排不了路線
    return inPlanZone(p.area);
  });
}
// 抽一套。**隨機抽而不是挑最佳**——挑最佳會每次都給同一個答案，「換一批」就形同虛設；
// 而且最佳解一味求近，實測會退化成「三站都在同一棟樓」。
function pickOne(pool,n,usedZones,usedIds,favSet){
  var cand=pool.filter(function(e){
    return !usedIds[e.id]&&!usedZones[zoneOf(e)];
  });
  var anchors=cand.filter(function(e){return e.type!=='煙火';});  // 花火是晚上的活動，不當起點
  if(favSet){
    anchors=anchors.filter(function(e){return favSet[e.id];});
    if(!anchors.length)return null;
  }
  shuffle(anchors);
  for(var i=0;i<anchors.length;i++){
    var a=anchors[i];
    var near=cand.filter(function(e){
      return e.id!==a.id&&venueKey(e)!==venueKey(a)
        &&hav(a.lat,a.lng,e.lat,e.lng)<=REC_MAX_KM;
    });
    shuffle(near);
    // 略偏好短檔期（這天才有的），否則三套永遠都是那幾個常設展
    near.sort(function(x,y){return (spanDays(x)<=7?0:1)-(spanDays(y)<=7?0:1);});
    var stops=[a],seenT={},seenV={};
    seenT[a.type]=1;seenV[venueKey(a)]=1;
    for(var j=0;j<near.length&&stops.length<n;j++){
      var e=near[j];
      if(seenT[e.type]||seenV[venueKey(e)])continue;
      var ok=true;
      for(var m=0;m<stops.length;m++){          // 要跟「每一站」都在範圍內，不是只跟起點近
        if(hav(stops[m].lat,stops[m].lng,e.lat,e.lng)>REC_MAX_KM){ok=false;break;}
      }
      if(!ok)continue;
      stops.push(e);seenT[e.type]=1;seenV[venueKey(e)]=1;
    }
    if(stops.length<n)continue;
    var hasFav=false;
    stops.forEach(function(e){if(store.favs.indexOf(e.id)>-1)hasFav=true;});
    stops=orderStops(stops);
    return {stops:stops,pace:n,fav:hasFav};
  }
  return null;
}
function buildOptions(){
  var basePool=optionPool(),places=placePool();
  var favSet={};
  store.favs.forEach(function(id){
    var e=evById(id);
    if(e&&activeOn(e,store.plan.date))favSet[id]=1;                 // 只有當天有在辦的收藏才算
  });
  var out=[],usedZones={},usedIds={};
  for(var k=0;k<PACES.length;k++){
    // **只有站數最多的那一套（第三套）混入景點。** 三套都混的話會開始每天長得一樣，
    // 「換一批」就失去意義；而綁「站數＝4」則會讓活動最少、最需要補位的日子
    // 反而完全沒有景點，且畫面上看不出來——所以綁的是「第三套」這個位置，
    // 降階成 3 站或 2 站時景點照樣參與。
    // 「一套最多一個景點」不必寫程式：pickOne 既有的 seenT[e.type] 天生保證，
    // 因為所有景點共用同一個分類值。
    var pool=(k===PACES.length-1)?basePool.concat(places):basePool;
    var p=null,want;
    // 第一套優先錨定收藏的活動；組不出來就放掉這個條件。
    // 站數不夠時自動降階（4→3→2），不留空卡。
    if(!out.length){
      for(want=PACES[k];want>=2&&!p;want--)p=pickOne(pool,want,usedZones,usedIds,favSet);
    }
    for(want=PACES[k];want>=2&&!p;want--)p=pickOne(pool,want,usedZones,usedIds,null);
    // 區域用完了就允許重複，總比少一張卡好
    for(want=PACES[k];want>=2&&!p;want--)p=pickOne(pool,want,{},usedIds,null);
    if(!p)continue;
    out.push(p);
    // **記錄的必須是重排後的第一站，也就是卡片標題顯示的那個區域。**
    // pickOne 的候選篩選是對「每一站」比對 usedZones，不是只比對錨點，
    // 所以記錄任何一站都足以讓下一套完全避開該區；記錄 stops[0] 則額外保證
    // 三張卡「顯示出來」的區域也互不重複。曾改記錄原錨點，結果三套的錨點雖不同區，
    // 卡片標題卻出現「表參道／秋葉原／秋葉原」——去重與顯示一旦脫鉤就會這樣。
    usedZones[zoneOf(p.stops[0])]=1;
    p.stops.forEach(function(e){usedIds[e.id]=1;});
  }
  return out;
}

// ---- 畫面 ----
function hopLabel(d){
  var L=t();
  return L.km(d)+'・'+(d<=WALK_KM?L.onFoot:L.byTrain);
}

export { buildOptions, hopLabel, nearestZone, planEvents, shortCount, spotLabel, spotOf, zoneLabel, zonesWithStock };
