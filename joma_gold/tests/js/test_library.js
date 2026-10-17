const assert = require('assert');
const path = require('path');
const TA = require('../../frontend/js/indicators/ta.js');
const kit = require('../../frontend/js/indicators/kit.js');
const defs = new Map();
globalThis.JG = { ta: TA, kit, registerIndicator: d => { if (defs.has(d.id)) throw new Error('duplicate id ' + d.id); defs.set(d.id, Object.assign({ group: 'Custom', kind: 'overlay', inputs: [] }, d)); } };
globalThis.window = globalThis;
const dir = '../../frontend/js/indicators/';
require(dir + 'lib_trend.js');
require(dir + 'lib_momentum.js');
require(dir + 'lib_volume.js');
const struct = require(dir + 'lib_structure.js');
require(dir + 'lib_studio.js');
const research = require(dir + 'lib_research11.js');
const vol = require(dir + 'lib_volume.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

const T0 = 1_767_571_200, TF = 900;
const bar = (i, o, h, l, c, v = 100) => ({ time: T0 + i * TF, open: o, high: h, low: l, close: c, volume: v });
function walk(n, seed = 5) { let s = seed, price = 4100; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, out = []; for (let i = 0; i < n; i++) { const o = price; price += (rnd() - .5) * 3; out.push(bar(i, o, Math.max(o, price) + rnd() * 1.2, Math.min(o, price) - rnd() * 1.2, price, 50 + Math.floor(rnd() * 400))); } return out; }
function path_(points, per, rng = 0.5, start = 0) { const out = []; let i = start, prev = points[0]; for (const target of points.slice(1)) { for (let s = 1; s <= per; s++) { const c = prev + (target - prev) * s / per, o = out.length ? out[out.length - 1].close : prev; out.push(bar(i++, o, Math.max(o, c) + rng, Math.min(o, c) - rng, c)); } prev = target; } return out; }

t('the library registers a healthy catalogue with unique ids and complete definitions', () => {
  assert.ok(defs.size >= 31, 'only ' + defs.size);
  for (const d of defs.values()) {
    assert.ok(d.name && d.desc && d.group && typeof d.calc === 'function', d.id);
    for (const i of d.inputs) { assert.ok(i.k && i.l && i.t && i.d !== undefined, d.id + '.' + i.k); if (i.t === 'int' || i.t === 'float') assert.ok(i.d >= i.min && i.d <= i.max, `${d.id}.${i.k} default outside range`); if (i.t === 'select') assert.ok(i.opts.includes(i.d), `${d.id}.${i.k}`); }
    if (d.kind === 'canvas') assert.strictEqual(typeof d.draw, 'function', d.id);
  }
});
t('every indicator computes on 600 candles with its default inputs, array lengths aligned, no NaN leaks', () => {
  const C = walk(600);
  for (const d of defs.values()) {
    const p = Object.fromEntries(d.inputs.map(i => [i.k, i.d])), r = d.calc(C, p, globalThis.JG); assert.ok(r && typeof r === 'object', d.id);
    for (const l of [...(r.lines || []), ...(r.hist || [])]) { assert.ok(l.data.length >= C.length, d.id + ' short'); assert.ok(l.data.every(v => v === null || Number.isFinite(v)), d.id + ' has NaN/Infinity'); }
    if (d.kind === 'pane') assert.ok((r.lines || []).length + (r.hist || []).length > 0, d.id);
  }
});
t('no look-ahead: indicator values at bar i are identical when later bars are removed', () => {
  const C = walk(500, 11), cut = 380;
  for (const id of ['sma', 'ema', 'bollinger', 'keltner', 'supertrend', 'psar', 'rsi', 'macd', 'stoch', 'cci', 'atr', 'adx', 'obv', 'vwap', 'donchian', 'joma-regime']) {
    const d = defs.get(id), p = Object.fromEntries(d.inputs.map(i => [i.k, i.d])), a = d.calc(C, p), b = d.calc(C.slice(0, cut), p), A = [...(a.lines || []), ...(a.hist || [])], B = [...(b.lines || []), ...(b.hist || [])];
    A.forEach((l, k) => { for (let i = 0; i < cut; i++) { const x = l.data[i], y = B[k].data[i]; assert.ok((x === null && y === null) || Math.abs(x - y) < 1e-9, `${id}[${k}] differs at ${i}`); } });
  }
});
t('Bollinger bands bracket the basis symmetrically; Donchian equals the rolling extremes', () => {
  const C = walk(120), d = defs.get('bollinger'), r = d.calc(C, { len: 20, mult: 2, src: 'close', color: '#4aa3ff' }), [u, m, l] = r.lines.map(x => x.data);
  for (let i = 30; i < 120; i++) { close(u[i] - m[i], m[i] - l[i], 1e-9); assert.ok(u[i] > l[i]); }
  const dc = defs.get('donchian').calc(C, { len: 10, color: '#35e8c4' }).lines[0].data; close(dc[50], Math.max(...C.slice(41, 51).map(b => b.high)), 1e-9);
});
t('Ichimoku: tenkan is the 9-bar midpoint, the cloud is projected forward by the displacement', () => {
  const C = walk(200), r = defs.get('ichimoku').calc(C, { t: 9, k: 26, b: 52, shift: 26, up: '#35e8c4', dn: '#ff5f78' }), tk = r.lines[0].data;
  close(tk[100], (Math.max(...C.slice(92, 101).map(b => b.high)) + Math.min(...C.slice(92, 101).map(b => b.low))) / 2, 1e-9);
  const sa = r.lines[3].data; assert.strictEqual(sa.length, 226); assert.ok(sa[225] !== null && sa[225] !== undefined); assert.strictEqual(sa[10], null);
});
t('VWAP lines alternate by day so consecutive days are never joined', () => {
  const C = []; for (let i = 0; i < 250; i++) C.push(bar(i, 100, 101, 99, 100)); const r = defs.get('vwap').calc(C, { mult: 1, bands: false, color: '#e8b04a' }), [even, odd] = r.lines.map(l => l.data);
  for (let i = 0; i < 250; i++) assert.ok((even[i] === null) !== (odd[i] === null));
});
t('volume profile finds the high-volume row as POC and a value area that holds the requested share', () => {
  const C = []; for (let i = 0; i < 40; i++) C.push(bar(i, 100, 101, 99, 100.2, 10)); for (let i = 40; i < 60; i++) C.push(bar(i, 105, 105.4, 104.6, 105.1, 500));
  const pr = vol.profile(C, 0, 59, 40, 70); assert.ok(pr); const pocPrice = pr.lo + (pr.poc + .5) * pr.step; assert.ok(Math.abs(pocPrice - 105) < 0.5, 'POC ' + pocPrice);
  const total = pr.vol.reduce((a, b) => a + b, 0); let va = 0; for (let r = pr.va[0]; r <= pr.va[1]; r++) va += pr.vol[r]; assert.ok(va / total >= 0.7 - 1e-9);
});

const S = struct;
t('structure: BOS in trend, CHoCH against it, each swing level broken only once', () => {
  const pre = []; for (let i = 0; i < 40; i++) pre.push(bar(i, 100, 100.5, 99.5, 100));
  const up = path_([100, 106, 103, 109, 106.2, 108.5], 8, 0.5, 40); const C = pre.concat(up); C.push(bar(C.length, 108.5, 111.2, 108.4, 110.9));
  const r = S.analyse(C, 3, 0.5), last = r.events[r.events.length - 1]; assert.ok(last, 'no event'); assert.strictEqual(last.dir, 'UP'); assert.strictEqual(last.kind, 'BOS'); assert.strictEqual(last.i, C.length - 1);
  const seen = new Set(); for (const e of r.events) { const k = e.dir + e.pi; assert.ok(!seen.has(k), 'level broken twice'); seen.add(k); }
  const dn = []; for (let i = 0; i < 40; i++) dn.push(bar(i, 100, 100.5, 99.5, 100)); const D = dn.concat(path_([112, 106, 109, 103, 106, 106.5], 8, 0.5, 40)); D.push(bar(D.length, 106.5, 110.9, 106.4, 110.6));
  const r2 = S.analyse(D, 3, 0.5), e2 = r2.events[r2.events.length - 1]; assert.ok(e2 && e2.kind === 'CHoCH' && e2.dir === 'UP', JSON.stringify(e2));
});
t('structure is causal: events found on the first n bars are exactly the full-history events with i < n', () => {
  const C = walk(700, 21), full = S.analyse(C, 3, 0.6); for (const cut of [300, 450, 620]) { const part = S.analyse(C.slice(0, cut), 3, 0.6); const f = full.events.filter(e => e.i < cut); assert.deepStrictEqual(part.events.map(e => [e.kind, e.dir, e.pi, e.i]), f.map(e => [e.kind, e.dir, e.pi, e.i])); assert.deepStrictEqual(part.sweeps.map(s => [s.dir, s.pi, s.i]), full.sweeps.filter(s => s.i < cut).map(s => [s.dir, s.pi, s.i])); }
});
t('liquidity sweep: wick through a swing high that closes back inside', () => {
  const C = []; for (let i = 0; i < 80; i++) C.push(bar(i, 102, 102.5, 101.5, 102)); C[20] = bar(20, 102, 105, 103.5, 104); C[30] = bar(30, 102, 102.5, 98, 99); C.push(bar(80, 102, 105.5, 102, 104.6));
  const r = S.analyse(C, 3, 0.5), s = r.sweeps[r.sweeps.length - 1]; assert.ok(s && s.dir === 'DOWN' && Math.abs(s.level - 105) < 1e-9 && s.i === 80);
});
t('order block = last opposite candle before the breaking displacement; unmitigated until price trades back into it', () => {
  const pre = []; for (let i = 0; i < 40; i++) pre.push(bar(i, 100, 100.5, 99.5, 100)); const C = pre.concat(path_([100, 106, 103, 109, 106.2, 108.5], 8, 0.5, 40)); C.push(bar(C.length, 108.5, 111.2, 108.4, 110.9));
  const r = S.analyse(C, 3, 0.5), obs = S.orderBlocks ? S.orderBlocks(C, r, 0.6) : []; const ob = obs[obs.length - 1]; assert.ok(ob, 'no OB'); assert.strictEqual(ob.dir, 'UP'); assert.ok(C[ob.i].close < C[ob.i].open, 'OB candle must be bearish'); assert.strictEqual(ob.mit, -1);
  const C2 = C.concat([bar(C.length, 110.9, 111, C[ob.i].high - 0.1, 109)]); const ob2 = S.orderBlocks(C2, S.analyse(C2, 3, 0.5), 0.6).find(o => o.i === ob.i); assert.ok(ob2 && ob2.mit === C2.length - 1, 'should be mitigated by the last bar');
});
t('fair value gap: found, shrinks as price re-enters, closes when fully traded through', () => {
  const up = i => bar(i, 103, 103.6, 102.6, 103.1), C = []; for (let i = 0; i < 60; i++) C.push(i < 29 ? bar(i, 100, 100.6, 99.6, 100.1) : up(i));
  C[29] = bar(29, 100, 100.6, 99.6, 100.1); C[30] = bar(30, 100, 102.5, 100, 102.2); C[31] = bar(31, 102.2, 103, 101.9, 102.8);
  let g = S.gaps(C, 0.1).find(x => x.i === 30); assert.ok(g && g.dir === 'UP' && g.filled < 0, JSON.stringify(g)); const topBefore = g.top, bottom = g.bottom;
  const C2 = C.slice(); C2[40] = bar(40, 103, 103.1, 101.2, 102); g = S.gaps(C2, 0.1).find(x => x.i === 30); assert.ok(g.top < topBefore && g.top > bottom && g.filled < 0, 'partial fill should shrink the gap');
  const C3 = C.slice(); C3[40] = bar(40, 101, 101.2, 99.0, 99.5); g = S.gaps(C3, 0.1).find(x => x.i === 30); assert.strictEqual(g.filled, 40);
});
t('previous day/week levels use the right sessions', () => {
  const day = d => d * 86400, base = Math.floor(T0 / 86400) - 8, C = []; for (let d = base; d < base + 8; d++) for (let h = 0; h < 24; h += 4) C.push({ time: day(d) + h * 3600, open: 100 + d - base, high: 110 + d - base, low: 90 + d - base, close: 101 + d - base, volume: 1 });
  const r = defs.get('prevlevels').calc(C, {}), by = Object.fromEntries(r.items.map(x => [x.label, x.price])); assert.strictEqual(by.PDH, 110 + 6); assert.strictEqual(by.PDL, 90 + 6); assert.strictEqual(by.DO, 100 + 7);
});

t('research catalogue registers all independent studies with valid data contracts', () => {
  for (const id of ['joma-pulse-lab','joma-saga-lab','joma-binary-lines-lab','joma-umbrella-lab','joma-binlex-lab','joma-aurora-lab','joma-breakout-lab']) {
    assert.ok(defs.has(id), id);
    const d=defs.get(id); assert.ok(/independent|not |estimate|research/i.test(d.desc), 'provenance warning missing: '+id);
  }
});
t('Pulse columns have volume totals, non-negative finite bins, and correct historical candle index', () => {
  const C=walk(200, 27), p={columns:40,window:35,rows:26}, arr=research.pulseColumns(C,p);
  assert.ok(arr.length>=35); for(const c of arr){assert.ok(c.max>0&&c.i<C.length);assert.strictEqual(c.vol.length,26);assert.ok(c.vol.every(v=>Number.isFinite(v)&&v>=0));
    const expected=C.slice(Math.max(0,c.i-p.window+1),c.i+1).reduce((t,b)=>t+b.volume,0);
    const actual=c.vol.reduce((a,b)=>a+b,0);close(expected,actual,1e-8);
  }
});
t('Pulse older columns are unchanged when adding later candles (no look ahead)', () => {
  const C=walk(150, 49),p={columns:50,window:35,rows:20};
  const a=research.pulseColumns(C,p),b=research.pulseColumns(C.slice(0,120),p);
  for(const c of a.filter(c=>c.i>=70&&c.i<120)){
    const prev=b.find(x=>x.i===c.i);assert.ok(prev,'column missing');
    close(c.lo,prev.lo); close(c.step,prev.step);
    c.vol.forEach((v,j)=>close(v,prev.vol[j],1e-8));
  }
});
t('Binary line research only uses confirmed pivots and has no future crossing events', () => {
  const C=walk(330, 12),p={pivot:5,tolerance:1},full=research.pivotLines(C,p);
  for(let cut of [160,220,300]){
    const part=research.pivotLines(C.slice(0,cut),p);
    for(let i=0;i<cut;i++){assert.strictEqual(part.upper[i],full.upper[i]);assert.strictEqual(part.lower[i],full.lower[i]);}
    assert.deepStrictEqual(part.events, full.events.filter(e=>e.i<cut-1));
  }
});
t('Breakout research avoids future highs; holds last unclosed bar and confirms volume', () => {
  const C=[];for(let i=0;i<40;i++)C.push(bar(i,100,101,99,100,100));
  C.push(bar(40,100,105,100,104,250));
  const p={length:20,vol:1.1,retest:10};
  const pending=research.breakoutStudy(C,p);
  assert.ok(!pending.events.some(e=>e.i===40),'unclosed candle signal');
  const completed=research.breakoutStudy(C.concat(bar(41,104,104.5,102.5,103,100)),p);
  const br=completed.events.find(e=>e.i===40);
  assert.ok(br&&br.dir===1);close(br.price,101);
  const invalid=C.slice();invalid[40]={...invalid[40],volume:50};
  const no=research.breakoutStudy(invalid.concat(C[40]),p);
  assert.ok(!no.events.some(e=>e.i===40),'low-volume false positive');
});

console.log(`\n${n} library tests passed (${defs.size} indicators registered)`);
