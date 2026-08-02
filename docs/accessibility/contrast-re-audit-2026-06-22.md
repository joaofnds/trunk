# Trunk — App-Wide WCAG AAA Text-Contrast Re-Audit

Date: 2026-06-22 (second pass). Supersedes nothing in `AUDIT.md` (the first pass) — it
**re-derives every surface independently** against the live source and fixes the cases the
first pass missed or mis-modeled. Scope: every piece of text in `src/components/` + `src/App.svelte`
+ `src/app.css`, measured against its *actual rendered background* (hover / selected / tinted /
stacked layers and any `opacity` on the glyph).

## Method

Reused the existing dependency-free helper `contrast.mjs` (oklch → OKLab → linear sRGB → 8-bit
gamma sRGB → WCAG relative luminance; translucent layers composited source-over; `opacity:<1>`
on text modelled as compositing the glyph toward its backdrop; tokens parsed live from `app.css`).
Nothing was eyeballed — every ratio below is reproducible:

- `node scripts/contrast/re-audit-verify.mjs` — all fixed cases, post-fix (exit 1 on any miss).
- `node scripts/contrast/contrast.mjs '<fg>' '<base>' ['<layer>'...]` — any pair.

Process (workflow-orchestrated, 60 agents): 8 surface auditors each enumerated every text element
and ran the helper; **every non-AAA finding was then independently re-derived by an adversarial
verifier** (which re-read the source, re-built the worst-case background stack, and re-ran the
helper), plus a **completeness critic** per surface that hunted for overlooked elements and missed
stacked layers. The verifiers corrected several auditor tuples (wrong opaque base, missed `opacity`,
missed stacked tint) and reclassified several "transient AA" claims as real failures.

## Standard

- Normal text **AAA ≥ 7:1**. Large text (≥24px, or ≥18.66px bold) **≥ 4.5:1**.
- Exempt (WCAG 1.4.6): genuinely disabled controls (`--fg-4`, or an `opacity` applied only while a
  control is `:disabled`) and purely decorative / non-text glyphs (icons are non-text → governed by
  1.4.11 at 3:1, not 7:1). Each reliance on an exemption is called out below.
- Transient states (hover, selection, current-search-match, the stacked word-emphasis patch, active
  search de-emphasis) may land at AA where forcing AAA would wash the palette or defeat the feature.

## What the first pass missed — confirmed real failures, now fixed

