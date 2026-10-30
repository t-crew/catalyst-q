// The page. Everything it shows comes from the advisor, which runs right here, or from a reply the service sent.
// Server text only ever goes in through textContent.
import { suggest, extractCounts } from "./advisor.mjs";
import { renderOutcomes } from "./chart.mjs";
import { EXAMPLES, GOAL_STARTERS } from "./examples.mjs";
import { formatNumber, formatValue, formFromSuggestion, outcomeRows, parseObservables, parseOutcomes, parseQubitList, refusalWords, scoreSentence } from "./format.mjs";

const SESSION = document.querySelector('meta[name="catalyst-q-session"]').content;
const $ = (id) => document.getElementById(id);
const desktop = window.catalystQDesktop ?? null;

const el = (tag, className, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};

// --- talking to the local handler -------------------------------------------------------------------------------

const localHeaders = { "x-catalyst-q-session": SESSION };

async function localCall(action, body) {
	try {
		const response = await fetch("local/call", { method: "POST", headers: { ...localHeaders, "content-type": "application/json" }, body: JSON.stringify({ action, body }) });
		return await response.json();
	} catch (err) {
		return { kind: "unreachable", code: "local_error", detail: String(err?.message ?? err) };
	}
}

// --- views ------------------------------------------------------------------------------------------------------

function showView(name) {
	for (const tab of document.querySelectorAll(".tab")) {
		if (tab.dataset.view === name) tab.setAttribute("aria-current", "page");
		else tab.removeAttribute("aria-current");
	}
	for (const view of ["ask", "run", "score"]) $(`view-${view}`).hidden = view !== name;
	window.scrollTo({ top: 0 });
}
for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showView(tab.dataset.view));

// --- connection -------------------------------------------------------------------------------------------------

let accountState = "none";

async function checkConnection() {
	const line = $("connection");
	let status;
	try {
		const response = await fetch("local/status", { headers: localHeaders });
		status = await response.json();
	} catch {
		status = { online: false };
	}
	line.replaceChildren();
	if (status.online) {
		line.classList.remove("offline");
		line.textContent = `Connected to ${new URL(status.base_url).host}`;
	} else {
		line.classList.add("offline");
		line.append("You are offline, so nothing can run. ");
		const retry = el("button", "link-button", "Check again");
		retry.type = "button";
		retry.addEventListener("click", checkConnection);
		line.append(retry);
	}
	accountState = status.account ?? "none";
	renderKeyPanel();
	return status;
}
window.addEventListener("online", checkConnection);
window.addEventListener("offline", checkConnection);

// --- the advisor ------------------------------------------------------------------------------------------------

const droppedFiles = new Map();

function renderAdvice() {
	const result = suggest({ goal: $("goal").value, files: [...droppedFiles.values()] });
	const host = $("advice");
	host.replaceChildren();
	const hasInput = $("goal").value.trim() !== "" || droppedFiles.size > 0;
	if (!hasInput) return;
	host.append(el("p", "advice-note", result.message));
	for (const suggestion of result.suggestions) host.append(renderSuggestion(suggestion));
}

function renderSuggestion(suggestion) {
	const card = el("article", "suggestion");
	card.append(el("h2", "", suggestion.title));
	card.append(el("p", "why", suggestion.why));
	const not = el("p", "not");
	not.append(el("strong", "", "When not to: "), suggestion.when_not);
	card.append(not);
	card.append(el("p", "noticed", `Noticed: ${suggestion.evidence.join("; ")}.`));
	const actions = el("div", "suggestion-actions");
	const form = suggestion.action.body ? formFromSuggestion(suggestion) : null;
	if (form) {
		const open = el("button", "secondary", form.view === "score" ? "Open the scoring screen" : "Set this up to run");
		open.type = "button";
		open.addEventListener("click", () => applyForm(form));
		actions.append(open);
	}
	if (suggestion.action.command) card.append(el("pre", "example", suggestion.action.command));
	card.append(actions);
	return card;
}

