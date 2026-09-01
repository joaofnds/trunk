# Measured slow patterns

Patterns that made `just app-test` (and with it `just check` and `just dev` startup) slow,
each caught by measurement during TRUNK-63/65/66, plus the Rust-gate patterns from
TRUNK-12. Review new code against them; when one seems worth violating, bring a
measurement. `docs/application-harness.md` §Budget holds the frontend numbers and the
cost model those rules fall out of; TRUNK-12's implementation notes hold the Rust-gate
measurements in full.

## Barrel imports of large libraries

`import { GitBranch } from "@lucide/svelte"` loads the barrel, and the barrel re-exports
every icon — about 3,700 modules — into every vitest worker and every dev-server start.
Seventeen files doing this cost `just app-test` 3.5 s of wall (9.41 s → 5.90 s when
removed).

**Rule:** import icons, and any member of a large collection package, by deep path:
`@lucide/svelte/icons/git-branch`. Before adopting a new dependency's barrel, look at how
many modules it re-exports.

**Review check:** `grep -rn 'from "@lucide/svelte"' src/` must return nothing — deep paths
only. For a new large package, the same question at review time.

## Scenario files that accumulate serial tests

Tests inside one file run serially; files run in parallel across cores. With cores to
spare, the suite's wall clock is the import floor plus the *slowest file*, so a workflow
file that collects scenarios becomes the critical path. `interactive-rebase.test.ts` at
5.3 s of serial tests cost the suite about 1 s of wall against splitting it (10.2 s →
9.2 s).

**Rule:** one workflow per file in `tests/app/`. A file whose tests exceed roughly 2–3 s
gets split before the next scenario lands in it.

**Review check:** the per-file durations in the vitest output; the new-file cost is near
zero, so when in doubt, split.

## Deciding from a priced model instead of a measurement

The budget's original model priced a scenario at 300–500 ms; measurement showed 0.05 s.
The corrected model priced by app boots; measurement showed the critical path is the
slowest file. Each wrong model was believed long enough to almost force a wrong decision
(raising the ceiling, trimming a workflow). Separately, `isolate: false` looks like an
obvious win and measures *slower* (12.5 s against 9.4 s): the shared module graph buys
nothing when each file already has its own core.

**Rule:** before acting on the budget — and before rejecting an optimization as not worth
it — measure the actual term with `hyperfine` (serial runs, note the load average). Record
negative results in `docs/application-harness.md` §Budget so the next session doesn't
re-try them.

## Wall-clock waits inside scenarios

`settle()` costs a minimum of 250 ms per call and is a fallback, not a default: it exists
for negative assertions ("nothing else refetched") that have no state to wait for. A
scenario that reaches for it when a `waitFor` on real state would do donates wall time to
the suite's slowest file.

**Rule:** wait on observable state; reach for `settle()` only when the assertion is a
negative. (The testing skill's sleep-based-waits ban is the general form; this is its cost
in this suite.)

## Freshly linked binaries pay a first-exec scan (TRUNK-12, 2026-08-31)

macOS scans every new executable on its first exec. Measured on this machine: a fresh
test binary (2.4 MB) took 1.03 s on first exec at 0% CPU and 5 ms on the second; a fresh
trivial C binary took 271 ms, then 2 ms. `cargo test` after one `src/lib.rs` edit relinks
all 28 test binaries, so the run phase went 58.3 s on the first pass and 16.9 s on the
second — about 41 s of scan per relink, and it comes back after every Rust edit.
The fix is verified: the Privacy & Security → Developer Tools exemption removes the scan
entirely (fresh-binary first exec 277 ms → 2 ms; post-edit `just check` 91.3 s at load ~7
→ 62.1 s at load ~4). Three things it needed, each measured failing without: the exempted
entry must be the *responsible process* — Claude.app's helper disclaims responsibility
for the Claude Code runtime, so the toggle on Claude.app alone covered nothing and the
nested bundle (`~/Library/Application Support/Claude/claude-code/<version>/claude.app`)
had to be added itself; the host process had to be restarted after toggling; and the
bundle path carries the version number, so a Claude Code update will silently bring the
scan back until the new bundle is re-added — if the gate suddenly gains ~30 s after an
update, check this list first.

