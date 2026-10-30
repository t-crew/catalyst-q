/**
 * catalyst-q: a small client for the Catalyst-Q HTTP API (https://catalyst-q.strategic-innovations.ai).
 *
 * Every method sends one HTTPS request and returns the server's JSON. Request and response types follow the
 * API. A reply that is not JSON, or that says `ok: false`, is raised as a `CatalystQError`; nothing is
 * returned that the server did not send.
 *
 * The service refuses work it cannot answer exactly, and a refusal carries the numbers behind it. `settle()`
 * turns any call into a plain value, so a refusal can be shown as the result it is.
 */
export const VERSION = "0.2.0";
export const DEFAULT_BASE_URL = "https://catalyst-q.strategic-innovations.ai";
const DEFAULT_TIMEOUT_MS = 120_000;
// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------
/** Raised for every failed call. `status` is the HTTP status (0 when no response arrived). */
export class CatalystQError extends Error {
    status;
    /** The server's error code (e.g. `authentication_required`, `insufficient_credits`), or a client code:
     * `non_json_response`, `timeout`, `network_error`. */
    code;
    /** The server's explanation, or the client's. */
    detail;
    /** The parsed error body when the server sent JSON; it keeps every extra field (credits, limits, docs link). */
    body;
    /** Seconds to wait before retrying, from the `retry-after` header on 429 replies. */
    retryAfter;
    constructor(status, code, detail, body = null, options = {}) {
        super(`${code}${status ? ` (HTTP ${status})` : ""}: ${detail}`, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "CatalystQError";
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.body = body;
        this.retryAfter = options.retryAfter ?? null;
    }
    /** True when the service answered with a reason (a JSON error body). False when no usable reply arrived. */
    get isRefusal() {
        return this.body !== null;
    }
    /** Every field of the refusal other than `ok`, `error` and `detail`: the numbers behind it. */
    get numbers() {
        const { ok: _ok, error: _error, detail: _detail, ...rest } = this.body ?? {};
        return rest;
    }
}
/**
 * Turns a call into a value. An answer and a refusal are both normal outcomes. `unreachable` means no usable
 * reply arrived, so nothing can be said about the circuit. Anything other than a `CatalystQError` is rethrown.
 */
export async function settle(call) {
    try {
        return { kind: "answer", reply: await call };
    }
    catch (err) {
        if (!(err instanceof CatalystQError))
            throw err;
        if (err.isRefusal)
            return { kind: "refusal", status: err.status, code: err.code, detail: err.detail, numbers: err.numbers, retryAfter: err.retryAfter };
        return { kind: "unreachable", status: err.status, code: err.code, detail: err.detail };
    }
}
function envKey() {
    const g = globalThis;
    return g.process?.env?.CATALYST_Q_KEY || undefined;
}
export class CatalystQ {
    baseUrl;
    timeoutMs;
    qec;
    jobs;
    records;
    #apiKey;
    #fetch;
    constructor(options = {}) {
        this.#apiKey = options.apiKey === null ? undefined : (options.apiKey || envKey());
        this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const f = options.fetch ?? globalThis.fetch;
        if (typeof f !== "function")
            throw new TypeError("No fetch available: use Node 18+ or pass options.fetch.");
        this.#fetch = f;
        this.qec = {
            coherent: (body) => this.#call("POST", "/api/v1/qec/coherent", body, true),
            threshold: (body) => this.#call("POST", "/api/v1/qec/threshold", body, true),
        };
        this.jobs = {
            create: (body) => this.#call("POST", "/api/v1/jobs", body, true),
            list: () => this.#call("GET", "/api/v1/jobs", undefined, true),
        };
        this.records = {
            get: async (id) => {
                if (typeof id !== "string" || !id)
                    throw new TypeError("records.get needs a record id");
                return this.#call("GET", `/api/v1/records/${encodeURIComponent(id)}`, undefined, false);
            },
        };
    }
    /** True when calls can use the routes that need a key. Without one, the routing methods use /api/v1/try. */
    get hasKey() {
        return Boolean(this.#apiKey);
    }
    // -------------------------------------------------------------------------------------------------------------
    // Routing methods: with a key they use the account routes, without one they use /api/v1/try.
    // -------------------------------------------------------------------------------------------------------------
    /** Run a circuit and get the full table of exact probabilities (up to 20 measured qubits). */
    run(body) {
        return this.#route("/api/v1/execute", "execute", body);
    }
    /** Real draws from the exact distribution, at any number of measured qubits. */
    sample(body) {
        return this.#route("/api/v1/execute", "execute", { ...body, sampling: "random" });
    }
    /** The probability of each bit string you name (classical bit 0 rightmost, up to 4096 outcomes). */
    probabilityOf(body) {
        return this.#route("/api/v1/execute", "execute", body);
    }
    /** Compare counts you measured on a device against the exact distribution of the circuit. */
    score(body) {
        return this.#route("/api/v1/score", "score", body);
    }
    /** Expectation values of observables, each with `exact` and an error `certificate`. */
    expectationValues(body) {
        return this.#route("/api/v1/observables", "circuit", body);
    }
    /** Logical channel of a rotated surface code under a coherent rotation error (distance 3 or 5). */
    surfaceCode(body) {
        return this.#route("/api/v1/qec/coherent", "qec", body);
    }
    // -------------------------------------------------------------------------------------------------------------
    // Account routes and the no-account route, directly.
    // -------------------------------------------------------------------------------------------------------------
    /** Expectation values of observables on a circuit. Each value carries `exact` and an error `certificate`. */
    observables(body) {
        return this.#call("POST", "/api/v1/observables", body, true);
    }
    /** Run a circuit: the distribution over the measured qubits, or one Pauli expectation with `observable`. */
    execute(body) {
        return this.#call("POST", "/api/v1/execute", body, true);
    }
    /** Credits, tier and qubit limit for the key in use. */
    usage() {
        return this.#call("GET", "/api/v1/usage", undefined, true);
    }
    /** A small job without an account (rate-limited per address; the key is not sent). */
    tryRun(body) {
        return this.#call("POST", "/api/v1/try", body, false);
    }
    /** Service name and deployed version. */
    health() {
        return this.#call("GET", "/api/health", undefined, false);
    }
    #route(accountPath, tryMode, body) {
        if (this.#apiKey)
            return this.#call("POST", accountPath, body, true);
        return this.#call("POST", "/api/v1/try", { mode: tryMode, ...body }, false);
    }
    async #call(method, path, body, authenticated) {
        const headers = { accept: "application/json", "x-catalyst-sdk": `catalyst-q-js/${VERSION}` };
        if (body !== undefined)
            headers["content-type"] = "application/json";
        if (authenticated && this.#apiKey)
            headers.authorization = `Bearer ${this.#apiKey}`;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
        let response;
        try {
            response = await this.#fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
        }
        catch (cause) {
            clearTimeout(timer);
            if (timedOut)
                throw new CatalystQError(0, "timeout", `No response from ${path} within ${this.timeoutMs} ms.`, null, { cause });
            throw new CatalystQError(0, "network_error", `Request to ${path} failed: ${cause?.message ?? String(cause)}`, null, { cause });
        }
        let text;
        try {
            text = await response.text();
        }
        catch (cause) {
            clearTimeout(timer);
            if (timedOut)
                throw new CatalystQError(0, "timeout", `No complete response from ${path} within ${this.timeoutMs} ms.`, null, { cause });
            throw new CatalystQError(response.status, "network_error", `Reading the response from ${path} failed.`, null, { cause });
        }
        clearTimeout(timer);
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfter = retryAfterHeader !== null && retryAfterHeader.trim() !== "" && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) : null;
        const contentType = response.headers.get("content-type") || "";
        let parsed;
        const looksJson = /\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(contentType);
        try {
            if (!looksJson)
                throw new Error("not json");
            parsed = JSON.parse(text);
        }
        catch {
            throw new CatalystQError(response.status, "non_json_response", `Expected JSON from ${path}, got ${contentType || "no content-type"} (HTTP ${response.status}).`, null, { retryAfter });
        }
        const obj = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : null;
        if (!response.ok || !obj || obj.ok === false) {
            const code = obj && typeof obj.error === "string" && obj.error ? obj.error : `http_${response.status}`;
            const detail = obj && typeof obj.detail === "string" ? obj.detail : (response.ok ? "The server replied ok: false." : `HTTP ${response.status}`);
            throw new CatalystQError(response.status, code, detail, obj, { retryAfter });
        }
        return obj;
    }
}
