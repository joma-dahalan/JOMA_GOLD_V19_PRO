# JOMA GOLD — Gold Intelligence Terminal V19

A chart-first gold (XAUUSD) research terminal built around your broker price (OANDA or MT5), an indicator library, recorded venue observations, and an explicit market-data readiness report. No synthetic market observations are injected into the running application.

عربي: منصة شارت واحدة مرتبة للذهب، بسعر وسيطك (OANDA أو MT5)، مع مكتبة مؤشرات، وسيولة مسجلة فعلاً. الشرح الكامل بالعربي: `docs/README_AR.md`.

## V19 — Professional reliability pass

- Corrected the release/version labels and the system-diagnostics banner.
- `/api/health` now separates API liveness from live market-data readiness, reports stale/fresh sources, engine age, analysis readiness, and background storage/engine errors.
- The engine and history flusher log failures instead of silently swallowing them.
- The Studio overview now surfaces the engine's decision state, data quality, normalized confluence inputs, and liquidity references while explicitly avoiding probability/entry claims.
- Feed details show freshness and safely escape provider messages before rendering them in the UI.
- Verification in this archive: 23 Python tests and 32 JavaScript tests pass. Live broker/provider connectivity remains environment-dependent and must be verified on the target machine.

## Run

1. Install Python 3.10+ (64-bit). Windows: double-click `install.bat`, then `start.bat`. Linux/macOS: `pip install -r requirements.txt && ./start.sh`.
2. Put your broker credentials in **`config.local.json`** (copy `config.local.json.example`; this file is never shared):
   ```json
   {"oanda": {"token": "YOUR_OANDA_TOKEN", "account_id": "101-001-XXXXXXX-001"}}
   ```
   MT5 (Windows): keep the terminal open and logged in; the symbol is auto-detected.
3. Run `doctor.bat` (or `python doctor.py`) to check the connection. Open <http://127.0.0.1:8080>.

## What's on the screen

| Area | What it does |
|---|---|
| **Indicators** (`ƒx`) | Library of 38 indicators + 5 liquidity layers. Add, tweak (⚙), hide or remove from the chip bar. Your set is remembered. |
| **Tools** | Measure box (liquidity / flow / OANDA inside a rectangle), Long / Short planner, Replay. |
| **Strip** | Hover OHLC, order-book imbalance ±$10, liquidity colour scale, feed status. |
| **Right edge** | Live liquidity profile with the nearest bid / ask walls. |

**Base Studio V17:** click **◈ Studio** for a responsive research dashboard with recorded-flow Footprint (Classic/Delta/Volume), a fresh-depth ladder, liquidity zones, local price level watches, and saved layout presets. Two original indicators were added: **Tick Density** (broker tick volume approximation) and **EMA/ATR Ribbon**. These are *independent approximations*, not indtrade proprietary algorithms. Full feature/data guide: `docs/STUDIO_GUIDE_AR.md`.

**Research Eleven (introduced in V18):** chart-based collection with seven new, independently programmed studies and entry controls for four existing flow/depth modules. The eleven entries reference public product names solely to compare categories, and are **not identical substitutes for any proprietary paid indicators**. Go to **◈ Studio → Research 11**, use each toggle, and configure chart studies from their ⚙ chip. See `docs/RESEARCH_ELEVEN_AR.md` for a full source-by-source audit.

Indicators: trend (SMA, EMA, WMA, Hull, VWAP, Bollinger, Keltner, Donchian, Supertrend, Parabolic SAR, Ichimoku), momentum (RSI, MACD, Stochastic, CCI, ATR, ADX), volume (Volume, OBV, Volume Profile), structure (Market Structure BOS/CHoCH, Order Blocks, Fair Value Gaps, Equal Highs/Lows, Liquidity Sweeps, Sessions, Previous Day/Week levels, Auto Fibonacci, Premium/Discount).
Liquidity layers: Heatmap, Profile, Large Trades, Delta & CVD, OANDA client orders.
Research studies: Pulse Research, Saga Research, Binary Lines Research, Umbrella Research, Binlex Research, Aurora Research, Breakout Research.

Add your own indicator in one small file: `docs/ADDING_INDICATORS.md`.

## Honest notes

- Indicators are our own implementations of standard, public formulas — not copies of any commercial script. Volume means the broker's **tick volume**.
- Liquidity comes from the order books of gold-linked venues (shifted onto your broker's price) and OANDA's client-order book. Spot gold has no public order book; these are proxies, labelled as such. History only exists from the moment the server started recording.
- It is an analysis tool, not financial advice. There is no auto-trading.

## Folders

```
app.py  doctor.py  config.json  config.local.json (yours)   start.bat  start.sh  install.bat
backend/    price sources (OANDA, MT5, venues), liquidity engine, recorder, history store
frontend/   index.html · css/ · js/app.js (chart + liquidity) · js/indicators/ (framework + library) · vendor/
tests/      python tests + tests/js (indicator math) — run:  python tests/run_all.py
docs/       README_AR.md · STUDIO_GUIDE_AR.md · RESEARCH_ELEVEN_AR.md · ADDING_INDICATORS.md · SOURCES.md · CHANGELOG.md
data/       recorded history (created automatically)
```
