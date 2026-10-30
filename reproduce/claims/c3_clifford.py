"""On a Clifford circuit, the exact law of the outcomes at hundreds of measured qubits, checked against Aer's stabilizer simulator."""
import numpy as np
from qiskit import QuantumCircuit, transpile
from cq import *

def sparse_clifford(n, seed):
    rng = np.random.default_rng(seed)
    qc = QuantumCircuit(n)
    for q in range(0, n, 3):
        qc.x(q)   # so that constraints with odd parity appear and the signs are tested
    for _ in range(4 * n):
        kind, a, b = rng.integers(4), int(rng.integers(n)), int(rng.integers(n))
        if kind == 0: qc.h(a)
        elif kind == 1: qc.s(a)
        elif a != b and kind == 2: qc.cx(a, b)
        elif a != b: qc.cz(a, b)
    return qc

def run():
    numbers, ok, pos, neg = {}, True, True, True
    for n in (64, 256):
        qc = sparse_clifford(n, n)
        o = execute({"qasm": qasm_of(qc), "sampling": "random", "shots": 1000, "seed": 1})
        if n > 64 and not KEY:
            numbers[f"n{n}"] = "not run: needs a free key"
            continue
        law = o["outcome_law"]
        m = qc.copy(); m.measure_all()
        sim = AerSimulator(method="stabilizer")
        shots = sim.run(transpile(m, sim, optimization_level=0), shots=1000, seed_simulator=n).result().get_counts()
        violates = lambda key: any(sum(int(key[n - 1 - b]) for b in c["bits"]) % 2 != c["parity"] for c in law["constraints"])
        bad = sum(c for k, c in shots.items() if violates(k))
        ours_bad = sum(c for k, c in o["counts"].items() if violates(k))
        # The law must be tight as well as true: the differences of Aer's shots span exactly the stated dimension.
        def span(keys):
            base = int(keys[0], 2)
            rows, rank = [], 0
            for k in keys[1:]:
                v = int(k, 2) ^ base
                for r in rows:
                    v = min(v, v ^ r)
                if v:
                    rows.append(v); rank += 1
            return rank
        aer_rank, our_rank = span(list(shots)), span(list(o["counts"]))
        # An outcome Aer produced has the stated probability, and that outcome with a constrained bit flipped has zero.
        named = list(shots)[:8]
        flip = law["constraints"][0]["bits"][0] if law["constraints"] else 0
        broken = [k[: n - 1 - flip] + ("1" if k[n - 1 - flip] == "0" else "0") + k[n - flip:] for k in named]
        a = execute({"qasm": qasm_of(qc), "outcomes": named + broken})
        stated = all(a["probabilities"][k] == 2.0 ** -law["dimension"] for k in named) and (not law["constraints"] or all(a["probabilities"][k] == 0 for k in broken))
        # Negative control: shots of a different circuit must break this law.
        other = sparse_clifford(n, n + 1)
        om = other.copy(); om.measure_all()
        wrong = sim.run(transpile(om, sim, optimization_level=0), shots=1000, seed_simulator=n).result().get_counts()
        caught = sum(c for k, c in wrong.items() if violates(k))
        numbers[f"n{n}"] = {"dimension": law["dimension"], "constraints": len(law["constraints"]), "aer_shots_violating": bad, "our_shots_violating": ours_bad, "aer_span": aer_rank, "our_span": our_rank, "wrong_circuit_shots_caught": caught, "named_match_law": stated, "odd_parity_constraints": sum(c["parity"] for c in law["constraints"])}
        ok &= bad == 0 and ours_bad == 0 and aer_rank == law["dimension"] and our_rank == law["dimension"] and stated and sum(c["parity"] for c in law["constraints"]) > 0
        pos &= bad == 0
        neg &= caught >= 990
    return result("c3_clifford", ok, numbers, pos, neg)
