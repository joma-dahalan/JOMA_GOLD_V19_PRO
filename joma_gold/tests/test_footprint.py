"""Market Studio footprint API integration regression tests."""
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from app import ROOT, create_app, load_config


class FootprintApiTests(unittest.TestCase):
    def test_broker_candle_boundaries_and_session_gaps(self):
        """Off-UTC broker candle starts must not assign weekend/gap prints to a bar."""
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config()
            cfg['recording']['sqlite_path'] = str(Path(d) / 'aligned.db')
            cfg['recording']['enabled'] = False
            app = create_app(cfg, start_sources=False, root=ROOT)
            hist = app.state.ctx.history
            start_ms = ((int(time.time() * 1000) - 8 * 60_000) // 60_000) * 60_000
            first_bar_ms = start_ms - 12_000  # broker offset differs from UTC boundary
            hist.add_flow([(start_ms + 15_000, 8800, 9_000, 1_000, 1, 1),
                           (start_ms + 4 * 60_000, 8800, 7_000, 2_000, 1, 1)])
            bars = f"{first_bar_ms // 1000},{first_bar_ms // 1000 + 60}"
            with TestClient(app) as c:
                resp = c.get('/api/footprint', params={'tf':'1m', 'minutes':20, 'bars': bars}).json()
                self.assertTrue(resp['ok'])
                self.assertEqual(resp['recordCount'], 2)
                self.assertEqual(len(resp['rows']), 1)
                self.assertEqual(resp['rows'][0][0], first_bar_ms)
                self.assertEqual(resp['rows'][0][2], 9000)
                self.assertEqual(c.get('/api/footprint?bars=1,1').status_code, 400)
                self.assertEqual(c.get('/api/footprint?bars=1,3,2').status_code, 400)
                self.assertEqual(c.get('/api/footprint?minutes=nan').status_code, 400)
                self.assertEqual(c.get('/api/footprint?bucket=inf').status_code, 400)

    def test_recorded_rows_aggregate_no_fakes_and_validate_tf(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config()
            cfg['recording']['sqlite_path'] = str(Path(d) / 'fp.db')
            cfg['recording']['enabled'] = False
            app = create_app(cfg, start_sources=False, root=ROOT)
            hist = app.state.ctx.history
            now = int(time.time() * 1000)
            slot = ((now - 120_000) // 5000) * 5000
            hist.add_flow([(slot, 8800, 100000, 20000, 6, 20),
                           (slot + 5000, 8800, 50000, 30000, 4, 12),
                           (slot, 8802, 0, 90000, 3, 9)])
            with TestClient(app) as c:
                r = c.get('/api/footprint', params={'tf': '15m', 'minutes': 5, 'bucket': 1}).json()
                self.assertTrue(r['ok'])
                self.assertEqual(r['recordCount'], 3)
                self.assertEqual(sum(x[2] for x in r['rows']), 150000)
                self.assertEqual(sum(x[3] for x in r['rows']), 140000)
                self.assertEqual(sum(x[4] for x in r['rows']), 13)
                self.assertTrue(all(row[0] % (15 * 60 * 1000) == 0 for row in r['rows']))
                self.assertEqual(c.get('/api/footprint?tf=6h').status_code, 400)
                empty = c.get('/api/footprint?tf=1m&minutes=1').json()
                self.assertEqual(empty['rows'], [])

if __name__ == '__main__':
    unittest.main()
