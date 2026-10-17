from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class TradeEvent:
    source: str
    symbol: str
    ts_ms: int
    price: float
    qty: float
    side: str  # buy/sell = taker/aggressor side
    notional: float
    seq: int = 0


@dataclass
class SourceSnapshot:
    name: str
    ok: bool = False
    message: str = "starting"
    updated_ms: int = 0
    mid: float | None = None
    best_bid: float | None = None
    best_ask: float | None = None
    levels: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)


class SharedState:
    def __init__(self, max_trades: int = 20000):
        self.lock = asyncio.Lock()
        self.sources: dict[str, SourceSnapshot] = {}
        self.trades: deque[TradeEvent] = deque(maxlen=max_trades)
        self.mt5_tick: dict[str, Any] = {}
        self.mt5_symbol: str | None = None
        self.mt5_symbol_info: dict[str, Any] = {}
        self.candles_m5: list[dict[str, Any]] = []
        self.candles_m15: list[dict[str, Any]] = []
        self.zones: list[dict[str, Any]] = []
        self.reference_price: float | None = None
        self.reference_source: str = "NONE"
        self.engine_updated_ms: int = 0
        self.metrics: dict[str, Any] = {}
        self.bias: dict[str, Any] = {
            "status": "WARMING",
            "direction": "NEUTRAL",
            "score": 0,
            "reason": "Waiting for live data",
        }
        self.basis: dict[str, float] = {}
        self.trade_seq: int = 0

    async def set_source(self, snap: SourceSnapshot):
        async with self.lock:
            self.sources[snap.name] = snap

    async def add_trade(self, trade: TradeEvent):
        async with self.lock:
            self.trade_seq += 1
            trade.seq = self.trade_seq
            self.trades.append(trade)

    async def snapshot(self):
        async with self.lock:
            return {
                "referencePrice": self.reference_price,
                "referenceSource": self.reference_source,
                "mt5Symbol": self.mt5_symbol,
                "mt5Tick": dict(self.mt5_tick),
                "zones": list(self.zones),
                "metrics": dict(self.metrics),
                "bias": dict(self.bias),
                "basis": dict(self.basis),
                "engineUpdatedMs": self.engine_updated_ms,
                "sources": {
                    k: {
                        "ok": v.ok,
                        "message": v.message,
                        "updatedMs": v.updated_ms,
                        "ageMs": max(0, now_ms() - v.updated_ms) if v.updated_ms else None,
                        "mid": v.mid,
                        "bestBid": v.best_bid,
                        "bestAsk": v.best_ask,
                        "levels": len(v.levels),
                        "meta": dict(v.meta),
                    }
                    for k, v in self.sources.items()
                },
            }
