# -*- coding: utf-8 -*-
"""GPU 실행 게이트 — 10초 간격 정확히 한 쌍만 측정. 미충족이면 반복 측정하지 않는다."""
import json
import subprocess
import time


def sample():
    a = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu",
                        "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout.strip()
    used, total, util = [int(x.strip()) for x in a.split(",")]
    p = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory,process_name",
                        "--format=csv,noheader"], capture_output=True, text=True).stdout
    ml = [l for l in p.splitlines() if "python" in l.lower()]
    return {"free_mib": total - used, "util": util, "ml_procs": ml}


s1 = sample()
time.sleep(10)
s2 = sample()
r = {"sample1": s1, "sample2": s2,
     "free_min_mib": min(s1["free_mib"], s2["free_mib"]),
     "util_mean": (s1["util"] + s2["util"]) / 2.0,
     "util_max": max(s1["util"], s2["util"]),
     "ml_compute_procs": s1["ml_procs"] + s2["ml_procs"]}
r["gate_free_ge_8GB"] = r["free_min_mib"] >= 8192
r["gate_util_mean_le_5"] = r["util_mean"] <= 5
r["gate_util_max_le_10"] = r["util_max"] <= 10
r["gate_no_ml_compute"] = len(r["ml_compute_procs"]) == 0
r["PASS"] = all(r[k] for k in ("gate_free_ge_8GB", "gate_util_mean_le_5",
                               "gate_util_max_le_10", "gate_no_ml_compute"))
print(json.dumps(r, ensure_ascii=False, indent=1))
