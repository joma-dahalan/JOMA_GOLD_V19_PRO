from __future__ import annotations

import asyncio
import bisect
import logging
import math
import time
from collections import defaultdict, deque
from statistics import mean, median

from .state import SharedState, now_ms

# Broker price feeds (can act as the chart's reference price). Everything else is a public venue.
BROKER_FEEDS = {"MT5_DOM": "MT5", "OANDA": "OANDA"}
logger = logging.getLogger("joma.engine")


class _Basis:
    def __init__(self, window: int, alpha: float):
        self.samples = deque(maxlen=max(5, window))
        self.alpha = max(0.02, min(1.0, alpha))
        self.ema: float | None = None

    def update(self, value: float) -> float:
        if not math.isfinite(value):
            return self.ema or 0.0
        self.samples.append(value)
        robust = median(self.samples)
        self.ema = robust if self.ema is None else (self.alpha * robust + (1 - self.alpha) * self.ema)
        return self.ema


class LiquidityEngine:
    """v8.2-inspired multi-venue liquidity/flow engine for the web UI.

    The score describes observable liquidity quality; it is deliberately not a
    win-rate/probability. Directional bias is calculated separately from flow,
    book imbalance and MT5 short-term trend.
    """

    def __init__(self, state: SharedState, cfg: dict, heat_cfg: dict | None = None, flow_cfg: dict | None = None,
                 heat_sink=None, flow_sink=None):
        self.state = state
        self.cfg = cfg
        self.hist: dict[tuple[str, float], dict] = {}
        self.basis: dict[str, _Basis] = {}
        self._ref_name: str | None = None
        self.heat_cfg = heat_cfg or {}
        self.flow_cfg = flow_cfg or {}
        self.heat_sink = heat_sink
        self.flow_sink = flow_sink
        self._last_heat = 0
        self._flow_seq = 0
        self._flow_acc: dict[tuple[int, int], list[float]] = {}
        self.last_error: str | None = None

    @staticmethod
    def _clamp(x: float, a: float = 0.0, b: float = 1.0) -> float:
        return max(a, min(b, x))

    async def run(self):
        delay = max(0.18, float(self.cfg.get("snapshot_interval_ms", 350)) / 1000)
        while True:
            try:
                await self.compute()
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"[:300]
                logger.exception("Liquidity engine computation failed")
            await asyncio.sleep(delay)

    def _basis_for(self, name: str, ref: float, mid: float) -> float:
        if name == self._ref_name:
            return 0.0
        tracker = self.basis.get(name)
        if tracker is None:
            tracker = _Basis(int(self.cfg.get("basis_window", 31)), float(self.cfg.get("basis_ema_alpha", 0.22)))
            self.basis[name] = tracker
        return tracker.update(ref - mid)

    @staticmethod
    def _trend_score(m15: list[dict], m5: list[dict]) -> float:
        if not m15 or not m5:
            return 0.0
        ranges = [max(0.0, r["high"] - r["low"]) for r in m15[-20:]]
        atr = max(0.01, mean(ranges) if ranges else 0.01)

        def slope(rows: list[dict], window: int) -> float:
            closes = [float(r["close"]) for r in rows]
            if len(closes) < window * 2:
                return 0.0
            recent = mean(closes[-window:])
            previous = mean(closes[-window * 2:-window])
            return (recent - previous) / atr

        return max(-1.0, min(1.0, slope(m15, 6) * 0.62 + slope(m5, 8) * 0.38))

    @staticmethod
    def _candle_confirmation(m5: list[dict], direction: str) -> bool:
        if len(m5) < 3:
            return False
        last, prev = m5[-1], m5[-2]
        if direction == "BUY":
            return last["close"] > last["open"] and last["close"] >= prev["close"]
        return last["close"] < last["open"] and last["close"] <= prev["close"]

    def _flow_metrics(self, trades, basis_map: dict[str, float], ref: float):
        window_ms = int(float(self.cfg.get("trade_window_seconds", 8)) * 1000)
        cutoff = now_ms() - window_ms
        by_source: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
        recent = []
        max_distance = float(self.cfg.get("max_distance_usd", 180)) * 1.3
        for tr in trades:
            if tr.ts_ms < cutoff:
                continue
            shift = basis_map.get(tr.source)
            if shift is None:
                continue
            aligned = tr.price + shift
            if abs(aligned - ref) > max_distance:
                continue
            notional = max(0.0, tr.qty * aligned)
            if tr.side == "buy":
                by_source[tr.source][0] += notional
            else:
                by_source[tr.source][1] += notional
            recent.append((tr, aligned, notional))
        ratios = []
        buy_total = sell_total = 0.0
        for buy, sell in by_source.values():
            total = buy + sell
            if total <= 0:
                continue
            ratios.append((buy - sell) / total)
            buy_total += buy; sell_total += sell
        flow = mean(ratios) if ratios else 0.0
        return max(-1.0, min(1.0, flow)), buy_total, sell_total, recent, len(ratios)

    def _book_imbalance(self, grouped, ref: float) -> float:
        near = float(self.cfg.get("near_distance_usd", 20))
        bid = ask = 0.0
        for (side, center), g in grouped.items():
            d = abs(center - ref)
            if d > near:
                continue
            weight = 1.0 / (1.0 + d / max(0.25, near / 5))
            if side == "buy": bid += g["notional"] * weight
            else: ask += g["notional"] * weight
        total = bid + ask
        return (bid - ask) / total if total > 0 else 0.0

    def _record_heat(self, live, basis_map, ref: float, nowm: int):
        """One aligned, merged resting-liquidity column every `interval_ms` — exactly what the books showed."""
        sink, hc = self.heat_sink, self.heat_cfg
        if sink is None or not hc.get("enabled", True):
            return
        if nowm - self._last_heat < int(hc.get("interval_ms", 5000)):
            return
        bucket = max(0.05, float(hc.get("bucket_usd", 0.5)))
        window = float(hc.get("window_usd", 70))
        min_k = float(hc.get("min_k_usd", 20))
        cap = int(hc.get("max_cells", 400))
        acc: dict[int, list[float]] = {}
        for name, snap in live.items():
            shift = basis_map.get(name)
            if shift is None or not snap.levels:
                continue
            for lv in snap.levels:
                n = float(lv.get("notional") or 0)
                side = str(lv.get("side", "")).lower()
                if n <= 0 or side not in ("buy", "sell"):
                    continue
                p = float(lv["price"]) + shift
                if abs(p - ref) > window:
                    continue
                a = acc.setdefault(int(round(p / bucket)), [0.0, 0.0])
                a[0 if side == "buy" else 1] += n
        cells = [(idx, (b + s_) / 1000.0, 1 if b >= s_ else 0) for idx, (b, s_) in acc.items() if (b + s_) / 1000.0 >= min_k]
        if not cells:
            return
        if len(cells) > cap:
            cells.sort(key=lambda c: c[1], reverse=True)
            cells = cells[:cap]
        self._last_heat = nowm
        sink(nowm, bucket, ref, cells)

    def _record_flow(self, trades, basis_map, nowm: int):
        """Executed trades -> 5 s x price-bucket rows, aligned to the reference axis at the time they printed."""
        fb = max(0.05, float(self.flow_cfg.get("bucket_usd", 0.5)))
        fresh = []
        for tr in reversed(trades):
            if tr.seq <= self._flow_seq:
                break
            fresh.append(tr)
        top = self._flow_seq
        for tr in fresh:
            top = max(top, tr.seq)
            shift = basis_map.get(tr.source)
            if shift is None:
                continue
            aligned = tr.price + shift
            a = self._flow_acc.setdefault((tr.ts_ms // 5000 * 5000, int(round(aligned / fb))), [0.0, 0.0, 0, 0.0])
            usd = tr.qty * aligned
            a[0 if tr.side == "buy" else 1] += usd
            a[2] += 1
            a[3] += tr.qty
        self._flow_seq = top
        cutoff = (nowm - 12000) // 5000 * 5000
        done = [(k, v) for k, v in self._flow_acc.items() if k[0] < cutoff]
        if done:
            for k, _ in done:
                del self._flow_acc[k]
            if self.flow_sink:
                self.flow_sink([(k[0], k[1], v[0], v[1], int(v[2]), v[3]) for k, v in done])

    async def compute(self):
        async with self.state.lock:
            sources = {k: v for k, v in self.state.sources.items()}
            trades = tuple(self.state.trades)
            m5 = list(self.state.candles_m5)
            m15 = list(self.state.candles_m15)

        stale_ms = int(self.cfg.get("stale_source_ms", 6500))
        nowm = now_ms()
        live = {k: v for k, v in sources.items() if v.ok and v.mid and v.updated_ms and nowm - v.updated_ms <= stale_ms}

        # Reference price = the first live broker feed in `reference_priority` (default MT5, then OANDA).
        # Only when no broker feed is alive do we fall back to the median of live public venues (and say so).
        priority = [str(x).upper() for x in self.cfg.get("reference_priority", ["MT5", "OANDA"])]
        ref = None
        ref_src = "NONE"
        self._ref_name = None
        for want in priority:
            for name, kind in BROKER_FEEDS.items():
                snap = live.get(name)
                if kind == want and snap is not None and snap.mid and math.isfinite(snap.mid):
                    ref = float(snap.mid)
                    self._ref_name = name
                    ref_src = (snap.meta or {}).get("label") or kind
                    break
            if self._ref_name:
                break
        if ref is None:
            mids = sorted(v.mid for k, v in live.items() if k not in BROKER_FEEDS and v.mid)
            if mids:
                ref = median(mids)
                ref_src = "PUBLIC_MEDIAN"
            else:
                async with self.state.lock:
                    # Clear the last reference explicitly: otherwise the UI could mistake a stale
                    # price for a live one after every source has disconnected.
                    self.state.reference_price = None
                    self.state.reference_source = "NONE"
                    self.state.basis = {}
                    self.state.zones = []
                    self.state.metrics = {"quality": 0.0, "reason": "No live reference price"}
                    self.state.bias = {"status": "NO_DATA", "direction": "NEUTRAL", "score": 0, "reason": "No live price"}
                    self.state.engine_updated_ms = nowm
                return

        basis_map: dict[str, float] = {}
        for name, snap in live.items():
            if snap.mid:
                basis_map[name] = self._basis_for(name, ref, snap.mid)

        self._record_heat(live, basis_map, ref, nowm)
        self._record_flow(trades, basis_map, nowm)

        bucket = max(0.05, float(self.cfg.get("bucket_usd", 0.5)))
        maxdist = float(self.cfg.get("max_distance_usd", 180))
        minnot = float(self.cfg.get("min_notional_usd", 10000))
        grouped: dict[tuple[str, float], dict] = {}
        for name, snap in live.items():
            shift = basis_map.get(name)
            if shift is None:
                continue
            for lv in snap.levels:
                notional = float(lv.get("notional") or 0)
                if notional <= 0:
                    continue
                aligned = float(lv["price"]) + shift
                if abs(aligned - ref) > maxdist:
                    continue
                side = str(lv.get("side", "")).lower()
                if side not in {"buy", "sell"}:
                    continue
                center = round(aligned / bucket) * bucket
                key = (side, center)
                g = grouped.setdefault(key, {
                    "side": side, "center": center, "notional": 0.0,
                    "sources": defaultdict(float), "raw": [],
                })
                g["notional"] += notional
                g["sources"][name] += notional
                g["raw"].append({"source":name,"rawPrice":lv["price"],"alignedPrice":aligned,"notional":notional})

        values = sorted(g["notional"] for g in grouped.values() if g["notional"] >= minnot)
        flow, buy_flow_usd, sell_flow_usd, recent_trades, trade_sources = self._flow_metrics(trades, basis_map, ref)
        book = self._book_imbalance(grouped, ref)
        trend = self._trend_score(m15, m5)

        live_public = [k for k in live if k not in BROKER_FEEDS]
        mt5_ref = str(ref_src).startswith("MT5")
        broker_ref = self._ref_name is not None
        freshness = mean([self._clamp(1 - (nowm - s.updated_ms) / max(1, stale_ms)) for s in live.values()]) if live else 0.0
        quality = self._clamp(
            (0.24 if broker_ref else 0.10)
            + 0.34 * self._clamp(len(live_public) / 5)
            + 0.24 * self._clamp(trade_sources / 4)
            + 0.18 * freshness
        )

        if not values:
            async with self.state.lock:
                self.state.reference_price = ref; self.state.reference_source = ref_src
                self.state.basis = {k: round(v, 5) for k, v in basis_map.items()}
                self.state.zones = []
                self.state.metrics = {
                    "quality": round(quality,3), "flow": round(flow,4), "bookImbalance":round(book,4),
                    "trend":round(trend,4), "tradeSources":trade_sources, "liveSources":len(live_public),
                }
                self.state.bias = {"status":"WARMING","direction":"NEUTRAL","score":round(quality*100),"reason":"No qualifying liquidity zones yet"}
                self.state.engine_updated_ms = nowm
            return

        def pct_rank(v: float) -> float:
            return bisect.bisect_right(values, v) / max(1, len(values))

        now = time.time(); zones=[]; active=set()
        persistence_full = max(5.0, float(self.cfg.get("persistence_full_seconds",45)))
        local_radius = max(bucket, float(self.cfg.get("local_trade_radius_usd",1.25)))
        for key,g in grouped.items():
            if g["notional"] < minnot:
                continue
            active.add(key)
            h = self.hist.get(key)
            if h is None:
                h = {"first":now,"last":now,"prev":g["notional"],"ema":g["notional"],"peak":g["notional"],"addEma":0.0,"pullEma":0.0,"seen":0}
            delta = g["notional"] - h["prev"]
            h["addEma"] = 0.82*h["addEma"] + 0.18*max(0.0,delta)
            h["pullEma"] = 0.82*h["pullEma"] + 0.18*max(0.0,-delta)
            h["prev"] = g["notional"]
            h["ema"] = 0.78*h["ema"] + 0.22*g["notional"]
            h["peak"] = max(h["peak"],g["notional"])
            h["last"] = now; h["seen"] += 1; self.hist[key]=h
            age = now-h["first"]

            executed_against = 0.0; executed_with = 0.0
            for tr, aligned, n in recent_trades:
                if abs(aligned-g["center"]) > local_radius:
                    continue
                if g["side"]=="buy":
                    if tr.side=="sell": executed_against += n
                    else: executed_with += n
                else:
                    if tr.side=="buy": executed_against += n
                    else: executed_with += n

            size_score = pct_rank(g["notional"])
            persistence = self._clamp(age/persistence_full)
            source_count = len(g["sources"])
            consensus = self._clamp((source_count-1)/3)
            pull_ratio = self._clamp(h["pullEma"] / max(h["ema"],1.0))
            stability = 1-pull_ratio
            exec_ratio = executed_against / max(g["notional"],1.0)
            execution = self._clamp(exec_ratio/0.30)
            book_refill = self._clamp(g["notional"] / max(h["peak"]*0.80,1.0))
            replenishment = self._clamp(execution * book_refill)
            absorption_score = self._clamp(execution * stability)
            absorption = absorption_score >= 0.35 and executed_against > 0
            fresh = mean([
                self._clamp(1-(nowm-live[src].updated_ms)/max(1,stale_ms))
                for src in g["sources"] if src in live
            ]) if g["sources"] else 0.0
            fleeting_penalty = 0.12 if age < 1.5 and pull_ratio > 0.25 else 0.0
            strength01 = self._clamp(
                0.28*size_score + 0.18*persistence + 0.16*consensus + 0.12*stability
                + 0.12*execution + 0.08*replenishment + 0.06*fresh - fleeting_penalty
            )
            strength = round(100*strength01)
            if strength < int(self.cfg.get("min_strength",18)):
                continue
            src_sorted = dict(sorted(g["sources"].items(), key=lambda x:x[1], reverse=True))
            max_venue = max(src_sorted.values()) if src_sorted else 0.0
            zones.append({
                "id": f"{g['side']}:{g['center']:.3f}",
                "side":g["side"], "center":round(g["center"],3),
                "low":round(g["center"]-bucket/2,3), "high":round(g["center"]+bucket/2,3),
                "notionalUsd":round(g["notional"],2), "notionalM":round(g["notional"]/1e6,4),
                "maxVenueNotionalUsd":round(max_venue,2), "strength":strength,
                "sourceCount":source_count, "sources":src_sorted,
                "distanceUsd":round(g["center"]-ref,3), "persistenceSec":round(age,1),
                "addedUsd":round(h["addEma"],2), "pulledUsd":round(h["pullEma"],2),
                "executedAgainstUsd":round(executed_against,2), "executedWithUsd":round(executed_with,2),
                "replenishment":round(replenishment,3), "stability":round(stability,3),
                "absorption":absorption, "absorptionScore":round(absorption_score,3),
                "fleeting":bool(age < 1.5 and pull_ratio > 0.25),
                "label":"VERY STRONG" if strength>=85 else "STRONG" if strength>=70 else "MEDIUM" if strength>=50 else "LIGHT",
            })

        # Retain short gaps for persistence tracking, then reset old vanished levels.
        retention = 8.0
        for k in list(self.hist):
            if k not in active and now-self.hist[k]["last"]>retention:
                self.hist.pop(k,None)

        # Preserve visibility across near/mid/far/deep ranges. The v8.2 engine
        # deliberately avoided letting dense near-spot rows consume every slot.
        near=float(self.cfg.get("near_distance_usd",20))
        mid=float(self.cfg.get("mid_distance_usd",60))
        far=float(self.cfg.get("far_distance_usd",120))
        maxd=float(self.cfg.get("max_distance_usd",180))
        tiers=[
            (0.0,near,int(self.cfg.get("near_zones_per_side",3))),
            (near,mid,int(self.cfg.get("mid_zones_per_side",2))),
            (mid,far,int(self.cfg.get("far_zones_per_side",2))),
            (far,maxd,int(self.cfg.get("deep_zones_per_side",2))),
        ]
        limit=int(self.cfg.get("top_zones",18))
        selected=[]; selected_ids=set()
        for side in ("buy","sell"):
            side_rows=[z for z in zones if z["side"]==side]
            for lo,hi,quota in tiers:
                band=sorted(
                    [z for z in side_rows if abs(z["distanceUsd"])<=hi+1e-9 and (lo<=0 or abs(z["distanceUsd"])>lo)],
                    key=lambda z:(z["strength"],z["notionalUsd"]), reverse=True
                )
                for z in band[:max(0,quota)]:
                    if z["id"] not in selected_ids:
                        selected.append(z); selected_ids.add(z["id"])
        if len(selected)<limit:
            for z in sorted(zones,key=lambda z:(z["strength"],z["notionalUsd"]),reverse=True):
                if z["id"] in selected_ids: continue
                selected.append(z); selected_ids.add(z["id"])
                if len(selected)>=limit: break
        zones=sorted(selected[:limit],key=lambda z:(z["strength"],z["notionalUsd"]),reverse=True)

        composite = max(-1.0,min(1.0,flow*0.55+book*0.20+trend*0.25))
        threshold = float(self.cfg.get("signal_flow_threshold",0.22))
        direction = "BUY" if composite>=threshold else "SELL" if composite<=-threshold else "NEUTRAL"
        status = "WATCH"; reason = "Balanced flow"
        analysis_score = round(100*(0.50*abs(composite)+0.30*quality+0.20*(1 if direction!="NEUTRAL" and self._candle_confirmation(m5,direction) else 0)))
        target = support = None
        if direction != "NEUTRAL":
            above = sorted([z for z in zones if z["side"]=="sell" and z["center"]>ref], key=lambda z:(-z["strength"],z["center"]-ref))
            below = sorted([z for z in zones if z["side"]=="buy" and z["center"]<ref], key=lambda z:(-z["strength"],ref-z["center"]))
            target = (above[0] if above else None) if direction=="BUY" else (below[0] if below else None)
            support = (below[0] if below else None) if direction=="BUY" else (above[0] if above else None)
            candle_ok = self._candle_confirmation(m5,direction)
            if quality < float(self.cfg.get("signal_min_quality",0.42)):
                status="WAIT"; reason="Directional flow exists, but data quality is still warming"
            elif not target or not support:
                status="WAIT"; reason="Directional flow exists, but two-sided liquidity is incomplete"
            elif not candle_ok:
                status="WAIT"; reason=f"{direction} flow present; waiting for M5 confirmation"
            else:
                status="CONFIRMED_BIAS"; reason=f"{direction} flow + book + trend + M5 confirmation aligned"

        metrics = {
            "quality":round(quality,3), "flow":round(flow,4), "bookImbalance":round(book,4), "trend":round(trend,4),
            "composite":round(composite,4), "aggressiveBuyUsd":round(buy_flow_usd,2), "aggressiveSellUsd":round(sell_flow_usd,2),
            "tradeSources":trade_sources, "liveSources":len(live_public), "referenceIsMT5":mt5_ref, "referenceIsBroker":broker_ref,
        }
        bias = {
            "status":status, "direction":direction, "score":analysis_score, "reason":reason,
            "composite":round(composite,4), "targetZone":target, "supportZone":support,
            "warning":"Analysis score is not a win probability and does not execute trades.",
        }

        async with self.state.lock:
            self.state.reference_price=ref; self.state.reference_source=ref_src
            self.state.basis={k:round(v,5) for k,v in basis_map.items()}
            self.state.zones=zones; self.state.metrics=metrics; self.state.bias=bias; self.state.engine_updated_ms=nowm
