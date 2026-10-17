# Adding your own indicator

An indicator is one small JavaScript file. Copy `frontend/js/indicators/custom/example.js`, edit it, and add one line to `frontend/index.html` next to the other `<script>` tags. It then appears in **Indicators → Custom**.

```js
(() => {
  const J = window.JG, { I, hexA } = J.kit, TA = J.ta;           // I = input helpers, TA = math library
  J.registerIndicator({
    id: 'myema', name: 'My EMA', group: 'Custom', desc: 'One line shown in the library.',
    kind: 'overlay',                                             // 'overlay' (on the price), 'pane' (own pane below), 'canvas' (you draw)
    inputs: [ I.int('len', 'Length', 21, 1, 500), I.color('color', 'Color', '#4aa3ff') ],
    calc(C, p) {                                                 // C = closed + forming candles {time, open, high, low, close, volume}
      return { lines: [ { data: TA.ema(C.map(b => b.close), p.len), color: p.color, width: 2 } ] };
    },
  });
})();
```

## What `calc` may return (overlay and pane kinds)

| Key | Meaning |
|---|---|
| `lines: [{data, color, width, style, points}]` | `data` has one value per candle (use `null` for gaps). `style` 0 solid, 1 dotted, 2 dashed. `points: true` draws dots (SAR-style). |
| `hist: [{data, colors, color}]` | Histogram bars; optional per-bar `colors`. |
| `levels: [{price, color, title}]` | Horizontal reference lines in a pane (e.g. RSI 70 / 30). |
| `bounds: [min, max]` | Fixed scale for a pane (e.g. `[0, 100]`). |
| `fills: [{a, b, color, colorDown}]` | Shade between two arrays on the price chart (bands, clouds). Arrays may be longer than `C` to project into the future. |

## Canvas indicators

Set `kind: 'canvas'` and add `draw(ctx, v, params, result)`. `result` is what `calc` returned. The view `v` gives you: `v.x(i)` / `v.xL(i)` (centre / left edge of candle *i*), `v.xt(unixSeconds)`, `v.y(price)`, `v.w`, `v.h`, `v.from`, `v.to` (visible candle range), `v.C`, `v.N`, `v.tf`. Always return early when a coordinate is `null`.

## Rules we hold ourselves to

1. **No look-ahead.** Value *i* may only use candles ≤ *i*. The test-suite checks this for the built-in library (`tests/js/test_library.js`).
2. Use the inputs for every number a user might want to change; give each a sensible default inside its min/max.
3. Say what the indicator is in `desc`. If it uses volume, remember it is broker tick volume.
4. Run `python tests/run_all.py` before shipping.
