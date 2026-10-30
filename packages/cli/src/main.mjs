// npx catalyst-q: suggest, run, sample, score, ui.
// Exit codes: 0 an answer, 10 a refusal (a normal result, and scripts may want to branch on it),
// 1 no usable reply or bad usage.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { CatalystQ, settle } from "catalyst-q";
import { extractCounts, suggest } from "catalyst-q-advisor";
import { collect } from "catalyst-q-advisor/collect";

const { version } = createRequire(import.meta.url)("../package.json");

export const EXIT = { ANSWER: 0, USAGE_OR_UNREACHABLE: 1, REFUSAL: 10 };

const HELP = `catalyst-q ${version}

A hosted API that runs quantum circuits on classical hardware and returns exact
answers, or refuses with the numbers. It is not a quantum computer.

Usage
  catalyst-q suggest [path] [--goal "text"]   Where could this help? Runs locally.
  catalyst-q run file.qasm [--measure 0,1] [--shots N]
                                              The exact probability of every outcome.
  catalyst-q sample file.qasm --shots N [--seed S] [--measure 0,1]
                                              Real draws from the exact distribution.
  catalyst-q score file.qasm counts.json [--measure 0,1]
                                              Compare device counts with the circuit.
  catalyst-q ui [--port N] [--no-open]        The same tools as a local web page.

Options
  --json             Print the service's reply as JSON.
  --base-url URL     Use a different API address.
  -h, --help         Show this.
  -v, --version      Show the version.

No key is needed up to 64 qubits and 4,000 gates (6 calls a minute, 60 a day).
Set CATALYST_Q_KEY to use your account, up to 256 qubits.

Exit codes: 0 an answer, 10 a refusal, 1 no usable reply or bad usage.
`;

const OPTIONS = {
	goal: { type: "string" },
	shots: { type: "string" },
	seed: { type: "string" },
	measure: { type: "string" },
	port: { type: "string" },
	"no-open": { type: "boolean" },
	json: { type: "boolean" },
	"base-url": { type: "string" },
	help: { type: "boolean", short: "h" },
	version: { type: "boolean", short: "v" },
};

class UsageError extends Error {}

function positiveInt(text, name) {
	const value = Number(text);
	if (!Number.isInteger(value) || value < 1) throw new UsageError(`${name} needs a whole number above zero. You gave "${text}".`);
	return value;
}

function qubitList(text) {
	if (text === undefined) return undefined;
	const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
	if (!parts.length || !parts.every((part) => /^\d+$/.test(part))) throw new UsageError(`--measure takes qubit numbers like 0,1,2. You gave "${text}".`);
	return parts.map(Number);
}

async function readText(path, what) {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		throw new UsageError(`Could not read ${what} at ${path}: ${err.code ?? err.message}`);
	}
}

function bar(share, width = 32) {
	return "#".repeat(Math.max(share > 0 ? 1 : 0, Math.round(share * width)));
}

function formatNumber(value) {
	if (typeof value !== "number") return String(value);
	if (Number.isInteger(value)) return value.toLocaleString("en-US");
	if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(3);
	return String(Number(value.toPrecision(6)));
}

function printTable(print, map, maxRows = 32) {
	const rows = Object.entries(map).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const top = rows[0]?.[1] || 1;
	const width = Math.max(...rows.slice(0, maxRows).map(([key]) => key.length), 7);
	for (const [outcome, value] of rows.slice(0, maxRows)) {
		print(`  ${outcome.padEnd(width)}  ${formatNumber(value).padStart(10)}  ${bar(value / top)}`);
	}
	if (rows.length > maxRows) print(`  and ${rows.length - maxRows} more. Use --json to see them all.`);
}

function printFooter(print, reply) {
	if (reply.permalink) print(`\nPermalink: ${reply.permalink}`);
	if (reply.result?.execution?.fingerprint) print(`Fingerprint: ${reply.result.execution.fingerprint}`);
}

