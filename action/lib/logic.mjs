// The action's logic, with every outside effect passed in, so the tests can run offline.
import { settle } from "../vendor/catalyst-q.mjs";

const COMMENT_MARK = "<!-- catalyst-q-action -->";
const MAX_ROWS = 16;

/** Files changed in the pull request that end in .qasm and still exist. Uses the two commits in the event. */
export async function changedQasmFiles({ event, git }) {
	const base = event?.pull_request?.base?.sha;
	if (!base) return [];
	await git(["fetch", "--no-tags", "--depth=1", "origin", base]);
	const listed = await git(["diff", "--name-only", "--diff-filter=ACMR", "-z", base, "HEAD"]);
	return listed.split("\0").filter((name) => /\.qasm$/i.test(name)).sort();
}

const flatCounts = (value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const entries = Object.entries(value);
	if (!entries.length) return null;
	return entries.every(([key, n]) => /^[01]+$/.test(key) && typeof n === "number" && Number.isFinite(n) && n >= 0) ? value : null;
};

/** Reads the counts input. It takes {"00": 12} or {"counts": {"00": 12}}. Trouble is reported, not thrown. */
export async function loadCounts({ countsPath, circuitPath, readFile }) {
	const label = countsPath;
	if (!circuitPath) return { label, problem: "The counts-circuit input is required with counts, because counts can only be scored against the circuit that produced them." };
	let parsed;
	try {
		parsed = JSON.parse(await readFile(countsPath, "utf8"));
	} catch (err) {
		return { label, problem: `Could not read the counts file: ${err.code ?? err.message}` };
	}
	const counts = flatCounts(parsed) ?? flatCounts(parsed?.counts);
	if (!counts) return { label, problem: 'No counts found. The file should hold bit strings and numbers, like {"00": 498, "11": 502}.' };
	let qasm;
	try {
		qasm = await readFile(circuitPath, "utf8");
	} catch (err) {
		return { label, problem: `Could not read the circuit at ${circuitPath}: ${err.code ?? err.message}` };
	}
	return { label, qasm, counts, circuitPath };
}

function fromSettled(label, kind, out) {
	if (out.kind === "answer") return { label, kind, outcome: "answered", reply: out.reply };
	if (out.kind === "refusal") return { label, kind, outcome: "refused", code: out.code, status: out.status, detail: out.detail, numbers: out.numbers, retryAfter: out.retryAfter };
	return { label, kind, outcome: "unreachable", code: out.code, detail: out.detail };
}

/** Runs the files one at a time, then scores the counts. One call each, with no retries. */
export async function runAll({ files, counts, client, readFile, maxFiles = 6 }) {
	const room = counts && !counts.problem ? Math.max(0, maxFiles - 1) : maxFiles;
	const chosen = files.slice(0, room);
	const skipped = files.slice(room);
	const items = [];
	for (const file of chosen) {
		let qasm;
		try {
			qasm = await readFile(file, "utf8");
		} catch (err) {
			items.push({ label: file, kind: "circuit", outcome: "unreadable", detail: `Could not read the file: ${err.code ?? err.message}` });
			continue;
		}
		items.push(fromSettled(file, "circuit", await settle(client.run({ qasm }))));
	}
	if (counts) {
		if (counts.problem) items.push({ label: counts.label, kind: "counts", outcome: "unreadable", detail: counts.problem });
		else items.push(fromSettled(counts.label, "counts", await settle(client.score({ qasm: counts.qasm, counts: counts.counts }))));
	}
	return { items, skipped, consideredFiles: files.length };
}

/** Makes text from a file name or a reply safe inside a Markdown table cell or line. */
export function escapeMarkdown(value) {
	return String(value)
		.replace(/[\r\n]+/g, " ")
		.replace(/[\\`*_{}[\]<>()#+!|~]/g, (c) => `\\${c}`)
		.replace(/@/g, "@​");
}

function formatNumber(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
	if (Number.isInteger(value)) return value.toLocaleString("en-US");
	if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(3);
	return String(Number(value.toPrecision(6)));
}

function outcomeTable(map, heading) {
	const rows = Object.entries(map).filter(([, v]) => typeof v === "number").sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const lines = [`| Outcome | ${heading} |`, "|---|---:|"];
	for (const [outcome, value] of rows.slice(0, MAX_ROWS)) lines.push(`| \`${String(outcome).replace(/[`|]/g, "")}\` | ${formatNumber(value)} |`);
	if (rows.length > MAX_ROWS) lines.push(`| ${rows.length - MAX_ROWS} more | |`);
	return lines.join("\n");
}

function permalinkLine(reply) {
	const link = reply?.permalink;
	if (typeof link !== "string" || !/^https:\/\/[^\s)]+$/.test(link)) return "";
	return `\n\nRecord: ${link}`;
}

