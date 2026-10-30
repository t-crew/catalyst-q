// Unit tests for the catalyst-q client.
// Every call goes through an injected fetch, so each test asserts the exact request the client sends and how it
// reads the reply. Nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CatalystQ, CatalystQError, VERSION, DEFAULT_BASE_URL, settle } from "../src/index.ts";

type Call = { url: string; init: RequestInit };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function recorder(reply: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
		const call = { url: String(url), init };
		calls.push(call);
		return reply(call);
	};
	return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const header = (call: Call, name: string): string | null => new Headers(call.init.headers).get(name);
const sent = (call: Call) => JSON.parse(String(call.init.body));
const route = (call: Call) => call.url.slice(DEFAULT_BASE_URL.length);

test("VERSION matches package.json", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(VERSION, pkg.version);
});

test("defaults: base URL is the hosted API, trailing slashes are trimmed", async () => {
	assert.equal(DEFAULT_BASE_URL, "https://catalyst-q.strategic-innovations.ai");
	const r = recorder(() => json({ ok: true, service: "catalyst-q", version: "v", sdk: "s" }));
	await new CatalystQ({ apiKey: "k", fetch: r.fetch }).health();
	assert.equal(r.calls[0].url, "https://catalyst-q.strategic-innovations.ai/api/health");
	const r2 = recorder(() => json({ ok: true, service: "catalyst-q", version: "v", sdk: "s" }));
	await new CatalystQ({ apiKey: "k", baseUrl: "http://localhost:8787///", fetch: r2.fetch }).health();
	assert.equal(r2.calls[0].url, "http://localhost:8787/api/health");
});

test("the API key falls back to CATALYST_Q_KEY; null means no key at all", async () => {
	const before = process.env.CATALYST_Q_KEY;
	process.env.CATALYST_Q_KEY = "cq_live_from_env";
	try {
		const r = recorder(() => json({ ok: true, key_id: "k", via: "key", tier: "free", credits_remaining: 1, qubit_limit: 16 }));
		await new CatalystQ({ fetch: r.fetch }).usage();
		assert.equal(header(r.calls[0], "authorization"), "Bearer cq_live_from_env");
		const r2 = recorder(() => json({ ok: true, key_id: "k", via: "key", tier: "free", credits_remaining: 1, qubit_limit: 16 }));
		await new CatalystQ({ apiKey: null, fetch: r2.fetch }).usage();
		assert.equal(header(r2.calls[0], "authorization"), null);
	} finally {
		if (before === undefined) delete process.env.CATALYST_Q_KEY; else process.env.CATALYST_Q_KEY = before;
	}
});

test("observables: POST /api/v1/observables with bearer auth, JSON in and out, SDK and Accept headers", async () => {
	const reply = { ok: true, record_id: "obs_1", permalink: "https://x/r/obs_1", result: { status: "completed", values: [], duration_ms: 3 }, usage: { declared_qubits: 2, credits_charged: 1, credits_remaining: 9, duration_ms: 3 }, account: { tier: "free", key_id: "key_1", via: "key" } };
	const r = recorder(() => json(reply));
	const q = new CatalystQ({ apiKey: "cq_live_abc", fetch: r.fetch });
	const body = { qasm: "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];", observables: [{ pauli: "ZZ", qubits: [0, 1] }] };
	const out = await q.observables(body);
	assert.deepEqual(out, reply);
	const c = r.calls[0];
	assert.equal(c.url, `${DEFAULT_BASE_URL}/api/v1/observables`);
	assert.equal(c.init.method, "POST");
	assert.equal(header(c, "authorization"), "Bearer cq_live_abc");
	assert.equal(header(c, "content-type"), "application/json");
	assert.equal(header(c, "accept"), "application/json");
	assert.equal(header(c, "x-catalyst-sdk"), `catalyst-q-js/${VERSION}`);
	assert.deepEqual(sent(c), body);
});

