"""Random shots follow the exact distribution: random u and cz circuits of 2 to 12 qubits. Wider paths are tested in c2."""
import numpy as np
from cq import *

def run():
    circuits = max(4, int(200 * SCALE))
    shots, floor = 4096, 1e-3 / circuits
    worst, biased_caught, truth_ok = 1.0, 0, 0
    for k in range(circuits):
        n, depth = 2 + k % 11, 2 + k % 7
        qc = random_brick(n, depth, 1000 + k)
        p = aer_probabilities(qc)
        o = execute({"qasm": qasm_of(qc), "sampling": "random", "shots": shots, "seed": k})
        assert o.get("sampling") == "random", o
        obs = np.zeros(2 ** n)
        for key, c in o["counts"].items():
            obs[int(key, 2)] = c
        worst = min(worst, chi_square_p(obs, p * shots))
        # Positive control: draws we make ourselves from the truth must pass the same test.
        t = np.zeros(2 ** n)
        for i, c in draw_truth(p, shots, k).items():
            t[i] = c
        truth_ok += chi_square_p(t, p * shots) >= floor
        # Negative control: a sampler biased towards the likeliest outcomes must fail it.
        b = p ** 1.5 / (p ** 1.5).sum()
        t = np.zeros(2 ** n)
        for i, c in draw_truth(b, shots, k).items():
            t[i] = c
        biased_caught += chi_square_p(t, p * shots) < floor
    return result("c1_shots", worst >= floor, {"circuits": circuits, "shots": shots, "worst_p": worst, "p_floor": floor, "biased_caught": biased_caught},
                  truth_ok == circuits, biased_caught >= 0.8 * circuits)
