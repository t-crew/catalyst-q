"""A job larger than one request: scrambled 1D circuits at depth equal to width, carried in their own payload across many stateless hops."""
import numpy as np
from cq import *

def run():
    if not KEY:
        return {"claim": "c10_distributed", "passed": True, "skipped": "needs a free key: CATALYST_Q_KEY", "numbers": {}}
    numbers, ok = {}, True
    # 26 qubits: the state-vector referee.
    qc = random_brick(26, 26, 126)
    p = aer_probabilities(qc)
    named = [bits(i, 26) for i in draw_truth(p, 64, 26)]
    o = distributed({"qasm": qasm_of(qc), "outcomes": named})
    assert "probabilities" in o, o
    rel = max(abs(o["probabilities"][x] - p[int(x, 2)]) / p[int(x, 2)] for x in named)
    numbers["n26"] = {"worst_relative_error_vs_aer": rel, "shards": o["shards"], "hops": o["hops"], "runs": o["plan"]["runs"], "gates_across_cut": o["plan"]["gates_across_cut"]}
    ok &= rel < 1e-10
    # Negative control: a shard changed in flight must be refused at the fold.
    job, done = o["job"], o["done"]
    changed = [dict(done[0], sum={"re": [v * 2 for v in done[0]["sum"]["re"]], "im": done[0]["sum"]["im"]})] + done[1:]
    refused_change = call("/api/v1/distributed/fold", {"job": job, "shards": changed}).get("error") == "capsule_digest_mismatch"
    refused_double = call("/api/v1/distributed/fold", {"job": job, "shards": done + [done[0]]}).get("error") == "fold_failed"
    refused_missing = call("/api/v1/distributed/fold", {"job": job, "shards": done[1:]}).get("error") == "fold_failed"
    # Different concurrency, same bits.
    again = distributed({"qasm": qasm_of(qc), "outcomes": named}, concurrency=2)
    same_bits = again["probabilities"] == o["probabilities"]
    numbers["same_bits_at_other_concurrency"] = same_bits
    ok &= same_bits
    # Positive control: the second referee agrees with the first where both can run.
    small = random_brick(20, 20, 120)
    ps = aer_probabilities(small)
    xs = [bits(i, 20) for i in draw_truth(ps, 2, 20)]
    q = quimb_probability(small, xs)
    referee = max(abs(q[x] - ps[int(x, 2)]) / ps[int(x, 2)] for x in xs)
    numbers["quimb_vs_aer_at_20"] = referee
    # 30 qubits and past: the second referee.
    for n in (30, 32):
        qc = random_brick(n, n, 100 + n)
        rng = np.random.default_rng(n)
        xs = [format(int(rng.integers(2 ** n)), f"0{n}b") for _ in range(2)]
        o = distributed({"qasm": qasm_of(qc), "outcomes": xs})
        assert "probabilities" in o, o
        q = quimb_probability(qc, xs)
        rel = max(abs(o["probabilities"][x] - q[x]) / q[x] for x in xs)
        numbers[f"n{n}"] = {"worst_relative_error_vs_quimb": rel, "shards": o["shards"], "hops": o["hops"], "runs": o["plan"]["runs"], "work_spent": o["work_spent"]}
        ok &= rel < 1e-9
    return result("c10_distributed", ok, numbers, referee < 1e-9, refused_change and refused_double and refused_missing)
