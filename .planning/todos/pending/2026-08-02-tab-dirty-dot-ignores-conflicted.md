---
created: 2026-08-02T00:00:00.000Z
title: Tab dirty dot ignores conflicted paths, so a conflict-only repo shows no dot
area: frontend
files:
  - src/App.svelte
---

## Symptom

A repo whose only dirty state is a merge or rebase conflict
(`staged=0 unstaged=0 conflicted=1`) renders the WIP row in the commit graph but
shows **no dirty dot** on its tab. The two disagree about whether the repo has
uncommitted work.

## Cause

`App.svelte` computes tab dirtiness at **two** sites, both as:

```js
counts.staged + counts.unstaged > 0
```

— `src/App.svelte:385` and `src/App.svelte:603`. Both drop `conflicted`.
`wipCount` (`src/components/RepoView.svelte:266-267`), which gates the WIP row,
is `staged + unstaged + conflicted`, so the two formulas diverge exactly when a
conflict is the only dirty state.

Found by the adversarial gate on the stash/WIP column-collision work and
deferred as unrelated. The grilled doc names only `:603`; there are two sites,
and a fix must change both.

## Fix sketch

Add `+ counts.conflicted` at both sites, or better, export the single
`staged + unstaged + conflicted` formula so tab dirtiness and `wipCount` cannot
drift again — the same functional-coupling failure the graph's
`git::status::DIRTY_BITS` was introduced to close on the Rust side.
