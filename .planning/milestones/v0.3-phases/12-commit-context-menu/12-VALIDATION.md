---
phase: 12
slug: commit-context-menu
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-11
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust `#[cfg(test)]` + `cargo test` |
| **Config file** | Standard Cargo test runner |
| **Quick run command** | `cargo test -p trunk --lib -- commit_actions` |
| **Full suite command** | `cargo test -p trunk --lib` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p trunk --lib -- commit_actions`
- **After every plan wave:** Run `cargo test -p trunk --lib`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 12-01-01 | 01 | 1 | MENU-03 | unit | `cargo test -p trunk --lib -- commit_actions::tests::checkout_commit` | ❌ W0 | ⬜ pending |
| 12-01-02 | 01 | 1 | MENU-04 | unit | `cargo test -p trunk --lib -- branches::tests::create_branch_from_oid` | ❌ W0 | ⬜ pending |
| 12-01-03 | 01 | 1 | MENU-05 | unit | `cargo test -p trunk --lib -- commit_actions::tests::create_tag` | ❌ W0 | ⬜ pending |
| 12-01-04 | 01 | 1 | MENU-06 | unit | `cargo test -p trunk --lib -- commit_actions::tests::cherry_pick` | ❌ W0 | ⬜ pending |
| 12-01-05 | 01 | 1 | MENU-07 | unit | `cargo test -p trunk --lib -- commit_actions::tests::revert` | ❌ W0 | ⬜ pending |
| 12-02-01 | 02 | 2 | MENU-01 | manual | N/A (clipboard requires OS context) | N/A | ⬜ pending |
| 12-02-02 | 02 | 2 | MENU-02 | manual | N/A (clipboard requires OS context) | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/commit_actions.rs` — test stubs for checkout_commit, create_tag, cherry_pick, revert_commit (MENU-03, MENU-05, MENU-06, MENU-07)
- [ ] Update `src-tauri/src/commands/branches.rs` tests — test create_branch_inner with from_oid parameter (MENU-04)

*Existing test infrastructure (cargo test) covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Copy SHA to clipboard | MENU-01 | Clipboard requires native OS context, cannot test headlessly | Right-click commit → Copy SHA → paste in editor, verify match |
| Copy message to clipboard | MENU-02 | Clipboard requires native OS context, cannot test headlessly | Right-click commit → Copy Message → paste in editor, verify match |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
