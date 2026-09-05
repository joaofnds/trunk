// The contrast gate: every audited text/background pair in src/app.css against
// its WCAG target. Started as the post-fix verification of the 2026-06-22
// app-wide AAA re-audit; runs as `just contrast` inside `just check`.
// Parses tokens LIVE from src/app.css via contrast.mjs, so it tracks the theme.
// Run: bun scripts/contrast/re-audit-verify.mjs   (exit 1 if any target missed)

import { compose, contrast, ratio, verdict } from "./contrast.mjs";

let fails = 0;
const rows = [];
function record(label, r, target, grade) {
	const ok = r >= target;
	if (!ok) fails++;
	rows.push(`  ${ok ? "OK " : "!! "} ${r.toFixed(2)} ${grade} (>=${target}) ${label}`);
}
// A text target carries a WCAG grade. Below AA there is no letter to print: the
// target is a non-text floor the design chose.
function check(label, fg, base, { layers = [], opacity = null, target = 7 } = {}) {
	const r = contrast(fg, base, { layers, opacity: opacity ?? undefined });
	record(label, r, target, target >= 4.5 ? verdict(r).padEnd(4) : "non-text");
}
// Two opaque surfaces against each other (a patch against the line it sits on).
function checkSurfaces(label, base, layersA, layersB, target) {
	record(label, ratio(compose(base, layersA), compose(base, layersB)), target, "non-text");
}
const section = (t) => rows.push(`\n== ${t} ==`);
// Two opaque surfaces against each other (a patch against the line it sits on).
// Non-text, so no WCAG letter grade: the target is the design's own floor.
function checkSurfaces(label, base, layersA, layersB, target) {
	const r = ratio(compose(base, layersA), compose(base, layersB));
	const ok = r >= target;
	if (!ok) fails++;
	rows.push(`  ${ok ? "OK " : "!! "} ${r.toFixed(2)} ${"non-text".padEnd(4)} (>=${target}) ${label}`);
}

// The source diff views sit in DiffPanel's --bg-1 pane; a rendered markdown
// block paints --bg-0 itself (.rendered-block.md-*.no-wash).
const PANEL = "var(--bg-1)";
const PAGE = "var(--bg-0)";
const t = (c, p) => `color-mix(in oklch, ${c} ${p}%, transparent)`;

section('CommitRow ": " separator (--fg-4 -> --fg-2): default AAA, transient AA');
check("resting", "var(--fg-2)", PANEL);
check("hover", "var(--fg-2)", "var(--bg-hover)");
check("selected", "var(--fg-2)", "var(--bg-selected)");
check("current-search-match (transient)", "var(--fg-2)", PANEL, { layers: ["var(--color-search-current)"], target: 4.5 });

section("Word patch (TRUNK-166): text on it is forced to --color-diff-text, so that is what must clear AAA");
for (const [origin, line, sel, word] of [
	["add", "var(--diff-add-bg)", "var(--diff-add-hi)", "var(--color-diff-word-add-bg)"],
	["del", "var(--diff-del-bg)", "var(--diff-del-hi)", "var(--color-diff-word-delete-bg)"],
]) {
	check(`${origin} line + word`, "var(--color-diff-text)", PANEL, { layers: [line, word] });
	check(`${origin} selected + word`, "var(--color-diff-text)", PANEL, { layers: [sel, word] });
	checkSurfaces(`${origin} word patch stands apart from its line`, PANEL, [line], [line, word], 2);
	checkSurfaces(`${origin} word patch stands apart from its selected line`, PANEL, [sel], [sel, word], 2);
}

section("Syntax hues off the patch: every token AAA on context, add, delete and selected lines (2026-06-22 audit, held)");
const SYN = ["keyword", "string", "comment", "number", "type", "function", "variable", "constant", "operator", "punctuation", "attribute", "tag", "property", "regex", "escape"];
const LINE_TINTS = { context: [], add: ["var(--diff-add-bg)"], del: ["var(--diff-del-bg)"], "selected add": ["var(--diff-add-hi)"], "selected del": ["var(--diff-del-hi)"] };
let worstSyn = { r: Infinity, label: "" };
for (const hue of SYN) {
	for (const [tint, layers] of Object.entries(LINE_TINTS)) {
		const r = contrast(`var(--color-syn-${hue})`, PANEL, { layers });
		if (r < worstSyn.r) worstSyn = { r, label: `syn-${hue} on ${tint}` };
		if (r < 7) record(`syn-${hue} on ${tint}`, r, 7, verdict(r).padEnd(4));
	}
}
record(`worst of ${SYN.length} hues x ${Object.keys(LINE_TINTS).length} tints: ${worstSyn.label}`, worstSyn.r, 7, verdict(worstSyn.r).padEnd(4));

