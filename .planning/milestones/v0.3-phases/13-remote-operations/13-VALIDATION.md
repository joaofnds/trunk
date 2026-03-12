---
phase: 13
slug: remote-operations
status: draft
nyquist_compliant: true
wave_0_complete: true
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
| 13-01-01 | 01 | 1 | REMOTE-01 | build | `cd src-tauri && cargo check` | N/A | ⬜ pending |
| 13-01-02 | 01 | 1 | REMOTE-01..04 | unit+build | `cd src-tauri && cargo test --lib commands::remote` | inline | ⬜ pending |
| 13-02-01 | 02 | 2 | TOOLBAR-01 | manual-only | Manual: verify toolbar appears with correct buttons | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Nyquist Compliance Notes

Plan 01 Task 2 is marked `tdd="true"` and writes unit tests for `classify_git_error` inline within `remote.rs` (`#[cfg(test)] mod tests`). This satisfies the Nyquist rule -- tests are created as part of the implementation task, not in a separate Wave 0. The `<verify>` element runs `cargo test --lib commands::remote` which exercises these inline tests.

No separate Wave 0 plan is needed because:
1. The test file (`remote.rs` with `#[cfg(test)]`) is created by the same task that writes the production code (TDD red-green cycle).
2. The `<behavior>` block in Task 2 defines test expectations before implementation.
3. `cargo test` infrastructure already exists (no new test framework setup required).

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

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (N/A -- no MISSING references, tests are inline TDD)
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
