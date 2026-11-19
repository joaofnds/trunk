# Heavy CI jobs do not wait for the fast checks

Status: accepted, 2026-11-19. Retires the two-gate pipeline that
[history/retrospective.md](../history/retrospective.md) records as "established
for all future CI work".

## What changed

Every job in `.github/workflows/ci.yml` starts when the run starts. The heavy
jobs (Clippy, Rust Tests, macOS Clippy + Tests, Windows Current-File Link
Safety, Application Harness, Vitest, Visual Baselines) used to carry
`needs: [biome, cargo-fmt, graph-sweep-check, svelte-check]`, so none of them
began until all four had passed.

## Why

The gate sat on the critical path of every green run. In run 44574427989 the
fast jobs started at 17:11:20, Biome finished last at 17:11:48, and the heavy
jobs started at 17:11:50 to 17:11:52. Making the fast checks faster does not
remove that wait: after the Biome 2.6.8 upgrade the Biome step still takes
about 14 s on CI, nearly all of it in `nursery/noUndeclaredCustomProperties`,
which the design system relies on, and Svelte Check alone takes 23 s.

No heavy job reads anything a fast job produces. The fast jobs upload no
artifact and save no cache, so starting the jobs together breaks no ordering.

## What it costs

A run now concludes only when its slowest job ends, whether or not a fast check
has already failed. Each check still reports on the commit as soon as it ends,
so a red Biome shows within about 30 s, but anything that waits for the run's
conclusion, such as `gh run watch --exit-status`, waits for the heavy jobs
too. Run 44506198927 shows the shape: Vitest failed at 10:35:36 and the run
concluded at 10:42:55, when Application Harness finished.

A failing fast check also no longer saves the heavy jobs' runner time. The
repository is public, so that time is not billed.

A push now starts every CI job at once, 16 of them, 2 on macOS. GitHub limits
how many jobs an account runs at a time, so a pull request run overlapping a
push to `main` can queue jobs that the gate used to stagger.

## Rejected

A job that needs the fast checks and cancels the run when one fails would
bring back the early conclusion. It needs `actions: write` on a workflow that
otherwise only reads, it cannot cancel anything on a pull request from a fork,
whose token is read-only, and `just check`, which runs before every commit,
covers every fast check, so a red fast check on CI is rare. Leaving the gate
in place was rejected because it delays every green run to save time only on
red ones.
