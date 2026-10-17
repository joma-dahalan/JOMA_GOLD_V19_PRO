from __future__ import annotations

import asyncio
import platform
import time
from .state import SharedState, SourceSnapshot, now_ms


class MT5Source:
    """Local MT5 bridge.

    MT5 is used as the chart/reference-price axis. Broker DOM is included only
    when the connected broker actually publishes it. The module never fabricates
    an order book when DOM is absent.
    """

    def __init__(self, state: SharedState, cfg: dict):
        self.state = state
        self.cfg = cfg
        self.mt5 = None
        self.symbol = None
        self.subscribed_book = False
        self._last_candles = 0.0

    def _load(self):
        if platform.system() != "Windows":
            raise RuntimeError("MetaTrader5 Python package requires Windows + installed MT5 terminal")
        import MetaTrader5 as mt5
        self.mt5 = mt5

    def _choose_symbol(self):
        target = str(self.cfg.get("symbol") or "AUTO").strip()
        if target.upper() != "AUTO":
            info = self.mt5.symbol_info(target)
            if info is not None:
                return target
        symbols = self.mt5.symbols_get() or []
        names = [s.name for s in symbols]
        exact = ["XAUUSD", "GOLD", "XAUUSDm", "XAUUSD.a", "XAUUSDpro", "XAUUSD."]
        for p in exact:
            for n in names:
                if n.upper() == p.upper():
                    return n
        candidates = [n for n in names if "XAU" in n.upper() and "USD" in n.upper()]
        if candidates:
            candidates.sort(key=lambda x: (len(x), x))
            return candidates[0]
        gold = [n for n in names if "GOLD" in n.upper()]
        return gold[0] if gold else None

    def _connect_blocking(self):
        self._load()
        path = str(self.cfg.get("terminal_path") or "").strip()
        ok = self.mt5.initialize(path) if path else self.mt5.initialize()
        if not ok:
            raise RuntimeError(f"mt5.initialize failed: {self.mt5.last_error()}")
        self.symbol = self._choose_symbol()
        if not self.symbol:
            raise RuntimeError("No XAUUSD/GOLD symbol found in the connected MT5 terminal")
        if not self.mt5.symbol_select(self.symbol, True):
            raise RuntimeError(f"Could not select {self.symbol}: {self.mt5.last_error()}")
        info = self.mt5.symbol_info(self.symbol)
        info_d = info._asdict() if info else {}
        try:
            self.subscribed_book = bool(self.mt5.market_book_add(self.symbol))
        except Exception:
            self.subscribed_book = False
        return info_d

    async def connect(self):
        info = await asyncio.to_thread(self._connect_blocking)
        async with self.state.lock:
            self.state.mt5_symbol = self.symbol
            self.state.mt5_symbol_info = info

    def _poll_blocking(self):
        tick = self.mt5.symbol_info_tick(self.symbol)
        if tick is None:
            raise RuntimeError(f"symbol_info_tick failed: {self.mt5.last_error()}")
        td = tick._asdict()
        bid, ask = float(td.get("bid") or 0), float(td.get("ask") or 0)
        mid = (bid + ask) / 2 if bid > 0 and ask > 0 else (bid or ask or float(td.get("last") or 0))
        levels = []
        info = self.mt5.symbol_info(self.symbol)
        contract = float(getattr(info, "trade_contract_size", 0) or 0) if info else 0
        dom = None
        if self.subscribed_book:
            try:
                dom = self.mt5.market_book_get(self.symbol)
            except Exception:
                dom = None
        if dom:
            buy_types = {
                getattr(self.mt5, "BOOK_TYPE_BUY", -999),
                getattr(self.mt5, "BOOK_TYPE_BUY_MARKET", -998),
            }
            sell_types = {
                getattr(self.mt5, "BOOK_TYPE_SELL", -997),
                getattr(self.mt5, "BOOK_TYPE_SELL_MARKET", -996),
            }
            for row in dom:
                d = row._asdict()
                typ = d.get("type")
                side = "buy" if typ in buy_types else "sell" if typ in sell_types else None
                if not side:
                    continue
                price = float(d.get("price") or 0)
                lots = float(d.get("volume_real") or d.get("volume") or 0)
                if price <= 0 or lots <= 0:
                    continue
                levels.append({
                    "source": "MT5_DOM",
                    "side": side,
                    "price": price,
                    "qty": lots,
                    "notional": price * lots * contract if contract > 0 else 0,
                    "unit": "lots",
                    "contractSize": contract,
                })
        return td, mid, bid, ask, levels, contract

    def _rates_blocking(self, timeframe: str, limit: int):
        tfmap = {
            "1m": self.mt5.TIMEFRAME_M1,
            "5m": self.mt5.TIMEFRAME_M5,
            "15m": self.mt5.TIMEFRAME_M15,
            "30m": self.mt5.TIMEFRAME_M30,
            "1h": self.mt5.TIMEFRAME_H1,
            "4h": self.mt5.TIMEFRAME_H4,
            "1d": self.mt5.TIMEFRAME_D1,
        }
        tf = tfmap.get(timeframe, self.mt5.TIMEFRAME_M15)
        rows = self.mt5.copy_rates_from_pos(self.symbol, tf, 0, int(limit))
        if rows is None:
            return []
        return [
            {
                "time": int(r["time"]),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": float(r["tick_volume"]),
            }
            for r in rows
        ]

    async def candles(self, timeframe: str, limit: int):
        if self.mt5 is None or not self.symbol:
            return []
        return await asyncio.to_thread(self._rates_blocking, timeframe, limit)

    async def _refresh_analysis_candles(self):
        now = time.monotonic()
        if now - self._last_candles < max(1.0, float(self.cfg.get("candles_refresh_seconds", 3))):
            return
        self._last_candles = now
        try:
            m5, m15 = await asyncio.gather(self.candles("5m", 80), self.candles("15m", 80))
            async with self.state.lock:
                if m5:
                    self.state.candles_m5 = m5
                if m15:
                    self.state.candles_m15 = m15
        except Exception:
            pass

    async def run(self):
        backoff = 2.0
        while True:
            try:
                if self.mt5 is None or not self.symbol:
                    await self.connect()
                td, mid, bid, ask, levels, contract = await asyncio.to_thread(self._poll_blocking)
                async with self.state.lock:
                    self.state.mt5_tick = td
                await self.state.set_source(SourceSnapshot(
                    name="MT5_DOM",
                    ok=True,
                    message="live" if levels else "price live; broker DOM unavailable/empty",
                    updated_ms=now_ms(),
                    mid=mid,
                    best_bid=bid,
                    best_ask=ask,
                    levels=levels,
                    meta={"symbol": self.symbol, "label": f"MT5:{self.symbol}", "dom": bool(levels), "contractSize": contract},
                ))
                await self._refresh_analysis_candles()
                backoff = 2.0
                await asyncio.sleep(max(0.05, float(self.cfg.get("poll_ms", 120)) / 1000))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self.state.set_source(SourceSnapshot(
                    name="MT5_DOM", ok=False, message=str(exc), updated_ms=now_ms()
                ))
                self.mt5 = None
                self.symbol = None
                self.subscribed_book = False
                await asyncio.sleep(backoff)
                backoff = min(20.0, backoff * 1.6)
