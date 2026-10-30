// The advisor: given a goal, some files or some code, say where Catalyst-Q can help and when it should not be used.
// Deterministic and local. Same input, same output. No network, no model. This file also runs in the browser.

const API_TRY = "POST /api/v1/try";
const EXAMPLE_QASM = "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];";
const MAX_INLINE_QASM = 4000;
const MAX_SCAN = 256 * 1024;
/** At or under this width, a laptop handles the circuit with ordinary tools, and the advice says so. */
const LAPTOP_SIZED_QUBITS = 20;

const QUANTUM_CONTEXT = /\b(qubits?|quantum|qasm|openqasm|qiskit|cirq|pennylane|hadamard|cnot|toffoli|bell state|ghz|qpu|ionq|quantinuum|rigetti|braket|ansatz|qaoa|vqe|trotter\w*|surface[- ]code|xeb)\b/i;

const CONSERVING_GATES = new Set(["iswap", "iswapdg", "fsim", "phasedfsim", "xx_plus_yy", "givens", "swap", "cz", "cp", "cu1", "crz", "rzz", "z", "s", "sdg", "t", "tdg", "p", "u1", "rz", "id", "barrier", "measure"]);
const EXCITATION_MOVING_GATES = new Set(["iswap", "iswapdg", "fsim", "phasedfsim", "xx_plus_yy", "givens"]);
const REVERSIBLE_GATES = new Set(["x", "cx", "cnot", "ccx", "toffoli", "cswap", "fredkin", "swap", "c3x", "c4x", "mcx", "id", "barrier", "measure"]);
const MULTI_CONTROL_GATES = new Set(["ccx", "toffoli", "cswap", "fredkin", "c3x", "c4x", "mcx"]);
const NOT_GATES = new Set(["openqasm", "include", "qreg", "creg", "qubit", "bit", "gate", "def", "if", "for", "while", "reset", "input", "output", "const", "let", "opaque"]);

// ---------------------------------------------------------------------------------------------------------------
// Reading the input
// ---------------------------------------------------------------------------------------------------------------

function readQasm(text) {
	const clean = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
	let qubits = 0;
	const gates = [];
	for (const raw of clean.split(";")) {
		const stmt = raw.trim();
		if (!stmt) continue;
		const reg = /^qreg\s+\w+\s*\[\s*(\d+)\s*\]/.exec(stmt) || /^qubit\s*\[\s*(\d+)\s*\]/.exec(stmt);
		if (reg) { qubits += Number(reg[1]); continue; }
		if (/^qubit\s+\w+/.test(stmt)) { qubits += 1; continue; }
		const assign = /=\s*measure\b/.test(stmt);
		const name = assign ? "measure" : (/^([A-Za-z_]\w*)/.exec(stmt)?.[1] ?? "").toLowerCase();
		if (name && !NOT_GATES.has(name)) gates.push(name);
	}
	return { qubits, gates };
}

function looksLikeQasm(file) {
	return /\.qasm$/i.test(file.name ?? "") || /^\s*OPENQASM\s+[23]/m.test(file.text);
}

const BITS = /^[01]+$/;

