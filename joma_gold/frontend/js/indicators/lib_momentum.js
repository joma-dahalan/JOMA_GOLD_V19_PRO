/* Momentum / oscillator indicators — each lives in its own pane below the chart. */
(() => {
  'use strict';
  const J = (typeof window !== 'undefined' ? window : globalThis).JG, TA = J.ta, { I, SRC, hexA } = J.kit, reg = d => J.registerIndicator(Object.assign({ group: 'Momentum', kind: 'pane' }, d));
  const line = (data, color, width = 1.5, style = 0) => ({ data, color, width, style });
  const lv = (price, color = '#3b4658', style = 2, title = '') => ({ price, color, style, title });

  reg({
    id: 'rsi', name: 'RSI', desc: 'Relative Strength Index (Wilder).',
    inputs: [I.int('len', 'Length', 14, 2, 200), I.select('src', 'Source', 'close', SRC), I.int('ob', 'Overbought', 70, 50, 99), I.int('os', 'Oversold', 30, 1, 50), I.color('color', 'Color', '#b388ff')],
    calc: (C, p) => ({ lines: [line(TA.rsi(TA.source(C, p.src), p.len), p.color)], levels: [lv(p.ob), lv(50, '#2a3342', 1), lv(p.os)], bounds: [0, 100] }),
  });
  reg({
    id: 'macd', name: 'MACD', desc: 'Moving Average Convergence Divergence with signal line and histogram.',
    inputs: [I.int('fast', 'Fast', 12, 1, 200), I.int('slow', 'Slow', 26, 2, 400), I.int('sig', 'Signal', 9, 1, 100), I.color('c1', 'MACD', '#4aa3ff'), I.color('c2', 'Signal', '#ff9f43')],
    calc: (C, p) => {
      const m = TA.macd(TA.source(C, 'close'), p.fast, p.slow, p.sig), col = m.hist.map((v, i) => { if (!TA.isN(v)) return null; const pv = m.hist[i - 1], up = TA.isN(pv) ? v >= pv : true; return v >= 0 ? (up ? '#35e8c4' : '#1d8f7a') : (up ? '#a3404f' : '#ff5f78'); });
      return { hist: [{ data: m.hist, colors: col, color: '#35e8c4' }], lines: [line(m.macd, p.c1), line(m.signal, p.c2)], levels: [lv(0, '#2a3342', 1)] };
    },
  });
  reg({
    id: 'stoch', name: 'Stochastic', short: 'Stoch', desc: '%K / %D stochastic oscillator.',
    inputs: [I.int('k', '%K length', 14, 1, 200), I.int('sk', '%K smoothing', 3, 1, 50), I.int('d', '%D smoothing', 3, 1, 50), I.color('c1', '%K', '#4aa3ff'), I.color('c2', '%D', '#ff9f43')],
    calc: (C, p) => { const s = TA.stoch(C, p.k, p.sk, p.d); return { lines: [line(s.k, p.c1), line(s.d, p.c2)], levels: [lv(80), lv(20)], bounds: [0, 100] }; },
  });
  reg({
    id: 'cci', name: 'CCI', desc: 'Commodity Channel Index.',
    inputs: [I.int('len', 'Length', 20, 2, 300), I.color('color', 'Color', '#35e8c4')],
    calc: (C, p) => ({ lines: [line(TA.cci(C, p.len), p.color)], levels: [lv(100), lv(0, '#2a3342', 1), lv(-100)] }),
  });
  reg({
    id: 'atr', name: 'ATR', desc: 'Average True Range (Wilder) in price units.',
    inputs: [I.int('len', 'Length', 14, 1, 200), I.color('color', 'Color', '#ff9f43')],
    calc: (C, p) => ({ lines: [line(TA.atr(C, p.len), p.color)] }),
  });
  reg({
    id: 'adx', name: 'ADX / DMI', short: 'ADX', desc: 'Trend strength (ADX) with +DI and −DI.',
    inputs: [I.int('len', 'Length', 14, 2, 100), I.int('lvl', 'Trend level', 25, 5, 60), I.color('c1', 'ADX', '#e8e8e8'), I.color('c2', '+DI', '#35e8c4'), I.color('c3', '−DI', '#ff5f78')],
    calc: (C, p) => { const a = TA.adx(C, p.len); return { lines: [line(a.adx, p.c1, 2), line(a.pdi, p.c2, 1), line(a.mdi, p.c3, 1)], levels: [lv(p.lvl)] }; },
  });
})();
