---
phase: 02-repository-open-commit-graph
plan: "01"
subsystem: testing
tags: [rust, tdd, git2, tempfile, test-scaffold]
dependency_graph:
  requires: []
  provides: [test-scaffold-repo-commands, test-scaffold-graph, test-scaffold-repository, make_test_repo-helper]
  affects: [02-02, 02-03, 02-04]
tech_stack:
  added: [tempfile = "3" (dev-dependency)]
  patterns: [TDD RED state — stubs compile and fail via todo!()]
key_files:
  created: []
  modified:
    - src-tauri/src/commands/repo.rs
    - src-tauri/src/git/graph.rs
    - src-tauri/src/git/repository.rs
    - src-tauri/Cargo.toml
decisions:
  - "make_test_repo() implemented inline in repository::tests — creates real git2 repo with init commit + feature branch + merge commit"
  - "graph::tests imports make_test_repo via crate::git::repository::tests::make_test_repo"
  - "All stubs use todo!() not panic!() for clear intent communication"
metrics:
  duration: "2 minutes"
  completed: "2026-03-04"
  tasks_completed: 2
  files_modified: 4
---

# Phase 2 Plan 01: Test Scaffolds (RED State) Summary

**One-liner:** Ten TDD RED-state test stubs across three modules with a real git2 make_test_repo() helper including a merge commit.

## What Was Built

All Rust test scaffolds for Phase 2 Wave 0. Three modules received `#[cfg(test)]` blocks:

1. **`src-tauri/src/commands/repo.rs`** — 3 test stubs: `open_invalid_path`, `open_valid_repo`, `close_removes_state`
2. **`src-tauri/src/git/repository.rs`** — `make_test_repo()` helper + 2 stubs: `ref_map_head`, `ref_map_stash`
3. **`src-tauri/src/git/graph.rs`** — 5 stubs: `linear_topology`, `merge_commit_edges`, `is_merge_flag`, `walk_first_batch`, `walk_second_batch`

Total: 10 named test functions, all compiling and failing via `todo!()` (RED state).

## make_test_repo() Helper

Creates a real git2 repository in a `tempfile::TempDir` with:
- An initial commit on `refs/heads/main` (README.md)
- A feature branch commit on `refs/heads/feature` (feature.txt)
- A merge commit on `refs/heads/main` merging feature into main (merged.txt)

This ensures graph tests have a repo with merge topology to assert on.

## Verification Results

```
running 10 tests
test commands::repo::tests::open_invalid_path ... FAILED
test commands::repo::tests::open_valid_repo ... FAILED
test commands::repo::tests::close_removes_state ... FAILED
test git::graph::tests::linear_topology ... FAILED
test git::graph::tests::merge_commit_edges ... FAILED
test git::graph::tests::is_merge_flag ... FAILED
test git::graph::tests::walk_first_batch ... FAILED
test git::graph::tests::walk_second_batch ... FAILED
test git::repository::tests::ref_map_head ... FAILED
test git::repository::tests::ref_map_stash ... FAILED
test result: FAILED. 0 passed; 10 failed; 0 ignored; 0 measured
```

Production build: `cargo build -p trunk` exits 0.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | 8df17b7 | test(02-01): add repo command test scaffold (RED) |
| Task 2 | 8ada5d3 | test(02-01): add graph and repository test scaffolds (RED) |

## Deviations from Plan

None — plan executed exactly as written.

## Decisions Made

- `make_test_repo()` is declared `pub` in `pub mod tests` so graph::tests can import it via `crate::git::repository::tests::make_test_repo`
- `tempfile = "3"` added as `[dev-dependencies]` only (not a production dependency)
- Stubs use `todo!()` (not `panic!("not yet implemented")`) — cleaner intent signal

## Self-Check: PASSED

- FOUND: src-tauri/src/commands/repo.rs
- FOUND: src-tauri/src/git/repository.rs
- FOUND: src-tauri/src/git/graph.rs
- FOUND: .planning/phases/02-repository-open-commit-graph/02-01-SUMMARY.md
- FOUND commit: 8df17b7
- FOUND commit: 8ada5d3
