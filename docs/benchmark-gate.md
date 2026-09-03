# The CI benchmark gate

`.github/workflows/benchmarks.yml` runs the criterion suite on every push to `main` and
fails the build when a benchmark gets slower than the previous run. This page says what it
compares and why, because the obvious reading of the numbers is wrong.

## What it compares

Not nanoseconds. GitHub's hosted runners vary enough that the same code measures 1.7x to
3.0x apart from one run to the next, which is wider than any threshold worth setting. The
gate compares each benchmark **divided by a calibration benchmark of the same workload
class**, so the runner's speed cancels and the code's cost is what is left.

Two calibrations live in `src-tauri/benches/bench_commands.rs`:

| Calibration | Measures | Divides |
|---|---|---|
| `calibration/syntect` | A fixed syntect highlight of an embedded TypeScript constant | `diff_ts_full_pipeline`, `enrich_ts_new_perfile`, every `diff_ts_large_file/*` |
| `calibration/git2` | A fixed revwalk and blob read over a repository the benchmark builds itself | `list_refs_inner`, `diff_unstaged_inner`, `get_status_inner`, `stage_hunk_inner`, every `snapshot/*`, `toggle_visibility/*`, `ipc_round_trip/*` and `startup/*` |

`reviewdb_draft_write` is excluded. It measures an fsync, it fits neither calibration, and
its own doc comment in the bench file says a threshold on it reports how loaded the runner
was rather than anything about Trunk.

**The calibrations must never call `trunk_lib`.** Their whole job is to move with the
machine and not with our code. A calibration that tracked Trunk's code would divide a real
regression away, which is exactly what happened to the two syntect benchmarks in August
2026: both got 1.3x slower from one commit, so their ratio to each other never moved.

`scripts/bench-gate.ts` does the division and `scripts/bench-normalize.ts` holds the class
table. The emitted names carry a `norm/` prefix and the value is the ratio scaled by one
million. The unit still reads `ns/iter` because the action's parser requires that shape, so
`norm/` is the signal that the number is not a duration. The raw criterion output is
uploaded as the `criterion-bencher-output` artifact on every run.

## Reading a failure

The alert names a benchmark, a previous value and a current one, both normalized. A ratio
at or above 1.30 fails the build.

Before looking for a regression, check the artifact: if the raw nanoseconds moved but the
normalized value did not, the runner was slow and the gate is doing its job. If the
normalized value moved, `git diff <previous-sha>..<this-sha> -- src-tauri/src/` is the
first thing to read. A local A/B on one machine, both commits, criterion's default sample
count, is what settles it. CI cannot.

No timing result says anything about whether the output is *correct*. This gate is not a
correctness gate.

## What resets the baseline

The baseline lives in a GitHub Actions cache entry keyed
`Linux-benchmark-<run_id>-<run_attempt>`, restored by the `Linux-benchmark-` prefix. Every
run misses its own key and therefore saves a fresh entry, which is the bug this design
replaced: a static key produced an exact hit, and `actions/cache` skips its post-job save on
an exact hit, so the baseline sat frozen from 2026-08-19 to 2026-08-28 while every run
compared against it.

Three things reset it, and all three are fine:

- **A week without a push to `main`.** Actions caches are evicted after seven days idle. The
  next run finds no baseline, emits no alert and starts a new series.
- **Bumping `syntect`, `two-face` or `git2`.** The calibration moves, so every normalized
  value in its class moves with it. This is a visible `Cargo.lock` change, and the first run
  after it may alert once.
- **Changing what a calibration measures.** Do not, unless you mean to reset every series.

To reset by hand, delete the cache entries: `gh cache list` then
`gh cache delete <id>` for each `Linux-benchmark-` key.

## The threshold

`alert-threshold: '130%'`. The measured spread of same-class ratios across the thirteen runs
from 2026-08-02 to 2026-08-27 was 1.046x, and the one real regression the gate has caught
read 1.306x normalized against 1.325x raw. 130% sits between them with room on both sides.

That number is a starting point measured on a *proxy* for the calibrations, since the
calibrations themselves did not exist in those runs. Re-derive it once five runs of real
normalized data exist.
