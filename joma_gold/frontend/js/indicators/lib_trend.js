/* Trend / overlay indicators. Original implementations of standard, public formulas. */
(() => {
  'use strict';
  const J = (typeof window !== 'undefined' ? window : globalThis).JG, TA = J.ta, { I, SRC, hexA } = J.kit, reg = d => J.registerIndicator(Object.assign({ group: 'Trend', kind: 'overlay' }, d));
  const line = (data, color, width = 2, style = 0, extra = {}) => Object.assign({ data, color, width, style }, extra);
  const ma = (id, name, desc, fn, color) => reg({
    id, name, desc, inputs: [I.int('len', 'Length', 21, 1, 1000), I.select('src', 'Source', 'close', SRC), I.color('color', 'Color', color)],
    calc: (C, p) => ({ lines: [line(fn(TA.source(C, p.src), p.len), p.color)] }),
  });
  ma('sma', 'SMA', 'Simple moving average.', TA.sma, '#f5c542');
  ma('ema', 'EMA', 'Exponential moving average (seeded with the SMA, like most platforms).', TA.ema, '#4aa3ff');
  ma('wma', 'WMA', 'Linearly weighted moving average.', TA.wma, '#c77dff');
  ma('hma', 'Hull MA', 'Hull moving average: fast and smooth with little lag.', TA.hma, '#ff9f43');

  reg({
    id: 'vwap', name: 'VWAP (daily)', desc: 'Volume-weighted average price anchored at 00:00 UTC, with optional deviation bands. Uses broker tick volume.',
    inputs: [I.float('mult', 'Band multiplier', 1, 0, 5, 0.1), I.bool('bands', 'Show bands', true), I.color('color', 'Color', '#e8b04a')],
    calc: (C, p) => {
      const v = TA.vwap(C, p.mult), day = C.map(b => Math.floor(b.time / 86400)), pick = (arr, odd) => arr.map((x, i) => (day[i] % 2 === 1) === odd ? x : null);   // alternate series per day → no joining line between days
      const out = { lines: [line(pick(v.vwap, false), p.color), line(pick(v.vwap, true), p.color)] };
      if (p.bands && p.mult > 0) out.lines.push(line(pick(v.upper, false), hexA(p.color, .55), 1, 2), line(pick(v.upper, true), hexA(p.color, .55), 1, 2), line(pick(v.lower, false), hexA(p.color, .55), 1, 2), line(pick(v.lower, true), hexA(p.color, .55), 1, 2));
      return out;
    },
  });
  reg({
    id: 'bollinger', name: 'Bollinger Bands', short: 'BB', desc: 'Moving average with bands at N standard deviations.',
    inputs: [I.int('len', 'Length', 20, 2, 500), I.float('mult', 'Std dev', 2, 0.1, 10, 0.1), I.select('src', 'Source', 'close', SRC), I.color('color', 'Color', '#4aa3ff')],
    calc: (C, p) => {
      const s = TA.source(C, p.src), m = TA.sma(s, p.len), sd = TA.stdev(s, p.len), up = m.map((x, i) => TA.isN(x) ? x + p.mult * sd[i] : null), lo = m.map((x, i) => TA.isN(x) ? x - p.mult * sd[i] : null);
      return { lines: [line(up, p.color, 1), line(m, hexA(p.color, .7), 1, 2), line(lo, p.color, 1)], fills: [{ a: up, b: lo, color: hexA(p.color, .07) }] };
    },
  });
  reg({
    id: 'keltner', name: 'Keltner Channels', short: 'KC', desc: 'EMA with bands at a multiple of ATR.',
    inputs: [I.int('len', 'EMA length', 20, 2, 500), I.int('atr', 'ATR length', 10, 1, 200), I.float('mult', 'Multiplier', 2, 0.1, 10, 0.1), I.color('color', 'Color', '#c77dff')],
    calc: (C, p) => {
      const m = TA.ema(TA.source(C, 'close'), p.len), a = TA.atr(C, p.atr), up = m.map((x, i) => TA.isN(x) && TA.isN(a[i]) ? x + p.mult * a[i] : null), lo = m.map((x, i) => TA.isN(x) && TA.isN(a[i]) ? x - p.mult * a[i] : null);
      return { lines: [line(up, p.color, 1), line(m, hexA(p.color, .7), 1, 2), line(lo, p.color, 1)], fills: [{ a: up, b: lo, color: hexA(p.color, .06) }] };
    },
  });
  reg({
    id: 'donchian', name: 'Donchian Channels', short: 'DC', desc: 'Highest high / lowest low over N bars.',
    inputs: [I.int('len', 'Length', 20, 2, 500), I.color('color', 'Color', '#35e8c4')],
    calc: (C, p) => {
      const up = TA.highest(C.map(b => b.high), p.len), lo = TA.lowest(C.map(b => b.low), p.len), mid = up.map((x, i) => TA.isN(x) ? (x + lo[i]) / 2 : null);
      return { lines: [line(up, p.color, 1), line(mid, hexA(p.color, .6), 1, 1), line(lo, p.color, 1)], fills: [{ a: up, b: lo, color: hexA(p.color, .05) }] };
    },
  });
  reg({
    id: 'supertrend', name: 'Supertrend', short: 'ST', desc: 'ATR-based trailing stop that flips with the trend.',
    inputs: [I.int('len', 'ATR length', 10, 1, 200), I.float('mult', 'Factor', 3, 0.5, 10, 0.1), I.color('up', 'Up color', '#35e8c4'), I.color('dn', 'Down color', '#ff5f78')],
    calc: (C, p) => { const s = TA.supertrend(C, p.len, p.mult); return { lines: [line(s.line.map((v, i) => s.dir[i] === 1 ? v : null), p.up), line(s.line.map((v, i) => s.dir[i] === -1 ? v : null), p.dn)] }; },
  });
  reg({
    id: 'psar', name: 'Parabolic SAR', short: 'SAR', desc: "Wilder's stop-and-reverse dots.",
    inputs: [I.float('step', 'Step', 0.02, 0.001, 0.5, 0.001), I.float('inc', 'Increment', 0.02, 0.001, 0.5, 0.001), I.float('max', 'Maximum', 0.2, 0.01, 1, 0.01), I.color('up', 'Up color', '#35e8c4'), I.color('dn', 'Down color', '#ff5f78')],
    calc: (C, p) => { const s = TA.psar(C, p.step, p.inc, p.max); return { lines: [line(s.sar.map((v, i) => s.dir[i] === 1 ? v : null), p.up, 1, 0, { points: true }), line(s.sar.map((v, i) => s.dir[i] === -1 ? v : null), p.dn, 1, 0, { points: true })] }; },
  });
  reg({
    id: 'ichimoku', name: 'Ichimoku Cloud', short: 'Ichimoku', desc: 'Tenkan, Kijun, Chikou and the Senkou cloud (projected forward).',
    inputs: [I.int('t', 'Tenkan', 9, 1, 100), I.int('k', 'Kijun', 26, 1, 200), I.int('b', 'Senkou B', 52, 1, 400), I.int('shift', 'Displacement', 26, 1, 100), I.color('up', 'Cloud up', '#35e8c4'), I.color('dn', 'Cloud down', '#ff5f78')],
    calc: (C, p) => {
      const H = C.map(b => b.high), Lw = C.map(b => b.low), mid = n => { const h = TA.highest(H, n), l = TA.lowest(Lw, n); return h.map((x, i) => TA.isN(x) ? (x + l[i]) / 2 : null); };
      const tk = mid(p.t), kj = mid(p.k), sb = mid(p.b), N = C.length, sa = TA.blank(N + p.shift), sbb = TA.blank(N + p.shift), ch = TA.blank(N);
      for (let i = 0; i < N; i++) { if (TA.isN(tk[i]) && TA.isN(kj[i])) sa[i + p.shift] = (tk[i] + kj[i]) / 2; if (TA.isN(sb[i])) sbb[i + p.shift] = sb[i]; if (i - p.shift >= 0) ch[i - p.shift] = C[i].close; }
      return { lines: [line(tk, '#4aa3ff', 1), line(kj, '#ff9f43', 1), line(ch, '#c77dff', 1, 1), line(sa, hexA(p.up, .5), 1), line(sbb, hexA(p.dn, .5), 1)], fills: [{ a: sa, b: sbb, color: hexA(p.up, .10), colorDown: hexA(p.dn, .10) }] };
    },
  });
})();
