import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile as readFileFs, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CatalystQ } from "../vendor/catalyst-q.mjs";
import { changedQasmFiles, chooseExitCode, escapeMarkdown, loadCounts, postOrUpdateComment, renderSummary, runAll } from "../lib/logic.mjs";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const QASM = "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];";

function clientWith(reply) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined, init });
		return reply(calls.at(-1));
	};
	return { calls, client: new CatalystQ({ apiKey: null, fetch }) };
}
const readFrom = (files) => async (path) => {
	if (path in files) return files[path];
	throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

test("changed files: fetches the base commit, diffs it, keeps only .qasm", async () => {
	const commands = [];
	const git = async (args) => {
		commands.push(args);
		return args[0] === "diff" ? "b.qasm\0src/app.js\0a/deep name.QASM\0" : "";
	};
	const files = await changedQasmFiles({ event: { pull_request: { base: { sha: "abc123" } } }, git });
	assert.deepEqual(files, ["a/deep name.QASM", "b.qasm"]);
	assert.deepEqual(commands[0], ["fetch", "--no-tags", "--depth=1", "origin", "abc123"]);
	assert.deepEqual(commands[1], ["diff", "--name-only", "--diff-filter=ACMR", "-z", "abc123", "HEAD"]);
});

test("changed files: outside a pull request there is nothing to diff", async () => {
	assert.deepEqual(await changedQasmFiles({ event: {}, git: async () => { throw new Error("not called"); } }), []);
});

test("an answer goes in the summary with its probabilities and record, without a secret anywhere", async () => {
	const { client, calls } = clientWith(() => json({ ok: true, permalink: "https://catalyst-q.strategic-innovations.ai/r/1", result: { probabilities: { "00": 0.5, "11": 0.5 } } }));
	const out = await runAll({ files: ["bell.qasm"], client, readFile: readFrom({ "bell.qasm": QASM }) });
	assert.equal(calls[0].url.endsWith("/api/v1/try"), true);
	assert.equal(new Headers(calls[0].init.headers).get("authorization"), null);
	assert.deepEqual(calls[0].body, { mode: "execute", qasm: QASM });
	const md = renderSummary(out);
	assert.match(md, /### bell\.qasm/);
	assert.match(md, /\| `00` \| 0\.5 \|/);
	assert.match(md, /Record: https:\/\/catalyst-q\.strategic-innovations\.ai\/r\/1/);
	assert.match(md, /describe the circuits, not any device/);
});

test("a refusal goes in the summary with its numbers, and the job passes", async () => {
	const { client } = clientWith(() => json({ error: "too_many_gates", detail: "9000 gates; the limit is 4000.", gates: 9000, limit: 4000 }, 422));
	const out = await runAll({ files: ["big.qasm"], client, readFile: readFrom({ "big.qasm": QASM }) });
	assert.equal(out.items[0].outcome, "refused");
	const md = renderSummary(out);
	assert.match(md, /refused this one \(`too_many_gates`, HTTP 422\)/);
	assert.match(md, /9000 gates; the limit is 4000\./);
	assert.match(md, /\| gates \| 9000 \|/);
	assert.equal(chooseExitCode({ answered: 0, refused: 1, unreachable: 0, unreadable: 0 }), 0);
	assert.equal(chooseExitCode({ answered: 0, refused: 1, unreachable: 0, unreadable: 0 }, { failOnRefusal: true }), 1);
});

test("no reply is reported as nothing checked, and fails unless told otherwise", async () => {
	const { client } = clientWith(() => { throw new TypeError("fetch failed"); });
	const out = await runAll({ files: ["a.qasm"], client, readFile: readFrom({ "a.qasm": QASM }) });
	assert.equal(out.items[0].outcome, "unreachable");
	assert.match(renderSummary(out), /nothing was checked/);
	assert.equal(chooseExitCode({ answered: 0, refused: 0, unreachable: 1, unreadable: 0 }), 1);
	assert.equal(chooseExitCode({ answered: 0, refused: 0, unreachable: 1, unreadable: 0 }, { failWhenUnreachable: false }), 0);
});

test("a file that cannot be read is reported and the others still run", async () => {
	const { client, calls } = clientWith(() => json({ ok: true, result: { probabilities: { "0": 1 } } }));
	const out = await runAll({ files: ["gone.qasm", "ok.qasm"], client, readFile: readFrom({ "ok.qasm": QASM }) });
	assert.equal(out.items[0].outcome, "unreadable");
	assert.equal(out.items[1].outcome, "answered");
	assert.equal(calls.length, 1);
});

test("files past the limit are named as not run, and there are no retries", async () => {
	const { client, calls } = clientWith(() => json({ error: "rate_limited", detail: "Too many." }, 429, { "retry-after": "30" }));
	const names = Array.from({ length: 8 }, (_, i) => `f${i}.qasm`);
	const out = await runAll({ files: names, client, readFile: readFrom(Object.fromEntries(names.map((n) => [n, QASM]))), maxFiles: 6 });
	assert.equal(calls.length, 6);
	const md = renderSummary(out);
	assert.match(md, /2 of 8 changed files were not run/);
	assert.match(md, /f7\\?\.qasm/);
});

test("counts: scored against the named circuit through the no-account route", async () => {
	const counts = await loadCounts({ countsPath: "c.json", circuitPath: "bell.qasm", readFile: readFrom({ "c.json": '{"counts":{"00":498,"11":502}}', "bell.qasm": QASM }) });
	const score = { shots: 1000, distinct_outcomes: 2, measured: 2, xeb: { value: 0.98, standard_error: 0.03, ideal: 1, fidelity_estimate: 0.98 }, mean_log2_probability: -1, impossible_shots: 0, table: { total_variation: 0.002, hellinger_fidelity: 0.999, perfect_device: null }, note: "A note." };
	const { client, calls } = clientWith(() => json({ ok: true, result: { score } }));
	const out = await runAll({ files: [], counts, client, readFile: readFrom({}) });
	assert.deepEqual(calls[0].body, { mode: "score", qasm: QASM, counts: { "00": 498, "11": 502 } });
	const md = renderSummary(out);
	assert.match(md, /Cross-entropy score \| 0\.98/);
	assert.match(md, /impossible outcomes \| 0/);
	assert.match(md, /Hellinger fidelity \| 0\.999/);
	assert.match(md, /A note\./);
});

test("counts: the scoring call takes one slot of the file limit", async () => {
	const counts = { label: "c.json", qasm: QASM, counts: { "0": 1 } };
	const { client, calls } = clientWith(() => json({ ok: true, result: {} }));
	const names = ["a.qasm", "b.qasm", "c.qasm"];
	const out = await runAll({ files: names, counts, client, readFile: readFrom(Object.fromEntries(names.map((n) => [n, QASM]))), maxFiles: 2 });
	assert.equal(calls.length, 2);
	assert.deepEqual(out.skipped, ["b.qasm", "c.qasm"]);
});

test("counts: problems are reported in plain words, with no request", async () => {
	const read = readFrom({ "bad.json": '{"hello":1}', "notjson.json": "{", "ok.json": '{"00":1}' });
	const cases = [
		[{ countsPath: "ok.json", circuitPath: "" }, /counts-circuit input is required/],
		[{ countsPath: "bad.json", circuitPath: "x.qasm" }, /No counts found/],
		[{ countsPath: "notjson.json", circuitPath: "x.qasm" }, /Could not read the counts/],
		[{ countsPath: "ok.json", circuitPath: "gone.qasm" }, /Could not read the circuit/],
	];
	for (const [input, pattern] of cases) {
		const counts = await loadCounts({ ...input, readFile: read });
		assert.match(counts.problem, pattern);
		const { client, calls } = clientWith(() => json({ ok: true }));
		const out = await runAll({ files: [], counts, client, readFile: read });
		assert.equal(out.items[0].outcome, "unreadable");
		assert.equal(calls.length, 0);
	}
});

test("nothing to do says so", () => {
	assert.match(renderSummary({ items: [] }), /nothing was run/);
});

test("untrusted text cannot inject Markdown, links or mentions", () => {
	assert.equal(escapeMarkdown("a|b"), "a\\|b");
	assert.doesNotMatch(escapeMarkdown("@everyone"), /@e/);
	assert.doesNotMatch(escapeMarkdown("<img src=x>"), /(^|[^\\])</);
	assert.doesNotMatch(escapeMarkdown("line\nbreak"), /\n/);
	const md = renderSummary({ items: [{ label: "x|<img>.qasm", kind: "circuit", outcome: "refused", code: "c`x", status: 400, detail: "[click](http://evil) @you", numbers: { "a|b": "<b>" } }] });
	assert.doesNotMatch(md, /\[click\]\(http/);
	assert.doesNotMatch(md, /<img>/);
	const noLink = renderSummary({ items: [{ label: "a.qasm", kind: "circuit", outcome: "answered", reply: { permalink: "javascript:alert(1)", result: { probabilities: { "0": 1 } } } }] });
	assert.doesNotMatch(noLink, /javascript/);
});

test("the comment is added the first time and updated after that", async () => {
	const seen = [];
	const fetch = async (url, init = {}) => {
		seen.push({ url, method: init.method ?? "GET", body: init.body && JSON.parse(init.body) });
		if ((init.method ?? "GET") === "GET") return json(seen.length === 1 ? [{ id: 1, body: "someone else" }] : [{ id: 77, body: "<!-- catalyst-q-action --> old" }]);
		return json({}, 201);
	};
	const first = await postOrUpdateComment({ token: "t", repository: "o/r", pull: 5, markdown: "m1", fetch });
	assert.deepEqual(first, { ok: true, status: 201, updated: false });
	assert.equal(seen[1].method, "POST");
	assert.equal(seen[1].url, "https://api.github.com/repos/o/r/issues/5/comments");
	const second = await postOrUpdateComment({ token: "t", repository: "o/r", pull: 5, markdown: "m2", fetch });
	assert.equal(second.updated, true);
	assert.equal(seen[3].method, "PATCH");
	assert.equal(seen[3].url, "https://api.github.com/repos/o/r/issues/comments/77");
	assert.deepEqual(seen[3].body, { body: "m2" });
});

test("a comment that cannot be posted comes back as a value, not a throw", async () => {
	const forbidden = async () => json({ message: "Resource not accessible" }, 403);
	assert.deepEqual(await postOrUpdateComment({ token: "t", repository: "o/r", pull: 5, markdown: "m", fetch: forbidden }), { ok: false, status: 403 });
	const down = async () => { throw new TypeError("offline"); };
	assert.equal((await postOrUpdateComment({ token: "t", repository: "o/r", pull: 5, markdown: "m", fetch: down })).ok, false);
});

test("run.mjs end to end with explicit paths: writes the summary and outputs, and fails when nothing was checked", async () => {
	const dir = await mkdtemp(join(tmpdir(), "action-"));
	try {
		await writeFile(join(dir, "a.qasm"), QASM);
		const summary = join(dir, "summary.md");
		const output = join(dir, "output.txt");
		await writeFile(summary, "");
		await writeFile(output, "");
		const entry = fileURLToPath(new URL("../run.mjs", import.meta.url));
		const child = spawn(process.execPath, [entry], {
			cwd: dir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, CQ_PATHS: "a.qasm", CQ_BASE_URL: "http://127.0.0.1:59999", CQ_MAX_FILES: "6" },
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		const code = await new Promise((resolve) => child.on("close", resolve));
		assert.equal(code, 1);
		assert.match(await readFileFs(summary, "utf8"), /nothing was checked/);
		assert.match(await readFileFs(output, "utf8"), /unreachable=1/);
		assert.match(stdout, /::warning::a\.qasm/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
