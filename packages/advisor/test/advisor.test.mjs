import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggest, extractCounts } from "../src/index.mjs";
import { collect } from "../src/collect.mjs";

const ids = (result) => result.suggestions.map((s) => s.id);
const BELL = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nbit[2] c;\nh q[0];\ncx q[0], q[1];\nc = measure q;\n';

function assertSuggestionShape(s) {
	for (const key of ["id", "title", "why", "when_not"]) assert.equal(typeof s[key], "string", key);
	assert.ok(s.when_not.length > 20, "every suggestion says when not to use it");
	assert.ok(s.confidence > 0 && s.confidence <= 1);
	assert.ok(["api", "command"].includes(s.action.kind));
	assert.ok(s.action.body || s.action.command, "an action has a body or a command");
	assert.ok(s.evidence.length > 0);
}

// --- positive rules ---------------------------------------------------------------------------------------------

test("a QASM file suggests running it, and says a laptop can do it when small", () => {
	const out = suggest({ files: [{ name: "bell.qasm", content: BELL }] });
	assert.deepEqual(ids(out), ["run-circuit"]);
	const s = out.suggestions[0];
	assertSuggestionShape(s);
	assert.match(s.why, /2 qubits/);
	assert.match(s.why, /laptop/);
	assert.match(s.when_not, /laptop with Qiskit/);
	assert.equal(s.action.body.mode, "execute");
	assert.equal(s.action.body.qasm, BELL.trim());
	assert.equal(s.action.command, "npx catalyst-q run bell.qasm");
});

test("a wide circuit ranks higher than a small one and drops the laptop note", () => {
	const small = suggest({ files: [{ name: "a.qasm", content: BELL }] }).suggestions[0];
	const wide = suggest({ files: [{ name: "b.qasm", content: "OPENQASM 2.0; qreg q[40]; h q[0]; cx q[0],q[1];" }] }).suggestions[0];
	assert.ok(wide.confidence > small.confidence);
	assert.doesNotMatch(wide.why, /so a laptop can run it too/);
});

for (const [framework, code] of [
	["Qiskit", "from qiskit import QuantumCircuit\nqc = QuantumCircuit(2)\nqc.h(0)\n"],
	["Cirq", "import cirq\nq = cirq.LineQubit.range(2)\n"],
	["PennyLane", "import pennylane as qml\ndev = qml.device('default.qubit', wires=2)\n"],
]) {
	test(`${framework} code suggests exporting and running`, () => {
		const out = suggest({ code });
		assert.deepEqual(ids(out), ["run-circuit"]);
		assertSuggestionShape(out.suggestions[0]);
		assert.equal(out.suggestions[0].action.kind, "command");
		assert.match(out.suggestions[0].evidence[0], new RegExp(framework));
	});
}

test("a counts JSON file suggests scoring, with the counts in the example", () => {
	const out = suggest({ files: [{ name: "job_counts.json", content: JSON.stringify({ "00": 498, "11": 502 }) }] });
	assert.equal(out.suggestions[0].id, "score-device-counts");
	assertSuggestionShape(out.suggestions[0]);
	assert.deepEqual(out.suggestions[0].action.body.counts, { "00": 498, "11": 502 });
	assert.equal(out.suggestions[0].action.body.mode, "score");
	assert.match(out.suggestions[0].action.command, /score circuit\.qasm job_counts\.json/);
	assert.match(out.suggestions[0].when_not, /says nothing about a specific device/);
});

test("a nested results JSON with hex keys is understood", () => {
	const results = { results: [{ data: { counts: { "0x0": 10, "0x3": 22 } }, header: { memory_slots: 2 } }] };
	const out = suggest({ files: [{ name: "results.json", content: JSON.stringify(results) }] });
	assert.deepEqual(out.suggestions[0].action.body.counts, { "00": 10, "11": 22 });
});

test("a dict literal in pasted output counts as device counts in a quantum context", () => {
	const out = suggest({ code: "from qiskit import QuantumCircuit\nprint(job.result().get_counts())\n# {'00': 512, '11': 488}\n" });
	assert.ok(ids(out).includes("score-device-counts"));
});

test("a hardware results goal suggests scoring without any file", () => {
	const out = suggest({ goal: "I want to check my IBM quantum hardware results" });
	assert.equal(out.suggestions[0].id, "score-device-counts");
});

for (const [label, content] of [
	["iSWAP", "OPENQASM 3.0; qubit[8] q; x q[0]; x q[2]; iswap q[0], q[1]; iswap q[2], q[3]; rz(0.1) q[1]; cz q[1], q[2];"],
	["fSim", "OPENQASM 3.0; qubit[6] q; x q[1]; fsim(0.3, 0.1) q[1], q[2]; fsim(0.3, 0.1) q[2], q[3];"],
]) {
	test(`a ${label} circuit that keeps the excitation count is recognised from its gates`, () => {
		const out = suggest({ files: [{ name: "evolve.qasm", content }] });
		assert.equal(out.suggestions[0].id, "conserved-excitations");
		assertSuggestionShape(out.suggestions[0]);
		assert.equal(out.suggestions[0].action.body.sampling, "random");
		assert.ok(out.suggestions[0].confidence > 0.8);
		assert.match(out.suggestions[0].when_not, /Small systems/);
	});
}

