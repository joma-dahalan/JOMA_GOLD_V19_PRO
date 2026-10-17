import asyncio
import time
import unittest

from backend.engine import LiquidityEngine
from backend.state import SharedState, SourceSnapshot, TradeEvent, now_ms


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.state = SharedState()
        self.cfg = {
            "bucket_usd": 0.5,
            "max_distance_usd": 100,
            "near_distance_usd": 20,
            "top_zones": 12,
            "min_notional_usd": 1000,
            "min_strength": 0,
            "persistence_full_seconds": 1,
            "stale_source_ms": 10000,
            "basis_window": 7,
            "basis_ema_alpha": 0.5,
            "trade_window_seconds": 10,
            "local_trade_radius_usd": 1.5,
            "signal_min_quality": 0.1,
            "signal_flow_threshold": 0.15,
        }
        self.engine = LiquidityEngine(self.state, self.cfg)
        async with self.state.lock:
            self.state.reference_price = 4400.0
            self.state.reference_source = "MT5:XAUUSD"
            self.state.candles_m5 = [
                {"open":4390+i*.2,"high":4391+i*.2,"low":4389+i*.2,"close":4390.3+i*.2}
                for i in range(30)
            ]
            self.state.candles_m15 = [
                {"open":4380+i*.35,"high":4382+i*.35,"low":4379+i*.35,"close":4380.5+i*.35}
                for i in range(30)
            ]
        await self.state.set_source(SourceSnapshot(
            "MT5_DOM", True, "live", now_ms(), 4400, 4399.9, 4400.1,
            [{"side":"buy","price":4398,"notional":150000,"qty":1,"source":"MT5_DOM"},
             {"side":"sell","price":4404,"notional":180000,"qty":1,"source":"MT5_DOM"}], {}
        ))
        await self.state.set_source(SourceSnapshot(
            "TEST:XAUT", True, "live", now_ms(), 4399, 4398.9, 4399.1,
            [{"side":"buy","price":4397,"notional":250000,"qty":60,"source":"TEST:XAUT"},
             {"side":"sell","price":4403,"notional":300000,"qty":68,"source":"TEST:XAUT"}], {}
        ))

    async def test_basis_alignment_and_zones(self):
        await self.engine.compute()
        snap = await self.state.snapshot()
        self.assertTrue(snap["zones"])
        self.assertAlmostEqual(snap["basis"]["TEST:XAUT"], 1.0, places=3)
        centers = [z["center"] for z in snap["zones"]]
        self.assertIn(4398.0, centers)
        self.assertIn(4404.0, centers)
        self.assertIn("quality", snap["metrics"])

    async def test_executed_trade_reaches_zone_metrics(self):
        await self.state.add_trade(TradeEvent("TEST:XAUT","XAUT",now_ms(),4397.0,20.0,"sell",4397*20))
        await self.engine.compute()
        snap = await self.state.snapshot()
        buy = min((z for z in snap["zones"] if z["side"]=="buy"), key=lambda z:abs(z["center"]-4398))
        self.assertGreater(buy["executedAgainstUsd"], 0)


if __name__ == "__main__":
    unittest.main()


