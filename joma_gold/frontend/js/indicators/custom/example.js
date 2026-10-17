/* Example custom indicator — copy this file, change the id/name/calc/draw, and add a <script> line in frontend/index.html.
   This one marks "inside bars" (a candle whose range sits inside the previous candle's range). See docs/ADDING_INDICATORS.md. */
(() => {
  'use strict';
  const J = window.JG, { I, hexA } = J.kit;
  J.registerIndicator({
    id: 'insidebar', name: 'Inside Bars (example)', short: 'Inside', group: 'Custom', kind: 'canvas',
    desc: 'Example of a custom canvas indicator: dots under candles that are inside the previous candle.',
    inputs: [I.color('color', 'Color', '#ffb74d')],
    calc: C => ({ idx: C.map((b, i) => i > 0 && b.high <= C[i - 1].high && b.low >= C[i - 1].low ? i : -1).filter(i => i >= 0) }),
    draw(ctx, v, p, r) {
      ctx.fillStyle = hexA(p.color, .95);
      for (const i of r.idx) { if (i < v.from || i > v.to) continue; const x = v.x(i), y = v.y(v.C[i].low); if (x == null || y == null) continue; ctx.beginPath(); ctx.arc(x, y + 8, 2.5, 0, 6.2832); ctx.fill(); }
    },
  });
})();
