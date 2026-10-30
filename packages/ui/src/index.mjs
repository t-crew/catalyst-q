// The local side of the UI. One handler, two ways to reach it: a loopback port for `npx catalyst-q ui`, and a custom
// protocol in the desktop app. The page only ever talks to this handler, which holds any key and calls the API.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { CatalystQ, settle, DEFAULT_BASE_URL } from "catalyst-q";

export const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const WEB = new URL("../web/", import.meta.url);

const STATIC = new Map([
	["/", { url: new URL("index.html", WEB), type: "text/html; charset=utf-8", page: true }],
	["/styles.css", { url: new URL("styles.css", WEB), type: "text/css; charset=utf-8" }],
	["/app.mjs", { url: new URL("app.mjs", WEB), type: "text/javascript; charset=utf-8" }],
	["/format.mjs", { url: new URL("format.mjs", WEB), type: "text/javascript; charset=utf-8" }],
	["/chart.mjs", { url: new URL("chart.mjs", WEB), type: "text/javascript; charset=utf-8" }],
	["/examples.mjs", { url: new URL("examples.mjs", WEB), type: "text/javascript; charset=utf-8" }],
	["/advisor.mjs", { resolve: () => import.meta.resolve("catalyst-q-advisor"), type: "text/javascript; charset=utf-8" }],
	["/fonts/atkinson-next.woff2", { url: new URL("fonts/atkinson-next.woff2", WEB), type: "font/woff2", binary: true }],
	["/fonts/atkinson-mono.woff2", { url: new URL("fonts/atkinson-mono.woff2", WEB), type: "font/woff2", binary: true }],
]);

const ACTIONS = new Set(["run", "sample", "probabilityOf", "score", "expectationValues", "surfaceCode"]);

const securityHeaders = {
	"content-security-policy": CONTENT_SECURITY_POLICY,
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
};

function respond(body, status, type, extra = {}) {
	return new Response(body, { status, headers: { "content-type": type, ...securityHeaders, ...extra } });
}
const sendJson = (value, status = 200) => respond(JSON.stringify(value), status, "application/json; charset=utf-8");

/**
 * @param {object} options
 * @param {() => string | null | undefined | Promise<string | null | undefined>} [options.getKey] Where a key comes from, if any.
 * @param {string} [options.baseUrl] API address.
 * @param {typeof fetch} [options.fetch] A fetch implementation.
 * @param {"web" | "desktop"} [options.shell] Which shell is hosting the page.
 * @param {string} [options.token] Session token the page must send back. Generated when absent.
 */
export function createUiHandler({ getKey = () => null, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl, shell = "web", token = randomBytes(24).toString("hex") } = {}) {
	const makeClient = async () => new CatalystQ({ apiKey: (await getKey()) || null, baseUrl, fetch: fetchImpl });

	async function staticFile(entry) {
		const source = entry.url ?? new URL(entry.resolve());
		if (entry.binary) return respond(await readFile(source), 200, entry.type);
		let text = await readFile(source, "utf8");
		if (entry.page) text = text.replace("__SESSION_TOKEN__", token).replace("__SHELL__", shell);
		return respond(text, 200, entry.type);
	}

	async function status() {
		const client = await makeClient();
		const out = await settle(client.health());
		const account = client.hasKey ? "key" : "none";
		// Any reply from the service, even a refusal, means it is reachable.
		if (out.kind === "unreachable") return { online: false, code: out.code, detail: out.detail, base_url: client.baseUrl, account, shell };
		return { online: true, base_url: client.baseUrl, account, shell };
	}

	async function call(request) {
		let payload;
		try {
			payload = await request.json();
		} catch {
			return sendJson({ error: "bad_request", detail: "Expected a JSON body." }, 400);
		}
		const { action, body } = payload ?? {};
		if (!ACTIONS.has(action) || !body || typeof body !== "object") return sendJson({ error: "bad_request", detail: "Unknown action." }, 400);
		const client = await makeClient();
		return sendJson(await settle(client[action](body)));
	}

	return async function handle(request) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/local/")) {
			if (request.headers.get("x-catalyst-q-session") !== token) return sendJson({ error: "forbidden", detail: "Missing or wrong session token." }, 403);
			if (url.pathname === "/local/status" && request.method === "GET") return sendJson(await status());
			if (url.pathname === "/local/call" && request.method === "POST") return call(request);
			return sendJson({ error: "not_found" }, 404);
		}
		if (request.method !== "GET") return respond("Method not allowed", 405, "text/plain; charset=utf-8");
		const entry = STATIC.get(url.pathname);
		if (!entry) return respond("Not found", 404, "text/plain; charset=utf-8");
		return staticFile(entry);
	};
}

function hostAllowed(host, port) {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Puts the handler on 127.0.0.1. Requests naming any other Host are refused, which stops DNS rebinding. */
export function serveLocally(handler, { port = 0 } = {}) {
	return new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			try {
				const bound = server.address().port;
				if (!hostAllowed(req.headers.host, bound)) {
					res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
					res.end("Forbidden host");
					return;
				}
				const hasBody = req.method !== "GET" && req.method !== "HEAD";
				const request = new Request(`http://${req.headers.host}${req.url}`, {
					method: req.method,
					headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
					body: hasBody ? Readable.toWeb(req) : undefined,
					duplex: hasBody ? "half" : undefined,
				});
				const response = await handler(request);
				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(Buffer.from(await response.arrayBuffer()));
			} catch (err) {
				console.error(err);
				if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});
		server.on("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const { port: bound } = server.address();
			resolve({ url: `http://127.0.0.1:${bound}/`, port: bound, close: () => new Promise((done) => server.close(done)) });
		});
	});
}
