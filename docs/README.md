# Trunk docs

Reference material that outlives the change that produced it. Anything task-scoped —
specs, plans, review reports — stays in the gitignored `.boris/` tree instead.

## Architecture

| Doc | What it covers |
|-----|----------------|
| [architecture/commit-graph.md](architecture/commit-graph.md) | The graph pipeline end to end: `placement.rs` column and edge assignment, the `active-lanes.ts` overlay translation, SVG path building, and the invariants each layer owns. Read before changing lane assignment, edge emission, or node rendering; the binding rules are in `.claude/rules/commit-graph.md`. |
| [architecture/diff-highlighting.md](architecture/diff-highlighting.md) | The diff syntax-highlighting cost model: the bounded lookback window and how faithful it is, why cost now scales with a change's span rather than its depth, what that makes slower, the measured split between parsing and theme matching, the three guards that bound pathological input, and the optimisations that were measured and rejected. Read before touching `syntax.rs` or diff enrichment. |
| [architecture/diff-virtualization.md](architecture/diff-virtualization.md) | How all three diff views render through one row model and one virtual list: why heights are computed and never measured, the sticky-row plus shared-`--pan-x` mechanism split view pans with, and the four ways that mechanism has been re-derived wrongly. Read before touching a diff view's geometry. |
| [architecture/scrollbars.md](architecture/scrollbars.md) | Why every native scrollbar is hidden and a themed thumb is painted from JS instead, why the thumb shows only while scrolling, how dragging it works, and the viewport-padding trap that made lists which fit still scroll. Read before touching `scrollbar-activity.ts`, the `::-webkit-scrollbar` rule, or `VirtualList`'s height measurement. |
| [architecture/overview.md](architecture/overview.md) | Whole-system map — component tree, Rust command modules, state ownership. A 2026-05-14 snapshot, not kept current. |
| [review-cli.md](review-cli.md) | The `trunk review` CLI: the four verbs, repo and store discovery, the agent-attribution and no-leak rules, the error contract, and how live reflection reaches the running app. Read before extending the CLI or changing the review store's schema. |

## Decisions

| Doc | Outcome |
|-----|---------|
| [decisions/2026-06-20-pierre-diffs.md](decisions/2026-06-20-pierre-diffs.md) | Rejected `@pierre/diffs`; closed the syntax-highlighting gap natively in Rust with the `two-face` syntect crate. |

## Research

| Doc | What it covers |
|-----|----------------|
| [research/large-file-diff-rendering.md](research/large-file-diff-rendering.md) | How VS Code, Zed, JetBrains, Sublime Merge, GitHub Desktop, GitHub, GitLab, Gerrit, delta and difftastic keep large-file diffs fast: thresholds, virtualization granularity, off-thread parsing and cancellation. Records which techniques depend on the diff being read-only, and which trunk tried, measured or declined. |
| [research/gitamine-graph-algorithm.md](research/gitamine-graph-algorithm.md) | The gitamine "straight branches" placement algorithm, compared against Trunk's `placement.rs`. |

## Accessibility

The theme targets WCAG AAA for text contrast. `scripts/contrast/re-audit-verify.mjs` is the
gate: it parses the tokens live from `src/app.css` and exits 1 if any target is missed. Run it
after touching a color token.

| Doc | What it covers |
|-----|----------------|
| [accessibility/contrast-re-audit-2026-06-22.md](accessibility/contrast-re-audit-2026-06-22.md) | The authoritative pass — every surface re-derived against live source, with the fixes that landed. |
| [accessibility/contrast-audit-2026-06-22.md](accessibility/contrast-audit-2026-06-22.md) | The first pass. Superseded on the numbers, kept for its method write-up. |

## Performance

| Doc | What it covers |
|-----|----------------|
| [benchmark-gate.md](benchmark-gate.md) | The CI benchmark gate: why it compares each benchmark divided by a calibration benchmark of its workload class rather than raw nanoseconds, which benchmark belongs to which class, how to read a failure, and the three things that reset the baseline. Read before changing `.github/workflows/benchmarks.yml`, `scripts/bench-normalize.ts`, or any calibration benchmark. |
| [performance-instrumentation.md](performance-instrumentation.md) | The standing measurement tooling: `just perf` and `just perf-report`, what is instrumented automatically (every Tauri command, frame gaps) and how to add a named span, why percentiles are nearest-rank, and why the gate is an env var rather than `import.meta.env.DEV`. Read before measuring anything. |
| [build-environment.md](build-environment.md) | What `just check`'s speed depends on outside the repo: the single pinned toolchain shared by every session, the macOS Gatekeeper stall that turns minute gates into hour gates and how to diagnose it, and why no scanner may walk `src-tauri/target`. Read when the gate is slow with idle CPUs. |

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
| [decisions/2026-08-31-snapshot-pin-sweep.md](decisions/2026-08-31-snapshot-pin-sweep.md) | Why a superseded snapshot's keepalive ref is reclaimed by a two-pass sweep instead of pruned when the snapshot is superseded: a comment is submitted as two calls, so a prune in between unpins the commit the arriving thread anchors to and gc collects the comment. Read before changing snapshot pinning, `ensure_review_snapshot`, or the sweep's call sites. |
| [decisions/2026-08-31-test-only-api-on-production-types.md](decisions/2026-08-31-test-only-api-on-production-types.md) | How a test waits on async production code without a wall-clock deadline: put the affordance on the production type behind a non-default `test-util` cargo feature, as tokio does for `time::pause` and Go does for `synctest.Wait`. Why `cfg(test)` cannot serve the suites in `src-tauri/tests/`, and how to verify such a gate — check the release rlib's symbols, never a dev target. Read before adding a test-only method or waiting on a duration. |
| [application-harness.md](application-harness.md) | `just app-test`: how a test drives the real component tree into the real command handlers against a real repository, what the host process and the transport seam do, what is deliberately faked (the watcher, the traffic lights, three Tauri surfaces), and the per-scenario budget. Read before adding a test under `tests/app/`. |
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
