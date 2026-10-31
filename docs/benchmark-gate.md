# The CI benchmark gate

`.github/workflows/benchmarks.yml` runs the criterion suite on every push to `main`, twice
in one job: once on a base commit and once on the pushed commit. It fails the build when a
gated benchmark of the pushed commit is slower than the base's by more than the threshold,
and when the pushed commit's pass or the comparison itself cannot run. This page says what
it compares and why, because the obvious reading of the numbers is wrong.

## What it compares

Two passes on the same runner. GitHub's hosted runners vary enough that the same code
measures 1.7x to 3.0x apart from one run to the next, and runners fall into hardware
cohorts whose classes of work move by different amounts: by 2026-10-08, five runs on
unchanged code had spread up to 1.44x. A baseline kept from an earlier run therefore
compares two machines as much as two commits, and that failed `main` four times from
2026-09-23 on. Measuring both commits in one job takes the runner out of
the comparison.

Within the job, the gate compares each benchmark **divided by a calibration benchmark of
the same workload class**, so any drift in the runner's speed between the two passes
cancels and the code's cost is what is left.

Four calibrations live in `src-tauri/benches/bench_commands.rs`:

| Calibration | Measures | Divides |
|---|---|---|
| `calibration/syntect-v1` | A fixed syntect highlight of an embedded TypeScript constant | `diff_ts_full_pipeline`, `enrich_ts_new_perfile`, every `diff_ts_large_file/*` |
| `calibration/git2-v1` | A fixed revwalk and blob read over a repository the benchmark builds itself | `list_refs_inner`, every `snapshot/*` and `toggle_visibility/walk/*`, the graph and refs `ipc_round_trip/*` benchmarks, and `startup/*` |
| `calibration/worktree-v1` | Fixed status and diff reads over a modified working tree through git2 directly | `diff_unstaged_inner`, `get_status_inner`, and `ipc_round_trip/diff_unstaged` |
| `calibration/staging-v1` | A fixed diff applied to a fresh repository's index through git2 directly | `stage_hunk_inner` |

Staging writes the index, whose cost can move independently of worktree reads. Both the
staging benchmark and its calibration borrow each fresh fixture through Criterion's
`iter_batched_ref`, so repository creation and deletion stay outside the timer. Consuming
the fixture inside the timed closure also measures deleting its `.git` directory. That
cleanup is unrelated to a staging gesture and was roughly half the measured cost in a
local decomposition of the previous benchmark.

The staging class has its own `norm/staging-v1/` series because its measured workload and
divisor differ from the worktree reads, which keep `norm/worktree-v1/`.

`reviewdb_draft_write` and `toggle_visibility/cached/*` are excluded.
`reviewdb_draft_write` measures an fsync and fits none of the calibrations. A cached
visibility toggle measures CPU and allocation work after the repository capture already
exists, so dividing it by the Git-object calibration adds that calibration's independent
runner variance instead of removing noise. Both measurements remain in the raw artifact;
Each needs an independent matching calibration before it can join the hard gate.

Attempt 1 of run 34773521544 exposed the mismatch against run 34729512090. The Git
calibration moved to 0.657x of the baseline while cached toggles moved to 0.935x raw at 1k
and 1.155x raw at 10k. Dividing those independent changes reported false regressions of
1.423x and 1.758x. Attempt 2 of the same commit passed when those timings happened to move
together instead.

**The calibrations must never call `trunk_lib`.** Their whole job is to move with the
machine and not with our code. A calibration that tracked Trunk's code would divide a real
regression away, which is exactly what happened to the two syntect benchmarks in August
2026: both got 1.3x slower from one commit, so their ratio to each other never moved.

`scripts/bench-gate.ts` does the division and `scripts/bench-normalize.ts` holds the class
table. The emitted names use `norm/<calibration-id>/`; the normalizer derives that namespace
from the calibration name, so a generation change starts a fresh compatible series. The
value is the ratio scaled by one million. The output keeps criterion's bencher line shape,
unit `ns/iter` included, so the comparison reads both outputs with one parser, and `norm/`
is the signal that the number is not a duration.

## How a run works

`scripts/bench-ab.ts` runs the job:

1. It picks the base (`scripts/bench-base.ts`): the commit `main` held before the push,
   `github.event.before`. When that is the all-zero SHA of a newly created branch, or not an
   ancestor of the pushed commit because the push rewrote history, it falls back to the
   pushed commit's parent. The log names the chosen SHA and the reason.
