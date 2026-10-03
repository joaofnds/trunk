/** Parsed conventional-commit summary. `prefix` is null when the summary does
 *  not start with a `type(scope)?!?:` header, in which case `rest` is the whole
 *  summary unchanged. */
export interface ParsedSummary {
	prefix: string | null;
	scope: string | null;
	bang: string | null;
	rest: string;
}

const CONVENTIONAL = /^(\w+)(\([^)]+\))?(!?):\s*(.*)$/;

export function parseSummary(summary: string): ParsedSummary {
	const m = summary.match(CONVENTIONAL);
	if (!m) return { prefix: null, scope: null, bang: null, rest: summary };
	return { prefix: m[1], scope: m[2] ?? "", bang: m[3] ?? "", rest: m[4] };
}

// Lane hues kept clear of the semantic tokens (green/amber/red/blue) so a
// neutral prefix never reads as feat/fix/revert/docs.
const NEUTRAL_LANES = [
	"var(--lane-3)", // purple
	"var(--lane-2)", // pink
	"var(--lane-5)", // cyan
	"var(--lane-1)", // orange
	"var(--lane-6)", // teal
];

const PREFIX_TONE: Record<string, string> = {
	// Semantic anchors — the hue carries meaning.
	feat: "var(--color-success)",
	perf: "var(--color-success)",
	fix: "var(--color-warning)",
	revert: "var(--color-danger)",
	docs: "var(--color-info)",
	// Distinct neutral hues.
	refactor: NEUTRAL_LANES[0], // purple
	refine: NEUTRAL_LANES[1], // pink
	test: NEUTRAL_LANES[2], // cyan
	style: NEUTRAL_LANES[4], // teal
	// Tooling / housekeeping — one shared hue.
	chore: NEUTRAL_LANES[3], // orange
	build: NEUTRAL_LANES[3],
	ci: NEUTRAL_LANES[3],
};

function neutralLaneFor(prefix: string): string {
	let hash = 0;
	for (let i = 0; i < prefix.length; i++) {
		hash = (hash * 31 + prefix.charCodeAt(i)) | 0;
	}
	return NEUTRAL_LANES[Math.abs(hash) % NEUTRAL_LANES.length];
}

/** Theme token for a conventional-commit prefix. Mapped types get their own
 *  tone; any other type gets a stable neutral lane hue — never greyed out. */
export function prefixToneVar(prefix: string): string {
	return PREFIX_TONE[prefix] ?? neutralLaneFor(prefix);
}
