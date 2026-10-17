from __future__ import annotations

import asyncio
import json
import logging
import math
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.engine import LiquidityEngine
from backend.history import HistoryStore
from backend.mt5_source import MT5Source
from backend.oanda_source import OandaSource
from backend.public_sources import BinanceSource, BitfinexSource, KrakenSource, OKXSource
from backend.recorder import Recorder
from backend.state import SharedState, now_ms

ROOT = Path(__file__).resolve().parent
VERSION = "19.0"
logger = logging.getLogger("joma.app")
TFS = {"1m", "5m", "15m", "30m", "1h", "4h", "1d"}


def _merge(base: dict, extra: dict) -> dict:
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def load_config(root: Path = ROOT) -> dict:
    """config.json, optionally overridden by config.local.json (keep API tokens in the local file)."""
    cfg = json.loads((root / "config.json").read_text(encoding="utf-8"))
    local = root / "config.local.json"
    if local.exists():
        _merge(cfg, json.loads(local.read_text(encoding="utf-8")))
    return cfg


def create_app(cfg: dict | None = None, start_sources: bool = True, root: Path = ROOT) -> FastAPI:
    CFG = cfg if cfg is not None else load_config(root)
    sources_cfg = CFG.get("sources", {})
    STATE = SharedState(max_trades=30000)
    HIST = HistoryStore(root, CFG.get("recording", {}), CFG.get("heat", {}), CFG.get("flow", {}))
    MT5 = MT5Source(STATE, CFG.get("mt5", {}))
    OANDA = OandaSource(STATE, CFG.get("oanda", {}), HIST)
    BIN_FUT = BinanceSource(STATE, sources_cfg.get("binance_futures", {}))
    BIN_SPOT = BinanceSource(STATE, sources_cfg.get("binance_spot", {}))
    REC = Recorder(STATE, CFG.get("recording", {}), root)
    engine_cfg = dict(CFG.get("engine", {}))
    engine_cfg["reference_priority"] = CFG.get("price", {}).get("priority", engine_cfg.get("reference_priority", ["MT5", "OANDA"]))
    ENGINE = LiquidityEngine(STATE, engine_cfg, CFG.get("heat", {}), CFG.get("flow", {}), HIST.add_heat, HIST.add_flow)
    TASKS: list[asyncio.Task] = []
    runtime = {"historyFlushError": None, "lastHistoryFlushMs": None}

    async def flusher():
        try:
            await asyncio.to_thread(HIST.init)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            runtime["historyFlushError"] = f"{type(exc).__name__}: {exc}"[:300]
            logger.exception("History store initialization failed")
        while True:
            try:
                await asyncio.to_thread(HIST.flush)
                runtime["historyFlushError"] = None
                runtime["lastHistoryFlushMs"] = now_ms()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                runtime["historyFlushError"] = f"{type(exc).__name__}: {exc}"[:300]
                logger.exception("History flush failed")
            await asyncio.sleep(5)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        TASKS.append(asyncio.create_task(flusher(), name="history-flush"))
        if start_sources:
            if CFG.get("mt5", {}).get("enabled", True):
                TASKS.append(asyncio.create_task(MT5.run(), name="mt5"))
            if CFG.get("oanda", {}).get("enabled", True):
                TASKS.append(asyncio.create_task(OANDA.run(), name="oanda"))
            if sources_cfg.get("binance_futures", {}).get("enabled", True):
                TASKS.append(asyncio.create_task(BIN_FUT.run(), name="binance-futures"))
            if sources_cfg.get("binance_spot", {}).get("enabled", True):
                TASKS.append(asyncio.create_task(BIN_SPOT.run(), name="binance-spot"))
            if sources_cfg.get("bitfinex", {}).get("enabled", True):
                TASKS.append(asyncio.create_task(BitfinexSource(STATE, sources_cfg["bitfinex"]).run(), name="bitfinex"))
            if sources_cfg.get("kraken", {}).get("enabled", True):
                for sym in sources_cfg["kraken"].get("symbols", ["XAUT/USD"]):
                    TASKS.append(asyncio.create_task(KrakenSource(STATE, sources_cfg["kraken"], sym).run(), name=f"kraken:{sym}"))
            if sources_cfg.get("okx", {}).get("enabled", True):
                for sym in sources_cfg["okx"].get("symbols", ["XAUT-USDT"]):
                    TASKS.append(asyncio.create_task(OKXSource(STATE, sources_cfg["okx"], sym).run(), name=f"okx:{sym}"))
            TASKS.append(asyncio.create_task(ENGINE.run(), name="engine"))
            if CFG.get("recording", {}).get("enabled", True):
                TASKS.append(asyncio.create_task(REC.run(), name="recorder"))
        yield
        for task in TASKS:
            task.cancel()
        await asyncio.gather(*TASKS, return_exceptions=True)
        TASKS.clear()

    app = FastAPI(title="JOMA GOLD Gold Intelligence Terminal", version=VERSION, lifespan=lifespan)
    app.state.ctx = SimpleNamespace(cfg=CFG, state=STATE, history=HIST, engine=ENGINE, oanda=OANDA, mt5=MT5, runtime=runtime)
    app.mount("/static", StaticFiles(directory=root / "frontend"), name="static")

    @app.get("/")
    async def index():
        return FileResponse(root / "frontend" / "index.html")

    @app.get("/api/state")
    async def state():
        return await STATE.snapshot()

    @app.get("/api/health")
    async def health():
        """Service liveness plus an explicit, freshness-aware market-data readiness report."""
        s = await STATE.snapshot()
        now = now_ms()
        stale_after_ms = max(1500, int(CFG.get("engine", {}).get("stale_source_ms", 6500)))
        engine_updated = int(s.get("engineUpdatedMs") or 0)
        engine_age_ms = max(0, now - engine_updated) if engine_updated else None
        source_rows = s.get("sources") or {}
        fresh_names = [
            name for name, item in source_rows.items()
            if item.get("ok") is True
            and item.get("ageMs") is not None
            and 0 <= int(item.get("ageMs") or 0) <= stale_after_ms
        ]
        reference_source = str(s.get("referenceSource") or "NONE")
        reference_price = s.get("referencePrice")
        try:
            reference_price_valid = math.isfinite(float(reference_price)) and float(reference_price) > 0
        except (TypeError, ValueError):
            reference_price_valid = False
        if reference_source.startswith("OANDA"):
            reference_feed_fresh = "OANDA" in fresh_names
        elif reference_source.startswith("MT5"):
            reference_feed_fresh = "MT5_DOM" in fresh_names
        elif reference_source == "PUBLIC_MEDIAN":
            reference_feed_fresh = any(name not in {"OANDA", "MT5_DOM"} for name in fresh_names)
        else:
            reference_feed_fresh = False
        reference_fresh = bool(
            reference_price_valid and reference_feed_fresh and engine_age_ms is not None
            and engine_age_ms <= stale_after_ms
        )
        if reference_fresh and len(fresh_names) >= 2:
            market_data_status = "LIVE"
        elif reference_fresh or fresh_names:
            market_data_status = "DEGRADED"
        else:
            market_data_status = "OFFLINE"
        metrics = s.get("metrics") or {}
        try:
            quality = float(metrics.get("quality"))
        except (TypeError, ValueError):
            quality = 0.0
        analysis_ready = bool(
            reference_fresh and len(fresh_names) >= 2
            and math.isfinite(quality)
            and quality >= float(CFG.get("engine", {}).get("signal_min_quality", 0.42))
        )
        try:
            stats = await asyncio.to_thread(HIST.stats)
        except Exception as exc:  # diagnostics must never break the endpoint
            stats = {"error": str(exc)}
        return {
            # `ok` means the local API is responding; use marketDataStatus for feed readiness.
            "ok": True,
            "status": "ok",
            "version": VERSION,
            "marketDataStatus": market_data_status,
            "marketDataReady": reference_fresh,
            "analysisReady": analysis_ready,
            "engineAgeMs": engine_age_ms,
            "freshSourceCount": len(fresh_names),
            "freshSources": fresh_names,
            "totalSourceCount": len(source_rows),
            "referenceFeedFresh": reference_feed_fresh,
            "referenceSource": reference_source,
            "referencePrice": reference_price,
            "engineUpdatedMs": engine_updated,
            "sources": source_rows,
            "metrics": metrics,
            "history": stats,
            "historyFlushError": runtime.get("historyFlushError"),
            "lastHistoryFlushMs": runtime.get("lastHistoryFlushMs"),
            "engineError": getattr(ENGINE, "last_error", None),
            "oandaConfigured": OANDA.configured,
            "fakeFallback": False,
            "autoTrading": False,
        }

    @app.get("/api/candles")
    async def candles(tf: str = "15m", limit: int = 800):
        if tf not in TFS:
            tf = "15m"
        limit = max(50, min(1500, int(limit)))
        pref = str(CFG.get("price", {}).get("chart", "auto")).lower()
        ref = str(STATE.reference_source or "")
        if pref == "oanda" or (pref == "auto" and ref.startswith("OANDA")):
            order = ["OANDA", "MT5"]
        elif pref == "mt5" or (pref == "auto" and ref.startswith("MT5")):
            order = ["MT5", "OANDA"]
        else:
            pri = [str(x).upper() for x in CFG.get("price", {}).get("priority", ["MT5", "OANDA"])]
            order = [p for p in pri if p in ("MT5", "OANDA")] or ["MT5", "OANDA"]
        errors = []
        for name in order:
            try:
                if name == "MT5":
                    rows, comp, label = await MT5.candles(tf, limit), "bid", f"MT5:{STATE.mt5_symbol}"
                else:
                    rows, comp, label = await OANDA.candles(tf, limit), OANDA.price_component_name, OANDA.label
                if rows:
                    return {"source": label, "component": comp, "timeframe": tf, "candles": rows, "fallback": False}
            except Exception as exc:
                errors.append(f"{name}: {exc}")
        try:
            rows = await BIN_FUT.candles(tf, limit)
            if rows:
                return {"source": f"BINANCE:{BIN_FUT.symbol}", "component": "last", "timeframe": tf, "candles": rows,
                        "fallback": True, "warning": "No broker candles available; this price differs from your broker.",
                        "errors": errors}
        except Exception as exc:
            errors.append(f"BINANCE: {exc}")
        raise HTTPException(503, "No real candle source available: " + " | ".join(errors))

    @app.get("/api/history")
    async def history(minutes: int = 30, limit: int = 4000):
        if not CFG.get("recording", {}).get("enabled", True):
            return {"enabled": False, "items": []}
        return {"enabled": True, "items": await REC.history(max(1, min(minutes, 10080)), max(10, min(limit, 20000)))}

    @app.get("/api/heat")
    async def heat(minutes: float = 120, step: float = 15, after: int | None = None):
        minutes = max(1.0, min(float(minutes), 4320.0))
        step = max(2.0, min(float(step), 14400.0))
        return await asyncio.to_thread(HIST.heat, minutes, step, after)

    @app.get("/api/flow")
    async def flow(minutes: float = 120, step: float = 20, pb: float = 0.5, min_usd: float = 150000):
        minutes = max(1.0, min(float(minutes), 4320.0))
        return await asyncio.to_thread(HIST.flow, minutes, max(5.0, float(step)), max(0.5, float(pb)), max(0.0, float(min_usd)))

    @app.get("/api/footprint")
    async def footprint(tf: str = "15m", minutes: float = 720, bucket: float = 1.0, bars: str = ""):
        """Historical, recorded venue flow for exploratory price-level footprint displays."""
        tfmap = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400}
        if tf not in tfmap:
            raise HTTPException(status_code=400, detail="Unsupported timeframe")
        if not math.isfinite(minutes) or not math.isfinite(bucket):
            raise HTTPException(status_code=400, detail='Time window and price bucket must be finite')
        minutes = max(1.0, min(float(minutes), 10080.0))
        bucket = max(0.5, min(float(bucket), 20.0))
        bar_starts = None
        if bars:
            try:
                if len(bars) > 3500:
                    raise ValueError("too many candle times")
                bar_starts = [int(x) for x in bars.split(",")]
                if not (1 <= len(bar_starts) <= 240) or any(
                    b <= a for a, b in zip(bar_starts, bar_starts[1:])
                ) or any(t <= 0 for t in bar_starts):
                    raise ValueError("invalid candle times")
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid broker candle times")
        return await asyncio.to_thread(HIST.footprint, minutes, tfmap[tf], bucket, 160, bar_starts)

    @app.get("/api/book")
    async def book(window: float = 60):
        return await asyncio.to_thread(HIST.latest_book, max(5.0, min(float(window), 200.0)))

    @app.get("/api/delta")
    async def delta(minutes: float = 180, step: float = 60):
        return await asyncio.to_thread(HIST.delta, max(1.0, min(float(minutes), 4320.0)), max(5.0, float(step)))

    @app.get("/api/flow/range")
    async def flow_range(t0: int, t1: int, p0: float, p1: float):
        if t1 < t0:
            t0, t1 = t1, t0
        return await asyncio.to_thread(HIST.flow_range, t0, t1, p0, p1)

    @app.get("/api/oanda/books")
    async def oanda_books(kind: str = "order", minutes: float = 1440):
        kind = "position" if kind == "position" else "order"
        return {
            "kind": kind, "instrument": OANDA.instrument, "configured": OANDA.configured, "status": OANDA.book_status,
            "snapshots": await asyncio.to_thread(HIST.books, kind, max(20.0, min(float(minutes), 10080.0))),
        }

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        try:
            while True:
                await ws.send_json(await STATE.snapshot())
                await asyncio.sleep(0.25)
        except (WebSocketDisconnect, RuntimeError):
            pass

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    cfg = app.state.ctx.cfg
    uvicorn.run("app:app", host=str(cfg.get("host", "127.0.0.1")), port=int(cfg.get("port", 8080)), reload=False)