**Rule:** when timing anything that runs freshly built binaries, run it twice and report
both numbers — the first-run number is the scan, not the workload. Don't split test
binaries further without pricing the extra ~1 s+ scan each new binary adds to every
post-edit gate run.

## Rust-gate levers measured and refuted (TRUNK-12, 2026-08-31)

Recorded so they aren't re-tried:

- **`[profile.dev] debug = "line-tables-only"`**: no change. Incremental post-edit build
  10.3 s vs 10.0 s at debug=2; test binaries within 2 MB of their debug=2 sizes (61→59 MB,
  23→23 MB). macOS keeps debug info in object files behind a debug map instead of linking
  it into the binary, so debug level barely touches link output or link time. Costs a full
  rebuild (~105 s) each way to try.
- **Splitting `placement.rs` into its own crate** (2026-08-07 lead): refuted by
  decomposition, not tried. The post-edit build is 33 parallel units at 2.5–4.8 s each
  behind a 3.7 s `trunk_lib` compile, 10 s wall total; a leaf-crate edit still rebuilds
  `trunk_lib` and still relinks every test binary, so the split moves ~2 s inside a 10 s
  parallel phase and leaves the dominant relink-and-scan cost intact.
- **`cargo nextest`** (adopted, TRUNK-67): runs test binaries in parallel where
  `cargo test` runs them serially — warm `just cargo-test` went 17 s → 9.5 s (7.2 s
  nextest + 1.6 s `cargo test --doc`, six consecutive clean runs), post-edit `just check`
  62 s → 49 s. The 8-minute hang of
  `store_events_survive_a_commit_racing_the_subscribe` seen on the first try did not
  reproduce on a clean tree (six runs); it coincided with another session's in-flight
  reviewdb race fix. nextest cannot run doctests, so the recipe runs `cargo test --doc`
  after it; the union was verified name-by-name against `cargo test -- --list`, which
  differs only by the one doctest.
- **Two-lane `just check`** (measured, not adopted): running the Rust chain
  (clippy → clippy-shipped → cargo-test → app-test) concurrently with the frontend chain
  measured 41.6 s post-edit against 49.4 s serial — about 8 s, for a wrapper script,
  buffered logs, and failure reporting the serial gate gets for free. Decision open.
- **Already fixed before TRUNK-12 ran**: `biome ci` traversal (25–84 s in the 2026-08-26
  note) now 0.12 s after the `files.includes` exclusions; `test_integ_watcher.rs`
  (21.6 s in the card) now 1.67 s.

## `Diff::foreach` costs the whole diff, whatever the callbacks return (TRUNK-82, 2026-09-01)

Reading one file out of a commit's diff must not go through `Diff::foreach`.
libgit2 generates each delta's patch text before it calls any callback, so a
callback that returns early on unwanted files still pays for them in full.

Measured in release on a synthetic commit, asking for one file:

| Files in the commit | `foreach`, do-nothing callbacks | build + `find_similar` + one `Patch::from_diff` |
|---|---|---|
| 50 | 5.2 ms | 0.27 ms |
| 300 | 33.3 ms | 0.49 ms |
| 1000 | 110.0 ms | 0.73 ms |

The `foreach` column is linear in the commit's total changed content, not in the
requested file's. Filtering inside the callbacks was tried and changed nothing,
which is the measurement that identified the cause.

This became live when rename detection removed the `DiffOptions::pathspec` that
used to narrow single-file diffs — a pathspec strips a rename's other side
before `find_similar` can pair it, so the narrowing had to go. `diff_one_file`
in `commands/diff.rs` selects the delta and reads it with `Patch::from_diff`;
`walk_diff` stays for callers that genuinely want every file. End to end, one
file out of a 1000-file commit went from 118 ms to 4.5 ms, and stopped scaling
with the commit's width.
