// 行程頁的「加一頓飯」（單位 I，2026-08-26）：算出行程附近有哪些餐廳、產生那一段的 HTML。
// 決策紀錄見 development-plan-v3.md §1-I。
//
// ⚠️ **本模組不 import plan-ui**（`addToPlan` 在那邊，會成環）。方向是
// `restaurants → plan-food → plan-ui`，那一段的**點擊由 plan-ui 接手**，
// 照 `mylocation`／`expiring` 把 callback 交回去的既有做法。
//
// ⚠️ **也不自己抓 `_map.json`**：`restaurants.js` 已經有第一層載入與 promise 快取，
// 複製一份等於同一份資料兩個載入器（`SPOTS` 在兩支管線各一份就吃過這個虧）。
import { FOOD_NEAR_KM, FOOD_PAGE, FOOD_TYPE, OTHER_SPOT, T } from './config.js';
import { store } from './store.js';
import { awardsHTML, esc, hav, fld, foodId, foodKey, isRestaurant, planFoodIdOf, t, typeColor } from './util.js';
import { hopLabel } from './plan-core.js';
import { ensureRestaurants, restaurantRecords } from './restaurants.js';
import { isFavFood, toggleFavFood } from './favfood.js';

// 這一段自己的狀態。**不進 store**——只有本模組讀寫（store.js 訂的界線）。
var meal='lunch', genre='', shown=FOOD_PAGE;
var loaded=false, loading=false, loadFail=false, loadPromise=null;

// `_map.json` 的原始記錄 → 行程認得的形狀。
// ⚠️ **`venue_ja` 存的是 Google 查詢字串而不是地址**：`_map.json` 沒有地址欄位
//（那在詳細檔裡，而詳細檔一個要 10～50 KB，決策裡明確排除為了它去載），
// 而 `mapQuery()`／`route.js` 認的就是這個欄位。店名＋據點日文已經夠精準
// ——少了據點，連鎖店會被 Google 配到別的分店。
// ⚠️ **據點是 `其他` 時不可以串進去**：那是資料值不是地名，
// 查「焼肉うしごろ その他 埼玉」只會讓結果更糟。
// 這個欄位**永遠不顯示**（餐廳那一列印的是料理類別與距離），所以不必顧慮雙語。
function adapt(r){
  var spotJa=(r.spot&&r.spot!==OTHER_SPOT&&T.ja.spots&&T.ja.spots[r.spot])||'';
  var q=r.name_ja+(spotJa?' '+spotJa:'');
  return {
    id:'rs-'+r.id, type:FOOD_TYPE,
    // 餐廳沒有繁中譯名（店名就是日文），中日兩邊都放同一個值——
    // 這與地雷 #7b 不衝突：那條講的是「資料值不可為了顯示而改」，這裡本來就只有一種寫法。
    title:r.name_ja, title_ja:r.name_ja,
    venue:q, venue_ja:q,
    genre:r.genre, genre_ja:r.genre_ja,
    area:r.area, spot:r.spot,
    // 榜單徽章（2026-08-26）。`_map.json` 的 `w` 已由 `expandSlim()` 展開成
    // 與詳細檔同形狀的陣列，這裡照抄過來即可——**不要在這邊自己查字典**，
    // 那會變成同一條規則存在兩處（同 `SPOTS` 吃過的虧）。
    awards:r.awards,
    lat:r.lat, lng:r.lng, geo:r.geo
  };
}
// 載一次 `restaurants/_map.json`（壓縮後 76 KB）。
// ⚠️ **呼叫時機刻意寫成一般形式**：「任何地方需要用到 `rs-` 開頭的 id 就叫我一次」，
// 而不是「開行程頁時載」。今天行為完全一樣，等單位 K（餐廳收藏）上線時
// 這條規則一個字都不用改。
function ensureFood(){
  if(loaded)return Promise.resolve(store.restaurants);
  if(loadPromise)return loadPromise;
  loading=true;loadFail=false;
  loadPromise=ensureRestaurants().then(function(){
    store.restaurants=restaurantRecords().map(adapt);
    loaded=true;loading=false;
    return store.restaurants;
  }).catch(function(err){
    // 失敗不卡住行程頁的其他部分（同 places.json 那條：附加內容失敗不可以拖垮本體）。
    loading=false;loadFail=true;loadPromise=null;
    throw err;
  });
  return loadPromise;
}
function foodLoaded(){return loaded;}
function foodLoading(){return loading;}
function foodFailed(){return loadFail;}
// 行程裡有沒有餐廳。**只看 id 不看資料**——這正是 `rs-` 前綴存在的理由：
// 不必先載 76 KB 才知道要不要載。
function planHasFood(ids){
  for(var i=0;i<ids.length;i++)if(foodKey(ids[i]))return true;
  return false;
}
function planFoodIds(){
  return store.plan.ids.filter(function(id){return !!foodKey(id);});
}
// 這家店已經在行程裡的話，回它的行程 id（含餐別）；否則回空字串。
// **判斷本體在 util 的 planFoodIdOf()**（2026-08-27 整併：同一件事有三處要問）。
function planIdOf(baseId){return planFoodIdOf(baseId);}
// 從餐廳分頁加進來時沒有午餐／晚餐可選，**自動補空著的那一格**。
// 猜錯的代價很小（行程列上寫著是哪一餐，按一下就能移除），
// 而多問一次會讓那顆鈕變成兩層對話框。
function freeMeal(){
  var used={};
  planFoodIds().forEach(function(id){used[id.slice(3,4)]=1;});
  if(!used.l)return 'lunch';
  if(!used.d)return 'dinner';
  return '';
}