test("execute, qec.coherent, qec.threshold and jobs.create POST to their routes with the body unchanged", async () => {
	const r = recorder(() => json({ ok: true }));
	const q = new CatalystQ({ apiKey: "k", fetch: r.fetch });
	await q.execute({ qasm: "OPENQASM 3.0; qubit[1] q; h q[0];", shots: 100 });
	await q.qec.coherent({ distance: 3, epsilons: [0.1, 0.2] });
	await q.qec.threshold({ distances: [3, 5], ps: [0.04], shots: 1000, noise: "code_capacity" });
	await q.jobs.create({ kind: "verification", summary: "please verify this circuit", payload: { n: 1 } });
	assert.deepEqual(r.calls.map((c) => [c.init.method, route(c)]), [
		["POST", "/api/v1/execute"], ["POST", "/api/v1/qec/coherent"], ["POST", "/api/v1/qec/threshold"], ["POST", "/api/v1/jobs"]]);
	assert.deepEqual(sent(r.calls[0]), { qasm: "OPENQASM 3.0; qubit[1] q; h q[0];", shots: 100 });
	assert.deepEqual(sent(r.calls[1]), { distance: 3, epsilons: [0.1, 0.2] });
	assert.deepEqual(sent(r.calls[3]), { kind: "verification", summary: "please verify this circuit", payload: { n: 1 } });
});

test("usage and jobs.list are authenticated GETs with no body", async () => {
	const r = recorder(() => json({ ok: true, jobs: [] }));
	const q = new CatalystQ({ apiKey: "k", fetch: r.fetch });
	await q.usage();
	await q.jobs.list();
	for (const c of r.calls) {
		assert.equal(c.init.method, "GET");
		assert.equal(c.init.body, undefined);
		assert.equal(header(c, "authorization"), "Bearer k");
		assert.equal(header(c, "accept"), "application/json");
	}
	assert.deepEqual(r.calls.map((c) => route(c)), ["/api/v1/usage", "/api/v1/jobs"]);
});

test("public routes (records.get, tryRun, health) never send the key", async () => {
	const r = recorder(() => json({ ok: true, record_id: "obs_x", kind: "observables", created_at: 1, site_version: "v", inputs: {}, result: {} }));
	const q = new CatalystQ({ apiKey: "cq_live_secret", fetch: r.fetch });
	await q.records.get("obs_x/../y");
	await q.tryRun({ mode: "qec", distance: 3, epsilon: 0.1 });
	await q.health();
	assert.equal(r.calls[0].url, `${DEFAULT_BASE_URL}/api/v1/records/${encodeURIComponent("obs_x/../y")}`);
	assert.equal(r.calls[0].init.method, "GET");
	assert.equal(r.calls[1].url, `${DEFAULT_BASE_URL}/api/v1/try`);
	assert.equal(r.calls[1].init.method, "POST");
	assert.deepEqual(sent(r.calls[1]), { mode: "qec", distance: 3, epsilon: 0.1 });
	for (const c of r.calls) assert.equal(header(c, "authorization"), null);
});

test("records.get refuses an empty id before any request", async () => {
	const r = recorder(() => json({}));
	await assert.rejects(new CatalystQ({ fetch: r.fetch }).records.get(""), TypeError);
	assert.equal(r.calls.length, 0);
});

// --- routing: account routes with a key, /api/v1/try without ---------------------------------------------------

const QASM = "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];";

test("sample with a key goes to /api/v1/execute with sampling random and the bearer key", async () => {
	const r = recorder(() => json({ ok: true, result: { counts: { "00": 3, "11": 5 }, seed: 7, method: "m", qubits_held: 2 } }));
	const q = new CatalystQ({ apiKey: "cq_live_k", fetch: r.fetch });
	const out = await q.sample({ qasm: QASM, shots: 8, seed: 7, measure: [0, 1] });
	assert.equal(route(r.calls[0]), "/api/v1/execute");
	assert.equal(header(r.calls[0], "authorization"), "Bearer cq_live_k");
	assert.deepEqual(sent(r.calls[0]), { qasm: QASM, shots: 8, seed: 7, measure: [0, 1], sampling: "random" });
	assert.deepEqual(out.result.counts, { "00": 3, "11": 5 });
});

