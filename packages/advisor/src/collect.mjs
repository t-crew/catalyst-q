// Node-only helper for the CLI: turn a path into the `files` list `suggest` takes. Reads locally, sends nothing.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "venv", "__pycache__", "coverage"]);
const READ_EXTS = new Set([".qasm", ".py", ".ipynb", ".json", ".txt", ".md", ".rst", ".tex", ".js", ".mjs", ".ts", ".jl", ".toml", ".yaml", ".yml"]);

function notebookText(raw) {
	try {
		const parts = [];
		for (const cell of JSON.parse(raw).cells ?? []) {
			parts.push(Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? ""));
			for (const output of cell.outputs ?? []) {
				if (output.text) parts.push(Array.isArray(output.text) ? output.text.join("") : String(output.text));
				const plain = output.data?.["text/plain"];
				if (plain) parts.push(Array.isArray(plain) ? plain.join("") : String(plain));
			}
		}
		return parts.join("\n");
	} catch {
		return raw;
	}
}

async function readOne(path, name, maxBytes) {
	const info = await stat(path);
	if (info.size > maxBytes) return { name };
	const raw = await readFile(path, "utf8");
	return { name, content: extname(path) === ".ipynb" ? notebookText(raw) : raw };
}

export async function collect(path, { maxFiles = 400, maxBytes = 256 * 1024 } = {}) {
	const info = await stat(path);
	if (info.isFile()) return [await readOne(path, basename(path), maxBytes)];
	const files = [];
	const queue = [path];
	while (queue.length && files.length < maxFiles) {
		const dir = queue.shift();
		const entries = await readdir(dir, { withFileTypes: true });
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) queue.push(full);
			} else if (entry.isFile() && READ_EXTS.has(extname(entry.name)) && files.length < maxFiles) {
				files.push(await readOne(full, relative(path, full), maxBytes));
			}
		}
	}
	return files;
}
