(() => {
'use strict';
const $ = id => document.getElementById(id);
const escHtml = value => String(value ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const TF = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const PB = { '1m': 0.5, '5m': 1, '15m': 2, '30m': 3, '1h': 5, '4h': 10, '1d': 20 };   // trade-print price bucket per timeframe
const HEAT_S = 6;                                                                       // heat sub-columns per candle
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('jg15_' + k); return v == null ? d : v; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('jg15_' + k, String(v)); } catch { /* private mode */ } },
};
const L = k => store.get('L_' + k, '1') === '1';
const state = {
  tf: TF[store.get('tf', '15m')] ? store.get('tf', '15m') : '15m', raw: null, candles: [], component: 'mid', fallback: false,
  heatOn: L('heatOn'), wallsOn: L('wallsOn'), bubOn: L('bubOn'), flowOn: L('flowOn'), oandaOn: store.get('L_oandaOn', '0') === '1',
  replay: false, replayItems: [], replayIndex: 0,
  heat: null, heatImg: null, heatDirty: false, heatMaxMode: store.get('heatMax', 'auto'), heatMaxAuto: null,
  books: [], bookKind: store.get('bookKind', 'order'), bookImg: null, bookDirty: false, bookInfo: null,
  flow: { bubbles: [], cvd: [] }, delta: [], hits: [], wallHits: [], sel: null,
  bmin: +store.get('bmin', 150000), bref: +store.get('bref', 5000000), soft: +store.get('soft', 1), psize: +store.get('psize', 100),
  pos: null, armed: null, px: null, tool: null, drag: null, measure: null,
  book: null, profile: null, flowReady: false, heatSpanMin: 0, lastStrip: 0,
};

// ---------------------------------------------------------------- chart (pane 0 = price, pane 1 = delta/CVD)
const hooks = { candles: [], draw: [], layer: [] };
const fire = (list, ...a) => { for (const f of list) { try { f(...a); } catch (e) { console.error('indicator hook', e); } } };
const chart = LightweightCharts.createChart($('chart'), {
  layout: { background: { type: 'solid', color: 'rgba(0,0,0,0)' }, textColor: '#8a97a6', fontSize: 11, attributionLogo: false, panes: { separatorColor: '#1b2431', separatorHoverColor: '#2a3a52' } },
  grid: { vertLines: { color: 'rgba(255,255,255,.02)' }, horzLines: { color: 'rgba(255,255,255,.03)' } },
  rightPriceScale: { borderColor: '#18202b', scaleMargins: { top: .08, bottom: .08 } },
  timeScale: { borderColor: '#18202b', timeVisible: true, secondsVisible: false, rightOffset: 14, barSpacing: 8, minBarSpacing: 2 },
  crosshair: { mode: 0, vertLine: { color: '#344153', width: 1, style: 3, labelBackgroundColor: '#1a2431' }, horzLine: { color: '#344153', width: 1, style: 3, labelBackgroundColor: '#1a2431' } },
  handleScroll: true, handleScale: true,
});
const candles = chart.addSeries(LightweightCharts.CandlestickSeries, {
  upColor: '#35e8c4', downColor: '#ff5f78', borderVisible: false, wickUpColor: '#35e8c4', wickDownColor: '#ff5f78',
  priceLineVisible: true, lastValueVisible: true, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
});

const money = v => { if (v === null || v === undefined || v === '' || !Number.isFinite(+v)) return '—'; v = +v; const s = v < 0 ? '−' : '', a = Math.abs(v); if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M'; if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K'; return s + '$' + a.toFixed(0); };
const fmt = (v, d = 2) => v !== null && v !== undefined && v !== '' && Number.isFinite(+v) ? Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const pctf = v => v !== null && v !== undefined && v !== '' && Number.isFinite(+v) ? Math.round(+v * 100) + '%' : '—';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hhmm = ms => new Date(ms).toISOString().slice(11, 16) + 'Z';
const dur = s => { s = Math.round(s); if (s < 90) return s + ' s'; const m = s / 60; if (m < 90) return Math.round(m) + ' min'; const h = m / 60; return h < 48 ? h.toFixed(1) + ' h' : (h / 24).toFixed(1) + ' d'; };

// ---------------------------------------------------------------- coordinates (market gaps safe)
function lx(l) {                        // lightweight-charts 5.x returns 0 for fractional logical indexes → interpolate between bars
  const ts = chart.timeScale(), a = Math.floor(l), c0 = ts.logicalToCoordinate(a), c1 = ts.logicalToCoordinate(a + 1);
  return c0 == null || c1 == null ? null : c0 + (l - a) * (c1 - c0);
}
function logicalOfSec(t) {              // unix seconds → fractional candle index (integer = candle start); gaps snap to the next bar
  const c = state.candles, n = c.length; if (!n) return null; const tf = TF[state.tf];
  if (t >= c[n - 1].time) return n - 1 + (t - c[n - 1].time) / tf;
  if (t < c[0].time) return (t - c[0].time) / tf;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid].time <= t) lo = mid; else hi = mid - 1; }
  const f = (t - c[lo].time) / tf; return f >= 1 ? lo + 1 : lo + f;
}
function secOfX(x) {                    // pixel → unix seconds (inverse of xOfSec)
  const l = chart.timeScale().coordinateToLogical(x), c = state.candles, n = c.length; if (l == null || !n) return null;
  const p = l + 0.5, tf = TF[state.tf];
  if (p >= n) return c[n - 1].time + (p - (n - 1)) * tf; if (p < 0) return c[0].time + p * tf;
  const i = Math.floor(p); return c[i].time + (p - i) * tf;
}
const xOfSec = t => { const l = logicalOfSec(t); return l == null ? null : lx(l - 0.5); };
const yOf = p => candles.priceToCoordinate(p);
const spanMinutes = () => state.candles.length ? clamp(Math.ceil((Date.now() / 1000 - state.candles[0].time) / 60) + 5, 5, 4320) : 120;

// ---------------------------------------------------------------- candles
function showNotice(text) { const el = $('notice'); el.textContent = text || ''; el.classList.toggle('hidden', !text); }
function applySpacing() { const w = $('chartShell').clientWidth, bs = clamp((w - 70) / 130, 3.5, 10); chart.timeScale().applyOptions({ barSpacing: bs, rightOffset: Math.ceil((profileW(w) + 28) / bs) }); }
async function loadCandles(fit) {
  try {
    const r = await fetch(`/api/candles?tf=${state.tf}&limit=900`, { cache: 'no-store' });
    if (!r.ok) throw new Error((await r.text()).slice(0, 180));
    const d = await r.json();
    state.candles = (d.candles || []).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
    state.component = d.component || 'mid'; state.fallback = !!d.fallback;
    candles.setData(state.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    showNotice(d.fallback ? `CANDLES FROM ${d.source} · not your broker's price` : '');
    if (fit) { applySpacing(); chart.timeScale().scrollToRealTime(); }
    state.heatDirty = state.bookDirty = true; applyDelta(); fire(hooks.candles, true); requestDraw();
  } catch (e) { showNotice('No candle source: ' + String(e.message || e).slice(0, 160)); }
}
function updateLiveCandle(d) {          // merge the broker tick into the forming candle; never invent bars while the price is static
  const last = state.candles[state.candles.length - 1]; if (!last || state.fallback || state.replay) return;
  const ref = String(d.referenceSource || ''), s = d.sources && (ref.startsWith('OANDA') ? d.sources.OANDA : ref.startsWith('MT5') ? d.sources.MT5_DOM : null);
  if (!s) return;
  const p = state.component === 'bid' ? s.bestBid : state.component === 'ask' ? s.bestAsk : s.mid; if (!Number.isFinite(p)) return;
  const tf = TF[state.tf], nowS = Math.floor(Date.now() / 1000);
  if (state.tf !== '1d' && nowS >= last.time + tf) {
    if (Math.abs(p - last.close) < 1e-9) return;
    const nc = { time: last.time + tf * Math.floor((nowS - last.time) / tf), open: p, high: p, low: p, close: p, volume: 0 };
    state.candles.push(nc); candles.update({ time: nc.time, open: nc.open, high: nc.high, low: nc.low, close: nc.close }); applyDelta(); fire(hooks.candles, true);
  } else {
    last.close = p; last.high = Math.max(last.high, p); last.low = Math.min(last.low, p);
    candles.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close }); fire(hooks.candles, false);
  }
  requestDraw();
}

