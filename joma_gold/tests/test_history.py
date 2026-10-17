import tempfile
import time
import unittest
from pathlib import Path

from backend.history import HistoryStore, aggregate_flow_rows, bin_heat_rows, pack_cells, unpack_cells


class HistoryTests(unittest.TestCase):
    def test_cell_roundtrip_clamps_values(self):
        cells = [(8798, 150.0, 1), (-5, 99999, 0)]
        back = unpack_cells(pack_cells(cells))
        self.assertEqual(back, [(8798, 150, 1), (-5, 65535, 0)])

    def test_binning_is_a_mean_over_columns_not_a_sum(self):
        rows = [(1000, 0.5, [(10, 100, 1)]), (2000, 0.5, [(10, 300, 1), (11, 50, 0)]), (3000, 0.5, [])]
        bucket, bins = bin_heat_rows(rows, 10_000)
        self.assertEqual(bucket, 0.5)
        self.assertEqual(len(bins), 1)
        cells = {c[0]: c for c in bins[0]["cells"]}
        self.assertAlmostEqual(cells[10][1], 133.3, places=1)    # (100+300+0)/3 columns
        self.assertAlmostEqual(cells[11][1], 16.7, places=1)

    def test_flow_aggregation_and_cvd(self):
        rows = [(0, 8000, 100000.0, 20000.0, 3, 1.0), (5000, 8000, 10000.0, 400000.0, 2, 2.0), (5000, 8010, 1000.0, 1000.0, 1, 0.1)]
        bubbles, cvd = aggregate_flow_rows(rows, 10_000, 0.5, 0.5, 100000.0, 10)
        self.assertEqual(len(bubbles), 1)
        b = bubbles[0]
        self.assertTrue(b["sell"])
        self.assertEqual(b["usd"], 530000)
        self.assertEqual(b["n"], 5)
        self.assertEqual(cvd[-1]["v"], (100000 - 20000) + (10000 - 400000) + 0)

    def test_store_persists_and_serves_what_was_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            s = HistoryStore(Path(d), {"sqlite_path": "h.db"})
            now = int(time.time() * 1000)
            s.add_heat(now - 4000, 0.5, 4400.0, [(8800, 120.0, 1)])
            s.add_heat(now - 2000, 0.5, 4400.0, [(8800, 80.0, 1), (8801, 40.0, 0)])
            s.add_flow([((now - 9000) // 5000 * 5000, 8800, 5e5, 1e5, 4, 8.0)])
            s.add_flow([((now - 9000) // 5000 * 5000, 8800, 5e5, 0.0, 1, 1.0)])   # same slot: must add, not replace
            s.add_book({"kind": "order", "ts": now - 600000, "price": 4400.0, "width": 0.5, "buckets": [[4399.5, 0.3, 0.2]]})
            h = s.heat(5, 60)
            self.assertEqual(h["columns"], 2)
            total = {c[0]: c[1] for b in h["bins"] for c in b["cells"]}
            self.assertAlmostEqual(total[8800], 100.0, places=1)
            f = s.flow(5, 20, 0.5, 1000)
            self.assertEqual(f["bubbles"][0]["usd"], 1100000)
            self.assertEqual(f["bubbles"][0]["n"], 5)
            self.assertEqual(s.books("order", 60)[0]["buckets"], [[4399.5, 0.3, 0.2]])
            self.assertEqual(s.stats()["heat"]["columns"], 2)
            s2 = HistoryStore(Path(d), {"sqlite_path": "h.db"})          # restart: history is still there
            self.assertEqual(s2.heat(5, 60)["columns"], 2)
            self.assertEqual(s.heat(5, 60, after_ms=now - 3000)["columns"], 1)


if __name__ == "__main__":
    unittest.main()


class LatestBookTests(unittest.TestCase):
    def test_latest_book_is_the_newest_column_and_windowed(self):
        with tempfile.TemporaryDirectory() as d:
            s = HistoryStore(Path(d), {"sqlite_path": "b.db"})
            self.assertEqual(s.latest_book(), {"ok": False})
            now = int(time.time() * 1000)
            s.add_heat(now - 9000, 0.5, 4400.0, [(8800, 100.0, 1)])
            s.add_heat(now - 1000, 0.5, 4400.0, [(8800, 250.0, 1), (8801, 90.0, 0), (9500, 500.0, 0)])   # 4750 is outside ±60
            b = s.latest_book(60)
            self.assertTrue(b["ok"])
            self.assertEqual(sorted(c[0] for c in b["cells"]), [8800, 8801])
            self.assertEqual(b["cells"][0][1], 250.0)
            self.assertLess(b["ageMs"], 5000)
            s2 = HistoryStore(Path(d), {"sqlite_path": "b.db"})        # after a restart it falls back to the database
            s.flush()
            self.assertEqual(s2.latest_book(60)["ts"], now - 1000)
