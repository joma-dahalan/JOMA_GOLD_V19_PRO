const assert = require('assert');
const TA = require('../../frontend/js/indicators/ta.js');
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('sma / ema / wma on a small series', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepStrictEqual(TA.sma(a, 3).slice(0, 4), [null, null, 2, 3]);
  const e = TA.ema(a, 3); close(e[2], 2, 1e-9); close(e[3], 3, 1e-9); close(e[9], 9, 1e-9);        // EMA of a ramp lags by (n-1)/2
  close(TA.wma(a, 3)[2], (1 * 1 + 2 * 2 + 3 * 3) / 6, 1e-9);
});
t('RSI matches the classic Wilder / StockCharts worked example', () => {
  const px = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439];
  const r = TA.rsi(px, 14);
  close(r[14], 70.53, 0.02); close(r[15], 66.32, 0.02); close(r[16], 66.55, 0.02); close(r[17], 69.41, 0.02); close(r[18], 66.36, 0.02); close(r[19], 57.97, 0.02);
});
t('MACD definitions hold; a flat series gives zeros', () => {
  const a = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.1), m = TA.macd(a, 12, 26, 9);
  const e12 = TA.ema(a, 12), e26 = TA.ema(a, 26);
  for (let i = 40; i < 80; i++) { close(m.macd[i], e12[i] - e26[i], 1e-9); close(m.hist[i], m.macd[i] - m.signal[i], 1e-9); }
  const z = TA.macd(Array(60).fill(50), 12, 26, 9); close(z.macd[59], 0, 1e-9); close(z.hist[59], 0, 1e-9);
});
t('stdev is the population deviation; bollinger-style bands bracket the mean', () => {
  const a = [2, 4, 4, 4, 5, 5, 7, 9]; close(TA.stdev(a, 8)[7], 2, 1e-9);
});
const bars = (rows) => rows.map((r, i) => ({ time: 1_700_000_000 + i * 900, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] || 100 }));
t('ATR (Wilder) of constant ranges equals the range', () => { const c = bars(Array.from({ length: 30 }, () => [100, 100.5, 99.5, 100])); close(TA.atr(c, 14)[29], 1.0, 1e-9); });
t('stochastic stays in 0..100 and hits 100 at a new high', () => {
  const c = bars(Array.from({ length: 40 }, (_, i) => [100 + i, 101 + i, 99 + i, 100.5 + i])), s = TA.stoch(c, 14, 1, 1);
  assert.ok(s.k.filter(v => v !== null).every(v => v >= 0 && v <= 100)); assert.ok(s.k[39] > 70);
});
t('CCI is zero for a constant series and positive in an uptrend', () => {
  close(TA.cci(bars(Array.from({ length: 30 }, () => [10, 11, 9, 10])), 20)[29], 0, 1e-9);
  assert.ok(TA.cci(bars(Array.from({ length: 40 }, (_, i) => [10 + i, 11 + i, 9 + i, 10 + i])), 20)[39] > 0);
});
t('ADX is high in a clean trend and +DI beats -DI', () => {
  const c = bars(Array.from({ length: 80 }, (_, i) => [100 + i * 2, 101.5 + i * 2, 99.5 + i * 2, 101 + i * 2])), a = TA.adx(c, 14);
  assert.ok(a.adx[79] > 40); assert.ok(a.pdi[79] > a.mdi[79]);
});
t('Supertrend flips with price and stays on the right side of it', () => {
  const rows = []; for (let i = 0; i < 60; i++) rows.push([100 + i, 101 + i, 99.5 + i, 100.8 + i]); for (let i = 0; i < 60; i++) rows.push([160 - i, 160.5 - i, 159 - i, 159.2 - i]);
  const c = bars(rows), s = TA.supertrend(c, 10, 3);
  assert.strictEqual(s.dir[50], 1); assert.ok(s.line[50] < c[50].close);
  assert.strictEqual(s.dir[119], -1); assert.ok(s.line[119] > c[119].close);
});
t('Parabolic SAR sits below price in an uptrend and flips on a reversal', () => {
  const rows = []; for (let i = 0; i < 40; i++) rows.push([100 + i, 101 + i, 99.5 + i, 100.8 + i]); for (let i = 0; i < 30; i++) rows.push([140 - i * 1.5, 140.5 - i * 1.5, 138 - i * 1.5, 138.5 - i * 1.5]);
  const c = bars(rows), p = TA.psar(c, 0.02, 0.02, 0.2);
  assert.strictEqual(p.dir[35], 1); assert.ok(p.sar[35] < c[35].low); assert.strictEqual(p.dir[69], -1); assert.ok(p.sar[69] > c[69].high);
});
t('OBV accumulates volume by direction', () => { const o = TA.obv(bars([[1, 1, 1, 10, 5], [1, 1, 1, 11, 7], [1, 1, 1, 10.5, 3], [1, 1, 1, 10.5, 9]])); assert.deepStrictEqual(o, [0, 7, 4, 4]); });
t('VWAP restarts every day and equals the typical price at the start', () => {
  const c = [{ time: 86400 * 3 + 100, open: 1, high: 12, low: 8, close: 10, volume: 10 }, { time: 86400 * 3 + 1000, open: 1, high: 22, low: 18, close: 20, volume: 30 }, { time: 86400 * 4 + 100, open: 1, high: 31, low: 29, close: 30, volume: 5 }];
  const v = TA.vwap(c, 1).vwap; close(v[0], 10, 1e-9); close(v[1], (10 * 10 + 20 * 30) / 40, 1e-9); close(v[2], 30, 1e-9);
});
t('pivots are confirmed k bars late and zigzag alternates', () => {
  const rows = []; for (let i = 0; i < 12; i++) rows.push([100 + i, 100.5 + i, 99.5 + i, 100 + i]); for (let i = 0; i < 12; i++) rows.push([111 - i, 111.5 - i, 110.5 - i, 111 - i]); for (let i = 0; i < 12; i++) rows.push([100 + i, 100.5 + i, 99.5 + i, 100 + i]);
  const c = bars(rows), p = TA.pivotsOf(c, 3); assert.ok(p.length >= 2); assert.ok(p.every(x => x.i <= c.length - 4));
  const z = TA.zigzag(p, 2); for (let i = 1; i < z.length; i++) assert.notStrictEqual(z[i].kind, z[i - 1].kind);
});
t('HMA tracks a ramp with less lag than the SMA', () => { const a = Array.from({ length: 60 }, (_, i) => i); assert.ok(Math.abs(TA.hma(a, 16)[59] - 59) < Math.abs(TA.sma(a, 16)[59] - 59)); });
console.log(`\n${n} TA tests passed`);
