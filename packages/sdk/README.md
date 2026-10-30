# catalyst-q

A TypeScript client for [Catalyst-Q](https://catalyst-q.strategic-innovations.ai), a hosted API that runs quantum circuits on classical hardware and returns exact answers, or refuses with the numbers. It is not a quantum computer.

No runtime dependencies. It uses the platform `fetch` (Node 18+, browsers, Workers). ES module and CommonJS builds, with types for every request and response.

## Install

```sh
npm install catalyst-q
```

## No account

Without a key, calls go through `/api/v1/try`: up to 64 qubits and 4,000 gates, 6 calls a minute and 60 a day per address.

```ts
import { CatalystQ, settle } from "catalyst-q";

const q = new CatalystQ();
const out = await settle(q.run({ qasm: "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];", measure: [0, 1] }));

if (out.kind === "answer") console.log(out.reply.result);
if (out.kind === "refusal") console.log(out.code, out.detail, out.numbers);
if (out.kind === "unreachable") console.log("No reply, so no result:", out.detail);
```

With `CATALYST_Q_KEY` set (or `apiKey` passed), the same methods use the account routes, up to 256 qubits. Create a key at [/console/keys](https://catalyst-q.strategic-innovations.ai/console/keys).

## Methods that pick the route for you

| Method | With a key | Without a key | What you get |
|---|---|---|---|
| `run({qasm, measure?, shots?})` | `POST /api/v1/execute` | `POST /api/v1/try` | Full table of exact probabilities, up to 20 measured qubits |
| `sample({qasm, shots, seed?, measure?})` | `POST /api/v1/execute` | `POST /api/v1/try` | Real draws from the exact distribution, at any number of measured qubits |
| `probabilityOf({qasm, outcomes, measure?})` | `POST /api/v1/execute` | `POST /api/v1/try` | The probability of each bit string you name, classical bit 0 rightmost, up to 4096 |
| `score({qasm, counts, measure?})` | `POST /api/v1/score` | `POST /api/v1/try` | How counts from a device compare with the exact distribution |
| `expectationValues({qasm, observables?, tau?})` | `POST /api/v1/observables` | `POST /api/v1/try` | Each value with `exact` and an error `certificate` |
| `surfaceCode({distance, epsilon})` | `POST /api/v1/qec/coherent` | `POST /api/v1/try` | Logical channel of a surface code, distance 3 or 5 |

## Methods tied to one route

`execute`, `observables`, `qec.coherent`, `qec.threshold`, `jobs.create`, `jobs.list`, `usage`, `records.get`, `tryRun`, `health`.

## Refusals

A refusal is a normal result. The service looked at the job and said no, and it tells you why with numbers. Either catch `CatalystQError` and read `err.code`, `err.detail` and `err.numbers`, or wrap the call in `settle()`, which never throws for a service reply.

`settle()` gives one of three values:

| `kind` | Meaning |
|---|---|
| `answer` | `reply` holds the service's JSON |
| `refusal` | `status`, `code`, `detail`, `numbers`, `retryAfter` |
| `unreachable` | No usable reply arrived, so nothing can be said about the circuit |

## Options

```ts
const q = new CatalystQ({
  apiKey: "cq_live_...",   // default: process.env.CATALYST_Q_KEY; null sends no key
  baseUrl: "https://catalyst-q.strategic-innovations.ai",
  timeoutMs: 120_000,      // per request
  fetch: globalThis.fetch, // any fetch implementation
});
```

Keep the key in a secret store or an environment variable, never in source.

## License

MIT
