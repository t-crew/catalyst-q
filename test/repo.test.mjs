// Checks across the repo: copies stay in step and versions agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the action's vendored client matches the built source", async () => {
	assert.equal(await read("action/vendor/catalyst-q.mjs"), await read("packages/sdk/dist/esm/index.js"));
});

test("every published package carries the same licence", async () => {
	const license = await read("LICENSE");
	for (const name of ["sdk", "advisor", "cli", "mcp", "ui"]) assert.equal(await read(`packages/${name}/LICENSE`), license, name);
});

test("packages agree on one version and pin each other to it", async () => {
	const names = ["sdk", "advisor", "cli", "mcp", "ui"];
	const manifests = await Promise.all(names.map(async (name) => JSON.parse(await read(`packages/${name}/package.json`))));
	const { version } = manifests[0];
	const ours = new Set(manifests.map((m) => m.name));
	for (const manifest of manifests) {
		assert.equal(manifest.version, version, manifest.name);
		for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
			if (ours.has(dep)) assert.equal(range, version, `${manifest.name} on ${dep}`);
		}
	}
	const sdkSource = await read("packages/sdk/src/index.ts");
	assert.match(sdkSource, new RegExp(`VERSION = "${version.replace(/\./g, "\\.")}"`));
});

test("the plugin manifests agree with the packages", async () => {
	const { version } = JSON.parse(await read("packages/sdk/package.json"));
	assert.equal(JSON.parse(await read(".claude-plugin/plugin.json")).version, version);
	assert.equal(JSON.parse(await read(".codex-plugin/plugin.json")).version, version);
	const mcp = JSON.parse(await read(".mcp.json"));
	assert.deepEqual(mcp.mcpServers["catalyst-q"].args, ["-y", "catalyst-q-mcp"]);
});

test("the README keeps the reproduce section exactly as it was asked for", async () => {
	const readme = await read("README.md");
	const section = readme.split(/^## /m).find((part) => part.startsWith("Reproduce every claim"));
	assert.ok(section);
	assert.equal(section.trim(), "Reproduce every claim\n\nEvery claim on the [Evidence page](https://catalyst-q.strategic-innovations.ai/bench) has a script here that computes the answer a second way and compares. See [reproduce/](reproduce/).");
});

test("the skill has the frontmatter hosts need", async () => {
	const skill = await read("skills/catalyst-q/SKILL.md");
	assert.match(skill, /^---\nname: catalyst-q\ndescription: /);
});