test("a Hadamard in the middle stops the gate-level excitation rule", () => {
	const out = suggest({ files: [{ name: "broken.qasm", content: "OPENQASM 3.0; qubit[4] q; iswap q[0], q[1]; h q[1]; iswap q[1], q[2];" }] });
	const hit = out.suggestions.find((s) => s.id === "conserved-excitations");
	assert.ok(!hit || hit.confidence < 0.8, "only the name-based signal can remain");
});

for (const goal of ["Trotter evolution of an XXZ spin chain on 40 qubits", "Simulate the Fermi-Hubbard model on a quantum circuit"]) {
	test(`goal "${goal}" gets the excitation suggestion`, () => {
		assert.ok(ids(suggest({ goal })).includes("conserved-excitations"));
	});
}

for (const goal of ["Plan a QAOA run on 30 qubits", "Our VQE on H2 needs a baseline", "Is this variational ansatz worth running on a quantum device?"]) {
	test(`goal "${goal}" suggests the noiseless value first`, () => {
		const out = suggest({ goal });
		assert.equal(out.suggestions[0].id, "noiseless-before-hardware");
		assertSuggestionShape(out.suggestions[0]);
		assert.equal(out.suggestions[0].action.body.mode, "circuit");
		assert.match(out.suggestions[0].why, /hardware|device/);
	});
}

test("ansatz code suggests the noiseless value, with measurements stripped from the example", () => {
	const qasm = "// qaoa layer\nOPENQASM 3.0;\nqubit[3] q;\nbit[3] c;\nrzz(0.4) q[0], q[1];\nrx(0.2) q[0];\nc = measure q;\n";
	const out = suggest({ files: [{ name: "qaoa.qasm", content: qasm }] });
	const s = out.suggestions.find((x) => x.id === "noiseless-before-hardware");
	assert.ok(s);
	assert.doesNotMatch(s.action.body.qasm, /measure/);
	assert.doesNotMatch(s.action.body.qasm, /\bbit\[3\]/);
	assert.match(s.action.body.qasm, /qubit\[3\]/);
});

test("a reversible circuit is recognised from its gates", () => {
	const out = suggest({ files: [{ name: "adder.qasm", content: "OPENQASM 2.0; include \"qelib1.inc\"; qreg q[30]; creg c[30]; x q[0]; ccx q[0],q[1],q[2]; cx q[0],q[1]; measure q -> c;" }] });
	assert.equal(out.suggestions[0].id, "test-reversible-circuit");
	assertSuggestionShape(out.suggestions[0]);
	assert.ok(out.suggestions[0].action.body.outcomes);
	assert.match(out.suggestions[0].when_not, /inputs you pick/);
});

test("a quantum oracle goal gets the reversible test", () => {
	assert.ok(ids(suggest({ goal: "test my Grover oracle on chosen inputs, it is a quantum circuit" })).includes("test-reversible-circuit"));
});

for (const goal of ["Estimate the logical error rate of a surface code", "qec study at distance 5", "quantum error correction under coherent noise"]) {
	test(`goal "${goal}" gets the surface code suggestion`, () => {
		const out = suggest({ goal });
		assert.equal(out.suggestions[0].id, "surface-code");
		assertSuggestionShape(out.suggestions[0]);
		assert.deepEqual(out.suggestions[0].action.body, { mode: "qec", distance: 3, epsilon: 0.05 });
		assert.match(out.suggestions[0].when_not, /Stim/);
	});
}

for (const goal of ["Reproduce figure 3 of this quantum paper", "replicate the claim in arXiv:2401.01234 about qubits"]) {
	test(`goal "${goal}" gets the paper suggestion`, () => {
		const out = suggest({ goal });
		assert.equal(out.suggestions[0].id, "reproduce-paper");
		assertSuggestionShape(out.suggestions[0]);
		assert.match(out.suggestions[0].when_not, /noise/);
	});
}

test("shots used only for an expectation value are noticed in a goal", () => {
	const out = suggest({ goal: "I use 100000 shots to estimate an expectation value on a quantum circuit" });
	assert.equal(out.suggestions[0].id, "drop-the-shots");
	assertSuggestionShape(out.suggestions[0]);
	assert.equal(out.suggestions[0].action.body.mode, "circuit");
});

test("shots used only for an expectation value are noticed in code", () => {
	const out = suggest({ code: "from qiskit.primitives import Estimator\nimport qiskit\nresult = Estimator().run(qc, op, shots=100000).result()\n" });
	assert.ok(ids(out).includes("drop-the-shots"));
});

// --- ranking and determinism ------------------------------------------------------------------------------------

