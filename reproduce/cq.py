"""Talk to Catalyst-Q and compute the independent answer. Everything a claim needs, nothing about how the service works."""
import json, math, os, subprocess, time, urllib.request, urllib.error
import numpy as np
from qiskit import QuantumCircuit, transpile
from qiskit.qasm2 import dumps
from qiskit_aer import AerSimulator

BASE = os.environ.get("CATALYST_Q_URL", "https://catalyst-q.strategic-innovations.ai").rstrip("/")
KEY = os.environ.get("CATALYST_Q_KEY", "")
CMD = os.environ.get("CATALYST_Q_CMD", "")   # an alternative transport: a command reading JSON on stdin, writing JSON on stdout
SCALE = float(os.environ.get("CQ_SCALE", "1"))   # fewer circuits, for the no-account rate limit
last_call = [0.0]


def call(path, body):
    """POST and return the parsed reply. A refusal is a normal reply: it carries `error`, `detail` and the numbers."""
    if CMD:
        r = subprocess.run(CMD.split(), input=json.dumps({"path": path, "body": body}), capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(r.stderr[-1500:])
        return json.loads(r.stdout)
    if not KEY:   # the no-account route allows 6 calls a minute from one address
        wait = 11 - (time.time() - last_call[0])
        if wait > 0:
            time.sleep(wait)
        last_call[0] = time.time()
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"content-type": "application/json", "user-agent": "catalyst-q-reproduce", **({"authorization": f"Bearer {KEY}"} if KEY else {})})
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:   # over the rate limit: wait as long as the reply says, then ask again
            time.sleep(min(120, int(e.headers.get("retry-after") or 60)) + 1)
            return call(path, body)
        return json.loads(e.read() or b"{}")


def execute(body):
    """Run a circuit. With a key, the signed-in route; without one, the no-account route."""
    reply = call("/api/v1/execute", body) if KEY else call("/api/v1/try", {"mode": "execute", **body})
    return reply.get("result", reply)


def score(qasm, counts):
    reply = call("/api/v1/score", {"qasm": qasm, "counts": counts}) if KEY else call("/api/v1/try", {"mode": "score", "qasm": qasm, "counts": counts})
    return reply.get("result", reply)


def observables(qasm, specs):
    reply = call("/api/v1/observables", {"qasm": qasm, "observables": specs, "tau": 0}) if KEY else call("/api/v1/try", {"mode": "circuit", "qasm": qasm, "observables": specs, "tau": 0})
    return reply.get("result", reply)


def random_brick(n, depth, seed):
    """A 1D brickwork: a random single-qubit gate on every qubit, then cz on alternating neighbours."""
    rng = np.random.default_rng(seed)
    qc = QuantumCircuit(n)
    for d in range(depth):
        for q in range(n):
            qc.u(math.acos(1 - 2 * rng.random()), 2 * math.pi * rng.random(), 2 * math.pi * rng.random(), q)
        for q in range(d % 2, n - 1, 2):
            qc.cz(q, q + 1)
    return qc


def qasm_of(qc):
    return dumps(qc)


def aer_state(qc):
    """The referee: Qiskit Aer's state vector, which shares no code with the service."""
    sim = AerSimulator(method="statevector", max_parallel_threads=4)
    c = qc.copy()
    c.save_statevector()
    return np.asarray(sim.run(transpile(c, sim, optimization_level=0)).result().get_statevector())


def aer_probabilities(qc):
    return np.abs(aer_state(qc)) ** 2


def draw_truth(p, shots, seed):
    rng = np.random.default_rng(seed)
    idx, cnt = np.unique(rng.choice(len(p), size=shots, p=p / p.sum()), return_counts=True)
    return {int(i): int(c) for i, c in zip(idx, cnt)}


def bits(i, n):
    return format(int(i), f"0{n}b")


def chi_square_p(observed, expected):
    """p-value that `observed` came from `expected`, pooling small bins."""
    from scipy.stats import chi2
    order = np.argsort(expected)
    o, e, bins = 0.0, 0.0, []
    for i in order:
        o += observed[i]; e += expected[i]
        if e >= 5:
            bins.append((o, e)); o, e = 0.0, 0.0
    if e > 0 and bins:
        a, b = bins[-1]; bins[-1] = (a + o, b + e)
    if len(bins) < 2:
        return 1.0
    stat = sum((a - b) ** 2 / b for a, b in bins)
    return float(chi2.sf(stat, len(bins) - 1))


def result(claim, passed, numbers, positive, negative, note=""):
    return {"claim": claim, "passed": bool(passed and positive and negative), "numbers": numbers, "positive_control": bool(positive), "negative_control": bool(negative), "note": note}


def distributed(body, concurrency=8):
    """A job larger than one request: plan it, carry each shard through as many hops as it takes, fold. Needs a free key."""
    from concurrent.futures import ThreadPoolExecutor
    plan = call("/api/v1/distributed/plan", body)
    if not plan.get("ok"):
        return plan
    job, open_shards, done, hops = plan["plan"]["job"], plan["plan"]["shards"], [], 0
    def hop(shard):
        return call("/api/v1/distributed/hop", {"job": job, "shard": shard})
    with ThreadPoolExecutor(concurrency) as pool:
        while open_shards:
            replies = list(pool.map(hop, open_shards))
            hops += len(replies)
            open_shards = []
            for r in replies:
                if not r.get("ok"):
                    return r
                (done if r["shard"]["next"] is None else open_shards).append(r["shard"])
    fold = call("/api/v1/distributed/fold", {"job": job, "shards": done})
    if not fold.get("ok"):
        return fold
    return {**fold["result"], "hops": hops, "plan": {k: v for k, v in plan["plan"].items() if k not in ("job", "shards")}, "job": job, "done": done}


def quimb_probability(qc, outcomes):
    """A second referee for widths Aer cannot hold: tensor-network contraction with quimb, a different algorithm in different code."""
    import cotengra as ctg
    import quimb.tensor as qtn
    out = {}
    for x in outcomes:
        c = qtn.Circuit(qc.num_qubits)
        for ins in qc.data:
            qs = [qc.find_bit(q).index for q in ins.qubits]
            if ins.operation.name == "u":
                c.apply_gate("U3", *[float(v) for v in ins.operation.params], *qs)
            elif ins.operation.name == "cz":
                c.apply_gate("CZ", *qs)
            else:
                raise ValueError(ins.operation.name)
        opt = ctg.HyperOptimizer(methods=["greedy"], max_repeats=8, parallel=False, progbar=False)
        out[x] = float(abs(c.amplitude(x[::-1], optimize=opt, backend="numpy")) ** 2)
    return out
