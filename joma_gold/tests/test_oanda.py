import asyncio
import json
import time
import unittest

import httpx

from backend.oanda_source import OandaSource, iso_z, parse_book, parse_candles, parse_time
from backend.state import SharedState

CANDLES = {"instrument": "XAU_USD", "granularity": "M1", "candles": [
    {"complete": True, "volume": 70, "time": "2016-10-17T15:00:00.000000000Z",
     "mid": {"o": "1250.10", "h": "1250.90", "l": "1249.80", "c": "1250.50"},
     "bid": {"o": "1250.00", "h": "1250.80", "l": "1249.70", "c": "1250.40"}},
    {"complete": False, "volume": 22, "time": "2016-10-17T15:01:00.000000000Z",
     "mid": {"o": "1250.50", "h": "1250.60", "l": "1250.30", "c": "1250.40"}}]}
BOOK = {"orderBook": {"instrument": "XAU_USD", "time": "2017-06-28T10:00:00Z", "price": "1250.50", "bucketWidth": "0.50",
                      "buckets": [{"price": "1250.00", "longCountPercent": "0.2666", "shortCountPercent": "0.2352"},
                                  {"price": "1250.50", "longCountPercent": "0.4156", "shortCountPercent": "0.3842"}]}}


class ParserTests(unittest.TestCase):
    def test_time_formats(self):
        self.assertEqual(parse_time("2016-10-17T15:00:00.000000000Z"), 1476716400.0)
        self.assertEqual(parse_time("1476716400.250000000"), 1476716400.25)
        self.assertEqual(iso_z(1476716400), "2016-10-17T15:00:00Z")

    def test_candles_components_and_incomplete_flag(self):
        mid = parse_candles(CANDLES, "M")
        self.assertEqual([c["close"] for c in mid], [1250.5, 1250.4])
        self.assertEqual(mid[0]["time"], 1476716400)
        self.assertFalse(mid[1]["complete"])
        self.assertEqual(len(parse_candles(CANDLES, "B")), 1)      # second candle has no bid block -> skipped, not invented

    def test_book(self):
        b = parse_book(BOOK, "order")
        self.assertEqual(b["ts"], 1498644000000)
        self.assertEqual(b["width"], 0.5)
        self.assertEqual(b["buckets"][0], [1250.0, 0.2666, 0.2352])
        self.assertIsNone(parse_book({"orderBook": {"instrument": "X", "buckets": []}}, "order"))


class FakeHistory:
    def __init__(self):
        self.books, self.known = [], set()

    def add_book(self, b):
        self.books.append(b)

    def known_book_times(self, kind):
        return set(self.known)


class SourceTests(unittest.IsolatedAsyncioTestCase):
    def make(self, handler, **cfg):
        hist = FakeHistory()
        src = OandaSource(SharedState(), {"token": "t", "account_id": "101-001-1-001", **cfg}, hist)
        src.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        return src, hist

    async def test_price_message_becomes_broker_snapshot_without_fake_depth(self):
        src, _ = self.make(lambda r: httpx.Response(404))
        await src._on_price({"type": "PRICE", "time": "2026-10-04T10:00:00.1Z", "tradeable": True,
                             "bids": [{"price": "4150.10", "liquidity": 1000000}], "asks": [{"price": "4150.50", "liquidity": 1000000}]})
        snap = src.state.sources["OANDA"]
        self.assertTrue(snap.ok)
        self.assertAlmostEqual(snap.mid, 4150.30, places=6)
        self.assertEqual(snap.levels, [])                      # quoted tier size is NOT turned into a wall
        self.assertEqual(snap.meta["label"], "OANDA:XAU_USD")
        await src._on_price({"type": "PRICE", "tradeable": False, "bids": [{"price": "4150.0"}], "asks": [{"price": "4150.4"}]})
        self.assertIn("closed", src.state.sources["OANDA"].message)

    async def test_candles_request_and_auth_header(self):
        seen = {}

        def handler(req: httpx.Request):
            seen["url"], seen["auth"] = str(req.url), req.headers.get("authorization")
            return httpx.Response(200, json=CANDLES)

        src, _ = self.make(handler)
        rows = await src.candles("15m", 300)
        self.assertEqual(len(rows), 2)
        self.assertIn("/v3/instruments/XAU_USD/candles", seen["url"])
        self.assertIn("granularity=M15", seen["url"])
        self.assertEqual(seen["auth"], "Bearer t")

    async def test_candles_surface_http_errors(self):
        src, _ = self.make(lambda r: httpx.Response(401, text="bad token"))
        with self.assertRaises(RuntimeError):
            await src.candles("1m", 100)

    async def test_backfill_walks_back_and_stops_when_oanda_refuses(self):
        newest = 1498644000
        calls = []

        def handler(req: httpx.Request):
            t = req.url.params.get("time")
            calls.append(t)
            if t is None:
                ts = newest
            else:
                ts = int(parse_time(t)) // 1200 * 1200
            if ts < newest - 3 * 1200:
                return httpx.Response(404, text="no snapshot")
            body = json.loads(json.dumps(BOOK))
            body["orderBook"]["time"] = iso_z(ts)
            return httpx.Response(200, json=body)

        src, hist = self.make(handler, book_backfill_snapshots=10)
        book, code, _ = await src.fetch_book("order")
        src._store_book(book)
        import backend.oanda_source as mod
        orig_sleep = asyncio.sleep
        mod.asyncio.sleep = lambda *_a, **_k: orig_sleep(0)
        try:
            await src.backfill_books()
        finally:
            mod.asyncio.sleep = orig_sleep
        stamps = sorted(b["ts"] // 1000 for b in hist.books)
        self.assertEqual(stamps, [newest - 3600, newest - 2400, newest - 1200, newest])
        self.assertIn("3 historical snapshots loaded", src.book_status["order"])
        self.assertIn("HTTP 404", src.book_status["order"])


if __name__ == "__main__":
    unittest.main()
