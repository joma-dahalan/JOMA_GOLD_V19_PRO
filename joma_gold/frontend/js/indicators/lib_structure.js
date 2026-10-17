/* Market structure / smart-money style indicators, drawn on the chart canvas.
   All swing logic is causal: a swing is only used k bars after it formed, so nothing here "knows the future". */
(() => {
  'use strict';
  const J = (typeof window !== 'undefined' ? window : globalThis).JG, TA = J.ta, { I, hexA } = J.kit;
  const reg = d => J.registerIndicator(Object.assign({ group: 'Structure', kind: 'canvas' }, d));
  const UP = '#35e8c4', DN = '#ff5f78', FONT = '600 10px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif';
  const lastKind = (a, kind) => { for (let i = a.length - 1; i >= 0; i--) if (a[i].kind === kind) return a[i]; return null; };
  const trendOf = a => {
    const h = a.filter(p => p.kind === 'high').slice(-2), l = a.filter(p => p.kind === 'low').slice(-2); if (h.length < 2 || l.length < 2) return 'RANGE';
    return h[1].price > h[0].price && l[1].price > l[0].price ? 'UP' : h[1].price < h[0].price && l[1].price < l[0].price ? 'DOWN' : 'RANGE';
  };
  function incZig(zz, p, minMove) {
    const l = zz[zz.length - 1]; if (!l) { zz.push(p); return; }
    if (p.kind === l.kind) { if ((p.kind === 'high' && p.price >= l.price) || (p.kind === 'low' && p.price <= l.price)) zz[zz.length - 1] = p; return; }
    if (Math.abs(p.price - l.price) >= minMove) zz.push(p);
  }

  /** Causal structure analysis: swings (ATR-filtered zig-zag), BOS / CHoCH, liquidity sweeps, FVGs and order blocks. */
  function analyse(C, k, minAtr) {
    const N = C.length, atrA = TA.atr(C, 14), raw = TA.pivotsOf(C, k), zz = [], events = [], sweeps = [], brokenH = new Set(), brokenL = new Set(), sweptH = new Set(), sweptL = new Set();
    let pi = 0, lastAtr = 0;
    for (let j = 1; j < N; j++) {
      if (TA.isN(atrA[j])) lastAtr = atrA[j];
      while (pi < raw.length && raw[pi].i + k <= j - 1) incZig(zz, raw[pi++], minAtr * (lastAtr || 0));
      if (!zz.length || !lastAtr) continue;
      const hi = lastKind(zz, 'high'), lo = lastKind(zz, 'low'), tr = trendOf(zz), b = C[j], pc = C[j - 1].close, body = Math.abs(b.close - b.open) / lastAtr, canBreak = zz.length >= 3;
      if (canBreak && hi && b.close > hi.price && pc <= hi.price && !brokenH.has(hi.i)) { brokenH.add(hi.i); events.push({ kind: tr === 'UP' ? 'BOS' : 'CHoCH', dir: 'UP', level: hi.price, pi: hi.i, i: j, body }); }
      if (canBreak && lo && b.close < lo.price && pc >= lo.price && !brokenL.has(lo.i)) { brokenL.add(lo.i); events.push({ kind: tr === 'DOWN' ? 'BOS' : 'CHoCH', dir: 'DOWN', level: lo.price, pi: lo.i, i: j, body }); }
      if (hi && b.high > hi.price + 0.05 * lastAtr && b.close < hi.price && (b.high - hi.price) <= 1.2 * lastAtr && !sweptH.has(hi.i)) { sweptH.add(hi.i); sweeps.push({ dir: 'DOWN', level: hi.price, pi: hi.i, i: j, extreme: b.high }); }
      if (lo && b.low < lo.price - 0.05 * lastAtr && b.close > lo.price && (lo.price - b.low) <= 1.2 * lastAtr && !sweptL.has(lo.i)) { sweptL.add(lo.i); sweeps.push({ dir: 'UP', level: lo.price, pi: lo.i, i: j, extreme: b.low }); }
    }
    const labels = []; let ph = null, pl = null;
    for (const p of zz) { if (p.kind === 'high') { labels.push({ ...p, text: ph ? (p.price > ph.price ? 'HH' : 'LH') : 'H' }); ph = p; } else { labels.push({ ...p, text: pl ? (p.price > pl.price ? 'HL' : 'LL') : 'L' }); pl = p; } }
    return { zz, labels, events, sweeps, atr: lastAtr, atrA };
  }
  const idxXs = (v, i) => v.x(i);

  reg({
    id: 'structure', name: 'Market Structure (BOS / CHoCH)', short: 'Structure', desc: 'Swing highs/lows (HH, HL, LH, LL) and structure breaks: BOS with the trend, CHoCH against it.',
    inputs: [I.int('k', 'Swing strength (bars)', 3, 1, 10), I.float('minAtr', 'Min swing (ATR)', 0.6, 0, 5, 0.1), I.int('max', 'Max breaks shown', 10, 1, 60), I.bool('labels', 'Swing labels', true), I.bool('bos', 'Show BOS', true)],
    calc: (C, p) => analyse(C, p.k, p.minAtr),
    draw(ctx, v, p, r) {
      ctx.font = FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      if (p.labels) for (const s of r.labels) { if (s.i < v.from || s.i > v.to) continue; const x = idxXs(v, s.i), y = v.y(s.price); if (x == null || y == null) continue; ctx.fillStyle = 'rgba(165,178,198,.75)'; ctx.fillText(s.text, x, y + (s.kind === 'high' ? -9 : 9)); }
      const evs = r.events.filter(e => e.i >= v.from - 5 && e.pi <= v.to && (p.bos || e.kind !== 'BOS')).slice(-p.max);
      for (const e of evs) {
        const x0 = idxXs(v, e.pi), x1 = idxXs(v, e.i), y = v.y(e.level); if (x0 == null || x1 == null || y == null) continue; const col = e.dir === 'UP' ? UP : DN;
        ctx.strokeStyle = hexA(col, e.kind === 'BOS' ? .65 : .95); ctx.lineWidth = e.kind === 'BOS' ? 1 : 1.4; ctx.setLineDash(e.kind === 'BOS' ? [4, 3] : []); ctx.beginPath(); ctx.moveTo(x0, y + .5); ctx.lineTo(x1, y + .5); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
        ctx.fillStyle = col; ctx.fillText(e.kind === 'BOS' ? 'BOS' : 'CHoCH', (x0 + x1) / 2, y + (e.dir === 'UP' ? -9 : 9));
      }
      ctx.textAlign = 'left';
    },
  });

  function orderBlocks(C, r, minBody) {
    const out = [];
    for (const e of r.events) {
      if (e.body < minBody) continue; const up = e.dir === 'UP'; let ob = -1;
      for (let q = e.i - 1; q >= Math.max(e.pi, e.i - 20); q--) if (up ? C[q].close < C[q].open : C[q].close > C[q].open) { ob = q; break; }
      if (ob < 0) continue; const lo = C[ob].low, hi = C[ob].high; let mit = -1;
      for (let m = e.i + 1; m < C.length; m++) if (up ? C[m].low <= hi : C[m].high >= lo) { mit = m; break; }
      out.push({ dir: e.dir, i: ob, lo, hi, mit, kind: e.kind });
    }
    return out;
  }
  reg({
    id: 'orderblocks', name: 'Order Blocks', short: 'OB', desc: 'The last opposite candle before a displacement that broke structure; shaded until price returns to it (mitigation).',
    inputs: [I.int('k', 'Swing strength', 3, 1, 10), I.float('body', 'Min displacement (ATR)', 0.6, 0, 5, 0.1), I.int('max', 'Max zones', 5, 1, 30), I.bool('mit', 'Show mitigated', false), I.color('up', 'Bullish', UP), I.color('dn', 'Bearish', DN)],
    calc: (C, p) => { const r = analyse(C, p.k, 0.6); return { obs: orderBlocks(C, r, p.body) }; },
    draw(ctx, v, p, r) {
      ctx.font = FONT; ctx.textBaseline = 'top';
      const list = r.obs.filter(o => (p.mit || o.mit < 0) && (o.mit < 0 || o.mit >= v.from) && o.i <= v.to).slice(-p.max);
      for (const o of list) {
        const x0 = v.xL(o.i), x1 = o.mit < 0 ? v.w : v.xL(o.mit), y1 = v.y(o.hi), y2 = v.y(o.lo); if ([x0, x1, y1, y2].some(q => q == null)) continue; const col = o.dir === 'UP' ? p.up : p.dn, a = o.mit < 0 ? 1 : .45;
        ctx.fillStyle = hexA(col, .14 * a); ctx.fillRect(x0, y1, Math.max(2, x1 - x0), Math.max(1, y2 - y1)); ctx.strokeStyle = hexA(col, .6 * a); ctx.strokeRect(x0 + .5, y1 + .5, Math.max(2, x1 - x0) - 1, Math.max(1, y2 - y1) - 1);
        ctx.fillStyle = hexA(col, .95 * a); ctx.fillText(o.dir === 'UP' ? 'Bull OB' : 'Bear OB', Math.max(x0, 0) + 4, y1 + 3);
      }
    },
  });

  function gaps(C, minAtr) {
    const atrA = TA.atr(C, 14), out = [];
    for (let i = 2; i < C.length; i++) {
      const a = atrA[i]; if (!TA.isN(a)) continue; let bull = C[i].low > C[i - 2].high, bear = C[i].high < C[i - 2].low; if (!bull && !bear) continue;
      let bottom = bull ? C[i - 2].high : C[i].high, top = bull ? C[i].low : C[i - 2].low; if (top - bottom < minAtr * a) continue; let filled = -1;
      for (let m = i + 1; m < C.length; m++) {
        if (bull) { top = Math.min(top, C[m].low); if (C[m].low <= bottom) { filled = m; break; } } else { bottom = Math.max(bottom, C[m].high); if (C[m].high >= top) { filled = m; break; } }
      }
      out.push({ dir: bull ? 'UP' : 'DOWN', i: i - 1, top, bottom, filled });
    }
    return out;
  }
  reg({
    id: 'fvg', name: 'Fair Value Gaps', short: 'FVG', desc: 'Three-candle imbalances, shown as the part of the gap that is still unfilled.',
    inputs: [I.float('minAtr', 'Min size (ATR)', 0.25, 0, 3, 0.05), I.int('max', 'Max gaps', 8, 1, 40), I.bool('filled', 'Show filled', false), I.color('up', 'Bullish', UP), I.color('dn', 'Bearish', DN)],
    calc: (C, p) => ({ gaps: gaps(C, p.minAtr) }),
    draw(ctx, v, p, r) {
      const list = r.gaps.filter(g => (p.filled || g.filled < 0) && (g.filled < 0 || g.filled >= v.from) && g.i <= v.to).slice(-p.max);
      for (const g of list) {
        const x0 = v.xL(g.i), x1 = g.filled < 0 ? v.w : v.xL(g.filled), y1 = v.y(g.top), y2 = v.y(g.bottom); if ([x0, x1, y1, y2].some(q => q == null)) continue; const col = g.dir === 'UP' ? p.up : p.dn;
        ctx.fillStyle = hexA(col, g.filled < 0 ? .13 : .06); ctx.fillRect(x0, y1, Math.max(2, x1 - x0), Math.max(1, y2 - y1));
      }
    },
  });
  reg({
    id: 'eqhl', name: 'Equal Highs / Lows', short: 'EQH/EQL', desc: 'Two swings at almost the same price: resting liquidity just beyond them.',
    inputs: [I.int('k', 'Swing strength', 3, 1, 10), I.float('tol', 'Tolerance (ATR)', 0.15, 0.02, 1, 0.01), I.int('max', 'Max shown', 8, 1, 40)],
    calc: (C, p) => {
      const r = analyse(C, p.k, 0.6), out = [], tol = p.tol * r.atr; const hs = r.zz.filter(x => x.kind === 'high'), ls = r.zz.filter(x => x.kind === 'low');
      for (const [arr, kind] of [[hs, 'EQH'], [ls, 'EQL']]) for (let a = 0; a < arr.length; a++) for (let b = a + 1; b < arr.length; b++) if (Math.abs(arr[a].price - arr[b].price) <= tol) { out.push({ kind, a: arr[a], b: arr[b], price: (arr[a].price + arr[b].price) / 2 }); break; }
      return { eq: out };
    },
    draw(ctx, v, p, r) {
      ctx.font = FONT; ctx.textBaseline = 'middle';
      for (const e of r.eq.filter(q => q.b.i >= v.from && q.a.i <= v.to).slice(-p.max)) {
        const x0 = v.x(e.a.i), x1 = v.x(e.b.i), y = v.y(e.price); if ([x0, x1, y].some(q => q == null)) continue; const col = e.kind === 'EQH' ? DN : UP;
        ctx.strokeStyle = hexA(col, .75); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x0, y + .5); ctx.lineTo(x1, y + .5); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.fillText(e.kind, x1 + 5, y);
      }
    },
  });
  reg({
    id: 'sweeps', name: 'Liquidity Sweeps', short: 'Sweeps', desc: 'A wick through a confirmed swing that closes back inside: a liquidity raid.',
    inputs: [I.int('k', 'Swing strength', 3, 1, 10), I.int('max', 'Max shown', 14, 1, 60)],
    calc: (C, p) => ({ sweeps: analyse(C, p.k, 0.6).sweeps }),
    draw(ctx, v, p, r) {
      ctx.font = FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const s of r.sweeps.filter(q => q.i >= v.from && q.pi <= v.to).slice(-p.max)) {
        const x0 = v.x(s.pi), x1 = v.x(s.i), yl = v.y(s.level), ye = v.y(s.extreme); if ([x0, x1, yl, ye].some(q => q == null)) continue; const col = s.dir === 'UP' ? UP : DN;
        ctx.strokeStyle = hexA(col, .45); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x0, yl + .5); ctx.lineTo(x1, yl + .5); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.fillText(s.dir === 'UP' ? '▲ sweep' : '▼ sweep', x1, ye + (s.dir === 'UP' ? 13 : -13));
      }
      ctx.textAlign = 'left';
    },
  });

  const idx = (C, t) => { let lo = 0, hi = C.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (C[m].time < t) lo = m + 1; else hi = m; } return lo; };
  reg({
    id: 'sessions', name: 'Sessions (Asia / London / NY)', short: 'Sessions', desc: 'Shaded session windows (UTC hours) with each session high / low.',
    inputs: [I.int('days', 'Days shown', 3, 1, 10), I.int('a0', 'Asia start', 0, 0, 23), I.int('a1', 'Asia end', 7, 1, 24), I.int('l0', 'London start', 7, 0, 23), I.int('l1', 'London end', 12, 1, 24), I.int('n0', 'NY start', 12, 0, 23), I.int('n1', 'NY end', 21, 1, 24), I.bool('hl', 'High / low lines', true)],
    calc: () => ({}),
    draw(ctx, v, p) {
      const C = v.C, N = v.N, last = C[N - 1].time, d1 = Math.floor(last / 86400), defs = [['ASIA', p.a0, p.a1, '#b388ff'], ['LONDON', p.l0, p.l1, '#ffb74d'], ['NY', p.n0, p.n1, '#4aa3ff']];
      ctx.font = FONT; ctx.textBaseline = 'top';
      for (let d = d1 - p.days + 1; d <= d1; d++) for (const [name, h0, h1, col] of defs) {
        const s = d * 86400 + h0 * 3600, e = Math.min(d * 86400 + h1 * 3600, last + v.tf); if (e <= s || s > last) continue;
        const x0 = v.xt(s), x1 = v.xt(e); if (x0 == null || x1 == null || x1 < 0 || x0 > v.w) continue;
        ctx.fillStyle = hexA(col, .045); ctx.fillRect(x0, 0, x1 - x0, v.h);
        const i0 = idx(C, s); let hi = -Infinity, lo = Infinity; for (let i = i0; i < N && C[i].time < e; i++) { if (C[i].high > hi) hi = C[i].high; if (C[i].low < lo) lo = C[i].low; }
        if (!isFinite(hi)) continue; ctx.fillStyle = hexA(col, .85); ctx.fillText(`${name}  ${hi.toFixed(1)} / ${lo.toFixed(1)}`, Math.max(x0, 0) + 5, 4);
        if (p.hl) for (const [pr, ] of [[hi], [lo]]) { const y = v.y(pr); if (y == null) continue; ctx.strokeStyle = hexA(col, .5); ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x0, y + .5); ctx.lineTo(x1, y + .5); ctx.stroke(); ctx.setLineDash([]); }
      }
    },
  });
  reg({
    id: 'prevlevels', name: 'Previous Day / Week Levels', short: 'Prev H/L', desc: 'Previous day high / low / close, today\'s open, and previous week high / low.',
    inputs: [I.bool('day', 'Previous day', true), I.bool('week', 'Previous week', true), I.bool('open', "Today's open", true)],
    calc: C => {
      const byDay = new Map(); for (const b of C) { const d = Math.floor(b.time / 86400); const g = byDay.get(d) || { o: b.open, h: -Infinity, l: Infinity, c: b.close, t: b.time }; g.h = Math.max(g.h, b.high); g.l = Math.min(g.l, b.low); g.c = b.close; byDay.set(d, g); }
      const days = [...byDay.keys()].sort((a, b) => a - b); if (days.length < 2) return { items: [] }; const cur = days[days.length - 1], prev = byDay.get(days[days.length - 2]), curG = byDay.get(cur), items = [];
      const wk = d => Math.floor((d + 3) / 7), curW = wk(cur), pw = days.filter(d => wk(d) === curW - 1); if (pw.length) { const hi = Math.max(...pw.map(d => byDay.get(d).h)), lo = Math.min(...pw.map(d => byDay.get(d).l)); items.push({ g: 'week', price: hi, label: 'PWH', t0: cur * 86400, c: '#8fa3c4' }, { g: 'week', price: lo, label: 'PWL', t0: cur * 86400, c: '#8fa3c4' }); }
      items.push({ g: 'day', price: prev.h, label: 'PDH', t0: cur * 86400, c: '#e8b04a' }, { g: 'day', price: prev.l, label: 'PDL', t0: cur * 86400, c: '#e8b04a' }, { g: 'day', price: prev.c, label: 'PDC', t0: cur * 86400, c: '#a89060' }, { g: 'open', price: curG.o, label: 'DO', t0: cur * 86400, c: '#9aa7b8' });
      return { items };
    },
    draw(ctx, v, p, r) {
      ctx.font = FONT; ctx.textBaseline = 'bottom'; let lastY = -99;
      const rows = r.items.filter(it => p[it.g]).map(it => ({ it, y: v.y(it.price) })).filter(q => q.y != null && q.y >= 0 && q.y <= v.h).sort((a, b) => a.y - b.y);
      for (const { it, y } of rows) {
        const x0 = Math.max(0, v.xt(it.t0) ?? 0); ctx.strokeStyle = hexA(it.c, .75); ctx.setLineDash([5, 3]); ctx.beginPath(); ctx.moveTo(x0, y + .5); ctx.lineTo(v.w, y + .5); ctx.stroke(); ctx.setLineDash([]);
        const ly = Math.max(y - 2, lastY + 12); lastY = ly; ctx.fillStyle = hexA(it.c, .95); ctx.fillText(`${it.label} ${it.price.toFixed(2)}`, x0 + 5, ly);       // labels never stack on top of each other
      }
    },
  });
  const LEVELS = [0, .236, .382, .5, .618, .786, 1];
  reg({
    id: 'fib', name: 'Auto Fibonacci Retracement', short: 'Fib', desc: 'Retracement levels of the latest confirmed swing leg.',
    inputs: [I.int('k', 'Swing strength', 4, 1, 12), I.float('minAtr', 'Min swing (ATR)', 1.5, 0, 10, 0.1), I.color('color', 'Color', '#e8b04a')],
    calc: (C, p) => { const r = analyse(C, p.k, p.minAtr); const z = r.zz; return z.length < 2 ? {} : { a: z[z.length - 2], b: z[z.length - 1] }; },
    draw(ctx, v, p, r) {
      if (!r.a) return; ctx.font = FONT; ctx.textBaseline = 'bottom'; const x0 = Math.max(0, v.x(r.a.i) ?? 0), yg1 = v.y(r.b.price + (r.a.price - r.b.price) * .5), yg2 = v.y(r.b.price + (r.a.price - r.b.price) * .618);
      if (yg1 != null && yg2 != null) { ctx.fillStyle = hexA(p.color, .07); ctx.fillRect(x0, Math.min(yg1, yg2), v.w - x0, Math.abs(yg2 - yg1)); }
      for (const l of LEVELS) { const price = r.b.price + (r.a.price - r.b.price) * l, y = v.y(price); if (y == null || y < 0 || y > v.h) continue; ctx.strokeStyle = hexA(p.color, l === .5 || l === .618 ? .8 : .45); ctx.setLineDash(l === 0 || l === 1 ? [] : [4, 4]); ctx.beginPath(); ctx.moveTo(x0, y + .5); ctx.lineTo(v.w, y + .5); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = hexA(p.color, .95); ctx.fillText(`${l}  ${price.toFixed(2)}`, x0 + 5, y - 2); }
    },
  });
  reg({
    id: 'premdisc', name: 'Premium / Discount', short: 'P/D', desc: 'Splits the latest swing range at its midpoint: sell from premium, buy from discount.',
    inputs: [I.int('k', 'Swing strength', 4, 1, 12), I.float('minAtr', 'Min swing (ATR)', 1.5, 0, 10, 0.1)],
    calc: (C, p) => { const r = analyse(C, p.k, p.minAtr), h = lastKind(r.zz, 'high'), l = lastKind(r.zz, 'low'); return h && l ? { hi: h, lo: l } : {}; },
    draw(ctx, v, p, r) {
      if (!r.hi) return; const x0 = Math.max(0, v.x(Math.min(r.hi.i, r.lo.i)) ?? 0), eq = (r.hi.price + r.lo.price) / 2, yh = v.y(r.hi.price), ye = v.y(eq), yl = v.y(r.lo.price); if ([yh, ye, yl].some(q => q == null)) return;
      ctx.fillStyle = hexA(DN, .06); ctx.fillRect(x0, yh, v.w - x0, ye - yh); ctx.fillStyle = hexA(UP, .06); ctx.fillRect(x0, ye, v.w - x0, yl - ye);
      ctx.strokeStyle = 'rgba(190,200,215,.55)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x0, ye + .5); ctx.lineTo(v.w, ye + .5); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = FONT; ctx.textBaseline = 'top'; ctx.fillStyle = hexA(DN, .9); ctx.fillText('PREMIUM', x0 + 5, yh + 4); ctx.textBaseline = 'bottom'; ctx.fillStyle = hexA(UP, .9); ctx.fillText('DISCOUNT', x0 + 5, yl - 4); ctx.fillStyle = 'rgba(200,208,220,.8)'; ctx.fillText(`EQ ${eq.toFixed(2)}`, x0 + 5, ye - 3);
    },
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = { analyse, orderBlocks, gaps };
})();