// ---------------------------------------------------------------- colour ramps / raster helpers
const RAMP_HEAT = [[0, 30, 40, 120, 0], [.10, 40, 60, 160, .16], [.35, 92, 72, 200, .36], [.62, 196, 76, 172, .52], [.85, 250, 150, 76, .64], [1, 255, 226, 128, .78]];   // [t, r, g, b, alpha]
const RAMP_BOOK = [[0, 24, 10, 52, 0], [.35, 78, 34, 150, .22], [.65, 205, 70, 176, .40], [1, 255, 214, 240, .58]];
function rampA(stops, t) {
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const a = stops[i - 1], b = stops[i], k = (t - a[0]) / (b[0] - a[0]); return [1, 2, 3, 4].map(j => a[j] + (b[j] - a[j]) * k); }
  return stops[stops.length - 1].slice(1);
}
const cssGradient = stops => 'linear-gradient(90deg,' + stops.map(x => `rgba(${x[1]},${x[2]},${x[3]},${Math.max(.25, x[4])}) ${Math.round(x[0] * 100)}%`).join(',') + ')';
function percentile(arr, q) {
  const v = []; const stride = Math.max(1, Math.floor(arr.length / 30000));
  for (let i = 0; i < arr.length; i += stride) if (arr[i] > 0) v.push(arr[i]);
  if (!v.length) return 0; v.sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(v.length * q))] || 0;
}
function niceMax(v) { if (!(v > 0)) return 1000; const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
function boxBlur(T, W, R, rad) {
  if (rad <= 0) return T; const K = rad * 2 + 1, tmp = new Float32Array(T.length);
  for (let c = 0; c < W; c++) for (let r = 0; r < R; r++) { let a = 0; for (let k = -rad; k <= rad; k++) a += T[Math.min(W - 1, Math.max(0, c + k)) * R + r]; tmp[c * R + r] = a / K; }
  for (let c = 0; c < W; c++) for (let r = 0; r < R; r++) { let a = 0; for (let k = -rad; k <= rad; k++) a += tmp[c * R + Math.min(R - 1, Math.max(0, r + k))]; T[c * R + r] = a / K; }
  return T;
}
function gridAxis(B) {
  const cd = state.candles; let lo = Infinity, hi = -Infinity; for (const k of cd) { if (k.low < lo) lo = k.low; if (k.high > hi) hi = k.high; }
  const margin = (hi - lo) * 0.2 + B * 4; lo -= margin; hi += margin;
  const rb = Math.max(B, (hi - lo) / 130), base = Math.floor(lo / rb) * rb;
  return { rb, base, R: Math.ceil((hi - base) / rb) + 1 };
}
function toImage(T, W, R, stops, floor) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = R; const cx = cv.getContext('2d'), img = cx.createImageData(W, R), px = img.data;
  for (let c = 0; c < W; c++) for (let r = 0; r < R; r++) {
    const t = T[c * R + r]; if (t < floor) continue;
    const [rr, gg, bb, aa] = rampA(stops, Math.min(1, t)), o = ((R - 1 - r) * W + c) * 4;
    px[o] = rr; px[o + 1] = gg; px[o + 2] = bb; px[o + 3] = Math.round(aa * 255);
  }
  cx.putImageData(img, 0, 0); return cv;
}
const heatMaxK = () => state.heatMaxMode === 'auto' ? (state.heatMaxAuto || 2000) : +state.heatMaxMode;   // k$ per base bucket

// ---------------------------------------------------------------- resting liquidity (recorded books) — fixed $ scale
async function loadHeat(full) {
  if (!state.candles.length) return;
  const step = Math.max(4, Math.round(TF[state.tf] / HEAT_S));
  let url = `/api/heat?minutes=${spanMinutes()}&step=${step}`;
  const incremental = !full && state.heat && state.heat.bins.size;
  if (incremental) url += `&after=${Math.max(...state.heat.bins.keys())}`;
  try {
    const d = await (await fetch(url, { cache: 'no-store' })).json(); if (!d.ok) return;
    if (!incremental || !state.heat || state.heat.step !== d.stepMs || state.heat.tf !== state.tf) state.heat = { bucket: d.bucket, step: d.stepMs, tf: state.tf, bins: new Map() };
    for (const b of d.bins) state.heat.bins.set(b.t, b.cells);
    state.heat.bucket = d.bucket; state.heatDirty = true; requestDraw();
  } catch (e) { /* server restarting */ }
}
function rebuildHeat() {
  state.heatDirty = false; const h = state.heat, cd = state.candles, N = cd.length, S = HEAT_S;
  const keys = h ? [...h.bins.keys()] : []; state.heatSpanMin = keys.length ? (Math.max(...keys) - Math.min(...keys) + (h ? h.step : 0)) / 60000 : 0;
  if (!h || !N || !h.bins.size || state.heatSpanMin < Math.max(10, 3 * TF[state.tf] / 60)) { state.heatImg = null; renderStrip(); return; }
  const B = h.bucket, { rb, base, R } = gridAxis(B), W = N * S, A = new Float32Array(W * R), scale = B / rb;
  for (const [t, cells] of h.bins) {
    const p = logicalOfSec(t / 1000 + h.step / 2000); if (p == null || p < 0 || p >= N) continue;
    const col = Math.min(W - 1, Math.floor(p * S)), rows = new Map();
    for (const [idx, k] of cells) { const r = Math.floor((idx * B - base) / rb); if (r >= 0 && r < R) rows.set(r, (rows.get(r) || 0) + k * scale); }
    for (const [r, v] of rows) { const i = col * R + r; if (v > A[i]) A[i] = v; }
  }
  let lastFilled = -99, lastReal = -1;                       // carry a recorded column forward ≤ 3 sub-columns, never past the last real record
  for (let c = W - 1; c >= 0 && lastReal < 0; c--) for (let r = 0; r < R; r++) if (A[c * R + r] > 0) { lastReal = c; break; }
  for (let c = 0; c <= lastReal; c++) {
    let any = false; for (let r = 0; r < R; r++) if (A[c * R + r] > 0) { any = true; break; }
    if (any) lastFilled = c; else if (c - lastFilled <= 3) A.copyWithin(c * R, lastFilled * R, lastFilled * R + R);
  }
  if (state.heatMaxAuto == null) { const p = percentile(A, 0.985); if (p > 0) state.heatMaxAuto = niceMax(p); }   // calibrated ONCE, then frozen
  const mx = heatMaxK(), T = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) T[i] = A[i] > 0 ? Math.min(1, Math.sqrt(A[i] / mx)) : 0;     // sqrt scale; legend shows the exact $ ticks
  boxBlur(T, W, R, state.soft);
  state.heatImg = { cv: toImage(T, W, R, RAMP_HEAT, 0.06), N, base, rb, R }; renderStrip();
}
function heatAt(tSec, price) {          // recorded resting liquidity at one time × price (k$), or null when nothing was recorded there
  const h = state.heat; if (!h) return null; const key = Math.floor(tSec * 1000 / h.step) * h.step, cells = h.bins.get(key); if (!cells) return null;
  const idx = Math.round(price / h.bucket); let best = null; for (const c of cells) if (Math.abs(c[0] - idx) <= 0) best = c; return best || { k: 0, none: true };
}

