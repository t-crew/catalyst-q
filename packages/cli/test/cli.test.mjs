import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, main } from "../src/main.mjs";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const BELL = "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];";

async function workspace() {
	const dir = await mkdtemp(join(tmpdir(), "cli-"));
	await writeFile(join(dir, "bell.qasm"), BELL);
	await writeFile(join(dir, "counts.json"), JSON.stringify({ "00": 498, "11": 502 }));
	await writeFile(join(dir, "words.json"), JSON.stringify({ hello: 1 }));
	return dir;
}

function harness(reply = () => json({ ok: true, result: {} }), env = {}) {
	const out = [];
	const err = [];
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
		return reply(calls.at(-1));
	};
	return { out, err, calls, io: { print: (line) => out.push(line), printError: (line) => err.push(line), env, fetch } };
}

test("help and version", async () => {
	const h = harness();
	assert.equal(await main(["--help"], h.io), EXIT.ANSWER);
	assert.match(h.out.join("\n"), /suggest/);
	assert.match(h.out.join("\n"), /not a quantum computer/);
	const v = harness();
	assert.equal(await main(["--version"], v.io), EXIT.ANSWER);
	assert.match(v.out[0], /^\d+\.\d+\.\d+$/);
	const none = harness();
	assert.equal(await main([], none.io), EXIT.USAGE_OR_UNREACHABLE);
});

