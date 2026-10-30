#!/usr/bin/env node
// `npx catalyst-q` lands here because npm resolves that command to the package named catalyst-q, which is this
// zero-dependency client. The commands live in catalyst-q-cli. This launcher runs an installed copy when there is
// one and otherwise asks npx for the matching version, so the client itself never takes on a dependency.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json");
const args = process.argv.slice(2);

let main = null;
try {
	({ main } = await import("catalyst-q-cli"));
} catch (err) {
	if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
}

if (main) {
	process.exitCode = await main(args);
} else {
	const npx = process.platform === "win32" ? "npx.cmd" : "npx";
	const child = spawn(npx, ["--yes", `catalyst-q-cli@${version}`, ...args], { stdio: "inherit" });
	child.on("exit", (code) => { process.exitCode = code ?? 1; });
	child.on("error", (spawnError) => {
		console.error(`Could not start npx: ${spawnError.message}. Try: npm install -g catalyst-q-cli`);
		process.exitCode = 1;
	});
}
