// The tools this server offers. The descriptions are written for an agent deciding whether to reach for one.
import { settle } from "catalyst-q";
import { suggest } from "catalyst-q-advisor";

const QASM = {
	type: "string",
	description: "OpenQASM 2 or 3 source text of the circuit. Bound parameters only.",
	minLength: 1,
};
const MEASURE = {
	type: "array",
	items: { type: "integer", minimum: 0 },
	description: "Which qubits to read, when the source has no measurements.",
};

const PRIVACY = "Replies usually carry a permalink to a public record that includes the circuit, so do not send a circuit that must stay private.";

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

function need(args, checks) {
	for (const [field, ok, message] of checks) {
		if (!ok(args[field])) return `${field}: ${message}`;
	}
	return null;
}
const text = (value) => typeof value === "string" && value.trim() !== "";
const positiveInt = (value) => Number.isInteger(value) && value > 0;
const optional = (check) => (value) => value === undefined || check(value);
const qubitList = (value) => Array.isArray(value) && value.every((q) => Number.isInteger(q) && q >= 0);

export const TOOLS = [
	{
		name: "suggest_where_catalyst_q_helps",
		title: "Where can Catalyst-Q help?",
		description: "Reach for this first when a task touches quantum circuits and you are unsure whether Catalyst-Q applies. It reads a goal, code or files locally and returns ranked suggestions, each with why, when not to use it, and an example call. Nothing leaves the machine. It returns an empty list when nothing applies; in that case, do not use the other tools here.",
		annotations: { readOnlyHint: true, openWorldHint: false },
		inputSchema: {
			type: "object",
			properties: {
				goal: { type: "string", description: "What the person is trying to do, in their words." },
				code: { type: "string", description: "Source code or pasted output." },
				files: {
					type: "array",
					description: "Files to look at, by name and content.",
					items: { type: "object", properties: { name: { type: "string" }, content: { type: "string" } }, required: ["name"] },
				},
			},
		},
		check: () => null,
		async run(_client, args) {
			const out = suggest({ goal: args.goal, code: args.code, files: args.files });
			return { kind: "local", value: out, summary: out.message };
		},
	},
	{
		name: "run_circuit",
		title: "Run a circuit, get exact probabilities",
		description: `Use when you need the exact probability of every outcome of a quantum circuit, up to 20 measured qubits: checking that a circuit does what you think, or getting ground truth to compare against. Do not use it for an ordinary small circuit you could run locally with Qiskit, or to learn how a specific device behaves; this is classical and noiseless. Above 20 measured qubits use sample_shots or probability_of_outcomes. A refusal is a normal result that explains why, with numbers. ${PRIVACY}`,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object",
			properties: {
				qasm: QASM,
				measure: MEASURE,
				shots: { type: "integer", minimum: 1, description: "If set, the reply also has counts: the exact probabilities scaled to this number and rounded." },
			},
			required: ["qasm"],
		},
		check: (a) => need(a, [["qasm", text, "OpenQASM source is required"], ["measure", optional(qubitList), "a list of qubit indices"], ["shots", optional(positiveInt), "a positive integer"]]),
		run: (client, a) => client.run({ qasm: a.qasm, measure: a.measure, shots: a.shots }),
	},
	{
		name: "sample_shots",
		title: "Draw shots from the exact distribution",
		description: `Use when you need real samples from a circuit's exact distribution, at any number of measured qubits, for example to feed a downstream pipeline or to see a wide circuit's outcomes. Pass a seed to repeat the draw. Do not use it to estimate an expectation value (use expectation_values, which has no shot noise) or to mimic a noisy device. A refusal is a normal result that explains why, with numbers. ${PRIVACY}`,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		inputSchema: {
			type: "object",
			properties: {
				qasm: QASM,
				shots: { type: "integer", minimum: 1, description: "How many draws." },
				seed: { type: "integer", description: "Fixes the draws." },
				measure: MEASURE,
			},
			required: ["qasm", "shots"],
		},
		check: (a) => need(a, [["qasm", text, "OpenQASM source is required"], ["shots", positiveInt, "a positive integer is required"], ["seed", optional(Number.isInteger), "an integer"], ["measure", optional(qubitList), "a list of qubit indices"]]),
		run: (client, a) => client.sample({ qasm: a.qasm, shots: a.shots, seed: a.seed, measure: a.measure }),
	},
	{
		name: "probability_of_outcomes",
		title: "Probability of specific outcomes",
		description: `Use when you know which bit strings you care about and want their exact probabilities, at any number of measured qubits, up to 4096 outcomes per call. It suits testing a reversible or oracle circuit: set inputs with X gates, name the expected output, and expect probability 1. Classical bit 0 is the rightmost character. Do not use it when you need the whole distribution of a small circuit (use run_circuit). A refusal is a normal result that explains why, with numbers. ${PRIVACY}`,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object",
			properties: {
				qasm: QASM,
				outcomes: { type: "array", items: { type: "string", pattern: "^[01]+$" }, minItems: 1, maxItems: 4096, description: "Bit strings, classical bit 0 rightmost." },
				measure: MEASURE,
			},
			required: ["qasm", "outcomes"],
		},
		check: (a) => need(a, [["qasm", text, "OpenQASM source is required"], ["outcomes", (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && /^[01]+$/.test(s)), "a non-empty list of bit strings is required"], ["measure", optional(qubitList), "a list of qubit indices"]]),
		run: (client, a) => client.probabilityOf({ qasm: a.qasm, outcomes: a.outcomes, measure: a.measure }),
	},
	{
		name: "score_device_counts",
		title: "Score counts from a device",
		description: `Use when someone has counts from a real quantum device and the circuit that produced them, and wants to know how close the device came to the exact distribution. The reply has a cross-entropy score with its standard error, the number of shots on impossible outcomes, and at small widths total variation and Hellinger fidelity. Do not use it without the original circuit. It describes only the counts given to it, not the device in general. A refusal is a normal result that explains why, with numbers. ${PRIVACY}`,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object",
			properties: {
				qasm: QASM,
				counts: { type: "object", additionalProperties: { type: "number", minimum: 0 }, description: 'Bit string to times seen, for example {"0101": 12}. Classical bit 0 rightmost.' },
				measure: MEASURE,
			},
			required: ["qasm", "counts"],
		},
		check: (a) => need(a, [["qasm", text, "OpenQASM source is required"], ["counts", (v) => asObject(v) && Object.keys(v).length > 0, "an object of bit string to count is required"], ["measure", optional(qubitList), "a list of qubit indices"]]),
		run: (client, a) => client.score({ qasm: a.qasm, counts: a.counts, measure: a.measure }),
	},
	{
		name: "expectation_values",
		title: "Exact expectation values",
		description: `Use when you want an expectation value without shot noise: the noiseless value of a QAOA or VQE circuit before paying for hardware time, or as a replacement for many shots spent averaging. Each value comes with exact and certificate fields; read them. Send a unitary circuit with no measurements. Do not use it for a long optimiser loop on the no-account route (6 calls a minute), or to predict what noise will do. A refusal is a normal result that explains why, with numbers. ${PRIVACY}`,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object",
			properties: {
				qasm: QASM,
				observables: {
					type: "array",
					description: 'For example [{"pauli": "ZZ", "qubits": [0, 1]}] or [{"type": "mean_z"}].',
					items: { type: "object", properties: { pauli: { type: "string" }, qubits: { type: "array", items: { type: "integer", minimum: 0 } }, type: { type: "string" } } },
				},
				tau: { type: "number", minimum: 0, description: "Tolerance on the value." },
			},
			required: ["qasm"],
		},
		check: (a) => need(a, [["qasm", text, "OpenQASM source is required"], ["observables", optional(Array.isArray), "a list of observables"], ["tau", optional((v) => typeof v === "number" && v >= 0), "a non-negative number"]]),
		run: (client, a) => client.expectationValues({ qasm: a.qasm, observables: a.observables, tau: a.tau }),
	},
];

/** Runs a tool. Answers and refusals are normal results. isError is kept for bad input and for no reply at all. */
export async function callTool(tool, client, args) {
	const problem = tool.check(args);
	if (problem) return failure(`Bad input. ${problem}`);
	const started = tool.run(client, args);
	if (tool.name === "suggest_where_catalyst_q_helps") {
		const { value, summary } = await started;
		return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(value, null, 2)}` }], structuredContent: value, isError: false };
	}
	const out = await settle(started);
	if (out.kind === "answer") {
		const value = { outcome: "answered", ...out.reply };
		return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: false };
	}
	if (out.kind === "refusal") {
		const value = { outcome: "refused", status: out.status, error: out.code, detail: out.detail, numbers: out.numbers, retry_after: out.retryAfter };
		const summary = `Catalyst-Q refused this job (${out.code}): ${out.detail} This is a normal result, not a failure of the tool. Read the numbers before you change anything.`;
		return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(value, null, 2)}` }], structuredContent: value, isError: false };
	}
	return failure(`No usable reply from Catalyst-Q (${out.code}): ${out.detail} Nothing can be said about the circuit from this.`);
}

function failure(message) {
	return { content: [{ type: "text", text: message }], isError: true };
}
