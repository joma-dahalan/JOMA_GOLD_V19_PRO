## V19 — Gold Intelligence Terminal (2026-10-17)

- Corrected release metadata across the app and diagnostics.
- Added freshness-aware `/api/health` fields for market-data status, source freshness, engine age, and analysis readiness while keeping API liveness distinct from data readiness.
- Replaced silent background engine/history failures with structured log output and exposed the latest runtime errors through diagnostics.
- Added a decision-state summary in Studio Overview: bias/wait/no-trade state, data-quality score, normalized flow/book/trend factors, and liquidity references.
- Feed status now reflects freshness rather than the provider's last `ok` flag alone; provider messages are escaped before HTML rendering. Stale reference prices are cleared when all market sources expire.
- Verification: 23 Python tests and 32 JavaScript tests pass. No live-feed connectivity or trading performance is claimed by unit tests.

## V18 — Research Eleven (2026-10-16)

- Added a new **Research 11** Studio section with 11 activation controls and explicit source/limitation labels.
- Added seven independent indicators: rolling historical tick-volume density/Pulse Research, regime blocks/Saga Research, confirmed pivot lines/Binary Research, ATR shelter/Umbrella Research, squeeze oscillator/Binlex Research, dual momentum cloud/Aurora Research, and prior-range breakout with retests/Breakout Research.
- Integrated four existing layers/modules into the Research 11 catalogue, preserving the recorded-data-only policy. The catalogue is a **functional research comparison**, not a clone or unlock of any paid site.
- Improved sidebar tabs at small widths, plus scroll reset on tab changes.
- Added additional math, causality, volume conservation, and signal-completion tests for the new work.
- Browser QA on desktop and mobile using fabricated candle data solely in the isolated QA harness; **no synthetic data in the shipped application**.

# V17 — Market Studio (2026-10-16)

- New responsive Studio tabs: Overview, Footprint, Depth, Levels and Layouts.
- Independent broker-tick-density and EMA/ATR indicators; source and limitations clearly labeled.
- Historical public-venue flow Footprint API with optional broker candle alignment and session-gap filtering; chart overlay and three view modes.
- Fresh snapshot-only depth and zones; local threshold watches and workspace presets.
- QA: 21 Python tests + 27 JavaScript tests and isolated 1440px/390px browser checks. No production venue data was simulated.
- See `docs/STUDIO_GUIDE_AR.md` for operation, scope, limitations and source links.

# v16 — one tidy platform
- Single project folder: `frontend/css`, `frontend/js` (core + indicator framework + library), `docs`, `tests`; one README, one config.
- NEW indicator platform: library dialog, chip bar (show / hide / settings / remove), settings popovers, sub-panes, canvas overlays, persistence, custom indicators in one file.
- NEW library: 29 original indicators (trend, momentum, volume, market structure / SMC) + 5 liquidity layers (heatmap, live profile, large trades, delta & CVD, OANDA client orders). The old Layers menu is replaced by the library.
- Tests: indicator math (incl. Wilder RSI worked example), no-look-ahead guarantee, structure logic (`python tests/run_all.py`).
- Fix: sub-panes no longer assume a fixed pane index; the order-flow title follows its pane.

# v15.1 — visual density pass
- Live liquidity profile on the right edge (depth now, bid/ask), with only the walls that matter labelled: nearest ask above, nearest bid below, and a clearly larger one (≥35% of the biggest, ≥ $250K) with distance and ABS flag.
- Removed full-width wall lines and the floating legend box; all meta moved to a slim info strip (hover OHLC, book ±$10 imbalance, heat scale, flow status, feeds popover).
- Liquidity history only draws once enough is recorded to read as a map (≥ 10 min and ≥ 3 candles); before that the strip says how much is recorded.
- Delta/CVD pane appears only with ≥ 3 candles of data; CVD no longer extends flat past the last real data point.
- Calmer transparent colour ramp (candles stay dominant); fixed scale unchanged.
- Bubbles capped at 30, no overlapping labels. Bigger type, two-row mobile header.
- API: /api/book (latest recorded order-book column).

# v15.0
- UI rebuilt: clean default screen, minimal toolbar (timeframes + Tools + Layers + Settings).
- NEW Measure tool: drag a box → resting liquidity (average / peak / largest level / bid-ask split), executed buy/sell/delta, OANDA client-order share, range and duration — recorded data only.
- NEW fixed-$ heat scale with a colour legend (auto-calibrated once per load, or choose $500K…$25M); no per-frame rescaling.
- NEW calm trade bubbles: fixed $ size scale, one per candle × price bucket, snapped to the candle grid, overlap-culled, labelled.
- NEW Delta + CVD pane under the chart (bars = buy−sell per candle, line = running CVD) instead of a line over the candles.
- NEW Top-5 walls with size labels, hover readout of resting liquidity under the cursor, feeds status pill.
- API: /api/delta, /api/flow/range.

# v14.0
- NEW: OANDA v20 source (pricing stream, candles, order/position books) — works on Windows/Linux/macOS without MT5.
- NEW: broker price priority (`price.priority`); every other venue is aligned to the chosen broker price; MT5 is no longer special-cased.
- NEW: persistent history (SQLite): aligned order-book columns every 5 s (72 h), executed-flow rows, OANDA book snapshots.
- NEW: UI — recorded-book heat, OANDA client-order layer, bubbles (click for momentum/volume), CVD, LONG/SHORT tool with live P&L.
- FIX: live candle merge, market-gap-safe time→x mapping, canvas redraw on pan/zoom/resize.
- REMOVED: nothing is estimated from candle volume any more; empty history stays empty.

# v13 — Web Ultimate

Compared with the previous web v12:

- Replaced Binance/Kraken REST polling with WebSocket-first collectors.
- Added executed trades to the analysis engine.
- Added Binance PAXG spot alongside XAUUSDT futures.
- Added Kraken XAUT/PAXG feeds.
- Added OKX XAUT/PAXG feeds.
- Bitfinex R0 now includes public trades and checksum validation.
- Added robust rolling basis alignment to MT5.
- Added multi-range Near/Mid/Far/Deep zone reservation from v8.2 design.
- Added execution-against, replenishment, absorption evidence, stability and fleeting penalties.
- Reintroduced v8.2-style flow/book/trend directional bias as a separate layer from liquidity-quality score.
- Added SQLite replay data for metrics/bias/basis.
- Kept the minimal fullscreen TradingView-style UI.