function normaliseBinary(counts) {
	const keys = Object.keys(counts);
	if (!keys.length) return null;
	const out = {};
	let width = -1;
	for (const key of keys) {
		const bits = key.replace(/\s+/g, "");
		const value = counts[key];
		if (!BITS.test(bits) || typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
		if (width !== -1 && bits.length !== width) return null;
		width = bits.length;
		out[bits] = (out[bits] ?? 0) + value;
	}
	return { counts: out, width };
}

function normaliseHex(counts, slots) {
	const keys = Object.keys(counts);
	if (!keys.length || !keys.every((k) => /^0x[0-9a-f]+$/i.test(k))) return null;
	const width = Number.isInteger(slots) && slots > 0 ? slots : Math.max(...keys.map((k) => BigInt(k).toString(2).length));
	const out = {};
	for (const key of keys) {
		const value = counts[key];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
		out[BigInt(key).toString(2).padStart(width, "0")] = value;
	}
	return { counts: out, width };
}

function findCounts(node, depth, slots) {
	if (!node || typeof node !== "object" || depth > 8) return null;
	if (Array.isArray(node)) {
		for (const item of node) {
			const hit = findCounts(item, depth + 1, slots);
			if (hit) return hit;
		}
		return null;
	}
	const hereSlots = node.header?.memory_slots ?? slots;
	if (node.counts && typeof node.counts === "object") {
		const named = normaliseBinary(node.counts) ?? normaliseHex(node.counts, hereSlots);
		if (named) return { ...named, named: true };
	}
	const direct = normaliseBinary(node);
	if (direct) return { ...direct, named: false };
	for (const value of Object.values(node)) {
		const hit = findCounts(value, depth + 1, hereSlots);
		if (hit) return hit;
	}
	return null;
}

function parseCounts(text) {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return findCounts(JSON.parse(trimmed), 0, undefined);
		} catch {
			// Not JSON. Fall through to the dictionary literal below.
		}
	}
	// A dict literal in Python or printed output: {'00': 512, '11': 488}
	const literal = /\{\s*(?:['"][01 ]+['"]\s*:\s*\d+\s*,?\s*)+\}/.exec(text);
	if (!literal) return null;
	try {
		return { ...normaliseBinary(JSON.parse(literal[0].replace(/'/g, '"').replace(/,\s*\}/, "}"))), named: false };
	} catch {
		return null;
	}
}

/** Reads a counts object out of pasted text or a results file, or null when there is none. */
export function extractCounts(text, { allowSingleBit = true } = {}) {
	if (typeof text !== "string") return null;
	const hit = parseCounts(text.slice(0, MAX_SCAN));
	if (!hit || !hit.counts) return null;
	if (hit.width === 1 && !hit.named && !allowSingleBit) return null;
	return hit.counts;
}

function readInput(input) {
	const goal = typeof input.goal === "string" ? input.goal.slice(0, MAX_SCAN) : "";
	const sources = [];
	for (const file of Array.isArray(input.files) ? input.files : []) {
		if (!file || typeof file.name !== "string") continue;
		sources.push({ name: file.name, text: typeof file.content === "string" ? file.content.slice(0, MAX_SCAN) : "" });
	}
	if (typeof input.code === "string" && input.code.trim()) sources.push({ name: "the code you pasted", text: input.code.slice(0, MAX_SCAN), pasted: true });

	const qasm = [];
	const frameworks = [];
	const countSources = [];
	let quantumContext = QUANTUM_CONTEXT.test(goal);

	for (const source of sources) {
		const isQasm = looksLikeQasm(source);
		if (QUANTUM_CONTEXT.test(source.text) || isQasm) quantumContext = true;
		if (isQasm) qasm.push({ ...source, ...readQasm(source.text) });
		if (/^\s*(from|import)\s+qiskit\b/m.test(source.text)) frameworks.push({ source, framework: "Qiskit" });
		if (/^\s*(from|import)\s+cirq\b/m.test(source.text)) frameworks.push({ source, framework: "Cirq" });
		if (/^\s*(from|import)\s+pennylane\b/m.test(source.text)) frameworks.push({ source, framework: "PennyLane" });
	}
	for (const source of sources) {
		if (looksLikeQasm(source)) continue;
		const hit = parseCounts(source.text);
		if (!hit || !hit.counts) continue;
		const onlySingleBit = hit.width === 1 && !hit.named;
		const hintedByName = /(count|result|shots|histogram|job)/i.test(source.name);
		if (onlySingleBit && !(quantumContext && hintedByName)) continue;
		if (hit.width < 2 && !hit.named && !quantumContext) continue;
		countSources.push({ source, counts: hit.counts });
	}
	return { goal, sources, qasm, frameworks, countSources, quantumContext };
}

function textHit(signals, pattern, { needsContext = true } = {}) {
	const evidence = [];
	if (!needsContext || signals.quantumContext) {
		const goalMatch = pattern.exec(signals.goal);
		if (goalMatch) evidence.push({ where: "goal", label: `your goal mentions "${goalMatch[0].toLowerCase()}"` });
		for (const source of signals.sources) {
			const match = pattern.exec(source.text);
			if (match) evidence.push({ where: "source", label: `${source.name} mentions "${match[0].toLowerCase()}"` });
		}
	}
	return evidence;
}

function firstQasmBody(signals, { unitaryOnly = false } = {}) {
	const first = signals.qasm[0];
	if (!first || !first.text.trim()) return EXAMPLE_QASM;
	if (first.text.length > MAX_INLINE_QASM) return `<contents of ${first.name}>`;
	const text = first.text.trim();
	if (!unitaryOnly) return text;
	return text.split(";").filter((part) => !/\bmeasure\b/.test(part) && !/^\s*(creg|bit)\b/.test(part.replace(/\/\/[^\n]*\n/g, ""))).join(";").trim() + ";";
}

const fileArg = (signals) => (signals.qasm[0] && !signals.qasm[0].pasted ? signals.qasm[0].name : "circuit.qasm");

function sizeNote(signals) {
	const first = signals.qasm[0];
	if (!first || !first.qubits) return "";
	return first.qubits <= LAPTOP_SIZED_QUBITS ? ` This one has ${first.qubits} qubit${first.qubits === 1 ? "" : "s"}, so a laptop can run it too.` : "";
}

const CLASSICAL = "This is classical simulation. It says nothing about a specific device beyond the counts you give it.";

// ---------------------------------------------------------------------------------------------------------------
// Rules. Each returns null, or { confidence, evidence } plus the text of the suggestion.
// ---------------------------------------------------------------------------------------------------------------

const RULES = [
	{
		id: "score-device-counts",
		match(signals) {
			if (signals.countSources.length) {
				return { confidence: 0.92, evidence: signals.countSources.map((c) => `${c.source.name} holds counts over ${Object.keys(c.counts).length} outcome${Object.keys(c.counts).length === 1 ? "" : "s"}`) };
			}
			const device = /\b(hardware|device|qpu|ibm|ionq|quantinuum|rigetti|braket|real machine)\b/i.exec(signals.goal);
			const output = /\b(results?|counts?|shots|output|job|run|histogram|bitstrings?)\b/i.exec(signals.goal);
			if (device && output && signals.quantumContext) return { confidence: 0.7, evidence: [`your goal mentions "${device[0].toLowerCase()}" and "${output[0].toLowerCase()}"`] };
			if (/\b(score|xeb|cross[- ]entropy)\b/i.test(signals.goal) && /\bcounts?\b/i.test(signals.goal) && signals.quantumContext) return { confidence: 0.7, evidence: ["your goal asks to score counts"] };
			return null;
		},
		build(signals) {
			const counts = signals.countSources[0]?.counts ?? { "00": 512, "11": 488 };
			const countsFile = signals.countSources[0]?.source.pasted === false || signals.countSources[0]?.source.name && !signals.countSources[0]?.source.pasted ? signals.countSources[0].source.name : "counts.json";
			return {
				title: "Score your device counts against the exact distribution",
				why: "Send the circuit with the counts you measured. You get a cross-entropy score with its standard error, how many shots landed on outcomes the circuit can never produce and, at small widths, total variation and Hellinger fidelity. It works without an account.",
				when_not: `It needs the circuit that produced the counts; without it there is nothing to compare. ${CLASSICAL}`,
				action: { kind: "api", route: API_TRY, body: { mode: "score", qasm: firstQasmBody(signals), counts }, command: `npx catalyst-q score ${fileArg(signals)} ${countsFile}` },
			};
		},
	},
	{
		id: "conserved-excitations",
		match(signals) {
			const evidence = [];
			let strong = false;
			for (const q of signals.qasm) {
				const moving = q.gates.filter((g) => EXCITATION_MOVING_GATES.has(g));
				const firstTwoQubit = q.gates.findIndex((g) => g !== "x");
				const rest = firstTwoQubit < 0 ? [] : q.gates.slice(firstTwoQubit);
				if (moving.length && rest.every((g) => CONSERVING_GATES.has(g))) {
					strong = true;
					evidence.push(`every gate in ${q.name} after state preparation keeps the number of excitations (${[...new Set(moving)].join(", ")})`);
				}
			}
			const named = textHit(signals, /\b(xxz|fermi[- ]hubbard|hubbard|heisenberg|fsim|iswap|givens rotation|excitation[- ](?:number|preserving|conserving)|number[- ]conserving|particle[- ]conserving)\b/i);
			const trotter = textHit(signals, /\btrotter\w*\b/i).filter((t) => /\b(hamiltonian|xx|xy|zz|hopping|spin chain|lattice)\b/i.test(signals.goal + " " + signals.sources.map((s) => s.text).join(" ")));
			evidence.push(...named.map((e) => e.label), ...trotter.map((e) => e.label));
			if (!evidence.length) return null;
			return { confidence: strong ? 0.86 : 0.62, evidence };
		},
		build(signals) {
			return {
				title: "Draw shots from a circuit that keeps the number of excitations",
				why: "Trotter, XXZ, Hubbard, fSim and iSWAP circuits keep the number of excitations fixed. Ask for real draws from the exact distribution at any number of measured qubits. The reply reports qubits_held and, when one applies, outcome_law: the dimension and constraints every outcome obeys. If the circuit does not stay in reach, you get a refusal with the numbers.",
				when_not: `One gate that changes the count, such as a stray Hadamard or an X rotation, removes the reason to pick this route. Small systems run fine on a laptop with Qiskit. ${CLASSICAL}`,
				action: { kind: "api", route: API_TRY, body: { mode: "execute", qasm: firstQasmBody(signals), sampling: "random", shots: 1000, seed: 1 }, command: `npx catalyst-q sample ${fileArg(signals)} --shots 1000 --seed 1` },
			};
		},
	},
	{
		id: "noiseless-before-hardware",
		match(signals) {
			const evidence = [
				...textHit(signals, /\b(qaoa|vqe)\b/i, { needsContext: false }),
				...textHit(signals, /\b(ansatz|variational (?:circuit|algorithm|eigensolver)|efficientsu2|twolocal|realamplitudes|uccsd|qaoaansatz|max[- ]?cut)\b/i),
			];
			if (!evidence.length) return null;
			return { confidence: evidence.some((e) => e.where === "source") ? 0.84 : 0.72, evidence: evidence.map((e) => e.label) };
		},
		build(signals) {
			return {
				title: "Compute the noiseless value before you buy hardware time",
				why: "A QAOA or VQE run on a device is chasing a number. Get that number first: the expectation value at your chosen parameters, with exact and certificate fields on the reply. Then you know what a good device result would look like, and whether these parameters are worth paying for.",
				when_not: `Each call is one circuit at one set of parameters, and the no-account route allows 6 calls a minute, so it does not suit a long optimiser loop. Small ansatzes run fine on a laptop with Qiskit or PennyLane. A noiseless value does not predict what noise will do. ${CLASSICAL}`,
				action: { kind: "api", route: API_TRY, body: { mode: "circuit", qasm: firstQasmBody(signals, { unitaryOnly: true }), observables: [{ pauli: "ZZ", qubits: [0, 1] }] }, command: "Fill in your parameter values first. The API takes bound circuits." },
			};
		},
	},
	{
		id: "test-reversible-circuit",
		match(signals) {
			const evidence = [];
			let strong = false;
			for (const q of signals.qasm) {
				if (q.gates.length && q.gates.every((g) => REVERSIBLE_GATES.has(g)) && q.gates.some((g) => MULTI_CONTROL_GATES.has(g))) {
					strong = true;
					evidence.push(`${q.name} uses only reversible classical gates (${[...new Set(q.gates.filter((g) => g !== "measure" && g !== "barrier"))].join(", ")})`);
				}
			}
			const named = textHit(signals, /\b(ripple[- ]carry|cuccaro|quantum adder|reversible (?:adder|circuit|arithmetic|logic)|modular (?:addition|multiplication|exponentiation)|comparator circuit|grover oracle|phase oracle|boolean oracle|oracle circuit|oracle)\b/i);
			evidence.push(...named.map((e) => e.label));
			if (!evidence.length) return null;
			return { confidence: strong ? 0.85 : 0.64, evidence };
		},
		build(signals) {
			return {
				title: "Test your reversible circuit on inputs you choose",
				why: "Set the input bits with X gates, name the output you expect, and ask for its probability. A correct circuit gives probability 1 on that output. Any other answer points at a bug, and you can repeat it across the inputs you care about at any number of measured qubits.",
				when_not: `It checks the inputs you pick, not every input. A small adder is just as easy to check on a laptop. If you want to know how a device runs the circuit, this will not tell you. ${CLASSICAL}`,
				action: { kind: "api", route: API_TRY, body: { mode: "execute", qasm: firstQasmBody(signals), outcomes: ["<the output you expect, classical bit 0 rightmost>"] } },
			};
		},
	},
	{
		id: "surface-code",
		match(signals) {
			const evidence = [
				...textHit(signals, /\b(surface[- ]codes?|logical error rate|qec)\b/i, { needsContext: false }),
				...textHit(signals, /\b(quantum error correction|error[- ]correcting code|error correction|stabili[sz]er code|syndrome)\b/i),
			];
			if (!evidence.length) return null;
			return { confidence: evidence.some((e) => /surface|qec/.test(e.label)) ? 0.8 : 0.6, evidence: evidence.map((e) => e.label) };
		},
		build() {
			return {
				title: "Compute a surface code's logical channel under a coherent error",
				why: "Give a distance of 3 or 5 and a rotation error epsilon. You get the logical channel of a rotated surface code back, coherent and twirled, so you can see how far the usual noise approximation is from the coherent answer. With a key there is also a threshold sweep under code-capacity or phenomenological noise.",
				when_not: `Other codes, larger distances and circuit-level noise are outside these routes; Stim is the usual tool for those. ${CLASSICAL}`,
				action: { kind: "api", route: API_TRY, body: { mode: "qec", distance: 3, epsilon: 0.05 } },
			};
		},
	},
	{
		id: "reproduce-paper",
		match(signals) {
			if (!signals.quantumContext) return null;
			const evidence = [];
			const all = [{ label: "your goal", text: signals.goal }, ...signals.sources.map((s) => ({ label: s.name, text: s.text }))];
			for (const { label, text } of all) {
				const verb = /\b(reproduc\w*|replicat\w*)\b/i.exec(text);
				const noun = /\b(figure|fig\.|paper|arxiv|claim|published|preprint)\b/i.exec(text);
				if (verb && noun) evidence.push(`${label} says "${verb[0].toLowerCase()}" and "${noun[0].toLowerCase()}"`);
				const arxiv = /\barxiv[: ]\s*\d{4}\.\d{4,5}\b/i.exec(text);
				if (arxiv && !verb) evidence.push(`${label} cites ${arxiv[0]}`);
			}
			if (!evidence.length) return null;
			return { confidence: 0.75, evidence };
		},
		build(signals) {
			return {
				title: "Reproduce a paper's figure or claim from its circuit",
				why: "Write the paper's circuit in OpenQASM and run it. You get exact values to set against the printed figure, and most replies carry a permalink to a stored record you can cite. A refusal is useful as well: it tells you with numbers that this exact computation is out of reach here.",
				when_not: `A figure that depends on a device's noise cannot be reproduced this way, because the values returned are noiseless. Small circuits are just as easy to check on a laptop with Qiskit. ${CLASSICAL}`,
				action: { kind: "api", route: API_TRY, body: { mode: "execute", qasm: firstQasmBody(signals) }, command: `npx catalyst-q run ${fileArg(signals)}` },
			};
		},
	},
	{
		id: "drop-the-shots",
		match(signals) {
			const evidence = [];
			const expectation = /\b(expectation values?|expval|estimator|mean z|<\s*z\s*>|⟨\s*z\s*⟩|pauli expectation)\b/i;
			const shots = /\b(shots|repetitions|sampling)\b/i;
			if (signals.quantumContext && expectation.test(signals.goal) && shots.test(signals.goal)) evidence.push("your goal estimates an expectation value from shots");
			for (const source of signals.sources) {
				if (looksLikeQasm(source)) continue;
				if (expectation.test(source.text) && /\b(shots|repetitions)\s*=/.test(source.text) && QUANTUM_CONTEXT.test(source.text)) evidence.push(`${source.name} sets a shot count and computes an expectation value`);
			}
			if (!evidence.length) return null;
			return { confidence: 0.78, evidence };
		},
		build(signals) {
			return {
				title: "Ask for the expectation value directly, without shots",
				why: "If shots are only there to estimate an expectation value, you can ask for the value itself. It comes back with exact and certificate fields, and no shot noise to average away.",
				when_not: `Keep the shots if you are studying shot noise on purpose or need samples for something else. Small circuits give the same value in a laptop simulator. ${CLASSICAL}`,
				action: { kind: "api", route: API_TRY, body: { mode: "circuit", qasm: firstQasmBody(signals, { unitaryOnly: true }), observables: [{ type: "mean_z" }] } },
			};
		},
	},
	{
		id: "run-circuit",
		match(signals) {
			const evidence = [];
			for (const q of signals.qasm) evidence.push(`${q.name} is an OpenQASM circuit${q.qubits ? ` with ${q.qubits} qubit${q.qubits === 1 ? "" : "s"}` : ""}`);
			for (const f of signals.frameworks) evidence.push(`${f.source.name} uses ${f.framework}`);
			const goal = /\b(run|simulate|verify|check|test|execute)\b[^.?!]{0,60}\bcircuits?\b/i.exec(signals.goal);
			if (goal && signals.quantumContext) evidence.push("your goal is to run or check a quantum circuit");
			if (!evidence.length) return null;
			const wide = signals.qasm.some((q) => q.qubits > LAPTOP_SIZED_QUBITS);
			const small = signals.qasm.length > 0 && !wide;
			return { confidence: wide ? 0.58 : small ? 0.3 : 0.42, evidence };
		},
		build(signals) {
			const hasQasm = signals.qasm.length > 0;
			return {
				title: "Run this circuit and get exact answers",
				why: `You get the full table of exact probabilities, up to 20 measured qubits, or a refusal with the numbers. No account is needed up to 64 qubits and 4,000 gates.${sizeNote(signals)}`,
				when_not: `Ordinary small circuits run fine on a laptop with Qiskit, and you do not need this for them. ${CLASSICAL}`,
				action: hasQasm
					? { kind: "api", route: API_TRY, body: { mode: "execute", qasm: firstQasmBody(signals) }, command: `npx catalyst-q run ${fileArg(signals)}` }
					: { kind: "command", command: "Export your circuit to OpenQASM first (in Qiskit: qiskit.qasm3.dumps(circuit)), then run: npx catalyst-q run circuit.qasm" },
			};
		},
	},
];

// ---------------------------------------------------------------------------------------------------------------
// suggest
// ---------------------------------------------------------------------------------------------------------------

export function suggest(input = {}) {
	const signals = readInput(input ?? {});
	const hasInput = signals.goal.trim() !== "" || signals.sources.length > 0;
	const suggestions = [];
	RULES.forEach((rule, order) => {
		const hit = rule.match(signals);
		if (!hit) return;
		const evidence = hit.evidence.map((e) => (typeof e === "string" ? e : e.label));
		suggestions.push({ order, suggestion: { id: rule.id, ...rule.build(signals), confidence: hit.confidence, evidence: [...new Set(evidence)] } });
	});
	suggestions.sort((a, b) => b.suggestion.confidence - a.suggestion.confidence || a.order - b.order);
	const list = suggestions.map((s) => s.suggestion);
	let message;
	if (!hasInput) message = "Tell me what you are trying to do, or give me a file.";
	else if (!list.length) message = "Nothing here looks like a job for Catalyst-Q, so there is nothing to suggest. It runs quantum circuits and scores results from quantum hardware.";
	else message = `${list.length === 1 ? "One place" : `${list.length} places`} Catalyst-Q could help. Each one says when not to use it.`;
	return { suggestions: list, message };
}