// ---------------------------------------------------------------- OANDA client orders / positions layer
async function loadBooks() {
  try {
    const d = await (await fetch(`/api/oanda/books?kind=${state.bookKind}&minutes=${spanMinutes() + 60}`, { cache: 'no-store' })).json();
    state.books = d.snapshots || []; state.bookInfo = d; state.bookDirty = true; renderStrip(); requestDraw();
  } catch (e) { /* ignore */ }
}
function rebuildBooks() {
  state.bookDirty = false; const cd = state.candles, N = cd.length, snaps = state.books;
  if (!N || !snaps.length) { state.bookImg = null; return; }
  const B = Math.max(0.1, snaps[snaps.length - 1].width || 0.5), { rb, base, R } = gridAxis(B), S = HEAT_S, W = N * S, tf = TF[state.tf];
  const colOf = new Map(), val = s => { let a = colOf.get(s.ts); if (a) return a; a = new Float32Array(R);
    for (const [price, lg, sh] of s.buckets) { const v = lg + sh, r0 = Math.floor((price - base) / rb), r1 = Math.floor((price + s.width - base) / rb - 1e-9); for (let r = Math.max(0, r0); r <= Math.min(R - 1, Math.max(r0, r1)); r++) a[r] = Math.max(a[r], v); }
    colOf.set(s.ts, a); return a; };
  const A = new Float32Array(W * R); let j = 0;
  for (let c = 0; c < W; c++) {
    const i = Math.floor(c / S), tms = (cd[i].time + (((c % S) + 0.5) / S) * tf) * 1000;
    while (j + 1 < snaps.length && snaps[j + 1].ts <= tms) j++;
    if (snaps[j].ts > tms || tms - snaps[j].ts > 45 * 60e3) continue;
    A.set(val(snaps[j]), c * R);
  }
  const P = percentile(A, 0.97), b0 = percentile(A, 0.5), T = new Float32Array(A.length), span = Math.max(1e-9, P - b0);
  for (let i = 0; i < A.length; i++) T[i] = A[i] > b0 ? Math.min(1, Math.pow((A[i] - b0) / span, 0.8)) : 0;
  boxBlur(T, W, R, 1);
  state.bookImg = { cv: toImage(T, W, R, RAMP_BOOK, 0.05), N, base, rb, R };
}
function bookNear(timeSec) {
  if (!state.books.length) return null; const t = timeSec * 1000; let best = null;
  for (const s of state.books) if (s.ts <= t + TF[state.tf] * 500) best = s; else break;
  return best && t - best.ts <= 45 * 60e3 ? best : null;
}
function bookAt(timeSec, price) { const s = bookNear(timeSec); if (!s) return null; const b = s.buckets.find(x => price >= x[0] && price < x[0] + s.width); return b ? { snap: s, bucket: b } : null; }

// ---------------------------------------------------------------- canvas layers
const heatC = $('heat'), hctx = heatC.getContext('2d'), fxC = $('fx'), fctx = fxC.getContext('2d');
function paneSize() {
  let w = $('chartShell').clientWidth - 64, h = $('chartShell').clientHeight - 26;
  try { const p = chart.paneSize(0); if (p && p.width > 0 && p.height > 0) { w = p.width; h = p.height; } } catch { /* older lib */ }
  return [Math.max(10, Math.round(w)), Math.max(10, Math.round(h))];
}
function prepCanvas(cv, cx) {
  const [w, h] = paneSize(), dpr = window.devicePixelRatio || 1;
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  cx.setTransform(1, 0, 0, 1, 0, 0); cx.clearRect(0, 0, cv.width, cv.height); cx.setTransform(dpr, 0, 0, dpr, 0, 0); return [w, h];
}
function blit(img, w, h) {
  if (!img) return; const xa = lx(-0.5), xb = lx(img.N - 0.5), yt = yOf(img.base + img.R * img.rb), yb = yOf(img.base);
  if ([xa, xb, yt, yb].some(v => v == null)) return;
  hctx.save(); hctx.beginPath(); hctx.rect(0, 0, w, h); hctx.clip(); hctx.imageSmoothingEnabled = state.soft > 0; hctx.imageSmoothingQuality = 'high';
  hctx.drawImage(img.cv, xa, yt, Math.max(1, xb - xa), Math.max(1, yb - yt)); hctx.restore();
}
function bookNow() { const b = state.book; return b && Date.now() - b.fetchedAt - b.ageMs < 30000 ? b : null; }
function renderStrip() {
  const hc = $('heatChip'), bc = $('bookChip'), fc = $('flowChip'), hm = heatMaxK() * 1000;
  const need = Math.max(10, Math.round(3 * TF[state.tf] / 60)), oan = state.oandaOn ? ` <em>·</em> <em>OANDA ${state.bookKind === 'order' ? 'orders' : 'positions'}</em><span class="grad" style="width:56px;background:${cssGradient(RAMP_BOOK)}"></span>` : '';
  if (state.heatOn) {
    hc.classList.remove('hidden');
    hc.innerHTML = state.heatImg
      ? `<em>LIQUIDITY HISTORY</em><span class="grad" style="background:${cssGradient(RAMP_HEAT)}"></span><b>≥ ${money(hm)}</b><em>per $0.50 · fixed · ${dur(state.heatSpanMin * 60)} recorded</em>${oan}`
      : `<em>LIQUIDITY HISTORY</em><b>${state.heatSpanMin ? dur(state.heatSpanMin * 60) : 'starting'}</b><em>recorded · appears after ${need} min</em>${oan}`;
    hc.title = `Colour = resting dollars per $0.50 bucket (square-root scale). Top of the bar = ${money(hm)}; middle = ${money(hm * .25)}.`;
  } else if (state.oandaOn) { hc.classList.remove('hidden'); hc.innerHTML = `<em>OANDA ${state.bookKind === 'order' ? 'client orders' : 'client positions'}</em><span class="grad" style="background:${cssGradient(RAMP_BOOK)}"></span><em>${state.books.length ? 'crowded levels →' : 'no snapshots yet'}</em>`; } else hc.classList.add('hidden');
  const b = bookNow();
  if (state.wallsOn && b && state.px != null) {
    let bid = 0, ask = 0; for (const [i, k] of b.cells) { const p = i * b.bucket; if (p <= state.px && p >= state.px - 10) bid += k; else if (p > state.px && p <= state.px + 10) ask += k; }
    const t = bid + ask || 1; bc.classList.remove('hidden');
    bc.innerHTML = `<em>BOOK ±$10</em><span class="up">Bid <b>${money(bid * 1000)}</b></span><span class="meter"><i style="width:${Math.round(bid / t * 100)}%"></i></span><span class="dn">Ask <b>${money(ask * 1000)}</b></span>`;
    bc.title = 'Resting liquidity within $10 of the price on each side (recorded order books). Bar = bid share.';
  } else if (state.wallsOn) { bc.classList.remove('hidden'); bc.innerHTML = `<em>BOOK</em> <em>${state.book ? 'stale — feeds paused?' : 'waiting for order books'}</em>`; } else bc.classList.add('hidden');
  if (state.flowOn && !state.flowReady) { fc.classList.remove('hidden'); fc.innerHTML = `<em>ORDER FLOW</em><em>collecting trades · pane appears with 3+ candles of data</em>`; } else fc.classList.add('hidden');
}

const profileW = w => clamp(Math.round(w * 0.13), 96, 190);
function layoutProfile(w, h) {
  const b = bookNow(); state.profile = null; if (!state.wallsOn || !b || !b.cells.length) return;
  const y1 = yOf(b.ref), y2 = yOf(b.ref + 1); if (y1 == null || y2 == null) return; const ppd = Math.abs(y1 - y2) || 1;
  const step = Math.max(b.bucket, [0.5, 1, 2, 5, 10, 20, 50].find(s => s * ppd >= 4) || 50), bins = new Map();
  for (const [idx, k, side] of b.cells) { const key = Math.floor(idx * b.bucket / step + 1e-9); let a = bins.get(key); if (!a) { a = { bid: 0, ask: 0 }; bins.set(key, a); } if (side) a.bid += k; else a.ask += k; }
  const arr = []; let vmax = 0;
  for (const [key, a] of bins) { const lo = key * step, hi = lo + step, yt = yOf(hi), yb = yOf(lo); if (yt == null || yb == null || yb < 0 || yt > h) continue; const v = (a.bid + a.ask) * 1000; arr.push({ lo, hi, yt, yb, v, side: a.bid >= a.ask ? 'buy' : 'sell' }); if (v > vmax) vmax = v; }
  state.profile = { arr, vmax, step, maxW: profileW(w) };
}
function drawHeat() {
  const [w, h] = prepCanvas(heatC, hctx);
  if (state.bookDirty) rebuildBooks(); if (state.heatDirty) rebuildHeat();
  if (state.oandaOn) blit(state.bookImg, w, h);
  if (state.heatOn && state.heatImg) blit(state.heatImg, w, h);
  layoutProfile(w, h); const P = state.profile; if (!P || !P.vmax) return;
  for (const r of P.arr) {
    const f = r.v / P.vmax, bw = Math.max(2, P.maxW * Math.pow(f, 0.75)), col = r.side === 'buy' ? '53,232,196' : '255,95,120';
    hctx.fillStyle = `rgba(${col},${(0.26 + 0.34 * f).toFixed(3)})`; hctx.fillRect(w - bw, r.yt + 0.5, bw, Math.max(2, r.yb - r.yt - 1));
  }
  hctx.fillStyle = 'rgba(255,255,255,.07)'; hctx.fillRect(w - P.maxW - 1, 0, 1, h);
}

