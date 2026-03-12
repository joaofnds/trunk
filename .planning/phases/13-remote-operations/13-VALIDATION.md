---
phase: 13
slug: remote-operations
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 13 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in test (cargo test) |
| **Config file** | Cargo.toml (existing) |
| **Quick run command** | `cd src-tauri && cargo test --lib commands::remote` |
| **Full suite command** | `cd src-tauri && cargo test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test --lib commands::remote`
- **After every plan wave:** Run `cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 13-01-01 | 01 | 1 | REMOTE-01 | integration | `cd src-tauri && cargo test commands::remote::tests::fetch` | ❌ W0 | ⬜ pending |
| 13-01-02 | 01 | 1 | REMOTE-02 | integration | `cd src-tauri && cargo test commands::remote::tests::pull` | ❌ W0 | ⬜ pending |
| 13-01-03 | 01 | 1 | REMOTE-03 | integration | `cd src-tauri && cargo test commands::remote::tests::push` | ❌ W0 | ⬜ pending |
| 13-01-04 | 01 | 1 | REMOTE-04 | unit | `cd src-tauri && cargo test commands::remote::tests::classify` | ❌ W0 | ⬜ pending |
| 13-02-01 | 02 | 2 | TOOLBAR-01 | manual-only | Manual: verify toolbar appears with correct buttons | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/remote.rs` — new file with `_inner` functions + test stubs
- [ ] Test helper: `make_test_repo_with_remote()` — creates bare remote + clone pair
- [ ] Error classification unit tests — verify stderr patterns map to correct error codes

*Wave 0 creates test infrastructure before implementation begins.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Toolbar renders with Pull, Push, Branch, Stash, Pop buttons | TOOLBAR-01 | Visual layout verification | Launch app, verify centered toolbar in header with all 5 buttons |
| Pull chevron dropdown shows 4 strategies | TOOLBAR-01 | Dropdown interaction | Click chevron on Pull button, verify Fetch/FF/FF-only/Rebase options |
| Status bar shows spinner during remote ops | REMOTE-01 | Real remote needed | Fetch from a real remote, verify spinner + progress text appears |
| Cancel button kills subprocess | REMOTE-01 | Real subprocess needed | Start fetch on large repo, click X, verify operation stops |
| Non-fast-forward shows "Pull now" action | REMOTE-04 | Requires specific remote state | Push to branch with upstream changes, verify clickable "Pull now" |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
