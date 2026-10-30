import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CatalystQ } from "catalyst-q";
import { createServer, MODERN_VERSION } from "../src/server.mjs";

const QASM = "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION };

function json(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function setup(reply, options = { apiKey: null }) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
		return reply(calls.at(-1));
	};
	const client = new CatalystQ({ ...options, fetch });
	return { calls, server: createServer({ client }) };
}

const call = (server, name, args) => server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: META } });

test("server/discover names both eras and the server", async () => {
	const { server } = setup(() => json({}));
	const out = await server.handle({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: META } });
	assert.equal(out.id, "d");
	assert.equal(out.result.resultType, "complete");
	assert.ok(out.result.supportedVersions.includes(MODERN_VERSION));
	assert.ok(out.result.supportedVersions.includes("2025-11-25"));
	assert.deepEqual(out.result.capabilities, { tools: {} });
	assert.equal(out.result._meta["io.modelcontextprotocol/serverInfo"].name, "catalyst-q-mcp");
	assert.equal(typeof out.result.ttlMs, "number");
	assert.equal(out.result.cacheScope, "public");
});

test("tools/list returns the six tools in a stable order with the cache fields", async () => {
	const { server } = setup(() => json({}));
	const out = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } });
	assert.deepEqual(out.result.tools.map((t) => t.name), ["suggest_where_catalyst_q_helps", "run_circuit", "sample_shots", "probability_of_outcomes", "score_device_counts", "expectation_values"]);
	assert.equal(out.result.resultType, "complete");
	assert.equal(out.result.cacheScope, "public");
	for (const tool of out.result.tools) {
		assert.equal(tool.inputSchema.type, "object");
		assert.match(tool.description, /Reach for|Use when/);
		assert.match(tool.description, /[Dd]o not use|do not use/);
		assert.equal(tool.check, undefined, "only the wire fields are listed");
	}
});

test("an unsupported version gets the error the spec names, listing what is supported", async () => {
	const { server } = setup(() => json({}));
	const out = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } });
	assert.equal(out.error.code, -32022);
	assert.equal(out.error.data.requested, "1900-01-01");
	assert.ok(out.error.data.supported.includes(MODERN_VERSION));
});

test("a request with no version and no handshake is told what to send", async () => {
	const { server } = setup(() => json({}));
	const out = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" });
	assert.equal(out.error.code, -32602);
	assert.match(out.error.message, /initialize/);
});

test("a legacy client gets the handshake and the older result shape", async () => {
	const { server } = setup(() => json({ ok: true, result: { probabilities: { "00": 0.5, "11": 0.5 } } }));
	const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
	assert.equal(init.result.protocolVersion, "2025-06-18");
	assert.deepEqual(init.result.capabilities, { tools: {} });
	assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
	const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.equal(list.result.resultType, undefined);
	assert.equal(list.result.tools.length, 6);
	const ping = await server.handle({ jsonrpc: "2.0", id: 3, method: "ping" });
	assert.deepEqual(ping.result, {});
	const run = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_circuit", arguments: { qasm: QASM } } });
	assert.equal(run.result.isError, false);
	assert.equal(run.result.resultType, undefined);
});

test("a legacy client asking for an unknown version gets the newest legacy revision", async () => {
	const { server } = setup(() => json({}));
	const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2020-01-01" } });
	assert.equal(init.result.protocolVersion, "2025-11-25");
});

test("ping is gone in the modern revision", async () => {
	const { server } = setup(() => json({}));
	const out = await server.handle({ jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: META } });
	assert.equal(out.error.code, -32601);
});

test("unknown method and malformed request", async () => {
	const { server } = setup(() => json({}));
	assert.equal((await server.handle({ jsonrpc: "2.0", id: 1, method: "nope", params: { _meta: META } })).error.code, -32601);
	assert.equal((await server.handle([1, 2])).error.code, -32600);
	assert.equal((await server.handle({ id: 1, method: "tools/list" })).error.code, -32600);
});

test("run_circuit answers with the reply as structured content", async () => {
	const reply = { ok: true, mode: "execute", record_id: "r1", permalink: "https://x/r1", inputs: {}, result: { probabilities: { "00": 0.5, "11": 0.5 } }, limits: { per_minute: 6, per_day: 60 } };
	const { server, calls } = setup(() => json(reply));
	const out = await call(server, "run_circuit", { qasm: QASM, measure: [0, 1] });
	assert.equal(out.result.isError, false);
	assert.equal(out.result.resultType, "complete");
	assert.equal(out.result.structuredContent.outcome, "answered");
	assert.equal(out.result.structuredContent.result.probabilities["11"], 0.5);
	assert.match(out.result.content[0].text, /"permalink"/);
	assert.ok(calls[0].url.endsWith("/api/v1/try"));
	assert.deepEqual(calls[0].body, { mode: "execute", qasm: QASM, measure: [0, 1] });
});