// ---------------------------------------------------------------- walls (top 5 live) + trade prints + measure box
function activeSnapshot() {
  if (state.replay && state.replayItems.length) { const x = state.replayItems[state.replayIndex] || state.replayItems.at(-1); return { ...state.raw, referencePrice: x.price, referenceSource: 'REPLAY:' + x.source, zones: x.zones || [], metrics: x.metrics || {}, bias: x.bias || {}, basis: x.basis || {} }; }
  return state.raw;
}
function drawWalls(w, h) {
  state.wallHits = []; const d = activeSnapshot(), P = state.profile; if (!state.wallsOn || !d || !P || state.px == null) return;
  const px = state.px, all = (d.zones || []).filter(z => z.strength >= 25 && z.notionalUsd > 0 && Number.isFinite(z.center)), top = Math.max(0, ...all.map(z => z.notionalUsd));
  const zs = all.filter(z => z.notionalUsd >= Math.max(250000, top * 0.35));          // only walls that matter: ≥ 35% of the biggest and ≥ $250K
  const above = zs.filter(z => z.center > px).sort((a, b) => a.center - b.center), below = zs.filter(z => z.center <= px).sort((a, b) => b.center - a.center);
  const pick = [above[0], below[0]].filter(Boolean), big = zs.slice().sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
  if (big && !pick.includes(big) && pick.every(p => big.notionalUsd >= 1.5 * p.notionalUsd)) pick.push(big);
  fctx.font = '600 10.5px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif'; fctx.textBaseline = 'middle'; const used = [];
  for (const z of pick) {
    const y = yOf(z.center); if (y == null || y < 8 || y > h - 8) continue; const col = z.side === 'buy' ? '53,232,196' : '255,95,120';
    const bin = P.arr.find(r => z.center >= r.lo && z.center < r.hi), bw = bin ? Math.max(2, P.maxW * Math.pow(bin.v / P.vmax, 0.75)) : P.maxW * 0.4;
    const dist = z.center - px, txt = `${z.side === 'buy' ? 'BID' : 'ASK'} ${fmt(z.center)}  ${money(z.notionalUsd)}  ${dist >= 0 ? '+' : '−'}${Math.abs(dist).toFixed(1)}${z.absorption ? '  ABS' : ''}`;
    let ly = y; for (const u of used) if (Math.abs(u - ly) < 19) ly = u + (ly >= u ? 19 : -19); used.push(ly);
    const tw = fctx.measureText(txt).width + 14, x = w - bw - tw - 8;
    fctx.fillStyle = 'rgba(6,10,15,.92)'; fctx.fillRect(x, ly - 9, tw, 18); fctx.strokeStyle = `rgba(${col},.7)`; fctx.strokeRect(x + .5, ly - 8.5, tw - 1, 17);
    fctx.fillStyle = `rgb(${col})`; fctx.fillText(txt, x + 7, ly + .5); state.wallHits.push({ x, y: ly - 9, w: tw, h: 18, z });
    if (Math.abs(ly - y) > 1) { fctx.strokeStyle = `rgba(${col},.35)`; fctx.beginPath(); fctx.moveTo(x + tw, ly); fctx.lineTo(w - bw, y); fctx.stroke(); }
  }
}
const bubR = usd => clamp(4 + 16 * Math.sqrt(usd / state.bref), 4, 22);       // FIXED scale in dollars — a size never changes because another print appeared
function bubblesView() {                // merge prints to one per candle × price bucket (calm, snapped to the candle grid)
  const N = state.candles.length; if (!N) return []; const pb = PB[state.tf], m = new Map();
  for (const b of state.flow.bubbles) {
    const l = logicalOfSec(b.t / 1000); if (l == null || l < 0 || l >= N + 1) continue;
    const ci = Math.min(N - 1, Math.floor(l)), pk = Math.round(b.price / pb), k = ci + ':' + pk; let a = m.get(k);
    if (!a) { a = { ci, price: pk * pb, buyUsd: 0, sellUsd: 0, n: 0, qty: 0, t: 0 }; m.set(k, a); }
    a.buyUsd += b.buyUsd; a.sellUsd += b.sellUsd; a.n += b.n; a.qty += b.qty; a.t = Math.max(a.t, b.t);
  }
  return [...m.values()].map(a => { const usd = a.buyUsd + a.sellUsd; return { ...a, usd, sell: a.sellUsd > a.buyUsd, momentum: (a.buyUsd - a.sellUsd) / (usd || 1) }; }).filter(a => a.usd >= state.bmin).sort((a, b) => b.usd - a.usd);
}
function drawBubbles(w, h) {
  state.hits = []; if (!state.bubOn) return; const placed = [], labels = [];
  for (const b of bubblesView()) {
    if (placed.length >= 30) break; const x = lx(b.ci), y = yOf(b.price); if (x == null || y == null || x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
    const r = bubR(b.usd); if (placed.some(p => Math.hypot(p.x - x, p.y - y) < (p.r + r) * 0.95)) continue; placed.push({ x, y, r, b });
  }
  placed.forEach(({ x, y, r, b }, i) => {
    const c = b.sell ? '255,95,120' : '60,240,225';
    fctx.fillStyle = `rgba(${c},.20)`; fctx.beginPath(); fctx.arc(x, y, r, 0, 6.2832); fctx.fill();
    fctx.strokeStyle = `rgba(${c},.95)`; fctx.lineWidth = 1.2; fctx.beginPath(); fctx.arc(x, y, r, 0, 6.2832); fctx.stroke(); fctx.lineWidth = 1;
    if (i < 10) {                          // label only when it does not collide with another label
      fctx.font = '600 10.5px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif'; fctx.textBaseline = 'middle'; const txt = money(b.usd), tw = fctx.measureText(txt).width, lx0 = x + r + 4;
      if (lx0 + tw < w - 4 && !labels.some(q => lx0 < q.x + q.w + 4 && lx0 + tw + 4 > q.x && Math.abs(y - q.y) < 13)) { fctx.fillStyle = `rgb(${c})`; fctx.fillText(txt, lx0, y); labels.push({ x: lx0, w: tw, y }); }
    }
    state.hits.push({ x, y, r: Math.max(r, 8), b });
    if (state.sel === b.ci + ':' + b.price) { fctx.strokeStyle = '#fff'; fctx.lineWidth = 1.6; fctx.beginPath(); fctx.arc(x, y, r + 3, 0, 6.2832); fctx.stroke(); fctx.lineWidth = 1; }
  });
}
function measureRectPx() {
  if (state.drag) return { x0: Math.min(state.drag.x0, state.drag.x1), x1: Math.max(state.drag.x0, state.drag.x1), y0: Math.min(state.drag.y0, state.drag.y1), y1: Math.max(state.drag.y0, state.drag.y1), live: true };
  const m = state.measure; if (!m) return null; const xa = xOfSec(m.t0), xb = xOfSec(m.t1), ya = yOf(m.p1), yb = yOf(m.p0);
  return [xa, xb, ya, yb].some(v => v == null) ? null : { x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: Math.min(ya, yb), y1: Math.max(ya, yb) };
}
function drawMeasure() {
  const r = measureRectPx(), panel = $('measurePanel'); if (!r) { panel.classList.add('hidden'); return; }
  fctx.fillStyle = 'rgba(110,150,255,.10)'; fctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  fctx.strokeStyle = 'rgba(140,175,255,.9)'; fctx.setLineDash([5, 3]); fctx.strokeRect(r.x0 + .5, r.y0 + .5, r.x1 - r.x0 - 1, r.y1 - r.y0 - 1); fctx.setLineDash([]);
  fctx.fillStyle = '#8caeff'; for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]) fctx.fillRect(x - 2.5, y - 2.5, 5, 5);
  if (r.live || !state.measure || !state.measure.html) { panel.classList.add('hidden'); return; }
  panel.innerHTML = state.measure.html; panel.classList.remove('hidden');
  const W = $('chartShell').clientWidth, H = $('chartShell').clientHeight, pw = panel.offsetWidth || 300, ph = panel.offsetHeight || 260;
  panel.style.left = clamp(r.x1 + 12 + pw > W - 70 ? r.x0 - pw - 12 : r.x1 + 12, 6, W - pw - 70) + 'px'; panel.style.top = clamp(r.y0, 6, H - ph - 30) + 'px';
}
function drawFx() {
  const [w, h] = prepCanvas(fxC, fctx);
  let ftop = h + 8; try { if (deltaS) { const ps = chart.panes(), idx = deltaS.getPane().paneIndex(); ftop = 8; for (let i = 0; i < idx; i++) ftop += ps[i].getHeight() + 1; } } catch (e) { /* panes not ready */ }
  $('flowTitle').style.top = ftop + 'px'; $('measureLayer').style.width = w + 'px'; $('measureLayer').style.height = h + 'px';
  drawWalls(w, h); drawBubbles(w, h); fire(hooks.draw, fctx, w, h); drawMeasure(); drawPosition(w, h);
}