function applyForm(form) {
	if (form.view === "score") {
		if (form.qasm) $("score-qasm").value = form.qasm;
		if (form.counts) $("score-counts").value = JSON.stringify(form.counts, null, 2);
		noteCounts();
		showView("score");
		return;
	}
	if (form.qasm) $("qasm").value = form.qasm;
	document.querySelector(`input[name="mode"][value="${form.mode}"]`).checked = true;
	if (form.shots) $("shots").value = form.shots;
	if (form.seed !== undefined) $("seed").value = form.seed;
	if (form.outcomes !== undefined) $("outcomes").value = form.outcomes;
	if (form.observables !== undefined) $("observables").value = form.observables;
	if (form.distance) $("distance").value = String(form.distance);
	if (form.epsilon !== undefined) $("epsilon").value = form.epsilon;
	syncModeFields();
	showView("run");
}

function renderDropped() {
	const list = $("ask-dropped");
	list.replaceChildren();
	for (const name of droppedFiles.keys()) {
		const item = el("li", "", name);
		const remove = el("button", "", "Remove");
		remove.type = "button";
		remove.setAttribute("aria-label", `Remove ${name}`);
		remove.addEventListener("click", () => { droppedFiles.delete(name); renderDropped(); renderAdvice(); });
		item.append(remove);
		list.append(item);
	}
}

const MAX_FILE = 256 * 1024;

async function addFiles(fileList) {
	for (const file of fileList) {
		const content = file.size <= MAX_FILE ? await file.text() : "";
		droppedFiles.set(file.name, { name: file.name, content });
		if (/\.qasm$/i.test(file.name) && content) $("qasm").value = content;
	}
	renderDropped();
	renderAdvice();
}

function wireDrop(zone, onFiles) {
	zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("over"); });
	zone.addEventListener("dragleave", () => zone.classList.remove("over"));
	zone.addEventListener("drop", (event) => {
		event.preventDefault();
		zone.classList.remove("over");
		if (event.dataTransfer?.files?.length) onFiles(event.dataTransfer.files);
	});
}

$("goal").addEventListener("input", renderAdvice);
wireDrop($("ask-drop"), addFiles);
$("ask-drop").addEventListener("click", () => $("ask-file").click());
$("ask-drop").addEventListener("keydown", (event) => {
	if (event.key === "Enter" || event.key === " ") { event.preventDefault(); $("ask-file").click(); }
});
$("ask-file").addEventListener("click", (event) => event.stopPropagation());
$("ask-file").addEventListener("change", (event) => addFiles(event.target.files));

for (const text of GOAL_STARTERS) {
	const starter = el("button", "starter", text);
	starter.type = "button";
	starter.addEventListener("click", () => { $("goal").value = text; renderAdvice(); $("goal").focus(); });
	$("starters").append(starter);
}

// --- run view ---------------------------------------------------------------------------------------------------

for (const example of EXAMPLES) {
	const option = el("option", "", example.name);
	option.value = example.id;
	$("example").append(option);
}
$("example").addEventListener("change", (event) => {
	const example = EXAMPLES.find((e) => e.id === event.target.value);
	if (!example) return;
	$("qasm").value = example.qasm;
	$("measure").value = example.measure;
	$("shots-measure").value = example.measure;
	$("outcomes-measure").value = example.measure;
	event.target.value = "";
});

const currentMode = () => document.querySelector('input[name="mode"]:checked').value;

function syncModeFields() {
	const mode = currentMode();
	for (const name of ["probabilities", "shots", "outcomes", "expectation", "qec"]) $(`fields-${name}`).hidden = name !== mode;
}
for (const radio of document.querySelectorAll('input[name="mode"]')) radio.addEventListener("change", syncModeFields);

async function readInto(target, file, after) {
	target.value = await file.text();
	after?.();
}
$("run-file").addEventListener("change", (event) => { if (event.target.files[0]) readInto($("qasm"), event.target.files[0]); });
wireDrop($("qasm"), (files) => readInto($("qasm"), files[0]));

function fieldError(id, message) {
	const node = $(id);
	node.textContent = message ?? "";
	node.hidden = !message;
}