function printResult(print, reply, heading) {
	const result = reply.result ?? {};
	print(heading);
	if (result.probabilities) printTable(print, result.probabilities);
	else if (result.counts) printTable(print, result.counts);
	else print(JSON.stringify(result, null, 2));
	for (const field of ["method", "qubits_held", "seed"]) {
		if (result[field] !== undefined) print(`${field}: ${result[field]}`);
	}
	if (result.outcome_law) print(`outcome_law: ${JSON.stringify(result.outcome_law)}`);
	printFooter(print, reply);
}

function printScore(print, reply) {
	const score = reply.result?.score;
	if (!score) {
		print(JSON.stringify(reply.result ?? {}, null, 2));
		return;
	}
	print(`Scored ${formatNumber(score.shots)} shots over ${formatNumber(score.distinct_outcomes)} distinct outcomes.`);
	if (score.xeb) print(`Cross-entropy score: ${formatNumber(score.xeb.value)} (standard error ${formatNumber(score.xeb.standard_error)}, a perfect device expects ${formatNumber(score.xeb.ideal)}, fidelity estimate ${formatNumber(score.xeb.fidelity_estimate)})`);
	print(`Mean log2 probability: ${formatNumber(score.mean_log2_probability)}`);
	print(`Shots on impossible outcomes: ${formatNumber(score.impossible_shots)}`);
	if (score.table) {
		const perfect = score.table.perfect_device;
		print(`Total variation: ${formatNumber(score.table.total_variation)}${perfect ? ` (a perfect device: ${formatNumber(perfect.total_variation)})` : ""}`);
		print(`Hellinger fidelity: ${formatNumber(score.table.hellinger_fidelity)}${perfect ? ` (a perfect device: ${formatNumber(perfect.hellinger_fidelity)})` : ""}`);
	}
	if (score.note) print(`\n${score.note}`);
	printFooter(print, reply);
}