// ---------------------------------------------------------------- order-flow pane: Delta bars + CVD line
let deltaS = null, cvdS = null;
function ensureFlowPane() {
  const want = state.flowOn && state.flowReady;
  if (want && !deltaS) {
    deltaS = chart.addSeries(LightweightCharts.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom', formatter: v => money(v), minMove: 1 } }, chart.panes().length);
    cvdS = chart.addSeries(LightweightCharts.LineSeries, { color: '#e8b04a', lineWidth: 2, priceScaleId: 'cvd', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: { type: 'custom', formatter: v => money(v), minMove: 1 } }, deltaS.getPane().paneIndex());
    chart.priceScale('cvd').applyOptions({ scaleMargins: { top: .14, bottom: .14 }, visible: false });
    setTimeout(() => { layoutPanes(); applyDelta(); requestDraw(); }, 0);
  } else if (!want && deltaS) { chart.removeSeries(deltaS); chart.removeSeries(cvdS); deltaS = cvdS = null; setTimeout(requestDraw, 0); }
  $('flowTitle').classList.toggle('hidden', !want); renderStrip();
}
function layoutPanes() { const ps = chart.panes(); if (ps.length < 2) return; const h = clamp(Math.round($('chartShell').clientHeight * 0.17), 84, 170); for (let i = 1; i < ps.length; i++) ps[i].setHeight(h); }
function perCandleDelta() {
  const N = state.candles.length, per = new Float64Array(N), has = new Uint8Array(N);
  for (const r of state.delta) { const l = logicalOfSec(r.t / 1000); if (l == null || l < 0) continue; const ci = Math.min(N - 1, Math.floor(l)); per[ci] += r.buy - r.sell; has[ci] = 1; }
  return { per, has, N };
}
async function loadDelta() {
  if (!state.candles.length || !state.flowOn) return;
  try {
    const d = await (await fetch(`/api/delta?minutes=${spanMinutes()}&step=60`, { cache: 'no-store' })).json(); if (!d.ok) return; state.delta = d.rows;
    const { has } = perCandleDelta(); let n = 0; for (const v of has) n += v; const ready = n >= 3; const changed = ready !== state.flowReady; state.flowReady = ready;
    if (changed || (ready && !deltaS)) ensureFlowPane(); else renderStrip(); applyDelta();
  } catch (e) { /* ignore */ }
}
function applyDelta() {
  if (!deltaS || !state.candles.length) return; const { per, has, N } = perCandleDelta(); let first = N, last = -1;
  for (let i = 0; i < N; i++) if (has[i]) { if (i < first) first = i; last = i; }
  const bars = [], line = []; let run = 0;
  for (let i = first; i <= last; i++) { run += per[i]; const t = state.candles[i].time; line.push({ time: t, value: run }); if (has[i]) bars.push({ time: t, value: per[i], color: per[i] >= 0 ? 'rgba(53,232,196,.72)' : 'rgba(255,95,120,.72)' }); }
  deltaS.setData(bars); cvdS.setData(line);
}

// ---------------------------------------------------------------- trade prints: data + click details
async function loadFlow() {
  if (!state.candles.length) return;
  try {
    const q = `minutes=${spanMinutes()}&step=${Math.max(5, Math.round(TF[state.tf] / 3))}&pb=${PB[state.tf]}&min_usd=${Math.round(state.bmin / 3)}`;
    const d = await (await fetch('/api/flow?' + q, { cache: 'no-store' })).json(); if (d.ok) { state.flow = d; requestDraw(); }
  } catch (e) { /* ignore */ }
}
const pop = document.createElement('div'); pop.className = 'bpop hidden'; $('chartShell').appendChild(pop);
const hitAt = pt => { let best = null, bd = 1e9; for (const h of state.hits) { const d = Math.hypot(h.x - pt.x, h.y - pt.y); if (d <= h.r && d < bd) { best = h; bd = d; } } return best; };
const wallAt = pt => state.wallHits.find(r => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h);
function showBubble(h) {
  const b = h.b, tot = b.usd || 1, bp = Math.round(b.buyUsd / tot * 100), sp = 100 - bp, m = Math.round(b.momentum * 100); state.sel = b.ci + ':' + b.price;
  const lab = m >= 35 ? 'Strong buy' : m >= 10 ? 'Buy' : m <= -35 ? 'Strong sell' : m <= -10 ? 'Sell' : 'Balanced';
  pop.innerHTML = `<div class="bp-top"><span class="bp-badge ${b.sell ? 'dn' : 'up'}">${b.sell ? 'SELL' : 'BUY'}</span><b class="bp-amt">${money(b.usd)}</b><i data-x>×</i></div>
    <div class="bp-r"><span>Price</span><b>${fmt(b.price)}</b></div><div class="bp-r"><span>Qty</span><b>${fmt(b.qty, 1)} oz</b></div>
    <div class="bp-r"><span>Time</span><b>${new Date(b.t).toISOString().replace('T', ' ').slice(0, 19)} UTC</b></div><div class="bp-sep"></div>
    <div class="bp-bar"><em style="width:${bp}%"></em><u style="width:${sp}%"></u></div>
    <div class="bp-r"><span class="up">Buy ${money(b.buyUsd)} · ${bp}%</span><span class="dn">Sell ${money(b.sellUsd)} · ${sp}%</span></div>
    <div class="bp-r"><span>Momentum</span><b class="${m >= 0 ? 'up' : 'dn'}">${m > 0 ? '+' : ''}${m}% · ${lab}</b></div><div class="bp-r"><span>Trades</span><b>${b.n}</b></div>
    <div class="bp-src">executed on public venues · aligned to broker price</div>`;
  pop.classList.remove('hidden'); const W = $('chartShell').clientWidth, H = $('chartShell').clientHeight, ph = pop.offsetHeight;
  pop.style.left = clamp(h.x + 14, 6, W - 262 - 70) + 'px'; pop.style.top = clamp(h.y - ph / 2, 6, H - ph - 34) + 'px'; requestDraw();
}
pop.addEventListener('click', e => { if (e.target.dataset.x !== undefined) { pop.classList.add('hidden'); state.sel = null; requestDraw(); } });
function showWall(z) {
  const sources = Object.entries(z.sources || {}).map(([k, v]) => `${k} ${money(v)}`).join('<br>');
  $('zoneDetail').innerHTML = `<div class="zd-head"><strong>${z.side === 'buy' ? 'BID' : 'ASK'} WALL · ${fmt(z.center)}</strong><span>${z.label || ''}</span></div><div class="zd-grid"><div><span>VISIBLE NOTIONAL SUM</span><b>${money(z.notionalUsd)}</b></div><div><span>QUALITY</span><b>Q${z.strength}/100</b></div><div><span>LARGEST SINGLE FEED</span><b>${money(z.maxVenueNotionalUsd)}</b></div><div><span>FEEDS AGREEING</span><b>${z.sourceCount}</b></div><div><span>PERSISTENCE</span><b>${fmt(z.persistenceSec, 1)} s</b></div><div><span>STABILITY</span><b>${pctf(z.stability)}</b></div><div><span>EXECUTED AGAINST</span><b>${money(z.executedAgainstUsd)}</b></div><div><span>REPLENISHMENT</span><b>${pctf(z.replenishment)}</b></div><div><span>ABSORPTION</span><b>${z.absorption ? 'YES · ' + pctf(z.absorptionScore) : '—'}</b></div></div><div class="zd-sources">${sources || 'No source detail'}<br>Distance from broker price: ${fmt(z.distanceUsd)} USD</div>`;
  $('zoneDetail').classList.remove('hidden');
}

// ---------------------------------------------------------------- measure tool (drag a box → liquidity, flow, OANDA inside it)
const ML = $('measureLayer');
function setTool(t) {
  state.tool = t; ML.classList.toggle('hidden', t !== 'measure'); $('chartShell').classList.toggle('placing', t === 'measure' || !!state.armed);
  $('toolsBtn').classList.toggle('on', !!t || !!state.armed || !!state.measure || !!state.pos);
}
function clearDrawings() {
  state.measure = null; state.drag = null; state.pos = null; state.armed = null; syncPosLines(); setTool(null); $('measurePanel').classList.add('hidden'); requestDraw();
}
ML.addEventListener('pointerdown', e => { const r = ML.getBoundingClientRect(); state.drag = { x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top }; state.measure = null; ML.setPointerCapture(e.pointerId); requestDraw(); });
ML.addEventListener('pointermove', e => { if (!state.drag) return; const r = ML.getBoundingClientRect(); state.drag.x1 = clamp(e.clientX - r.left, 0, r.width); state.drag.y1 = clamp(e.clientY - r.top, 0, r.height); requestDraw(); });
ML.addEventListener('pointerup', async e => {
  const d = state.drag; if (!d) return; state.drag = null;
  const xa = Math.min(d.x0, d.x1), xb = Math.max(d.x0, d.x1), ya = Math.min(d.y0, d.y1), yb = Math.max(d.y0, d.y1);
  if (xb - xa < 6 || yb - ya < 6) { setTool(null); requestDraw(); return; }
  const t0 = secOfX(xa), t1 = secOfX(xb), p1 = candles.coordinateToPrice(ya), p0 = candles.coordinateToPrice(yb);
  setTool(null); if ([t0, t1, p0, p1].some(v => v == null)) return;
  state.measure = { t0, t1, p0, p1, html: '<div class="mp-h"><b>MEASURE</b><span>reading…</span></div>' }; requestDraw();
  await computeMeasure(state.measure);
});
async function computeMeasure(m) {
  const tms0 = m.t0 * 1000, tms1 = m.t1 * 1000, h = state.heat, B = h ? h.bucket : 0.5;
  // 1) resting liquidity from the recorded books that are already on screen
  let nb = 0, sumAll = 0, peak = 0, bid = 0, ask = 0, big = { k: 0, price: 0, side: 1 };
  if (h) for (const [t, cells] of h.bins) {
    if (t + h.step <= tms0 || t >= tms1) continue; nb++; let s = 0;
    for (const [idx, k, side] of cells) { const p = idx * B; if (p < m.p0 - B / 2 || p > m.p1 + B / 2) continue; s += k; if (side) bid += k; else ask += k; if (k > big.k) big = { k, price: p, side }; }
    sumAll += s; peak = Math.max(peak, s);
  }
  const rangeMin = (tms1 - tms0) / 60000, coverMin = h ? nb * h.step / 60000 : 0, resting = nb ? `
    <div class="mp-s">RESTING LIQUIDITY <em>recorded order books</em></div>
    <div class="mp-r"><span>Average inside box</span><b>${money(sumAll / nb * 1000)}</b></div>
    <div class="mp-r"><span>Peak at one moment</span><b>${money(peak * 1000)}</b></div>
    <div class="mp-r"><span>Largest single level</span><b>${money(big.k * 1000)} @ ${fmt(big.price)} · ${big.side ? 'bid' : 'ask'}</b></div>
    <div class="mp-bar"><em style="width:${bid + ask ? Math.round(bid / (bid + ask) * 100) : 50}%"></em><u></u></div>
    <div class="mp-r"><span class="up">Bid ${pctf(bid / ((bid + ask) || 1))}</span><span class="dn">Ask ${pctf(ask / ((bid + ask) || 1))}</span></div>
    <div class="mp-n">recorded ${dur(Math.min(coverMin, rangeMin) * 60)} of ${dur(rangeMin * 60)}</div>` : `
    <div class="mp-s">RESTING LIQUIDITY</div><div class="mp-n">No order book was recorded in this period — nothing is estimated.</div>`;
  // 2) OANDA client orders
  const snap = bookNear(m.t1); let oanda = '';
  if (snap) { let lg = 0, sh = 0; for (const [price, a, b] of snap.buckets) if (price + snap.width > m.p0 && price < m.p1) { lg += a; sh += b; }
    oanda = `<div class="mp-s">OANDA CLIENT ${state.bookKind === 'order' ? 'ORDERS' : 'POSITIONS'} <em>share of count · ${hhmm(snap.ts)}</em></div><div class="mp-r"><span class="up">Long ${lg.toFixed(1)}%</span><span class="dn">Short ${sh.toFixed(1)}%</span></div>`; }
  const head = `<div class="mp-h"><b>MEASURE</b><span>${fmt(m.p0)} → ${fmt(m.p1)}</span><i data-x>×</i></div>
    <div class="mp-r"><span>Range</span><b>${fmt(m.p1 - m.p0)} · ${fmt((m.p1 - m.p0) / m.p0 * 100, 2)}%</b></div><div class="mp-r"><span>Duration</span><b>${dur(m.t1 - m.t0)}</b></div>`;
  m.html = head + resting + '<div class="mp-s">EXECUTED TRADES <em>public venues</em></div><div class="mp-n" id="mpFlow">reading…</div>' + oanda + '<div class="mp-n src">aligned to your broker price · values from recorded data only</div>';
  requestDraw();
  try {
    const f = await (await fetch(`/api/flow/range?t0=${Math.round(tms0)}&t1=${Math.round(tms1)}&p0=${m.p0}&p1=${m.p1}`, { cache: 'no-store' })).json();
    const body = f.slotsInRange ? `<div class="mp-r"><span class="up">Buy ${money(f.buy)}</span><span class="dn">Sell ${money(f.sell)}</span></div>
      <div class="mp-r"><span>Delta (buy − sell)</span><b class="${f.delta >= 0 ? 'up' : 'dn'}">${f.delta >= 0 ? '+' : ''}${money(f.delta)}</b></div><div class="mp-r"><span>Trades · volume</span><b>${f.trades} · ${fmt(f.qty, 0)} oz</b></div>`
      : 'No executed trades were recorded in this period.';
    m.html = m.html.replace('<div class="mp-n" id="mpFlow">reading…</div>', body);
  } catch (e) { m.html = m.html.replace('reading…', 'flow unavailable'); }
  requestDraw();
}
$('measurePanel').addEventListener('click', e => { if (e.target.dataset.x !== undefined) { state.measure = null; $('measurePanel').classList.add('hidden'); setTool(null); requestDraw(); } });

// ---------------------------------------------------------------- position tool (LONG / SHORT)
let posLines = [];
function syncPosLines() {
  for (const l of posLines) candles.removePriceLine(l); posLines = []; const P = state.pos; if (!P || P.tp == null || P.sl == null) return;
  const mk = (price, color, title) => candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title, axisLabelColor: color, axisLabelTextColor: '#04120f' });
  posLines = [mk(P.tp, '#2fe0c6', 'TP'), mk(P.entry, '#c9d2dc', P.side === 'long' ? 'LONG' : 'SHORT'), mk(P.sl, '#ff6a6a', 'SL')];
}
function drawPosition(w) {
  const P = state.pos; if (!P || P.entry == null) return; const xx = xOfSec(P.t), ye = yOf(P.entry); if (xx == null || ye == null) return;
  const x1 = Math.max(0, xx), x2 = w, ys = P.sl != null ? yOf(P.sl) : null, yt = P.tp != null ? yOf(P.tp) : null, dir = P.side === 'long' ? 1 : -1, pc = v => (v - P.entry) / P.entry * 100 * dir;
  if (yt != null) { fctx.fillStyle = 'rgba(40,200,190,.18)'; fctx.fillRect(x1, Math.min(ye, yt), x2 - x1, Math.abs(yt - ye)); fctx.strokeStyle = 'rgba(80,235,215,.8)'; fctx.strokeRect(x1 + .5, Math.min(ye, yt) + .5, x2 - x1 - 1, Math.abs(yt - ye) - 1); }
  if (ys != null) { fctx.fillStyle = 'rgba(239,83,80,.20)'; fctx.fillRect(x1, Math.min(ye, ys), x2 - x1, Math.abs(ys - ye)); fctx.strokeStyle = 'rgba(255,110,106,.8)'; fctx.strokeRect(x1 + .5, Math.min(ye, ys) + .5, x2 - x1 - 1, Math.abs(ys - ye) - 1); }
  fctx.strokeStyle = 'rgba(255,255,255,.7)'; fctx.setLineDash([4, 3]); fctx.beginPath(); fctx.moveTo(x1, ye); fctx.lineTo(x2, ye); fctx.stroke(); fctx.setLineDash([]);
  fctx.font = '10px ui-monospace,Menlo,Consolas,monospace'; fctx.textBaseline = 'middle';
  const lab = (t, c, x, y) => { fctx.fillStyle = c; fctx.fillText(t, x, y); };
  if (yt != null) lab(`TP ${fmt(P.tp)} (${pc(P.tp) >= 0 ? '+' : ''}${pc(P.tp).toFixed(2)}%)`, x1 + 8, yt + (yt < ye ? 10 : -10), '#8ff3e6');
  if (ys != null) lab(`SL ${fmt(P.sl)} (${pc(P.sl) >= 0 ? '+' : ''}${pc(P.sl).toFixed(2)}%)`, x1 + 8, ys + (ys < ye ? 10 : -10), '#ff9a96');
  if (P.tp != null && P.sl != null) lab(`${P.side.toUpperCase()} · R:R ${(Math.abs(P.tp - P.entry) / Math.abs(P.entry - P.sl)).toFixed(1)} · ${state.psize} oz`, x1 + 8, ye - 8, '#fff');
  if (state.px != null && P.tp != null) {
    const yp = yOf(state.px); if (yp == null) return; const usd = (state.px - P.entry) * dir * state.psize, p = pc(state.px), win = usd >= 0;
    const txt = `${win ? '+' : '−'}${Math.abs(usd).toFixed(2)} USD (${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}%)`, wd = fctx.measureText(txt).width + 16;
    fctx.fillStyle = win ? 'rgba(22,60,58,.95)' : 'rgba(70,28,28,.95)'; fctx.strokeStyle = win ? '#3fe0cc' : '#ff6e6a';
    fctx.fillRect(x2 - wd - 6, yp - 9, wd, 18); fctx.strokeRect(x2 - wd - 5.5, yp - 8.5, wd - 1, 17); fctx.fillStyle = win ? '#9ff7ea' : '#ffb1ae'; fctx.fillText(txt, x2 - wd + 2, yp);
  }
}
function armTool(side) {
  state.pos = null; state.armed = state.armed === side ? null : side; syncPosLines(); setTool(null); $('chartShell').classList.toggle('placing', !!state.armed); $('toolsBtn').classList.toggle('on', !!state.armed); requestDraw();
}
chart.subscribeClick(p => {
  if (!p.point) return;
  if (!state.armed) {
    const h = hitAt(p.point); if (h) { showBubble(h); return; } const w = wallAt(p.point); if (w) { showWall(w.z); return; }
    pop.classList.add('hidden'); state.sel = null; $('zoneDetail').classList.add('hidden'); requestDraw(); return;
  }
  const price = candles.coordinateToPrice(p.point.y); if (price == null) return;
  if (!state.pos) state.pos = { side: state.armed, t: p.time || (state.candles.length ? state.candles[state.candles.length - 1].time : 0), entry: price, sl: null, tp: null };
  else { const P = state.pos, risk = Math.abs(P.entry - price) || P.entry * .001; P.sl = P.side === 'long' ? P.entry - risk : P.entry + risk; P.tp = P.side === 'long' ? P.entry + 2 * risk : P.entry - 2 * risk; state.armed = null; $('chartShell').classList.remove('placing'); syncPosLines(); }
  requestDraw();
});

