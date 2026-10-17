/* JOMA original indicators. Calculations use broker OHLC and broker tick volume only.
   These are NOT any third party's proprietary algorithms or actual executed-volume levels. */
(() => {
 'use strict';
 const J = window.JG, TA = J.ta, {I, hexA} = J.kit;
 J.registerIndicator({
   id:'joma-density', name:'Pulse Bands · Tick Density', short:'Density', group:'Volume', kind:'canvas',
   desc:'Rolling price-band concentration using candle tick volume distributed across observed OHLC ranges. Approximation, not executed-volume heatmap.',
   inputs:[I.int('window','Last N candles',120,20,400),I.int('rows','Price bands',54,12,120),I.int('va','Value area %',70,50,95),I.color('color','Heat color','#4d8eff')],
   calc:(C,p)=>{
     const bars=C.slice(-p.window); if(bars.length<5)return null;
     let lo=Infinity,hi=-Infinity; for(const b of bars){lo=Math.min(lo,b.low);hi=Math.max(hi,b.high);}
     if(!(hi>lo))return null;
     const step=(hi-lo)/p.rows, sums=new Float64Array(p.rows);
     for(const b of bars){
       const from=Math.max(0,Math.min(p.rows-1,Math.floor((b.low-lo)/step)));
       const to=Math.max(from,Math.min(p.rows-1,Math.floor((b.high-lo)/step-1e-8)));
       const vol=Math.max(0,b.volume||0); if(!vol)continue;
       const share=vol/(to-from+1);
       for(let j=from;j<=to;j++)sums[j]+=share;
     }
     const max=Math.max(...sums);if(!max)return null;
     let poc=sums.indexOf(max),a=poc,b=poc,acc=sums[poc];const total=sums.reduce((x,y)=>x+y,0);
     while(acc<total*p.va/100&&(a>0||b<p.rows-1)){
       if(b<p.rows-1&&(a===0||sums[b+1]>=sums[a-1]))acc+=sums[++b];else acc+=sums[--a];
     }
     return {lo,step,sums:[...sums],max,poc,va:[a,b],fromTime:bars[0].time};
   },
   draw:(ctx,v,p,r)=>{
     if(!r)return;const x0=v.xt(r.fromTime),x1=v.x(v.N-1);
     if(x0==null||x1==null)return;
     const left=Math.max(0,x0), width=Math.max(0,Math.min(v.w-1,x1)-left);
     if(width<=0)return;
     const hex=p.color;
     ctx.save();
     for(let k=0;k<p.rows;k++){
       const t=r.sums[k]/r.max; if(t<.05)continue;
       const y1=v.y(r.lo+(k+1)*r.step),y2=v.y(r.lo+k*r.step);
       if(y1==null||y2==null)continue;
       const h=Math.max(1,y2-y1-0.75);
       ctx.fillStyle=hexA(hex,(k>=r.va[0]&&k<=r.va[1]? .13:.07)+t*.28);
       ctx.fillRect(left,y1,width,h);
     }
     const pocPrice=r.lo+(r.poc+.5)*r.step,py=v.y(pocPrice);
     if(py!=null){ctx.strokeStyle='#ffce73';ctx.lineWidth=1.4;ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(left,py+.5);ctx.lineTo(Math.min(v.w,x1+35),py+.5);ctx.stroke();ctx.setLineDash([]);
       ctx.fillStyle='#ffce73';ctx.font='600 10px system-ui';ctx.fillText('TICK POC '+pocPrice.toFixed(2),Math.min(v.w-112,Math.max(8,left+5)),Math.max(11,py-6));}
     ctx.restore();
   }
 });
 J.registerIndicator({
   id:'joma-regime',name:'Regime Ribbon · EMA / ATR',short:'Regime',group:'Trend',kind:'overlay',
   desc:'Historical EMA 21/55 cross and ATR volatility envelope. Descriptive only; no buy/sell predictions.',
   inputs:[I.int('fast','Fast EMA',21,2,150),I.int('slow','Slow EMA',55,5,250),I.int('atr','ATR length',14,2,100),I.float('factor','Envelope × ATR',1,0.2,5,0.1),I.color('up','Positive spread','#35e8c4'),I.color('down','Negative spread','#ff6e8b')],
   calc:(C,p)=>{
     const src=C.map(b=>b.close), fast=TA.ema(src,p.fast),slow=TA.ema(src,p.slow),atr=TA.atr(C,p.atr);
     const upper=fast.map((f,i)=>TA.isN(f)&&TA.isN(atr[i])?f+atr[i]*p.factor:null);
     const lower=fast.map((f,i)=>TA.isN(f)&&TA.isN(atr[i])?f-atr[i]*p.factor:null);
     const positive=fast.map((f,i)=>TA.isN(f)&&TA.isN(slow[i])&&f>=slow[i]?f:null);
     const negative=fast.map((f,i)=>TA.isN(f)&&TA.isN(slow[i])&&f<slow[i]?f:null);
     return {lines:[{data:positive,color:p.up,width:2},{data:negative,color:p.down,width:2},{data:slow,color:'#bbc3d4',width:1.5},{data:upper,color:hexA(p.up,.28),width:1},{data:lower,color:hexA(p.down,.28),width:1}]};
   }
 });
})();