/** Prints whichever way the call went and returns the exit code. A refusal is a result, so it goes to stdout. */
function report(out, { print, printError, json }, onAnswer) {
	if (out.kind === "answer") {
		if (json) print(JSON.stringify(out.reply, null, 2));
		else onAnswer(out.reply);
		return EXIT.ANSWER;
	}
	if (out.kind === "refusal") {
		if (json) {
			print(JSON.stringify({ refused: true, status: out.status, error: out.code, detail: out.detail, ...out.numbers }, null, 2));
			return EXIT.REFUSAL;
		}
		print(`Catalyst-Q refused this one (${out.code}).`);
		print(out.detail);
		const numbers = Object.entries(out.numbers);
		if (numbers.length) {
			print("");
			for (const [field, value] of numbers) print(`  ${field}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
		}
		if (out.retryAfter) print(`\nYou can run it again in ${out.retryAfter} seconds.`);
		return EXIT.REFUSAL;
	}
	printError(`No usable reply from the service (${out.code}): ${out.detail}`);
	printError("Nothing was computed, so there is no result.");
	return EXIT.USAGE_OR_UNREACHABLE;
}

function printSuggestions(print, result) {
	print(result.message);
	for (const s of result.suggestions) {
		print(`\n${s.title}`);
		print(`  Why: ${s.why}`);
		print(`  When not to: ${s.when_not}`);
		print(`  Noticed: ${s.evidence.join("; ")}`);
		if (s.action.command) print(`  Try: ${s.action.command}`);
		else if (s.action.body) print(`  Try: ${s.action.route} ${JSON.stringify(s.action.body)}`);
	}
}

async function runUi(values, { print, printError, env, startUi, openUrl }) {
	const { createUiHandler, serveLocally } = await import("catalyst-q-ui");
	const port = values.port === undefined ? 0 : positiveInt(values.port, "--port");
	const handler = createUiHandler({ getKey: () => env.CATALYST_Q_KEY, baseUrl: values["base-url"] || env.CATALYST_Q_BASE_URL || undefined });
	let server;
	try {
		server = await (startUi ?? serveLocally)(handler, { port });
	} catch (err) {
		printError(`Could not start the local page: ${err.code ?? err.message}`);
		return EXIT.USAGE_OR_UNREACHABLE;
	}
	print(`Catalyst-Q is on ${server.url}`);
	print("It only listens on this computer. Press Ctrl-C to stop.");
	if (!values["no-open"]) (openUrl ?? openInBrowser)(server.url);
	return new Promise(() => {});
}

function openInBrowser(url) {
	const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	const child = spawn(command, args, { stdio: "ignore", detached: true });
	child.on("error", () => {});
	child.unref();
}

/**
 * @param {string[]} argv Arguments after the command name.
 * @param {object} [io] Replacements for testing.
 * @returns {Promise<number>} The exit code.
 */
export async function main(argv, io = {}) {
	const print = io.print ?? ((line) => console.log(line));
	const printError = io.printError ?? ((line) => console.error(line));
	const env = io.env ?? process.env;
	try {
		let parsed;
		try {
			parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
		} catch (err) {
			throw new UsageError(err.message);
		}
		const { values, positionals } = parsed;
		const [command, ...rest] = positionals;
		if (values.version) { print(version); return EXIT.ANSWER; }
		if (values.help || !command) { print(HELP); return command || values.help ? EXIT.ANSWER : EXIT.USAGE_OR_UNREACHABLE; }

		const context = { print, printError, json: Boolean(values.json) };
		const client = () => new CatalystQ({ apiKey: env.CATALYST_Q_KEY || null, baseUrl: values["base-url"] || env.CATALYST_Q_BASE_URL || undefined, fetch: io.fetch });

		if (command === "suggest") {
			const path = rest[0];
			if (!path && !values.goal) throw new UsageError('Give it a path, or a goal: catalyst-q suggest . --goal "what you are trying to do"');
			let files = [];
			if (path) {
				try {
					files = await collect(path);
				} catch (err) {
					throw new UsageError(`Could not read ${path}: ${err.code ?? err.message}`);
				}
			}
			const result = suggest({ goal: values.goal, files });
			if (context.json) print(JSON.stringify(result, null, 2));
			else printSuggestions(print, result);
			return EXIT.ANSWER;
		}

		if (command === "run") {
			if (!rest[0]) throw new UsageError("Which circuit? catalyst-q run file.qasm");
			const body = { qasm: await readText(rest[0], "the circuit") };
			const measure = qubitList(values.measure);
			if (measure) body.measure = measure;
			if (values.shots !== undefined) body.shots = positiveInt(values.shots, "--shots");
			return report(await settle(client().run(body)), context, (reply) => printResult(print, reply, "Exact answer:"));
		}

		if (command === "sample") {
			if (!rest[0]) throw new UsageError("Which circuit? catalyst-q sample file.qasm --shots 1000");
			if (values.shots === undefined) throw new UsageError("How many draws? Add --shots N.");
			const body = { qasm: await readText(rest[0], "the circuit"), shots: positiveInt(values.shots, "--shots") };
			if (values.seed !== undefined) {
				if (!/^\d+$/.test(values.seed)) throw new UsageError(`--seed takes a whole number. You gave "${values.seed}".`);
				body.seed = Number(values.seed);
			}
			const measure = qubitList(values.measure);
			if (measure) body.measure = measure;
			return report(await settle(client().sample(body)), context, (reply) => printResult(print, reply, `${formatNumber(body.shots)} draws from the exact distribution:`));
		}

		if (command === "score") {
			if (rest.length < 2) throw new UsageError("It needs the circuit and the counts: catalyst-q score file.qasm counts.json");
			const body = { qasm: await readText(rest[0], "the circuit") };
			const counts = extractCounts(await readText(rest[1], "the counts"));
			if (!counts) throw new UsageError(`No counts found in ${rest[1]}. It should hold bit strings and numbers, like {"00": 498, "11": 502}.`);
			body.counts = counts;
			const measure = qubitList(values.measure);
			if (measure) body.measure = measure;
			return report(await settle(client().score(body)), context, (reply) => printScore(print, reply));
		}

		if (command === "ui") return await runUi(values, { print, printError, env, startUi: io.startUi, openUrl: io.openUrl });

		throw new UsageError(`There is no "${command}" command. Run catalyst-q --help.`);
	} catch (err) {
		if (err instanceof UsageError) {
			printError(err.message);
			return EXIT.USAGE_OR_UNREACHABLE;
		}
		throw err;
	}
}
