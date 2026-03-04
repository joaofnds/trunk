---
phase: 2
slug: repository-open-commit-graph
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-03
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in `#[cfg(test)]` + `#[test]` |
| **Config file** | none — tests live inline in module files |
| **Quick run command** | `cargo test -p trunk --lib -- graph` |
| **Full suite command** | `cargo test -p trunk` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p trunk --lib -- graph`
- **After every plan wave:** Run `cargo test -p trunk`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 2-repo-01 | repo | 0 | REPO-01 | unit | `cargo test -p trunk --lib -- repo::tests::open_invalid_path` | ❌ W0 | ⬜ pending |
| 2-repo-02 | repo | 0 | REPO-01 | unit | `cargo test -p trunk --lib -- repo::tests::open_valid_repo` | ❌ W0 | ⬜ pending |
| 2-repo-03 | repo | 0 | REPO-02 | unit | `cargo test -p trunk --lib -- repo::tests::close_removes_state` | ❌ W0 | ⬜ pending |
| 2-repo-04 | repo | 1 | REPO-03 | manual | — requires Tauri runtime | manual | ⬜ pending |
| 2-graph-01 | graph | 0 | GRAPH-01 | unit | `cargo test -p trunk --lib -- graph::tests::walk_first_batch` | ❌ W0 | ⬜ pending |
| 2-graph-02 | graph | 0 | GRAPH-01 | unit | `cargo test -p trunk --lib -- graph::tests::walk_second_batch` | ❌ W0 | ⬜ pending |
| 2-graph-03 | graph | 0 | GRAPH-02 | unit | `cargo test -p trunk --lib -- graph::tests::linear_topology` | ❌ W0 | ⬜ pending |
| 2-graph-04 | graph | 0 | GRAPH-02 | unit | `cargo test -p trunk --lib -- graph::tests::merge_commit_edges` | ❌ W0 | ⬜ pending |
| 2-graph-05 | graph | 0 | GRAPH-03 | unit | `cargo test -p trunk --lib -- repository::tests::ref_map_head` | ❌ W0 | ⬜ pending |
| 2-graph-06 | graph | 0 | GRAPH-03 | unit | `cargo test -p trunk --lib -- repository::tests::ref_map_stash` | ❌ W0 | ⬜ pending |
| 2-graph-07 | graph | 0 | GRAPH-04 | unit | `cargo test -p trunk --lib -- graph::tests::is_merge_flag` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/repo.rs` — add `#[cfg(test)]` module with `open_invalid_path`, `open_valid_repo`, `close_removes_state` tests
- [ ] `src-tauri/src/git/graph.rs` — add `#[cfg(test)]` module with `linear_topology`, `merge_commit_edges`, `is_merge_flag`, `walk_first_batch`, `walk_second_batch` tests
- [ ] `src-tauri/src/git/repository.rs` — add `#[cfg(test)]` module with `ref_map_head`, `ref_map_stash` tests
- [ ] Test helper: `fn make_test_repo() -> TempDir` — creates an in-memory repo with at least one merge commit for use across all graph tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Recent repos persist across app restarts | REPO-03 | Requires Tauri runtime; `LazyStore` needs live app context | 1. Open a repo. 2. Quit app. 3. Relaunch. 4. Verify repo appears in recent list. |
| Native file dialog opens and returns correct path | REPO-01 | OS dialog cannot be driven by unit tests | Launch app, click "Open Repository", select a directory, verify path is loaded. |
| Commit graph renders correct lane topology visually | GRAPH-02 | Pixel-level SVG correctness requires visual inspection | Open a repo with merge commits; verify lane lines connect correctly across scroll. |
| Virtual scroll loads next batch at scroll threshold | GRAPH-01 | Scroll events require real browser/WebView | Open a repo with 500+ commits; scroll to end; verify batch loads automatically. |
| Ref pills display correct colors and icons | GRAPH-03 | Visual rendering requires manual check | Verify green pills for local branches, blue for HEAD, gray for remotes, tag icon for tags. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