test("sample_shots, probability_of_outcomes, score_device_counts and expectation_values send the right bodies", async () => {
	const { server, calls } = setup(() => json({ ok: true, result: {} }));
	await call(server, "sample_shots", { qasm: QASM, shots: 10, seed: 3 });
	await call(server, "probability_of_outcomes", { qasm: QASM, outcomes: ["00"] });
	await call(server, "score_device_counts", { qasm: QASM, counts: { "00": 4 } });
	await call(server, "expectation_values", { qasm: QASM, observables: [{ type: "mean_z" }] });
	assert.deepEqual(calls.map((c) => c.body), [
		{ mode: "execute", qasm: QASM, shots: 10, seed: 3, sampling: "random" },
		{ mode: "execute", qasm: QASM, outcomes: ["00"] },
		{ mode: "score", qasm: QASM, counts: { "00": 4 } },
		{ mode: "circuit", qasm: QASM, observables: [{ type: "mean_z" }] },
	]);
});

test("with a key the account routes are used", async () => {
	const { server, calls } = setup(() => json({ ok: true, result: {} }), { apiKey: "cq_live_x" });
	await call(server, "score_device_counts", { qasm: QASM, counts: { "00": 4 } });
	assert.ok(calls[0].url.endsWith("/api/v1/score"));
	assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer cq_live_x");
});

test("a refusal is a normal tool result with its numbers", async () => {
	const { server } = setup(() => json({ error: "over_budget", detail: "This circuit needs more than the route allows.", needed: 9, allowed: 3 }, 422));
	const out = await call(server, "run_circuit", { qasm: QASM });
	assert.equal(out.error, undefined);
	assert.equal(out.result.isError, false);
	assert.equal(out.result.structuredContent.outcome, "refused");
	assert.equal(out.result.structuredContent.error, "over_budget");
	assert.deepEqual(out.result.structuredContent.numbers, { needed: 9, allowed: 3 });
	assert.match(out.result.content[0].text, /refused/);
	assert.match(out.result.content[0].text, /"needed": 9/);
});

test("a rate limit is a refusal that carries retry_after", async () => {
	const { server } = setup(() => json({ error: "rate_limited", detail: "Too many.", per_minute: 6 }, 429, { "retry-after": "20" }));
	const out = await call(server, "sample_shots", { qasm: QASM, shots: 5 });
	assert.equal(out.result.isError, false);
	assert.equal(out.result.structuredContent.retry_after, 20);
});

test("no reply is isError, and never looks like a result", async () => {
	const { server } = setup(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
	const out = await call(server, "run_circuit", { qasm: QASM });
	assert.equal(out.result.isError, true);
	assert.equal(out.result.structuredContent, undefined);
	assert.match(out.result.content[0].text, /No usable reply/);
});

test("bad input is isError and makes no request", async () => {
	const { server, calls } = setup(() => json({ ok: true }));
	const cases = [
		["run_circuit", {}],
		["sample_shots", { qasm: QASM }],
		["sample_shots", { qasm: QASM, shots: -1 }],
		["probability_of_outcomes", { qasm: QASM, outcomes: ["012"] }],
		["score_device_counts", { qasm: QASM, counts: {} }],
		["expectation_values", { qasm: "" }],
	];
	for (const [name, args] of cases) {
		const out = await call(server, name, args);
		assert.equal(out.result.isError, true, name);
		assert.match(out.result.content[0].text, /Bad input/);
	}
	assert.equal(calls.length, 0);
});

test("the suggest tool runs locally and says when nothing applies", async () => {
	const { server, calls } = setup(() => json({}));
	const hit = await call(server, "suggest_where_catalyst_q_helps", { goal: "Plan a QAOA run on quantum hardware" });
	assert.equal(hit.result.structuredContent.suggestions[0].id, "noiseless-before-hardware");
	const none = await call(server, "suggest_where_catalyst_q_helps", { goal: "Build a todo app" });
	assert.deepEqual(none.result.structuredContent.suggestions, []);
	assert.match(none.result.content[0].text, /nothing to suggest/);
	assert.equal(calls.length, 0);
});

test("an unknown tool is a protocol error", async () => {
	const { server } = setup(() => json({}));
	const out = await call(server, "nope", {});
	assert.equal(out.error.code, -32602);
});

test("over real stdio: one JSON message per line, and nothing else on stdout", async () => {
	const bin = fileURLToPath(new URL("../bin/catalyst-q-mcp.mjs", import.meta.url));
	const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, CATALYST_Q_BASE_URL: "http://127.0.0.1:9" } });
	let stdout = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	const closed = new Promise((resolve) => child.on("close", resolve));
	const waitFor = async (count) => {
		for (let i = 0; i < 200 && stdout.split("\n").filter(Boolean).length < count; i++) await new Promise((r) => setTimeout(r, 25));
	};
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } })}\n`);
	child.stdin.write("not json\n");
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } })}\n`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_circuit", arguments: { qasm: QASM }, _meta: META } })}\n`);
	await waitFor(4);
	child.stdin.end();
	await closed;
	const lines = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	assert.equal(lines.length, 4);
	const byId = new Map(lines.map((l) => [l.id, l]));
	assert.equal(byId.get(1).result.resultType, "complete");
	assert.equal(byId.get(null).error.code, -32700);
	assert.equal(byId.get(2).result.tools.length, 6);
	assert.equal(byId.get(3).result.isError, true, "an unreachable service is an error, not an answer");
});
