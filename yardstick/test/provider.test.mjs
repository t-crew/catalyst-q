import { test } from "node:test";
import assert from "node:assert/strict";
import createProvider, { toObservable, toQasm } from "../catalyst-q.js";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function setup(reply, config = {}) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url: String(url), body: JSON.parse(init.body), init });
		return reply(calls.at(-1), calls.length);
	};
	return { calls, provider: createProvider({ fetch, url: "https://api.test", ...config }) };
}

test("the provider has the shape the yardstick checks for", () => {
	const { provider } = setup(() => json({}));
	assert.equal(typeof provider.run, "function");
	assert.equal(provider.name, "catalyst-q");
	assert.equal(provider.meta.account, "none");
});

test("toQasm writes every gate the yardstick uses", () => {
	const qasm = toQasm({
		n: 5,
		gates: [
			{ g: "h", q: [0] }, { g: "x", q: [1] }, { g: "y", q: [2] }, { g: "z", q: [3] }, { g: "s", q: [0] }, { g: "sdg", q: [0] }, { g: "t", q: [0] },
			{ g: "rx", q: [0], params: [0.5] }, { g: "ry", q: [1], params: [0.25] }, { g: "rz", q: [2], params: [1] },
			{ g: "cx", q: [0, 1] }, { g: "cz", q: [1, 2] }, { g: "swap", q: [2, 3] }, { g: "cp", q: [0, 1], params: [0.125] },
			{ g: "ccz", q: [0, 1, 2] }, { g: "mcz", q: [0, 1] }, { g: "measure", q: [0] },
		],
	});
	assert.match(qasm, /^OPENQASM 3\.0;\nqubit\[5\] q;\n/);
	for (const line of ["h q[0];", "sdg q[0];", "rx(0.5) q[0];", "cx q[0], q[1];", "swap q[2], q[3];", "cp(0.125) q[0], q[1];", "ccx q[0], q[1], q[2];", "cz q[0], q[1];"]) {
		assert.ok(qasm.includes(line), line);
	}
	assert.doesNotMatch(qasm, /measure/);
});

test("toQasm breaks a wide multi-controlled Z into gates the service reads", () => {
	const qasm = toQasm({ n: 5, gates: [{ g: "mcz", q: [0, 1, 2, 3, 4] }] });
	const names = new Set(qasm.split("\n").slice(2).filter(Boolean).map((line) => /^([a-z]+)/.exec(line)[1]));
	assert.deepEqual([...names].sort(), ["cp", "cx", "h"]);
});

test("toQasm stops a very wide multi-controlled Z instead of filling memory", () => {
	const started = process.memoryUsage().heapUsed;
	assert.throws(() => toQasm({ n: 16, gates: [{ g: "mcz", q: Array.from({ length: 16 }, (_, i) => i) }] }), /more than 50000 gates/);
	assert.ok(process.memoryUsage().heapUsed - started < 200 * 1024 * 1024, "the guard fires early");
});

test("toQasm refuses a gate it does not know, instead of dropping it", () => {
	assert.throws(() => toQasm({ n: 1, gates: [{ g: "wat", q: [0] }] }), /unsupported gate 'wat'/);
});

test("toObservable keeps the letter and position of each non-identity", () => {
	assert.deepEqual(toObservable("ZIIZ"), { pauli: "ZZ", qubits: [0, 3] });
	assert.deepEqual(toObservable("IXY"), { pauli: "XY", qubits: [1, 2] });
	assert.equal(toObservable("III"), null);
});