function buildRunRequest() {
	const mode = currentMode();
	const qasm = $("qasm").value.trim();
	if (mode !== "qec" && !qasm) return { problem: "Paste a circuit first, or start from an example." };
	if (mode === "qec") {
		const epsilon = Number($("epsilon").value);
		if (!Number.isFinite(epsilon) || $("epsilon").value.trim() === "") return { problem: "Epsilon needs to be a number." };
		return { action: "surfaceCode", body: { distance: Number($("distance").value), epsilon } };
	}
	if (mode === "expectation") {
		const observables = parseObservables($("observables").value || "mean_z");
		if (!observables) return { problem: 'Write observables like "ZZ on 0,1; mean_z". Each letter needs one qubit.' };
		return { action: "expectationValues", body: { qasm, observables } };
	}
	const measureId = { probabilities: "measure", shots: "shots-measure", outcomes: "outcomes-measure" }[mode];
	const measure = parseQubitList($(measureId).value);
	if (measure === null) return { problem: "Qubits to read should be numbers, like 0,1,2." };
	const withMeasure = measure ? { measure } : {};
	if (mode === "shots") {
		const shots = Number($("shots").value);
		if (!Number.isInteger(shots) || shots < 1) return { problem: "Shots needs to be a whole number above zero." };
		const seedText = $("seed").value.trim();
		if (seedText && !/^\d+$/.test(seedText)) return { problem: "The seed needs to be a whole number." };
		return { action: "sample", body: { qasm, shots, ...(seedText ? { seed: Number(seedText) } : {}), ...withMeasure } };
	}
	if (mode === "outcomes") {
		const outcomes = parseOutcomes($("outcomes").value);
		if (!outcomes) return { problem: "List bit strings made of 0 and 1, like 0101, 1100." };
		return { action: "probabilityOf", body: { qasm, outcomes, ...withMeasure } };
	}
	return { action: "run", body: { qasm, ...withMeasure } };
}

function setBusy(busy, button) {
	document.body.classList.toggle("measuring", busy);
	button.disabled = busy;
}

function skeleton(host) {
	host.replaceChildren();
	const box = el("div", "skeleton");
	box.setAttribute("aria-label", "Waiting for the service");
	box.append(el("span"), el("span"), el("span"));
	host.append(box);
}

function emptyAnswer(host, text) {
	host.replaceChildren(el("p", "answer-empty", text));
}

function permalinkRow(reply) {
	if (!reply.permalink) return null;
	const row = el("div", "permalink");
	const link = el("a", "", reply.permalink);
	link.href = reply.permalink;
	link.target = "_blank";
	link.rel = "noreferrer noopener";
	const copy = el("button", "secondary", "Copy link");
	copy.type = "button";
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(reply.permalink);
			copy.textContent = "Copied";
		} catch {
			copy.textContent = "Could not copy";
		}
		setTimeout(() => { copy.textContent = "Copy link"; }, 1600);
	});
	row.append(link, copy);
	return row;
}

function fullReply(value) {
	const details = el("details", "full-reply");
	details.append(el("summary", "", "Full reply"), el("pre", "", JSON.stringify(value, null, 2)));
	return details;
}

function metaLine(result) {
	const bits = [];
	if (result.method) bits.push(`Method: ${result.method}`);
	if (result.qubits_held !== undefined) bits.push(`Qubits held: ${formatValue(result.qubits_held)}`);
	if (result.seed !== undefined) bits.push(`Seed: ${formatValue(result.seed)}`);
	if (result.execution?.fingerprint) bits.push(`Fingerprint: ${result.execution.fingerprint}`);
	return bits;
}

function dataTable(columns, rows) {
	const wrap = el("div", "table-wrap");
	const table = el("table", "data-table");
	const head = el("tr");
	for (const column of columns) head.append(el("th", "", column));
	const thead = el("thead");
	thead.append(head);
	const body = el("tbody");
	for (const row of rows) {
		const tr = el("tr");
		for (const column of columns) tr.append(el("td", "", formatValue(row[column])));
		body.append(tr);
	}
	table.append(thead, body);
	wrap.append(table);
	return wrap;
}

function renderAnswer(host, reply, action) {
	host.replaceChildren();
	const result = reply.result ?? {};
	const { unit, rows } = outcomeRows(result);
	if (action === "expectationValues" && Array.isArray(result.values)) {
		host.append(el("h2", "", "Here are the values."));
		host.append(dataTable(["observable", "value", "certificate", "exact"], result.values));
	} else if (action === "surfaceCode") {
		host.append(el("h2", "", "Here is the logical channel."));
		const table = Array.isArray(result.rows) ? result.rows : [result];
		const columns = [...new Set(table.flatMap((row) => Object.keys(row)))].filter((key) => typeof table[0][key] !== "object");
		const pivot = columns.flatMap((column) => table.map((row) => ({ field: column, value: row[column] })));
		host.append(dataTable(["field", "value"], pivot));
	} else if (rows.length) {
		host.append(el("h2", "", action === "sample" ? `${formatNumber(rows.reduce((sum, row) => sum + row.value, 0))} real draws from the exact distribution.` : "Here is the exact answer."));
		const meta = metaLine(result);
		if (meta.length) {
			const line = el("div", "answer-meta");
			for (const bit of meta) line.append(el("div", "", bit));
			host.append(line);
		}
		const chart = el("div", "chart");
		host.append(chart);
		renderOutcomes(chart, rows, unit);
		if (result.outcome_law) {
			host.append(el("h2", "law-title", "What every outcome obeys"));
			host.append(dataTable(["field", "value"], Object.entries(result.outcome_law).map(([field, value]) => ({ field, value }))));
		}
	} else {
		host.append(el("h2", "", "The service replied."));
		host.append(el("p", "answer-meta", "It sent no outcomes to draw. The full reply is below."));
	}
	const link = permalinkRow(reply);
	if (link) host.append(link);
	host.append(fullReply(reply));
}

