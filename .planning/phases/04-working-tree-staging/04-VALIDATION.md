---
phase: 4
slug: working-tree-staging
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in tests (`#[test]`) |
| **Config file** | none — Cargo test discovery |
| **Quick run command** | `cargo test -p trunk_lib --lib 2>&1 \| tail -20` |
| **Full suite command** | `cargo test -p trunk_lib 2>&1 \| tail -30` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p trunk_lib --lib 2>&1 | tail -20`
- **After every plan wave:** Run `cargo test -p trunk_lib 2>&1 | tail -30`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 4-01-01 | 01 | 1 | STAGE-01 | unit | `cargo test -p trunk_lib -- staging::tests::get_status_returns_unstaged` | ❌ W0 | ⬜ pending |
| 4-01-02 | 01 | 1 | STAGE-01 | unit | `cargo test -p trunk_lib -- staging::tests::status_new_file` | ❌ W0 | ⬜ pending |
| 4-01-03 | 01 | 1 | STAGE-01 | unit | `cargo test -p trunk_lib -- staging::tests::status_modified_file` | ❌ W0 | ⬜ pending |
| 4-02-01 | 01 | 1 | STAGE-02 | unit | `cargo test -p trunk_lib -- staging::tests::stage_file_moves_to_staged` | ❌ W0 | ⬜ pending |
| 4-02-02 | 01 | 1 | STAGE-02 | unit | `cargo test -p trunk_lib -- staging::tests::unstage_file_moves_to_unstaged` | ❌ W0 | ⬜ pending |
| 4-02-03 | 01 | 1 | STAGE-02 | unit | `cargo test -p trunk_lib -- staging::tests::unstage_on_unborn_head` | ❌ W0 | ⬜ pending |
| 4-03-01 | 01 | 1 | STAGE-03 | unit | `cargo test -p trunk_lib -- staging::tests::stage_all_stages_everything` | ❌ W0 | ⬜ pending |
| 4-03-02 | 01 | 1 | STAGE-03 | unit | `cargo test -p trunk_lib -- staging::tests::unstage_all_clears_index` | ❌ W0 | ⬜ pending |
| 4-04-01 | 02 | 2 | STAGE-04 | manual | n/a — requires real FS + Tauri runtime | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/staging.rs` — fill stub with `get_status_inner`, `stage_file_inner`, `unstage_file_inner`, `stage_all_inner`, `unstage_all_inner` + `#[cfg(test)]` block
- [ ] Tests live inside `staging.rs` `#[cfg(test)]` using `make_test_repo()` from `crate::git::repository::tests`
- [ ] `src-tauri/src/watcher.rs` — fill stub with `WatcherState` managed type + `start_watcher`/`stop_watcher`

*(No separate test file needed — Rust inline tests match the established pattern from `branches.rs`)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Watcher emits event within ~300ms of external file change | STAGE-04 | Requires real FS events + live Tauri runtime; cannot be unit tested | Open repo, edit a file from terminal, verify staging panel refreshes within 300ms without user action |
| macOS sandbox FSEvents in production `.app` | STAGE-04 | `tauri dev` vs production sandbox behavior differs | Run `cargo tauri build`, open `.app`, edit file externally, verify panel updates |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
