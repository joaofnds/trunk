---
created: 2026-08-02T00:00:00.000Z
title: A stash whose committer time predates its parent's sorts below it in the graph
area: graph
files:
  - src-tauri/src/git/graph.rs
---

## Symptom

The graph draws a stash **below** the commit it was taken from, with its dashed
connector running upward across every intervening row. Deferred from the
stash/WIP column-collision work (grilled doc D4) as an independent defect: it has
a different trigger and shares no code with the dirtiness clause.

## Cause

`graph.rs:110-127` merges stashes into the walk purely by `commit.time()`:

```rust
while stash_idx < stash_with_time.len() && stash_with_time[stash_idx].1 >= base_time {
    oids.push(stash_with_time[stash_idx].0);
    stash_idx += 1;
}
```

Nothing constrains a stash to sort above its own parent. A stash timestamped
before its parent falls through to the trailing "older than all base_oids" loop
and lands at the bottom.

## Reproduction (confirmed 2026-08-02)

Build `C0 -> C1` with a stash on the tip, then rewrite `refs/stash` to an
identical commit dated one hour earlier via `repo.commit()` with a backdated
`Signature`:

```
row=0 col=0 stash=true  summary="On main: backdated stash"
row=1 col=0 stash=false summary="Add stash marker"
row=2 col=0 stash=false summary="C1"
row=3 col=0 stash=false summary="C0"
row=4 col=1 stash=true  summary="backdated stash"     <-- below the root
```

Rebuild confound: rewriting `refs/stash` leaves the original reflog entry, so
`stash_foreach` yields both. Row 0 is the original; the defect is row 4.

Reachable in the wild through clock skew, a fetched commit with a future
committer date, or an explicit `GIT_COMMITTER_DATE`.

## Not yet confirmed

The render consequence — `overlay-paths.ts:127-156` computing
`vTarget = cy(parentY) - R` above `startY` — was traced by a reviewer but not
reproduced. The **ordering** is confirmed; the drawing is a hypothesis.

## Fix sketch

Clamp each stash's insertion point so it never sorts below its own first parent,
rather than trusting `commit.time()` alone.
