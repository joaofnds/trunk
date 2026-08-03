---
created: 2026-08-03T00:00:00.000Z
title: An unreadable-but-present file renders as a whole-file deletion in the markdown diff
area: backend
files:
  - src-tauri/src/git/blob_reader.rs
  - src-tauri/src/commands/markdown.rs
---

## Symptom

A file that exists in the working tree but cannot be resolved — a symlink loop
(ELOOP), an unsearchable parent directory (EACCES) — renders in the rendered-markdown
diff as if the user had deleted the whole file. Every block shows as removed. No
error reaches the user.

## Cause

`read_working_tree_file` maps **every** `canonicalize` failure on the target path to
`not_found`:

```rust
let target = root
    .join(file_path)
    .canonicalize()
    .map_err(|e| TrunkError::new("not_found", format!("{file_path}: {e}")))?;
```

`src-tauri/src/git/blob_reader.rs:119-122`. `read_side`
(`src-tauri/src/commands/markdown.rs:925-928`) then treats `not_found` as "the file is
absent at this rev" and returns `Ok(None)`, which the block differ renders as the whole
file removed.

`not_found` is doing two jobs: "git has no such path at this rev", which `read_side`
is right to swallow, and "the OS refused to resolve this path", which it is not.

## Evidence

Reproduced 2026-08-03 with a two-node symlink cycle in a fresh repo:

```
raw canonicalize error: kind=FilesystemLoop msg=Too many levels of symbolic links (os error 62)
read_file_at_inner code="not_found" message="loop_a.md: Too many levels of symbolic links (os error 62)"
```

The sibling half of this defect — an unborn HEAD misclassified the other way — was
fixed in `8541452`. This half was not.

## Fix sketch

Stop encoding presence as a string code. Have the resolver return
`Result<Option<Vec<u8>>, TrunkError>`: `Ok(None)` only for a genuinely absent path,
`Err` for every other failure, and let `read_side` match on the type instead of on
`e.code == "not_found"`. Distinguishing `ErrorKind::NotFound` from everything else at
the `canonicalize` call is the smaller version of the same fix.

## Provenance

Found by the `.boris/reviews/2026-08-02-commitgraph-svelte.md` panel as Appendix G §C,
and deferred out of the P3 milestone-1 refactor because fixing it is a behavior change.
**G §C cites `markdown.rs:1174-1177`, which contains no `canonicalize` at all** — those
lines are the function signature and the bare-repo guard. A probe of exactly the cited
range records a false negative.

The resolver moved from `commands/markdown.rs` to `git/blob_reader.rs` in `671bd8c`;
the code above is unchanged by that move, only relocated.