// ---- 附近的餐廳 ----
function hasXY(e){
  return !!e&&typeof e.lat==='number'&&typeof e.lng==='number'
    &&isFinite(e.lat)&&isFinite(e.lng);
}
// 依「離**最近的那一站**」排序，不是離行程的中心點——中心點常常是一塊空地，
// 而使用者要的是「順路」。同時回報是離哪一站多遠，因為只說「0.4 km」等於沒說。
// ⚠️ **超過 FOOD_NEAR_KM 一律不列**（決策 22）：不設上限的話，日光的行程會列出
// 一家 40 公里外的東京餐廳，**而它看起來跟正常結果一模一樣**。
function nearby(stops){
  var anchors=(stops||[]).filter(hasXY),out=[];
  if(!anchors.length)return out;
  store.restaurants.forEach(function(r){
    if(!hasXY(r))return;
    var best=Infinity,who=null;
    for(var i=0;i<anchors.length;i++){
      var d=hav(r.lat,r.lng,anchors[i].lat,anchors[i].lng);
      if(d<best){best=d;who=anchors[i];}
    }
    if(!who||best>FOOD_NEAR_KM)return;
    out.push({r:r,d:best,from:who});
  });
  out.sort(function(a,b){return a.d-b.d;});
  return out;
}
// 類別下拉的選項**由範圍內的候選算出來**，不是全站 23 類——
// 列出一個選了會得到零家的類別，等於做了一個死角。
function genreOptions(pool){
  var n={},order=[];
  pool.forEach(function(x){
    if(!x.r.genre)return;
    if(!n[x.r.genre]){n[x.r.genre]=0;order.push(x.r.genre);}
    n[x.r.genre]++;
  });
  order.sort(function(a,b){return n[b]-n[a];});
  return order.map(function(g){return {v:g,n:n[g]};});
}
function genreLabel(r){
  return store.lang==='ja'?(r.genre_ja||r.genre):(r.genre||r.genre_ja);
}
// 「離『X』多遠」裡的 X。**用場地名而不是活動名**：距離是到一個**地方**的，
// 而活動名往往很長（實測「「畫家 勒·柯布西耶：建築巨匠所編織的繪畫世界展」」）
// 又不是空間資訊。餐廳例外——它的 `venue` 裝的是 Google 查詢字串，只能用店名。
// ⚠️ **名稱本身可能已經帶著「」**（日文展名很常見），不剝掉會變成「「…」」。
function anchorName(ev){
  var n=isRestaurant(ev)?fld(ev,'title'):(fld(ev,'venue')||fld(ev,'title'));
  return String(n||'').replace(/^[「『]+/,'').replace(/[」』]+$/,'');
}
function rowHTML(x){
  var L=t(),r=x.r,pid=planIdOf(r.id.slice(3));
  // **距離那一句沿用 hopLabel()**（「0.4 km・步行可達」），與站與站之間那一列同一套說法。
  var dist=L.foodFrom(anchorName(x.from))+' '+hopLabel(x.d);
  // 「被哪些指南推薦過」是這份清單唯一的挑選依據（沒有照片、沒有營業時間、
  // 沒有預算），所以徽章自成一行，不與類別・距離擠在一起——430px 下長的那個
  // （ミシュランガイド日本・セレクテッドレストラン 2026）一定會折行，
  // 折下來的效果跟自成一行一樣、只是更亂。
  // ⚠️ **顏色一律傳 `--c-餐廳`**，理由見 `awardsHTML` 的註解。
  var aw=awardsHTML(r,typeColor(FOOD_TYPE));
  return '<div class="plan-row plan-food-row">'
    +'<div class="info"><div class="nm">'+esc(r.title)+'</div>'
      +'<div class="sub">'
        +'<span class="cat" style="color:'+typeColor(FOOD_TYPE)+'">'+esc(genreLabel(r))+'</span>'
        +'<span>'+esc(dist)+'</span>'
      +'</div>'
      // 沒有 awards 就整段不印（理論上不會發生——現況 2190 家全部都有——
      // 但那是資料的現況，不是這支程式可以假設的事）。
      +(aw?'<div class="restaurant-awards plan-food-aw">'+aw+'</div>':'')
    +'</div>'
    // data-food-add 帶的是**原始 id**（不含 rs- 與餐別）：要加哪一餐由目前選中的
    // chip 決定，而移除要用的是它現在那個行程 id——兩者都在 plan-ui 那邊算。
    // 收藏星（單位 K）。**排在「＋」左邊**：先看到的是「這家不錯」，
    // 而「排進今天」是更強的決定。兩顆都帶原始 id。
    +'<button class="plan-food-fav'+(isFavFood(r.id)?' on':'')
      +'" data-food-fav="'+esc(r.id.slice(3))+'"'
      +' aria-label="'+esc(isFavFood(r.id)?L.aFavFoodOn:L.aFavFood)+'">★</button>'
    +'<button class="act'+(pid?' on':'')+'" data-food-add="'+esc(r.id.slice(3))+'">'
      +(pid?'✓':'＋')+'</button>'
    +'</div>';
}
// 整段的內容。`stops` 是目前行程裡的站（已排序），至少要有一站呼叫端才會叫到這裡。
function foodBodyHTML(stops){
  var L=t();
  if(foodFailed())return '<div class="plan-empty">'+esc(L.restaurantLoadFail)+'</div>';
  if(!foodLoaded())return '<div class="plan-empty">'+esc(L.restaurantLoading)+'</div>';
  var pool=nearby(stops);
  var opts=genreOptions(pool);
  var list=genre?pool.filter(function(x){return x.r.genre===genre;}):pool;
  // 兩顆餐別 chip ＋ 一個類別下拉。chip 沿用 `.side-chip`（純文字＋選中加底線），
  // 與路線那兩顆、篩選彈窗同一套，不新增樣式。
  var h='<div class="plan-food-bar">'
    +'<div class="route-chips">'
      +'<button class="side-chip'+(meal==='lunch'?' on':'')+'" data-food-meal="lunch">'
        +esc(L.foodLunch)+'</button>'
      +'<button class="side-chip'+(meal==='dinner'?' on':'')+'" data-food-meal="dinner">'
        +esc(L.foodDinner)+'</button>'
    +'</div>'
    +'<select id="foodGenre" aria-label="'+esc(L.restaurantGenre)+'">'
      +'<option value="">'+esc(L.restaurantAllGenres)+'</option>'
      +opts.map(function(o){
          return '<option value="'+esc(o.v)+'"'+(genre===o.v?' selected':'')+'>'
            +esc(store.lang==='ja'?(o.v&&genreJaOf(o.v))||o.v:o.v)+' · '+o.n+'</option>';
        }).join('')
    +'</select></div>';
  if(!list.length)return h+'<div class="plan-empty">'+esc(L.foodNone)+'</div>';
  h+='<div class="plan-food-n">'+esc(L.foodCount(list.length))+'</div>';
  h+=list.slice(0,shown).map(rowHTML).join('');
  if(list.length>shown)
    h+='<button class="plan-more" data-food-more="1">'+esc(L.foodMore)+'</button>';
  return h;
}
// 類別的日文名。**候選記錄自己就帶著 `genre_ja`**，所以不必再去查 `_map.json` 的 genres[]。
function genreJaOf(g){
  for(var i=0;i<store.restaurants.length;i++)
    if(store.restaurants[i].genre===g)return store.restaurants[i].genre_ja||g;
  return g;
}
// 這一段自己的控制項（餐別 chip、類別下拉、看更多）。
// 回 true＝狀態變了、呼叫端該重畫。**「＋」不在這裡處理**——那要走 plan-ui 的
// `addToPlan()`（上限、提示、唯讀守門三件事都在裡面）。
function handleFoodControl(e){
  // 收藏星（單位 K）。**可以放這裡是因為它不必經過 addToPlan**（沒有上限、
  // 沒有唯讀守門、不改行程）——那正是「＋」必須交給 plan-ui 的理由。
  var fv=e.target.closest?e.target.closest('[data-food-fav]'):null;
  if(fv){
    var base=fv.getAttribute('data-food-fav');
    for(var i=0;i<store.restaurants.length;i++){
      if(store.restaurants[i].id!=='rs-'+base)continue;
      toggleFavFood(store.restaurants[i]);break;
    }
    return true;
  }
  var m=e.target.closest?e.target.closest('[data-food-meal]'):null;
  if(m){
    if(meal===m.getAttribute('data-food-meal'))return false;
    meal=m.getAttribute('data-food-meal');return true;
  }
  var more=e.target.closest?e.target.closest('[data-food-more]'):null;
  if(more){shown+=FOOD_PAGE;return true;}
  return false;
}
function setFoodGenre(v){
  if(genre===v)return false;
  genre=v;shown=FOOD_PAGE;return true;
}
// 目前這顆 chip 選的那一餐已經有店了，就換去空著的那一格；兩格都滿了維持原樣
// （由 addToPlan 的上限守門說「一天最多 2 家」）。
function mealForAdd(){
  var used={};
  planFoodIds().forEach(function(id){used[id.slice(3,4)]=1;});
  var want=meal==='dinner'?'d':'l';
  if(!used[want])return meal;
  return freeMeal()||meal;
}
// 行程 id。**產生的地方只有這一支**，格式見 util.js 的 FOOD_ID_RE。
function planIdFor(baseId,m){return foodId('rs-'+baseId,m);}

export { ensureFood, foodBodyHTML, foodFailed, foodLoaded, foodLoading,
         handleFoodControl, mealForAdd, planHasFood, planIdFor, planIdOf,
         setFoodGenre };
