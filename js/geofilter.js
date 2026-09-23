// 地理篩選：圈 → 桶 → 據點的**多選**狀態與 chip（2026-09-03，取代原本的單選下拉）。
//
// ⚠️ **只 import 共用層**（config／store／util），與 icons／favfood／credits／tickets 同一個模子。
//    這是刻意的：使用者要三張地圖都改成這套，而餐廳／活動／景點三個模組彼此有依賴關係，
//    把它放進其中任何一個，日後搬給另外兩個時一定成環。
//
// ⚠️ **本模組不碰 DOM、不記狀態**：狀態由呼叫端持有（餐廳頁那份不進 store，
//    只有它自己讀寫），這裡只出「怎麼判定」與「怎麼畫」。同 route.js 的分工。
//
// === 狀態的形狀 ===
//   {areas:{桶名:1,…}, spots:{桶名:{據點名:1,…},…}}
// - `areas` 空的 = **不篩選**（不是零筆）。⚠️ 這一條不可以改成「空的就什麼都不給」——
//   使用者把最後一個取消掉之後會對著一張空地圖，而畫面上沒有任何地方說得出原因。
// - `spots` **按桶分組**，不是一組扁平的據點名。今天據點名確實全域唯一（實測 58 個無重複、
//   每個只屬於一個桶），但那是資料的現況不是保證；按桶分組讓「東京收窄到銀座、
//   大阪整桶」這件事在結構上就成立，不必依賴那個巧合。
// - 「圈有沒有被選中」**是算出來的**（底下的桶全選才算），不另外存一份。
//   存兩份的話會出現「圈亮著但底下沒全選」這種兩個狀態互相說謊的情況
//   ——同單位 N 的 planFar 那條。
import { SPOT_AREAS } from './config.js';
import { areaGroupsInOrder, areaLabel, esc, groupLabel, t } from './util.js';

function newGeoSel(){ return {areas:{},spots:{}}; }
function geoActive(sel){ return Object.keys(sel.areas).length>0; }
function clearGeo(sel){ sel.areas={};sel.spots={}; }

// ⚠️ **判定 `geoMatch()` 住在 `util.js`，不在這裡**（2026-09-03，接活動頁時搬的）：
//    `util.match()` 要用它，而本模組已經 import util——反過來 import 就成環。
//    呼叫端一律從 util 拿。本模組只出「怎麼畫」與「怎麼改狀態」。

// ⚠️ **取消一個桶時，它底下的據點一定要一起丟掉。** 不丟的話那份選擇會留著，
//    使用者下次重新選中這個桶，會拿到一個他以為已經清掉的據點篩選
//    ——而畫面上只是「家數怎麼比預期少」。
function setGeoArea(sel,a,on){
  if(on)sel.areas[a]=1;
  else{delete sel.areas[a];delete sel.spots[a];}
}
function toggleGeoArea(sel,a){ setGeoArea(sel,a,!sel.areas[a]); }
// 圈：底下（**列得出來的**那些）全選才算亮。點一下 → 全開；已經全開 → 全關。
// ⚠️ `areas` 傳的是「這一段實際畫出來的桶」而不是 AREA_GROUPS[g]：
//    沒有資料的桶根本沒畫出來，把它算進「全不全選」會讓圈永遠亮不起來。
function groupOn(sel,areas){
  if(!areas.length)return false;
  for(var i=0;i<areas.length;i++)if(!sel.areas[areas[i]])return false;
  return true;
}
function toggleGeoGroup(sel,areas){
  var on=groupOn(sel,areas);
  areas.forEach(function(a){setGeoArea(sel,a,!on);});
}
function toggleGeoSpot(sel,a,s){
  if(!sel.spots[a])sel.spots[a]={};
  if(sel.spots[a][s])delete sel.spots[a][s];
  else sel.spots[a][s]=1;
}
// 據點的顯示名。⚠️ **繁中沒有 `spots` 對照表**（據點名本身就是中文），日文才有；
// 而「其他」是**資料值不是顯示文字**，它就在那張表裡（`その他`）。
// ⚠️ 這是全站唯一一份——`restaurants.js` 原本有一份一模一樣的 `spotLabel`，
//    已於 2026-09-03 改成呼叫這裡（同一條規則存在兩處必然漂移）。
function spotText(v){
  return (t().spots&&t().spots[v])||v;
}