test("run prints the outcomes as bars, sends the no-account body, and exits 0", async () => {
	const dir = await workspace();
	try {
		const h = harness(() => json({ ok: true, permalink: "https://x/r/1", result: { probabilities: { "00": 0.5, "11": 0.5 }, method: "m", execution: { fingerprint: "abc" } } }));
		assert.equal(await main(["run", join(dir, "bell.qasm"), "--measure", "0,1"], h.io), EXIT.ANSWER);
		assert.ok(h.calls[0].url.endsWith("/api/v1/try"));
		assert.deepEqual(h.calls[0].body, { mode: "execute", qasm: BELL, measure: [0, 1] });
		const text = h.out.join("\n");
		assert.match(text, /00\s+0\.5\s+#+/);
		assert.match(text, /Permalink: https:\/\/x\/r\/1/);
		assert.match(text, /Fingerprint: abc/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a key in the environment selects the account route", async () => {
	const dir = await workspace();
	try {
		const h = harness(() => json({ ok: true, result: { probabilities: { "0": 1 } } }), { CATALYST_Q_KEY: "cq_live_k" });
		await main(["run", join(dir, "bell.qasm")], h.io);
		assert.ok(h.calls[0].url.endsWith("/api/v1/execute"));
		assert.equal(new Headers(h.calls[0].init.headers).get("authorization"), "Bearer cq_live_k");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("sample sends sampling random with shots and seed", async () => {
	const dir = await workspace();
	try {
		const h = harness(() => json({ ok: true, result: { counts: { "00": 3, "11": 7 }, seed: 5, qubits_held: 2, outcome_law: { dimension: 2, constraints: [] } } }));
		assert.equal(await main(["sample", join(dir, "bell.qasm"), "--shots", "10", "--seed", "5"], h.io), EXIT.ANSWER);
		assert.deepEqual(h.calls[0].body, { mode: "execute", qasm: BELL, shots: 10, seed: 5, sampling: "random" });
		const text = h.out.join("\n");
		assert.match(text, /qubits_held: 2/);
		assert.match(text, /outcome_law/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("score reads the counts file and prints what the service sent", async () => {
	const dir = await workspace();
	try {
		const score = { shots: 1000, distinct_outcomes: 2, measured: 2, xeb: { value: 0.98, standard_error: 0.03, ideal: 1, fidelity_estimate: 0.98 }, mean_log2_probability: -1, impossible_shots: 0, table: { total_variation: 0.002, hellinger_fidelity: 0.9999, perfect_device: { total_variation: 0.01, hellinger_fidelity: 0.9998 } }, note: "A note." };
		const h = harness(() => json({ ok: true, result: { score } }));
		assert.equal(await main(["score", join(dir, "bell.qasm"), join(dir, "counts.json")], h.io), EXIT.ANSWER);
		assert.deepEqual(h.calls[0].body, { mode: "score", qasm: BELL, counts: { "00": 498, "11": 502 } });
		const text = h.out.join("\n");
		assert.match(text, /Cross-entropy score: 0\.98/);
		assert.match(text, /impossible outcomes: 0/);
		assert.match(text, /Total variation: 0\.002 \(a perfect device: 0\.01\)/);
		assert.match(text, /A note\./);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a counts file with no counts stops before any request", async () => {
	const dir = await workspace();
	try {
		const h = harness();
		assert.equal(await main(["score", join(dir, "bell.qasm"), join(dir, "words.json")], h.io), EXIT.USAGE_OR_UNREACHABLE);
		assert.match(h.err.join("\n"), /No counts found/);
		assert.equal(h.calls.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a refusal prints the reason and numbers on stdout and exits 10, not as a crash", async () => {
	const dir = await workspace();
	try {
		const h = harness(() => json({ error: "too_many_gates", detail: "9000 gates; the limit is 4000.", gates: 9000, limit: 4000 }, 422, { "retry-after": "12" }));
		assert.equal(await main(["run", join(dir, "bell.qasm")], h.io), EXIT.REFUSAL);
		const text = h.out.join("\n");
		assert.match(text, /refused this one \(too_many_gates\)/);
		assert.match(text, /9000 gates; the limit is 4000\./);
		assert.match(text, /gates: 9000/);
		assert.match(text, /again in 12 seconds/);
		assert.equal(h.err.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("--json keeps the refusal's numbers too", async () => {
	const dir = await workspace();
	try {
		const h = harness(() => json({ error: "over", detail: "d", needed: 9 }, 422));
		assert.equal(await main(["run", join(dir, "bell.qasm"), "--json"], h.io), EXIT.REFUSAL);
		assert.deepEqual(JSON.parse(h.out[0]), { refused: true, status: 422, error: "over", detail: "d", needed: 9 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("no reply says so and exits 1", async () => {
	const dir = await workspace();
	try {
		const h = harness(() => { throw new TypeError("fetch failed"); });
		assert.equal(await main(["run", join(dir, "bell.qasm")], h.io), EXIT.USAGE_OR_UNREACHABLE);
		assert.match(h.err.join("\n"), /there is no result/);
		assert.equal(h.out.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("suggest on a quantum folder, on a goal, and on a plain folder", async () => {
	const dir = await workspace();
	try {
		const quantum = harness();
		assert.equal(await main(["suggest", dir], quantum.io), EXIT.ANSWER);
		const text = quantum.out.join("\n");
		assert.match(text, /Run this circuit/);
		assert.match(text, /Score your device counts/);
		assert.match(text, /When not to:/);
		assert.equal(quantum.calls.length, 0, "suggest never touches the network");

		const goal = harness();
		await main(["suggest", "--goal", "plan a QAOA run", "--json"], goal.io);
		assert.equal(JSON.parse(goal.out[0]).suggestions[0].id, "noiseless-before-hardware");

		const plain = await mkdtemp(join(tmpdir(), "cli-plain-"));
		await writeFile(join(plain, "index.js"), "console.log('hello');\n");
		const none = harness();
		assert.equal(await main(["suggest", plain], none.io), EXIT.ANSWER);
		assert.match(none.out.join("\n"), /nothing to suggest/);
		await rm(plain, { recursive: true, force: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("usage mistakes get a plain sentence and exit 1", async () => {
	const dir = await workspace();
	try {
		const cases = [
			[["nope"], /no "nope" command/],
			[["run"], /Which circuit/],
			[["run", join(dir, "missing.qasm")], /Could not read/],
			[["sample", join(dir, "bell.qasm")], /--shots/],
			[["sample", join(dir, "bell.qasm"), "--shots", "ten"], /whole number/],
			[["sample", join(dir, "bell.qasm"), "--shots", "5", "--seed", "x"], /--seed/],
			[["run", join(dir, "bell.qasm"), "--measure", "a"], /--measure/],
			[["score", join(dir, "bell.qasm")], /circuit and the counts/],
			[["suggest"], /path, or a goal/],
			[["suggest", join(dir, "nothing-here")], /Could not read/],
			[["run", "--wat"], /wat/],
		];
		for (const [args, pattern] of cases) {
			const h = harness();
			assert.equal(await main(args, h.io), EXIT.USAGE_OR_UNREACHABLE, args.join(" "));
			assert.match(h.err.join("\n"), pattern);
			assert.equal(h.calls.length, 0);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ui starts the local page, reports the address, and opens it", async () => {
	const h = harness();
	let opened = null;
	let started = null;
	const run = main(["ui", "--port", "4100"], { ...h.io, startUi: async (handler, options) => { started = { handler, options }; return { url: "http://127.0.0.1:4100/" }; }, openUrl: (url) => { opened = url; } });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(started.options.port, 4100);
	assert.equal(opened, "http://127.0.0.1:4100/");
	assert.match(h.out.join("\n"), /only listens on this computer/);
	assert.equal(typeof started.handler, "function");
	void run;
});

test("ui --no-open leaves the browser alone", async () => {
	const h = harness();
	let opened = false;
	main(["ui", "--no-open"], { ...h.io, startUi: async () => ({ url: "http://127.0.0.1:1/" }), openUrl: () => { opened = true; } });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(opened, false);
});

test("ui reports a port it cannot open", async () => {
	const h = harness();
	const code = await main(["ui"], { ...h.io, startUi: async () => { throw Object.assign(new Error("in use"), { code: "EADDRINUSE" }); } });
	assert.equal(code, EXIT.USAGE_OR_UNREACHABLE);
	assert.match(h.err.join("\n"), /EADDRINUSE/);
});
