"""Scoring a device's counts against the exact answer: draws from the truth score high, noise scores what theory says, nonsense scores zero."""
import numpy as np
from cq import *

def run():
    numbers = {}
    n, shots = 12, 20000
    qc = random_brick(n, 8, 21)
    q = qasm_of(qc)
    p = aer_probabilities(qc)
    ideal = 2 ** n * float((p ** 2).sum()) - 1
    key = lambda d: {bits(i, n): c for i, c in d.items()}
    perfect = score(q, key(draw_truth(p, shots, 1)))["score"]
    f = 0.7
    mixed = f * p + (1 - f) / 2 ** n
    noisy = score(q, key(draw_truth(mixed, shots, 2)))["score"]
    expected = f * ideal
    z_noisy = (noisy["xeb"]["value"] - expected) / noisy["xeb"]["standard_error"]
    # Negative control: the same outcomes with their bits shuffled by a fixed permutation of labels carry no signal.
    perm = np.random.default_rng(3).permutation(2 ** n)
    shuffled = score(q, key({int(perm[i]): c for i, c in draw_truth(p, shots, 4).items()}))["score"]
    z_shuf = shuffled["xeb"]["value"] / shuffled["xeb"]["standard_error"]
    numbers.update({"perfect_hellinger": perfect["table"]["hellinger_fidelity"], "perfect_device_floor": perfect["table"]["perfect_device"], "noisy_xeb": noisy["xeb"], "expected_noisy_xeb": expected, "z_noisy": float(z_noisy), "shuffled_xeb": shuffled["xeb"], "z_shuffled": float(z_shuf)})
    # Past 20 measured qubits there is no table, and the score still works.
    wide = random_brick(24, 6, 22)
    pw = aer_probabilities(wide)
    ideal_w = 2 ** 24 * float((pw ** 2).sum()) - 1
    good = score(qasm_of(wide), {bits(i, 24): c for i, c in draw_truth(pw, 2000, 5).items()})["score"]
    z_w = (good["xeb"]["value"] - ideal_w) / good["xeb"]["standard_error"]
    # Recompute the score from the referee, so its numbers do not rest on the service's own arithmetic.
    pq = np.zeros(2 ** n)
    for i, c in draw_truth(p, shots, 1).items():
        pq[i] = c / shots
    numbers["hellinger_recomputed_error"] = abs(float((np.sqrt(p * pq).sum()) ** 2) - perfect["table"]["hellinger_fidelity"])
    numbers["shuffled_hellinger"] = shuffled["table"]["hellinger_fidelity"]
    numbers["wide_ideal_basis"] = good["xeb"]["ideal_basis"]
    numbers.update({"wide_xeb": good["xeb"], "wide_ideal_from_referee": ideal_w, "z_wide": float(z_w)})
    # A finite run of a perfect device never reads 1: what it should match is the floor the reply reports for that many shots.
    small = random_brick(6, 6, 23)
    ps = aer_probabilities(small)
    tight = score(qasm_of(small), {bits(i, 6): c for i, c in draw_truth(ps, 20000, 6).items()})["score"]
    numbers["small_hellinger"] = tight["table"]["hellinger_fidelity"]
    near_floor = abs(perfect["table"]["hellinger_fidelity"] - perfect["table"]["perfect_device"]["hellinger_fidelity"]) < 0.005
    ok = tight["table"]["hellinger_fidelity"] > 0.99 and near_floor and abs(z_noisy) < 4 and abs(z_w) < 4 and numbers["hellinger_recomputed_error"] < 1e-9 and good["xeb"]["ideal_basis"] == "estimate_from_draws"
    # Positive: the truth scores near its ideal. Negative: shuffled labels score near zero and well below the truth on Hellinger.
    return result("c6_score", ok, numbers, abs(perfect["xeb"]["value"] - ideal) < 4 * perfect["xeb"]["standard_error"], abs(z_shuf) < 4 and shuffled["table"]["hellinger_fidelity"] < 0.7)