function renderRefusal(host, refusal) {
	host.replaceChildren();
	const box = el("div", "refusal");
	const words = refusalWords(refusal.code);
	box.append(el("h2", "", words.headline));
	box.append(el("p", "refusal-mark", refusal.detail));
	box.append(el("p", "next", words.next));
	const numbers = Object.entries(refusal.numbers ?? {}).map(([field, value]) => ({ field, value }));
	numbers.unshift({ field: "error", value: refusal.code }, { field: "http status", value: refusal.status });
	box.append(dataTable(["field", "value"], numbers));
	if (refusal.retryAfter) {
		const wait = el("p", "answer-meta");
		let left = refusal.retryAfter;
		const tick = () => {
			if (!wait.isConnected && left !== refusal.retryAfter) return;
			wait.textContent = left > 0 ? `You can run it again in ${left} second${left === 1 ? "" : "s"}.` : "You can run it again now.";
			if (left > 0) { left -= 1; setTimeout(tick, 1000); }
		};
		tick();
		box.prepend(wait);
	}
	host.append(box);
}

function renderUnreachable(host, out) {
	host.replaceChildren();
	const box = el("div", "refusal");
	box.append(el("h2", "", "The service did not answer, so there is no result."));
	box.append(el("p", "refusal-mark", out.detail));
	box.append(el("p", "next", "Nothing was worked out on this computer. Check your connection and run it again."));
	host.append(box);
	checkConnection();
}

function renderOutcome(host, out, action, renderOk) {
	if (out.kind === "answer") renderOk(host, out.reply, action);
	else if (out.kind === "refusal") renderRefusal(host, out);
	else renderUnreachable(host, out);
	// On a narrow screen the answer lands below the form, so bring it into view.
	const { top } = host.getBoundingClientRect();
	if (top < 0 || top > window.innerHeight * 0.6) host.scrollIntoView({ block: "start" });
}

$("run-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const request = buildRunRequest();
	fieldError("qasm-error", request.problem);
	if (request.problem) return;
	const host = $("run-answer");
	const button = $("run-button");
	setBusy(true, button);
	skeleton(host);
	const out = await localCall(request.action, request.body);
	setBusy(false, button);
	renderOutcome(host, out, request.action, renderAnswer);
});

// --- score view -------------------------------------------------------------------------------------------------

function noteCounts() {
	const text = $("score-counts").value;
	const note = $("counts-read");
	if (!text.trim()) {
		note.textContent = "Paste counts as JSON, a printed dictionary, or a results file. Classical bit 0 goes on the right.";
		return null;
	}
	const counts = extractCounts(text);
	if (!counts) {
		note.textContent = "No counts found in that yet. Keys should be bit strings and values should be numbers.";
		return null;
	}
	const shots = Object.values(counts).reduce((sum, value) => sum + value, 0);
	const outcomes = Object.keys(counts).length;
	note.textContent = `Read ${formatNumber(outcomes)} outcome${outcomes === 1 ? "" : "s"} and ${formatNumber(shots)} shots.`;
	return counts;
}
$("score-counts").addEventListener("input", noteCounts);
$("score-qasm-file").addEventListener("change", (event) => { if (event.target.files[0]) readInto($("score-qasm"), event.target.files[0]); });
$("score-counts-file").addEventListener("change", (event) => { if (event.target.files[0]) readInto($("score-counts"), event.target.files[0], noteCounts); });
wireDrop($("score-qasm"), (files) => readInto($("score-qasm"), files[0]));
wireDrop($("score-counts"), (files) => readInto($("score-counts"), files[0], noteCounts));

