"""Run every test: python unit tests + the JavaScript indicator tests (needs node)."""
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
ok = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.discover(str(ROOT / "tests"), pattern="test_*.py", top_level_dir=str(ROOT / "tests"))).wasSuccessful()
node = shutil.which("node")
if node:
    for f in ("test_ta.js", "test_library.js"):
        r = subprocess.run([node, str(ROOT / "tests" / "js" / f)], capture_output=True, text=True)
        print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[:300])
        ok = ok and r.returncode == 0
else:
    print("node not found — skipped JavaScript indicator tests")
sys.exit(0 if ok else 1)
