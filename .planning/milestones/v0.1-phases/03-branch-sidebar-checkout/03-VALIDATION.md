---
phase: 3
slug: branch-sidebar-checkout
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-04
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in `#[test]` (cargo test) |
| **Config file** | None — cargo test runs automatically |
| **Quick run command** | `cargo test -p trunk --lib -- branches` |
| **Full suite command** | `cargo test -p trunk --lib` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p trunk --lib -- branches`
- **After every plan wave:** Run `cargo test -p trunk --lib`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 0 | BRNCH-01 | unit | `cargo test -p trunk --lib -- branches::tests::list_refs_returns_all` | ❌ W0 | ⬜ pending |
| 3-01-02 | 01 | 0 | BRNCH-01 | unit | `cargo test -p trunk --lib -- branches::tests::list_refs_hides_remote_head` | ❌ W0 | ⬜ pending |
| 3-01-03 | 01 | 0 | BRNCH-01 | unit | `cargo test -p trunk --lib -- branches::tests::list_refs_head_flag` | ❌ W0 | ⬜ pending |
| 3-01-04 | 01 | 0 | BRNCH-03 | unit | `cargo test -p trunk --lib -- branches::tests::checkout_dirty_returns_error` | ❌ W0 | ⬜ pending |
| 3-01-05 | 01 | 0 | BRNCH-03 | unit | `cargo test -p trunk --lib -- branches::tests::checkout_clean_succeeds` | ❌ W0 | ⬜ pending |
| 3-01-06 | 01 | 0 | BRNCH-04 | unit | `cargo test -p trunk --lib -- branches::tests::create_branch_from_head` | ❌ W0 | ⬜ pending |
| 3-01-07 | 01 | 0 | BRNCH-04 | unit | `cargo test -p trunk --lib -- branches::tests::create_branch_duplicate_fails` | ❌ W0 | ⬜ pending |
| 3-02-01 | 02 | 1 | BRNCH-01 | manual | Visual: sidebar lists all sections with correct data | N/A | ⬜ pending |
| 3-02-02 | 02 | 1 | BRNCH-02 | manual | Visual: search filters in real-time without backend call | N/A | ⬜ pending |
| 3-02-03 | 02 | 1 | BRNCH-03 | manual | Visual: dirty-workdir error banner appears inline | N/A | ⬜ pending |
| 3-02-04 | 02 | 1 | BRNCH-04 | manual | Visual: create branch inline input works | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/branches.rs` — all test stubs for BRNCH-01, BRNCH-03, BRNCH-04
- [ ] Helper `make_test_repo_with_remote_branch()` — extend test helpers to create repo with remote tracking branch
- [ ] Helper `make_dirty_repo()` — create test repo with uncommitted changes for BRNCH-03

*Existing `make_test_repo()` in `git/repository.rs` is reusable for clean-tree tests.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Frontend search filter works in real-time | BRNCH-02 | Pure `$derived` computation, no backend involvement | Open repo, type in search box, verify list updates immediately without network tab activity |
| Active branch highlighted in sidebar | BRNCH-01 | Visual styling (accent color + bold) | Open repo on a known branch, verify it appears highlighted |
| Collapsible sections expand/collapse | BRNCH-01 | DOM interaction, no backend | Click section headers, verify sections collapse/expand |
| Inline error banner dismisses on action | BRNCH-03 | UX behavior | Trigger dirty-workdir error, then type in search — banner should disappear |
| New branch appears immediately after create | BRNCH-04 | UI reactivity | Create branch, verify it appears in Local section without refresh |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