function renderAnswer(item) {
	const result = item.reply?.result ?? {};
	if (item.kind === "counts") {
		const score = result.score ?? {};
		const lines = [
			"| Measure | Value |", "|---|---:|",
			`| Shots | ${formatNumber(score.shots)} |`,
			`| Cross-entropy score | ${formatNumber(score.xeb?.value)} |`,
			`| Its standard error | ${formatNumber(score.xeb?.standard_error)} |`,
			`| Score a perfect device expects | ${formatNumber(score.xeb?.ideal)} |`,
			`| Fidelity estimate | ${formatNumber(score.xeb?.fidelity_estimate)} |`,
			`| Mean log2 probability | ${formatNumber(score.mean_log2_probability)} |`,
			`| Shots on impossible outcomes | ${formatNumber(score.impossible_shots)} |`,
		];
		if (score.table) {
			lines.push(`| Total variation | ${formatNumber(score.table.total_variation)} |`, `| Hellinger fidelity | ${formatNumber(score.table.hellinger_fidelity)} |`);
		}
		return lines.join("\n") + (score.note ? `\n\n${escapeMarkdown(score.note)}` : "") + permalinkLine(item.reply);
	}
	if (result.probabilities) return outcomeTable(result.probabilities, "Exact probability") + permalinkLine(item.reply);
	if (result.counts) return outcomeTable(result.counts, "Count") + permalinkLine(item.reply);
	return `The reply held no outcomes.${permalinkLine(item.reply)}`;
}

function renderRefusal(item) {
	const lines = [`The service refused this one (\`${String(item.code).replace(/`/g, "")}\`, HTTP ${item.status}). This is a normal result.`, "", `> ${escapeMarkdown(item.detail)}`];
	const numbers = Object.entries(item.numbers ?? {});
	if (numbers.length) {
		lines.push("", "| Field | Value |", "|---|---|");
		for (const [field, value] of numbers) lines.push(`| ${escapeMarkdown(field)} | ${escapeMarkdown(typeof value === "object" ? JSON.stringify(value) : value)} |`);
	}
	return lines.join("\n");
}

/** The job summary, and the comment if one is posted. */
export function renderSummary({ items, skipped = [], consideredFiles = 0, notes = [] }) {
	const parts = [COMMENT_MARK, "## Catalyst-Q"];
	for (const note of notes) parts.push(`> ${escapeMarkdown(note)}`);
	if (!items.length && !skipped.length) {
		parts.push(notes.length ? "Nothing was run." : "No changed .qasm files and no counts to score, so nothing was run.");
		return parts.join("\n\n");
	}
	for (const item of items) {
		parts.push(`### ${escapeMarkdown(item.label)}`);
		if (item.outcome === "answered") parts.push(renderAnswer(item));
		else if (item.outcome === "refused") parts.push(renderRefusal(item));
		else if (item.outcome === "unreadable") parts.push(`Not run. ${escapeMarkdown(item.detail)}`);
		else parts.push(`No usable reply from the service (\`${String(item.code).replace(/`/g, "")}\`), so nothing was checked. ${escapeMarkdown(item.detail)}`);
	}
	if (skipped.length) {
		parts.push(`${skipped.length} of ${consideredFiles} changed files were not run, because of the max-files limit: ${skipped.map(escapeMarkdown).join(", ")}`);
	}
	parts.push("Catalyst-Q is classical and noiseless. These results describe the circuits, not any device.");
	return parts.join("\n\n");
}

/** Decides the job's exit code. A refusal passes unless asked otherwise. No reply fails unless asked otherwise. */
export function chooseExitCode(tally, { failOnRefusal = false, failWhenUnreachable = true } = {}) {
	if (failOnRefusal && tally.refused > 0) return 1;
	if (failWhenUnreachable && (tally.unreachable > 0 || tally.unreadable > 0)) return 1;
	return 0;
}

/** Updates this action's earlier comment on the pull request, or adds one. Failure comes back as a value. */
export async function postOrUpdateComment({ token, repository, pull, markdown, apiUrl = "https://api.github.com", fetch }) {
	const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "catalyst-q-action" };
	const base = `${apiUrl}/repos/${repository}/issues`;
	try {
		const list = await fetch(`${base}/${pull}/comments?per_page=100`, { headers });
		if (!list.ok) return { ok: false, status: list.status };
		const existing = (await list.json()).find((comment) => typeof comment.body === "string" && comment.body.includes(COMMENT_MARK));
		const response = existing
			? await fetch(`${base}/comments/${existing.id}`, { method: "PATCH", headers, body: JSON.stringify({ body: markdown }) })
			: await fetch(`${base}/${pull}/comments`, { method: "POST", headers, body: JSON.stringify({ body: markdown }) });
		return { ok: response.ok, status: response.status, updated: Boolean(existing) };
	} catch (err) {
		return { ok: false, status: err.message };
	}
}
