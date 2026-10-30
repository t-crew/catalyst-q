"""Run one claim or all of them and print what happened. Exit status 1 if any claim fails."""
import importlib, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ALL = ["c1_shots", "c2_wide_shots", "c3_clifford", "c4_scrambled", "c5_spin", "c6_score", "c7_depth10", "c8_qec", "c9_workloads", "c10_distributed"]
names = sys.argv[1:] or ALL
out, failed = [], False
for name in names:
    t = time.time()
    try:
        r = importlib.import_module(f"claims.{name}").run()
    except Exception as e:
        r = {"claim": name, "passed": False, "error": f"{type(e).__name__}: {e}"}
    r["seconds"] = round(time.time() - t, 1)
    print(json.dumps(r, default=str), flush=True)
    out.append(r); failed |= not r["passed"]
sys.exit(1 if failed else 0)
