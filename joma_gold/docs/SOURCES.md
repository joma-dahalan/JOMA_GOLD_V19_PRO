# Official data/API references

Verified against public documentation around 2026-09-19.

## MetaTrader 5 Python
- Python integration: https://www.mql5.com/en/docs/python_metatrader5
- Latest tick: https://www.mql5.com/en/docs/python_metatrader5/mt5symbolinfotick_py
- Market book: https://www.mql5.com/en/docs/python_metatrader5/mt5marketbookget_py

## Binance
- USD-M Futures WebSocket subscriptions: https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Live-Subscribing-Unsubscribing-to-streams
- Spot WebSocket streams: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams

## Bitfinex
- Raw Books R0: https://docs.bitfinex.com/reference/ws-public-raw-books
- Public Trades: https://docs.bitfinex.com/reference/ws-public-trades
- WebSocket Checksum: https://docs.bitfinex.com/docs/ws-websocket-checksum

## Kraken
- API Center: https://docs.kraken.com/api/
- WebSocket v2 market-data documentation is available from Kraken API Center.

## OKX
- API v5 / public WebSocket: https://www.okx.com/docs-v5/en/

## Chart library
- TradingView Lightweight Charts: https://tradingview.github.io/lightweight-charts/

Notes:
- Public exchange availability and symbol availability can vary by region and can change.
- The application reports feed failures in `/api/health`; it does not silently substitute fabricated data.


## OANDA (v14)
- Pricing stream: `GET {stream}/v3/accounts/{id}/pricing/stream?instruments=XAU_USD` — bid/ask/mid reference price.
- Candles: `GET {api}/v3/instruments/XAU_USD/candles` (volume = tick count, not traded volume).
- Order book / position book: `GET .../orderBook`, `.../positionBook` — client order/position distribution by price bucket, ~20 min snapshots. Percentages of order/position *count*.
