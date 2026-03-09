---
phase: 5
slug: commit-creation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in test (`cargo test`) |
| **Config file** | none — standard `#[cfg(test)] mod tests` in each `.rs` file |
| **Quick run command** | `cargo test -p trunk --lib commit -- --nocapture` |
| **Full suite command** | `cargo test -p trunk` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p trunk --lib commit`
- **After every plan wave:** Run `cargo test -p trunk`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 5-01-01 | 01 | 0 | COMIT-01 | unit | `cargo test -p trunk --lib commit::tests::create_commit_creates_commit` | ❌ W0 | ⬜ pending |
| 5-01-02 | 01 | 0 | COMIT-01 | unit | `cargo test -p trunk --lib commit::tests::create_commit_unborn_head` | ❌ W0 | ⬜ pending |
| 5-01-03 | 01 | 0 | COMIT-01 | unit | `cargo test -p trunk --lib commit::tests::create_commit_uses_signature` | ❌ W0 | ⬜ pending |
| 5-02-01 | 01 | 0 | COMIT-03 | unit | `cargo test -p trunk --lib commit::tests::amend_commit_updates_message` | ❌ W0 | ⬜ pending |
| 5-02-02 | 01 | 0 | COMIT-03 | unit | `cargo test -p trunk --lib commit::tests::amend_commit_includes_staged` | ❌ W0 | ⬜ pending |
| 5-02-03 | 01 | 0 | COMIT-03 | unit | `cargo test -p trunk --lib commit::tests::get_head_commit_message_returns_message` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/commit.rs` — add `#[cfg(test)] mod tests` block with stubs for all 6 test cases above

*Existing infrastructure covers test runner — no new framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Commit button shows loading state during in-flight invoke | COMIT-01 | No vitest/jest configured for Svelte components | Open app, stage a file, submit commit, observe button disabled/loading state |
| Empty subject shows inline error below subject field | COMIT-02 | Frontend-only UI validation | Click commit with empty subject, verify red error text appears below field |
| Empty staging area shows inline warning near button | COMIT-02 | Frontend-only UI validation | Click commit with no staged files, verify warning appears near commit button |
| Amend checkbox pre-populates subject/body from HEAD | COMIT-03 | Frontend-only behavior | Check amend checkbox, verify fields populate with HEAD commit message |
| Graph updates immediately after commit | COMIT-01 | End-to-end visual | Create commit, verify new node appears at top of graph without manual refresh |
| Graph updates after amend | COMIT-03 | End-to-end visual | Amend commit, verify graph reflects updated commit message |
| On success: fields clear, checkbox unchecks | COMIT-01 | Post-submit UI state | Commit successfully, verify form resets silently |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
