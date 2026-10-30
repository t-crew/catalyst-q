// Launches the real app, drives the real page and saves what it shows.
//
//   npm run screenshots -w catalyst-q-desktop -- <output folder> [--base-url https://...]
//
// With no --base-url it talks to a local address nothing listens on, so the page is truly offline and the shots
// hold nothing but the advisor and the offline state. Point --base-url at a service to capture real answers.
// Nothing is faked here: there is no stub in this script.
process.env.CATALYST_Q_DESKTOP_NO_AUTOSTART = "1";

const { app, nativeTheme } = await import("electron");
const { setUpShell, createWindow } = await import("../src/main.mjs");
const { mkdir, writeFile } = await import("node:fs/promises");
const { join, resolve } = await import("node:path");

const args = process.argv.slice(process.defaultApp ? 2 : 1).filter((a) => !a.endsWith("screenshots.mjs"));
const baseFlag = args.indexOf("--base-url");
const baseUrl = baseFlag >= 0 ? args[baseFlag + 1] : "http://127.0.0.1:59999";
const outDir = resolve(args.find((a, i) => !a.startsWith("--") && (baseFlag < 0 || i !== baseFlag + 1)) ?? ".");
const prefix = process.env.CATALYST_Q_SHOT_PREFIX ?? "";
const size = (process.env.CATALYST_Q_SHOT_SIZE ?? "1240x900").split("x").map(Number);
const live = baseFlag >= 0;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// A shot that never comes should fail loudly, not leave a window open.
setTimeout(() => {
	console.error("Timed out before finishing.");
	app.exit(1);
}, 90_000).unref();
const die = (err) => {
	console.error(err);
	app.exit(1);
};
process.on("uncaughtException", die);
process.on("unhandledRejection", die);

async function shot(window, name) {
	await pause(500);
	const image = await window.webContents.capturePage();
	const path = join(outDir, `${prefix}${name}.png`);
	await writeFile(path, image.toPNG());
	console.log(`saved ${path} ${image.getSize().width}x${image.getSize().height}`);
}

const drive = (window, code) => window.webContents.executeJavaScript(code, true);

const setValue = (id, value) => `(() => { const n = document.getElementById(${JSON.stringify(id)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event("input", { bubbles: true })); })()`;

async function run() {
	await mkdir(outDir, { recursive: true });
	if (process.env.CATALYST_Q_SHOT_THEME) nativeTheme.themeSource = process.env.CATALYST_Q_SHOT_THEME;
	setUpShell({ baseUrl });
	const window = createWindow({ width: size[0], height: size[1] });
	const problems = [];
	window.webContents.on("console-message", (event) => {
		if (event.level === "error" || event.level === "warning") problems.push(event.message);
	});
	window.webContents.on("render-process-gone", (_e, details) => problems.push(`renderer gone: ${details.reason}`));
	await new Promise((done, fail) => {
		window.webContents.once("did-finish-load", done);
		window.webContents.once("did-fail-load", (_event, code, description, url) => fail(new Error(`Could not load ${url}: ${code} ${description}`)));
	});
	await pause(800);

	const facts = await drive(window, `({
		title: document.title,
		heading: document.querySelector("h1").textContent,
		node: typeof process !== "undefined" || typeof require !== "undefined",
		bridge: Object.keys(window.catalystQDesktop ?? {}),
		fonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
		overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		connection: document.getElementById("connection").textContent,
	})`);
	console.log(JSON.stringify(facts));

	await shot(window, "01-first-screen");

	await drive(window, setValue("goal", "Plan a QAOA run on 30 qubits before I pay for quantum hardware time, and check the counts I already have"));
	await shot(window, "02-advisor-reacts");

	await drive(window, setValue("goal", "Build a todo app with a login page"));
	await shot(window, "03-advisor-says-nothing-applies");

	await drive(window, `document.querySelector('[data-view="run"]').click();`);
	await drive(window, `(() => { const s = document.getElementById("example"); s.value = "ghz"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
	await drive(window, `document.getElementById("run-form").requestSubmit();`);
	await pause(live ? 6000 : 1200);
	await shot(window, live ? "04-run-answer" : "04-run-offline");

	await drive(window, `document.querySelector('[data-view="score"]').click();`);
	await drive(window, setValue("score-qasm", "OPENQASM 3.0;\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n"));
	await drive(window, setValue("score-counts", '{"00": 498, "11": 489, "01": 7, "10": 6}'));
	await drive(window, `document.getElementById("score-form").requestSubmit();`);
	await pause(live ? 6000 : 1200);
	await shot(window, live ? "05-score-answer" : "05-score-offline");

	if (live) {
		// A circuit wider than the no-account route allows, to see a real refusal.
		await drive(window, `document.querySelector('[data-view="run"]').click();`);
		await drive(window, setValue("qasm", "OPENQASM 3.0;\nqubit[300] q;\nh q[0];\n"));
		await drive(window, setValue("measure", ""));
		await drive(window, `document.getElementById("run-form").requestSubmit();`);
		await pause(6000);
		await shot(window, "06-run-refusal");
	}

	if (problems.length) console.log(`page reported: ${JSON.stringify(problems)}`);
	else console.log("page reported no errors or warnings");
	app.quit();
}

// Not a top-level await: Electron holds the ready event until an ES module entry has finished loading.
app.whenReady().then(run).catch(die);
