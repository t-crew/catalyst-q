"""A scrambled 1D circuit at depth equal to its width: the exact probability of the outcomes you name."""
import numpy as np
from qiskit import QuantumCircuit
from cq import *

def grid(rows, cols, depth, seed):
    rng = np.random.default_rng(seed)
    n = rows * cols
    qc = QuantumCircuit(n)
    for d in range(depth):
        for q in range(n):
            qc.u(*(rng.random(3) * 3), q)
        horizontal = d % 4 < 2
        for r in range(rows):
            for c in range(cols):
                if horizontal and c + 1 < cols and c % 2 == d % 2: qc.cz(r * cols + c, r * cols + c + 1)
                if not horizontal and r + 1 < rows and r % 2 == d % 2: qc.cz(r * cols + c, (r + 1) * cols + c)
    return qc

def run():
    numbers, ok = {}, True
    pos = neg = True
    for n in (24, 26):
        qc = random_brick(n, n, 100 + n)
        p = aer_probabilities(qc)
        named = [bits(i, n) for i in draw_truth(p, 256, n)]
        o = execute({"qasm": qasm_of(qc), "outcomes": named})
        if "probabilities" not in o:
            numbers[f"n{n}"] = o
            ok = False
            continue
        rel = max(abs(o["probabilities"][x] - p[int(x, 2)]) / p[int(x, 2)] for x in named)
        # Negative control: a small rotation added to one qubit. The referee must see the answer move far past the tolerance,
        # and the service must follow it there, so a service that ignored the change would fail.
        changed = qc.copy()
        changed.rx(1e-3, n // 2)
        pc = aer_probabilities(changed)
        moved = max(abs(pc[int(x, 2)] - p[int(x, 2)]) / p[int(x, 2)] for x in named)
        oc = execute({"qasm": qasm_of(changed), "outcomes": named})
        follows = max(abs(oc["probabilities"][x] - pc[int(x, 2)]) / pc[int(x, 2)] for x in named)
        numbers[f"n{n}"] = {"worst_relative_error": rel, "method": o.get("method"), "held": o.get("qubits_held"), "workers": o.get("execution", {}).get("workers"), "ms": o.get("duration_ms"), "control_moved": moved, "control_followed_to": follows}
        ok &= rel < 1e-10
        pos &= abs(float(p.sum()) - 1) < 1e-9
        neg &= moved > 1e-6 and follows < 1e-10
        del p, pc
    # Positive control: on a circuit with no entangling gates the referee must equal a product formula, so the referee itself is sound.
    rng = np.random.default_rng(1)
    plain = QuantumCircuit(20)
    marginals = []
    for q in range(20):
        t = float(rng.random() * 3)
        plain.ry(t, q)
        marginals.append(np.sin(t / 2) ** 2)
    pp = aer_probabilities(plain)
    idx = int(rng.integers(2 ** 20))
    formula = np.prod([marginals[q] if (idx >> q) & 1 else 1 - marginals[q] for q in range(20)])
    referee = abs(pp[idx] - formula) / formula
    numbers["referee_vs_product_formula"] = float(referee)
    pos &= referee < 1e-10
    refused = execute({"qasm": qasm_of(grid(5, 5, 20, 1)), "outcomes": ["0" * 25]})
    numbers["grid_5x5_depth_20"] = {k: refused.get(k) for k in ("error", "detail")}
    ok &= refused.get("error") in ("budget_exceeded", "needs_distributed_run") and "gates cross" in str(refused.get("detail"))
    return result("c4_scrambled", ok, numbers, pos, neg)
