"""Shots and named outcomes past 20 measured qubits, exact against the referee."""
import numpy as np
from qiskit import QuantumCircuit
from cq import *

def run():
    n, depth = 24, 6
    qc = random_brick(n, depth, 7)
    q = qasm_of(qc)
    p = aer_probabilities(qc)
    ideal = float((p ** 2).sum())
    d = execute({"qasm": q, "sampling": "random", "shots": 4096, "seed": 11})
    assert d.get("sampling") == "random", d
    vals = np.array([p[int(k, 2)] for k, c in d["counts"].items() for _ in range(c)])
    z = (vals.mean() - ideal) / (vals.std() / np.sqrt(len(vals)))
    named = [bits(i, n) for i in draw_truth(p, 256, 3)]
    a = execute({"qasm": q, "outcomes": named})
    rel = max(abs(a["probabilities"][x] - p[int(x, 2)]) / p[int(x, 2)] for x in named)
    # Positive control: truth draws pass the same z test. Negative control: draws of a different circuit fail it.
    t = draw_truth(p, 4096, 5)
    tv = np.array([p[i] for i, c in t.items() for _ in range(c)])
    zt = (tv.mean() - ideal) / (tv.std() / np.sqrt(len(tv)))
    other = random_brick(n, depth, 8)
    o = aer_probabilities(other)
    ov = np.array([p[i] for i, c in draw_truth(o, 4096, 5).items() for _ in range(c)])
    zo = (ov.mean() - ideal) / (ov.std() / np.sqrt(len(ov)))
    # The shape of the draws, not one moment: every block of 8 qubits against the referee's marginal.
    from scipy.stats import chisquare
    def block_ps(counts, truth, width):
        shots = sum(counts.values())
        out = []
        for start in range(0, width, 8):
            mask = (1 << min(8, width - start)) - 1
            obs = np.zeros(mask + 1)
            for k, c in counts.items():
                obs[(int(k, 2) >> start) & mask] += c
            exp = np.zeros(mask + 1)
            for i in np.nonzero(truth)[0]:
                exp[(int(i) >> start) & mask] += truth[i]
            out.append(chi_square_p(obs, exp * shots))
        return out
    blocks = block_ps(d["counts"], p, n)
    # Separate blocks, a second shape of circuit for the same test.
    sep = QuantumCircuit(24)
    rng = np.random.default_rng(13)
    for b in range(0, 24, 8):
        for layer in range(10):
            for q in range(b, b + 8):
                sep.u(*(rng.random(3) * 3), q)
            for q in range(b + layer % 2, b + 7, 2):
                sep.cz(q, q + 1)
    ps = aer_probabilities(sep)
    ds = execute({"qasm": qasm_of(sep), "sampling": "random", "shots": 8192, "seed": 3})
    sep_blocks = block_ps(ds["counts"], ps, 24)
    biased = {bits(i, n): c for i, c in draw_truth(p ** 1.3 / (p ** 1.3).sum(), 4096, 6).items()}
    biased_block = min(block_ps(biased, p, n))
    wide = random_brick(64, 4, 9)
    w = execute({"qasm": qasm_of(wide), "sampling": "random", "shots": 8192, "seed": 2})
    # The 64-qubit draws themselves: the total, and two windows against what Aer computes for the part of the circuit they depend on.
    def window_p(lo, width):
        hi = lo + width
        keep = set(range(lo, hi))
        for ins in reversed(wide.data):
            qs = [wide.find_bit(q).index for q in ins.qubits]
            if keep & set(qs):
                keep |= set(qs)
        order = sorted(keep)
        pos = {q: i for i, q in enumerate(order)}
        sub = QuantumCircuit(len(order))
        chosen = set(range(lo, hi))
        kept = []
        for ins in reversed(wide.data):
            qs = [wide.find_bit(q).index for q in ins.qubits]
            if chosen & set(qs):
                chosen |= set(qs); kept.append(ins)
        for ins in reversed(kept):
            sub.append(ins.operation, [pos[wide.find_bit(q).index] for q in ins.qubits])
        ps = aer_probabilities(sub)
        exp = np.zeros(2 ** width)
        idx = np.arange(len(ps))
        marg = np.zeros(len(ps), dtype=int)
        for t in range(width):
            marg |= ((idx >> pos[lo + t]) & 1) << t
        np.add.at(exp, marg, ps)
        obs = np.zeros(2 ** width)
        for k, c in w["counts"].items():
            obs[(int(k, 2) >> lo) & ((1 << width) - 1)] += c
        return chi_square_p(obs, exp * sum(w["counts"].values()))
    w_total = sum(w.get("counts", {}).values())
    wide_ps = [window_p(0, 8), window_p(26, 12), window_p(52, 12)]
    floor = 1e-3
    return result("c2_wide_shots", abs(z) < 4 and rel < 1e-10 and w_total == 8192 and min(wide_ps) > floor and min(blocks) > floor and min(sep_blocks) > floor,
                  {"n": n, "worst_block_p": min(blocks), "separate_blocks_method": ds.get("method"), "separate_worst_block_p": min(sep_blocks), "biased_worst_block_p": biased_block, "n64_shots": w_total, "n64_window_p": wide_ps, "not_checked": "correlations between windows far apart at 64 qubits", "z_of_draws": float(z), "named_worst_relative_error": rel, "method_draws": d.get("method"), "method_named": a.get("method"), "held": a.get("qubits_held"), "n64_method": w.get("method"), "n64_held": w.get("qubits_held"), "n64_error": w.get("error")},
                  abs(zt) < 4, abs(zo) > 4 and biased_block < floor)
