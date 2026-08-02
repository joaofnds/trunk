---
created: 2026-06-22T00:00:00.000Z
title: Pull leaves a spurious mid-rebase "conflict" that a plain git pull never produces
area: commands
files:
  - src-tauri/src/commands/remote.rs
  - src-tauri/src/commands/operation_state.rs
  - src/components/RepoView.svelte
---

## Symptom

User clicks **Pull** on a repo with `pull.rebase=true`. Trunk shows the
conflict-resolution UI ("Rebasing main onto …", Continue/Skip/Abort) — but
`CONFLICTED FILES 0`. The repo is stopped **mid-rebase (commit 1 of N)** with
the user's uncommitted WIP still in the working tree. Running the same `git pull`
in the terminal completes cleanly. Recurring ("the old pull problem").

## What was ruled out (each tested with reproductions, 2026-06-22)

- **Real merge conflict** — no. `git merge-tree` + an isolated worktree rebase of
  the same commits onto the same `onto` are content-clean (exit 0,
  "Successfully rebased"). The incoming commit didn't even touch the conflicted
  files.
- **We don't shell out to real git** — false. `remote.rs` already runs
  `git pull --progress` (since `68bab10`).
- **Wrong git binary / PATH / HOME / config** — a *faithful* replay of the app's
  exact spawn (Apple `/usr/bin/git`, `path_helper` PATH, real `HOME` + `~/.gitconfig`)
  autostashes the dirty tree and finishes clean. (The wrong-git divergence is a
  real but separate issue — fixed by sourcing the login shell in `shell_env.rs`.)
- **GPG signing failure** — no. `commit.gpgsign=true` and the commits are signed,
  but signing succeeds even with the controlling terminal dropped (no TTY).

## The unexplained part

The live end-state is **provably impossible from a lone `git pull`**:
- git refuses to start a rebase on a dirty tree unless it autostashes;
- if it autostashed, the WIP wouldn't still be un-stashed in the tree, and a
  clean pick can't conflict.
- Also: `.git/rebase-merge/done` listed `c435` as applied while
  `git-rebase-todo` *also* listed it — a duplicate a normal rebase never writes.

So something on trunk's side interfered after/around the pull. Leading suspects
(none confirmed — needs runtime evidence):
1. The recursive fs-watcher reacting to git's own `.git` writes during the
   rebase (`repo-changed` → `refresh_graph` opening the repo with git2 while the
   git CLI is mid-write). See the "writing to .git triggers a UI reload" hazard.
2. The periodic `git_fetch_background` (RepoView.svelte ~553) racing the pull.
   It's guarded by `RunningOp` + an `is_clean` check, but the guard is a TOCTOU.
3. The pull subprocess being cancelled/killed mid-rebase (`cancel_remote_op`).

## Why this can't be pinned now

`remote.rs::run_git_remote` logs nothing — no argv, no stdout/stderr, no record
of concurrent ops/cancels. The after-the-fact repo state is lossy. **First step:
instrument the pull path** (exact argv + captured stdout/stderr + a marker
whenever a cancel or background fetch fires during an active remote op), so the
next occurrence is diagnosable.

## Compounding bug worth fixing regardless

`git_pull` runs against a dirty working tree with no protection. When the
autostash path misbehaves, the user's uncommitted WIP gets stranded in a
half-finished rebase — the exact "confusing state that doesn't happen in the
terminal" that `68bab10` set out to kill. Consider forcing `--autostash` on the
pull (deterministic WIP protection) or refusing on a dirty tree with a clear
message, rather than depending on config resolution.
