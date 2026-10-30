// An MCP server over stdio: newline-delimited JSON-RPC 2.0.
//
// It serves both eras of the protocol, as the 2026-07-28 revision allows. A request carrying
// io.modelcontextprotocol/protocolVersion in _meta is served statelessly. An `initialize` request selects the
// handshake semantics of an earlier revision for the rest of this process.
//
// It is written against the wire format with no dependency, because the official SDK brings a web server and
// its stack along, and a stdio tool server needs none of that.
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { callTool, TOOLS } from "./tools.mjs";

const { version: SERVER_VERSION } = createRequire(import.meta.url)("../package.json");

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED = [MODERN_VERSION, ...LEGACY_VERSIONS];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_VERSION = -32022;

const INSTRUCTIONS = "Catalyst-Q is a hosted API that runs quantum circuits on classical hardware and returns exact answers, or refuses with the numbers. It is not a quantum computer. Call suggest_where_catalyst_q_helps first if you are unsure whether it applies. A refusal is a normal result. Set CATALYST_Q_KEY for wider circuits; with no key, calls use the no-account route.";

const SERVER_INFO = { name: "catalyst-q-mcp", title: "Catalyst-Q", version: SERVER_VERSION };

const toolListing = TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function createServer({ client }) {
	let legacyVersion = null;

	const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
	const fail = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });

	function modern(result, extra = {}) {
		return { resultType: "complete", ...result, ...extra, _meta: { [META_SERVER_INFO]: SERVER_INFO } };
	}

	async function handle(message) {
		if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
			return fail(isObject(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null, INVALID_REQUEST, "Expected one JSON-RPC 2.0 request per line.");
		}
		const { id, method } = message;
		const params = isObject(message.params) ? message.params : {};
		if (id === undefined || id === null) return null; // A notification. None of them change anything here.

		if (method === "initialize") {
			const asked = params.protocolVersion;
			legacyVersion = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0];
			return reply(id, { protocolVersion: legacyVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
		}

		const declared = isObject(params._meta) ? params._meta[META_VERSION] : undefined;
		if (declared !== undefined && !SUPPORTED.includes(declared)) {
			return fail(id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: SUPPORTED, requested: declared });
		}
		const isModern = declared === MODERN_VERSION;

		if (method === "server/discover") {
			return reply(id, modern({ supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: INSTRUCTIONS }, { ttlMs: 3_600_000, cacheScope: "public" }));
		}
		if (method === "ping" && !isModern && (legacyVersion || declared)) return reply(id, {});

		if (method !== "tools/list" && method !== "tools/call") return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);

		if (declared === undefined && !legacyVersion) {
			return fail(id, INVALID_PARAMS, `Send ${META_VERSION} in _meta, or call initialize first. Supported: ${SUPPORTED.join(", ")}.`);
		}

		if (method === "tools/list") {
			return reply(id, isModern ? modern({ tools: toolListing }, { ttlMs: 3_600_000, cacheScope: "public" }) : { tools: toolListing });
		}

		const tool = TOOLS.find((t) => t.name === params.name);
		if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
		const result = await callTool(tool, client, isObject(params.arguments) ? params.arguments : {});
		return reply(id, isModern ? modern(result) : result);
	}

	return { handle };
}

/** Reads one JSON-RPC message per line and writes one per line. Logging goes to stderr only. */
export function serveStdio(server, input, output) {
	const write = (message) => output.write(`${JSON.stringify(message)}\n`);
	const lines = createInterface({ input, crlfDelay: Infinity });
	lines.on("line", (line) => {
		if (!line.trim()) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Not valid JSON." } });
			return;
		}
		server.handle(message).then(
			(response) => { if (response) write(response); },
			(err) => {
				console.error(`catalyst-q-mcp: ${err?.stack ?? err}`);
				if (isObject(message) && message.id !== undefined && message.id !== null) write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error." } });
			},
		);
	});
	return lines;
}
