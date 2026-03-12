---
phase: 14
slug: toolbar-tracking
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust `#[cfg(test)]` + cargo test |
| **Config file** | src-tauri/Cargo.toml (built-in) |
| **Quick run command** | `cd src-tauri && cargo test` |
| **Full suite command** | `cd src-tauri && cargo test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test`
- **After every plan wave:** Run `cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 14-01-01 | 01 | 1 | TRACK-01 | unit | `cd src-tauri && cargo test branches::tests::list_refs_ahead_behind` | ❌ W0 | ⬜ pending |
| 14-01-02 | 01 | 1 | TRACK-02 | manual-only | Manual: fetch then check sidebar | N/A | ⬜ pending |
| 14-02-01 | 02 | 1 | TOOLBAR-01 | manual-only | Manual: visual check toolbar buttons | N/A | ⬜ pending |
| 14-02-02 | 02 | 1 | TOOLBAR-02 | unit | `cd src-tauri && cargo test undo_commit` | ❌ W0 | ⬜ pending |
| 14-02-03 | 02 | 1 | TOOLBAR-03 | unit | `cd src-tauri && cargo test redo_commit` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `branches::tests::list_refs_ahead_behind` — test that branches with upstream return real ahead/behind counts
- [ ] `undo_commit` tests — undo returns captured message, undo on merge commit fails, undo on initial commit fails
- [ ] `redo_commit` tests — recommit with saved message, redo on empty stack fails

*Existing infrastructure covers framework setup — only test stubs needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Toolbar has Pull, Push, Branch, Stash, Pop, Undo, Redo buttons | TOOLBAR-01 | Visual UI layout | Open app, verify all buttons visible and in correct order |
| Ahead/behind updates after remote ops | TRACK-02 | Event-driven refresh flow | Push a commit, verify sidebar counts update |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
