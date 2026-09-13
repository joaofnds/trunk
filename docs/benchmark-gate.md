# The CI benchmark gate

`.github/workflows/benchmarks.yml` runs the criterion suite on every push to `main` and
fails the build when a benchmark gets slower than the previous run. This page says what it
compares and why, because the obvious reading of the numbers is wrong.

## What it compares

Not nanoseconds. GitHub's hosted runners vary enough that the same code measures 1.7x to
3.0x apart from one run to the next, which is wider than any threshold worth setting. The
gate compares each benchmark **divided by a calibration benchmark of the same workload
class**, so the runner's speed cancels and the code's cost is what is left.

Three calibrations live in `src-tauri/benches/bench_commands.rs`:

| Calibration | Measures | Divides |
|---|---|---|
| `calibration/syntect-v1` | A fixed syntect highlight of an embedded TypeScript constant | `diff_ts_full_pipeline`, `enrich_ts_new_perfile`, every `diff_ts_large_file/*` |
| `calibration/git2-v1` | A fixed revwalk and blob read over a repository the benchmark builds itself | `list_refs_inner`, every `snapshot/*` and `toggle_visibility/*`, the graph and refs `ipc_round_trip/*` benchmarks, and `startup/*` |
| `calibration/worktree-v1` | Fixed status and diff reads over a modified working tree through git2 directly | `diff_unstaged_inner`, `get_status_inner`, `stage_hunk_inner`, and `ipc_round_trip/diff_unstaged` |

`reviewdb_draft_write` is excluded. It measures an fsync, it fits neither calibration, and
its own doc comment in the bench file says a threshold on it reports how loaded the runner
was rather than anything about Trunk.

**The calibrations must never call `trunk_lib`.** Their whole job is to move with the
machine and not with our code. A calibration that tracked Trunk's code would divide a real
regression away, which is exactly what happened to the two syntect benchmarks in August
2026: both got 1.3x slower from one commit, so their ratio to each other never moved.

`scripts/bench-gate.ts` does the division and `scripts/bench-normalize.ts` holds the class
table. The emitted names use `norm/<calibration-id>/`; the normalizer derives that namespace
from the calibration name, so a generation change starts a fresh compatible series. The
value is the ratio scaled by one million. The unit still reads `ns/iter` because the
action's parser requires that shape, so `norm/` is the signal that the number is not a
duration. The raw criterion output is uploaded as the `criterion-bencher-output` artifact
on every run.

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

## History and calibration generations

The baseline lives in a GitHub Actions cache entry keyed
`Linux-benchmark-<run_id>-<run_attempt>`, restored by the `Linux-benchmark-` prefix. Every
run misses its own key and therefore saves a fresh entry, which is the bug this design
replaced: a static key produced an exact hit, and `actions/cache` skips its post-job save on
an exact hit, so the baseline sat frozen from 2026-08-19 to 2026-08-28 while every run
compared against it. A week without a push to `main` can evict that whole cache; the next run
then starts history for every series again.

Each calibration's `-vN` suffix is its compatibility generation. When its workload or a
dependency it calls changes, bump that suffix in the Rust benchmark. The class table matches
the stable calibration prefix and derives `norm/<calibration-id>/` from the result, so the
generation has one source of truth. Its new name starts history only for benchmarks in that
class; unaffected series keep their cached history. Seeing two generations in one run is an
error rather than an arbitrary choice between them.

To reset by hand, delete the cache entries: `gh cache list` then
`gh cache delete <id>` for each `Linux-benchmark-` key.

## The threshold

`alert-threshold: '130%'`. Proxy-normalized results from thirteen runs between 2026-08-02
and 2026-08-27 had a 1.046x same-class spread, while the one confirmed regression read
1.306x normalized and 1.325x raw. That evidence put 130% between noise and signal.

The proxy treated git2 work as one speed dimension. Runs 34656946873 and 34722813882 later
disproved that assumption on unchanged Rust: the git2 object calibration moved 1.80x, while
working-tree operations moved 2.24x to 2.43x and produced a false alert after division.
Working-tree I/O therefore has its own calibration instead of a threshold high enough to
miss the confirmed 1.306x regression.

`calibration/worktree-v1` is new. Re-derive its same-class spread after five hosted runs;
if those runs show only one runner-speed cohort, keep collecting before changing the 130%
threshold.