// chip 樹。cfg：
//   sel      目前的選擇
//   count(桶名)        這個桶有幾筆（**已扣掉其他條件**）
//   has(桶名)          要不要列出來。**預設是「有資料才列」**（`count(a)>0`）——
//                      餐廳與景點用預設：列出 0 筆的桶等於給一個選了保證空白的選項。
//                      ⚠️ **活動頁刻意傳「全部都列」**：活動每天在變，今天 0 筆的桶明天
//                      可能就有，藏起來會讓人以為那個地區永遠沒有活動；而**筆數照印**，
//                      所以 0 是看得見的（比改動前那個不印筆數的下拉更清楚）。
//   spots(桶名)        [[據點名, 筆數], …]，**只有被選中的桶會被問到**
//                      （24 顆據點全攤開會變成一面牆，使用者 2026-09-03 拍板只在選中時展開）
// ⚠️ 分段結構走 util 的 `areaGroupsInOrder()`——「圈的桶必須相鄰」那條規則的唯一實作，
//    這裡不自己再寫一次迴圈。
function geoChipsHTML(cfg){
  var sel=cfg.sel,count=cfg.count,spots=cfg.spots;
  var has=cfg.has||function(a){return count(a)>0;};
  var html='';
  areaGroupsInOrder(has).forEach(function(seg){
    html+='<div class="geo-seg">';
    if(seg.group){
      var n=0;seg.areas.forEach(function(a){n+=count(a);});
      html+='<button type="button" class="side-chip geo-group'+(groupOn(sel,seg.areas)?' on':'')+'"'
        +' data-geo-group="'+esc(seg.areas.join('|'))+'">'
        +'<span>'+esc(groupLabel(seg.group))+'</span><span class="cnt">'+n+'</span></button>';
    }
    // 有圈的話桶縮排一層；沒有圈（單桶）就直接是這一段本身。
    html+='<div class="geo-kids'+(seg.group?' sub':'')+'">';
    seg.areas.forEach(function(a){
      html+='<button type="button" class="side-chip geo-area'+(sel.areas[a]?' on':'')+'"'
        +' data-geo-area="'+esc(a)+'">'
        +'<span>'+esc(areaLabel(a))+'</span><span class="cnt">'+count(a)+'</span></button>';
    });
    html+='</div>';
    // 據點：選中且這個桶有據點制度時才展開。**獨立一塊並標明是哪個桶的**——
    // 塞回上面那排會讓「這幾顆是誰的據點」看不出來。
    seg.areas.forEach(function(a){
      if(!sel.areas[a]||!SPOT_AREAS[a])return;
      var list=spots(a);
      if(!list.length)return;
      html+='<div class="geo-spots"><span class="geo-spots-h">'
        +esc(areaLabel(a))+' · '+esc(t().restaurantSpot)+'</span>';
      var picked=sel.spots[a]||{};
      list.forEach(function(p){
        html+='<button type="button" class="side-chip geo-spot'+(picked[p[0]]?' on':'')+'"'
          +' data-geo-spot="'+esc(p[0])+'" data-geo-in="'+esc(a)+'">'
          +'<span>'+esc(spotText(p[0]))+'</span><span class="cnt">'+p[1]+'</span></button>';
      });
      html+='</div>';
    });
    html+='</div>';
  });
  return html;
}

// 目前選了哪些地區，給「正在套用的篩選」那一列顯示用。
// ⚠️ **整個圈都選中時收合成圈名**：選了關西就顯示「關西」而不是
//    「大阪、京都、神戶、奈良、關西周邊」五個標籤——那一列會爆掉，
//    而且使用者按的本來就是「關西」那一顆。
function geoLabels(sel){
  var out=[],used={};
  areaGroupsInOrder().forEach(function(seg){
    if(seg.group&&groupOn(sel,seg.areas)){
      out.push(groupLabel(seg.group));
      seg.areas.forEach(function(a){used[a]=1;});
    }
  });
  Object.keys(sel.areas).forEach(function(a){if(!used[a])out.push(areaLabel(a));});
  return out;
}

// 點擊委派：回 true 代表這一下真的改到了選擇（呼叫端據此決定要不要重畫）。
// ⚠️ **委派掛在容器上**，因為這段 HTML 每次重畫都整個換掉——掛在 chip 上一重畫就失效
//   （buildLegend／mapswitch／favfood 都踩過那條）。
function handleGeoClick(e,sel){
  var b=e.target.closest?e.target.closest('.side-chip'):null;
  if(!b)return false;
  var g=b.getAttribute('data-geo-group');
  if(g){toggleGeoGroup(sel,g.split('|'));return true;}
  var a=b.getAttribute('data-geo-area');
  if(a){toggleGeoArea(sel,a);return true;}
  var s=b.getAttribute('data-geo-spot');
  if(s){toggleGeoSpot(sel,b.getAttribute('data-geo-in'),s);return true;}
  return false;
}

export { newGeoSel, geoActive, clearGeo, geoChipsHTML, geoLabels, handleGeoClick, spotText };
