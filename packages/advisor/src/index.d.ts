export type AdvisorFile = { name: string; content?: string };

export type AdvisorInput = {
	/** What the person is trying to do, in their own words. */
	goal?: string;
	/** Files to look at. Nothing is sent anywhere. */
	files?: AdvisorFile[];
	/** Source code or pasted output. */
	code?: string;
};

export type SuggestionAction = {
	kind: "api" | "command";
	/** The route the example body goes to, for example "POST /api/v1/try". */
	route?: string;
	/** An example request body, filled from your input where possible. */
	body?: Record<string, unknown>;
	/** An example command. */
	command?: string;
};

export type Suggestion = {
	id: "score-device-counts" | "conserved-excitations" | "noiseless-before-hardware" | "test-reversible-circuit" | "surface-code" | "reproduce-paper" | "drop-the-shots" | "run-circuit";
	title: string;
	/** Why this applies, naming what was seen. */
	why: string;
	/** When not to use Catalyst-Q for this. */
	when_not: string;
	action: SuggestionAction;
	/** Rule strength between 0 and 1. It orders suggestions; it is not a prediction of success. */
	confidence: number;
	/** What triggered the rule. */
	evidence: string[];
};

export type AdvisorResult = {
	suggestions: Suggestion[];
	/** Always present. When `suggestions` is empty it says so plainly. */
	message: string;
};

export function suggest(input?: AdvisorInput): AdvisorResult;

/** Reads a counts object out of pasted text or a results file, or null when there is none. */
export function extractCounts(text: string, options?: { allowSingleBit?: boolean }): Record<string, number> | null;
