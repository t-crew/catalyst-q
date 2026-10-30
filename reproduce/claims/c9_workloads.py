"""Two everyday checks: a reversible adder on inputs you choose, checked with ordinary integers, and an orbital-rotation circuit for chemistry, checked with a determinant."""
import numpy as np
from qiskit import QuantumCircuit
from cq import *

def adder_qasm(bits_n, a, b):
    """Cuccaro ripple-carry adder: c0, then a and b interleaved, then the carry out. b becomes a + b."""
    n = 2 * bits_n + 2
    L = ['OPENQASM 2.0;', 'include "qelib1.inc";', f'qreg q[{n}];', f'creg c[{bits_n + 1}];']
    A = lambda i: 2 * i + 2
    B = lambda i: 2 * i + 1
    for i in range(bits_n):
        if (a >> i) & 1: L.append(f'x q[{A(i)}];')
        if (b >> i) & 1: L.append(f'x q[{B(i)}];')
    maj = lambda x, y, z: [f'cx q[{z}],q[{y}];', f'cx q[{z}],q[{x}];', f'ccx q[{x}],q[{y}],q[{z}];']
    uma = lambda x, y, z: [f'ccx q[{x}],q[{y}],q[{z}];', f'cx q[{z}],q[{x}];', f'cx q[{x}],q[{y}];']
    prev = 0
    for i in range(bits_n):
        L += maj(prev, B(i), A(i)); prev = A(i)
    L.append(f'cx q[{A(bits_n - 1)}],q[{n - 1}];')
    for i in reversed(range(bits_n)):
        prev = 0 if i == 0 else A(i - 1)
        L += uma(prev, B(i), A(i))
    for i in range(bits_n):
        L.append(f'measure q[{B(i)}] -> c[{i}];')
    L.append(f'measure q[{n - 1}] -> c[{bits_n}];')
    return "\n".join(L) + "\n"

def orbital_rotation(n, electrons, layers, seed):
    """Nearest-neighbour rotations between orbitals keep the state a single determinant, so a determinant gives the answer."""
    from scipy.linalg import expm
    rng = np.random.default_rng(seed)
    L = ["OPENQASM 3.0;", f"qubit[{n}] q;"] + [f"x q[{q}];" for q in range(electrons)]
    u = np.eye(n, dtype=complex)
    for d in range(layers):
        h = np.zeros((n, n))
        for q in range(d % 2, n - 1, 2):
            t = float(rng.uniform(-0.7, 0.7))
            L += [f"rxx({t}) q[{q}], q[{q + 1}];", f"ryy({t}) q[{q}], q[{q + 1}];"]
            h[q, q + 1] = h[q + 1, q] = t   # exp(-i t/2 (XX+YY)) hops with amplitude t
        u = expm(-1j * h) @ u
    z = 1 - 2 * (np.abs(u[:, :electrons]) ** 2).sum(axis=1)
    return "\n".join(L) + "\n", z

def run():
    numbers, ok = {}, True
    rng = np.random.default_rng(1)
    width = 64 if KEY else 30
    good = 0
    trials = max(3, int(20 * SCALE))
    for _ in range(trials):
        a, b = int(rng.integers(2 ** (width - 1))) * 2 + int(rng.integers(2)), int(rng.integers(2 ** (width - 1))) * 2 + int(rng.integers(2))
        o = execute({"qasm": adder_qasm(width, a, b), "sampling": "random", "shots": 8, "seed": 1})
        keys = list(o.get("counts", {}))
        good += keys == [format(a + b, f"0{width + 1}b")]
        if len(keys) != 1: numbers["last_reply"] = {k: o.get(k) for k in ("error", "detail", "method")}
    numbers["adder"] = {"bits": width, "qubits": 2 * width + 2, "correct": good, "trials": trials}
    ok &= good == trials
    # Negative control: a broken adder, with one cx removed, must give a wrong sum on some input.
    a, b = 2 ** width - 1, 1
    broken = adder_qasm(width, a, b).replace(f"cx q[{2 * (width - 1) + 2}],q[{2 * width + 1}];\n", "", 1)
    o = execute({"qasm": broken, "sampling": "random", "shots": 8, "seed": 1})
    numbers["broken_adder_reply"] = list(o.get("counts", {}))[:1] or o.get("error")
    wrong = bool(o.get("counts")) and list(o["counts"]) != [format(a + b, f"0{width + 1}b")]
    n, electrons = (30, 6) if KEY else (24, 6)
    q, z = orbital_rotation(n, electrons, 12, 3)
    picks = [0, 5, 11, n - 1]
    r = observables(q, [{"pauli": "Z", "qubits": [p]} for p in picks])
    if "values" in r:
        err = max(abs(v["value"] - z[p]) for v, p in zip(r["values"], picks))
        numbers["orbital_rotation"] = {"orbitals": n, "electrons": electrons, "worst_error": err, "certificate": max(v["certificate"] for v in r["values"])}
        ok &= err < 1e-10
    else:
        numbers["orbital_rotation"] = r; ok = False
    # Positive control: the referee's own determinant formula agrees with Aer at a size Aer can hold.
    q2, z2 = orbital_rotation(14, 6, 12, 4)
    c2 = QuantumCircuit.from_qasm_str(q2.replace("OPENQASM 3.0;", 'OPENQASM 2.0;\ninclude "qelib1.inc";\ngate rxx(t) a,b {h a; h b; cx a,b; rz(t) b; cx a,b; h a; h b;}\ngate ryy(t) a,b {rx(pi/2) a; rx(pi/2) b; cx a,b; rz(t) b; cx a,b; rx(-pi/2) a; rx(-pi/2) b;}').replace("qubit[14] q;", "qreg q[14];"))
    p2 = aer_probabilities(c2)
    formula = max(abs(float(((1 - 2 * ((np.arange(2 ** 14) >> k) & 1)) * p2).sum()) - z2[k]) for k in range(14))
    numbers["determinant_vs_aer"] = formula
    return result("c9_workloads", ok, numbers, formula < 1e-10, wrong)
