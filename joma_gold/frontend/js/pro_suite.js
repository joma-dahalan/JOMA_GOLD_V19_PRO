/* JOMA Market Studio: original dashboard and recorded-flow footprint. No broker order execution.
   Neither liquidation clusters nor exchange-wide volumes are inferred from proxy data. */
(() => {
'use strict';
const J=window.JG,$=id=>document.getElementById(id),TA=window.JGTA;
const K='jg17_', get=(k,d)=>{try{const x=localStorage.getItem(K+k);return x===null?d:JSON.parse(x);}catch{return d;}},set=(k,v)=>{try{localStorage.setItem(K+k,JSON.stringify(v));}catch{}};
const S={open:!!get('open',false),tab:'overview',mode:get('mode','classic'),footOn:!!get('footOn',false),fp:null,fpTf:'',fpFetched:0,fpMap:null,fpMapSource:null,loading:false,bucket:get('bucket',1),selected:0,watch:get('watch',[]),workspaces:get('workspaces',[]),lastPrice:null,toastTimer:null};
const money=J.money,fmt=J.fmt;
if(!Array.isArray(S.watch))S.watch=[];if(!Array.isArray(S.workspaces))S.workspaces=[];
if(!['classic','delta','volume'].includes(S.mode))S.mode='classic';
if(![.5,1,2,5].includes(Number(S.bucket)))S.bucket=1;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isOn=id=>J._core.instances().some(x=>x.def.id===id&&x.visible);
const show=(s)=>{const a=$('suiteToast');a.textContent=s;a.classList.remove('hidden');clearTimeout(S.toastTimer);S.toastTimer=setTimeout(()=>a.classList.add('hidden'),4000);};
function open(v){S.open=!!v;set('open',S.open);$('app').classList.toggle('suite-open',S.open);$('suitePanel').classList.toggle('hidden',!S.open);$('suiteToggle').classList.toggle('on',S.open);$('suiteToggle').setAttribute('aria-expanded',String(S.open));if(S.open){render();if(S.tab==='footprint')refreshFootprint(true);}setTimeout(()=>{J.chart.resize($('chartShell').clientWidth,$('chartShell').clientHeight);J.requestDraw();},50);}
function tab(t){S.tab=t;document.querySelectorAll('.suite-tabs button').forEach(b=>{b.classList.toggle('active',b.dataset.suiteTab===t);b.setAttribute('aria-selected',String(b.dataset.suiteTab===t));});render();$('suiteBody').scrollTop=0;if(t==='footprint')refreshFootprint(true);}
const toggleLayer=(k,on)=>J.setLayer(k,on);
function toggleInd(id){const its=J._core.instances().filter(x=>x.def.id===id);if(its.length)its.forEach(x=>J._core.remove(x.uid));else J._core.add(id);render();}
function action(id){switch(id){
 case 'density':toggleInd('joma-density');break;
 case 'pulse-lab':toggleInd('joma-pulse-lab');break;
 case 'saga-lab':toggleInd('joma-saga-lab');break;
 case 'binary-lab':toggleInd('joma-binary-lines-lab');break;
 case 'umbrella-lab':toggleInd('joma-umbrella-lab');break;
 case 'binlex-lab':toggleInd('joma-binlex-lab');break;
 case 'aurora-lab':toggleInd('joma-aurora-lab');break;
 case 'breakout-lab':toggleInd('joma-breakout-lab');break;
 case 'regime':toggleInd('joma-regime');break;
 case 'liquidity':{const on=!(J.state.heatOn&&J.state.wallsOn);toggleLayer('heatOn',on);toggleLayer('wallsOn',on);render();break;}
 case 'levels':toggleInd('vprofile');break;
 case 'whales':toggleLayer('bubOn',!J.state.bubOn);render();break;
 case 'footprint':S.footOn=!S.footOn;set('footOn',S.footOn);if(S.footOn)refreshFootprint(true);J.requestDraw();render();break;
 case 'delta':toggleLayer('flowOn',!J.state.flowOn);render();break;
 case 'oanda':toggleLayer('oandaOn',!J.state.oandaOn);render();break;
 }}
const badge=(on)=>`<span class="suite-status ${on?'active':''}">${on?'ON':'OFF'}</span>`;
const feature=(act,n,label,desc,on)=>`<button type="button" class="suite-feature" data-suite-act="${act}"><span class="suite-feature-num">${n}</span><span class="suite-feature-text"><strong>${label}</strong><small>${desc}</small></span>${badge(on)}</button>`;
function metrics(){const C=J.state.candles;if(C.length<57)return {ok:false};const close=C.map(x=>x.close),i=C.length-1,e21=TA.ema(close,21)[i],e55=TA.ema(close,55)[i],rsi=TA.rsi(close,14)[i],atr=TA.atr(C,14)[i];return {ok:[e21,e55,rsi,atr].every(Number.isFinite),close:close[i],ema21:e21,ema55:e55,rsi,atr,spread:e21-e55,range:100*atr/close[i]};}
function overview(){
 const m=metrics(),C=J.state.candles,d=J.state.raw||{},now=Date.now(),rawPrice=Number(d.referencePrice);
 const engineMs=Number(d.engineUpdatedMs),engineAge=engineMs>0?Math.max(0,(now-engineMs)/1000):null;
 const online=Number.isFinite(rawPrice)&&rawPrice>0&&engineAge!==null&&engineAge<6;
 const b=d.bias||{},mt=d.metrics||{},dir=b.direction||'NEUTRAL',status=b.status||'NO_DATA';
 const confirmed=status==='CONFIRMED_BIAS',waiting=status==='WAIT'||(dir!=='NEUTRAL'&&!confirmed);
 const decision=status==='NO_DATA'||!online?'WAITING FOR DATA':confirmed?`${dir} BIAS CONFIRMED`:waiting?`WAIT · ${dir} BIAS`:'NO TRADE';
 const decisionTone=confirmed?(dir==='BUY'?'buy':'sell'):'neutral';
 const score=Number.isFinite(Number(b.score))&&status!=='NO_DATA'?Math.max(0,Math.min(100,Number(b.score))):null;
 const quality=Number.isFinite(Number(mt.quality))?Math.max(0,Math.min(1,Number(mt.quality))):null;
 const pct=v=>Number.isFinite(Number(v))?`${Number(v)>=0?'+':''}${Math.round(Number(v)*100)}%`:'—';
 const factor=(label,value)=>{const n=Number(value),valid=Number.isFinite(n);const amount=valid?Math.max(0,Math.min(100,Math.abs(n)*100)):0;return `<div class="intel-factor"><span>${label}</span><div class="intel-track"><i class="${valid&&n<0?'negative':'positive'}" style="width:${amount}%"></i></div><b class="${valid&&n<0?'negative-text':valid&&n>0?'positive-text':''}">${valid?pct(n):'—'}</b></div>`;};
 const ref=(label,z)=>z&&Number.isFinite(Number(z.center))?`<div class="intel-reference"><span>${label}</span><b>${fmt(z.center)}</b><small>Strength ${Number.isFinite(Number(z.strength))?Math.round(z.strength):'—'}/100 · ${money(z.notionalUsd)}</small></div>`:'';
 let html=`<div class="suite-kicker"><span class="suite-dot ${online?'live':'off'}"></span>${online?'REFERENCE PRICE FRESH':'LIVE PRICE NOT CONFIRMED'}<span class="suite-aux">${esc(J.state.tf)} · ${C.length} candles · ${engineAge===null?'engine age —':`${engineAge.toFixed(1)}s old`}</span></div>`;
 html+=`<section class="intel-decision ${decisionTone}"><div class="intel-decision-head"><div><span class="intel-overline">GOLD INTELLIGENCE · DECISION STATE</span><h3>${esc(decision)}</h3></div><span class="intel-score">${score===null?'—':score}<small>/100</small></span></div><div class="intel-reason">${esc(b.reason||'Waiting for enough live data to assess direction.')}</div><div class="intel-quality"><div><span>Data quality</span><b>${quality===null?'—':Math.round(quality*100)+'%'}</b></div><div class="intel-quality-track"><i style="width:${quality===null?0:Math.round(quality*100)}%"></i></div></div><p>Research score is not a win probability. A directional bias is not an entry signal; weak or incomplete evidence means wait.</p></section>`;
 html+=`<section class="suite-section"><div class="suite-section-heading"><h3>Confluence factors</h3><span>Normalized engine inputs</span></div><div class="intel-factors">${factor('Aggressive flow',mt.flow)}${factor('Book imbalance',mt.bookImbalance)}${factor('Price trend',mt.trend)}${factor('Composite',mt.composite)}</div><div class="suite-context">Factors range from −100% to +100%. Positive/negative values show direction of the measured input, not expected return. Missing inputs remain blank.</div>`;
 html+=`<div class="intel-references">${ref('Liquidity reference A',b.targetZone)}${ref('Liquidity reference B',b.supportZone)}</div><p class="suite-disclaimer">Liquidity references are analytical context only; they are not automatically calculated entry, stop-loss, or take-profit instructions.</p></section>`;
 html+=`<section class="suite-section"><div class="suite-section-heading"><h3>Chart diagnostics</h3><span>Historical OHLC</span></div><div class="suite-metrics">
 <div class="suite-metric"><span>EMA 21</span><b>${m.ok?fmt(m.ema21):'—'}</b></div><div class="suite-metric"><span>EMA 55</span><b>${m.ok?fmt(m.ema55):'—'}</b></div>
 <div class="suite-metric"><span>RSI · 14</span><b>${m.ok?fmt(m.rsi,1):'—'}</b></div><div class="suite-metric"><span>ATR · 14</span><b>${m.ok?fmt(m.atr):'—'}</b></div></div>`;
 html+=`<div class="suite-context">${m.ok?'EMA separation: '+fmt(m.spread)+' USD · ATR / price: '+fmt(m.range,2)+'%. These are measurements of past candles, not predictions.':'Waiting for at least 57 candles for full metrics.'}</div></section>`;
 html+=`<section class="suite-section"><div class="suite-section-heading"><h3>Research modules</h3><span>Independent implementations</span></div>
 ${feature('pulse-lab','01','Rolling density','Broker tick-volume bands + POC',isOn('joma-pulse-lab'))}
 ${feature('liquidity','02','Liquidity heatmap','Recorded resting orders, not liquidations',J.state.heatOn&&J.state.wallsOn)}
 ${feature('levels','03','Price levels','Visible volume profile, POC / VAH / VAL',isOn('vprofile'))}
 ${feature('whales','04','Large prints','Aggregated public-venue trade bubbles',J.state.bubOn)}
 ${feature('footprint','05','Executed-flow footprint','Bid/ask notional by recorded price row',S.footOn)}
 </section>`;
 html+=`<section class="suite-section"><div class="suite-section-heading"><h3>Additional analysis</h3></div>${feature('regime','+','EMA / ATR Ribbon','Descriptive trend and volatility bands',isOn('joma-regime'))}${feature('delta','+','Delta & CVD','Venue buy/sell imbalance over time',J.state.flowOn)}${feature('oanda','+','OANDA distribution','Client-order/position percentages when configured',J.state.oandaOn)}</section>`;
 html+=`<p class="suite-disclaimer">No synthetic market observations are added to the live application. Spot gold has no single consolidated public order book; venue-derived liquidity is partial and must be interpreted as a proxy.</p>`;
 return html;
}
const fpBuckets=()=>{
 if(S.fpMapSource===S.fp&&S.fpMap)return S.fpMap;
 const m=new Map();if(!S.fp||!Array.isArray(S.fp.rows))return m;
 for(const row of S.fp.rows){const [ms,price,buy,sell,trades]=row;let a=m.get(ms);if(!a){a=[];m.set(ms,a);}a.push({ms,price,buy,sell,trades,total:buy+sell,delta:buy-sell});}
 for(const a of m.values())a.sort((x,y)=>y.price-x.price);
 S.fpMap=m;S.fpMapSource=S.fp;return m;
};
function footprint(){const mp=fpBuckets(),keys=[...mp.keys()].sort((a,b)=>b-a),stamp=keys[Math.min(S.selected,keys.length-1)],rows=mp.get(stamp)||[],tot=rows.reduce((s,r)=>s+r.total,0),max=Math.max(1,...rows.map(x=>Math.max(x.buy,x.sell,x.total,Math.abs(x.delta)))),poc=rows.reduce((m,r)=>!m||r.total>m.total?r:m,null);
 const bar=(v,color)=>`<span class="suite-foot-bar ${color}" style="width:${Math.max(1,Math.min(100,100*Math.abs(v)/max))}%"></span>`;
 let html=`<div class="suite-kicker"><span class="suite-dot ${rows.length?'live':'off'}"></span>RECORDED FLOW <span class="suite-aux">${S.fp?.rows?.length?S.fp.rows.length+' PRICE ROWS':'NO STORED EXECUTIONS'}</span></div><section class="suite-section">
 <div class="suite-section-heading"><h3>Footprint explorer</h3><span>Public venue aggregates</span></div>
 <p class="suite-help">Recorded public-venue aggressive buys / sells aggregated by price and candle. The prices are aligned to the broker reference; this is not a centralized spot-gold footprint.</p>
 <div class="suite-field"><label for="suiteBucket">Price row</label><select id="suiteBucket"><option value="0.5" ${S.bucket===.5?'selected':''}>$0.50</option><option value="1" ${S.bucket===1?'selected':''}>$1.00</option><option value="2" ${S.bucket===2?'selected':''}>$2.00</option><option value="5" ${S.bucket===5?'selected':''}>$5.00</option></select></div>
 <div class="suite-mode">${['classic','delta','volume'].map((v,i)=>`<button type="button" data-suite-mode="${v}" class="${v===S.mode?'active':''}">${i+1} · ${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div>
 <div class="suite-field"><label for="suiteCandle">Recorded candle</label><select id="suiteCandle">${keys.slice(0,80).map((t,i)=>`<option value="${i}" ${Math.min(S.selected,keys.length-1)===i?'selected':''}>${new Date(t).toISOString().slice(5,16).replace('T',' ') } UTC</option>`).join('')||'<option>None</option>'}</select></div>
 <div class="suite-foot-stats"><div><span>Recorded notional</span><strong>${tot>0?money(tot):'—'}</strong></div><div><span>Bar POC</span><strong>${poc?fmt(poc.price):'—'}</strong></div></div>
 <div class="suite-foot-head"><span>Agg. sell USD</span><span>PRICE</span><span>Agg. buy USD</span></div><div class="suite-foot-rows">`;
 if(!rows.length)html+='<div class="suite-empty">No executions recorded in this window. Connect public venue feeds and let the recorder collect observations. Empty periods are never synthesized.</div>';
 for(const r of rows.slice(0,140)){
  if(S.mode==='classic')html+=`<div class="suite-foot-row ${r===poc?'poc':''}"><div class="suite-sellcell">${bar(r.sell,'sell')}<span>${money(r.sell)}</span></div><b>${fmt(r.price)}</b><div class="suite-buycell">${bar(r.buy,'buy')}<span>${money(r.buy)}</span></div></div>`;
  if(S.mode!=='classic'){const val=S.mode==='delta'?r.delta:r.total;const col=S.mode==='delta'?(val>=0?'buy':'sell'):'both';html+=`<div class="suite-foot-row ${r===poc?'poc':''}"><span></span><b>${fmt(r.price)}</b><div class="suite-buycell">${bar(val,col)}<span>${money(val)}</span></div></div>`;}
 }
 html+='</div>';
 if(S.fp?.sampleLimited)html+='<div class="suite-context warn">The server capped this query at 60,000 stored rows. Aggregates may be incomplete.</div>';
 if(J.state.fallback)html+='<div class="suite-context warn">Broker candles are unavailable. Footprint cannot be overlaid reliably on a fallback market chart.</div>';
 html+=`<label class="suite-switch"><input type="checkbox" data-suite-footon ${S.footOn?'checked':''}><span>Draw footprint on chart (when zoomed in)</span></label><button type="button" class="suite-action" data-suite-refresh>Refresh records</button></section>
 <p class="suite-disclaimer">Zoom closer for individual price rows; gold ticks on distant charts mark recorded POCs only. Keys 1, 2 and 3 change the footprint display.</p>`;
 return html;}
function depth(){
 // Live book is a short-lived snapshot from recorded gold-linked venue quotes.
 // Its cells are [priceIndex, notionalInThousandsUSD, dominantBidFlag].
 const b=J.state.book, price=J.state.raw?.referencePrice;
 const age=b?.ts?Date.now()-b.ts:Infinity;
 const valid=!!(b?.ok && finite(b.bucket) && b.bucket>0 && Array.isArray(b.cells) && age>=0 && age<30000);
 const rows=valid?b.cells.filter(a=>Array.isArray(a)&&finite(a[0])&&finite(a[1])&&a[1]>=0).map(a=>({price:a[0]*b.bucket,usd:a[1]*1000,side:a[2]===1?'bid':'ask'})) : [];
 const nearest=finite(price)&&price>0?rows.sort((a,z)=>Math.abs(a.price-price)-Math.abs(z.price-price)).slice(0,27):rows.slice(0,27);
 nearest.sort((a,z)=>z.price-a.price);
 const max=Math.max(1,...nearest.map(x=>x.usd));
 const bid=nearest.reduce((v,r)=>v+(r.side==='bid'?r.usd:0),0),ask=nearest.reduce((v,r)=>v+(r.side==='ask'?r.usd:0),0);
 const total=bid+ask,ratio=total?bid/total:0;
 const bubbles=Array.isArray(J.state.flow?.bubbles)?J.state.flow.bubbles:[];
 const last=bubbles.filter(x=>finite(x.t)&&finite(x.price)&&finite(x.usd)&&x.usd>0&&Date.now()-x.t<15*60000&&x.t<=Date.now()).slice(-14).reverse();
 let html=`<div class="suite-kicker"><span class="suite-dot ${valid?'live':'off'}"></span>${valid?'BOOK SNAPSHOT':'BOOK UNAVAILABLE / STALE'}<span class="suite-aux">${valid?Math.round(age/1000)+' SEC AGO':'NO RECENT DEPTH'}</span></div>`;
 html+=`<section class="suite-section"><div class="suite-section-heading"><h3>Depth ladder</h3><span>Venue proxies · $ notional</span></div>
 <p class="suite-help">Most recent stored liquidity snapshot from gold-linked venues mapped to the reference quote. This is not a native spot-gold order book. The display clears if the record is stale.</p>
 <div class="suite-foot-stats"><div><span>Displayed bid-side</span><strong>${total?money(bid):'—'}</strong></div><div><span>Displayed ask-side</span><strong>${total?money(ask):'—'}</strong></div></div>
 ${total?`<div class="suite-depth-meter"><span style="width:${(100*ratio).toFixed(1)}%"></span></div><div class="suite-depth-label"><span>Bid ${(100*ratio).toFixed(0)}%</span><span>Ask ${(100*(1-ratio)).toFixed(0)}%</span></div>`:''}
 <div class="suite-foot-head"><span>BID</span><span>PRICE</span><span>ASK</span></div><div class="suite-foot-rows suite-depth-list">`;
 if(!nearest.length)html+='<div class="suite-empty">No recent recorded resting orders. Turn on and verify the venue data feeds.</div>';
 for(const x of nearest){const w=(x.usd/max*95).toFixed(1),label=money(x.usd);
  html+=`<div class="suite-foot-row"><div class="suite-sellcell">${x.side==='bid'?`<span>${label}</span><span class="suite-foot-bar buy" style="width:${w}%"></span>`:''}</div><b>${fmt(x.price)}</b><div class="suite-buycell">${x.side==='ask'?`<span class="suite-foot-bar sell" style="width:${w}%"></span><span>${label}</span>`:''}</div></div>`;}
 html+=`</div></section><section class="suite-section"><div class="suite-section-heading"><h3>Large execution prints</h3><span>Aggregated, recorded flow</span></div>
 <p class="suite-help">Recent trade bubbles represent aggregated venue transactions, not verified single-whale orders.</p>`;
 if(!last.length)html+='<div class="suite-empty">No large execution prints are currently available.</div>';
 for(const x of last){const v=finite(x.buyUsd)?x.buyUsd:0,sv=finite(x.sellUsd)?x.sellUsd:0,side=v>=sv?'buy':'sell';
 html+=`<div class="suite-level"><span><b>${fmt(x.price)}</b><small class="${side}">${new Date(x.t).toISOString().slice(11,16)} UTC · ${side==='buy'?'BUY':'SELL'} majority</small></span><span>${money(x.usd)}</span></div>`;}
 html+='</section><p class="suite-disclaimer">Partial exchange-linked feed. Do not interpret these figures as global gold liquidity or proof of a future market move.</p>';
 return html;
}
function levels(){const d=J.state.raw||{},fresh=finite(d.engineUpdatedMs)&&d.engineUpdatedMs>0&&Date.now()-d.engineUpdatedMs>=0&&Date.now()-d.engineUpdatedMs<10000,zones=(fresh&&Array.isArray(d.zones)?d.zones:[]).filter(z=>Number.isFinite(z.center)&&Number.isFinite(z.notionalUsd)).sort((a,b)=>b.notionalUsd-a.notionalUsd).slice(0,18);const px=Number(d.referencePrice),current=Number.isFinite(px)&&px>0?px:null;
 let html=`<div class="suite-kicker"><span class="suite-dot ${zones.length?'live':'off'}"></span>RECORDED LIQUIDITY <span class="suite-aux">${zones.length} highlighted zones</span></div><section class="suite-section"><div class="suite-section-heading"><h3>Resting liquidity zones</h3><span>Fresh snapshots only</span></div><p class="suite-help">Resting orders on public gold-linked venues, mapped into broker-price coordinates. Not liquidation estimates or all-market liquidity.</p>`;
 html+=`<div class="suite-level-head"><span>LEVEL</span><span>VISIBLE NOTIONAL</span></div>`;
 if(!zones.length)html+='<div class="suite-empty">No fresh order-book zones available. Check the data feeds. Stale levels are hidden.</div>';
 for(const z of zones){const side=z.side==='buy'?'buy':'sell',delta=current?z.center-px:null;html+=`<div class="suite-level"><span><b>${fmt(z.center)}</b><small class="${side}">${side.toUpperCase()} · ${delta===null?'—':(delta>0?'+':'')+fmt(delta)} USD</small></span><span>${money(z.notionalUsd)}</span></div>`;}
 html+=`</section><section class="suite-section"><h3>Price level watch</h3><p class="suite-help">Local informational notification when the quoted price crosses a selected level (while this page stays open).</p><form id="suiteWatchForm" class="suite-watch-form"><input id="suiteWatchPrice" type="number" step="0.01" min="0.01" placeholder="Gold price (USD)" required><button type="submit">+ Watch</button></form>`;
 if(S.watch.length)html+=`<div class="suite-watches">${S.watch.map(w=>`<div><b>${fmt(w.value)}</b><span>${w.triggered?'Triggered':'Watching'}</span><button type="button" data-suite-unwatch="${w.id}" aria-label="Remove watch">×</button></div>`).join('')}</div>`;
 html+=`</section>`;return html;}
function snapshot(){return {layers:{heatOn:J.state.heatOn,wallsOn:J.state.wallsOn,bubOn:J.state.bubOn,flowOn:J.state.flowOn,oandaOn:J.state.oandaOn},footOn:S.footOn,indicators:J._core.instances().map(i=>({id:i.def.id,params:{...i.params},visible:i.visible}))};}
function applySnap(s){if(!s||typeof s!=='object'||!s.layers||!Array.isArray(s.indicators))return;
 for(const [k,v] of Object.entries(s.layers))if(['heatOn','wallsOn','bubOn','flowOn','oandaOn'].includes(k))J.setLayer(k,!!v);
 const old=J._core.instances().slice();old.forEach(it=>J._core.remove(it.uid));for(const it of s.indicators.slice(0,40))if(J._core.REG.has(it.id))J._core.add(it.id,it.params,it.visible!==false);
 S.footOn=!!s.footOn;set('footOn',S.footOn);if(S.footOn)refreshFootprint(true);J.requestDraw();render();}
function preset(n){const curr=snapshot();let ids=[],layers={heatOn:false,wallsOn:false,bubOn:false,flowOn:false,oandaOn:false},footOn=false;
 if(n==='heat'){ids=['joma-pulse-lab','vprofile'];layers.heatOn=true;layers.wallsOn=true;}
 if(n==='flow'){ids=['volume'];layers.bubOn=true;layers.flowOn=true;footOn=true;}
 if(n==='structure'){ids=['joma-regime','structure','fvg'];}
 // Only accept IDs in the installed library.
 applySnap({...curr,layers,footOn,indicators:ids.filter(x=>J._core.REG.has(x)).map(id=>({id,params:{},visible:true}))});show('Workspace preset applied');}
// Public product names are references for navigation only. These are JOMA original studies.
const RESEARCH=[
  {id:'pulse-lab',title:'Pulse V2',sub:'Rolling tick-volume heat columns + POC',source:'OHLC + broker tick volume',check:()=>isOn('joma-pulse-lab'),note:'Historical density estimate, not the original volume engine'},
  {id:'liquidity',title:'XRay',sub:'Recorded resting-order heatmap and liquidity walls',source:'Recorded venue depth only',check:()=>J.state.heatOn&&J.state.wallsOn,note:'NOT a liquidation map or leverage-position estimate'},
  {id:'levels',title:'Inside Levels',sub:'Visible-range POC + 70% value area',source:'Broker tick-volume profile',check:()=>isOn('vprofile'),note:'No true consolidated executed-volume distribution'},
  {id:'whales',title:'Whales Map',sub:'Actual recorded large prints over candles',source:'Partial public-venue executions',check:()=>J.state.bubOn,note:'Not proof that a particular person/whale traded'},
  {id:'footprint',title:'Print Pro',sub:'Bid / ask rows, delta, volume and price POC',source:'Recorded aggressive trade flow',check:()=>S.footOn,note:'May be empty without recorded trades; not centralised gold flow'},
  {id:'saga-lab',title:'Saga',sub:'Regime blocks, EMA and ADX with volume prominence',source:'Broker OHLC + tick volume',check:()=>isOn('joma-saga-lab'),note:'Independent research concept; original Saga internals unavailable'},
  {id:'binary-lab',title:'Binary Lux',sub:'Confirmed pivot trendlines, touch and break marks',source:'Broker OHLC',check:()=>isOn('joma-binary-lines-lab'),note:'Independent trendline logic, not identical signals'},
  {id:'umbrella-lab',title:'Umbrella',sub:'ATR trailing shelter with EMA envelope',source:'Broker OHLC',check:()=>isOn('joma-umbrella-lab'),note:'Independent ATR study, not a licensed formula'},
  {id:'binlex-lab',title:'Binlex',sub:'Bollinger / Keltner squeeze momentum',source:'Broker OHLC + tick volume',check:()=>isOn('joma-binlex-lab'),note:'Independent oscillator; no verified product specification'},
  {id:'aurora-lab',title:'Aurora',sub:'Dual EMA cloud and ATR momentum band',source:'Broker OHLC',check:()=>isOn('joma-aurora-lab'),note:'Independent momentum cloud; no verified signal equivalence'},
  {id:'breakout-lab',title:'Breakout',sub:'Prior-bar range breaks, volume and retest annotations',source:'Broker OHLC + tick volume',check:()=>isOn('joma-breakout-lab'),note:'Last unclosed candle excluded; independent definitions'}
];
function research(){
  const available=RESEARCH.filter(x=>x.check()).length;
  return `<div class="suite-kicker"><span class="suite-dot ${available?'live':'off'}"></span>JOMA RESEARCH ELEVEN <span class="suite-aux">${available} / 11 active</span></div>
  <section class="suite-section"><div class="suite-section-heading"><h3>11 independent chart studies</h3><span>Function comparisons</span></div>
  <p class="suite-help">This is an independent collection based on public descriptions and standard technical calculations. It is NOT indtrade's source code, a paid subscription unlock, or an exact clone. Proprietary formulas for the six less-documented titles have not been verified.</p>
  <div class="research-index">${RESEARCH.map((m,i)=>`<button type="button" class="research-item ${m.check()?'on':''}" data-suite-act="${m.id}" title="${esc(m.note)}">
    <span class="research-ordinal">${String(i+1).padStart(2,'0')}</span>
    <span class="research-copy"><b>${esc(m.title)} <small>RESEARCH ANALOGUE</small></b><em>${esc(m.sub)}</em><span>${esc(m.source)}</span><span class="research-note">${esc(m.note)}</span></span>
    ${badge(m.check())}
  </button>`).join('')}</div></section>
  <p class="suite-disclaimer">Chart indicators describe history; they do not execute trades. Price/volume data availability depends on each configured provider, and unavailable feeds remain unavailable rather than being fabricated.</p>`;
}
function workspaces(){return `<div class="suite-kicker"><span class="suite-dot live"></span>PERSONAL WORKSPACE <span class="suite-aux">saved locally</span></div>
 <section class="suite-section"><div class="suite-section-heading"><h3>Quick layouts</h3><span>One click</span></div><div class="suite-presets">
 <button type="button" data-suite-preset="heat"><b>Liquidity Study</b><small>Density + price profile + recorded heat</small></button>
 <button type="button" data-suite-preset="flow"><b>Execution Study</b><small>Footprint + prints + delta / CVD</small></button>
 <button type="button" data-suite-preset="structure"><b>Price Structure</b><small>EMA ribbon and structure overlays</small></button>
 </div></section>
 <section class="suite-section"><div class="suite-section-heading"><h3>Saved layouts</h3><span>${S.workspaces.length} / 8</span></div><form id="suiteSaveForm" class="suite-watch-form"><input id="suiteWorkspaceName" maxlength="40" placeholder="Layout name" required><button type="submit">Save</button></form>
 <div class="suite-watches">${S.workspaces.map((w,i)=>`<div><b>${esc(w.name)}</b><span>LOCAL</span><button type="button" data-suite-load="${i}" title="Restore">Load</button><button type="button" data-suite-delete="${i}" title="Delete">×</button></div>`).join('')||'<div class="suite-empty">No saved layouts yet.</div>'}</div></section>
 <p class="suite-disclaimer">Layouts and alerts are stored only in this browser. Clearing browser data removes them.</p>`;}
function render(){if(!S.open)return;const body=$('suiteBody'),scroll=body.scrollTop;body.innerHTML=S.tab==='overview'?overview():S.tab==='footprint'?footprint():S.tab==='depth'?depth():S.tab==='levels'?levels():S.tab==='research'?research():workspaces();body.scrollTop=scroll;$('suiteClock').textContent=new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});const d=J.state.raw||{};$('suiteSource').textContent=String(d.referenceSource||'No price feed');}
function handleClick(e){const b=e.target.closest('[data-suite-act], [data-suite-mode], [data-suite-refresh], [data-suite-unwatch], [data-suite-preset], [data-suite-load], [data-suite-delete]');if(!b)return;
 if(b.dataset.suiteAct){action(b.dataset.suiteAct);return;}
 if(b.dataset.suiteMode){S.mode=b.dataset.suiteMode;set('mode',S.mode);render();J.requestDraw();return;}
 if(b.hasAttribute('data-suite-refresh')){refreshFootprint(true);return;}
 if(b.dataset.suiteUnwatch){S.watch=S.watch.filter(x=>String(x.id)!==b.dataset.suiteUnwatch);set('watch',S.watch);render();return;}
 if(b.dataset.suitePreset){preset(b.dataset.suitePreset);return;}
 if(b.dataset.suiteLoad!==undefined){const x=S.workspaces[+b.dataset.suiteLoad];if(x?.config){applySnap(x.config);show('Saved layout restored');}return;}
 if(b.dataset.suiteDelete!==undefined){S.workspaces.splice(+b.dataset.suiteDelete,1);set('workspaces',S.workspaces);render();return;}
}
function change(e){if(e.target.id==='suiteBucket'){S.bucket=Number(e.target.value);set('bucket',S.bucket);S.selected=0;S.fp=null;S.fpTf='';render();refreshFootprint(true);}else if(e.target.id==='suiteCandle'){S.selected=+e.target.value;render();}else if(e.target.hasAttribute('data-suite-footon')){S.footOn=e.target.checked;set('footOn',S.footOn);if(S.footOn)refreshFootprint(true);J.requestDraw();render();}}
function submit(e){if(!['suiteWatchForm','suiteSaveForm'].includes(e.target.id))return;e.preventDefault();
 if(e.target.id==='suiteWatchForm'){const value=Number($('suiteWatchPrice').value);if(!Number.isFinite(value)||value<=0)return;S.watch.push({id:Date.now(),value,triggered:false});S.watch=S.watch.slice(-20);set('watch',S.watch);show('Price watch added');render();return;}
 const name=$('suiteWorkspaceName').value.trim().slice(0,40);if(!name)return;S.workspaces.push({name,config:snapshot()});S.workspaces=S.workspaces.slice(-8);set('workspaces',S.workspaces);show('Layout saved locally');render();}
function checkWatch(){const p=J.state.raw?.referencePrice,ms=J.state.raw?.engineUpdatedMs;if(!finite(p)||p<=0||!finite(ms)||!ms||Date.now()-ms>6000){S.lastPrice=null;return;}
 if(S.lastPrice!==null){let changed=false;for(const w of S.watch){if(w.triggered)continue;const crossed=(S.lastPrice<w.value&&p>=w.value)||(S.lastPrice>w.value&&p<=w.value);if(crossed){w.triggered=true;show('Price crossed '+fmt(w.value)+' USD');changed=true;}}if(changed){set('watch',S.watch);if(S.tab==='levels')render();}}
 S.lastPrice=p;}
async function refreshFootprint(force){if(S.loading)return;if(!force&&!(S.footOn||(S.open&&S.tab==='footprint')))return;
 if(!force&&Date.now()-S.fpFetched<12000&&S.fpTf===J.state.tf)return;
 S.loading=true;try{const tf=J.state.tf,range=Math.min(10080,Math.max(240,Math.ceil(J.TF[tf]/60*120)));const ctl=new AbortController(),bars=J.state.candles.slice(-220).map(c=>Math.trunc(c.time)).join(','),url=`/api/footprint?tf=${encodeURIComponent(tf)}&minutes=${range}&bucket=${S.bucket}${bars?'&bars='+encodeURIComponent(bars):''}`;const r=await fetch(url,{cache:'no-store',signal:ctl.signal});if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();if(!d.ok||!Array.isArray(d.rows))throw new Error('Invalid footprint response');if(J.state.tf===tf){S.fp=d;S.fpTf=tf;S.fpFetched=Date.now();S.selected=0;J.requestDraw();if(S.tab==='footprint')render();}}
 catch(err){S.fp=null;S.fpTf='';S.fpMap=null;S.fpMapSource=null;J.requestDraw();if(S.tab==='footprint'){render();show('Footprint not available: '+String(err.message||err));}}finally{S.loading=false;}}
function draw(ctx,w,h){if(!S.footOn||J.state.fallback||!S.fp?.rows?.length||S.fpTf!==J.state.tf)return;
 const m=fpBuckets();const scale=J.chart.timeScale(),vis=scale.getVisibleLogicalRange();if(!vis)return;
 const visible=Math.max(1,vis.to-vis.from),N=J.state.candles.length;if(!N)return;
 const full=visible<=72;ctx.save();ctx.beginPath();ctx.rect(0,0,w,h);ctx.clip();
 const width=Math.max(8,Math.min(52,w/visible*.82));
 const C=J.state.candles;for(let i=Math.max(0,Math.floor(vis.from)-2);i<Math.min(N,Math.ceil(vis.to)+3);i++){
   const rows=m.get(C[i].time*1000);if(!rows?.length)continue;
   const x=J.lx(i),poc=rows.reduce((a,r)=>!a||r.total>a.total?r:a,null),y=J.yOf(poc.price);if(x==null)continue;
   if(y!=null&&y>=0&&y<h){ctx.fillStyle='#f8c95a';ctx.beginPath();ctx.arc(x,y,2.8,0,Math.PI*2);ctx.fill();}
   if(!full||width<14)continue;
   const peak=Math.max(1,...rows.map(r=>r.total));
   for(const r of rows){const y0=J.yOf(r.price),y1=J.yOf(r.price+S.bucket);if(y0==null||y1==null||y0<0||y0>h)continue;const rh=y0-y1;if(rh<5)continue;const hi=Math.min(18,Math.max(3,rh-1)),top=y0-hi/2;
     if(S.mode==='classic'){ctx.fillStyle='rgba(250,91,111,.56)';ctx.fillRect(x-width/2,top,width*.48*(r.sell/peak),hi);ctx.fillStyle='rgba(61,226,193,.56)';ctx.fillRect(x+1,top,width*.48*(r.buy/peak),hi);}
     else if(S.mode==='delta'){ctx.fillStyle=r.delta>=0?'rgba(61,226,193,.55)':'rgba(250,91,111,.55)';ctx.fillRect(x-width*.45,top,width*.9*Math.abs(r.delta)/peak,hi);}
     else {ctx.fillStyle='rgba(117,155,255,.46)';ctx.fillRect(x-width*.46,top,width*.92*r.total/peak,hi);}
   }
 }
 ctx.restore();}
function boot(){ $('suiteToggle').onclick=()=>open(!S.open);$('suiteClose').onclick=()=>open(false);document.querySelector('.suite-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-suite-tab]');if(b)tab(b.dataset.suiteTab);});$('suiteBody').addEventListener('click',handleClick);$('suiteBody').addEventListener('change',change);$('suiteBody').addEventListener('submit',submit);
 J.hooks.draw.push(draw);J.hooks.candles.push(full=>{if(full&&S.footOn)refreshFootprint(true);});window.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.open&&!(document.activeElement?.closest('.modal')||document.activeElement?.closest('.ind-pop'))){open(false);return;}if(e.ctrlKey&&e.key.toLowerCase()==='k'){e.preventDefault();open(!S.open);}if(!e.ctrlKey&&!e.altKey&&!e.metaKey&&['1','2','3'].includes(e.key)&&S.open&&S.tab==='footprint'&&!/^(input|textarea|select)$/i.test(document.activeElement?.tagName||'')){S.mode={1:'classic',2:'delta',3:'volume'}[e.key];set('mode',S.mode);render();J.requestDraw();}});
 open(S.open);if(S.footOn)refreshFootprint(true);setInterval(()=>{checkWatch();if(S.open&&(S.tab==='overview'||S.tab==='depth'||(S.tab==='levels'&&!$('suiteBody').contains(document.activeElement))))render();if((S.open&&S.tab==='footprint')||S.footOn)refreshFootprint(false);},14000);setInterval(checkWatch,1000);
}
J.studio={boot,open,tab,refreshFootprint,snapshot,applySnap,state:S};
})();