test("ranks by strength and is deterministic", () => {
	const input = { goal: "QAOA on quantum hardware, I have results", files: [{ name: "r.json", content: '{"counts":{"00":1,"11":2}}' }, { name: "c.qasm", content: BELL }] };
	const a = suggest(input);
	const b = suggest(input);
	assert.deepEqual(a, b);
	const confidences = a.suggestions.map((s) => s.confidence);
	assert.deepEqual(confidences, [...confidences].sort((x, y) => y - x));
	assert.equal(a.suggestions[0].id, "score-device-counts");
	assert.equal(a.suggestions.at(-1).id, "run-circuit");
});

// --- negatives: it must not pitch -------------------------------------------------------------------------------

const NOTHING = [
	["empty input", {}],
	["a todo app", { goal: "Build a todo app with login" }],
	["a circuit breaker", { goal: "Add a circuit breaker to the payment service and run it" }],
	["an electronics circuit", { goal: "simulate this resistor circuit in SPICE" }],
	["an Oracle database", { goal: "Migrate our Oracle database and test the oracle connection" }],
	["a person called Hubbard", { goal: "Email Mr Hubbard about the paper invoice" }],
	["a web bug report", { goal: "reproduce the bug in figure 3 of the support ticket" }],
	["a credit score", { goal: "score my device counts of visitors per page" }],
	["screenshots", { goal: "take shots and screenshots of the expectation page" }],
	["a word-count JSON", { files: [{ name: "words.json", content: '{"hello": 3, "world": 4}' }] }],
	["an analytics JSON", { files: [{ name: "results.json", content: '{"counts": {"home": 3, "pricing": 4}}' }] }],
	["a numbered JSON", { files: [{ name: "data.json", content: '{"0": 5, "1": 7}' }] }],
	["a plain script", { code: "import requests\nprint(requests.get('https://example.com').status_code)\n" }],
];

for (const [label, input] of NOTHING) {
	test(`nothing to suggest for ${label}`, () => {
		const out = suggest(input);
		assert.deepEqual(out.suggestions, []);
		assert.match(out.message, /nothing to suggest|Tell me what/i);
		assert.doesNotMatch(out.message, /\btry it\b|sign up|\bfree\b/i);
	});
}

test("a plain web app repo yields nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "advisor-"));
	try {
		await mkdir(join(dir, "src"));
		await mkdir(join(dir, "node_modules", "cirq-lookalike"), { recursive: true });
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "shop", dependencies: { react: "^19.0.0" }, scripts: { test: "vitest" } }));
		await writeFile(join(dir, "README.md"), "# Shop\n\nA web shop. Run `npm start`. See the figure in the design paper.\n");
		await writeFile(join(dir, "src", "App.tsx"), "export default function App() { return <h1>Shop</h1>; }\n");
		await writeFile(join(dir, "src", "stats.json"), '{"counts":{"page":1}}');
		await writeFile(join(dir, "node_modules", "cirq-lookalike", "index.py"), "import cirq\n");
		const out = suggest({ files: await collect(dir) });
		assert.deepEqual(out.suggestions, []);
		assert.match(out.message, /nothing to suggest/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a quantum project on disk is read, notebook included", async () => {
	const dir = await mkdtemp(join(tmpdir(), "advisor-"));
	try {
		await writeFile(join(dir, "bell.qasm"), BELL);
		await writeFile(join(dir, "study.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: ["from qiskit import QuantumCircuit\n"], outputs: [{ text: ["{'00': 512, '11': 488}\n"] }] }] }));
		const files = await collect(dir);
		assert.deepEqual(files.map((f) => f.name).sort(), ["bell.qasm", "study.ipynb"]);
		const out = suggest({ files });
		assert.ok(ids(out).includes("run-circuit"));
		assert.ok(ids(out).includes("score-device-counts"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// --- extractCounts ----------------------------------------------------------------------------------------------

test("extractCounts reads the shapes people actually have", () => {
	assert.deepEqual(extractCounts('{"00": 1, "11": 2}'), { "00": 1, "11": 2 });
	assert.deepEqual(extractCounts('{"counts": {"01": 3}}'), { "01": 3 });
	assert.deepEqual(extractCounts("{'00': 512, '11': 488}"), { "00": 512, "11": 488 });
	assert.deepEqual(extractCounts('[{"results":[{"data":{"counts":{"0x1":4}},"header":{"memory_slots":3}}]}]'), { "001": 4 });
	assert.deepEqual(extractCounts('{"00 1": 4}'), { "001": 4 });
});

test("extractCounts returns null when there are no counts", () => {
	assert.equal(extractCounts('{"hello": 3}'), null);
	assert.equal(extractCounts("not json at all"), null);
	assert.equal(extractCounts('{"00": 1, "111": 2}'), null, "mixed widths");
	assert.equal(extractCounts('{"00": -1}'), null, "negative counts");
	assert.equal(extractCounts(42), null);
});
