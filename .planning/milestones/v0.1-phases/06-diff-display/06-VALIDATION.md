---
phase: 6
slug: diff-display
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-07
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in `#[test]` via `cargo test` |
| **Config file** | none — standard Cargo test |
| **Quick run command** | `cargo test -p trunk_lib diff` |
| **Full suite command** | `cargo test -p trunk_lib` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p trunk_lib diff`
- **After every plan wave:** Run `cargo test -p trunk_lib`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 6-01-01 | 01 | 1 | DIFF-01 | unit | `cargo test -p trunk_lib diff::tests::diff_unstaged_returns_hunks` | ❌ Wave 0 | ⬜ pending |
| 6-01-02 | 01 | 1 | DIFF-01 | unit | `cargo test -p trunk_lib diff::tests::diff_unstaged_empty_for_clean_file` | ❌ Wave 0 | ⬜ pending |
| 6-01-03 | 01 | 1 | DIFF-02 | unit | `cargo test -p trunk_lib diff::tests::diff_staged_returns_hunks` | ❌ Wave 0 | ⬜ pending |
| 6-01-04 | 01 | 1 | DIFF-02 | unit | `cargo test -p trunk_lib diff::tests::diff_staged_unborn_head` | ❌ Wave 0 | ⬜ pending |
| 6-01-05 | 01 | 1 | DIFF-03 | unit | `cargo test -p trunk_lib diff::tests::diff_commit_returns_hunks` | ❌ Wave 0 | ⬜ pending |
| 6-01-06 | 01 | 1 | DIFF-03 | unit | `cargo test -p trunk_lib diff::tests::diff_commit_root_empty_tree` | ❌ Wave 0 | ⬜ pending |
| 6-01-07 | 01 | 1 | DIFF-04 | unit | `cargo test -p trunk_lib diff::tests::get_commit_detail_returns_metadata` | ❌ Wave 0 | ⬜ pending |
| 6-01-08 | 01 | 1 | DIFF-04 | unit | `cargo test -p trunk_lib diff::tests::get_commit_detail_committer_fields` | ❌ Wave 0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/diff.rs` — needs inner fn implementations + 8 unit tests (file exists as empty stub)
- [ ] No framework install needed — Cargo `[dev-dependencies]` already has `tempfile = "3"`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| DiffPanel renders correctly in 4-column layout | DIFF-01, DIFF-02 | Visual layout validation | Open repo, click a modified file in unstaged section, verify DiffPanel appears with correct diff |
| Clicking commit in graph shows commit diff + metadata | DIFF-03, DIFF-04 | Visual component interaction | Click commit in graph, verify DiffPanel shows file diffs and commit metadata header |
| Binary file shows "Binary file" message | DIFF-01 | Visual fallback rendering | Stage a binary file, click it, verify "Binary file" message instead of hunks |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
