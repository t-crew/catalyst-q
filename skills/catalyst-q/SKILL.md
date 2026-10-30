---
name: catalyst-q
description: Decide whether Catalyst-Q helps and call it. Use for quantum circuit verification, checking counts from quantum hardware, planning QAOA or VQE before buying device time, surface-code or QEC studies, reproducing a figure or claim from a quantum paper, and testing reversible or oracle circuits on chosen inputs. Not for ordinary small circuits a laptop can run, and not for predicting how a specific device behaves.
---

# Catalyst-Q

A hosted API that runs quantum circuits on classical hardware and returns exact answers, or refuses with the numbers. It is not a quantum computer.

## Run the advisor first

It is local and deterministic. It sends nothing anywhere. It says why each suggestion applies, when not to use it, and gives an example call. An empty list means leave Catalyst-Q out of this task.

```sh
npx catalyst-q suggest . --goal "what the person is trying to do"
```

With the MCP server connected, call `suggest_where_catalyst_q_helps` instead.

## Deciding

Use it when:

- Someone has counts from a device and the circuit that produced them.
- You need a noiseless value before paying for QAOA or VQE hardware time.
- Shots exist only to estimate an expectation value.
- A reversible or oracle circuit needs testing on chosen inputs at a width a laptop cannot hold.
- A paper's figure or claim needs checking from its circuit.
- A rotated surface code at distance 3 or 5 is being studied under a coherent error.

Do not use it when:

- The circuit is small. Qiskit on a laptop is simpler.
- The question is how a specific device behaves. This is classical and noiseless, and it knows only the counts you give it.
- The circuit must stay private. Replies usually carry a permalink to a public record that includes the circuit.
- You need thousands of parameter settings. The no-account route allows 6 calls a minute and 60 a day.

## Exact calls

No key is needed up to 64 qubits and 4,000 gates. Set `CATALYST_Q_KEY` for up to 256 qubits.

```sh
npx catalyst-q run circuit.qasm --measure 0,1        # every exact probability, up to 20 measured qubits
npx catalyst-q sample circuit.qasm --shots 1000      # real draws, any number of measured qubits
npx catalyst-q score circuit.qasm counts.json        # device counts against the exact distribution
```

Exit codes: 0 an answer, 10 a refusal, 1 no usable reply.

The HTTP route takes the same jobs:

```sh
curl -s https://catalyst-q.strategic-innovations.ai/api/v1/try \
  -H 'content-type: application/json' \
  -d '{"mode":"execute","qasm":"OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];","outcomes":["00","01"]}'
```

| Goal | Body |
|---|---|
| Every probability | `{mode:"execute", qasm, measure?}` |
| Draw shots | `{mode:"execute", qasm, sampling:"random", shots, seed?}` |
| Named outcomes, classical bit 0 rightmost | `{mode:"execute", qasm, outcomes:["0101"]}` |
| Score device counts | `{mode:"score", qasm, counts:{"0101":12}}` |
| Expectation values, circuit with no measurements | `{mode:"circuit", qasm, observables:[{pauli:"ZZ",qubits:[0,1]}]}` |
| Surface code | `{mode:"qec", distance:3, epsilon:0.05}` |

## Reading the reply

- A refusal is a result. Report its `error`, `detail` and numbers to the person. Do not retry it unchanged, and do not call it a failure of the tool.
- Say a value is exact only if the reply says so. Read `exact` and `certificate` on expectation values.
- If no usable reply arrives, say nothing was computed. Never fill the gap with an estimate of your own.
- Quote the `permalink` when there is one, so the person can check the record.