class ReferenceAndRecordingTests(unittest.IsolatedAsyncioTestCase):
    """v14: broker reference priority, heat columns and executed-flow rows."""

    async def asyncSetUp(self):
        self.state = SharedState()
        self.heat, self.flow = [], []
        self.cfg = {
            "bucket_usd": 0.5, "max_distance_usd": 100, "near_distance_usd": 20, "top_zones": 12, "min_notional_usd": 1000,
            "min_strength": 0, "persistence_full_seconds": 1, "stale_source_ms": 10000, "basis_window": 7,
            "basis_ema_alpha": 1.0, "trade_window_seconds": 10, "local_trade_radius_usd": 1.5,
            "reference_priority": ["OANDA", "MT5"],
        }
        self.engine = LiquidityEngine(
            self.state, self.cfg, {"interval_ms": 0, "bucket_usd": 0.5, "window_usd": 50, "min_k_usd": 1}, {"bucket_usd": 0.5},
            lambda ts, b, ref, cells: self.heat.append((ts, b, ref, cells)), lambda rows: self.flow.extend(rows),
        )

    async def _feeds(self, oanda=True, mt5=True):
        if oanda:
            await self.state.set_source(SourceSnapshot("OANDA", True, "live", now_ms(), 4401.0, 4400.9, 4401.1, [],
                                                       {"label": "OANDA:XAU_USD"}))
        if mt5:
            await self.state.set_source(SourceSnapshot("MT5_DOM", True, "live", now_ms(), 4400.0, 4399.9, 4400.1,
                                                       [{"side": "buy", "price": 4398, "notional": 150000, "qty": 1, "source": "MT5_DOM"}],
                                                       {"label": "MT5:XAUUSD"}))
        await self.state.set_source(SourceSnapshot("TEST:XAUT", True, "live", now_ms(), 4399.0, 4398.9, 4399.1,
                                                   [{"side": "buy", "price": 4397, "notional": 250000, "qty": 60, "source": "TEST:XAUT"},
                                                    {"side": "sell", "price": 4403, "notional": 300000, "qty": 68, "source": "TEST:XAUT"}], {}))

    async def test_oanda_is_reference_and_other_feeds_are_aligned_to_it(self):
        await self._feeds()
        await self.engine.compute()
        snap = await self.state.snapshot()
        self.assertEqual(snap["referenceSource"], "OANDA:XAU_USD")
        self.assertAlmostEqual(snap["referencePrice"], 4401.0, places=3)
        self.assertAlmostEqual(snap["basis"]["OANDA"], 0.0, places=6)
        self.assertAlmostEqual(snap["basis"]["MT5_DOM"], 1.0, places=3)      # MT5 is no longer special
        self.assertAlmostEqual(snap["basis"]["TEST:XAUT"], 2.0, places=3)
        self.assertTrue(snap["metrics"]["referenceIsBroker"])

    async def test_falls_back_to_mt5_then_to_labelled_public_median(self):
        await self._feeds(oanda=False)
        await self.engine.compute()
        self.assertTrue((await self.state.snapshot())["referenceSource"].startswith("MT5"))
        self.state.sources.pop("MT5_DOM")
        await self.engine.compute()
        snap = await self.state.snapshot()
        self.assertEqual(snap["referenceSource"], "PUBLIC_MEDIAN")
        self.assertFalse(snap["metrics"]["referenceIsBroker"])

    async def test_clears_stale_reference_when_all_sources_expire(self):
        stamp = now_ms() - int(self.cfg["stale_source_ms"]) - 1000
        await self.state.set_source(SourceSnapshot(
            "OANDA", True, "stale", stamp, 4401.0, 4400.9, 4401.1, [], {"label": "OANDA:XAU_USD"}
        ))
        async with self.state.lock:
            self.state.reference_price = 4401.0
            self.state.reference_source = "OANDA:XAU_USD"
        await self.engine.compute()
        snap = await self.state.snapshot()
        self.assertIsNone(snap["referencePrice"])
        self.assertEqual(snap["referenceSource"], "NONE")
        self.assertEqual(snap["bias"]["status"], "NO_DATA")

    async def test_heat_column_is_aligned_to_reference_axis(self):
        await self._feeds()
        await self.engine.compute()
        self.assertTrue(self.heat)
        ts, bucket, ref, cells = self.heat[-1]
        prices = {round(idx * bucket, 3): (k, side) for idx, k, side in cells}
        # MT5 bid 4398 (+1.0 basis) and XAUT bid 4397 (+2.0 basis) both land on 4399 -> venues are summed
        self.assertIn(4399.0, prices)
        self.assertEqual(prices[4399.0][1], 1)  # bid side
        self.assertAlmostEqual(prices[4399.0][0], 150.0 + 250.0, places=3)  # k$
        self.assertIn(4405.0, prices)          # XAUT ask 4403 + basis 2.0
        self.assertEqual(prices[4405.0][1], 0)

    async def test_executed_trades_become_aligned_flow_rows(self):
        await self._feeds()
        old = ((now_ms() - 30000) // 5000) * 5000 + 1000  # same 5-second recording slot
        await self.state.add_trade(TradeEvent("TEST:XAUT", "XAUT", old, 4397.0, 10.0, "buy", 43970))
        await self.state.add_trade(TradeEvent("TEST:XAUT", "XAUT", old + 500, 4397.0, 4.0, "sell", 17588))
        await self.engine.compute()
        await self.engine.compute()   # second pass must not double count
        self.assertEqual(len(self.flow), 1)
        slot, idx, buy, sell, n, qty = self.flow[0]
        self.assertEqual(slot, old // 5000 * 5000)
        self.assertAlmostEqual(idx * 0.5, 4399.0, places=3)        # 4397 + basis 2.0
        self.assertAlmostEqual(buy, 10 * 4399.0, places=1)
        self.assertAlmostEqual(sell, 4 * 4399.0, places=1)
        self.assertEqual(n, 2)
