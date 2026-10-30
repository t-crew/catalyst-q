/**
 * Catalyst-Q connector: a hosted API that runs circuits on classical hardware
 * and returns exact answers, or refuses with the numbers. It is not a quantum
 * computer.
 *
 * Usage:
 *   yardstick run --provider catalyst-q --benchmarks ghz
 *   yardstick run --provider catalyst-q --key "$CATALYST_Q_KEY"
 *
 * Or via env vars:
 *   export CATALYST_Q_KEY=...       # optional; without it, the no-account route
 *   export CATALYST_Q_BASE_URL=...  # optional
 *
 * No key: up to 64 qubits and 4,000 gates, 6 calls a minute, 60 a day. A rate
 * limit is waited out, using the retry-after the service sends.
 *
 * A refusal is thrown as an Error holding the service's code, detail and
 * numbers, and the yardstick records it against that width.
 *
 * Self-contained: this file needs nothing but fetch.
 * Docs: https://catalyst-q.strategic-innovations.ai
 */

const DEFAULT_URL = "https://catalyst-q.strategic-innovations.ai"
const FULL_TABLE_MAX_MEASURED = 20
const MAX_WRITTEN_GATES = 50000

const qref = q => `q[${q}]`

function mcz(qubits, out) {
  // Multi-controlled Z, written with controlled phases and CNOTs only. The gate count triples with each control,
  // so the expansion stops at a limit well above what the API accepts, instead of filling memory.
  const target = qubits[qubits.length - 1]
  mcp(qubits.slice(0, -1), target, Math.PI, out)
}

function mcp(controls, target, angle, out) {
  if (out.length > MAX_WRITTEN_GATES) {
    throw new Error(`Catalyst-Q connector: a multi-controlled Z this wide takes more than ${MAX_WRITTEN_GATES} gates to write out`)
  }
  if (controls.length === 0) {
    out.push(`p(${angle}) ${qref(target)};`)
    return
  }
  if (controls.length === 1) {
    out.push(`cp(${angle}) ${qref(controls[0])}, ${qref(target)};`)
    return
  }
  const last = controls[controls.length - 1]
  const rest = controls.slice(0, -1)
  out.push(`cp(${angle / 2}) ${qref(last)}, ${qref(target)};`)
  mcx(rest, last, out)
  out.push(`cp(${-angle / 2}) ${qref(last)}, ${qref(target)};`)
  mcx(rest, last, out)
  mcp(rest, target, angle / 2, out)
}

function mcx(controls, target, out) {
  if (controls.length === 1) {
    out.push(`cx ${qref(controls[0])}, ${qref(target)};`)
    return
  }
  out.push(`h ${qref(target)};`)
  mcp(controls, target, Math.PI, out)
  out.push(`h ${qref(target)};`)
}

/** Turns the yardstick's circuit into OpenQASM 3 with no measurements. */
export function toQasm(circuit) {
  const out = ["OPENQASM 3.0;", `qubit[${circuit.n}] q;`]
  for (const gate of circuit.gates) {
    const q = Array.isArray(gate.q) ? gate.q : [gate.q]
    const params = gate.params ?? []
    switch (gate.g) {
      case "measure":
        break
      case "h": case "x": case "y": case "z": case "s": case "sdg": case "t":
        out.push(`${gate.g} ${qref(q[0])};`)
        break
      case "rx": case "ry": case "rz":
        out.push(`${gate.g}(${params[0] ?? 0}) ${qref(q[0])};`)
        break
      case "cx": case "cz": case "swap":
        out.push(`${gate.g} ${qref(q[0])}, ${qref(q[1])};`)
        break
      case "cp":
        out.push(`cp(${params[0] ?? 0}) ${qref(q[0])}, ${qref(q[1])};`)
        break
      case "ccz":
      case "mcz":
        if (q.length === 1) out.push(`z ${qref(q[0])};`)
        else if (q.length === 2) out.push(`cz ${qref(q[0])}, ${qref(q[1])};`)
        else if (q.length === 3) out.push(`h ${qref(q[2])};`, `ccx ${qref(q[0])}, ${qref(q[1])}, ${qref(q[2])};`, `h ${qref(q[2])};`)
        else mcz(q, out)
        break
      default:
        throw new Error(`Catalyst-Q connector: unsupported gate '${gate.g}'`)
    }
  }
  return out.join("\n") + "\n"
}

