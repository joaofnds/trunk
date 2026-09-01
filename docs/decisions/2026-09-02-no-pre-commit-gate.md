# No pre-commit gate: CI on push to main is the whole control

**Decision:** neither a git hook nor a new CI job. The existing CI workflow, which
already runs on every push to `main`, is the only enforced gate against a commit
that fails `just check`. Nothing runs before the commit exists.

Decided by João, 2026-09-02. Recorded from TRUNK-105.

## What prompted it

A file was committed unformatted in `235e45bd`. `bunx biome ci .` then failed from
a clean tree, so `just check` was red for every session working in the repository
until another session noticed and reported it. Fixed in `dc0ae5a6`.

At that point `.git/hooks/` held only samples, and `core.hooksPath` pointed at that
same empty directory. The only thing between a red commit and `main` was a session
remembering to run `just check` first. TRUNK-105 asked whether that should change.

## Why neither

**A hook is not wanted.** João does not want git hooks in this repository. That is a
standing preference about the tool, not a judgment about this defect, and it settles
the option on its own.

**A new CI job would be redundant.** `.github/workflows/ci.yml` triggers on
`push: branches: [main]` as well as on pull requests, and its `check-parity` job
fails when the recipes in `just check` and the workflow's jobs drift apart. Every
check that would catch a bad commit already runs, on the event that matters. There
is no gap for a second job to fill.

## What this accepts

A bad commit can exist on `main` and stay undetected until someone pushes. In
trunk-based development on a shared `main`, with several sessions committing
concurrently, that window is real: the cost of a red tree is paid by whoever notices
next, not by whoever caused it.

That cost is accepted. The compensating facts:

- The push is not deferred far. Sessions commit and push in the same stretch of work,
  so the detection point is close to the cause in practice.
- A hook that runs the full gate (~35s) invites `--no-verify`, which is worse than no
  hook: it makes the control look present while it is bypassed silently. TRUNK-105's
  third acceptance criterion asked for a mechanism that cannot be silently bypassed,
  and a hook fails it.
- The narrow static tier (`just quick`, ~3s) would have caught this specific defect,
  which was a formatting miss. It would not catch a failing test. Buying the cheap
  half of the gate is not worth introducing hooks to a repository that has none.

## What would reopen this

A second incident of the same shape, where a red `main` blocked other sessions for
long enough to cost real work. One occurrence is ordinary variation; a pattern is a
signal. If it recurs, the option to revisit is a hook running only the static tier,
and the thing to measure first is how long the red tree actually stood.
