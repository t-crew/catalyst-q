import type { AdvisorFile } from "./index.js";

/** Reads a file or a directory into the `files` list `suggest` takes. Local only. */
export function collect(path: string, options?: { maxFiles?: number; maxBytes?: number }): Promise<AdvisorFile[]>;
