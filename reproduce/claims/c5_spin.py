"""Interacting spin and electron models, exact with no error bound: XXZ at half filling, Hubbard at half filling."""
import numpy as np
from qiskit import QuantumCircuit
from cq import *

def trotter_qasm(n, bonds, onsite, steps, dt, delta):
    """OpenQASM 3 with rxx, ryy, rzz written as a person writes them, and a Neel-style start from x gates."""
    L = ["OPENQASM 3.0;", f"qubit[{n}] q;"] + [f"x q[{q}];" for q in onsite["start"]]
    for _ in range(steps):
        for layer in bonds:
            for a, b in layer:
                L += [f"rxx({2 * dt}) q[{a}], q[{b}];", f"ryy({2 * dt}) q[{a}], q[{b}];"]
                if delta: L.append(f"rzz({2 * dt * delta}) q[{a}], q[{b}];")
        for a, b in onsite["pairs"]:
            L.append(f"rzz({2 * dt * onsite['u']}) q[{a}], q[{b}];")
    return "\n".join(L) + "\n"

def aer_of(n, bonds, onsite, steps, dt, delta):
    c = QuantumCircuit(n)
    for q in onsite["start"]: c.x(q)
    for _ in range(steps):
        for layer in bonds:
            for a, b in layer:
                c.rxx(2 * dt, a, b); c.ryy(2 * dt, a, b)
                if delta: c.rzz(2 * dt * delta, a, b)
        for a, b in onsite["pairs"]:
            c.rzz(2 * dt * onsite["u"], a, b)
    return c

def z_expect(p, n, qubits):
    idx = np.arange(2 ** n)
    s = np.ones(2 ** n)
    for q in qubits: s *= 1 - 2 * ((idx >> q) & 1)
    return float((p * s).sum())

def chain(n, offset=0):
    return [[(offset + q, offset + q + 1) for q in range(par, n - 1, 2)] for par in (0, 1)]

def xx_free_fermion(n, start, steps, dt):
    """The XX chain maps to free fermions: an exact answer that needs no simulator, at any n."""
    from scipy.linalg import expm
    def layer(par):
        h = np.zeros((n, n))
        for q in range(par, n - 1, 2): h[q, q + 1] = h[q + 1, q] = 2.0
        return expm(-1j * dt * h)
    u = np.eye(n, dtype=complex)
    for _ in range(steps): u = layer(1) @ layer(0) @ u
    return 1 - 2 * (np.abs(u[:, list(start)]) ** 2).sum(axis=1)

def run():
    numbers, ok = {}, True
    specs = lambda n: [{"pauli": "Z", "qubits": [n // 2]}, {"pauli": "ZZ", "qubits": [n // 2 - 1, n // 2]}]
    n, steps = 24, int(50 * SCALE) or 4
    neel = {"start": list(range(1, n, 2)), "pairs": [], "u": 0}
    o = observables(trotter_qasm(n, chain(n), neel, steps, 0.1, 1.0), specs(n))
    p = aer_probabilities(aer_of(n, chain(n), neel, steps, 0.1, 1.0))
    refs = [z_expect(p, n, [n // 2]), z_expect(p, n, [n // 2 - 1, n // 2])]
    if "values" in o:
        err = max(abs(v["value"] - r) for v, r in zip(o["values"], refs))
        numbers["xxz_24"] = {"steps": steps, "worst_error": err, "certificate": max(v["certificate"] for v in o["values"]), "chart_ms": o.get("duration_ms")}
        ok &= err < 1e-10 and len(o["values"]) == 2 and all(v["certificate"] == 0 for v in o["values"])
    else:
        numbers["xxz_24"] = o; ok = False
    # Positive control: Aer agrees with the free-fermion answer on the XX chain, so the referee itself is sound.
    n2, s2 = 14, 12
    start = list(range(1, n2, 2))
    ff = xx_free_fermion(n2, start, s2, 0.1)
    pa = aer_probabilities(aer_of(n2, chain(n2), {"start": start, "pairs": [], "u": 0}, s2, 0.1, 0.0))
    # Qiskit's rxx(t) rxx-ryy pair is exp(-i t/2 (XX+YY)): hopping 2 in the fermion picture at dt, as above.
    referee = max(abs(z_expect(pa, n2, [q]) - ff[q]) for q in range(n2))
    n3, s3 = 24, int(40 * SCALE) or 4
    start3 = list(range(1, n3, 2))
    ffz = xx_free_fermion(n3, start3, s3, 0.1)
    o3 = observables(trotter_qasm(n3, chain(n3), {"start": start3, "pairs": [], "u": 0}, s3, 0.1, 0.0), [{"pauli": "Z", "qubits": [q]} for q in (0, 5, 12, 23)])
    if "values" in o3:
        e3 = max(abs(v["value"] - ffz[q]) for v, q in zip(o3["values"], (0, 5, 12, 23)))
        numbers["xx_24_free_fermion"] = {"steps": s3, "worst_error": e3, "certificate": max(v["certificate"] for v in o3["values"]), "values": len(o3["values"])}
        ok &= e3 < 1e-10 and len(o3["values"]) == 4 and all(v["certificate"] == 0 for v in o3["values"])
    else:
        numbers["xx_24_free_fermion"] = o3; ok = False
    sites, s4 = 12, int(20 * SCALE) or 3
    hub = {"start": list(range(0, sites, 2)) + [sites + q for q in range(1, sites, 2)], "pairs": [(q, sites + q) for q in range(sites)], "u": 0.5}
    bonds = [chain(sites)[0] + chain(sites, sites)[0], chain(sites)[1] + chain(sites, sites)[1]]
    o4 = observables(trotter_qasm(2 * sites, bonds, hub, s4, 0.1, 0.0), [{"pauli": "Z", "qubits": [sites // 2]}, {"pauli": "ZZ", "qubits": [sites // 2, sites + sites // 2]}])
    ph = aer_probabilities(aer_of(2 * sites, bonds, hub, s4, 0.1, 0.0))
    r4 = [z_expect(ph, 2 * sites, [sites // 2]), z_expect(ph, 2 * sites, [sites // 2, sites + sites // 2])]
    if "values" in o4:
        e4 = max(abs(v["value"] - r) for v, r in zip(o4["values"], r4))
        numbers["hubbard_12_sites"] = {"steps": s4, "worst_error": e4, "certificate": max(v["certificate"] for v in o4["values"])}
        ok &= e4 < 1e-10 and len(o4["values"]) == 2 and all(v["certificate"] == 0 for v in o4["values"])
    else:
        numbers["hubbard_12_sites"] = o4; ok = False
    # Negative control: a different delta moves the XXZ reference well past the tolerance.
    pd = aer_probabilities(aer_of(n, chain(n), neel, steps, 0.1, 1.001))
    moved = abs(z_expect(pd, n, [n // 2 - 1, n // 2]) - refs[1])
    numbers["referee_vs_free_fermion"] = referee
    numbers["control_moved"] = moved
    return result("c5_spin", ok, numbers, referee < 1e-10, moved > 1e-7)
