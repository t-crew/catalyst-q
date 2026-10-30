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
/** Named outcomes (`outcomes`), or random shots (`sampling: "random"` with `shots`). */
export type DistributedRequest = { qasm: string; measure?: number[]; outcomes?: string[]; sampling?: "random"; shots?: number; seed?: number };
export type DistributedShard = { shard_index: number; next: number | null } & Record<string, unknown>;
export type DistributedProgress = { shards_done: number; shards_total: number; hops: number; credits: number };
export type DistributedResult = { probabilities?: Record<string, number>; counts?: Record<string, number>; hops: number; credits: number; plan: { runs?: number; gates_across_cut?: number; work_total: number; credits_estimate: number } } & Record<string, unknown>;

export class CatalystQError extends Error {
	readonly status: number;
	/** The server's error code (e.g. `authentication_required`, `insufficient_credits`), or a client code:
	 * `non_json_response`, `timeout`, `network_error`. */
	readonly code: string;
	/** The server's explanation, or the client's. */
	readonly detail: string;
	/** The parsed error body when the server sent JSON; it keeps every extra field (credits, limits, docs link). */
	readonly body: Record<string, unknown> | null;
	/** Seconds to wait before retrying, from the `retry-after` header on 429 replies. */
	readonly retryAfter: number | null;