// ---------------------------------------------------------------- header: bias, feeds, price
function renderBias(d) {
  const b = d?.bias || {}, dir = b.direction || 'NEUTRAL', status = b.status || 'WATCH';
  let label = status === 'CONFIRMED_BIAS' ? `${dir} BIAS` : status === 'NO_DATA' ? 'NO DATA' :
    dir === 'NEUTRAL' ? 'NO TRADE' : status === 'WAIT' ? `WAIT · ${dir}` : status.replaceAll('_', ' ');
  $('biasText').textContent = label;
  $('biasScore').textContent = Number.isFinite(+b.score) && status !== 'NO_DATA' ? b.score : '';
  $('biasPill').className = 'bias ' + (dir === 'BUY' ? 'buy' : dir === 'SELL' ? 'sell' : 'neutral');
  $('biasPill').title = (b.reason || 'No decision rationale available') + '\n' + (b.warning || 'Research score is not a win probability.');
}
function renderFeeds() {
  const d = state.raw; if (!d) return;
  const e = Object.entries(d.sources || {}), el = $('feeds');
  const fresh = e.filter(([, s]) => s.ok === true && s.ageMs !== null && s.ageMs !== undefined && Number.isFinite(+s.ageMs) && +s.ageMs >= 0 && +s.ageMs <= 6500).length;
  el.textContent = `${fresh}/${e.length} live feeds`;
  el.className = 'feeds ' + (e.length && fresh === e.length ? 'ok' : fresh ? 'warn' : 'bad');
  $('feedsPanel').innerHTML = e.map(([k, s]) => {
    const ageMs = s.ageMs === null || s.ageMs === undefined ? NaN : Number(s.ageMs), freshNow = s.ok === true && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 6500;
    const ageLabel = !Number.isFinite(ageMs) ? 'age unknown' : ageMs < 1000 ? 'under 1s' : `${Math.round(ageMs / 1000)}s`;
    const status = freshNow ? 'LIVE' : s.ok === true ? 'STALE' : 'OFFLINE';
    const levels = Number.isFinite(+s.levels) && +s.levels ? ` · ${Math.trunc(+s.levels)} levels` : '';
    return `<div class="${freshNow ? '' : 'bad'}"><b>${freshNow ? '●' : '○'} ${escHtml(k)} <small>${status}</small></b><i>${escHtml(String(s.message || '').slice(0, 60))} · ${ageLabel}${levels}</i></div>`;
  }).join('');
}
$('feeds').onclick = ev => { ev.stopPropagation(); $('feedsPanel').classList.toggle('hidden'); };
document.addEventListener('click', ev => { if (!ev.target.closest('#feedsPanel')) $('feedsPanel').classList.add('hidden'); });
function onState(d) {
  state.raw = d; const v = activeSnapshot() || d; state.px = d.referencePrice !== null && d.referencePrice !== undefined && Number.isFinite(+d.referencePrice) && +d.referencePrice > 0 ? +d.referencePrice : null;
  $('price').textContent = fmt(v.referencePrice); $('priceSource').textContent = v.referencePrice !== null && v.referencePrice !== undefined && Number.isFinite(+v.referencePrice) && +v.referencePrice > 0 ? (v.referenceSource || 'LIVE') : 'WAITING';
  const ref = String(d.referenceSource || ''), s = d.sources && (ref.startsWith('OANDA') ? d.sources.OANDA : ref.startsWith('MT5') ? d.sources.MT5_DOM : null);
  $('symbol').textContent = ref.startsWith('OANDA') ? ((s && s.meta && s.meta.instrument) || 'XAU_USD').replace('_', '') : (d.mt5Symbol || 'XAUUSD');
  $('spread').textContent = s && s.bestBid && s.bestAsk ? `spread ${fmt(s.bestAsk - s.bestBid, 2)}` : '';
  const refSource = String(d.referenceSource || 'NONE');
  const refFeed = refSource.startsWith('OANDA') ? d.sources?.OANDA : refSource.startsWith('MT5') ? d.sources?.MT5_DOM : null;
  const freshAge = item => item && item.ok === true && item.ageMs !== null && item.ageMs !== undefined && Number.isFinite(+item.ageMs) && +item.ageMs >= 0 && +item.ageMs <= 6500;
  const publicReferenceFresh = refSource === 'PUBLIC_MEDIAN' && Object.entries(d.sources || {}).some(([name, item]) => !['OANDA','MT5_DOM'].includes(name) && freshAge(item));
  const referenceFresh = d.referencePrice !== null && d.referencePrice !== undefined && Number.isFinite(+d.referencePrice) && +d.referencePrice > 0 &&
    Date.now() - (d.engineUpdatedMs || 0) <= 6500 && (freshAge(refFeed) || publicReferenceFresh);
  $('offline').classList.toggle('hidden', referenceFresh || state.replay);
  renderFeeds(); renderBias(v); updateLiveCandle(d); if (Date.now() - state.lastStrip > 500) { state.lastStrip = Date.now(); renderStrip(); } requestDraw();
}
let ws; function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = e => { try { onState(JSON.parse(e.data)); } catch { /* partial frame */ } }; ws.onclose = () => setTimeout(connect, 1500); ws.onerror = () => ws.close();
}
async function startReplay() {
  try {
    const d = await (await fetch(`/api/history?minutes=${+$('replayMinutes').value || 30}&limit=10000`, { cache: 'no-store' })).json();
    state.replayItems = d.items || []; if (!state.replayItems.length) { showNotice('No recorded zone history yet'); setTimeout(() => showNotice(''), 2500); return; }
    state.replay = true; state.replayIndex = state.replayItems.length - 1; $('replaySlider').max = String(state.replayItems.length - 1); $('replaySlider').value = String(state.replayIndex); $('replayBar').classList.remove('hidden'); updateReplayView();
  } catch (e) { console.warn('replay', e); }
}
function stopReplay() { state.replay = false; state.replayItems = []; $('replayBar').classList.add('hidden'); if (state.raw) onState(state.raw); }
function updateReplayView() { if (!state.replay || !state.replayItems.length) return; $('replayTime').textContent = new Date(state.replayItems[state.replayIndex].ts).toLocaleTimeString(); if (state.raw) onState(state.raw); }

