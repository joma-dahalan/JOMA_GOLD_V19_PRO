import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app import ROOT, create_app, load_config
from backend.state import SourceSnapshot, now_ms


class ApiTests(unittest.TestCase):
    def test_delta_and_flow_range_endpoints(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config()
            cfg["recording"]["sqlite_path"] = str(Path(d) / "api.db")
            cfg["recording"]["enabled"] = False
            app = create_app(cfg, start_sources=False, root=ROOT)
            hist = app.state.ctx.history
            now = int(time.time() * 1000)
            s0 = (now - 120_000) // 5000 * 5000
            hist.add_flow([(s0, 8800, 400000.0, 100000.0, 5, 90.0),       # 4400.0
                           (s0, 8810, 50000.0, 10000.0, 1, 11.0),         # 4405.0
                           (s0 + 5000, 8800, 20000.0, 220000.0, 3, 50.0),
                           (s0 + 60_000, 8800, 1000.0, 1000.0, 1, 1.0)])
            with TestClient(app) as c:
                r = c.get("/api/flow/range", params={"t0": s0 - 1000, "t1": s0 + 20_000, "p0": 4399.0, "p1": 4401.0}).json()
                self.assertEqual((r["buy"], r["sell"], r["delta"], r["trades"]), (420000, 320000, 100000, 8))   # 4405 and the later slot excluded
                self.assertEqual(r["slotsInRange"], 2)
                r2 = c.get("/api/flow/range", params={"t0": s0 + 20_000, "t1": s0 - 1000, "p0": 4410.0, "p1": 4390.0}).json()  # swapped args
                self.assertEqual(r2["trades"], 9)      # 5+1+3: the +60 s slot is outside the window
                dl = c.get("/api/delta", params={"minutes": 10, "step": 60}).json()
                self.assertEqual(sum(x["buy"] for x in dl["rows"]), 471000)
                self.assertEqual(sum(x["sell"] for x in dl["rows"]), 331000)
                self.assertTrue(all(x["t"] % 60000 == 0 for x in dl["rows"]))
                self.assertEqual(c.get("/api/heat").json()["bins"], [])      # empty history stays empty


    def test_health_separates_api_liveness_from_market_data_readiness(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config()
            cfg["recording"]["sqlite_path"] = str(Path(d) / "health.db")
            cfg["recording"]["enabled"] = False
            app = create_app(cfg, start_sources=False, root=ROOT)
            with TestClient(app) as c:
                offline = c.get("/api/health").json()
                self.assertTrue(offline["ok"])  # API is responsive even with no feeds
                self.assertEqual(offline["version"], "19.0")
                self.assertEqual(offline["marketDataStatus"], "OFFLINE")
                self.assertFalse(offline["marketDataReady"])
                self.assertFalse(offline["analysisReady"])

                state = app.state.ctx.state
                stamp = now_ms()
                state.reference_price = 4400.0
                state.reference_source = "OANDA:XAU_USD"
                state.engine_updated_ms = stamp
                state.metrics = {"quality": 0.8}
                state.sources["OANDA"] = SourceSnapshot(
                    name="OANDA", ok=True, message="live", updated_ms=stamp, mid=4400.0,
                    best_bid=4399.9, best_ask=4400.1, meta={"label": "OANDA:XAU_USD"}
                )
                state.sources["BINANCE_SPOT"] = SourceSnapshot(
                    name="BINANCE_SPOT", ok=True, message="live", updated_ms=stamp, mid=4400.2
                )
                live = c.get("/api/health").json()
                self.assertEqual(live["marketDataStatus"], "LIVE")
                self.assertTrue(live["marketDataReady"])
                self.assertTrue(live["analysisReady"])
                self.assertEqual(live["freshSourceCount"], 2)



if __name__ == "__main__":
    unittest.main()
