from __future__ import annotations
import os
import importlib
import json
import platform
from pathlib import Path

ROOT=Path(__file__).resolve().parent
print("JOMA GOLD v19 · System Diagnostics")
print("OS:", platform.platform())
for mod in ["fastapi","uvicorn","httpx","websockets"]:
    try:
        m=importlib.import_module(mod); print(f"[OK] {mod}", getattr(m,"__version__",""))
    except Exception as e: print(f"[FAIL] {mod}: {e}")
if platform.system()=="Windows":
    try:
        import MetaTrader5 as mt5
        print("[OK] MetaTrader5 package", getattr(mt5,"__version__",""))
        ok=mt5.initialize()
        print("[OK] MT5 initialize" if ok else f"[WARN] MT5 initialize failed: {mt5.last_error()}")
        if ok:
            print("Terminal:", mt5.terminal_info())
            mt5.shutdown()
    except Exception as e: print("[FAIL] MetaTrader5:",e)
else:
    print("[INFO] MT5 bridge is Windows-only; public feeds can still run without it.")

# ---- OANDA check (uses config.local.json / config.json / env OANDA_TOKEN) ----
def _cfg():
    c = json.loads((ROOT/"config.json").read_text(encoding="utf-8"))
    p = ROOT/"config.local.json"
    if p.exists():
        for k, v in json.loads(p.read_text(encoding="utf-8")).items():
            c[k] = {**c.get(k, {}), **v} if isinstance(v, dict) else v
    return c
try:
    import httpx
    o = _cfg().get("oanda", {})
    token = (o.get("token") or os.environ.get("OANDA_TOKEN", "")).strip()
    host = "https://api-fxtrade.oanda.com" if o.get("environment") == "live" else "https://api-fxpractice.oanda.com"
    if not token:
        print("[WARN] OANDA token missing -> put it in config.local.json (see config.local.json.example) or env OANDA_TOKEN")
    else:
        h = {"Authorization": "Bearer " + token}; ins = o.get("instrument", "XAU_USD")
        r = httpx.get(host + "/v3/accounts", headers=h, timeout=12)
        print(("[OK]" if r.status_code == 200 else "[FAIL]"), "OANDA accounts HTTP", r.status_code, r.text[:140] if r.status_code != 200 else "")
        if r.status_code == 200:
            for name, path in (("candles", f"/v3/instruments/{ins}/candles?count=2&granularity=M1"), ("orderBook", f"/v3/instruments/{ins}/orderBook"), ("positionBook", f"/v3/instruments/{ins}/positionBook")):
                rr = httpx.get(host + path, headers=h, timeout=12)
                print(("[OK]" if rr.status_code == 200 else "[WARN]"), f"OANDA {name} HTTP", rr.status_code, "" if rr.status_code == 200 else rr.text[:140])
except Exception as e:
    print("[FAIL] OANDA check:", e)
safe = _cfg(); safe.get("oanda", {}).pop("token", None)
print("Config (token hidden):", safe)