	constructor(status: number, code: string, detail: string, body: Record<string, unknown> | null = null, options: { retryAfter?: number | null; cause?: unknown } = {}) {
		super(`${code}${status ? ` (HTTP ${status})` : ""}: ${detail}`, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "CatalystQError";
		this.status = status;
		this.code = code;
		this.detail = detail;
		this.body = body;
		this.retryAfter = options.retryAfter ?? null;
	}

	/** True when the service answered with a reason (a JSON error body). False when no usable reply arrived. */
	get isRefusal(): boolean {
		return this.body !== null;
	}

	/** Every field of the refusal other than `ok`, `error` and `detail`: the numbers behind it. */
	get numbers(): Record<string, unknown> {
		const { ok: _ok, error: _error, detail: _detail, ...rest } = this.body ?? {};
		return rest;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Request and response types (as served by the API)
// ---------------------------------------------------------------------------------------------------------------

/** One gate in the list form of a circuit; the server turns the list into OpenQASM 3. */
export type GateSpec = {
	gate?: string; name?: string;
	qubits?: number[]; qubit?: number; control?: number; target?: number;
	params?: Array<number | string>;
};

/** An observable: a Pauli string on listed qubits, or a named average. With no observables the API reads mean Z. */
export type ObservableSpec = { pauli?: string; qubits?: number[]; type?: "mean_z" | "mean_zz" | "pauli" };

export type ObservablesRequest = {
	/** OpenQASM 2 or 3 source of a unitary circuit; or send `circuit` + `qubits`. */
	qasm?: string;
	circuit?: GateSpec[];
	qubits?: number;
	observables?: ObservableSpec[];
	/** Initial product state: one letter for every qubit, or one letter per qubit (e.g. "0", "+", "01+"). */
	initial?: string;
	/** Tolerance in [0, 0.01); the default is 1e-8. */
	tau?: number;
	/** Single-qubit depolarizing noise after every gate, probability in [0, 0.5]. */
	noise?: { depolarizing?: number };
};

export type ObservableValue = {
	observable: string;
	value: number;
	/** Bound on the error of `value`; 0 when the value is exact. */
	certificate: number;
	exact: boolean;
	/** Further per-value fields the API reports. */
	[field: string]: unknown;
};

export type Usage = { declared_qubits?: number; credits_charged: number; credits_remaining: number; duration_ms: number };
export type Account = { tier: string; key_id: string; via: "key" | "session" };

export type ObservablesResponse = {
	ok: true;
	record_id: string | null;
	permalink: string | null;
	result: {
		status: "completed";
		values: ObservableValue[];
		duration_ms: number;
		[field: string]: unknown;
	};
	usage: Usage;
	account: Account;
};

export type ExecuteRequest = {
	/** OpenQASM 2 or 3; terminal measurements choose which qubits are read. */
	qasm?: string;
	circuit?: GateSpec[];
	qubits?: number;
	shots?: number;
	/** Qubits to read when the source has no measurements. */
	measure?: number[];
	/** Ask for one Pauli expectation instead of a distribution: one letter of I/X/Y/Z per qubit from qubit 0. */
	observable?: { pauli: string };
	/** "random" returns real draws from the exact distribution, at any number of measured qubits. */
	sampling?: "random";
	/** Fixes the draws when `sampling` is "random". */
	seed?: number;
	/** Bit strings to price, classical bit 0 rightmost, up to 4096. */
	outcomes?: string[];
};

/** The full table of exact probabilities, up to 20 measured qubits. */
export type DistributionResult = {
	measured?: number[];
	probabilities: Record<string, number>;
	/** The probabilities scaled to `shots` and rounded. */
	counts?: Record<string, number>;
	method?: string;
	exact?: boolean;
	execution?: { fingerprint?: string; [field: string]: unknown };
	[field: string]: unknown;
};

/** Real draws from the exact distribution. */
export type SampleResult = {
	counts: Record<string, number>;
	seed?: number;
	method?: string;
	qubits_held?: number;
	/** What every outcome obeys, when the service can state it. */
	outcome_law?: { dimension?: number | string; constraints?: unknown; [field: string]: unknown };
	[field: string]: unknown;
};

/** The probability of each bit string asked for. */
export type OutcomesResult = {
	probabilities: Record<string, number>;
	[field: string]: unknown;
};

export type ScoreRequest = {
	qasm: string;
	/** Bit string to number of times seen, classical bit 0 rightmost. */
	counts: Record<string, number>;
	measure?: number[];
};

export type ScoreTable = {
	total_variation: number;
	hellinger_fidelity: number;
	/** What a perfect device would score at the same number of shots, when known. */
	perfect_device: { total_variation: number; hellinger_fidelity: number } | null;
};

export type DeviceScore = {
	shots: number;
	distinct_outcomes: number;
	measured: number | number[];
	xeb: { value: number; standard_error: number; ideal: number; fidelity_estimate: number };
	mean_log2_probability: number;
	/** Shots that landed on outcomes the circuit gives probability zero. */
	impossible_shots: number;
	table?: ScoreTable;
	note?: string;
	[field: string]: unknown;
};

export type ExecuteResponse = {
	ok: true;
	engine?: string;
	record_id?: string | null;
	permalink?: string | null;
	result: DistributionResult | SampleResult | OutcomesResult | Record<string, unknown>;
	usage?: Usage;
	account?: Account;
	[field: string]: unknown;
};

export type QecCoherentRequest = { distance?: number; epsilon?: number; epsilons?: number[] };

export type QecCoherentRow = {
	d: number; n: number; x_stabilizers: number; syndromes: number; epsilon: number;
	p_logical_coherent: number; p_logical_twirled: number; ratio: number; coherent_offdiagonal: number;
	logical_infidelity_coherent: number; logical_infidelity_twirled: number; normalization: number;
};

export type QecCoherentResponse = {
	ok: true;
	record_id: string | null;
	permalink: string | null;
	result: { status: "completed"; code: string; rows: QecCoherentRow[]; duration_ms: number; reference: Record<string, string>; [field: string]: unknown };
	usage: Usage;
	account: Account;
};

export type QecThresholdRequest = { distances?: number[]; ps?: number[]; shots?: number; noise?: "code_capacity" | "phenomenological"; seed?: number };

export type QecThresholdRow = { d: number; n: number; p: number; noise: "code_capacity" | "phenomenological"; rounds: number; shots: number; fails: number; p_L: number; ms: number };

export type QecThresholdResponse = {
	ok: true;
	result: { status: "completed" | "partial"; code: string; decoder: string; rows: QecThresholdRow[]; truncated: boolean; duration_ms: number; reference: string };
	usage: Usage;
	account: Account;
};

export type JobRequest = { kind: string; summary: string; payload?: unknown };
export type JobCreated = { ok: true; job_id: string; status: "requested"; next: string };
export type JobListing = { ok: true; jobs: Array<{ job_id: string; kind: string; summary: string; status: string; created_at: number }> };

export type UsageResponse = { ok: true; key_id: string; via: "key" | "session"; tier: string; credits_remaining: number; qubit_limit: number; [field: string]: unknown };

export type StoredRecord = {
	record_id: string;
	kind: string;
	created_at: number;
	site_version: string;
	inputs: Record<string, unknown>;
	result: Record<string, unknown>;
};

/** No-account runs: up to 64 qubits and 4,000 gates, rate-limited to 6 a minute and 60 a day per address. */
export type TryRequest =
	| { mode: "circuit"; qasm?: string; observables?: ObservableSpec[]; initial?: string; tau?: number }
	| { mode: "qec"; distance?: number; epsilon?: number }
	| { mode: "score"; qasm: string; counts: Record<string, number>; measure?: number[] }
	| { mode: "execute"; qasm?: string; measure?: number[]; shots?: number; sampling?: "random"; seed?: number; outcomes?: string[] };

export type TryResponse = {
	ok: true;
	mode: TryRequest["mode"];
	record_id: string | null;
	permalink: string | null;
	inputs: Record<string, unknown>;
	result: Record<string, unknown>;
	limits: { per_minute: number; per_day: number; [field: string]: unknown };
};

export type HealthResponse = { ok: true; service: string; version: string; sdk: string };

/** What a call that went either way comes to. See `settle()`. */
export type Settled<T> =
	| { kind: "answer"; reply: T }
	| { kind: "refusal"; status: number; code: string; detail: string; numbers: Record<string, unknown>; retryAfter: number | null }
	| { kind: "unreachable"; status: number; code: string; detail: string };

/**
 * Turns a call into a value. An answer and a refusal are both normal outcomes. `unreachable` means no usable
 * reply arrived, so nothing can be said about the circuit. Anything other than a `CatalystQError` is rethrown.
 */
export async function settle<T>(call: Promise<T>): Promise<Settled<T>> {
	try {
		return { kind: "answer", reply: await call };
	} catch (err) {
		if (!(err instanceof CatalystQError)) throw err;
		if (err.isRefusal) return { kind: "refusal", status: err.status, code: err.code, detail: err.detail, numbers: err.numbers, retryAfter: err.retryAfter };
		return { kind: "unreachable", status: err.status, code: err.code, detail: err.detail };
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------------------------

export type CatalystQOptions = {
	/** API key (`cq_live_...`). Defaults to the CATALYST_Q_KEY environment variable; pass null to send no key. */
	apiKey?: string | null;
	/** Defaults to https://catalyst-q.strategic-innovations.ai. */
	baseUrl?: string;
	/** A fetch implementation; defaults to the global fetch (Node 18+, browsers, Workers). */
	fetch?: typeof globalThis.fetch;
	/** Per-request timeout in milliseconds; default 120,000. */
	timeoutMs?: number;
};

type Method = "GET" | "POST";

function envKey(): string | undefined {
	const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
	return g.process?.env?.CATALYST_Q_KEY || undefined;
}

export class CatalystQ {
	readonly baseUrl: string;
	readonly timeoutMs: number;
	readonly qec: {
		/** Exact logical channel of a rotated surface code under a coherent rotation error (distance 3 or 5). */
		coherent: (body: QecCoherentRequest) => Promise<QecCoherentResponse>;
		/** Union-find threshold sweep under code-capacity or phenomenological noise. */
		threshold: (body: QecThresholdRequest) => Promise<QecThresholdResponse>;
	};
	readonly jobs: {
		/** Request a job larger than one call allows; it is scoped and priced by email, nothing is charged here. */
		create: (body: JobRequest) => Promise<JobCreated>;
		list: () => Promise<JobListing>;
	};
	readonly records: {
		/** A finished job's public record (inputs and outputs), by id. */
		get: (id: string) => Promise<StoredRecord>;
	};
	#apiKey: string | undefined;
	#fetch: typeof globalThis.fetch;

	constructor(options: CatalystQOptions = {}) {
		this.#apiKey = options.apiKey === null ? undefined : (options.apiKey || envKey());
		this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const f = options.fetch ?? globalThis.fetch;
		if (typeof f !== "function") throw new TypeError("No fetch available: use Node 18+ or pass options.fetch.");
		this.#fetch = f;
		this.qec = {
			coherent: (body) => this.#call<QecCoherentResponse>("POST", "/api/v1/qec/coherent", body, true),
			threshold: (body) => this.#call<QecThresholdResponse>("POST", "/api/v1/qec/threshold", body, true),
		};
		this.jobs = {
			create: (body) => this.#call<JobCreated>("POST", "/api/v1/jobs", body, true),
			list: () => this.#call<JobListing>("GET", "/api/v1/jobs", undefined, true),
		};
		this.records = {
			get: async (id) => {
				if (typeof id !== "string" || !id) throw new TypeError("records.get needs a record id");
				return this.#call<StoredRecord>("GET", `/api/v1/records/${encodeURIComponent(id)}`, undefined, false);
			},
		};
	}

	/** True when calls can use the routes that need a key. Without one, the routing methods use /api/v1/try. */
	get hasKey(): boolean {
		return Boolean(this.#apiKey);
	}

	// -------------------------------------------------------------------------------------------------------------
	// Routing methods: with a key they use the account routes, without one they use /api/v1/try.
	// -------------------------------------------------------------------------------------------------------------

	/** Run a circuit and get the full table of exact probabilities (up to 20 measured qubits). */
	run(body: { qasm: string; measure?: number[]; shots?: number }): Promise<ExecuteResponse | TryResponse> {
		return this.#route("/api/v1/execute", "execute", body);
	}

	/** Real draws from the exact distribution, at any number of measured qubits. */
	sample(body: { qasm: string; shots: number; seed?: number; measure?: number[] }): Promise<ExecuteResponse | TryResponse> {
		return this.#route("/api/v1/execute", "execute", { ...body, sampling: "random" });
	}

	/** The probability of each bit string you name (classical bit 0 rightmost, up to 4096 outcomes). */
	probabilityOf(body: { qasm: string; outcomes: string[]; measure?: number[] }): Promise<ExecuteResponse | TryResponse> {
		return this.#route("/api/v1/execute", "execute", body);
	}

	/** Compare counts you measured on a device against the exact distribution of the circuit. */
	score(body: ScoreRequest): Promise<(ExecuteResponse | TryResponse) & { result: { score: DeviceScore } & Record<string, unknown> }> {
		return this.#route("/api/v1/score", "score", body);
	}

	/** Expectation values of observables, each with `exact` and an error `certificate`. */
	expectationValues(body: { qasm: string; observables?: ObservableSpec[]; tau?: number }): Promise<ObservablesResponse | TryResponse> {
		return this.#route("/api/v1/observables", "circuit", body);
	}

	/** Logical channel of a rotated surface code under a coherent rotation error (distance 3 or 5). */
	surfaceCode(body: { distance: 3 | 5; epsilon: number }): Promise<QecCoherentResponse | TryResponse> {
		return this.#route("/api/v1/qec/coherent", "qec", body);
	}

	/**
	 * A job too large for one request: named outcomes on a hard circuit, or a very large number of shots. The job travels in
	 * its own payload, so this client carries it across as many requests as it needs, at the concurrency you choose, and any
	 * failed request can simply be sent again. The answer is the same to the last bit at any concurrency. Needs a key.
	 */
	async distributed(body: DistributedRequest, options: { concurrency?: number; onProgress?: (progress: DistributedProgress) => void } = {}): Promise<DistributedResult> {
		const planned = await this.#call<{ ok: true; plan: { job: unknown; shards: DistributedShard[]; work_total: number; runs?: number; gates_across_cut?: number }; credits_estimate: number }>("POST", "/api/v1/distributed/plan", body, true);
		const { job, shards } = planned.plan;
		const open = [...shards], done: DistributedShard[] = [];
		let hops = 0, credits = 0;
		const worker = async () => {
			for (let shard = open.shift(); shard; shard = open.shift()) {
				const reply = await this.#call<{ ok: true; shard: DistributedShard; usage?: { credits_charged?: number } }>("POST", "/api/v1/distributed/hop", { job, shard }, true);
				hops++;
				credits += reply.usage?.credits_charged ?? 0;
				(reply.shard.next === null ? done : open).push(reply.shard);
				options.onProgress?.({ shards_done: done.length, shards_total: shards.length, hops, credits });
			}
		};
		// A worker that finds the list empty stops, and a shard still in flight may add itself back, so go round until none is left.
		const width = Math.max(1, Math.floor(options.concurrency ?? 8));
		while (done.length < shards.length) await Promise.all(Array.from({ length: width }, worker));
		const fold = await this.#call<{ ok: true; result: Record<string, unknown> }>("POST", "/api/v1/distributed/fold", { job, shards: done }, true);
		return { ...fold.result, hops, credits, plan: { runs: planned.plan.runs, gates_across_cut: planned.plan.gates_across_cut, work_total: planned.plan.work_total, credits_estimate: planned.credits_estimate } };
	}

	// -------------------------------------------------------------------------------------------------------------
	// Account routes and the no-account route, directly.
	// -------------------------------------------------------------------------------------------------------------

	/** Expectation values of observables on a circuit. Each value carries `exact` and an error `certificate`. */
	observables(body: ObservablesRequest): Promise<ObservablesResponse> {
		return this.#call("POST", "/api/v1/observables", body, true);
	}

	/** Run a circuit: the distribution over the measured qubits, or one Pauli expectation with `observable`. */
	execute(body: ExecuteRequest): Promise<ExecuteResponse> {
		return this.#call("POST", "/api/v1/execute", body, true);
	}

	/** Credits, tier and qubit limit for the key in use. */
	usage(): Promise<UsageResponse> {
		return this.#call("GET", "/api/v1/usage", undefined, true);
	}

	/** A small job without an account (rate-limited per address; the key is not sent). */
	tryRun(body: TryRequest): Promise<TryResponse> {
		return this.#call("POST", "/api/v1/try", body, false);
	}

	/** Service name and deployed version. */
	health(): Promise<HealthResponse> {
		return this.#call("GET", "/api/health", undefined, false);
	}

	#route<T>(accountPath: string, tryMode: TryRequest["mode"], body: object): Promise<T> {
		if (this.#apiKey) return this.#call<T>("POST", accountPath, body, true);
		return this.#call<T>("POST", "/api/v1/try", { mode: tryMode, ...body }, false);
	}

	async #call<T>(method: Method, path: string, body: unknown, authenticated: boolean): Promise<T> {
		const headers: Record<string, string> = { accept: "application/json", "x-catalyst-sdk": `catalyst-q-js/${VERSION}` };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (authenticated && this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
		let response: Response;
		try {
			response = await this.#fetch(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (cause) {
			clearTimeout(timer);
			if (timedOut) throw new CatalystQError(0, "timeout", `No response from ${path} within ${this.timeoutMs} ms.`, null, { cause });
			throw new CatalystQError(0, "network_error", `Request to ${path} failed: ${(cause as Error)?.message ?? String(cause)}`, null, { cause });
		}
		let text: string;
		try {
			text = await response.text();
		} catch (cause) {
			clearTimeout(timer);
			if (timedOut) throw new CatalystQError(0, "timeout", `No complete response from ${path} within ${this.timeoutMs} ms.`, null, { cause });
			throw new CatalystQError(response.status, "network_error", `Reading the response from ${path} failed.`, null, { cause });
		}
		clearTimeout(timer);
		const retryAfterHeader = response.headers.get("retry-after");
		const retryAfter = retryAfterHeader !== null && retryAfterHeader.trim() !== "" && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) : null;
		const contentType = response.headers.get("content-type") || "";
		let parsed: unknown;
		const looksJson = /\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(contentType);
		try {
			if (!looksJson) throw new Error("not json");
			parsed = JSON.parse(text);
		} catch {
			throw new CatalystQError(response.status, "non_json_response",
				`Expected JSON from ${path}, got ${contentType || "no content-type"} (HTTP ${response.status}).`,
				null, { retryAfter });
		}
		const obj = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
		if (!response.ok || !obj || obj.ok === false) {
			const code = obj && typeof obj.error === "string" && obj.error ? obj.error : `http_${response.status}`;
			const detail = obj && typeof obj.detail === "string" ? obj.detail : (response.ok ? "The server replied ok: false." : `HTTP ${response.status}`);
			throw new CatalystQError(response.status, code, detail, obj, { retryAfter });
		}
		return obj as T;
	}
}
