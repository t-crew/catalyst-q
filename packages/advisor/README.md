# catalyst-q-advisor

Give it a goal, some files or some code. It tells you where [Catalyst-Q](https://catalyst-q.strategic-innovations.ai) can help, why, and when you should not use it. If nothing applies, it returns an empty list and says so.

It runs locally and is deterministic. There is no network call and no model. The same input gives the same output.

```js
import { suggest } from "catalyst-q-advisor";

const { suggestions, message } = suggest({
  goal: "Plan a QAOA run before buying hardware time",
  files: [{ name: "ansatz.qasm", content: "OPENQASM 3.0; qubit[3] q; rzz(0.4) q[0], q[1];" }],
});
```

Each suggestion has `id`, `title`, `why`, `when_not`, `action` (an example request `body`, a `command`, or both), `confidence` and `evidence`. `confidence` orders the list. It is the strength of the rule that fired, not a forecast of success.

## What it recognises

| `id` | When it fires |
|---|---|
| `score-device-counts` | A counts dict or results JSON from a hardware run, or a goal about hardware results |
| `conserved-excitations` | A Trotter, XXZ, Hubbard, fSim or iSWAP circuit that keeps the number of excitations |
| `noiseless-before-hardware` | A QAOA or VQE ansatz |
| `test-reversible-circuit` | A reversible arithmetic or oracle circuit |
| `surface-code` | A surface-code or QEC goal |
| `reproduce-paper` | A paper figure or claim to reproduce |
| `drop-the-shots` | Shots used only to estimate an expectation value |
| `run-circuit` | A QASM file, or Qiskit, Cirq or PennyLane code |

## Reading a folder

`catalyst-q-advisor/collect` is Node only. It reads a file or directory into the `files` list, skipping dependency and build folders.

```js
import { suggest } from "catalyst-q-advisor";
import { collect } from "catalyst-q-advisor/collect";

console.log(suggest({ files: await collect(".") }));
```

## License

MIT