test("sample without a key goes to /api/v1/try with mode execute and sends no key", async () => {
	const r = recorder(() => json({ ok: true, mode: "execute", record_id: "r", permalink: "p", inputs: {}, result: { counts: {} }, limits: { per_minute: 6, per_day: 60 } }));
	const q = new CatalystQ({ apiKey: null, fetch: r.fetch });
	assert.equal(q.hasKey, false);
	await q.sample({ qasm: QASM, shots: 8 });
	assert.equal(route(r.calls[0]), "/api/v1/try");
	assert.equal(header(r.calls[0], "authorization"), null);
	assert.deepEqual(sent(r.calls[0]), { mode: "execute", qasm: QASM, shots: 8, sampling: "random" });
});

test("probabilityOf routes by key and passes outcomes through", async () => {
	const withKey = recorder(() => json({ ok: true, result: { probabilities: { "01": 0 } } }));
	await new CatalystQ({ apiKey: "k", fetch: withKey.fetch }).probabilityOf({ qasm: QASM, outcomes: ["01"], measure: [0, 1] });
	assert.equal(route(withKey.calls[0]), "/api/v1/execute");
	assert.deepEqual(sent(withKey.calls[0]), { qasm: QASM, outcomes: ["01"], measure: [0, 1] });
	const noKey = recorder(() => json({ ok: true, result: { probabilities: { "01": 0 } } }));
	await new CatalystQ({ apiKey: null, fetch: noKey.fetch }).probabilityOf({ qasm: QASM, outcomes: ["01"] });
	assert.equal(route(noKey.calls[0]), "/api/v1/try");
	assert.deepEqual(sent(noKey.calls[0]), { mode: "execute", qasm: QASM, outcomes: ["01"] });
});

test("score routes to /api/v1/score with a key and to /api/v1/try mode score without", async () => {
	const score = { shots: 12, distinct_outcomes: 1, measured: 2, xeb: { value: 1, standard_error: 0, ideal: 1, fidelity_estimate: 1 }, mean_log2_probability: -1, impossible_shots: 0, note: "n" };
	const withKey = recorder(() => json({ ok: true, result: { score } }));
	const out = await new CatalystQ({ apiKey: "k", fetch: withKey.fetch }).score({ qasm: QASM, counts: { "00": 12 } });
	assert.equal(route(withKey.calls[0]), "/api/v1/score");
	assert.deepEqual(sent(withKey.calls[0]), { qasm: QASM, counts: { "00": 12 } });
	assert.equal(out.result.score.xeb.value, 1);
	const noKey = recorder(() => json({ ok: true, result: { score } }));
	await new CatalystQ({ apiKey: null, fetch: noKey.fetch }).score({ qasm: QASM, counts: { "00": 12 }, measure: [0, 1] });
	assert.equal(route(noKey.calls[0]), "/api/v1/try");
	assert.deepEqual(sent(noKey.calls[0]), { mode: "score", qasm: QASM, counts: { "00": 12 }, measure: [0, 1] });
});

test("run, expectationValues and surfaceCode pick the matching route", async () => {
	const k = recorder(() => json({ ok: true, result: {} }));
	const a = new CatalystQ({ apiKey: "k", fetch: k.fetch });
	await a.run({ qasm: QASM });
	await a.expectationValues({ qasm: QASM, observables: [{ type: "mean_z" }] });
	await a.surfaceCode({ distance: 3, epsilon: 0.05 });
	assert.deepEqual(k.calls.map(route), ["/api/v1/execute", "/api/v1/observables", "/api/v1/qec/coherent"]);
	const n = recorder(() => json({ ok: true, result: {} }));
	const b = new CatalystQ({ apiKey: null, fetch: n.fetch });
	await b.run({ qasm: QASM });
	await b.expectationValues({ qasm: QASM, observables: [{ type: "mean_z" }], tau: 1e-8 });
	await b.surfaceCode({ distance: 5, epsilon: 0.01 });
	assert.deepEqual(n.calls.map(route), ["/api/v1/try", "/api/v1/try", "/api/v1/try"]);
	assert.deepEqual(n.calls.map((c) => sent(c).mode), ["execute", "circuit", "qec"]);
	assert.deepEqual(sent(n.calls[1]).observables, [{ type: "mean_z" }]);
});

