# Trunk — App-Wide WCAG AAA Text-Contrast Audit

Date: 2026-06-22. Scope: every piece of text in the UI (`src/components/`, `src/app.css`),
measured against the *actual rendered background* including hover/selected/tinted/stacked
layers and any `opacity` on the text.

## Method

WCAG 2.x contrast is computed on sRGB relative luminance, not oklch lightness. A deterministic
helper (`contrast.mjs`, no deps) does the math; nothing was eyeballed:

1. **oklch → OKLab → linear sRGB → gamma sRGB** (rounded through 8-bit, faithful to WCAG's
   8-bit inputs) → relative luminance → ratio `(L1+0.05)/(L2+0.05)`.
2. Translucent layers (`color-mix(in oklch, C p%, transparent)`) resolve to `C` at alpha `p/100`
   and are composited **source-over in gamma sRGB space** — the way browsers actually blend
   overlapping semi-transparent `background-color`s and `opacity`.
3. `opacity:<1>` on text composites the glyph toward its backdrop (a contrast killer) and is
   modelled the same way.
4. Tokens are parsed live from `app.css`, so the helper never drifts from the theme.

Reproduce: `node scripts/contrast/contrast.mjs '<fg>' '<base>' ['<layer>'...]` (any pair).
The one-shot derivation scripts this pass used (`matrix.mjs`, `final-audit.mjs`, and the
`solve*.mjs` family) were retired with `.planning/`; read them at
`git show 5fd4683:.planning/contrast/matrix.mjs`. The live gate is the second pass —
`node scripts/contrast/re-audit-verify.mjs`, see `contrast-re-audit-2026-06-22.md`.

Process: 7 review agents (one per UI surface) mapped each text element to its worst-case
composited background; every AA/FAIL finding was then independently re-derived by a second agent
before being trusted (several auditor numbers were corrected in that pass).

## Standard

- Normal text **AAA ≥ 7:1**. Large text (≥24px, or ≥18.66px bold) **≥ 4.5:1**.
- Exempt (WCAG 1.4.6): genuinely disabled controls (`--fg-4`) and purely decorative text.
- Transient/secondary states (hover, selection, current-search-match, the stacked word-emphasis
  case) may target AA where AAA forces a washed result — each is listed below.

## Root causes & token fixes (`src/app.css`)

AAA forces neutral text to L≈0.67 on these near-black surfaces, so the dim end of the ramp had
to compress upward. Ratios are worst-case on the surfaces each token actually renders on.

| Token | Before | After | What it fixes | Before→After (worst real surface) |
|---|---|---|---|---|
| `--fg-3` (tertiary/captions) | `oklch(0.54 …)` | `oklch(0.70 …)` | remote names, column headers, author email/date, mode tabs, commit hints | 4.09 → **7.50** (bg-1/bg-2) |
| `--fg-2` (secondary, `--color-text-muted`) | `oklch(0.68 …)` | `oklch(0.73 …)` | search counter, dragged tab, stash/branch/path subtitles, file counts, gutters, labels | 5.97 → **7.25** (bg-selected) |
| `--err` (`--color-danger`, status "D") | `oklch(0.68 …)` | `oklch(0.72 …)` | error text, deleted "D", danger button labels, deleted-line counts | 6.62 → **7.76** (bg-1) |
| `--lane-5`, `--lane-7` | `L0.70` | `L0.76` | ref-pill text (lane color on its own capsule) | 5.72 → **8.00** (graph bg) |
| `--color-danger-bg` | `err 15%` | `err 9%` | red danger-button/alert text on its own red tint | 5.72 → **7.13** (bg-1) |
| `--color-accent-bg` | `accent 15%` | `accent 9%` | diff "Comment" button, accent fills | 6.81 → **7.67** |
| `--color-success-bg` | `ok 15%` | `ok 9%` | "Stage"/"Continue"/"Take All" button labels | 6.69 → **7.52** |
| `--color-danger-bg-strong` | *(new)* | `err 30%` | armed "click again to confirm" hover fill (dark enough for light text) | — → **8.51** |
| `--opacity-dimmed` | `0.4` | `0.6` | rebase "drop" rows, orphaned-comment text (primary text → AA) | 2.77 → **5.12** |
| `--color-placeholder` rule | *(UA default ~0.54α)* | `--color-text-muted`, `opacity:1` | every input/textarea placeholder | 4.30 → **8.44/8.72** |

