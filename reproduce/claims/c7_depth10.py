"""One value from a circuit a million qubits wide: everything it depends on comes back with the answer, and the referee recomputes it."""
from cq import *

def run():
    reply = call("/api/v1/try", {"mode": "brickwork", "width": 1_000_000, "depth": 10, "seed": 1})
    inputs, res = reply["inputs"], reply["result"]
    value = res["values"][0]["value"]
    # Aer recomputes from the gates the reply names. Separately, the part of the circuit left out must not matter:
    # at a width the referee can hold whole, the same family with and without the rest agrees.
    from qiskit import QuantumCircuit
    import numpy as np
    text = inputs["qasm"].replace("OPENQASM 3.0;", 'OPENQASM 2.0;\ninclude "qelib1.inc";').replace(f"qubit[{inputs['cone']['qubits']}] q;", f"qreg q[{inputs['cone']['qubits']}];")
    cone = QuantumCircuit.from_qasm_str(text)
    n = cone.num_qubits
    p = aer_probabilities(cone)
    label = res["values"][0]["observable"]
    declared = int(label[2:-1])
    target = declared - inputs["cone"]["lo"]
    z = float(((1 - 2 * ((np.arange(2 ** n) >> target) & 1)) * p).sum())
    err = abs(z - value)
    moved = abs(value - float(((1 - 2 * ((np.arange(2 ** n) >> ((target + 1) % n)) & 1)) * p).sum()))
    # The gates left out must not matter. At a width the referee can hold whole, send the whole circuit and compare.
    whole = random_brick(24, 10, 5)
    pw = aer_probabilities(whole)
    r = observables(qasm_of(whole), [{"pauli": "Z", "qubits": [12]}])
    zw = float(((1 - 2 * ((np.arange(2 ** 24) >> 12) & 1)) * pw).sum())
    err_whole = abs(r["values"][0]["value"] - zw)
    # Negative control sent to the service: a rotation at the start of the circuit, inside what the value depends on,
    # must move both the referee and the service; one far outside must move neither.
    def with_first(q):
        c = QuantumCircuit(24)
        c.rx(0.3, q)
        return c.compose(whole)
    def z_of(c):
        return float(((1 - 2 * ((np.arange(2 ** 24) >> 12) & 1)) * aer_probabilities(c)).sum())
    inside, far = with_first(12), with_first(0)
    zi, zf = z_of(inside), z_of(far)
    si = observables(qasm_of(inside), [{"pauli": "Z", "qubits": [12]}])["values"][0]["value"]
    sf = observables(qasm_of(far), [{"pauli": "Z", "qubits": [12]}])["values"][0]["value"]
    numbers_inside = {"referee_moved": abs(zi - zw), "service_error": abs(si - zi)}
    numbers_far = {"referee_moved": abs(zf - zw), "service_error": abs(sf - zf)}
    return result("c7_depth10", err < 1e-10 and err_whole < 1e-10, {"declared_qubits": inputs["width"], "qubits_it_depends_on": n, "value": value, "referee": z, "error": err, "whole_24_qubit_circuit_error": err_whole, "control_inside": numbers_inside, "control_outside": numbers_far, "not_checked": "the width is declared; the referee holds at most 24 qubits whole"}, abs(float(p.sum()) - 1) < 1e-9 and abs(zf - zw) < 1e-10 and abs(sf - zf) < 1e-10, moved > 1e-6 and abs(zi - zw) > 1e-3 and abs(si - zi) < 1e-10)
