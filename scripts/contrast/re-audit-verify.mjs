// Reproducible post-fix verification for the 2026-06-22 app-wide AAA re-audit.
// Parses tokens LIVE from src/app.css via contrast.mjs, so it tracks the theme.
// Run: node scripts/contrast/re-audit-verify.mjs   (exit 1 if any target missed)

import { contrast, verdict } from "./contrast.mjs";

let fails = 0;
const rows = [];
function check(label, fg, base, { layers = [], opacity = null, target = 7 } = {}) {
	const r = contrast(fg, base, { layers, opacity: opacity ?? undefined });
	const ok = r >= target;
	if (!ok) fails++;
	rows.push(`  ${ok ? "OK " : "!! "} ${r.toFixed(2)} ${verdict(r).padEnd(4)} (>=${target}) ${label}`);
}
const section = (t) => rows.push(`\n== ${t} ==`);

const DIFF = "var(--bg-1)";
const t = (c, p) => `color-mix(in oklch, ${c} ${p}%, transparent)`;

section('CommitRow ": " separator (--fg-4 -> --fg-2): default AAA, transient AA');
check("resting", "var(--fg-2)", DIFF);
check("hover", "var(--fg-2)", "var(--bg-hover)");
check("selected", "var(--fg-2)", "var(--bg-selected)");
check("current-search-match (transient)", "var(--fg-2)", DIFF, { layers: ["var(--color-search-current)"], target: 4.5 });

section("syn-punctuation (#acacac -> #cccccc) over word-emphasis stack: AAA");
check("selected add + word", "var(--color-syn-punctuation)", DIFF, { layers: ["var(--diff-add-hi)", "var(--color-diff-word-add-bg)"] });
check("selected del + word", "var(--color-syn-punctuation)", DIFF, { layers: ["var(--diff-del-hi)", "var(--color-diff-word-delete-bg)"] });

section("invisible-char marker (translucent fg-3 -> opaque L0.78): single diff tints AAA");
check("context", "var(--color-invisible)", DIFF);
check("resting add", "var(--color-invisible)", DIFF, { layers: ["var(--diff-add-bg)"] });
check("selected add", "var(--color-invisible)", DIFF, { layers: ["var(--diff-add-hi)"] });
check("selected del", "var(--color-invisible)", DIFF, { layers: ["var(--diff-del-hi)"] });

section("trailing-ws glyph (new --color-trailing-ws-fg L0.90): stacks AAA incl. rare triple");
check("context + tws", "var(--color-trailing-ws-fg)", DIFF, { layers: ["var(--color-trailing-ws-bg)"] });
check("selected del + tws", "var(--color-trailing-ws-fg)", DIFF, { layers: ["var(--diff-del-hi)", "var(--color-trailing-ws-bg)"] });
check("selected del + word + tws (rare)", "var(--color-trailing-ws-fg)", DIFF, { layers: ["var(--diff-del-hi)", "var(--color-diff-word-delete-bg)", "var(--color-trailing-ws-bg)"] });

section("Danger buttons (--err 0.72 -> 0.76 lifts --color-danger): AAA on tinted chrome");
check("Discard (hunk-header info tint + danger-bg)", "var(--color-danger)", "color-mix(in oklch, var(--info) 6%, var(--bg-2))", { layers: ["var(--color-danger-bg)"] });
check("Abort (banner info tint + danger-bg)", "var(--color-danger)", DIFF, { layers: ["var(--color-banner-info-bg)", "var(--color-danger-bg)"] });
check("plain danger label on bg-1", "var(--color-danger)", DIFF, { layers: ["var(--color-danger-bg)"] });

section("FileRow status badge (tint 8% -> 6%): A/T/? selected AAA; D/R selected AA (transient)");
check("A selected", "var(--ok)", "var(--bg-selected)", { layers: [t("var(--ok)", 6)] });
check("T selected", "var(--color-status-typechange)", "var(--bg-selected)", { layers: [t("var(--color-status-typechange)", 6)] });
check("? selected (muted -> --color-text)", "var(--color-text)", "var(--bg-selected)", { layers: [t("var(--color-text)", 6)] });
check("D selected (transient)", "var(--color-status-deleted)", "var(--bg-selected)", { layers: [t("var(--color-status-deleted)", 6)], target: 4.5 });
check("R selected (transient)", "var(--color-status-renamed)", "var(--bg-selected)", { layers: [t("var(--color-status-renamed)", 6)], target: 4.5 });
check("D resting (AAA)", "var(--color-status-deleted)", DIFF, { layers: [t("var(--color-status-deleted)", 6)] });
check("R resting (AAA)", "var(--color-status-renamed)", DIFF, { layers: [t("var(--color-status-renamed)", 6)] });

section("ReviewPanel orphan comment (opacity-on-text removed)");
check("fileref dim -> solid --fg-3", "var(--fg-3)", "var(--color-surface)");
check("diff gutter now full --fg-2 (add line)", "var(--color-text-muted)", "var(--color-bg)", { layers: ["var(--color-diff-add-bg)"] });

section("Rebase DROP row (--opacity-dimmed 0.6 -> 0.8): message AAA, date AA (transient)");
check("message --fg-1", "var(--fg-1)", "var(--color-selected-row)", { opacity: 0.8 });
check("author --fg-1", "var(--fg-1)", "var(--color-selected-row)", { opacity: 0.8 });
check("date --fg-2 (transient)", "var(--fg-2)", "var(--color-selected-row)", { opacity: 0.8, target: 4.5 });

section("Search-dim (new --opacity-search-dim 0.75): non-match content AA (transient)");
check("row sub-text --fg-2 / bg-1", "var(--fg-2)", DIFF, { opacity: 0.75, target: 4.5 });
check("row sub-text --fg-2 / bg-selected", "var(--fg-2)", "var(--bg-selected)", { opacity: 0.75, target: 4.5 });
check("graph ref pill (worst lane-2) non-match", "var(--lane-2)", DIFF, { layers: [t("var(--lane-2)", 14)], opacity: 0.75, target: 4.5 });

console.log(rows.join("\n"));
console.log(`\n${fails === 0 ? "ALL TARGETS MET" : `${fails} TARGET(S) MISSED`}`);
process.exit(fails === 0 ? 0 : 1);
