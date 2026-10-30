// Two builds from one source: dist/esm (ES module) and dist/cjs (CommonJS), each with its own .d.ts,
// and a one-line package.json in each folder so Node and TypeScript read the right module format.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const tscPath = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const tsc = (args) => execFileSync(process.execPath, [tscPath, ...args], { stdio: "inherit" });
rmSync("dist", { recursive: true, force: true });
tsc(["-p", "tsconfig.build.json", "--module", "ES2022", "--moduleResolution", "node10", "--outDir", "dist/esm"]);
tsc(["-p", "tsconfig.build.json", "--module", "CommonJS", "--moduleResolution", "node10", "--outDir", "dist/cjs"]);
mkdirSync("dist/esm", { recursive: true }); mkdirSync("dist/cjs", { recursive: true });
writeFileSync("dist/esm/package.json", JSON.stringify({ type: "module" }) + "\n");
writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }) + "\n");
console.log("built dist/esm and dist/cjs");
