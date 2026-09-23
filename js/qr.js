// js/qr.js — QR 碼編碼器（只做「文字 → 黑白格子」，不碰 DOM、不碰 canvas）
//
// 程式改寫自 QR Code generator library（Project Nayuki），MIT License。
// https://www.nayuki.io/page/qr-code-generator-library
//
// **為什麼把它抄進來，而不是連 CDN 或打外部 QR API**（同 icons.js 的理由，另加兩條）：
// ① 打外部 API 等於**把使用者的行程送到第三方**，而本站唯一的硬規則就是不外送
//    （jpev_loc 那條）。
// ② 匯出的行程圖是畫進 canvas 的，而外來圖片要有 CORS 標頭才不會污染 canvas
//    （地雷 #15）——自己一格一格畫就完全沒有這個問題，一張圖都不用載。
// ③ `js/` 整個資料夾本來就在 Cloudflare 的複製清單裡，放這裡不必動組建設定。
//
// 對外只有 qrModules(text) → 二維布林陣列（true = 深色），零依賴。
// ⚠️ **回傳的格子不含靜區**：四周那 4 格白邊由呼叫端自己留。
//    少了它掃不到，而**畫面上完全看不出來**——那正是這種錯誤難抓的地方。
// ⚠️ **錯的 QR 與對的長得一模一樣**，所以這支的驗證方式是拿另一套獨立實作
//    （Python 的 segno）逐格比對，不是看截圖。見 progress.md 第一百二十九筆。