2. It exports the base's tree to a temporary directory and benchmarks it, then benchmarks
   the pushed commit's checkout. Each side runs `mise install` and `cargo bench --bench '*'`
   from its own tree, so it benches the targets its own `Cargo.toml` declares and is meant
   to build with the toolchain its own `mise.toml` pins, which would measure a toolchain bump
   as part of the push. Both sides use one cargo target directory, so a dependency that is
   identical on both sides can be reused rather than rebuilt. Neither effect has been
   observed in CI yet; TRUNK-47 records the first runs.
3. Each side is normalized by its own commit's `bench-gate.ts`. A push that adds or
   renames a calibration class emits different series names on the two sides, and the
   pushed commit's class table would reject the base's output.
4. `scripts/bench-compare.ts` matches the two normalized outputs by series name, writes a
   table of every ratio, normalized and raw, to the job summary, and fails when a
   normalized ratio exceeds the threshold. A series present on one side only is listed and
   not gated: a new benchmark, a renamed one, or a calibration generation that exists on
   one side.

If the base pass fails, for example because the base predates a benchmark binary, the job
warns and compares nothing. If the pushed commit's pass fails, the job fails.

Every push compares its own range of commits, so runs share no state and none is
cancelled by a later push. A real regression shows red on the run of the push that
introduced it, and only there. The next push compares against the regressed commit, so it
passes unless its own range adds a regression. A red nobody acts on becomes the baseline,
and nothing else tracks it. Whether a red should instead stay red until it is fixed or
accepted is an open decision on TRUNK-47.

A benchmark whose body changes inside the range compares two different workloads. Rename
it, so it starts a fresh series on the pushed side and goes ungated for that push. A
change to the normalizer's arithmetic or to a benchmark's class, with the calibration
names unchanged, keeps the same series names on both sides and is gated across two
different computations. Bump the affected calibration's generation in that push instead.

The passes write `base-output.txt`, `head-output.txt`, `base-normalized.txt` and
`head-normalized.txt`, and every run uploads what was written as the `benchmark-passes`
artifact. A pass that failed early leaves its files out. `bun run
scripts/bench-compare.ts <directory>` reruns the comparison on a downloaded copy and names
any file that is missing.

## Reading a failure

The job's error names each benchmark whose normalized ratio, pushed over base, exceeds
1.30, and the job summary holds the table with the raw ratio beside it. The range under
suspicion is the base SHA the log names up to the pushed commit:
`git diff <base>..<head> -- src-tauri/ mise.toml rust-toolchain.toml scripts/bench-*.ts`
is the first thing to read, since a toolchain or normalizer change moves the numbers as
surely as a code change.

Read the raw ratio beside the normalized one. If the raw ratio moved far more than the
normalized one, the runner's speed drifted between the passes and the calibration absorbed
it. If the normalized ratio is slower while the raw ratio is faster, the calibration sped
up more than the benchmark did, which is the pattern of the recorded false reds rather than
of a regression. Either way, a local A/B on one machine, both commits, criterion's default
sample count, is what settles whether a red is real. CI measures only the two ends of the
range, so when the range holds more than one commit, a local bisect that benchmarks each
step settles which one.

No timing result says anything about whether the output is *correct*. This gate is not a
correctness gate.

## Calibration generations

Each calibration's `-vN` suffix is its compatibility generation. When its workload or a
dependency it calls changes, bump that suffix in the Rust benchmark. The class table matches
the stable calibration prefix and derives `norm/<calibration-id>/` from the result, so the
generation has one source of truth. On the push that bumps it, that class's series exist on
one side only and go ungated; unaffected series compare as usual. Seeing two generations in
one pass is an error rather than an arbitrary choice between them.

## The threshold

130%, `THRESHOLD` in `scripts/bench-comparison.ts`, and provisional. Proxy-normalized
results from thirteen runs between 2026-08-02 and 2026-08-27 had a 1.046x same-class
spread, while the one confirmed regression read 1.306x normalized and 1.325x raw. That
evidence put 130% between noise and signal.

The proxy treated git2 work as one speed dimension. Runs 34656946873 and 34722813882 later
disproved that assumption on unchanged Rust: the git2 object calibration moved 1.80x, while
working-tree operations moved 2.24x to 2.43x and produced a false alert after division.
Working-tree I/O therefore has its own calibration instead of a threshold high enough to
miss the confirmed 1.306x regression.

All of those runs compared separate jobs, so none of them measures the noise between two
passes of one job. That noise is unmeasured, and 130% stays provisional until it is.
TRUNK-47 holds the re-derivation, which reads it from Benchmarks runs whose range changes
no benchmarked code.