// --- refusals ----------------------------------------------------------------------------------------------------

test("a JSON error reply becomes CatalystQError with status, code, detail and the whole body", async () => {
	const body = { ok: false, error: "authentication_required", detail: "Send your key as `Authorization: Bearer cq_live_...`", docs: "https://catalyst-q.strategic-innovations.ai/docs" };
	const r = recorder(() => json(body, 401));
	const err = await new CatalystQ({ apiKey: null, fetch: r.fetch }).observables({}).then(() => null, (e) => e);
	assert.ok(err instanceof CatalystQError);
	assert.ok(err instanceof Error);
	assert.equal(err.name, "CatalystQError");
	assert.equal(err.status, 401);
	assert.equal(err.code, "authentication_required");
	assert.equal(err.detail, body.detail);
	assert.deepEqual(err.body, body);
});

test("extra fields of an error (credits, limits) survive on err.body", async () => {
	const body = { ok: false, error: "insufficient_credits", detail: "This run costs 5 credits; 2 remain.", cost: 5, remaining: 2, upgrade: "/pricing" };
	const r = recorder(() => json(body, 402));
	const err = await new CatalystQ({ apiKey: "k", fetch: r.fetch }).execute({ qasm: "x" }).then(() => null, (e) => e);
	assert.equal(err.status, 402);
	assert.equal(err.code, "insufficient_credits");
	assert.equal(err.body.cost, 5);
	assert.equal(err.body.remaining, 2);
	assert.equal(err.isRefusal, true);
	assert.deepEqual(err.numbers, { cost: 5, remaining: 2, upgrade: "/pricing" });
});

test("settle: a refusal is a value with its numbers, not a throw", async () => {
	const r = recorder(() => json({ error: "over_budget", detail: "too much", needed: 9, allowed: 3 }, 422, { "retry-after": "4" }));
	const out = await settle(new CatalystQ({ apiKey: null, fetch: r.fetch }).sample({ qasm: QASM, shots: 1 }));
	assert.deepEqual(out, { kind: "refusal", status: 422, code: "over_budget", detail: "too much", numbers: { needed: 9, allowed: 3 }, retryAfter: 4 });
});

test("settle: an answer carries the reply", async () => {
	const r = recorder(() => json({ ok: true, result: { probabilities: { "00": 0.5, "11": 0.5 } } }));
	const out = await settle(new CatalystQ({ apiKey: null, fetch: r.fetch }).run({ qasm: QASM }));
	assert.equal(out.kind, "answer");
});