function statList(pairs) {
	const list = el("dl", "stats");
	for (const [label, value] of pairs) {
		if (value === undefined || value === null) continue;
		list.append(el("dt", "", label), el("dd", "", formatValue(value)));
	}
	return list;
}

function renderScore(host, reply) {
	host.replaceChildren();
	const score = reply.result?.score;
	if (!score) {
		host.append(el("h2", "", "The service replied without a score."));
		host.append(fullReply(reply));
		return;
	}
	host.append(el("h2", "", scoreSentence(score)));
	const xeb = score.xeb ?? {};
	host.append(statList([
		["Cross-entropy score", xeb.value],
		["Its standard error", xeb.standard_error],
		["Score a perfect device expects", xeb.ideal],
		["Fidelity estimate", xeb.fidelity_estimate],
		["Mean log2 probability", score.mean_log2_probability],
		["Shots", score.shots],
		["Distinct outcomes", score.distinct_outcomes],
		["Measured qubits", score.measured],
		["Shots on impossible outcomes", score.impossible_shots],
	]));
	if (score.table) {
		const perfect = score.table.perfect_device;
		const rows = [
			{ measure: "Total variation", "your counts": score.table.total_variation, "a perfect device": perfect?.total_variation ?? "not given" },
			{ measure: "Hellinger fidelity", "your counts": score.table.hellinger_fidelity, "a perfect device": perfect?.hellinger_fidelity ?? "not given" },
		];
		host.append(dataTable(["measure", "your counts", "a perfect device"], rows));
	}
	if (score.note) host.append(el("p", "score-note", score.note));
	const link = permalinkRow(reply);
	if (link) host.append(link);
	host.append(fullReply(reply));
}

$("score-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const qasm = $("score-qasm").value.trim();
	const counts = noteCounts();
	fieldError("score-qasm-error", qasm ? "" : "Paste the circuit that produced these counts.");
	fieldError("score-counts-error", counts ? "" : "Paste your counts. Keys should be bit strings and values should be numbers.");
	if (!qasm || !counts) return;
	const host = $("score-answer");
	const button = $("score-button");
	setBusy(true, button);
	skeleton(host);
	const out = await localCall("score", { qasm, counts });
	setBusy(false, button);
	renderOutcome(host, out, "score", renderScore);
});

// --- API key ----------------------------------------------------------------------------------------------------

function renderKeyPanel() {
	const summary = $("key-summary");
	const body = $("key-body");
	body.replaceChildren();
	summary.textContent = accountState === "key" ? "Using your API key" : "Using the no-account route";
	if (!desktop) {
		body.append(el("p", "", accountState === "key"
			? "Your key comes from the CATALYST_Q_KEY variable in the shell that started this page. It stays on this computer and goes only to the API."
			: "No key is needed for up to 64 qubits and 4,000 gates. To use one here, set CATALYST_Q_KEY before you run npx catalyst-q ui."));
		return;
	}
	if (accountState === "key") {
		body.append(el("p", "", "Your key is stored encrypted by your operating system. This page cannot read it back."));
		const remove = el("button", "secondary", "Remove the key");
		remove.type = "button";
		remove.addEventListener("click", async () => { await desktop.clearKey(); await checkConnection(); });
		body.append(remove);
		return;
	}
	body.append(el("p", "", "No key is needed for up to 64 qubits and 4,000 gates. With a key you can go up to 256 qubits."));
	const row = el("form", "key-row");
	const input = el("input", "text mono");
	input.type = "password";
	input.placeholder = "cq_live_…";
	input.autocomplete = "off";
	input.spellcheck = false;
	input.setAttribute("aria-label", "API key");
	const save = el("button", "secondary", "Save the key");
	save.type = "submit";
	const message = el("p", "hint");
	row.append(input, save);
	row.addEventListener("submit", async (event) => {
		event.preventDefault();
		const reply = await desktop.saveKey(input.value);
		input.value = "";
		if (reply.ok) await checkConnection();
		else message.textContent = reply.detail;
	});
	body.append(row, message);
}

// --- start ------------------------------------------------------------------------------------------------------

emptyAnswer($("run-answer"), "Nothing run yet. The answer lands here.");
emptyAnswer($("score-answer"), "Nothing scored yet. The score lands here.");
syncModeFields();
renderKeyPanel();
checkConnection();
$("goal").focus();
