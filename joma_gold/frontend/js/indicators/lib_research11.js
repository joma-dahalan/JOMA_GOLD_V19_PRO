/* JOMA Research Eleven — independent chart studies inspired by public descriptions.
 * Not original/redistributed indtrade algorithms or subscription equivalents.
 * All candle-derived volume is broker TICK VOLUME, not executed trade size.
 * No automated trade execution, no predictions. Calculations are causal.
 */
(() => {
  'use strict';
  const J = window.JG, TA = J.ta, {I,hexA} = J.kit;
  const UP='#30dac1', DN='#ff6685', GOLD='#ffce73', BLUE='#6aa9ff';
  const ok=TA.isN, empty=n=>new Array(n).fill(null);
  const indicator=d=>J.registerIndicator(Object.assign({group:'Research',kind:'overlay'},d));
  const xs=(v,i)=>v.x(i), ys=(v,n)=>v.y(n);
  const line=(data,color,width=2)=>({data,color,width});
  const text=(ctx,x,y,msg,color=GOLD)=>{if(!Number.isFinite(x)||!Number.isFinite(y))return;ctx.font='600 10px system-ui';ctx.fillStyle=color;ctx.textAlign='center';ctx.fillText(msg,x,y);};
  const crossing=(x,prev,level,prior)=>ok(x)&&ok(prev)&&ok(level)&&ok(prior)&&x>level&&prev<=prior;

  // Rolling historical density: each column uses ONLY past/present candles.
  function pulseColumns(C,p){
    const cols=[],limit=Math.max(0,C.length-p.columns),rows=p.rows;
    for(let i=limit;i<C.length;i++){
      const st=Math.max(0,i-p.window+1),bars=C.slice(st,i+1);if(bars.length<5)continue;
      let lo=Infinity,hi=-Infinity;for(const b of bars){lo=Math.min(lo,b.low);hi=Math.max(hi,b.high);}
      if(!(hi>lo))continue;
      const step=(hi-lo)/rows,vol=new Float64Array(rows);let total=0;
      for(const b of bars){const vv=Math.max(0,Number(b.volume)||0);if(!vv)continue;
        let a=Math.max(0,Math.min(rows-1,Math.floor((b.low-lo)/step)));
        let z=Math.max(a,Math.min(rows-1,Math.floor((b.high-lo)/step-1e-9)));
        const each=vv/(z-a+1);for(let j=a;j<=z;j++)vol[j]+=each;total+=vv;
      }
      if(total<=0)continue;
      let poc=0;for(let k=1;k<rows;k++)if(vol[k]>vol[poc])poc=k;
      cols.push({i,lo,step,vol:[...vol],max:vol[poc],poc});
    }
    return cols;
  }
  indicator({id:'joma-pulse-lab',name:'Pulse Research · Rolling Density',short:'Pulse Lab',kind:'canvas',
    desc:'Rolling historical price×time heat columns and tick-volume POC. Independent estimate from candle tick volumes; NOT the proprietary Pulse engine.',
    inputs:[I.int('window','Lookback bars',120,10,400),I.int('rows','Price bands',32,8,80),I.int('columns','Recent columns',160,20,350),I.color('color','Heat colour','#588cff'),I.bool('poc','Show per-bar POC',true)],
    calc:(C,p)=>({columns:pulseColumns(C,p)}),
    draw(ctx,v,p,r){if(!r)return;ctx.save();
      for(const c of r.columns){if(c.i<v.from-2||c.i>v.to+2)continue;const x=xs(v,c.i),x2=xs(v,c.i+1);if(x==null)continue;const w=Math.max(1,Math.min(22,(x2??x+6)-x)*.87);
        for(let k=0;k<c.vol.length;k++){const intensity=c.vol[k]/c.max;if(intensity<.09)continue;const y0=ys(v,c.lo+k*c.step),y1=ys(v,c.lo+(k+1)*c.step);if(y0==null||y1==null)continue;
          ctx.fillStyle=hexA(p.color,.045+Math.pow(intensity,1.3)*.38);ctx.fillRect(x-w*.5,y1,w,Math.max(1,y0-y1));}
        if(p.poc){const y=ys(v,c.lo+(c.poc+.5)*c.step);if(y!=null){ctx.fillStyle=GOLD;ctx.fillRect(x-1.3,y-1.3,2.6,2.6);}}
      }ctx.restore();}
  });

  // Saga Lab: trend-regime coloured price/volume blocks, not Saga proprietary logic.
  indicator({id:'joma-saga-lab',name:'Saga Research · Regime Blocks',short:'Saga Lab',
    desc:'Independent EMA + ADX trend-state ribbon with above-average tick-volume block highlights. No claim of Saga signal parity.',
    inputs:[I.int('fast','Fast EMA',13,2,100),I.int('slow','Slow EMA',34,3,200),I.int('adx','ADX length',14,2,60),I.int('threshold','ADX minimum',22,5,60),I.float('volume','Volume multiple',1.3,0.1,6,0.1)],
    calc:(C,p)=>{const src=C.map(b=>b.close),fast=TA.ema(src,p.fast),slow=TA.ema(src,p.slow),a=TA.adx(C,p.adx).adx,vm=TA.sma(C.map(b=>Math.max(0,b.volume||0)),20),state=C.map((b,i)=>!ok(fast[i])||!ok(slow[i])||!ok(a[i])?0:a[i]>=p.threshold?(fast[i]>slow[i]?1:fast[i]<slow[i]?-1:0):0);
      const blocks=C.map((b,i)=>state[i]!==0&&ok(vm[i])&&vm[i]>0&&b.volume>=vm[i]*p.volume&&i<C.length-1?i:-1).filter(i=>i>=0);
      return {lines:[line(fast,BLUE),line(slow,'#a9aebf',1)],blocks,state};},
    draw(ctx,v,p,r){for(const i of r.blocks){if(i<v.from-2||i>v.to+2)continue;const x=xs(v,i),top=ys(v,v.C[i].high),bottom=ys(v,v.C[i].low);if(x==null||top==null||bottom==null)continue;ctx.fillStyle=r.state[i]>0?hexA(UP,.18):hexA(DN,.18);ctx.fillRect(x-5,top,10,Math.max(2,bottom-top));}}
  });

  // Binary Lines: properly *confirmed* pivots at i+k, never usable before confirmation.
  function pivotLines(C,p){const N=C.length,upper=empty(N),lower=empty(N),events=[],touches=[], piv=TA.pivotsOf(C,p.pivot),atr=TA.atr(C,14),hi=[],lo=[];let at=0;
    const extrap=(arr,i)=>{if(arr.length<2)return null;const a=arr[arr.length-2],b=arr[arr.length-1];if(i-b.i>(p.extend||45)||b.i===a.i)return null;const level=b.price+(b.price-a.price)*(i-b.i)/(b.i-a.i);return ok(atr[i])&&Math.abs(level-C[i].close)>Math.max(atr[i]*10,0.2)?null:level;};
    for(let i=0;i<N;i++){
      while(at<piv.length&&piv[at].i+p.pivot<=i){const q=piv[at++];(q.kind==='high'?hi:lo).push(q);if(hi.length>3)hi.shift();if(lo.length>3)lo.shift();}
      upper[i]=extrap(hi,i);lower[i]=extrap(lo,i);
      if(i<1||i>=N-1)continue;const c=C[i],prev=C[i-1];
      if(crossing(c.close,prev.close,upper[i],upper[i-1]))events.push({i,dir:1,price:upper[i]});
      else if(ok(lower[i])&&ok(lower[i-1])&&c.close<lower[i]&&prev.close>=lower[i-1])events.push({i,dir:-1,price:lower[i]});
      else if(ok(upper[i])&&c.high>=upper[i]&&c.close<upper[i]&&Math.abs(c.high-upper[i])<p.tolerance)touches.push({i,price:upper[i],dir:-1});
      else if(ok(lower[i])&&c.low<=lower[i]&&c.close>lower[i]&&Math.abs(lower[i]-c.low)<p.tolerance)touches.push({i,price:lower[i],dir:1});
    }
    return {upper,lower,events,touches};}
  indicator({id:'joma-binary-lines-lab',name:'Binary Lines Research · Pivots',short:'Binary Lab',
    desc:'Independent confirmed pivot trendlines, touch markers, and close breakouts. Not Binary Lux proprietary signals.',
    inputs:[I.int('pivot','Swing confirmation',4,1,15),I.float('tolerance','Touch tolerance ($)',2,0.01,50,0.01),I.int('extend','Max extension (bars)',45,5,150),I.bool('touches','Display rejected touches',true),I.bool('breakouts','Display confirmed crossings',true)],
    calc:(C,p)=>{const r=pivotLines(C,p);return {...r,lines:[line(r.upper,DN,1),line(r.lower,UP,1)]};},
    draw(ctx,v,p,r){if(p.breakouts)for(const e of r.events.slice(-80)){if(e.i<v.from||e.i>v.to)continue;text(ctx,xs(v,e.i),ys(v,e.price)+(e.dir>0?-10:13),e.dir>0?'▲':'▼',e.dir>0?UP:DN);}if(p.touches)for(const e of r.touches.slice(-100)){if(e.i<v.from||e.i>v.to)continue;const x=xs(v,e.i),y=ys(v,e.price);if(x==null||y==null)continue;ctx.fillStyle=e.dir>0?UP:DN;ctx.beginPath();ctx.arc(x,y,2,0,Math.PI*2);ctx.fill();}}
  });

  indicator({id:'joma-umbrella-lab',name:'Umbrella Research · ATR Shelter',short:'Umbrella Lab',
    desc:'Independent ATR trailing boundaries and EMA envelope. Trend-state visualisation, not the licensed Umbrella formula.',
    inputs:[I.int('period','ATR period',14,2,100),I.float('mult','ATR multiple',2.5,0.2,10,0.1),I.int('basis','EMA basis',34,2,200)],
    calc:(C,p)=>{const st=TA.supertrend(C,p.period,p.mult),basis=TA.ema(C.map(b=>b.close),p.basis),a=TA.atr(C,p.period);
      const u=basis.map((x,i)=>ok(x)&&ok(a[i])?x+a[i]*p.mult:null),d=basis.map((x,i)=>ok(x)&&ok(a[i])?x-a[i]*p.mult:null);
      return {lines:[line(st.line.map((x,i)=>st.dir[i]===1?x:null),UP,2),line(st.line.map((x,i)=>st.dir[i]===-1?x:null),DN,2),line(basis,GOLD,1),line(u,'#7f98ca',1),line(d,'#7f98ca',1)],fills:[{a:u,b:d,color:hexA(BLUE,.06)}]};}
  });

  indicator({id:'joma-binlex-lab',name:'Binlex Research · Compression Oscillator',short:'Binlex Lab',kind:'pane',
    desc:'Independent Bollinger/Keltner volatility squeeze with normalised momentum bars. Not an extraction of the Binlex indicator.',
    inputs:[I.int('length','Squeeze lookback',20,5,100),I.float('bb','Bollinger width',2,0.5,4,0.1),I.float('kc','Keltner width',1.5,0.5,4,0.1),I.int('momentum','Momentum window',12,2,50)],
    calc:(C,p)=>{const cl=C.map(x=>x.close),ma=TA.sma(cl,p.length),sd=TA.stdev(cl,p.length),atr=TA.atr(C,p.length),m=TA.ema(cl,p.momentum);
      const osc=C.map((b,i)=>ok(m[i])&&ok(atr[i])&&atr[i]>0?100*(b.close-m[i])/atr[i]:null),sq=C.map((b,i)=>ok(sd[i])&&ok(atr[i])&&p.kc*atr[i]>0&&(p.bb*sd[i]<p.kc*atr[i])?1:0);
      return {hist:[{data:osc,colors:osc.map((x,i)=>!ok(x)?'transparent':hexA(sq[i]?'#f5cb68':x>=0?UP:DN,.77)),color:UP}],lines:[line(empty(C.length).map(()=>0),'#788294',1)],bounds:[-250,250],squeeze:sq};}
  });

  indicator({id:'joma-aurora-lab',name:'Aurora Research · Dual Momentum Cloud',short:'Aurora Lab',
    desc:'Independent dual EMA momentum cloud coloured by slope and spread, with ATR-adaptive outside bands. Not proprietary Aurora.',
    inputs:[I.int('fast','Fast length',12,2,100),I.int('slow','Slow length',30,3,200),I.int('atr','ATR length',14,2,100),I.float('width','Envelope ATR',0.8,0.1,5,0.1)],
    calc:(C,p)=>{const cl=C.map(b=>b.close),f=TA.ema(cl,p.fast),s=TA.ema(cl,p.slow),a=TA.atr(C,p.atr),u=f.map((x,i)=>ok(x)&&ok(a[i])?x+p.width*a[i]:null),d=f.map((x,i)=>ok(x)&&ok(a[i])?x-p.width*a[i]:null);
      return {lines:[line(f,'#8a92ff',2),line(s,GOLD,1),line(u,hexA(UP,.3),1),line(d,hexA(DN,.3),1)],fills:[{a:f,b:s,color:hexA(UP,.15),colorDown:hexA(DN,.15)}]};}
  });

  // Prior candle channel breakout: no current-bar range included in decision. Last candle withheld.
  function breakoutStudy(C,p){const N=C.length,h=C.map(b=>b.high),l=C.map(b=>b.low),v=C.map(b=>Math.max(0,b.volume||0));const avg=TA.sma(v,p.length),high=empty(N),low=empty(N),events=[],retests=[];
    let active=null;
    for(let i=p.length;i<N;i++){
      let hh=-Infinity,ll=Infinity;for(let k=i-p.length;k<i;k++){hh=Math.max(hh,h[k]);ll=Math.min(ll,l[k]);}high[i]=hh;low[i]=ll;
      if(i===N-1)continue; // Last candle may still be forming.
      const b=C[i],pc=C[i-1].close,priorVol=i>0?avg[i-1]:null;const allowed=ok(priorVol)&&priorVol>0&&v[i]>=p.vol*priorVol;
      if(allowed&&(!events.length||i-events[events.length-1].i>=(p.cooldown||8))&&b.close>hh&&pc<=hh){const e={i,dir:1,price:hh,kind:'break'};events.push(e);active=e;}
      else if(allowed&&(!events.length||i-events[events.length-1].i>=(p.cooldown||8))&&b.close<ll&&pc>=ll){const e={i,dir:-1,price:ll,kind:'break'};events.push(e);active=e;}
      else if(active&&i>active.i&&i-active.i<=p.retest&&((active.dir>0&&b.low<=active.price&&b.close>active.price)||(active.dir<0&&b.high>=active.price&&b.close<active.price))){retests.push({i,dir:active.dir,price:active.price});active=null;}
      else if(active&&i-active.i>p.retest)active=null;
    }
    return {high,low,events,retests};}
  indicator({id:'joma-breakout-lab',name:'Breakout Research · Range & Retest',short:'Breakout Lab',
    desc:'Independent prior N-bar high/low breakouts, volume filter, and level retests. Signals appear after candle closes; not indtrade Breakout.',
    inputs:[I.int('length','Previous bars',20,5,150),I.float('vol','Tick volume confirmation ×',1.2,0.1,5,0.1),I.int('retest','Retest max bars',12,1,100),I.int('cooldown','Bars between breaks',8,1,100),I.bool('labels','Show markers',true)],
    calc:(C,p)=>{const r=breakoutStudy(C,p);return {...r,lines:[line(r.high,hexA(UP,.8),1),line(r.low,hexA(DN,.8),1)]};},
    draw(ctx,v,p,r){if(!p.labels)return;for(const e of r.events.slice(-90)){if(e.i<v.from||e.i>v.to)continue;text(ctx,xs(v,e.i),ys(v,e.price)+(e.dir>0?-12:14),e.dir>0?'BRK ▲':'BRK ▼',e.dir>0?UP:DN);}for(const e of r.retests.slice(-70)){if(e.i<v.from||e.i>v.to)continue;text(ctx,xs(v,e.i),ys(v,e.price)+(e.dir>0?14:-10),'RT',GOLD);}}
  });
  if(typeof module!=='undefined'&&module.exports) module.exports={pulseColumns,pivotLines,breakoutStudy};
})();