// ---------------------------------------------------------------- hover readout (liquidity under the cursor)
chart.subscribeCrosshairMove(p => {
  const tip = $('hoverTip');
  if (!p || !p.time || !p.point) { tip.classList.add('hidden'); return; }
  const v = p.seriesData.get(candles); if (v) { const ch = (v.close - v.open) / v.open * 100; $('crossInfo').innerHTML = `O <b>${fmt(v.open)}</b>  H <b>${fmt(v.high)}</b>  L <b>${fmt(v.low)}</b>  C <b>${fmt(v.close)}</b>  <span class="${ch >= 0 ? 'up' : 'dn'}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span>`; }
  const onBubble = hitAt(p.point) || wallAt(p.point); $('chartShell').style.cursor = (!state.armed && !state.tool && onBubble) ? 'pointer' : '';
  const price = candles.coordinateToPrice(p.point.y), ts = secOfX(p.point.x);
  if (state.armed || state.tool || state.drag || onBubble || price == null || ts == null || (!state.heatOn && !state.oandaOn)) { tip.classList.add('hidden'); return; }
  const lines = [], hc = state.heatOn ? heatAt(ts, price) : null, ob = state.oandaOn ? bookAt(ts, price) : null;
  if (hc) lines.push(hc.none ? `<span class="mu">Resting @ ${fmt(price)}: below recording floor</span>` : `<b>${money(hc.k * 1000)}</b> resting @ ${fmt(hc[0] * state.heat.bucket)} · ${hc[2] ? '<span class="up">bid</span>' : '<span class="dn">ask</span>'}`);
  if (ob) lines.push(`OANDA ${state.bookKind === 'order' ? 'orders' : 'positions'}: <span class="up">L ${ob.bucket[1].toFixed(2)}%</span> · <span class="dn">S ${ob.bucket[2].toFixed(2)}%</span>`);
  if (!lines.length) { tip.classList.add('hidden'); return; }
  tip.innerHTML = lines.join('<br>'); tip.style.left = clamp(p.point.x + 16, 6, $('chartShell').clientWidth - 250) + 'px'; tip.style.top = clamp(p.point.y + 14, 6, $('chartShell').clientHeight - 60) + 'px'; tip.classList.remove('hidden');
});

