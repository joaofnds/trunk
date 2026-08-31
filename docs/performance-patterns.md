# Measured slow patterns

Patterns that made `just app-test` (and with it `just check` and `just dev` startup) slow,
each caught by measurement during TRUNK-63/65/66. Review new code against them; when one
seems worth violating, bring a measurement. `docs/application-harness.md` §Budget holds the
numbers and the cost model these rules fall out of.

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
