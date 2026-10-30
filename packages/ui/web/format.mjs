// Pure helpers for the page. No DOM, so they run under the test runner as they are.

/** Shows a number without inventing precision. Whole numbers get separators; others keep six significant digits. */
export function formatNumber(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
	if (Number.isInteger(value)) return value.toLocaleString("en-US");
	if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(3);
	return String(Number(value.toPrecision(6)));
}

/** Shows any field of a reply: a number, a bit of text, or JSON for anything nested. */
export function formatValue(value) {
	if (value === null || value === undefined) return "none";
	if (typeof value === "number") return formatNumber(value);
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "yes" : "no";
	return JSON.stringify(value);
}

const NOT_READABLE = new Set(["unknown_gate", "bad_statement", "bad_parameter", "bad_register", "unsupported_construct", "width_not_declared", "bad_qasm", "invalid_body", "invalid_qasm"]);
const TOO_WIDE = new Set(["width_over_route_limit", "width_over_tier_limit", "too_many_qubits", "too_many_measured"]);
const TOO_LONG = new Set(["too_many_gates"]);
const NEEDS_KEY = new Set(["authentication_required", "invalid_api_key"]);
const NEEDS_CREDITS = new Set(["insufficient_credits"]);

/** Plain words for a refusal. The service's own detail and numbers are always shown beside these. */
export function refusalWords(code) {
	if (code === "rate_limited") return { headline: "You have used the no-account allowance for now.", next: "It is 6 runs a minute and 60 a day per address. Wait a little and run it again, or add an API key." };
	if (NOT_READABLE.has(code)) return { headline: "The service could not read this circuit.", next: "The detail below names the line or construct. Fix that and run it again." };
	if (TOO_WIDE.has(code)) return { headline: "This circuit is wider than this route allows.", next: "Measure fewer qubits, draw shots, ask about specific outcomes, or add an API key." };
	if (TOO_LONG.has(code)) return { headline: "This circuit has more gates than this route allows.", next: "Cut the circuit down, or add an API key." };
	if (NEEDS_KEY.has(code)) return { headline: "This needs an API key.", next: "Add a key, or stay on the no-account route." };
	if (NEEDS_CREDITS.has(code)) return { headline: "This account does not have the credits for this job.", next: "The numbers below say what it costs and what remains." };
	return { headline: "Catalyst-Q refused this one.", next: "It says no when it cannot give an exact answer, instead of guessing. The numbers below are why." };
}

/** The outcome rows in a reply, largest first, with what they mean. */
export function outcomeRows(result) {
	const source = result && typeof result === "object" ? result : {};
	const probabilities = source.probabilities;
	if (probabilities && typeof probabilities === "object" && Object.keys(probabilities).length) {
		return { unit: "probability", rows: toRows(probabilities) };
	}
	const counts = source.counts;
	if (counts && typeof counts === "object" && Object.keys(counts).length) {
		return { unit: "count", rows: toRows(counts) };
	}
	return { unit: null, rows: [] };
}

function toRows(map) {
	return Object.entries(map)
		.filter(([, value]) => typeof value === "number")
		.map(([outcome, value]) => ({ outcome, value }))
		.sort((a, b) => b.value - a.value || (a.outcome < b.outcome ? -1 : 1));
}

export function inBitOrder(rows) {
	return [...rows].sort((a, b) => (a.outcome < b.outcome ? -1 : a.outcome > b.outcome ? 1 : 0));
}

/** Keeps the chart readable: the top rows, and what the rest add up to. The table view always has every row. */
export function limitRows(rows, max = 32) {
	if (rows.length <= max) return { shown: rows, hiddenCount: 0, hiddenTotal: 0 };
	const hidden = rows.slice(max);
	return { shown: rows.slice(0, max), hiddenCount: hidden.length, hiddenTotal: hidden.reduce((sum, row) => sum + row.value, 0) };
}

/** Round numbers for the axis under the bars. The last tick is at or above the maximum, so no bar overruns it. */
export function axisTicks(max) {
	if (!(max > 0)) return [0];
	const power = 10 ** Math.floor(Math.log10(max));
	const step = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => max / candidate <= 5) ?? power;
	const ticks = [0];
	while (ticks.at(-1) < max * (1 - 1e-9)) ticks.push(Number((ticks.length * step).toPrecision(6)));
	return ticks;
}

/** Reads "0,1, 3" into [0, 1, 3]. Returns undefined when blank and null when it does not parse. */
export function parseQubitList(text) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return undefined;
	const parts = trimmed.split(/[\s,]+/).filter(Boolean);
	if (!parts.every((part) => /^\d+$/.test(part))) return null;
	return parts.map(Number);
}

/** Reads "0101, 1100" into a list of bit strings, or null when something else is in there. */
export function parseOutcomes(text) {
	const parts = String(text ?? "").split(/[\s,]+/).filter(Boolean);
	if (!parts.length || !parts.every((part) => /^[01]+$/.test(part))) return null;
	return parts;
}

/** Reads observables such as "ZZ on 0,1; mean_z". Returns null when a part does not parse. */
export function parseObservables(text) {
	const parts = String(text ?? "").split(/[;\n]+/).map((part) => part.trim()).filter(Boolean);
	if (!parts.length) return null;
	const out = [];
	for (const part of parts) {
		if (/^mean_z$/i.test(part)) { out.push({ type: "mean_z" }); continue; }
		const match = /^([IXYZ]+)\s+on\s+([\d,\s]+)$/i.exec(part);
		if (!match) return null;
		const qubits = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
		if (qubits.length !== match[1].length) return null;
		out.push({ pauli: match[1].toUpperCase(), qubits });
	}
	return out;
}

/** Turns an advisor suggestion into what the page should open. */
export function formFromSuggestion(suggestion) {
	const body = suggestion?.action?.body;
	if (!body) return { view: "run", mode: "probabilities" };
	if (body.mode === "score") return { view: "score", qasm: body.qasm, counts: body.counts };
	if (body.mode === "qec") return { view: "run", mode: "qec", distance: body.distance, epsilon: body.epsilon };
	if (body.mode === "circuit") {
		const observables = (body.observables ?? []).map((o) => (o.type ? o.type : `${o.pauli} on ${(o.qubits ?? []).join(",")}`)).join("; ");
		return { view: "run", mode: "expectation", qasm: body.qasm, observables };
	}
	if (body.sampling === "random") return { view: "run", mode: "shots", qasm: body.qasm, shots: body.shots, seed: body.seed };
	if (Array.isArray(body.outcomes)) return { view: "run", mode: "outcomes", qasm: body.qasm, outcomes: body.outcomes.filter((o) => /^[01]+$/.test(o)).join(", ") };
	return { view: "run", mode: "probabilities", qasm: body.qasm };
}

/** A sentence for the top of a device score. It only restates fields the service sent. */
export function scoreSentence(score) {
	if (!score || typeof score !== "object") return "";
	const shots = formatNumber(score.shots);
	const impossible = score.impossible_shots;
	if (impossible > 0) return `${formatNumber(impossible)} of your ${shots} shots landed on outcomes this circuit can never produce.`;
	if (impossible === 0) return `None of your ${shots} shots landed on an outcome this circuit can never produce.`;
	return `Scored ${shots} shots.`;
}