test("settle: no usable reply is unreachable, never a result", async () => {
	const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch;
	const out = await settle(new CatalystQ({ apiKey: null, fetch: down }).run({ qasm: QASM }));
	assert.equal(out.kind, "unreachable");
	if (out.kind === "unreachable") assert.equal(out.code, "network_error");
	const html = recorder(() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
	const out2 = await settle(new CatalystQ({ apiKey: null, fetch: html.fetch }).run({ qasm: QASM }));
	assert.equal(out2.kind, "unreachable");
});

test("settle: a bug in the caller is rethrown", async () => {
	await assert.rejects(settle(Promise.reject(new RangeError("mine"))), RangeError);
});

test("429 carries retry-after in seconds", async () => {
	const r = recorder(() => json({ ok: false, error: "rate_limited" }, 429, { "retry-after": "17" }));
	const err = await new CatalystQ({ apiKey: "k", fetch: r.fetch }).usage().then(() => null, (e) => e);
	assert.equal(err.status, 429);
	assert.equal(err.code, "rate_limited");
	assert.equal(err.retryAfter, 17);
});

test("an HTML page with status 200 (the site's fallback for unknown routes) throws, never returns", async () => {
	const r = recorder(() => new Response("<!doctype html><html><title>Catalyst-Q</title></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
	const err = await new CatalystQ({ apiKey: "k", fetch: r.fetch }).usage().then(() => null, (e) => e);
	assert.ok(err instanceof CatalystQError);
	assert.equal(err.status, 200);
	assert.equal(err.code, "non_json_response");
	assert.match(err.detail, /text\/html/);
	assert.equal(err.isRefusal, false);
});

test("a 2xx JSON body that says ok:false throws", async () => {
	const r = recorder(() => json({ ok: false, error: "execution_failed", detail: "engine down" }, 200));
	const err = await new CatalystQ({ apiKey: "k", fetch: r.fetch }).execute({ qasm: "x" }).then(() => null, (e) => e);
	assert.equal(err.code, "execution_failed");
	assert.equal(err.status, 200);
});

test("malformed JSON throws non_json_response", async () => {
	const r = recorder(() => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
	const err = await new CatalystQ({ apiKey: "k", fetch: r.fetch }).usage().then(() => null, (e) => e);
	assert.equal(err.code, "non_json_response");
});

test("an error status without a JSON body still throws with a code from the status", async () => {
	const r = recorder(() => new Response("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } }));
	const err = await new CatalystQ({ apiKey: "k", fetch: r.fetch }).usage().then(() => null, (e) => e);
	assert.equal(err.status, 502);
	assert.equal(err.code, "non_json_response");
});

test("timeout aborts the request and throws code timeout", async () => {
	let seenSignal: AbortSignal | undefined;
	const fetch = ((_url: string, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
		seenSignal = init.signal ?? undefined;
		init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
	})) as unknown as typeof globalThis.fetch;
	const started = Date.now();
	const err = await new CatalystQ({ apiKey: "k", fetch, timeoutMs: 50 }).usage().then(() => null, (e) => e);
	assert.ok(seenSignal, "the client passes an AbortSignal to fetch");
	assert.equal(err.code, "timeout");
	assert.equal(err.status, 0);
	assert.ok(Date.now() - started < 2000);
});

test("a network failure throws code network_error with the cause", async () => {
	const fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch;
	const err = await new CatalystQ({ apiKey: "k", fetch }).usage().then(() => null, (e) => e);
	assert.equal(err.code, "network_error");
	assert.equal(err.status, 0);
	assert.ok(err.cause instanceof TypeError);
});

test("distributed carries every shard through its hops and folds them", async () => {
	const calls: string[] = [];
	const q = new CatalystQ({ apiKey: "cq_live_x", fetch: (async (url: string, init: RequestInit) => {
		const path = new URL(url).pathname, body = JSON.parse(String(init.body));
		calls.push(path);
		const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
		if (path.endsWith("/plan")) return reply({ ok: true, plan: { job: { id: 1 }, shards: [{ shard_index: 0, next: 0 }, { shard_index: 1, next: 0 }], work_total: 5, runs: 8 }, credits_estimate: 1 });
		if (path.endsWith("/hop")) return reply({ ok: true, shard: { ...body.shard, next: body.shard.step ? null : 1, step: 1 }, usage: { credits_charged: 1 } });
		return reply({ ok: true, result: { probabilities: { "00": 0.5 }, shards: body.shards.length } });
	}) as typeof fetch });
	const out = await q.distributed({ qasm: "x", outcomes: ["00"] }, { concurrency: 2 });
	assert.equal(out.shards, 2);
	assert.equal(out.hops, 4);
	assert.equal(out.credits, 4);
	assert.deepEqual(out.probabilities, { "00": 0.5 });
	assert.equal(calls.filter((c) => c.endsWith("/hop")).length, 4);
});