async function loadBook() {
  try { const d = await (await fetch('/api/book?window=60', { cache: 'no-store' })).json(); if (d.ok) { state.book = { ...d, fetchedAt: Date.now() }; renderStrip(); requestDraw(); } } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- draw scheduling + wiring
let raf = 0;
function requestDraw() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; drawHeat(); drawFx(); }); }
function closeMenus() { document.querySelectorAll('.mpanel').forEach(p => p.classList.add('hidden')); }
[['toolsBtn', 'toolsPanel']].forEach(([b, p]) => { $(b).onclick = e => { e.stopPropagation(); const open = !$(p).classList.contains('hidden'); closeMenus(); $(p).classList.toggle('hidden', open); }; });
document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenus(); if (!e.target.closest('#zoneDetail') && !e.target.closest('#chartShell')) $('zoneDetail').classList.add('hidden'); });
$('toolsPanel').addEventListener('click', e => {
  const b = e.target.closest('button[data-tool]'); if (!b) return; const t = b.dataset.tool; closeMenus();
  if (t === 'measure') { state.armed = null; state.pos = null; syncPosLines(); setTool('measure'); } else if (t === 'long' || t === 'short') armTool(t);
  else if (t === 'clear') clearDrawings(); else if (t === 'replay') state.replay ? stopReplay() : startReplay();
});
function setLayer(k, v) {
  state[k] = !!v; store.set('L_' + k, v ? '1' : '0');
  if (k === 'flowOn') { ensureFlowPane(); loadDelta(); } if (k === 'oandaOn') state.bookDirty = true;
  state.heatDirty = state.heatDirty || k === 'heatOn'; renderStrip(); requestDraw(); fire(hooks.layer, k, !!v);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') clearDrawings(); });
$('tfGroup').addEventListener('click', e => {
  const b = e.target.closest('button[data-tf]'); if (!b) return;
  document.querySelectorAll('#tfGroup button').forEach(x => x.classList.remove('active')); b.classList.add('active'); state.tf = b.dataset.tf; store.set('tf', state.tf);
  state.heat = null; state.heatImg = null; state.bookImg = null; state.flow = { bubbles: [], cvd: [] }; state.measure = null; $('measurePanel').classList.add('hidden');
  loadCandles(true).then(() => { loadHeat(true); loadFlow(); loadBooks(); loadDelta(); });
});
document.querySelectorAll('#tfGroup button').forEach(b => b.classList.toggle('active', b.dataset.tf === state.tf));
$('replayLive').onclick = stopReplay; $('replaySlider').oninput = e => { state.replayIndex = +e.target.value; updateReplayView(); };
$('settingsBtn').onclick = () => $('settings').classList.toggle('hidden'); $('closeSettings').onclick = () => $('settings').classList.add('hidden');
// settings
const HM = [['auto', 'Auto (calibrated once, then fixed)'], ['500', '$500K'], ['1000', '$1M'], ['2000', '$2M'], ['5000', '$5M'], ['10000', '$10M'], ['25000', '$25M']];
$('heatMax').innerHTML = HM.map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); $('heatMax').value = state.heatMaxMode;
$('heatMax').onchange = e => { state.heatMaxMode = e.target.value; store.set('heatMax', state.heatMaxMode); if (state.heatMaxMode === 'auto') state.heatMaxAuto = null; state.heatDirty = true; requestDraw(); };
$('heatSoft').value = String(state.soft); $('heatSoft').onchange = e => { state.soft = +e.target.value; store.set('soft', state.soft); state.heatDirty = true; requestDraw(); };
$('bmin').value = state.bmin; $('bminVal').textContent = money(state.bmin);
let bt = 0; $('bmin').oninput = e => { state.bmin = +e.target.value; $('bminVal').textContent = money(state.bmin); store.set('bmin', state.bmin); clearTimeout(bt); bt = setTimeout(loadFlow, 200); requestDraw(); };
$('bref').value = state.bref; $('brefVal').textContent = money(state.bref); $('bref').oninput = e => { state.bref = +e.target.value; $('brefVal').textContent = money(state.bref); store.set('bref', state.bref); requestDraw(); };
$('bookKind').value = state.bookKind; $('bookKind').onchange = e => { state.bookKind = e.target.value; store.set('bookKind', state.bookKind); loadBooks(); };
$('psize').value = state.psize; $('psize').oninput = e => { const v = +e.target.value; if (v > 0) { state.psize = v; store.set('psize', v); requestDraw(); } };

chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestDraw());
chart.timeScale().subscribeSizeChange(() => requestDraw());
new ResizeObserver(() => { chart.resize($('chartShell').clientWidth, $('chartShell').clientHeight); layoutPanes(); requestDraw(); }).observe($('chartShell'));
window.JG = {
  chart, candles, state, TF, hooks, setLayer, requestDraw, lx, xOfSec, secOfX, yOf, logicalOfSec, fmt, money, clamp, paneSize,
  layers: () => ({ heatOn: state.heatOn, wallsOn: state.wallsOn, bubOn: state.bubOn, flowOn: state.flowOn, oandaOn: state.oandaOn }),
  indicators: [],
};
if (location.search.includes('debug')) window.__jg = { state, xOfSec, secOfX, yOf, candles, chart, computeMeasure };   // test hook, only with ?debug

(async () => {
  ensureFlowPane(); renderStrip();
  await loadCandles(true); connect();
  loadHeat(true); loadFlow(); loadBooks(); loadDelta(); loadBook();
  setInterval(loadBook, 1500);
  setInterval(() => { if (!state.replay) loadCandles(false); }, 30000);
  setInterval(() => loadHeat(false), 4000); setInterval(() => loadHeat(true), 90000);
  setInterval(loadFlow, 3000); setInterval(loadDelta, 5000); setInterval(loadBooks, 120000);
})();
})();
