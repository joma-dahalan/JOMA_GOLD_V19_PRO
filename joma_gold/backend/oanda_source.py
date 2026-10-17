from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime, timezone

import httpx

from .state import SharedState, SourceSnapshot, now_ms

HOSTS = {
    "practice": ("https://api-fxpractice.oanda.com", "https://stream-fxpractice.oanda.com"),
    "live": ("https://api-fxtrade.oanda.com", "https://stream-fxtrade.oanda.com"),
}
GRANULARITY = {"1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D"}
BOOK_KEYS = {"order": "orderBook", "position": "positionBook"}
BOOK_STEP_S = 20 * 60  # OANDA publishes a new snapshot roughly every 20 minutes

_TS = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z?$")


def parse_time(value) -> float:
    """OANDA timestamps: RFC3339 with up to 9 fractional digits, or a unix float string."""
    s = str(value).strip()
    try:
        return float(s)
    except ValueError:
        pass
    m = _TS.match(s)
    if not m:
        raise ValueError(f"unrecognised OANDA time: {value!r}")
    dt = datetime.strptime(f"{m.group(1)}T{m.group(2)}", "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    frac = float("0." + m.group(3)) if m.group(3) else 0.0
    return dt.timestamp() + frac


def iso_z(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_candles(payload: dict, component: str = "M") -> list[dict]:
    """component: M (mid) | B (bid) | A (ask)."""
    key = {"M": "mid", "B": "bid", "A": "ask"}.get(component, "mid")
    rows = []
    for c in payload.get("candles", []) or []:
        px = c.get(key)
        if not px:
            continue
        try:
            rows.append({
                "time": int(parse_time(c["time"])),
                "open": float(px["o"]), "high": float(px["h"]), "low": float(px["l"]), "close": float(px["c"]),
                "volume": float(c.get("volume") or 0),  # OANDA volume = number of price updates (tick volume)
                "complete": bool(c.get("complete", True)),
            })
        except (KeyError, ValueError, TypeError):
            continue
    return rows


def parse_book(payload: dict, kind: str) -> dict | None:
    """Order/position book snapshot. Buckets are [lowerPrice, longCountPercent, shortCountPercent];
    each bucket covers [price, price + bucketWidth). Values are shares of the *number* of orders/positions."""
    body = payload.get(BOOK_KEYS[kind]) or payload
    if not isinstance(body, dict) or not body.get("buckets") or not body.get("time"):
        return None
    buckets = []
    for b in body["buckets"]:
        try:
            buckets.append([float(b["price"]), float(b.get("longCountPercent") or 0), float(b.get("shortCountPercent") or 0)])
        except (KeyError, ValueError, TypeError):
            continue
    if not buckets:
        return None
    return {
        "kind": kind, "instrument": body.get("instrument"), "ts": int(parse_time(body["time"]) * 1000),
        "price": float(body.get("price") or 0), "width": float(body.get("bucketWidth") or 0), "buckets": buckets,
    }


class OandaSource:
    """OANDA v20 (practice or live) – broker price reference + client order/position books.

    * Pricing stream  -> bid/ask/mid used as the chart's reference price (the same broker you trade with).
    * Candles         -> the chart history, so candles and live price come from one source.
    * Order/Position books -> real snapshots of where OANDA clients have pending orders / open positions
      (percent of order *count*, ~20 min cadence). They are NOT order sizes and NOT interbank depth, and
      they are shown on the chart as a separate, clearly-labelled layer.

    Quoted tier "liquidity" values from the pricing stream are deliberately not turned into walls: they
    are the maximum size the broker is willing to quote, not resting orders.
    """

    def __init__(self, state: SharedState, cfg: dict, history=None):
        self.state = state
        self.cfg = cfg
        self.history = history
        self.env = str(cfg.get("environment", "practice")).lower()
        self.api_host, self.stream_host = HOSTS.get(self.env, HOSTS["practice"])
        self.api_host = str(cfg.get("api_host") or self.api_host).rstrip("/")        # overrides are for tests / proxies
        self.stream_host = str(cfg.get("stream_host") or self.stream_host).rstrip("/")
        self.instrument = str(cfg.get("instrument", "XAU_USD")).upper()
        self.token = (str(cfg.get("token") or "").strip() or os.environ.get("OANDA_TOKEN", "").strip())
        self.account_id = (str(cfg.get("account_id") or "").strip() or os.environ.get("OANDA_ACCOUNT_ID", "").strip())
        self.candle_component = str(cfg.get("candle_price", "M")).upper()[:1] or "M"
        self.label = f"OANDA:{self.instrument}"
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(12.0), headers={"User-Agent": "JOMA-GOLD/14"})
        self.book_status = {"order": "not started", "position": "not started"}
        self.book_last_ts = {"order": 0, "position": 0}

    # ---- helpers ----------------------------------------------------------------
    @property
    def configured(self) -> bool:
        return bool(self.token)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}", "Accept-Datetime-Format": "RFC3339", "Content-Type": "application/json"}

    async def _get(self, path: str, params: dict | None = None) -> httpx.Response:
        return await self.client.get(self.api_host + path, params=params, headers=self._headers())

    async def ensure_account(self) -> str:
        if self.account_id:
            return self.account_id
        r = await self._get("/v3/accounts")
        if r.status_code != 200:
            raise RuntimeError(f"cannot list accounts: HTTP {r.status_code} {r.text[:160]}")
        accounts = r.json().get("accounts") or []
        if not accounts:
            raise RuntimeError("token has no accounts")
        self.account_id = str(accounts[0]["id"])
        return self.account_id

    async def _offline(self, name: str, message: str):
        await self.state.set_source(SourceSnapshot(name=name, ok=False, message=message, updated_ms=now_ms(),
                                                  meta={"label": self.label, "instrument": self.instrument}))

    # ---- candles ----------------------------------------------------------------
    async def candles(self, timeframe: str, limit: int) -> list[dict]:
        if not self.configured:
            return []
        gran = GRANULARITY.get(timeframe, "M15")
        r = await self._get(
            f"/v3/instruments/{self.instrument}/candles",
            {"granularity": gran, "count": max(10, min(5000, int(limit))), "price": self.candle_component},
        )
        if r.status_code != 200:
            raise RuntimeError(f"OANDA candles HTTP {r.status_code}: {r.text[:160]}")
        return parse_candles(r.json(), self.candle_component)

    @property
    def price_component_name(self) -> str:
        return {"M": "mid", "B": "bid", "A": "ask"}.get(self.candle_component, "mid")

    # ---- live pricing -------------------------------------------------------------
    async def _on_price(self, msg: dict):
        bids, asks = msg.get("bids") or [], msg.get("asks") or []
        if not bids or not asks:
            return
        bid, ask = float(bids[0]["price"]), float(asks[0]["price"])
        tradeable = bool(msg.get("tradeable", True))
        await self.state.set_source(SourceSnapshot(
            name="OANDA", ok=True,
            message="live · pricing stream" if tradeable else "market closed (not tradeable)",
            updated_ms=now_ms(), mid=(bid + ask) / 2, best_bid=bid, best_ask=ask, levels=[],
            meta={
                "label": self.label, "instrument": self.instrument, "environment": self.env, "tradeable": tradeable,
                "priceTime": msg.get("time"), "account": self.account_id,
                "bookOrder": self.book_status["order"], "bookPosition": self.book_status["position"],
            },
        ))

    async def _on_heartbeat(self):
        async with self.state.lock:
            snap = self.state.sources.get("OANDA")
            if snap and snap.ok:
                snap.updated_ms = now_ms()

    async def run_pricing(self):
        if not self.configured:
            await self._offline("OANDA", "no API token configured (config.json → oanda.token or env OANDA_TOKEN)")
            return
        backoff = 2.0
        stream_timeout = httpx.Timeout(connect=10.0, read=35.0, write=10.0, pool=10.0)
        while True:
            try:
                await self.ensure_account()
                url = f"{self.stream_host}/v3/accounts/{self.account_id}/pricing/stream"
                async with httpx.AsyncClient(timeout=stream_timeout, headers={"User-Agent": "JOMA-GOLD/14"}) as sc:
                    async with sc.stream("GET", url, params={"instruments": self.instrument, "snapshot": "true"},
                                         headers=self._headers()) as r:
                        if r.status_code != 200:
                            body = (await r.aread())[:200].decode("utf-8", "replace")
                            raise RuntimeError(f"pricing stream HTTP {r.status_code}: {body}")
                        backoff = 2.0
                        async for line in r.aiter_lines():
                            if not line:
                                continue
                            try:
                                msg = json.loads(line)
                            except ValueError:
                                continue
                            kind = msg.get("type")
                            if kind == "PRICE":
                                await self._on_price(msg)
                            elif kind == "HEARTBEAT":
                                await self._on_heartbeat()
                raise RuntimeError("pricing stream closed by server")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._offline("OANDA", str(exc)[:220])
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 1.7)

    # ---- analysis candles (only when MT5 isn't providing them) ----------------------
    async def run_analysis_candles(self):
        if not self.configured:
            return
        while True:
            try:
                mt5 = self.state.sources.get("MT5_DOM")
                if not (mt5 and mt5.ok):
                    m5, m15 = await asyncio.gather(self.candles("5m", 80), self.candles("15m", 80))
                    async with self.state.lock:
                        if m5:
                            self.state.candles_m5 = m5
                        if m15:
                            self.state.candles_m15 = m15
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(max(5.0, float(self.cfg.get("analysis_candles_seconds", 15))))

    # ---- order / position books ---------------------------------------------------
    async def fetch_book(self, kind: str, at_ts: float | None = None) -> tuple[dict | None, int, str]:
        params = {"time": iso_z(at_ts)} if at_ts else None
        r = await self._get(f"/v3/instruments/{self.instrument}/{BOOK_KEYS[kind]}", params)
        if r.status_code != 200:
            return None, r.status_code, r.text[:160]
        return parse_book(r.json(), kind), 200, ""

    def _store_book(self, book: dict):
        if self.history is not None:
            self.history.add_book(book)
        self.book_last_ts[book["kind"]] = max(self.book_last_ts[book["kind"]], book["ts"])

    async def _publish_books_status(self):
        summary = "; ".join(f"{k}: {v}" for k, v in self.book_status.items())
        ok = any(v.startswith("ok") for v in self.book_status.values())
        await self.state.set_source(SourceSnapshot(
            name="OANDA_BOOK", ok=ok, message=summary, updated_ms=now_ms(),
            meta={"label": f"{self.label} books", "status": dict(self.book_status), "lastTs": dict(self.book_last_ts)},
        ))

    async def backfill_books(self):
        """Walk backwards in 20-minute steps and store whatever OANDA still serves. Stops on the first refusal."""
        want = int(self.cfg.get("book_backfill_snapshots", 72))
        if want <= 0 or self.history is None:
            return
        for kind in ("order", "position"):
            known = await asyncio.to_thread(self.history.known_book_times, kind)
            cursor = (self.book_last_ts[kind] / 1000.0) or 0
            if not cursor:
                continue
            got = misses = 0
            refused = 0
            t = cursor - BOOK_STEP_S
            while got < want and misses < 6:
                try:
                    book, code, text = await self.fetch_book(kind, t)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.book_status[kind] = f"backfill error: {exc}"[:120]
                    break
                if book is None:
                    if code == 200:  # parsed empty
                        misses += 1
                        t -= BOOK_STEP_S
                        continue
                    refused = code
                    self.book_status[kind] = f"ok (live) · history not served (HTTP {code})"
                    break
                if book["ts"] in known:
                    t = min(t, book["ts"] / 1000.0) - BOOK_STEP_S
                    misses += 1
                    continue
                known.add(book["ts"])
                self._store_book(book)
                got += 1
                misses = 0
                t = book["ts"] / 1000.0 - BOOK_STEP_S
                await asyncio.sleep(0.2)
            if got:
                tail = f" · older not served (HTTP {refused})" if refused else ""
                self.book_status[kind] = f"ok · {got} historical snapshots loaded{tail}"
        await self._publish_books_status()

    async def run_books(self):
        if not self.configured:
            return
        poll = max(60.0, float(self.cfg.get("book_poll_seconds", 180)))
        first = True
        while True:
            for kind in ("order", "position"):
                try:
                    book, code, text = await self.fetch_book(kind)
                    if book:
                        self._store_book(book)
                        self.book_status[kind] = f"ok · {len(book['buckets'])} buckets @ {datetime.fromtimestamp(book['ts']/1000, tz=timezone.utc):%H:%M}Z"
                    elif code == 200:
                        self.book_status[kind] = "empty snapshot"
                    else:
                        self.book_status[kind] = f"unavailable (HTTP {code}) {text}"[:140]
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.book_status[kind] = f"error: {exc}"[:140]
            await self._publish_books_status()
            if first:
                first = False
                asyncio.create_task(self.backfill_books(), name="oanda-book-backfill")
            bad = all(not v.startswith("ok") for v in self.book_status.values())
            await asyncio.sleep(poll * (4 if bad else 1))

    async def run(self):
        if not self.configured:
            await self._offline("OANDA", "no API token configured (config.json → oanda.token or env OANDA_TOKEN)")
            return
        await asyncio.gather(self.run_pricing(), self.run_books(), self.run_analysis_candles())
