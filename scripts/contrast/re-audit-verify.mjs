// The contrast gate: every audited text/background pair in src/tokens.css against
// its WCAG target. Started as the post-fix verification of the 2026-06-22
// app-wide AAA re-audit; runs as `just contrast` inside `just check`.
// Parses tokens LIVE from src/tokens.css via contrast.mjs, so it tracks the theme.
// Run: bun scripts/contrast/re-audit-verify.mjs   (exit 1 if any target missed)

import { readFileSync } from "node:fs";
import { compose, contrast, ratio, resolve, TOKENS, verdict } from "./contrast.mjs";

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

section("Text selection retains readable syntax on diff and merge lines");
const appCss = readFileSync(new URL("../../src/app.css", import.meta.url), "utf8");
const selectionValue = (name) => {
	const value = appCss.match(new RegExp(`--selection-${name}:\\s*([^;]+);`))?.[1];
	if (!value) throw new Error(`Missing selection ${name} in app.css.`);
	return value.replace(/\s+/g, " ").trim();
};
const selectionRule = appCss.match(/^\s*::selection \{([^}]+)\}/m)?.[1] ?? "";
const selectionInk = selectionRule.match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1];
const paintedFill = appCss.match(/\.text-selection-paint\s*\{\s*background-color:\s*([^;]+)/)?.[1];
if (!selectionInk || paintedFill !== "var(--selection-fill)" || !selectionRule.includes(`background-color: ${paintedFill}`)) {
	throw new Error("Native selection and the range painter must share the selection palette.");
}
const syntaxBlend = selectionValue("ink");
const selectedSyntax = (hue) =>
	syntaxBlend
		.replace(/var\(--syntax-ink,\s*var\(--color-text-strong\)\)/, `var(--color-syn-${hue})`)
		.replace("var(--selection-syntax-share)", TOKENS["--selection-syntax-share"]);
for (const state of ["active", "inactive"]) {
	const selectionColor = (name) => selectionValue(name)
		.replace("var(--selection-tone)", selectionValue("tone"))
		.replace("var(--selection-strength)", TOKENS[`--selection-strength-${state}`]);
	const fill = selectionColor("fill");
	const overlap = selectionColor("overlap");
	if (resolve(fill).a === 1 || resolve(overlap).a === 1) {
		throw new Error("WebKit selection fills need explicit alpha.");
	}
	for (const [line, base, tints] of [
		...Object.entries(LINE_TINTS).map(([line, tints]) => [line, PANEL, tints]),
		["gutter-selected add", PANEL, ["var(--color-diff-add-bg)", "var(--color-accent-bg)"]],
		["gutter-selected del", PANEL, ["var(--color-diff-delete-bg)", "var(--color-accent-bg)"]],
		["merge current", PAGE, ["var(--color-merge-current-line)"]],
		["merge incoming", PAGE, ["var(--color-merge-incoming-line)"]],
		["code fence", PAGE, ["var(--color-muted-bg)"]],
	]) {
		const layers = [...tints, fill];
		for (const hue of SYN) {
			const ink = state === "active" ? selectedSyntax(hue) : `var(--color-syn-${hue})`;
			check(`${state} ${line} selection on ${hue}`, ink, base, { layers, target: 4.5 });
		}
		check(`${state} ${line} selection on plain text`, selectionInk, base, { layers, target: 4.5 });
		if (state === "active") checkSurfaces(`active selection against ${line}`, base, tints, layers, 3);
		else check(`inactive selection rule on ${line}`, selectionValue("inactive-rule"), base, { layers, target: 3 });
	}
	for (const base of [PAGE, PANEL, "var(--color-surface-raised)"]) {
		check(`${state} native or prose selection on ${base}`, selectionInk, base, { layers: [fill], target: 4.5 });
		if (state === "active") checkSurfaces(`active selection against ${base}`, base, [], [fill], 3);
		else check(`inactive selection on muted prose in ${base}`, "var(--color-text-subtle)", base, { layers: [fill], target: 4.5 });
	}
	if (state === "inactive") {
		for (const origin of ["add", "del"]) {
			check(`inactive selection on stale ${origin} excerpt`, "var(--color-text-subtle)", PAGE, { layers: [...LINE_TINTS[origin], fill], target: 4.5 });
		}
	}
	for (const [line, base, layers, marker] of [
		["added word", PANEL, [...LINE_TINTS["selected add"], fill, "var(--color-diff-word-add-bg)", overlap], selectionValue("add-marker")],
		["removed word", PANEL, [...LINE_TINTS["selected del"], fill, "var(--color-diff-word-delete-bg)", overlap], selectionValue("delete-marker")],
		["rendered addition", PAGE, [fill, "var(--color-md-word-add-bg)", overlap], selectionValue("add-marker")],
		["rendered deletion", PAGE, [fill, "var(--color-md-word-delete-bg)", overlap], selectionValue("delete-marker")],
		["Find match", PANEL, ["var(--color-accent)", overlap], "var(--color-accent-strong)"],
		["inline code", "var(--color-comment-card-bg)", [fill, "var(--color-muted-bg)", overlap], null],
		["merge word", PAGE, ["var(--color-merge-current-line)", fill, "var(--color-merge-current-word)", overlap], selectionInk],
		["trailing whitespace", PANEL, [...LINE_TINTS["selected del"], fill, "var(--color-trailing-ws-bg)", overlap], "var(--color-trailing-ws-fg)"],
	]) {
		check(`${state} selection on ${line}`, selectionInk, base, { layers, target: 4.5 });
		if (marker) check(`${state} selected ${line} marker`, marker, base, { layers, target: 3 });
	}
}

section("Merge comparison and editable Output");
for (const hue of SYN) check(`context and Output syntax ${hue}`, `var(--color-syn-${hue})`, PAGE);
check("plain context text", "var(--color-diff-text)", PAGE);
check("context line number", "var(--color-text-muted)", PAGE);
check("whitespace in context and Output", "var(--color-invisible)", PAGE);
check("trailing whitespace in context and Output", "var(--color-trailing-ws-fg)", PAGE, { layers: ["var(--color-trailing-ws-bg)"] });
check("plain Output text", "var(--color-text)", PAGE);
check("Output caret against the page", "var(--color-text)", PAGE, { target: 3 });
for (const [side, accent] of [["current", "var(--color-accent)"], ["incoming", "var(--color-accent-alt)"]]) {
	const line = `var(--color-merge-${side}-line)`;
	const word = `var(--color-merge-${side}-word)`;
	for (const hue of SYN) check(`${side} syntax ${hue}`, `var(--color-syn-${hue})`, PAGE, { layers: [line] });
	check(`${side} plain conflict text`, "var(--color-diff-text)", PAGE, { layers: [line] });
	for (const [action, color] of [["take", "--color-text-muted"], ["taken", "--color-success"], ["remove", "--color-danger"]]) {
		check(`${side} ${action} icon`, `var(${color})`, PAGE, { layers: [line], target: 3 });
	}
	check(`${side} line number`, "var(--color-text-muted)", PAGE, { layers: [line] });
	check(`${side} line rail`, accent, PAGE, { layers: [line], target: 3 });
	check(`${side} text on word`, "var(--color-diff-text)", PAGE, { layers: [line, word] });
	check(`${side} whitespace on line`, "var(--color-invisible)", PAGE, { layers: [line] });
	check(`${side} trailing whitespace on line`, "var(--color-trailing-ws-fg)", PAGE, { layers: [line, "var(--color-trailing-ws-bg)"] });
	checkSurfaces(`${side} word stands apart from its line`, PAGE, [line], [line, word], 2);
}

section("Rendered markdown marks (TRUNK-166): same rule, mark sits alone on the page");
for (const [origin, word, rule] of [
	["add", "var(--color-md-word-add-bg)", "var(--ok)"],
	["del", "var(--color-md-word-delete-bg)", "var(--err)"],
]) {
	check(`${origin} text on mark`, "var(--color-diff-text)", PAGE, { layers: [word] });
	check(`${origin} text on mark inside a code span`, "var(--color-diff-text)", PAGE, { layers: [word, "var(--color-muted-bg)"] });
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

const THREAD_TONES = [
	["open", "var(--color-thread-open)"],
	["addressed", "var(--color-thread-addressed)"],
	["done", "var(--color-thread-done)"],
	["dismissed", "var(--color-thread-dismissed)"],
	["stale", "var(--color-thread-stale)"],
];

section("State-aware review count pills and filter control (TRUNK-155)");
for (const [state, color] of THREAD_TONES) {
	check(`${state} pill`, "var(--accent-fg)", color);
}
check("review filter selector", "var(--color-text)", "var(--color-surface)");

section("Review state pills and thread attribution (TRUNK-334)");
for (const [state, color] of THREAD_TONES.filter(([state]) => state !== "dismissed")) {
	check(`${state} pill label on a card`, color, "var(--color-comment-card-bg)", { layers: [t(color, 12)] });
	check(`${state} pill label on the panel`, color, "var(--color-surface)", { layers: [t(color, 12)] });
}
check("excerpt line number on an added line", "var(--color-text-muted)", "var(--color-comment-card-bg)", { layers: ["var(--color-diff-add-bg)"] });
check("excerpt line number on a removed line", "var(--color-text-muted)", "var(--color-comment-card-bg)", { layers: ["var(--color-diff-delete-bg)"] });
check("excerpt line number on a context line", "var(--color-text-muted)", "var(--color-comment-card-bg)");
check("dismissed pill label on a card", "var(--color-thread-dismissed)", "var(--color-comment-card-bg)", { layers: ["var(--color-hover)"] });
check("agent name on a card", "var(--color-accent-alt)", "var(--color-comment-card-bg)");
for (const [state, color] of THREAD_TONES.filter(([state]) => state !== "stale")) {
	check(`${state} thread count in the diff gutter`, "var(--color-on-accent)", color);
}
for (const [state, color] of THREAD_TONES) {
	check(`${state} comment count on a resting row`, color, "var(--color-surface)");
	check(`${state} comment count on a hovered row`, color, "var(--color-hover)");
	check(`${state} comment count on a selected row`, color, "var(--color-selected-row)");
}

section("Unread marker and count (TRUNK-156)");
check("unread label on a card header", "var(--color-accent-strong)", "var(--color-comment-card-header-bg)");
check("unread label on a settled card header", "var(--color-accent-strong)", "var(--color-comment-card-bg)");
check("unread count in the panel header", "var(--color-accent-strong)", "var(--color-surface)");
check("unread dot on a card header", "var(--color-accent)", "var(--color-comment-card-header-bg)", { target: 3 });
check("unread dot on a settled card header", "var(--color-accent)", "var(--color-comment-card-bg)", { target: 3 });
check("unread dot in the panel header", "var(--color-accent)", "var(--color-surface)", { target: 3 });

section("Chip (lineage pills and branch chips, on --color-surface, the merge banner and the staging header)");
check("accent chip label", "var(--color-accent-strong)", "var(--color-surface)", { layers: ["var(--color-chip-accent-bg)"] });
check("accent chip label under the pointer", "var(--color-accent-strong)", "var(--color-surface)", { layers: ["var(--color-chip-accent-bg-hover)"] });
check("neutral chip label", "var(--color-text)", "var(--color-surface)", { layers: ["var(--color-muted-bg)"] });
check("neutral chip label under the pointer", "var(--color-text)", "var(--color-surface)", { layers: ["var(--color-muted-bg-hover)"] });
check("accent chip label on the merge banner", "var(--color-accent-strong)", "var(--color-surface)", { layers: ["var(--color-banner-warning-bg)", "var(--color-chip-accent-bg)"] });
check("accent chip label on the merge banner under the pointer", "var(--color-accent-strong)", "var(--color-surface)", { layers: ["var(--color-banner-warning-bg)", "var(--color-chip-accent-bg-hover)"] });
check("accent chip label on the staging header", "var(--color-accent-strong)", "var(--color-surface-raised)", { layers: ["var(--color-chip-accent-bg)"] });
check("accent chip label on the staging header under the pointer", "var(--color-accent-strong)", "var(--color-surface-raised)", { layers: ["var(--color-chip-accent-bg-hover)"] });

// The open tab's fill stands 1.06:1 off the bar and its edge 1.5:1, short of the
// 3:1 a state mark needs, so its label's medium weight is what tells it apart.
section("Repository tab (on the top bar's --color-surface)");
check("resting tab label", "var(--color-text-muted)", "var(--color-surface)");
check("tab label under the pointer", "var(--color-text)", "var(--color-surface)", { layers: [t("var(--color-hover)", 35)] });
check("open tab label", "var(--color-text-strong)", "var(--color-surface-chip)");
check("dirty dot on a resting tab", "var(--color-accent)", "var(--color-surface)", { target: 3 });
check("dirty dot on the open tab", "var(--color-accent)", "var(--color-surface-chip)", { target: 3 });

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