A global `input::placeholder, textarea::placeholder { color: var(--color-text-muted); opacity: 1 }`
rule replaces the UA default, which dimmed placeholders (a NON-exempt, must-be-legible role) to
~0.54 opacity of the input color (≈ 3.2–4.3:1).

## Component fixes (token/color/opacity only — no layout)

| File | Change | Before→After |
|---|---|---|
| `FileRow.svelte` | status-badge tint 18% → 8% | "D" on selected row 4.33 → **5.81** (AA), AAA on normal rows |
| `CommitGraph.svelte` | SVG pill capsule fill-opacity 0.2→0.14, +N badge 0.2→0.14, hover-tooltip lane 20%→14%, multi-ref hover `bg-white/15`→`/8` | pill text 4.59 → **8.00** (graph bg) |
| `CommitGraph.svelte` | search-dim graph overlay opacity 0.2 → 0.4 | transient de-emphasis (see exceptions) |
| `CommitRow.svelte` | search-dim non-match row opacity 0.35 → 0.6 | message 2.52 → **5.12** (AA) |
| `StagingPanel.svelte` | header branch pill lane tint 22% → 14% | 6.95 → **8.25** |
| `ReviewPanel.svelte` | "confirming" end-review button: dark `--color-on-accent` → light `--fg-1`; hover fill `--color-danger` → `--color-danger-bg-strong` | **1.12 → 12.41** (resting), **8.51** (hover) |
| `BranchSidebar.svelte` | stash id `--fg-4` (disabled token misused for real text) → `--fg-2` | 1.86 → **7.88** |

## Intentionally left at AA (transient/secondary states — each justified)

All *default-state* informational text now clears AAA. These remain AA (≥4.5) by design, because
forcing AAA would wash the palette or defeat a feature; color is never the sole carrier in any of
them:

- **Status badges / ref pills / diff gutter numbers on a *selected/focused* row** (5.8–6.9): AAA
  on the normal row, AA only while that row is the active selection (transient). The letter shape
  / branch name / line number carries the meaning regardless of color.
- **Commit author·date·SHA on the *current-search-match* highlight** (6.40): the lit-up
  current-match background is intentionally bright; the primary commit message stays AAA.
- **Diff hunk-toolbar "Discard" button** (6.40): dense toolbar that appears on hover/expand;
  red label on a red tint over the info-tinted hunk header.
- **Rebase "Abort" button on the operation banner** (6.44): danger button on the info-tinted
  banner; its siblings "Continue"/"Skip" are AAA, and any banner tint pushes red-on-red below 7.
- **Error toast over a *selected-row* backdrop** (5.72): 7.20 over the typical dark backdrop; the
  toast is a transient overlay carrying an error icon.
- **Diff syntax tokens over the word-emphasis stack** (5.28): the pre-existing documented
  stacked-emphasis exemption (see `diff_contrast_aaa`); the line tint + word-emphasis tint stack,
  and the add/delete signal rides the colored rail.

## Intentionally below AA (de-emphasized non-essential content — justified)

- **Search-dimmed *secondary* columns** (author/date/SHA ≈ 3.6) of *non-matching* rows during an
  active search: the primary commit message stays AA, matching rows keep full contrast + a
  highlight, and clearing the search restores everything. These are the muted tier on rows the
  user is explicitly filtering past.
- **Orphaned-comment file reference** (≈ 3.6): a non-actionable, anchor-lost reference shown
  deliberately de-emphasized; the comment body/excerpt stays AA.

## Exempt

- `--fg-4` — disabled controls only (e.g. disabled toolbar buttons). It is no longer used for any
  real text (the stash-id misuse was fixed).
- `--accent-lo` — defined in the ramp but has **no call sites**; never rendered as text.
- Decorative graph lines/dots, connector strokes, and icons paired with text labels.

## Diff viewer

Re-verified: the `--err` lift (0.68→0.72) slightly lightens the delete tints, but delete-line
syntax still clears AAA (e.g. comment on selected delete line 7.40), and the word-emphasis stack
stays at its documented AA. No regression.
