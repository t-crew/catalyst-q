import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createUiHandler, CONTENT_SECURITY_POLICY, serveLocally } from "../src/index.mjs";
import { axisTicks, formatNumber, formatValue, formFromSuggestion, inBitOrder, limitRows, outcomeRows, parseObservables, parseOutcomes, parseQubitList, refusalWords, scoreSentence } from "../web/format.mjs";

const TOKEN = "test-token";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function handlerWith(reply, options = {}) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
		return reply(calls.at(-1));
	};
	return { calls, handle: createUiHandler({ token: TOKEN, fetch, baseUrl: "https://api.test", ...options }) };
}

const get = (path, headers = {}) => new Request(`http://127.0.0.1:1${path}`, { headers });
const post = (path, body, headers = { "x-catalyst-q-session": TOKEN }) => new Request(`http://127.0.0.1:1${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the page is served with a strict CSP and the session token filled in", async () => {
	const { handle } = handlerWith(() => json({}));
	const response = await handle(get("/"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
	assert.match(CONTENT_SECURITY_POLICY, /default-src 'none'/);
	assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
	assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe/);
	const html = await response.text();
	assert.match(html, /content="test-token"/);
	assert.match(html, /What are you trying to do\?/);
	assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "no inline scripts");
	assert.doesNotMatch(html, /\sstyle=/, "no inline styles");
});

test("every static file the page needs is there, and nothing else is reachable", async () => {
	const { handle } = handlerWith(() => json({}));
	for (const path of ["/styles.css", "/app.mjs", "/format.mjs", "/chart.mjs", "/examples.mjs", "/advisor.mjs", "/fonts/atkinson-next.woff2", "/fonts/atkinson-mono.woff2"]) {
		const response = await handle(get(path));
		assert.equal(response.status, 200, path);
		assert.ok((await response.arrayBuffer()).byteLength > 0, path);
	}
	for (const path of ["/../package.json", "/src/index.mjs", "/fonts/OFL.txt", "/etc/passwd"]) {
		assert.equal((await handle(get(path))).status, 404, path);
	}
});

test("local routes refuse a request without the session token", async () => {
	const { handle, calls } = handlerWith(() => json({ ok: true }));
	assert.equal((await handle(get("/local/status"))).status, 403);
	assert.equal((await handle(post("/local/call", { action: "run", body: {} }, {}))).status, 403);
	assert.equal(calls.length, 0);
});

test("an answer comes back through settle", async () => {
	const { handle, calls } = handlerWith(() => json({ ok: true, result: { probabilities: { "00": 0.5, "11": 0.5 } }, permalink: "https://x/r/1" }));
	const response = await handle(post("/local/call", { action: "run", body: { qasm: "q" } }));
	const out = await response.json();
	assert.equal(out.kind, "answer");
	assert.equal(out.reply.permalink, "https://x/r/1");
	assert.equal(calls[0].url, "https://api.test/api/v1/try");
	assert.deepEqual(calls[0].body, { mode: "execute", qasm: "q" });
});

test("a refusal comes back as a value with its numbers and HTTP 200 to the page", async () => {
	const { handle } = handlerWith(() => json({ error: "too_many_gates", detail: "9000 gates; the limit is 4000.", gates: 9000, limit: 4000 }, 422));
	const response = await handle(post("/local/call", { action: "run", body: { qasm: "q" } }));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { kind: "refusal", status: 422, code: "too_many_gates", detail: "9000 gates; the limit is 4000.", numbers: { gates: 9000, limit: 4000 }, retryAfter: null });
});

test("a key stays on this side and never reaches the page", async () => {
	const { handle, calls } = handlerWith(() => json({ ok: true, service: "s", version: "v", sdk: "x", result: {} }), { getKey: () => "cq_live_secret" });
	const status = await (await handle(get("/local/status", { "x-catalyst-q-session": TOKEN }))).text();
	assert.doesNotMatch(status, /secret/);
	assert.match(status, /"account":"key"/);
	const html = await (await handle(get("/"))).text();
	assert.doesNotMatch(html, /secret/);
	await handle(post("/local/call", { action: "score", body: { qasm: "q", counts: { "0": 1 } } }));
	const last = calls.at(-1);
	assert.equal(last.url, "https://api.test/api/v1/score");
	assert.equal(new Headers(last.init.headers).get("authorization"), "Bearer cq_live_secret");
});

test("status says offline when the service cannot be reached, and does not pretend", async () => {
	const handle = createUiHandler({ token: TOKEN, baseUrl: "https://api.test", fetch: async () => { throw new TypeError("fetch failed"); } });
	const status = await (await handle(get("/local/status", { "x-catalyst-q-session": TOKEN }))).json();
	assert.equal(status.online, false);
	assert.equal(status.code, "network_error");
});

test("status counts a refusal reply as reachable", async () => {
	const { handle } = handlerWith(() => json({ error: "nope" }, 500));
	const status = await (await handle(get("/local/status", { "x-catalyst-q-session": TOKEN }))).json();
	assert.equal(status.online, true);
});

test("an unknown action or a bad body is rejected before any request", async () => {
	const { handle, calls } = handlerWith(() => json({ ok: true }));
	for (const body of [{ action: "usage", body: {} }, { action: "constructor", body: {} }, { action: "run" }]) {
		assert.equal((await handle(post("/local/call", body))).status, 400);
	}
	assert.equal(calls.length, 0);
});

test("serveLocally listens on loopback and refuses other Host headers", async (t) => {
	const { handle } = handlerWith(() => json({}));
	let server;
	try {
		server = await serveLocally(handle);
	} catch (err) {
		if (err.code === "EPERM") return t.skip("this sandbox does not allow listening on a port");
		throw err;
	}
	try {
		assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
		const ok = await fetch(server.url);
		assert.equal(ok.status, 200);
		assert.match(await ok.text(), /What are you trying to do/);
		const { request } = await import("node:http");
		const status = await new Promise((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port: server.port, path: "/", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
			req.on("error", reject);
			req.end();
		});
		assert.equal(status, 403);
		const posted = await fetch(`${server.url}local/call`, { method: "POST", headers: { "x-catalyst-q-session": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ action: "run", body: { qasm: "q" } }) });
		assert.equal((await posted.json()).kind, "answer");
	} finally {
		await server.close();
	}
});

// --- pure helpers -----------------------------------------------------------------------------------------------

test("formatNumber does not invent precision", () => {
	assert.equal(formatNumber(1000), "1,000");
	assert.equal(formatNumber(0.5), "0.5");
	assert.equal(formatNumber(0.1234567891), "0.123457");
	assert.equal(formatNumber(1.5e-9), "1.500e-9");
	assert.equal(formatNumber(0), "0");
	assert.equal(formatValue(null), "none");
	assert.equal(formatValue(true), "yes");
	assert.equal(formatValue({ a: 1 }), '{"a":1}');
});

test("outcomeRows prefers probabilities, sorts largest first, and handles nothing", () => {
	const both = outcomeRows({ probabilities: { "00": 0.25, "11": 0.75 }, counts: { "00": 1 } });
	assert.equal(both.unit, "probability");
	assert.deepEqual(both.rows.map((r) => r.outcome), ["11", "00"]);
	assert.equal(outcomeRows({ counts: { "01": 3 } }).unit, "count");
	assert.deepEqual(outcomeRows({}), { unit: null, rows: [] });
	assert.deepEqual(outcomeRows(null), { unit: null, rows: [] });
	assert.deepEqual(inBitOrder(both.rows).map((r) => r.outcome), ["00", "11"]);
});

test("limitRows keeps the top rows and adds up the rest", () => {
	const rows = Array.from({ length: 40 }, (_, i) => ({ outcome: String(i), value: 1 }));
	const { shown, hiddenCount, hiddenTotal } = limitRows(rows);
	assert.equal(shown.length, 32);
	assert.equal(hiddenCount, 8);
	assert.equal(hiddenTotal, 8);
	assert.equal(limitRows(rows.slice(0, 3)).hiddenCount, 0);
});

test("axisTicks are round and reach the maximum", () => {
	assert.deepEqual(axisTicks(0.5), [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
	assert.deepEqual(axisTicks(1), [0, 0.2, 0.4, 0.6, 0.8, 1]);
	assert.deepEqual(axisTicks(0), [0]);
	for (const max of [512, 0.73, 3, 1000, 1e-6, 999]) {
		const ticks = axisTicks(max);
		assert.equal(ticks[0], 0);
		assert.ok(ticks.at(-1) >= max, `the last tick covers ${max}: ${ticks}`);
		assert.ok(ticks.length <= 7, `few ticks for ${max}: ${ticks}`);
	}
});

test("parsers read what people type and return null on the rest", () => {
	assert.deepEqual(parseQubitList("0, 1 2"), [0, 1, 2]);
	assert.equal(parseQubitList("  "), undefined);
	assert.equal(parseQubitList("a"), null);
	assert.deepEqual(parseOutcomes("0101, 1100"), ["0101", "1100"]);
	assert.equal(parseOutcomes("012"), null);
	assert.equal(parseOutcomes(""), null);
	assert.deepEqual(parseObservables("ZZ on 0,1; mean_z"), [{ pauli: "ZZ", qubits: [0, 1] }, { type: "mean_z" }]);
	assert.equal(parseObservables("ZZ on 0"), null, "two letters need two qubits");
	assert.equal(parseObservables("nonsense"), null);
});

test("every refusal gets plain words, with a default for codes it does not know", () => {
	for (const code of ["rate_limited", "unknown_gate", "width_over_route_limit", "too_many_gates", "authentication_required", "insufficient_credits", "something_new"]) {
		const words = refusalWords(code);
		assert.ok(words.headline.length > 5);
		assert.ok(words.next.length > 5);
	}
	assert.match(refusalWords("rate_limited").next, /6 runs a minute and 60 a day/);
});

test("formFromSuggestion opens the right form for each action", () => {
	const of = (body) => formFromSuggestion({ action: { body } });
	assert.equal(of({ mode: "score", qasm: "q", counts: { "0": 1 } }).view, "score");
	assert.deepEqual(of({ mode: "qec", distance: 3, epsilon: 0.05 }), { view: "run", mode: "qec", distance: 3, epsilon: 0.05 });
	assert.equal(of({ mode: "circuit", qasm: "q", observables: [{ pauli: "ZZ", qubits: [0, 1] }, { type: "mean_z" }] }).observables, "ZZ on 0,1; mean_z");
	assert.equal(of({ mode: "execute", qasm: "q", sampling: "random", shots: 10, seed: 1 }).mode, "shots");
	assert.equal(of({ mode: "execute", qasm: "q", outcomes: ["<the output you expect>"] }).outcomes, "", "a placeholder is not put in the field");
	assert.equal(of({ mode: "execute", qasm: "q" }).mode, "probabilities");
});

test("scoreSentence only restates fields the service sent", () => {
	assert.match(scoreSentence({ shots: 1000, impossible_shots: 12 }), /12 of your 1,000 shots/);
	assert.match(scoreSentence({ shots: 1000, impossible_shots: 0 }), /None of your 1,000 shots/);
	assert.equal(scoreSentence({ shots: 5 }), "Scored 5 shots.");
	assert.equal(scoreSentence(null), "");
});

// --- the design tokens ------------------------------------------------------------------------------------------

function luminance(hex) {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
function hue(hex) {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) return null;
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return { hue: (h * 60 + 360) % 360, saturation: d / (1 - Math.abs(max + min - 1) || 1) };
}

const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
function tokens(blockStart) {
	const start = css.indexOf(blockStart);
	const block = css.slice(start, css.indexOf("}", start));
	return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
}
const THEMES = { light: tokens(":root {"), dark: tokens(':root[data-theme="dark"] {') };

for (const [name, t] of Object.entries(THEMES)) {
	test(`${name} theme: every text pairing reaches 4.5:1 and controls reach 3:1`, () => {
		for (const ground of ["paper", "surface", "sunken"]) {
			for (const text of ["ink", "muted", "refuse"]) {
				assert.ok(contrast(t[text], t[ground]) >= 4.5, `${text} on ${ground}: ${contrast(t[text], t[ground]).toFixed(2)}`);
			}
			assert.ok(contrast(t.control, t[ground]) >= 3, `control on ${ground}: ${contrast(t.control, t[ground]).toFixed(2)}`);
			assert.ok(contrast(t.pen, t[ground]) >= 3, `bars on ${ground}: ${contrast(t.pen, t[ground]).toFixed(2)}`);
		}
		assert.ok(contrast(t.pen, t.surface) >= 4.5, "link text on surface");
		assert.ok(contrast(t["on-ink"], t.ink) >= 4.5, "primary button text");
		assert.ok(contrast(t.refuse, t["refuse-soft"]) >= 3, "refusal heading ground");
		assert.ok(contrast(t.ink, t["refuse-soft"]) >= 4.5, "refusal text on its mark");
	});

	test(`${name} theme: nothing purple, indigo or violet`, () => {
		for (const [token, value] of Object.entries(t)) {
			const h = hue(value);
			if (!h || h.saturation < 0.1) continue;
			assert.ok(h.hue < 240 || h.hue > 300, `${token} ${value} has hue ${h.hue.toFixed(0)}`);
		}
	});
}

test("the dark tokens in the media query match the explicit dark theme", () => {
	const media = tokens(':root:not([data-theme="light"]) {');
	assert.deepEqual(media, THEMES.dark);
});

test("no colour literals outside the token blocks, and the banned face is absent", () => {
	const rules = css.slice(css.indexOf("* { box-sizing"));
	assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i);
	assert.doesNotMatch(css, /\bInter\b|Geist|Roboto/);
	assert.doesNotMatch(css, /text-transform:\s*uppercase/);
});