test("an expectation read goes to the no-account route and fills in the identity word", async () => {
	const { provider, calls } = setup(() => json({ ok: true, record_id: "r", permalink: "https://x/r", result: { values: [{ observable: "ZZ", value: 1, certificate: 0, exact: true }] } }));
	const result = await provider.run({ n: 2, gates: [{ g: "h", q: [0] }, { g: "cx", q: [0, 1] }], shots: 0, expect: [{ coeff: 2, word: "ZZ" }, { coeff: 3, word: "II" }] });
	assert.equal(calls[0].url, "https://api.test/api/v1/try");
	assert.equal(calls[0].body.mode, "circuit");
	assert.deepEqual(calls[0].body.observables, [{ pauli: "ZZ", qubits: [0, 1] }]);
	assert.deepEqual(result.expectations.map((e) => [e.word, e.value]), [["ZZ", 1], ["II", 1]]);
	assert.equal(result.energy, 5);
	assert.equal(result.metadata.permalink, "https://x/r");
	assert.equal(result.metadata.memory_bytes, undefined, "not reported, so not guessed");
	assert.equal(result.metadata.materialized, undefined, "not reported, so not guessed");
});

test("a key selects the account routes", async () => {
	const { provider, calls } = setup(() => json({ ok: true, result: { values: [{ value: 1 }] } }), { key: "cq_live_k" });
	await provider.run({ n: 1, gates: [], shots: 0, expect: [{ coeff: 1, word: "Z" }] });
	assert.equal(calls[0].url, "https://api.test/api/v1/observables");
	assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer cq_live_k");
	assert.equal(calls[0].body.mode, undefined);
});

test("a distribution read at small width asks for the full table", async () => {
	const { provider, calls } = setup(() => json({ ok: true, result: { probabilities: { "00": 0.5, "11": 0.5 } } }));
	const result = await provider.run({ n: 2, gates: [], shots: 100, expect: [] });
	assert.deepEqual(calls[0].body.measure, [0, 1]);
	assert.equal(calls[0].body.sampling, undefined);
	assert.deepEqual(result.distribution, { "00": 0.5, "11": 0.5 });
});

test("a distribution read at large width draws shots and normalises them", async () => {
	const { provider, calls } = setup(() => json({ ok: true, result: { counts: { ["0".repeat(30)]: 3, ["1".repeat(30)]: 1 } } }));
	const result = await provider.run({ n: 30, gates: [], shots: 4, expect: [] });
	assert.equal(calls[0].body.sampling, "random");
	assert.equal(calls[0].body.shots, 4);
	assert.equal(result.distribution["0".repeat(30)], 0.75);
});

test("a refusal is thrown with its code, detail and numbers, so the yardstick records it", async () => {
	const { provider } = setup(() => json({ error: "too_many_gates", detail: "Over the limit.", gates: 9000 }, 422));
	await assert.rejects(provider.run({ n: 2, gates: [], shots: 10, expect: [] }), /refused \(too_many_gates\): Over the limit\. \{"gates":9000\}/);
});

test("a reply that is not JSON is an error, never a result", async () => {
	const { provider } = setup(() => new Response("<html>", { status: 200 }));
	await assert.rejects(provider.run({ n: 1, gates: [], shots: 1, expect: [] }), /not JSON/);
});

test("a short list of values is an error, never a partial result", async () => {
	const { provider } = setup(() => json({ ok: true, result: { values: [] } }));
	await assert.rejects(provider.run({ n: 1, gates: [], shots: 0, expect: [{ coeff: 1, word: "Z" }] }), /asked for 1 values, got 0/);
});

test("a rate limit is waited out for as long as the service says, a few times at most", async () => {
	const waits = [];
	const { provider, calls } = setup((_call, n) => (n < 3 ? json({ error: "rate_limited", detail: "Slow down." }, 429, { "retry-after": "7" }) : json({ ok: true, result: { probabilities: { "0": 1 } } })), { sleep: async (ms) => waits.push(ms) });
	await provider.run({ n: 1, gates: [], shots: 1, expect: [] });
	assert.deepEqual(waits, [7000, 7000]);
	assert.equal(calls.length, 3);
	const always = setup(() => json({ error: "rate_limited", detail: "Slow down." }, 429), { sleep: async () => {}, patience: 1 });
	await assert.rejects(always.provider.run({ n: 1, gates: [], shots: 1, expect: [] }), /rate_limited/);
	assert.equal(always.calls.length, 2);
});
