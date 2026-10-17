/* Volume indicators. Volume = the broker's tick volume (number of price updates), not exchange volume. */
(() => {
  'use strict';
  const J = (typeof window !== 'undefined' ? window : globalThis).JG, TA = J.ta, { I, hexA } = J.kit;
  const reg = d => J.registerIndicator(Object.assign({ group: 'Volume', kind: 'pane' }, d));

  reg({
    id: 'volume', name: 'Volume (tick)', short: 'Vol', desc: 'Tick volume per candle, coloured by candle direction, with a moving average.',
    inputs: [I.int('ma', 'MA length (0 = off)', 20, 0, 300), I.color('up', 'Up color', '#35e8c4'), I.color('dn', 'Down color', '#ff5f78')],
    calc: (C, p) => {
      const v = C.map(b => b.volume || 0), out = { hist: [{ data: v, colors: C.map(b => hexA(b.close >= b.open ? p.up : p.dn, .6)), color: p.up }], lines: [] };
      if (p.ma > 0) out.lines.push({ data: TA.sma(v, p.ma), color: '#e8b04a', width: 1.5, style: 0 });
      return out;
    },
  });
  reg({
    id: 'obv', name: 'On-Balance Volume', short: 'OBV', desc: 'Cumulative volume added on up-closes and subtracted on down-closes.',
    inputs: [I.int('ma', 'Signal MA (0 = off)', 20, 0, 300), I.color('color', 'Color', '#4aa3ff')],
    calc: (C, p) => { const o = TA.obv(C), out = { lines: [{ data: o, color: p.color, width: 1.5, style: 0 }] }; if (p.ma > 0) out.lines.push({ data: TA.sma(o, p.ma), color: '#ff9f43', width: 1, style: 2 }); return out; },
  });

  // Volume profile of the *visible* candles: volume spread across each candle's range (body weighted double), POC and value area.
  function profile(C, from, to, rows, vaPct) {
    const sl = C.slice(from, to + 1); if (sl.length < 3) return null;
    let lo = Infinity, hi = -Infinity; for (const b of sl) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
    if (!(hi > lo)) return null; const step = (hi - lo) / rows, vol = new Float64Array(rows);
    for (const b of sl) {
      const v = b.volume > 0 ? b.volume : 1, r0 = Math.max(0, Math.floor((b.low - lo) / step)), r1 = Math.min(rows - 1, Math.floor((b.high - lo) / step - 1e-9)), bl = Math.min(b.open, b.close), bh = Math.max(b.open, b.close);
      let wsum = 0; const w = []; for (let r = r0; r <= r1; r++) { const mid = lo + (r + .5) * step, x = (mid >= bl && mid <= bh) ? 2 : 1; w.push(x); wsum += x; }
      for (let r = r0; r <= r1; r++) vol[r] += v * w[r - r0] / wsum;
    }
    let poc = 0; for (let r = 1; r < rows; r++) if (vol[r] > vol[poc]) poc = r;
    const total = vol.reduce((a, b) => a + b, 0); let acc = vol[poc], a = poc, b = poc;
    while (acc < total * vaPct / 100 && (a > 0 || b < rows - 1)) { const up = b < rows - 1 ? vol[b + 1] : -1, dn = a > 0 ? vol[a - 1] : -1; if (up >= dn) { b++; acc += vol[b]; } else { a--; acc += vol[a]; } }
    return { lo, hi, step, vol, poc, va: [a, b], max: vol[poc] };
  }
  reg({
    id: 'vprofile', name: 'Volume Profile (visible)', short: 'VP', kind: 'canvas', desc: 'Where volume traded across the visible candles: POC, value area high / low.',
    inputs: [I.int('rows', 'Rows', 48, 12, 200), I.int('va', 'Value area %', 70, 50, 95), I.select('side', 'Side', 'left', ['left', 'right']), I.color('color', 'Color', '#4aa3ff')],
    calc: () => ({}),
    draw(ctx, v, p) {
      const pr = profile(v.C, Math.max(0, v.from), Math.min(v.N - 1, v.to), p.rows, p.va); if (!pr) return;
      const maxW = Math.min(150, v.w * 0.16), right = p.side === 'right';
      for (let r = 0; r < p.rows; r++) {
        const y1 = v.y(pr.lo + (r + 1) * pr.step), y2 = v.y(pr.lo + r * pr.step); if (y1 == null || y2 == null) continue;
        const w = maxW * pr.vol[r] / pr.max, inVA = r >= pr.va[0] && r <= pr.va[1]; ctx.fillStyle = hexA(p.color, inVA ? .38 : .16);
        ctx.fillRect(right ? v.w - w : 0, y1 + .5, w, Math.max(1, y2 - y1 - 1));
      }
      const yp = v.y(pr.lo + (pr.poc + .5) * pr.step), yh = v.y(pr.lo + (pr.va[1] + 1) * pr.step), yl = v.y(pr.lo + pr.va[0] * pr.step);
      ctx.font = '600 10px ui-sans-serif,system-ui,sans-serif'; ctx.textBaseline = 'middle';
      const mark = (y, txt, col, dash) => { if (y == null) return; ctx.strokeStyle = col; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(v.w, y + .5); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.fillText(txt, right ? 6 : maxW + 8, y - 7); };
      mark(yp, `POC ${(pr.lo + (pr.poc + .5) * pr.step).toFixed(2)}`, 'rgba(255,159,67,.85)', [4, 3]); mark(yh, `VAH ${(pr.lo + (pr.va[1] + 1) * pr.step).toFixed(2)}`, 'rgba(160,175,200,.55)', [2, 4]); mark(yl, `VAL ${(pr.lo + pr.va[0] * pr.step).toFixed(2)}`, 'rgba(160,175,200,.55)', [2, 4]);
    },
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = { profile };
})();
