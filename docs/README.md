# Trunk docs

Reference material that outlives the change that produced it. Anything task-scoped —
specs, plans, review reports — stays in the gitignored `.boris/` tree instead.

## Architecture

| Doc | What it covers |
|-----|----------------|
| [architecture/commit-graph.md](architecture/commit-graph.md) | The graph pipeline end to end: `placement.rs` column and edge assignment, the `active-lanes.ts` overlay translation, SVG path building, and the invariants each layer owns. Read before changing lane assignment, edge emission, or node rendering; the binding rules are in `.claude/rules/commit-graph.md`. |
| [architecture/overview.md](architecture/overview.md) | Whole-system map — component tree, Rust command modules, state ownership. A 2026-05-14 snapshot, not kept current. |

## Decisions

| Doc | Outcome |
|-----|---------|
| [decisions/2026-06-20-pierre-diffs.md](decisions/2026-06-20-pierre-diffs.md) | Rejected `@pierre/diffs`; closed the syntax-highlighting gap natively in Rust with the `two-face` syntect crate. |

## Research

| Doc | What it covers |
|-----|----------------|
| [research/gitamine-graph-algorithm.md](research/gitamine-graph-algorithm.md) | The gitamine "straight branches" placement algorithm, compared against Trunk's `placement.rs`. |

## Accessibility

The theme targets WCAG AAA for text contrast. `scripts/contrast/re-audit-verify.mjs` is the
gate: it parses the tokens live from `src/app.css` and exits 1 if any target is missed. Run it
after touching a color token.

| Doc | What it covers |
|-----|----------------|
| [accessibility/contrast-re-audit-2026-06-22.md](accessibility/contrast-re-audit-2026-06-22.md) | The authoritative pass — every surface re-derived against live source, with the fixes that landed. |
| [accessibility/contrast-audit-2026-06-22.md](accessibility/contrast-audit-2026-06-22.md) | The first pass. Superseded on the numbers, kept for its method write-up. |

## Known issues

[known-issues/](known-issues/) holds open bugs that are reproduced and understood but not yet
fixed, one file each. Delete the file when the fix lands. Paid-down and pending *debt* lives in
`TECH_DEBT.md` at the repo root instead — these are behavioral defects, not debt.

## History

| Doc | What it covers |
|-----|----------------|
| [history/milestones.md](history/milestones.md) | What each shipped milestone (v0.1–v0.14) delivered. |
| [history/retrospective.md](history/retrospective.md) | Lessons per milestone: what worked, what was inefficient, what to do differently. |

## Testing

| Doc | What it covers |
|-----|----------------|
| [macos-e2e-validation.md](macos-e2e-validation.md) | Why the wdio e2e suite cannot run on macOS, and what CI does instead. |
| [commit-graph-mutation-ledger.md](commit-graph-mutation-ledger.md) | What the commit-graph suite's mutation coverage actually is: every measured site, its verdict, and a construction proof for each survivor that cannot be killed. A dated audit, not a gate — `just graph-sweep` regenerates the table, `just graph-sweep-check` is the alarm that runs in `just check`. |
| [commit-graph-changelog.md](commit-graph-changelog.md) | Every accepted change to a commit-graph golden, with the reason it was accepted. Written only by `just graph-accept "<reason>"`; a red golden is a suspected defect, so an entry here is the record that someone decided otherwise. |

## Retired planning tree

Trunk used GSD (`/gsd:*`) through v0.14. Its `.planning/` directory — milestone and phase
docs, quick tasks, resolved debug notes, closed todos — was retired on 2026-08-02. Everything
not carried into this folder is still in git history:

```bash
git show 5fd4683:.planning/STATE.md            # read one file
git ls-tree -r --name-only 5fd4683 .planning   # list them all
```