section("Rendered markdown marks (TRUNK-166): same rule, mark sits alone on the page");
for (const [origin, word, rule] of [
	["add", "var(--color-md-word-add-bg)", "var(--ok)"],
	["del", "var(--color-md-word-delete-bg)", "var(--err)"],
]) {
	check(`${origin} text on mark`, "var(--color-diff-text)", PAGE, { layers: [word] });
	check(`${origin} text on mark inside a code span`, "var(--color-diff-text)", PAGE, { layers: [word, "var(--color-md-code-bg)"] });
	check(`${origin} strike/underline rule on mark (non-text, 3:1)`, rule, PAGE, { layers: [word], target: 3 });
	checkSurfaces(`${origin} mark stands apart from the page`, PAGE, [], [word], 2);
}

section("invisible-char marker (translucent fg-3 -> opaque L0.78): single diff tints AAA");
check("context", "var(--color-invisible)", PANEL);
check("resting add", "var(--color-invisible)", PANEL, { layers: ["var(--diff-add-bg)"] });
check("selected add", "var(--color-invisible)", PANEL, { layers: ["var(--diff-add-hi)"] });
check("selected del", "var(--color-invisible)", PANEL, { layers: ["var(--diff-del-hi)"] });

section("trailing-ws glyph (new --color-trailing-ws-fg L0.90): stacks AAA");
check("context + tws", "var(--color-trailing-ws-fg)", PANEL, { layers: ["var(--color-trailing-ws-bg)"] });
check("selected del + tws", "var(--color-trailing-ws-fg)", PANEL, { layers: ["var(--diff-del-hi)", "var(--color-trailing-ws-bg)"] });

section("Danger buttons (--err 0.72 -> 0.76 lifts --color-danger): AAA on tinted chrome");
check("Discard (hunk-header info tint + danger-bg)", "var(--color-danger)", "color-mix(in oklch, var(--info) 6%, var(--bg-2))", { layers: ["var(--color-danger-bg)"] });
check("Abort (banner info tint + danger-bg)", "var(--color-danger)", PANEL, { layers: ["var(--color-banner-info-bg)", "var(--color-danger-bg)"] });
check("plain danger label on bg-1", "var(--color-danger)", PANEL, { layers: ["var(--color-danger-bg)"] });

section("FileRow status badge (tint 8% -> 6%): A/T/? selected AAA; D/R selected AA (transient)");
check("A selected", "var(--ok)", "var(--bg-selected)", { layers: [t("var(--ok)", 6)] });
check("T selected", "var(--color-status-typechange)", "var(--bg-selected)", { layers: [t("var(--color-status-typechange)", 6)] });
check("? selected (muted -> --color-text)", "var(--color-text)", "var(--bg-selected)", { layers: [t("var(--color-text)", 6)] });
check("D selected (transient)", "var(--color-status-deleted)", "var(--bg-selected)", { layers: [t("var(--color-status-deleted)", 6)], target: 4.5 });
check("R selected (transient)", "var(--color-status-renamed)", "var(--bg-selected)", { layers: [t("var(--color-status-renamed)", 6)], target: 4.5 });
check("D resting (AAA)", "var(--color-status-deleted)", PANEL, { layers: [t("var(--color-status-deleted)", 6)] });
check("R resting (AAA)", "var(--color-status-renamed)", PANEL, { layers: [t("var(--color-status-renamed)", 6)] });

section("ReviewPanel orphan comment (opacity-on-text removed)");
check("fileref dim -> solid --fg-3", "var(--fg-3)", "var(--color-surface)");
check("diff gutter now full --fg-2 (add line)", "var(--color-text-muted)", "var(--color-bg)", { layers: ["var(--color-diff-add-bg)"] });

section("Rebase DROP row (--opacity-dimmed 0.6 -> 0.8): message AAA, date AA (transient)");
check("message --fg-1", "var(--fg-1)", "var(--color-selected-row)", { opacity: 0.8 });
check("author --fg-1", "var(--fg-1)", "var(--color-selected-row)", { opacity: 0.8 });
check("date --fg-2 (transient)", "var(--fg-2)", "var(--color-selected-row)", { opacity: 0.8, target: 4.5 });

section("Search-dim (new --opacity-search-dim 0.75): non-match content AA (transient)");
check("row sub-text --fg-2 / bg-1", "var(--fg-2)", PANEL, { opacity: 0.75, target: 4.5 });
check("row sub-text --fg-2 / bg-selected", "var(--fg-2)", "var(--bg-selected)", { opacity: 0.75, target: 4.5 });
check("graph ref pill (worst lane-2) non-match", "var(--lane-2)", PANEL, { layers: [t("var(--lane-2)", 14)], opacity: 0.75, target: 4.5 });

console.log(rows.join("\n"));
console.log(`\n${fails === 0 ? "ALL TARGETS MET" : `${fails} TARGET(S) MISSED`}`);
process.exit(fails === 0 ? 0 : 1);
