from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from pathlib import Path
from .state import SharedState


class Recorder:
    def __init__(self, state: SharedState, cfg: dict, root: Path):
        self.state = state
        self.cfg = cfg
        self.path = (root / str(cfg.get("sqlite_path", "data/liquidity_history.db"))).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _init(self):
        con = sqlite3.connect(self.path)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute(
            """CREATE TABLE IF NOT EXISTS snapshots (
                ts_ms INTEGER PRIMARY KEY,
                ref_price REAL,
                ref_source TEXT,
                zones_json TEXT,
                sources_json TEXT,
                metrics_json TEXT,
                bias_json TEXT,
                basis_json TEXT
            )"""
        )
        # Upgrade older v12 DBs in place if present.
        cols = {r[1] for r in con.execute("PRAGMA table_info(snapshots)").fetchall()}
        for name in ("metrics_json", "bias_json", "basis_json"):
            if name not in cols:
                con.execute(f"ALTER TABLE snapshots ADD COLUMN {name} TEXT DEFAULT '{{}}'")
        con.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts_ms)")
        con.commit(); con.close()

    def _write(self, snap):
        con = sqlite3.connect(self.path)
        con.execute(
            "INSERT OR REPLACE INTO snapshots(ts_ms,ref_price,ref_source,zones_json,sources_json,metrics_json,bias_json,basis_json) VALUES(?,?,?,?,?,?,?,?)",
            (
                int(time.time() * 1000), snap.get("referencePrice"), snap.get("referenceSource"),
                json.dumps(snap.get("zones", []), separators=(",", ":")),
                json.dumps(snap.get("sources", {}), separators=(",", ":")),
                json.dumps(snap.get("metrics", {}), separators=(",", ":")),
                json.dumps(snap.get("bias", {}), separators=(",", ":")),
                json.dumps(snap.get("basis", {}), separators=(",", ":")),
            ),
        )
        cutoff = int((time.time() - float(self.cfg.get("retention_hours", 168)) * 3600) * 1000)
        con.execute("DELETE FROM snapshots WHERE ts_ms < ?", (cutoff,))
        con.commit(); con.close()

    async def run(self):
        await asyncio.to_thread(self._init)
        while True:
            snap = await self.state.snapshot()
            await asyncio.to_thread(self._write, snap)
            await asyncio.sleep(max(0.5, float(self.cfg.get("interval_ms", 1000)) / 1000))

    def _history(self, minutes: int, limit: int):
        con = sqlite3.connect(self.path)
        cutoff = int((time.time() - minutes * 60) * 1000)
        rows = con.execute(
            "SELECT ts_ms,ref_price,ref_source,zones_json,metrics_json,bias_json,basis_json FROM snapshots WHERE ts_ms>=? ORDER BY ts_ms ASC LIMIT ?",
            (cutoff, limit),
        ).fetchall()
        con.close()
        return [
            {
                "ts": r[0], "price": r[1], "source": r[2],
                "zones": json.loads(r[3] or "[]"),
                "metrics": json.loads(r[4] or "{}"),
                "bias": json.loads(r[5] or "{}"),
                "basis": json.loads(r[6] or "{}"),
            }
            for r in rows
        ]

    async def history(self, minutes=30, limit=2000):
        await asyncio.to_thread(self._init)
        return await asyncio.to_thread(self._history, minutes, limit)
