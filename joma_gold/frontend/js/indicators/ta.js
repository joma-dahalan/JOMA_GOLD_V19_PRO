/* Technical-analysis math. Pure array functions: input arrays in, same-length arrays out (null where undefined).
   Works in the browser (window.JGTA) and in node (tests). No look-ahead: value[i] only uses data up to i. */
(function (root) {
  'use strict';
  const isN = v => v !== null && v !== undefined && Number.isFinite(v);
  const blank = n => new Array(n).fill(null);
  const first = a => { for (let i = 0; i < a.length; i++) if (isN(a[i])) return i; return -1; };

  function sma(a, n) {
    const o = blank(a.length), f = first(a); if (f < 0) return o; let s = 0;
    for (let i = f; i < a.length; i++) { s += a[i]; if (i - f >= n) s -= a[i - n]; if (i - f >= n - 1) o[i] = s / n; }
    return o;
  }
  function smooth(a, n, alpha) {                         // seeded with the SMA of the first n values (TradingView / Wilder convention)
    const o = blank(a.length), f = first(a); if (f < 0 || a.length - f < n) return o;
    let e = 0; for (let i = f; i < f + n; i++) e += a[i]; e /= n; o[f + n - 1] = e;
    for (let i = f + n; i < a.length; i++) { e = alpha * a[i] + (1 - alpha) * e; o[i] = e; }
    return o;
  }
  const ema = (a, n) => smooth(a, n, 2 / (n + 1));
  const rma = (a, n) => smooth(a, n, 1 / n);
  function wma(a, n) {
    const o = blank(a.length), f = first(a), d = n * (n + 1) / 2;
    for (let i = f + n - 1; f >= 0 && i < a.length; i++) { let s = 0; for (let k = 0; k < n; k++) s += a[i - k] * (n - k); o[i] = s / d; }
    return o;
  }
  function hma(a, n) {
    const h = Math.max(1, Math.floor(n / 2)), r = Math.max(1, Math.round(Math.sqrt(n)));
    const w1 = wma(a, h), w2 = wma(a, n), diff = a.map((_, i) => (isN(w1[i]) && isN(w2[i])) ? 2 * w1[i] - w2[i] : null);
    return wma(diff, r);
  }
  function stdev(a, n) {                                   // population standard deviation
    const o = blank(a.length), m = sma(a, n);
    for (let i = 0; i < a.length; i++) if (isN(m[i])) { let s = 0; for (let k = 0; k < n; k++) s += (a[i - k] - m[i]) ** 2; o[i] = Math.sqrt(s / n); }
    return o;
  }
  function highest(a, n) { const o = blank(a.length); for (let i = n - 1; i < a.length; i++) { let m = -Infinity; for (let k = 0; k < n; k++) m = Math.max(m, a[i - k]); o[i] = m; } return o; }
  function lowest(a, n) { const o = blank(a.length); for (let i = n - 1; i < a.length; i++) { let m = Infinity; for (let k = 0; k < n; k++) m = Math.min(m, a[i - k]); o[i] = m; } return o; }

  function source(c, name) {
    return c.map(b => name === 'open' ? b.open : name === 'high' ? b.high : name === 'low' ? b.low : name === 'hl2' ? (b.high + b.low) / 2
      : name === 'hlc3' ? (b.high + b.low + b.close) / 3 : name === 'ohlc4' ? (b.open + b.high + b.low + b.close) / 4 : b.close);
  }
  function tr(c) { return c.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close))); }
  const atr = (c, n) => rma(tr(c), n);

  function rsi(a, n) {                                     // Wilder RSI
    const o = blank(a.length); if (a.length <= n) return o;
    let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; }
    g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    return o;
  }
  function macd(a, f, s, sig) {
    const ef = ema(a, f), es = ema(a, s), m = a.map((_, i) => isN(ef[i]) && isN(es[i]) ? ef[i] - es[i] : null), sg = ema(m, sig);
    return { macd: m, signal: sg, hist: m.map((v, i) => isN(v) && isN(sg[i]) ? v - sg[i] : null) };
  }
  function stoch(c, k, sk, d) {
    const hh = highest(c.map(b => b.high), k), ll = lowest(c.map(b => b.low), k);
    const raw = c.map((b, i) => isN(hh[i]) ? (hh[i] === ll[i] ? 50 : 100 * (b.close - ll[i]) / (hh[i] - ll[i])) : null), K = sma(raw, sk);
    return { k: K, d: sma(K, d) };
  }
  function cci(c, n) {
    const tp = source(c, 'hlc3'), m = sma(tp, n), o = blank(c.length);
    for (let i = 0; i < c.length; i++) if (isN(m[i])) { let md = 0; for (let k = 0; k < n; k++) md += Math.abs(tp[i - k] - m[i]); md /= n; o[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md); }
    return o;
  }
  function adx(c, n) {                                     // Wilder DMI / ADX
    const N = c.length, pdm = blank(N), mdm = blank(N);
    for (let i = 1; i < N; i++) { const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low; pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0; }
    const t = tr(c).map((v, i) => i === 0 ? null : v), str = rma(t, n), sp = rma(pdm, n), sm = rma(mdm, n);
    const pdi = str.map((v, i) => isN(v) && v > 0 ? 100 * sp[i] / v : null), mdi = str.map((v, i) => isN(v) && v > 0 ? 100 * sm[i] / v : null);
    const dx = pdi.map((p, i) => isN(p) && isN(mdi[i]) ? (p + mdi[i] === 0 ? 0 : 100 * Math.abs(p - mdi[i]) / (p + mdi[i])) : null);
    return { adx: rma(dx, n), pdi, mdi };
  }
  function supertrend(c, n, f) {
    const a = atr(c, n), N = c.length, line = blank(N), dir = blank(N); let up = null, dn = null, tr_ = 1;
    for (let i = 0; i < N; i++) {
      if (!isN(a[i])) continue; const hl2 = (c[i].high + c[i].low) / 2; let u = hl2 - f * a[i], d = hl2 + f * a[i];
      if (up !== null) { u = c[i - 1].close > up ? Math.max(u, up) : u; d = c[i - 1].close < dn ? Math.min(d, dn) : d; if (tr_ === -1 && c[i].close > dn) tr_ = 1; else if (tr_ === 1 && c[i].close < up) tr_ = -1; }
      up = u; dn = d; dir[i] = tr_; line[i] = tr_ === 1 ? u : d;
    }
    return { line, dir };
  }
  function psar(c, step, inc, max) {
    const N = c.length, o = blank(N), dir = blank(N); if (N < 3) return { sar: o, dir };
    let up = c[1].close >= c[0].close, af = step, ep = up ? Math.max(c[0].high, c[1].high) : Math.min(c[0].low, c[1].low), sar = up ? Math.min(c[0].low, c[1].low) : Math.max(c[0].high, c[1].high);
    o[1] = sar; dir[1] = up ? 1 : -1;
    for (let i = 2; i < N; i++) {
      sar = sar + af * (ep - sar);
      if (up) { sar = Math.min(sar, c[i - 1].low, c[i - 2].low); if (c[i].low < sar) { up = false; sar = ep; ep = c[i].low; af = step; } else if (c[i].high > ep) { ep = c[i].high; af = Math.min(af + inc, max); } }
      else { sar = Math.max(sar, c[i - 1].high, c[i - 2].high); if (c[i].high > sar) { up = true; sar = ep; ep = c[i].high; af = step; } else if (c[i].low < ep) { ep = c[i].low; af = Math.min(af + inc, max); } }
      o[i] = sar; dir[i] = up ? 1 : -1;
    }
    return { sar: o, dir };
  }
  function obv(c) { const o = blank(c.length); let s = 0; for (let i = 0; i < c.length; i++) { if (i > 0) s += c[i].close > c[i - 1].close ? c[i].volume : c[i].close < c[i - 1].close ? -c[i].volume : 0; o[i] = s; } return o; }
  function vwap(c, mult, dayStart) {                       // anchored at the start of each UTC day (or `dayStart(time)`)
    const key = dayStart || (t => Math.floor(t / 86400)), N = c.length, v = blank(N), u = blank(N), l = blank(N); let k = null, pv = 0, vol = 0, pv2 = 0;
    for (let i = 0; i < N; i++) {
      const kk = key(c[i].time); if (kk !== k) { k = kk; pv = vol = pv2 = 0; }
      const tp = (c[i].high + c[i].low + c[i].close) / 3, w = c[i].volume > 0 ? c[i].volume : 1; pv += tp * w; vol += w; pv2 += tp * tp * w;
      const m = pv / vol, sd = Math.sqrt(Math.max(0, pv2 / vol - m * m)); v[i] = m; u[i] = m + mult * sd; l[i] = m - mult * sd;
    }
    return { vwap: v, upper: u, lower: l };
  }
  function pivotsOf(c, k) {                                // confirmed fractal pivots (appear k bars after they form)
    const out = [];
    for (let i = k; i < c.length - k; i++) {
      let hi = true, lo = true;
      for (let j = 1; j <= k; j++) { if (!(c[i].high > c[i - j].high) || c[i].high < c[i + j].high) hi = false; if (!(c[i].low < c[i - j].low) || c[i].low > c[i + j].low) lo = false; }
      if (hi) out.push({ i, price: c[i].high, kind: 'high', time: c[i].time });
      if (lo) out.push({ i, price: c[i].low, kind: 'low', time: c[i].time });
    }
    return out.sort((a, b) => a.i - b.i || (a.kind === 'low' ? -1 : 1));
  }
  function zigzag(p, minMove) {
    const r = [];
    for (const x of p) {
      const l = r[r.length - 1];
      if (!l) { r.push(x); continue; }
      if (x.kind === l.kind) { if ((x.kind === 'high' && x.price >= l.price) || (x.kind === 'low' && x.price <= l.price)) r[r.length - 1] = x; continue; }
      if (Math.abs(x.price - l.price) >= minMove) r.push(x);
    }
    return r;
  }
  const TA = { isN, blank, sma, ema, rma, wma, hma, stdev, highest, lowest, source, tr, atr, rsi, macd, stoch, cci, adx, supertrend, psar, obv, vwap, pivotsOf, zigzag };
  if (typeof module !== 'undefined' && module.exports) module.exports = TA; else root.JGTA = TA;
})(typeof window !== 'undefined' ? window : globalThis);
