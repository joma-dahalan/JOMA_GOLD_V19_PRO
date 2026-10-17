from __future__ import annotations

import asyncio
import json
import math
import zlib
from decimal import Decimal
from typing import Iterable

import httpx
import websockets

from .state import SharedState, SourceSnapshot, TradeEvent, now_ms

UA = {"User-Agent": "JOMA-GOLD-WEB-ULTIMATE/13.0", "Accept": "application/json"}


def _book_levels(source: str, bids: dict[float, float], asks: dict[float, float], limit: int = 1200):
    b = sorted(((p, q) for p, q in bids.items() if p > 0 and q > 0), reverse=True)[:limit]
    a = sorted(((p, q) for p, q in asks.items() if p > 0 and q > 0))[:limit]
    levels = []
    for side, rows in (("buy", b), ("sell", a)):
        for p, q in rows:
            levels.append({
                "source": source,
                "side": side,
                "price": p,
                "qty": q,
                "notional": p * q,
                "unit": "oz-equivalent token/contract unit",
            })
    bid = b[0][0] if b else None
    ask = a[0][0] if a else None
    mid = (bid + ask) / 2 if bid and ask else None
    return levels, bid, ask, mid


class BinanceSource:
    """Binance USD-M XAUUSDT diff-depth + aggregate trades.

    Uses a REST snapshot only to seed the book, then maintains it with 100 ms
    public WebSocket deltas. Any sequence gap forces a full resync.
    """

    def __init__(self, state: SharedState, cfg: dict):
        self.state = state
        self.cfg = cfg
        self.symbol = str(cfg.get("symbol", "XAUUSDT")).upper()
        self.name = f"BINANCE:{self.symbol}"
        self.client = httpx.AsyncClient(timeout=10, headers=UA)
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.last_u: int | None = None
        self._last_publish = 0

    async def _seed(self):
        limit = int(self.cfg.get("depth_limit", 1000))
        limit = min((5, 10, 20, 50, 100, 500, 1000), key=lambda x: abs(x - limit))
        r = await self.client.get(
            str(self.cfg.get("rest_depth", "https://fapi.binance.com/fapi/v1/depth")),
            params={"symbol": self.symbol, "limit": limit},
        )
        r.raise_for_status()
        d = r.json()
        self.bids = {float(p): float(q) for p, q in d.get("bids", []) if float(q) > 0}
        self.asks = {float(p): float(q) for p, q in d.get("asks", []) if float(q) > 0}
        self.last_u = int(d.get("lastUpdateId", 0))

    async def _publish(self, message: str = "live · WS depth 100ms + aggTrade"):
        levels, bid, ask, mid = _book_levels(self.name, self.bids, self.asks, int(self.cfg.get("depth_limit", 1000)))
        await self.state.set_source(SourceSnapshot(
            name=self.name,
            ok=bool(mid),
            message=message if mid else "book empty",
            updated_ms=now_ms(),
            mid=mid,
            best_bid=bid,
            best_ask=ask,
            levels=levels,
            meta={"symbol": self.symbol, "transport": "websocket", "depthLevels": len(levels)},
        ))

    @staticmethod
    def _merge(target: dict[float, float], rows: Iterable):
        for p, q in rows:
            p, q = float(p), float(q)
            if q <= 0:
                target.pop(p, None)
            else:
                target[p] = q

    async def run(self):
        backoff = 1.5
        sym = self.symbol.lower()
        ws_base = str(self.cfg.get("ws_base", "wss://fstream.binance.com/stream?streams="))
        url = f"{ws_base}{sym}@depth@100ms/{sym}@aggTrade"
        while True:
            try:
                self.bids.clear(); self.asks.clear(); self.last_u = None
                async with websockets.connect(url, ping_interval=120, ping_timeout=30, close_timeout=5, max_size=8_000_000) as ws:
                    # Snapshot after the socket is open; incoming deltas wait in the WS queue.
                    await self._seed()
                    await self._publish("live · synchronized")
                    backoff = 1.5
                    async for raw in ws:
                        msg = json.loads(raw)
                        data = msg.get("data", msg) if isinstance(msg, dict) else {}
                        if not isinstance(data, dict):
                            continue
                        et = data.get("e")
                        if et == "aggTrade":
                            p = float(data.get("p") or 0); q = float(data.get("q") or 0)
                            if p > 0 and q > 0:
                                side = "sell" if bool(data.get("m", False)) else "buy"
                                await self.state.add_trade(TradeEvent(
                                    self.name, self.symbol, int(data.get("T") or data.get("E") or now_ms()),
                                    p, q, side, p * q,
                                ))
                            continue
                        if et != "depthUpdate":
                            continue
                        U = int(data.get("U", 0)); u = int(data.get("u", 0)); pu = data.get("pu")
                        if self.last_u is None:
                            raise RuntimeError("Binance book missing seed sequence")
                        if u <= self.last_u:
                            continue
                        # First delta must bridge the REST snapshot; later deltas must be contiguous.
                        if pu is not None and int(pu) != self.last_u:
                            if not (U <= self.last_u + 1 <= u):
                                raise RuntimeError("Binance depth sequence gap; resyncing")
                        elif pu is None and not (U <= self.last_u + 1 <= u):
                            raise RuntimeError("Binance depth sequence gap; resyncing")
                        self._merge(self.bids, data.get("b", []))
                        self._merge(self.asks, data.get("a", []))
                        self.last_u = u
                        t = now_ms()
                        if t - self._last_publish >= 180:
                            await self._publish(); self._last_publish = t
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self.state.set_source(SourceSnapshot(
                    name=self.name, ok=False, message=str(exc), updated_ms=now_ms(), meta={"symbol": self.symbol}
                ))
                await asyncio.sleep(backoff)
                backoff = min(20.0, backoff * 1.55)

    async def candles(self, timeframe: str, limit: int):
        imap = {"1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"4h","1d":"1d"}
        r = await self.client.get(
            str(self.cfg.get("rest_klines", "https://fapi.binance.com/fapi/v1/klines")),
            params={"symbol": self.symbol, "interval": imap.get(timeframe, "15m"), "limit": min(1500, int(limit))},
        )
        r.raise_for_status()
        return [{
            "time": int(int(x[0]) / 1000), "open": float(x[1]), "high": float(x[2]),
            "low": float(x[3]), "close": float(x[4]), "volume": float(x[5]),
        } for x in r.json()]


def _format_bfx_float(value: float) -> str:
    # Matches Bitfinex's checksum formatting closely enough for R0 books.
    if value == 0:
        return "0"
    try:
        if abs(value) >= 1e-6:
            return format(Decimal(repr(value)), "f")
    except Exception:
        pass
    return str(value).replace("e-0", "e-")


class BitfinexSource:
    """Bitfinex XAUT/USD raw R0 order book + public trades + checksum."""

    def __init__(self, state: SharedState, cfg: dict):
        self.state = state
        self.cfg = cfg
        self.symbol = str(cfg.get("symbol", "tXAUTUSD"))
        self.name = f"BITFINEX:{self.symbol}"
        self.orders: dict[int, tuple[float, float]] = {}
        self.book_chan: int | None = None
        self.trade_chan: int | None = None
        self.checksum_enabled = bool(cfg.get("checksum", True))
        self._last_publish = 0

    def _book(self):
        bids: dict[float, float] = {}; asks: dict[float, float] = {}
        for _oid, (p, a) in self.orders.items():
            if p <= 0 or a == 0:
                continue
            dest = bids if a > 0 else asks
            dest[p] = dest.get(p, 0.0) + abs(a)
        return bids, asks

    def _checksum(self) -> int | None:
        bids = sorted(((p, oid, a) for oid, (p, a) in self.orders.items() if p > 0 and a > 0), key=lambda x: (-x[0], x[1]))[:25]
        asks = sorted(((p, oid, a) for oid, (p, a) in self.orders.items() if p > 0 and a < 0), key=lambda x: (x[0], x[1]))[:25]
        if len(bids) < 25 or len(asks) < 25:
            return None
        values: list[str] = []
        for i in range(25):
            _, bid_id, bid_amt = bids[i]; _, ask_id, ask_amt = asks[i]
            values.extend([str(bid_id), _format_bfx_float(bid_amt), str(ask_id), _format_bfx_float(ask_amt)])
        crc = zlib.crc32(":".join(values).encode("utf-8"))
        if crc > 0x7FFFFFFF:
            crc -= 0x100000000
        return crc

    async def _publish(self, checksum_status: str = "ok"):
        bids, asks = self._book()
        levels, bid, ask, mid = _book_levels(self.name, bids, asks, int(self.cfg.get("raw_len", 250)))
        await self.state.set_source(SourceSnapshot(
            name=self.name, ok=bool(mid), message="live · raw R0 + trades",
            updated_ms=now_ms(), mid=mid, best_bid=bid, best_ask=ask, levels=levels,
            meta={"symbol": self.symbol, "rawOrders": len(self.orders), "checksum": checksum_status, "transport":"websocket"},
        ))

    async def run(self):
        backoff = 1.5
        while True:
            try:
                self.orders.clear(); self.book_chan = None; self.trade_chan = None
                async with websockets.connect("wss://api-pub.bitfinex.com/ws/2", ping_interval=20, ping_timeout=20, close_timeout=5, max_size=8_000_000) as ws:
                    if self.checksum_enabled:
                        await ws.send(json.dumps({"event":"conf","flags":131072}))
                    await ws.send(json.dumps({"event":"subscribe","channel":"book","symbol":self.symbol,"prec":"R0","freq":"F0","len":str(self.cfg.get("raw_len",250))}))
                    await ws.send(json.dumps({"event":"subscribe","channel":"trades","symbol":self.symbol}))
                    backoff = 1.5
                    async for raw in ws:
                        msg = json.loads(raw)
                        if isinstance(msg, dict):
                            if msg.get("event") == "subscribed":
                                if msg.get("channel") == "book": self.book_chan = int(msg.get("chanId"))
                                elif msg.get("channel") == "trades": self.trade_chan = int(msg.get("chanId"))
                            elif msg.get("event") == "error":
                                raise RuntimeError(msg.get("msg") or str(msg))
                            continue
                        if not isinstance(msg, list) or not msg:
                            continue
                        chan = msg[0]
                        if chan == self.book_chan:
                            if len(msg) >= 3 and msg[1] == "cs":
                                local = self._checksum(); remote = int(msg[2])
                                if local is not None and local != remote:
                                    raise RuntimeError("Bitfinex R0 checksum mismatch; resyncing")
                                continue
                            if len(msg) < 2 or msg[1] == "hb":
                                continue
                            payload = msg[1]
                            rows = payload if payload and isinstance(payload[0], list) else [payload]
                            for row in rows:
                                if not isinstance(row, list) or len(row) < 3: continue
                                oid = int(row[0]); price = float(row[1]); amount = float(row[2])
                                if price == 0: self.orders.pop(oid, None)
                                else: self.orders[oid] = (price, amount)
                            t = now_ms()
                            if t - self._last_publish >= 180:
                                await self._publish(); self._last_publish = t
                        elif chan == self.trade_chan:
                            if len(msg) >= 3 and msg[1] == "te" and isinstance(msg[2], list):
                                row = msg[2]
                                if len(row) >= 4:
                                    _id, mts, amount, price = row[:4]
                                    p = float(price); a = float(amount); q = abs(a)
                                    if p > 0 and q > 0:
                                        await self.state.add_trade(TradeEvent(
                                            self.name, self.symbol, int(mts), p, q,
                                            "buy" if a > 0 else "sell", p * q,
                                        ))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self.state.set_source(SourceSnapshot(
                    name=self.name, ok=False, message=str(exc), updated_ms=now_ms(), meta={"symbol":self.symbol}
                ))
                await asyncio.sleep(backoff); backoff = min(20.0, backoff * 1.55)


class KrakenSource:
    """One Kraken WS v2 symbol: L2 book + trades."""

    def __init__(self, state: SharedState, cfg: dict, symbol: str):
        self.state = state; self.cfg = cfg; self.symbol = symbol.upper()
        self.name = f"KRAKEN:{self.symbol}"
        self.bids: dict[float,float] = {}; self.asks: dict[float,float] = {}; self._last_publish = 0

    @staticmethod
    def _apply(target: dict[float,float], rows):
        for row in rows or []:
            if not isinstance(row, dict): continue
            p = float(row.get("price") or 0); q = float(row.get("qty") or 0)
            if p <= 0: continue
            if q <= 0: target.pop(p, None)
            else: target[p] = q

    async def _publish(self):
        levels,bid,ask,mid = _book_levels(self.name,self.bids,self.asks,int(self.cfg.get("depth",500)))
        await self.state.set_source(SourceSnapshot(
            self.name,bool(mid),"live · WS v2 book + trades" if mid else "book empty",now_ms(),mid,bid,ask,levels,
            {"symbol":self.symbol,"transport":"websocket","depthLevels":len(levels)}
        ))

    async def run(self):
        backoff=1.5
        depth = int(self.cfg.get("depth",500)); depth = max([x for x in (10,25,100,500,1000) if x <= min(1000,max(10,depth))])
        while True:
            try:
                self.bids.clear(); self.asks.clear()
                async with websockets.connect("wss://ws.kraken.com/v2",ping_interval=20,ping_timeout=20,close_timeout=5,max_size=8_000_000) as ws:
                    await ws.send(json.dumps({"method":"subscribe","params":{"channel":"book","symbol":[self.symbol],"depth":depth,"snapshot":True}}))
                    await ws.send(json.dumps({"method":"subscribe","params":{"channel":"trade","symbol":[self.symbol],"snapshot":False}}))
                    backoff=1.5
                    async for raw in ws:
                        msg=json.loads(raw)
                        if not isinstance(msg,dict): continue
                        if msg.get("success") is False: raise RuntimeError(msg.get("error") or str(msg))
                        channel=str(msg.get("channel") or "").lower(); rows=msg.get("data") or []
                        if channel=="book":
                            replace=str(msg.get("type") or "").lower()=="snapshot"
                            for row in rows:
                                if not isinstance(row,dict) or str(row.get("symbol","")).upper()!=self.symbol: continue
                                if replace:
                                    self.bids.clear(); self.asks.clear()
                                self._apply(self.bids,row.get("bids")); self._apply(self.asks,row.get("asks"))
                            t=now_ms()
                            if t-self._last_publish>=200: await self._publish(); self._last_publish=t
                        elif channel=="trade":
                            for row in rows:
                                if not isinstance(row,dict): continue
                                p=float(row.get("price") or 0); q=float(row.get("qty") or 0)
                                if p<=0 or q<=0: continue
                                side="buy" if str(row.get("side","")).lower()=="buy" else "sell"
                                ts=row.get("timestamp")
                                try:
                                    import datetime as _dt
                                    tms=int(_dt.datetime.fromisoformat(str(ts).replace("Z","+00:00")).timestamp()*1000)
                                except Exception: tms=now_ms()
                                await self.state.add_trade(TradeEvent(self.name,self.symbol,tms,p,q,side,p*q))
            except asyncio.CancelledError: raise
            except Exception as exc:
                await self.state.set_source(SourceSnapshot(self.name,False,str(exc),now_ms(),meta={"symbol":self.symbol}))
                await asyncio.sleep(backoff); backoff=min(20.0,backoff*1.55)


class OKXSource:
    """One OKX gold-token symbol: public incremental book + trades."""

    def __init__(self,state:SharedState,cfg:dict,symbol:str):
        self.state=state; self.cfg=cfg; self.symbol=symbol.upper(); self.name=f"OKX:{self.symbol}"
        self.bids:dict[float,float]={}; self.asks:dict[float,float]={}; self.seq:int|None=None; self._last_publish=0

    @staticmethod
    def _apply(target:dict[float,float],rows):
        for row in rows or []:
            if not isinstance(row,list) or len(row)<2: continue
            p=float(row[0]); q=float(row[1])
            if p<=0: continue
            if q<=0: target.pop(p,None)
            else: target[p]=q

    async def _publish(self):
        levels,bid,ask,mid=_book_levels(self.name,self.bids,self.asks,1000)
        await self.state.set_source(SourceSnapshot(
            self.name,bool(mid),"live · WS book + trades" if mid else "book empty",now_ms(),mid,bid,ask,levels,
            {"symbol":self.symbol,"transport":"websocket","seqId":self.seq,"depthLevels":len(levels)}
        ))

    async def run(self):
        backoff=1.5; channel=str(self.cfg.get("channel","books"))
        while True:
            try:
                self.bids.clear(); self.asks.clear(); self.seq=None
                async with websockets.connect("wss://ws.okx.com:8443/ws/v5/public",ping_interval=None,close_timeout=5,max_size=8_000_000) as ws:
                    await ws.send(json.dumps({"op":"subscribe","args":[{"channel":channel,"instId":self.symbol},{"channel":"trades","instId":self.symbol}]}))
                    backoff=1.5
                    while True:
                        try:
                            raw=await asyncio.wait_for(ws.recv(),timeout=20)
                        except asyncio.TimeoutError:
                            await ws.send("ping"); continue
                        if raw=="pong": continue
                        msg=json.loads(raw)
                        if not isinstance(msg,dict): continue
                        if msg.get("event") in {"error","notice"}:
                            if msg.get("event")=="error": raise RuntimeError(msg.get("msg") or str(msg))
                            continue
                        arg=msg.get("arg") or {}; ch=str(arg.get("channel") or ""); inst=str(arg.get("instId") or "").upper()
                        if inst and inst!=self.symbol: continue
                        rows=msg.get("data") or []
                        if ch.startswith("book"):
                            action=str(msg.get("action") or "update").lower()
                            for row in rows:
                                if not isinstance(row,dict): continue
                                seq=int(row.get("seqId",0)) if row.get("seqId") is not None else None
                                prev=int(row.get("prevSeqId",-1)) if row.get("prevSeqId") is not None else -1
                                if action=="snapshot":
                                    self.bids.clear(); self.asks.clear(); self.seq=seq
                                else:
                                    if self.seq is not None and prev not in (-1,self.seq):
                                        raise RuntimeError("OKX order-book sequence gap; resyncing")
                                    if seq is not None: self.seq=seq
                                self._apply(self.bids,row.get("bids")); self._apply(self.asks,row.get("asks"))
                            t=now_ms()
                            if t-self._last_publish>=180: await self._publish(); self._last_publish=t
                        elif ch=="trades":
                            for row in rows:
                                if not isinstance(row,dict): continue
                                p=float(row.get("px") or 0); q=float(row.get("sz") or 0)
                                if p<=0 or q<=0: continue
                                side="buy" if str(row.get("side","")).lower()=="buy" else "sell"
                                tms=int(row.get("ts") or now_ms())
                                await self.state.add_trade(TradeEvent(self.name,self.symbol,tms,p,q,side,p*q))
            except asyncio.CancelledError: raise
            except Exception as exc:
                await self.state.set_source(SourceSnapshot(self.name,False,str(exc),now_ms(),meta={"symbol":self.symbol}))
                await asyncio.sleep(backoff); backoff=min(20.0,backoff*1.55)