/** Turns a string of Paulis (letter i acts on qubit i) into an observable, or null when it is all identity. */
export function toObservable(word) {
  const pauli = []
  const qubits = []
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== "I") {
      pauli.push(word[i])
      qubits.push(i)
    }
  }
  return pauli.length ? { pauli: pauli.join(""), qubits } : null
}

export function createCatalystQProvider(config = {}) {
  const key = config.key || process.env.CATALYST_Q_KEY || null
  const baseUrl = (config.url || process.env.CATALYST_Q_BASE_URL || DEFAULT_URL).replace(/\/+$/, "")
  const timeout = Number(config.timeout) || 120000
  const fetchImpl = config.fetch || globalThis.fetch
  const sleep = config.sleep || (ms => new Promise(done => setTimeout(done, ms)))
  const patience = config.patience ?? 3

  async function post(path, body, attempt = 0) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let response, text
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      text = await response.text()
    } finally {
      clearTimeout(timer)
    }
    let reply
    try {
      reply = JSON.parse(text)
    } catch {
      throw new Error(`Catalyst-Q: HTTP ${response.status}, reply was not JSON`)
    }
    if (response.status === 429 && attempt < patience) {
      const wait = Number(response.headers.get("retry-after"))
      await sleep((Number.isFinite(wait) && wait > 0 ? wait : 10) * 1000)
      return post(path, body, attempt + 1)
    }
    if (!response.ok || reply?.ok === false) {
      const { ok, error, detail, ...numbers } = reply ?? {}
      const extra = Object.keys(numbers).length ? ` ${JSON.stringify(numbers)}` : ""
      throw new Error(`Catalyst-Q refused (${error ?? response.status}): ${detail ?? ""}${extra}`)
    }
    return reply
  }

  const send = (keyPath, mode, body) => (key ? post(keyPath, body) : post("/api/v1/try", { mode, ...body }))

  async function readExpectations(circuit, qasm) {
    const words = (circuit.expect ?? []).map(e => e.word)
    const asked = words.map(toObservable)
    const needed = asked.filter(Boolean)
    const reply = needed.length ? await send("/api/v1/observables", "circuit", { qasm, observables: needed }) : { result: { values: [] } }
    const values = reply.result?.values ?? []
    if (values.length !== needed.length) throw new Error(`Catalyst-Q: asked for ${needed.length} values, got ${values.length}`)
    let next = 0
    const expectations = words.map((word, i) => {
      if (!asked[i]) return { word, value: 1 }
      const entry = values[next++]
      if (typeof entry?.value !== "number") throw new Error(`Catalyst-Q: no value for ${word}`)
      return { word, value: entry.value, exact: entry.exact, certificate: entry.certificate }
    })
    const energy = expectations.reduce((sum, e, i) => sum + (circuit.expect[i].coeff ?? 1) * e.value, 0)
    return { expectations, energy, reply }
  }

  async function readDistribution(circuit, qasm) {
    const measure = Array.from({ length: circuit.n }, (_, i) => i)
    if (circuit.n <= FULL_TABLE_MAX_MEASURED) {
      const reply = await send("/api/v1/execute", "execute", { qasm, measure })
      const table = reply.result?.probabilities
      if (!table) throw new Error("Catalyst-Q: the reply held no probabilities")
      return { distribution: table, reply }
    }
    const shots = circuit.shots || 1024
    const reply = await send("/api/v1/execute", "execute", { qasm, measure, sampling: "random", shots })
    const counts = reply.result?.counts
    if (!counts) throw new Error("Catalyst-Q: the reply held no counts")
    const distribution = {}
    for (const [bits, count] of Object.entries(counts)) distribution[bits] = count / shots
    return { distribution, reply }
  }

  async function run(circuit) {
    const started = performance.now()
    const qasm = toQasm(circuit)
    const wantsShots = (circuit.shots ?? 0) > 0
    const read = wantsShots ? await readDistribution(circuit, qasm) : await readExpectations(circuit, qasm)
    const { reply, ...values } = read
    return {
      ...values,
      metadata: {
        provider: "catalyst-q",
        time_ms: performance.now() - started,
        // Not reported by this API, so left out instead of guessed: memory_bytes and materialized.
        mode: reply.result?.method,
        shots_returned: wantsShots ? circuit.shots : 0,
        record_id: reply.record_id ?? undefined,
        permalink: reply.permalink ?? undefined,
      },
    }
  }

  return { name: "catalyst-q", run, meta: { name: "catalyst-q", url: baseUrl, account: key ? "key" : "none" } }
}

export default createCatalystQProvider
