/* Indicator framework: registry, series/pane management, canvas drawing, chips, settings popover, library dialog.
   An indicator is a plain object (see docs/ADDING_INDICATORS.md). The framework never computes anything itself. */
(() => {
  'use strict';
  const J = window.JG, TA = window.JGTA, $ = id => document.getElementById(id);
  const REG = new Map(), CATS = ['Trend', 'Momentum', 'Volume', 'Structure', 'Liquidity', 'Research', 'Custom'], KEY = 'jg16_ind';
  let inst = [], uidSeq = 1, timer = 0, lastRun = 0;

  // ------------------------------------------------------------------ public helpers for indicator authors
  const { I, SRC, hexA } = window.JGKIT;
  J.I = I; J.SRC = SRC; J.hexA = hexA; J.ta = TA; J.kit = window.JGKIT;
  J.registerIndicator = def => { if (!def.id || !def.name) throw new Error('indicator needs id and name'); REG.set(def.id, Object.assign({ group: 'Custom', kind: 'overlay', inputs: [], desc: '' }, def)); };

  const defaults = def => Object.fromEntries(def.inputs.map(i => [i.k, i.d]));
  const label = it => { const sum = it.def.inputs.filter(i => i.t === 'int' || i.t === 'float').slice(0, 3).map(i => it.params[i.k]).join(', '); return `${it.def.short || it.def.name}${sum ? ' ' + sum : ''}`; };

  // ------------------------------------------------------------------ series management
  const timeAt = i => { const C = J.state.candles, N = C.length, tf = J.TF[J.state.tf]; return i < N ? C[i].time : C[N - 1].time + (i - (N - 1)) * tf; };
  function toData(arr, colors) {                                       // null → whitespace so lines break (supertrend, SAR) instead of connecting
    let f = -1, l = -1; for (let i = 0; i < arr.length; i++) if (TA.isN(arr[i])) { if (f < 0) f = i; l = i; }
    const out = []; if (f < 0) return out;
    for (let i = f; i <= l; i++) { const v = arr[i]; out.push(TA.isN(v) ? (colors && colors[i] ? { time: timeAt(i), value: v, color: colors[i] } : { time: timeAt(i), value: v }) : { time: timeAt(i) }); }
    return out;
  }
  function destroy(it) { for (const s of it.series || []) { try { J.chart.removeSeries(s); } catch (e) { /* already gone */ } } it.series = []; it.levels = []; it.sig = ''; }
  function build(it, res) {
    destroy(it); const own = it.def.kind === 'pane', C = LightweightCharts;
    const specs = [...(res.hist || []).map(h => ({ t: 'hist', s: h })), ...(res.lines || []).map(l => ({ t: 'line', s: l }))];
    let pane = own ? J.chart.panes().length : 0;
    specs.forEach((x, n) => {
      const common = { priceLineVisible: false, lastValueVisible: own && n === 0, crosshairMarkerVisible: false };
      if (own && n === 0 && res.bounds) common.autoscaleInfoProvider = () => ({ priceRange: { minValue: res.bounds[0], maxValue: res.bounds[1] } });
      const s = x.t === 'hist'
        ? J.chart.addSeries(C.HistogramSeries, { ...common, color: x.s.color || '#6b7a90', base: 0 }, pane)
        : J.chart.addSeries(C.LineSeries, { ...common, color: x.s.color || '#6b7a90', lineWidth: x.s.width || 2, lineStyle: x.s.style || 0, lineVisible: !x.s.points, pointMarkersVisible: !!x.s.points, pointMarkersRadius: 2 }, pane);
      if (own && n === 0) pane = s.getPane().paneIndex();
      it.series.push(s);
    });
    it.sig = specs.map(x => x.t).join(','); it.priceLines = []; it.levelSig = '';
    if (own) setTimeout(() => { J.chart.panes().forEach((p, i) => { if (i > 0) p.setHeight(Math.max(84, Math.min(170, Math.round($('chartShell').clientHeight * 0.17)))); }); J.requestDraw(); }, 0);
  }
  function applySeries(it) {
    const res = it.res, specs = [...(res.hist || []).map(h => ({ t: 'hist', s: h })), ...(res.lines || []).map(l => ({ t: 'line', s: l }))], sig = specs.map(x => x.t).join(',');
    if (it.sig !== sig || !it.series.length) build(it, res);
    specs.forEach((x, n) => { const s = it.series[n]; s.setData(toData(x.s.data, x.s.colors)); s.applyOptions({ visible: it.visible, color: x.s.color || undefined }); });
    if (it.def.kind === 'pane' && it.series[0]) {
      const sig2 = JSON.stringify(res.levels || []); if (sig2 !== it.levelSig) {
        for (const p of it.priceLines) it.series[0].removePriceLine(p); it.priceLines = [];
        for (const l of res.levels || []) it.priceLines.push(it.series[0].createPriceLine({ price: l.price, color: l.color || '#4a5568', lineWidth: 1, lineStyle: l.style ?? 2, axisLabelVisible: false, title: l.title || '' }));
        it.levelSig = sig2;
      }
    }
  }
  function refreshOne(it) {
    const C = J.state.candles; if (C.length < 5) return;
    try { it.res = it.def.calc(C, it.params, J); it.error = null; if (it.def.kind !== 'canvas' && it.res) applySeries(it); } catch (e) { it.error = String(e.message || e); console.error('indicator', it.def.id, e); }
  }
  const refreshAll = () => { lastRun = Date.now(); inst.forEach(refreshOne); J.requestDraw(); };
  function onCandles(full) {
    if (!inst.length) return;
    if (full) { clearTimeout(timer); timer = 0; refreshAll(); return; }
    if (!timer) timer = setTimeout(() => { timer = 0; refreshAll(); }, Math.max(100, 1000 - (Date.now() - lastRun)));
  }

  // ------------------------------------------------------------------ canvas drawing (fills + canvas-kind indicators)
  function makeView(w, h) {
    const ts = J.chart.timeScale(), vr = ts.getVisibleLogicalRange(), C = J.state.candles, N = C.length, tf = J.TF[J.state.tf];
    return { w, h, C, N, tf, from: Math.max(0, Math.floor(vr ? vr.from : 0)), to: Math.min(N + 60, Math.ceil(vr ? vr.to : N)), x: i => J.lx(i), xL: i => J.lx(i - 0.5), xt: J.xOfSec, y: J.yOf, T: timeAt, ta: TA, hexA };
  }
  function drawFills(ctx, v, fills) {
    for (const f of fills) {
      const len = Math.min(f.a.length, f.b.length);
      for (let i = v.from; i < Math.min(len - 1, v.to + 1); i++) {
        const a0 = f.a[i], a1 = f.a[i + 1], b0 = f.b[i], b1 = f.b[i + 1]; if (![a0, a1, b0, b1].every(TA.isN)) continue;
        const x0 = v.x(i), x1 = v.x(i + 1), ya0 = v.y(a0), ya1 = v.y(a1), yb0 = v.y(b0), yb1 = v.y(b1); if ([x0, x1, ya0, ya1, yb0, yb1].some(q => q == null)) continue;
        ctx.fillStyle = f.colorDown && a0 < b0 ? f.colorDown : f.color; ctx.beginPath(); ctx.moveTo(x0, ya0); ctx.lineTo(x1 + 0.6, ya1); ctx.lineTo(x1 + 0.6, yb1); ctx.lineTo(x0, yb0); ctx.closePath(); ctx.fill();
      }
    }
  }
  function onDraw(ctx, w, h) {
    if (!inst.length) return; const v = makeView(w, h); if (v.N < 5) return;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    for (const it of inst) {
      if (!it.visible || !it.res) continue;
      try { if (it.res.fills) drawFills(ctx, v, it.res.fills); if (it.def.draw) { ctx.save(); it.def.draw(ctx, v, it.params, it.res); ctx.restore(); } } catch (e) { console.error('indicator draw', it.def.id, e); }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ persistence + instances
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(inst.map(i => ({ id: i.def.id, params: i.params, visible: i.visible })))); } catch (e) { /* private mode */ } };
  function add(id, params, visible = true) {
    const def = REG.get(id); if (!def) return null;
    const it = { uid: uidSeq++, def, params: Object.assign(defaults(def), params || {}), visible, series: [], priceLines: [], res: null }; inst.push(it); J.indicators = inst;
    refreshOne(it); renderBar(); save(); J.requestDraw(); return it;
  }
  function remove(uid) { const k = inst.findIndex(i => i.uid === uid); if (k < 0) return; destroy(inst[k]); inst.splice(k, 1); closePop(); renderBar(); save(); J.requestDraw(); }
  function restore() { try { for (const r of JSON.parse(localStorage.getItem(KEY) || '[]')) if (REG.has(r.id)) { const def = REG.get(r.id); inst.push({ uid: uidSeq++, def, params: Object.assign(defaults(def), r.params || {}), visible: r.visible !== false, series: [], priceLines: [], res: null }); } } catch (e) { /* corrupt */ } J.indicators = inst; }

  // ------------------------------------------------------------------ chips bar + settings popover
  function swatch(it) { const l = it.res && ((it.res.lines || [])[0] || (it.res.hist || [])[0]); return (l && l.color) || it.params.color || '#6b7a90'; }
  function renderBar() {
    const bar = $('indBar'), n = inst.length; $('indCount').textContent = n ? n : ''; $('app').classList.toggle('has-ind', n > 0); bar.classList.toggle('hidden', !n);
    bar.innerHTML = inst.map(it => `<span class="ichip${it.visible ? '' : ' off'}${it.error ? ' err' : ''}" data-uid="${it.uid}" title="${it.error ? 'Error: ' + it.error : it.def.desc}"><i class="sw" style="background:${swatch(it)}"></i><b>${label(it)}</b><button data-act="eye" title="Show / hide">${it.visible ? '◉' : '○'}</button><button data-act="gear" title="Settings">⚙</button><button data-act="x" title="Remove">×</button></span>`).join('');
  }
  function closePop() { $('indPop').classList.add('hidden'); $('indPop').dataset.uid = ''; }
  function openPop(it, anchor) {
    const pop = $('indPop'), r = anchor.getBoundingClientRect();
    pop.dataset.uid = it.uid;
    pop.innerHTML = `<div class="ip-h"><b>${it.def.name}</b><span>${it.def.desc}</span></div>` + it.def.inputs.map(inp => {
      const v = it.params[inp.k];
      const ctl = inp.t === 'select' ? `<select data-k="${inp.k}">${inp.opts.map(o => `<option${o === v ? ' selected' : ''}>${o}</option>`).join('')}</select>`
        : inp.t === 'bool' ? `<input type="checkbox" data-k="${inp.k}"${v ? ' checked' : ''}>` : inp.t === 'color' ? `<input type="color" data-k="${inp.k}" value="${v}">`
        : `<input type="number" data-k="${inp.k}" value="${v}" min="${inp.min}" max="${inp.max}" step="${inp.step || 1}">`;
      return `<label><span>${inp.l}</span>${ctl}</label>`;
    }).join('') + `<div class="ip-f"><button data-act="reset">Reset</button><button data-act="remove" class="danger">Remove</button></div>`;
    pop.classList.remove('hidden'); pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
  }
  let popTimer = 0;
  $('indPop').addEventListener('input', e => {
    const it = inst.find(i => String(i.uid) === $('indPop').dataset.uid), k = e.target.dataset.k; if (!it || !k) return;
    const inp = it.def.inputs.find(x => x.k === k); let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (inp.t === 'int') v = Math.max(inp.min, Math.min(inp.max, parseInt(v, 10) || inp.d)); else if (inp.t === 'float') v = Math.max(inp.min, Math.min(inp.max, parseFloat(v) || inp.d));
    it.params[k] = v; clearTimeout(popTimer); popTimer = setTimeout(() => { refreshOne(it); renderBar(); save(); J.requestDraw(); }, 150);
  });
  $('indPop').addEventListener('click', e => {
    const act = e.target.dataset.act, it = inst.find(i => String(i.uid) === $('indPop').dataset.uid); if (!it || !act) return;
    if (act === 'remove') remove(it.uid); else if (act === 'reset') { it.params = defaults(it.def); refreshOne(it); renderBar(); save(); J.requestDraw(); openPop(it, document.querySelector(`.ichip[data-uid="${it.uid}"]`)); }
  });
  $('indBar').addEventListener('click', e => {
    const chip = e.target.closest('.ichip'); if (!chip) return; const it = inst.find(i => i.uid === +chip.dataset.uid), act = e.target.dataset.act; if (!it) return;
    if (act === 'x') remove(it.uid); else if (act === 'eye') { it.visible = !it.visible; if (it.series.length) applySeries(it); renderBar(); save(); J.requestDraw(); }
    else if (act === 'gear' || !act) { $('indPop').dataset.uid === String(it.uid) && !$('indPop').classList.contains('hidden') ? closePop() : openPop(it, chip); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('#indPop') && !e.target.closest('.ichip')) closePop(); });

  // ------------------------------------------------------------------ library dialog
  const BUILTINS = [
    { key: 'heatOn', name: 'Liquidity Heatmap', desc: 'Resting order-book dollars over time, from books this server recorded. Fixed $ colour scale.' },
    { key: 'wallsOn', name: 'Liquidity Profile', desc: 'Live resting depth at the right edge, with the nearest bid / ask walls labelled.' },
    { key: 'bubOn', name: 'Large Trades', desc: 'Large executed buy / sell prints on gold-linked venues, fixed dollar size scale.' },
    { key: 'flowOn', name: 'Delta & CVD', desc: 'Buy − sell per candle (bars) and the running CVD (line) in a pane below.' },
    { key: 'oandaOn', name: 'OANDA Client Orders', desc: "Share of OANDA clients' pending orders / positions per price level (~20 min snapshots)." },
  ];
  let cat = 'All', query = '';
  function renderList() {
    const q = query.trim().toLowerCase(), live = J.layers();
    const cats = ['All', ...CATS.filter(c => c === 'Liquidity' || [...REG.values()].some(d => d.group === c))];
    $('indCats').innerHTML = cats.map(c => `<button data-cat="${c}" class="${c === cat ? 'on' : ''}">${c}</button>`).join('');
    const rows = [];
    for (const b of BUILTINS) if ((cat === 'All' || cat === 'Liquidity') && (!q || (b.name + b.desc).toLowerCase().includes(q))) rows.push(`<div class="irow"><div><b>${b.name}</b><span>${b.desc}</span></div><div class="irtag">Liquidity · built-in</div><button class="sw ${live[b.key] ? 'on' : ''}" data-b="${b.key}">${live[b.key] ? 'On' : 'Off'}</button></div>`);
    for (const d of REG.values()) {
      if (cat !== 'All' && d.group !== cat) continue; if (q && !(d.name + d.desc + d.id + d.group).toLowerCase().includes(q)) continue;
      const n = inst.filter(i => i.def.id === d.id).length;
      rows.push(`<div class="irow"><div><b>${d.name}</b><span>${d.desc}</span></div><div class="irtag">${d.group} · ${d.kind === 'pane' ? 'pane' : 'on chart'}</div><button class="add" data-add="${d.id}">${n ? `Add another (${n})` : 'Add'}</button></div>`);
    }
    $('indList').innerHTML = rows.join('') || '<div class="iempty">No indicator matches your search.</div>';
  }
  const openModal = () => { $('indModal').classList.remove('hidden'); renderList(); setTimeout(() => $('indSearch').focus(), 30); };
  const closeModal = () => $('indModal').classList.add('hidden');
  $('indBtn').onclick = openModal; $('indClose').onclick = closeModal;
  $('indModal').addEventListener('click', e => { if (e.target === $('indModal')) closeModal(); });
  $('indSearch').addEventListener('input', e => { query = e.target.value; renderList(); });
  $('indCats').addEventListener('click', e => { const c = e.target.dataset.cat; if (c) { cat = c; renderList(); } });
  $('indList').addEventListener('click', e => {
    const a = e.target.dataset.add, b = e.target.dataset.b;
    if (a) { add(a); renderList(); } else if (b) { J.setLayer(b, !J.layers()[b]); renderList(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closePop(); } });

  J.boot = () => {
    restore(); renderBar(); J.hooks.candles.push(onCandles); J.hooks.draw.push(onDraw); J.hooks.layer.push(() => { if (!$('indModal').classList.contains('hidden')) renderList(); });
    if (J.state.candles.length) refreshAll();
  };
  J._core = { add, remove, instances: () => inst, REG };
})();
