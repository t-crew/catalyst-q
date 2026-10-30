// Entry point of the composite action. The logic and its tests are in lib/logic.mjs.
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { CatalystQ } from "./vendor/catalyst-q.mjs";
import { changedQasmFiles, chooseExitCode, loadCounts, runAll, postOrUpdateComment, renderSummary } from "./lib/logic.mjs";

const env = process.env;

function git(args) {
	return new Promise((resolve, reject) => {
		execFile("git", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`git ${args[0]}: ${stderr || err.message}`));
			else resolve(stdout);
		});
	});
}

async function readEvent() {
	if (!env.GITHUB_EVENT_PATH) return {};
	try {
		return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
	} catch {
		return {};
	}
}

const event = await readEvent();
const client = new CatalystQ({ apiKey: env.CQ_API_KEY || null, baseUrl: env.CQ_BASE_URL || undefined });

const explicit = (env.CQ_PATHS ?? "").split(/\s+/).filter(Boolean);
let files = explicit;
const notes = [];
if (!explicit.length) {
	try {
		files = await changedQasmFiles({ event, git });
	} catch (err) {
		notes.push(`Could not work out which files changed: ${err.message}`);
		files = [];
	}
}

const counts = env.CQ_COUNTS ? await loadCounts({ countsPath: env.CQ_COUNTS, circuitPath: env.CQ_COUNTS_CIRCUIT, readFile }) : null;
const maxFiles = Number(env.CQ_MAX_FILES);
const results = await runAll({ files, counts, client, readFile, maxFiles: Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : 6 });
const markdown = renderSummary({ ...results, notes });

if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
else console.log(markdown);

const tally = { answered: 0, refused: 0, unreachable: 0, unreadable: 0 };
for (const item of results.items) tally[item.outcome] += 1;
if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `answered=${tally.answered}\nrefused=${tally.refused}\nunreachable=${tally.unreachable + tally.unreadable}\n`);
for (const item of results.items) {
	if (item.outcome === "unreachable" || item.outcome === "unreadable") console.log(`::warning::${item.label}: ${item.detail.replace(/[\r\n]+/g, " ")}`);
}

if (env.CQ_TOKEN && env.CQ_COMMENT === "true") {
	const pull = event.pull_request?.number;
	if (!pull) {
		console.log("::notice::No pull request here, so no comment was posted.");
	} else {
		const posted = await postOrUpdateComment({ token: env.CQ_TOKEN, repository: env.GITHUB_REPOSITORY, pull, markdown, apiUrl: env.GITHUB_API_URL, fetch: globalThis.fetch });
		if (!posted.ok) console.log(`::warning::Could not post the comment (${posted.status}). Pull requests from forks get a read-only token. The results are in the job summary.`);
	}
}

process.exitCode = chooseExitCode(tally, { failOnRefusal: env.CQ_FAIL_ON_REFUSAL === "true", failWhenUnreachable: env.CQ_FAIL_WHEN_UNREACHABLE !== "false" });
