"""The logical error rate of a distance-3 rotated surface code under a coherent rotation on every data qubit, recomputed from a dense code state."""
import itertools
import numpy as np
from cq import *

# Data qubits on a 3 x 3 grid, X stabilisers of the rotated code.
X_STABS = [(0, 1), (1, 2, 4, 5), (3, 4, 6, 7), (7, 8)]
Z_STABS = [(0, 1, 3, 4), (2, 5), (3, 6), (4, 5, 7, 8)]
LOGICAL_X = (0, 3, 6)   # commutes with every Z stabiliser
LOGICAL_Z = (0, 1, 2)
N = 9

def parity_mask(support):
    return sum(1 << q for q in support)

def apply_x(state, support):
    return state[np.arange(2 ** N) ^ parity_mask(support)]

def z_sign(support):
    idx = np.arange(2 ** N)
    bits = np.zeros(2 ** N, dtype=int)
    for q in support:
        bits ^= (idx >> q) & 1
    return 1 - 2 * bits

def plus_logical():
    """|+L>: the +1 eigenstate of every stabiliser and of logical X."""
    s = np.zeros(2 ** N, dtype=complex); s[0] = 1
    for g in X_STABS:
        s = (s + apply_x(s, g)) / 2
    s = (s + apply_x(s, LOGICAL_X)) / 2
    s /= np.linalg.norm(s)
    return s

def decoder():
    """For each X syndrome, a minimum-weight set of Z corrections."""
    table = {}
    for w in range(N + 1):
        for sup in itertools.combinations(range(N), w):
            syn = tuple(sum(1 for q in g if q in sup) % 2 for g in X_STABS)
            table.setdefault(syn, sup)
    return table

def coherent(eps):
    state = plus_logical()
    idx = np.arange(2 ** N)
    weight = np.zeros(2 ** N, dtype=int)
    for q in range(N):
        weight += (idx >> q) & 1
    state = state * np.exp(1j * eps * (weight - N / 2.0))
    table = decoder()
    fail = 0.0
    for syn in itertools.product((0, 1), repeat=len(X_STABS)):
        ph = state.copy()
        for g, s in zip(X_STABS, syn):
            ph = (ph + (-1) ** s * apply_x(ph, g)) / 2
        p = float(np.vdot(ph, ph).real)
        if p < 1e-30:
            continue
        ph = ph * z_sign(table[syn])
        xl = float(np.vdot(ph, apply_x(ph, LOGICAL_X)).real)
        fail += (p - xl) / 2
    return fail

def twirled(eps):
    """The same rotation replaced by independent Z flips of probability sin^2(eps / 2)."""
    q = np.sin(eps / 2) ** 2
    table = decoder()
    fail = 0.0
    for w in range(N + 1):
        for sup in itertools.combinations(range(N), w):
            syn = tuple(sum(1 for t in g if t in sup) % 2 for g in X_STABS)
            residual = set(sup) ^ set(table[syn])
            if len(residual & set(LOGICAL_X)) % 2:
                fail += q ** w * (1 - q) ** (N - w)
    return fail

def run():
    numbers, ok, moved = {}, True, 0.0
    for eps in (0.1, 0.3):
        reply = call("/api/v1/try", {"mode": "qec", "distance": 3, "epsilon": eps})
        row = reply["result"]["rows"][0]
        c, t = coherent(eps), twirled(eps)
        numbers[f"eps_{eps}"] = {"service_coherent": row["p_logical_coherent"], "referee_coherent": c, "service_twirled": row["p_logical_twirled"], "referee_twirled": t}
        ok &= abs(row["p_logical_coherent"] - c) < 1e-10 * c and abs(row["p_logical_twirled"] - t) < 1e-10 * t
        moved = max(moved, abs(coherent(eps * 1.01) - c) / c)
    numbers["control_moved"] = moved
    # Positive control: with no error there is no failure, and the code state really is one.
    state = plus_logical()
    clean = max(abs(np.vdot(state, apply_x(state, g)).real - 1) for g in X_STABS) < 1e-12 and max(abs(np.vdot(state, z_sign(g) * state).real - 1) for g in Z_STABS) < 1e-12 and coherent(0.0) < 1e-20
    return result("c8_qec", ok, numbers, clean, moved > 1e-3)