// 每個區塊的糾錯碼字數 / 區塊數，index 0 是佔位（版本由 1 起算）。
var ECC={
  L:{bits:1,
     cw:[0,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
     bl:[0,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25]},
  M:{bits:0,
     cw:[0,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
     bl:[0,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49]},
  Q:{bits:3,
     cw:[0,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
     bl:[0,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68]},
  H:{bits:2,
     cw:[0,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
     bl:[0,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]}
};
var PEN_N1=3,PEN_N2=3,PEN_N3=40,PEN_N4=10;

function getBit(x,i){ return ((x>>>i)&1)!==0; }

// 這一版只用 byte 模式：網址含小寫字母，alphanumeric 模式本來就吃不下，
// 而多支援一種模式只會省下幾個位元、卻多一整段會出錯的程式。
function toBytes(s){
  if(typeof TextEncoder!=='undefined')return Array.prototype.slice.call(new TextEncoder().encode(s));
  var out=[];for(var i=0;i<s.length;i++)out.push(s.charCodeAt(i)&0xFF);return out;
}
// byte 模式的「字數欄」寬度：第 1～9 版 8 bits，第 10 版以後 16 bits。
function ccBits(ver){ return ver<=9?8:16; }

function rawDataModules(ver){
  var n=(16*ver+128)*ver+64;
  if(ver>=2){
    var na=Math.floor(ver/7)+2;
    n-=(25*na-10)*na-55;
    if(ver>=7)n-=36;
  }
  return n;
}
function dataCodewords(ver,e){
  return Math.floor(rawDataModules(ver)/8)-ECC[e].cw[ver]*ECC[e].bl[ver];
}
function pickVersion(len,e){
  for(var v=1;v<=40;v++){
    if(4+ccBits(v)+8*len<=dataCodewords(v,e)*8)return v;
  }
  return -1;
}

function bitStream(data,ver,e){
  var bits=[],i,j;
  function push(val,n){ for(j=n-1;j>=0;j--)bits.push(getBit(val,j)?1:0); }
  push(4,4);                       // byte 模式
  push(data.length,ccBits(ver));
  for(i=0;i<data.length;i++)push(data[i],8);
  var cap=dataCodewords(ver,e)*8;
  for(i=0;i<4&&bits.length<cap;i++)bits.push(0);        // 終止符
  while(bits.length%8!==0)bits.push(0);                 // 補到整個位元組
  for(i=0;bits.length<cap;i++)push(i%2===0?0xEC:0x11,8);   // 填充位元組 EC/11 交替
  var out=[];
  for(i=0;i<bits.length;i+=8){
    var b=0;for(j=0;j<8;j++)b=(b<<1)|bits[i+j];
    out.push(b);
  }
  return out;
}

function rsMul(x,y){
  var z=0;
  for(var i=7;i>=0;i--){
    z=(z<<1)^((z>>>7)*0x11D);
    z^=((y>>>i)&1)*x;
  }
  return z&0xFF;
}
function rsDivisor(deg){
  var r=new Uint8Array(deg);r[deg-1]=1;
  var root=1;
  for(var i=0;i<deg;i++){
    for(var j=0;j<r.length;j++){
      r[j]=rsMul(r[j],root);
      if(j+1<r.length)r[j]^=r[j+1];
    }
    root=rsMul(root,0x02);
  }
  return r;
}
function rsRemainder(data,div){
  var r=new Uint8Array(div.length),i,k;
  for(k=0;k<data.length;k++){
    var factor=data[k]^r[0];
    r.copyWithin(0,1);r[r.length-1]=0;
    for(i=0;i<r.length;i++)r[i]^=rsMul(div[i],factor);
  }
  return r;
}
// 補上糾錯碼並依規格交錯排列。
function addEcc(data,ver,e){
  var nb=ECC[e].bl[ver],eccLen=ECC[e].cw[ver];
  var raw=Math.floor(rawDataModules(ver)/8);
  var shortN=nb-raw%nb,shortLen=Math.floor(raw/nb);
  var blocks=[],div=rsDivisor(eccLen),i,j,k=0;
  for(i=0;i<nb;i++){
    var len=shortLen-eccLen+(i<shortN?0:1);
    var dat=data.slice(k,k+len);k+=len;
    var ecc=rsRemainder(dat,div);
    if(i<shortN)dat.push(0);
    for(j=0;j<ecc.length;j++)dat.push(ecc[j]);
    blocks.push(dat);
  }
  var out=[];
  for(i=0;i<blocks[0].length;i++){
    for(j=0;j<blocks.length;j++){
      if(i!==shortLen-eccLen||j>=shortN)out.push(blocks[j][i]);
    }
  }
  return out;
}

function alignPositions(ver){
  if(ver===1)return [];
  var na=Math.floor(ver/7)+2,size=ver*4+17;
  var step=(ver===32)?26:Math.ceil((ver*4+4)/(na*2-2))*2;
  var res=[6];
  for(var pos=size-7;res.length<na;pos-=step)res.splice(1,0,pos);
  return res;
}

function buildMatrix(cw,ver,e){
  var size=ver*4+17,x,y,i,j;
  var mod=[],fn=[];
  for(y=0;y<size;y++){ mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
  function set(x,y,v){ mod[y][x]=v; fn[y][x]=true; }

  // 定位圖案（三個角的大方框）與分隔線
  function finder(cx,cy){
    for(var dy=-4;dy<=4;dy++)for(var dx=-4;dx<=4;dx++){
      var d=Math.max(Math.abs(dx),Math.abs(dy)),xx=cx+dx,yy=cy+dy;
      if(xx>=0&&xx<size&&yy>=0&&yy<size)set(xx,yy,d!==2&&d!==4);
    }
  }
  // 時序圖案（那兩排交錯的點）
  for(i=0;i<size;i++){ set(6,i,i%2===0); set(i,6,i%2===0); }
  finder(3,3);finder(size-4,3);finder(3,size-4);
  // 校正圖案（第 2 版起才有，且三個角落要讓給定位圖案）
  var ap=alignPositions(ver);
  for(i=0;i<ap.length;i++)for(j=0;j<ap.length;j++){
    if((i===0&&j===0)||(i===0&&j===ap.length-1)||(i===ap.length-1&&j===0))continue;
    for(var dy2=-2;dy2<=2;dy2++)for(var dx2=-2;dx2<=2;dx2++)
      set(ap[i]+dx2,ap[j]+dy2,Math.max(Math.abs(dx2),Math.abs(dy2))!==1);
  }

  function drawFormat(mask){
    var d=(ECC[e].bits<<3)|mask,rem=d,n;
    for(n=0;n<10;n++)rem=(rem<<1)^((rem>>>9)*0x537);
    var bits=((d<<10)|rem)^0x5412;
    for(n=0;n<=5;n++)set(8,n,getBit(bits,n));
    set(8,7,getBit(bits,6));set(8,8,getBit(bits,7));set(7,8,getBit(bits,8));
    for(n=9;n<15;n++)set(14-n,8,getBit(bits,n));
    for(n=0;n<8;n++)set(size-1-n,8,getBit(bits,n));
    for(n=8;n<15;n++)set(8,size-15+n,getBit(bits,n));
    set(8,size-8,true);   // 永遠是深色的那一格
  }
  drawFormat(0);
  if(ver>=7){
    var rem=ver,n;
    for(n=0;n<12;n++)rem=(rem<<1)^((rem>>>11)*0x1F25);
    var vb=(ver<<12)|rem;
    for(n=0;n<18;n++){
      var c=getBit(vb,n),a=size-11+n%3,b=Math.floor(n/3);
      set(a,b,c);set(b,a,c);
    }
  }

  // 資料由右下角起、每兩欄一組來回走蛇形
  var bi=0;
  for(var right=size-1;right>=1;right-=2){
    if(right===6)right=5;
    for(var vert=0;vert<size;vert++){
      for(j=0;j<2;j++){
        x=right-j;
        var up=((right+1)&2)===0;
        y=up?size-1-vert:vert;
        if(!fn[y][x]&&bi<cw.length*8){
          mod[y][x]=getBit(cw[bi>>>3],7-(bi&7));
          bi++;
        }
      }
    }
  }

  function applyMask(m){
    for(y=0;y<size;y++)for(x=0;x<size;x++){
      if(fn[y][x])continue;
      var inv;
      switch(m){
        case 0:inv=(x+y)%2===0;break;
        case 1:inv=y%2===0;break;
        case 2:inv=x%3===0;break;
        case 3:inv=(x+y)%3===0;break;
        case 4:inv=(Math.floor(x/3)+Math.floor(y/2))%2===0;break;
        case 5:inv=(x*y)%2+(x*y)%3===0;break;
        case 6:inv=((x*y)%2+(x*y)%3)%2===0;break;
        default:inv=((x+y)%2+(x*y)%3)%2===0;break;
      }
      if(inv)mod[y][x]=!mod[y][x];
    }
  }
  // 規格的罰分規則：連續同色、2×2 同色、像定位圖案的排列、黑白比例失衡
  function addHist(run,hist){
    if(hist[0]===0)run+=size;
    hist.pop();hist.unshift(run);
  }
  function countPat(h){
    var n=h[1];
    var core=n>0&&h[2]===n&&h[3]===n*3&&h[4]===n&&h[5]===n;
    return (core&&h[0]>=n*4&&h[6]>=n?1:0)+(core&&h[6]>=n*4&&h[0]>=n?1:0);
  }
  function endRun(color,run,hist){
    if(color){addHist(run,hist);run=0;}
    run+=size;addHist(run,hist);
    return countPat(hist);
  }
  function penalty(){
    var r=0,a,b,c,run,color,hist;
    for(a=0;a<size;a++){
      color=false;run=0;hist=[0,0,0,0,0,0,0];
      for(b=0;b<size;b++){
        if(mod[a][b]===color){ run++; if(run===5)r+=PEN_N1; else if(run>5)r++; }
        else{ addHist(run,hist); if(!color)r+=countPat(hist)*PEN_N3; color=mod[a][b];run=1; }
      }
      r+=endRun(color,run,hist)*PEN_N3;
    }
    for(a=0;a<size;a++){
      color=false;run=0;hist=[0,0,0,0,0,0,0];
      for(b=0;b<size;b++){
        if(mod[b][a]===color){ run++; if(run===5)r+=PEN_N1; else if(run>5)r++; }
        else{ addHist(run,hist); if(!color)r+=countPat(hist)*PEN_N3; color=mod[b][a];run=1; }
      }
      r+=endRun(color,run,hist)*PEN_N3;
    }
    for(a=0;a<size-1;a++)for(b=0;b<size-1;b++){
      c=mod[a][b];
      if(c===mod[a][b+1]&&c===mod[a+1][b]&&c===mod[a+1][b+1])r+=PEN_N2;
    }
    var dark=0;
    for(a=0;a<size;a++)for(b=0;b<size;b++)if(mod[a][b])dark++;
    var total=size*size;
    r+=(Math.ceil(Math.abs(dark*20-total*10)/total)-1)*PEN_N4;
    return r;
  }

  var best=-1,bestPen=Infinity;
  for(var m=0;m<8;m++){
    applyMask(m);drawFormat(m);
    var p=penalty();
    if(p<bestPen){bestPen=p;best=m;}
    applyMask(m);   // 還原
  }
  applyMask(best);drawFormat(best);
  return mod;
}

// text → 二維布林陣列（true = 深色）。放不下（超過第 40 版）回 null。
function qrModules(text,ecl){
  var e=ecl||'M';
  var data=toBytes(text);
  var ver=pickVersion(data.length,e);
  if(ver<0)return null;
  return buildMatrix(addEcc(bitStream(data,ver,e),ver,e),ver,e);
}

export { qrModules };
