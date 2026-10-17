from __future__ import annotations

import json
import sqlite3
import struct
import threading
from bisect import bisect_right
import time
import zlib
from collections import defaultdict
from pathlib import Path

_CELL = struct.Struct("<iHB")  # price index, k$ (0..65535), side bit (1 = bid/buy dominant)


def pack_cells(cells) -> bytes:
    out = bytearray()
    for idx, k, side in cells:
        out += _CELL.pack(int(idx), max(0, min(65535, int(k))), 1 if side else 0)
    return bytes(out)


def unpack_cells(blob: bytes):
    return list(_CELL.iter_unpack(blob))


def bin_heat_rows(rows, step_ms: int, max_cells: int = 400):
    """rows: iterable of (ts_ms, bucket, cells[(idx,k,side)]).

    Returns (bucket, bins[{t, cells[[idx, mean_k, side]]}]). Missing cells count as zero so the
    per-bin value is the *average* resting size over the bin, not a sum of snapshots.
    """
    bins: dict[int, dict] = {}
    bucket = None
    for ts, b, cells in rows:
        if bucket is None:
            bucket = b
        if abs(b - bucket) > 1e-9:
            continue
        key = (ts // step_ms) * step_ms
        acc = bins.get(key)
        if acc is None:
            acc = bins[key] = {"n": 0, "k": defaultdict(float), "s": defaultdict(int)}
        acc["n"] += 1
        for idx, k, side in cells:
            acc["k"][idx] += k
            acc["s"][idx] += 1 if side else -1
    out = []
    for key in sorted(bins):
        acc = bins[key]
        n = max(1, acc["n"])
        items = [[idx, round(total / n, 1), 1 if acc["s"][idx] >= 0 else 0] for idx, total in acc["k"].items()]
        if len(items) > max_cells:
            items.sort(key=lambda c: c[1], reverse=True)
            items = items[:max_cells]
        out.append({"t": key, "cells": items})
    return bucket, out


def aggregate_flow_rows(rows, step_ms: int, price_bucket: float, flow_bucket: float, min_usd: float, limit: int = 400):
    """rows: (slot_ms, idx, buy_usd, sell_usd, n, qty) -> (bubbles, cvd)."""
    pb = max(flow_bucket, price_bucket)
    bub: dict[tuple[int, int], list] = {}
    cvd_bins: dict[int, float] = {}
    run = 0.0
    for slot, idx, buy, sell, n, qty in rows:
        tb = (slot // step_ms) * step_ms
        pk = int(round(idx * flow_bucket / pb))
        a = bub.setdefault((tb, pk), [0.0, 0.0, 0, 0.0])
        a[0] += buy
        a[1] += sell
        a[2] += n
        a[3] += qty
        run += buy - sell
        cvd_bins[tb] = run
    bubbles = []
    for (tb, pk), (buy, sell, n, qty) in bub.items():
        usd = buy + sell
        if usd < min_usd:
            continue
        bubbles.append({
            "t": tb + step_ms // 2, "price": round(pk * pb, 4), "usd": round(usd), "buyUsd": round(buy), "sellUsd": round(sell),
            "sell": sell > buy, "momentum": round((buy - sell) / usd, 3) if usd else 0.0, "n": n, "qty": round(qty, 2),
        })
    bubbles.sort(key=lambda b: b["usd"], reverse=True)
    bubbles = bubbles[:limit]
    bubbles.sort(key=lambda b: b["t"])
    cvd = [{"t": tb + step_ms // 2, "v": round(v)} for tb, v in sorted(cvd_bins.items())]
    return bubbles, cvd


class HistoryStore:
    """Persistent record of what was *actually observed*: aligned book columns, executed flow, OANDA books.

    Nothing here is synthesised. A time range with no rows is simply empty on the chart.
    """

    def __init__(self, root: Path, cfg: dict, heat_cfg: dict | None = None, flow_cfg: dict | None = None):
        self.path = (root / str(cfg.get("sqlite_path", "data/liquidity_history.db"))).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.retention_h = float(cfg.get("heat_retention_hours", 72))
        self.flow_bucket = float((flow_cfg or {}).get("bucket_usd", 0.5))
        self.heat_bucket = float((heat_cfg or {}).get("bucket_usd", 0.5))
        self.lock = threading.RLock()
        self._heat: list[tuple] = []
        self._flow: list[tuple] = []
        self._books: list[tuple] = []
        self._ready = False
        self._last_purge = 0.0
        self._last_col: tuple | None = None
        self.counters = {"heatColumns": 0, "flowRows": 0, "books": 0}

    # ---- setup -----------------------------------------------------------------
    def init(self):
        with self.lock:
            con = sqlite3.connect(self.path)
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("CREATE TABLE IF NOT EXISTS heat (ts INTEGER PRIMARY KEY, bucket REAL, ref REAL, cells BLOB)")
            con.execute(
                "CREATE TABLE IF NOT EXISTS flow (slot INTEGER, idx INTEGER, buy REAL, sell REAL, n INTEGER, qty REAL, PRIMARY KEY(slot, idx))"
            )
            con.execute(
                "CREATE TABLE IF NOT EXISTS oanda_books (kind TEXT, ts INTEGER, price REAL, width REAL, buckets TEXT, PRIMARY KEY(kind, ts))"
            )
            con.commit()
            con.close()
            self._ready = True

    # ---- sinks (called from the event loop; cheap, no I/O) -----------------------
    def add_heat(self, ts_ms: int, bucket: float, ref: float, cells):
        if not cells:
            return
        self._last_col = (int(ts_ms), float(bucket), float(ref), [(int(i), float(k), 1 if s else 0) for i, k, s in cells])
        self._heat.append((int(ts_ms), float(bucket), float(ref), zlib.compress(pack_cells(cells), 1)))

    def add_flow(self, rows):
        for slot, idx, buy, sell, n, qty in rows:
            self._flow.append((int(slot), int(idx), float(buy), float(sell), int(n), float(qty)))

    def add_book(self, book: dict):
        self._books.append((
            str(book["kind"]), int(book["ts"]), float(book.get("price") or 0), float(book.get("width") or 0),
            json.dumps(book["buckets"], separators=(",", ":")),
        ))

    # ---- persistence -----------------------------------------------------------
    def flush(self):
        if not self._ready:
            self.init()
        with self.lock:
            heat, self._heat = self._heat, []
            flow, self._flow = self._flow, []
            books, self._books = self._books, []
            if not (heat or flow or books) and time.time() - self._last_purge < 600:
                return
            con = sqlite3.connect(self.path)
            if heat:
                con.executemany("INSERT OR REPLACE INTO heat(ts,bucket,ref,cells) VALUES(?,?,?,?)", heat)
                self.counters["heatColumns"] += len(heat)
            if flow:
                con.executemany(
                    "INSERT INTO flow(slot,idx,buy,sell,n,qty) VALUES(?,?,?,?,?,?) "
                    "ON CONFLICT(slot,idx) DO UPDATE SET buy=buy+excluded.buy, sell=sell+excluded.sell, n=n+excluded.n, qty=qty+excluded.qty",
                    flow,
                )
                self.counters["flowRows"] += len(flow)
            if books:
                con.executemany("INSERT OR REPLACE INTO oanda_books(kind,ts,price,width,buckets) VALUES(?,?,?,?,?)", books)
                self.counters["books"] += len(books)
            if time.time() - self._last_purge >= 600:
                self._last_purge = time.time()
                cutoff = int((time.time() - self.retention_h * 3600) * 1000)
                con.execute("DELETE FROM heat WHERE ts < ?", (cutoff,))
                con.execute("DELETE FROM flow WHERE slot < ?", (cutoff,))
                con.execute("DELETE FROM oanda_books WHERE ts < ?", (cutoff - 7 * 24 * 3600 * 1000,))
            con.commit()
            con.close()

    # ---- queries (blocking; call via asyncio.to_thread) ---------------------------
    def heat(self, minutes: float, step_s: float, after_ms: int | None = None, max_cells: int = 400):
        self.flush()
        now_ms = int(time.time() * 1000)
        since = int(after_ms) if after_ms else now_ms - int(minutes * 60_000)
        step_ms = max(1000, int(step_s * 1000))
        with self.lock:
            con = sqlite3.connect(self.path)
            rows = con.execute("SELECT ts,bucket,cells FROM heat WHERE ts>=? ORDER BY ts", (since,)).fetchall()
            con.close()
        bucket, bins = bin_heat_rows(((ts, b, unpack_cells(zlib.decompress(c))) for ts, b, c in rows), step_ms, max_cells)
        return {"ok": True, "bucket": bucket or self.heat_bucket, "stepMs": step_ms, "columns": len(rows), "bins": bins, "now": now_ms}

    def flow(self, minutes: float, step_s: float, price_bucket: float, min_usd: float, limit: int = 400):
        self.flush()
        now_ms = int(time.time() * 1000)
        since = now_ms - int(minutes * 60_000)
        with self.lock:
            con = sqlite3.connect(self.path)
            rows = con.execute("SELECT slot,idx,buy,sell,n,qty FROM flow WHERE slot>=? ORDER BY slot", (since,)).fetchall()
            con.close()
        bubbles, cvd = aggregate_flow_rows(rows, max(5000, int(step_s * 1000)), price_bucket, self.flow_bucket, min_usd, limit)
        return {"ok": True, "bubbles": bubbles, "cvd": cvd, "rows": len(rows), "now": now_ms}

    def footprint(self, minutes: float, timeframe_seconds: int, bucket_usd: float, max_bars: int = 160, bar_starts_s: list[int] | None = None):
        """Aggregate *recorded* executed notional by candle and price (no fabricated fills).

        Flow slots/indices are stored in UTC and represent public venue executions,
        aligned onto the broker's gold quote. This is not broker-side order flow.
        """
        self.flush()
        tf_ms = int(timeframe_seconds) * 1000
        now_ms = int(time.time() * 1000)
        since = max(now_ms - int(minutes * 60_000), now_ms - max_bars * tf_ms)
        base = float(self.flow_bucket)
        # Broker sessions / daily candles can start at times different from UTC bins.
        # When the client supplies real broker candle starts, assign an execution
        # to the exact observed candle, never across a weekend/session gap.
        starts_ms = [int(t) * 1000 for t in bar_starts_s] if bar_starts_s else None
        with self.lock:
            con = sqlite3.connect(self.path)
            rows = con.execute(
                "SELECT slot,idx,buy,sell,n FROM flow WHERE slot>=? ORDER BY slot DESC LIMIT 60000",
                (since,),
            ).fetchall()
            con.close()
        combined = {}
        # All recorded rows contribute. Price buckets are representative aggregates.
        for slot, idx, buy, sell, n in rows:
            if starts_ms:
                pos = bisect_right(starts_ms, int(slot)) - 1
                if pos < 0 or int(slot) >= starts_ms[pos] + tf_ms:
                    continue  # no broker candle covers this execution
                candle = starts_ms[pos]
            else:
                candle = (int(slot) // tf_ms) * tf_ms
            price_key = round((int(idx) * base) / bucket_usd)
            k = (candle, price_key)
            acc = combined.setdefault(k, [0.0, 0.0, 0])
            acc[0] += float(buy or 0)
            acc[1] += float(sell or 0)
            acc[2] += int(n or 0)
        out = [[t, round(i * bucket_usd, 3), round(x[0]), round(x[1]), x[2]]
               for (t, i), x in sorted(combined.items())]
        return {"ok": True, "tfSeconds": timeframe_seconds, "bucketUsd": bucket_usd,
                "rows": out, "recordCount": len(rows), "sampleLimited": len(rows) == 60000,
                "source": "recorded public-venue executions mapped to broker gold price", "now": now_ms}

    def latest_book(self, window_usd: float = 60.0):
        """The most recent recorded order-book column (what is resting right now), around its reference price."""
        col = self._last_col
        if col is None:
            self.flush()
            with self.lock:
                con = sqlite3.connect(self.path)
                row = con.execute("SELECT ts,bucket,ref,cells FROM heat ORDER BY ts DESC LIMIT 1").fetchone()
                con.close()
            if not row:
                return {"ok": False}
            col = (row[0], row[1], row[2], [(i, float(k), s) for i, k, s in unpack_cells(zlib.decompress(row[3]))])
        ts, bucket, ref, cells = col
        lo, hi = ref - window_usd, ref + window_usd
        cells = [[i, round(k, 1), s] for i, k, s in cells if lo <= i * bucket <= hi]
        return {"ok": True, "ts": ts, "ageMs": int(time.time() * 1000) - ts, "bucket": bucket, "ref": ref, "cells": cells}

    def delta(self, minutes: float, step_s: float):
        """Executed buy/sell per time bucket (all prices) -> drives the Delta bars and the CVD line."""
        self.flush()
        step_ms = max(5000, int(step_s * 1000))
        since = int(time.time() * 1000) - int(minutes * 60_000)
        with self.lock:
            con = sqlite3.connect(self.path)
            rows = con.execute(
                "SELECT (slot / ?) * ? AS b, SUM(buy), SUM(sell), SUM(n) FROM flow WHERE slot >= ? GROUP BY b ORDER BY b",
                (step_ms, step_ms, since),
            ).fetchall()
            con.close()
        return {"ok": True, "stepMs": step_ms, "rows": [{"t": b, "buy": round(bu), "sell": round(se), "n": n} for b, bu, se, n in rows]}

    def flow_range(self, t0_ms: int, t1_ms: int, p0: float, p1: float):
        """Executed flow inside a time x price rectangle (the measure tool)."""
        self.flush()
        lo, hi = (p0, p1) if p0 <= p1 else (p1, p0)
        i0, i1 = int(round(lo / self.flow_bucket)), int(round(hi / self.flow_bucket))
        with self.lock:
            con = sqlite3.connect(self.path)
            row = con.execute(
                "SELECT COALESCE(SUM(buy),0), COALESCE(SUM(sell),0), COALESCE(SUM(n),0), COALESCE(SUM(qty),0), COUNT(DISTINCT slot), MIN(slot), MAX(slot) "
                "FROM flow WHERE slot + 5000 > ? AND slot < ? AND idx BETWEEN ? AND ?",
                (int(t0_ms), int(t1_ms), i0, i1),
            ).fetchone()
            cover = con.execute("SELECT COUNT(DISTINCT slot) FROM flow WHERE slot + 5000 > ? AND slot < ?", (int(t0_ms), int(t1_ms))).fetchone()[0]
            con.close()
        buy, sell, n, qty, slots, first, last = row
        return {"ok": True, "buy": round(buy), "sell": round(sell), "delta": round(buy - sell), "trades": int(n), "qty": round(qty, 2),
                "slotsInRange": int(cover), "firstMs": first, "lastMs": last}

    def books(self, kind: str, minutes: float):
        self.flush()
        since = int((time.time() - minutes * 60) * 1000)
        with self.lock:
            con = sqlite3.connect(self.path)
            rows = con.execute(
                "SELECT ts,price,width,buckets FROM oanda_books WHERE kind=? AND ts>=? ORDER BY ts", (kind, since)
            ).fetchall()
            con.close()
        return [{"ts": ts, "price": p, "width": w, "buckets": json.loads(b)} for ts, p, w, b in rows]

    def known_book_times(self, kind: str) -> set[int]:
        self.flush()
        with self.lock:
            con = sqlite3.connect(self.path)
            rows = con.execute("SELECT ts FROM oanda_books WHERE kind=?", (kind,)).fetchall()
            con.close()
        return {r[0] for r in rows}

    def stats(self):
        self.flush()
        with self.lock:
            con = sqlite3.connect(self.path)
            h = con.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM heat").fetchone()
            f = con.execute("SELECT COUNT(*) FROM flow").fetchone()
            b = con.execute("SELECT kind, COUNT(*), MIN(ts), MAX(ts) FROM oanda_books GROUP BY kind").fetchall()
            con.close()
        return {
            "heat": {"columns": h[0], "fromMs": h[1], "toMs": h[2]},
            "flowRows": f[0],
            "oandaBooks": {k: {"snapshots": c, "fromMs": a, "toMs": z} for k, c, a, z in b},
        }