| # | Element | Root cause | Before → After | Fix |
|---|---|---|---|---|
| 1 | Commit-row conventional-commit `": "` separator (`CommitRow.svelte`) | rendered in `--fg-4`, the **disabled-only** tier, for permanent message text | **2.05 → 7.25** (selected) / 8.65 (resting) | `var(--fg-4)` → `var(--fg-2)` |
| 2 | Diff syntax **punctuation** on a word-emphasized token (3 diff views) | `--color-syn-punctuation` (#acacac) too dim on the word-emphasis stack; it's neutral gray (no hue to wash), so it should be lifted, not left at AA | **5.15 → 7.27** (worst stack) | `--color-syn-punctuation` #acacac → **#cccccc** |
| 3 | Invisible-character markers (·/→/¶) over diff lines | `--color-invisible` was `color-mix(--fg-3 60%, transparent)` — a <1-alpha glyph composites toward the line tint; 6.76 resting, **3.04 selected** | **3.04 → 7.95** (worst single tint) | `--color-invisible` → opaque `oklch(0.78 0.006 260)` |
| 4 | Trailing-whitespace substitution glyphs over the red trailing-ws tint | same translucent `--color-invisible`, stacked on `--color-trailing-ws-bg` over a diff-line tint → **2.77** | **2.77 → 7.28** (rare triple) / 9.73 (selected del) | new opaque `--color-trailing-ws-fg: oklch(0.9 0.004 260)`; `.trailing-ws` uses it |
| 5 | "Discard Hunk/Lines" button (`HunkView`/`SplitView`) | red `--color-danger` on the **info-tinted** hunk header + danger-bg stack | **6.40 → 7.08** | `--err` 0.72 → **0.76** (lifts `--color-danger`) |
| 6 | "Abort" button (`OperationBanner`) | red `--color-danger` on the **info-tinted** operation banner + danger-bg stack | **6.44 → 7.13** | same `--err` lift |
| 7 | FileRow status badge **`T`** (and `A`) on a selected row | the badge's own 8% self-tint lightens its backdrop below 7:1 | **6.90 → 7.16** (T) / 7.10 (A) | badge tint `8%` → **6%** (`FileRow.svelte`) |
| 8 | FileRow `?` fallback badge on a selected row | letter used `--color-text-muted` (fg-2) | **6.35 → 9.95** | fallback color → `var(--color-text)` |
| 9 | ReviewPanel orphan-comment **file-ref** | `opacity: var(--opacity-dimmed)` (0.6) on the sole carrier of the file:line location | **3.59 → 7.68** | `.comment-card-fileref-dim` → solid `color: var(--fg-3)` (drop opacity) |
| 10 | ReviewPanel orphan-comment **diff excerpt + gutter** | same `opacity:0.6` on the only place that code is shown | **3.53 → 7.68** | removed `.comment-card-diff-dim` opacity (orphan signalled by the badge) |
| 11 | RebaseEditor **DROP-row** message/author/date | `opacity: var(--opacity-dimmed)` (0.6) on a persistent plan state; date at **3.46** (sub-AA) | msg **4.88 → 7.65** (AAA); date **3.46 → 5.11** (AA) | `--opacity-dimmed` 0.6 → **0.8** |
| 12 | Search-dim non-match rows (`CommitRow`) | inline `opacity: 0.6` on `--fg-2` sub-text → **3.46** (sub-AA) | **3.46 → 5.12** (AA) | new token `--opacity-search-dim: 0.75` |
| 13 | Search-dim graph overlay (`CommitGraph`) | inline `opacity: 0.4` on ref-pill labels → **2.03** (sub-AA) | **2.03 → 4.84** (AA) | same `--opacity-search-dim` token |

### `--err` 0.72 → 0.76 — blast radius (verified benign)

`--err` feeds diff-delete tints, the word-emphasis-delete tint, `--color-trailing-ws-bg`, the
`D` status, `--color-danger*`, `--color-error`, and the armed danger fill. After the lift:
diff-delete syntax stays AAA (syn-keyword on selected delete 7.32 → 7.16); the word-emphasis-delete
stack stays inside its **documented AA exemption** (syn-comment 5.58 → 5.37); **light** text on the
armed `--color-danger-bg-strong` fill stays AAA (fg-1 8.51 → 8.22); status `D` improves
(7.76 → 8.51 resting). No regression.

## Intentionally left at AA (transient / secondary — each justified)

All **default / resting** informational text now clears AAA. These remain AA by design; color is
never the sole carrier in any of them:

- **FileRow `D`/`R` badges on a *selected* row** (6.65 / 6.48): AAA on the normal row; AA only while
  the row is the active selection. The letter shape + filename carry the meaning. Forcing AAA needs
  darkening the global `--bg-selected` (17-site blast radius) or washing the err/info hues.
- **Commit `": "` separator on the *current-search-match* row** (6.40): the lit search highlight is
  intentionally bright; the separator is muted secondary punctuation, AAA in every other state.
- **Diff syntax (colored hues) over the *word-emphasis* stack** (5.1–5.8): the documented
  stacked-emphasis exemption (`diff_contrast_aaa`). Lifting the colored hues toward white to reach
  7:1 collapses hue separation; the add/delete signal rides the colored rail. (Neutral punctuation
  was the one exception and *was* lifted — #1 above.)
- **Diff gutter numbers / FileRow & DirectoryRow & MergeEditor hover action glyphs on a selected
  line** (6.5–6.7): selection / hover-only transient; glyphs are 11px icons (3:1 non-text floor) and
  the data is also carried by the line tint + rail.
- **Rebase DROP-row date** (5.11) and **search-dimmed non-match content** (4.6–5.1): deliberate
  de-emphasis of a persistent-plan / actively-filtered state; primary text (drop message, match
  rows) is AAA and the de-emphasis is also carried by strike-through / the match highlight.
- **Ref pill on a search-match row during active search** (compound transient, can dip below AA):
  the ref pill is independently an AA-transient even at rest on a lit row (lane hue on its own
  capsule), and the SVG overlay dims uniformly; the ref name is duplicated in the sidebar. A clean
  AAA fix needs per-row (not whole-overlay) dimming — a logic change, out of this token-only scope.

## Exempt (called out)

- `--fg-4` — disabled controls only; no longer used for any real text (the `": "` separator was the
  last misuse, now fixed).
- Disabled-only `opacity` (Toolbar/PullDropdown `:disabled` 0.45; InputDialog/WelcomeScreen submit
  0.5 when invalid; diff staging +/- buttons 0.4 when disabled; RebaseEditor `.rebase-btn:disabled`).
- Drag-transient `opacity` (SortableJS `.tab-ghost`/`.tab-drag`/`.tab-chosen`,
  `.rebase-row-ghost`/`-drag`/`-fallback`) — momentary direct-manipulation affordances; the dragged
  clone is rendered at full contrast on a real tab/row background.
- Non-text glyphs: branch leading dots, the dirty-tab dot, category icons (Tag/Archive/file-list
  toggle) — governed by 1.4.11 (3:1), which they clear; their meaning is also in adjacent text.

## Diff viewer

Re-verified post-`--err` lift: delete-line syntax still AAA, the word-emphasis stack stays at its
documented AA, invisibles and trailing-ws now AAA. No regression.

## Gate

`just check` green (fmt, biome ci, svelte-check, clippy `--all-targets -D warnings`, all Rust tests,
635 frontend tests). `node scripts/contrast/re-audit-verify.mjs` → ALL TARGETS MET.
