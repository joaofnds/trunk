---
phase: 11
slug: stash-operations
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in `#[test]` (cargo test) |
| **Config file** | none — Cargo.toml dev-dependencies has `tempfile = "3"` |
| **Quick run command** | `cargo test -p trunk stash` |
| **Full suite command** | `cargo test -p trunk` |
| **Estimated runtime** | ~30 seconds (quick), ~120 seconds (full) |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p trunk stash` (from `src-tauri/`)
- **After every plan wave:** Run `cargo test -p trunk` (from `src-tauri/`)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 0 | STASH-01, STASH-03, STASH-04, STASH-05, STASH-06 | unit | `cargo test -p trunk stash` | ❌ W0 | ⬜ pending |
| 11-01-02 | 01 | 1 | STASH-01 | unit | `cargo test -p trunk stash_save` | ❌ W0 | ⬜ pending |
| 11-01-03 | 01 | 1 | STASH-03 | unit | `cargo test -p trunk list_stashes` | ❌ W0 | ⬜ pending |
| 11-01-04 | 01 | 1 | STASH-04 | unit | `cargo test -p trunk stash_pop` | ❌ W0 | ⬜ pending |
| 11-01-05 | 01 | 1 | STASH-05 | unit | `cargo test -p trunk stash_apply` | ❌ W0 | ⬜ pending |
| 11-01-06 | 01 | 1 | STASH-06 | unit | `cargo test -p trunk stash_drop` | ❌ W0 | ⬜ pending |
| 11-02-01 | 02 | 2 | STASH-02 | manual | visual inspection of commit graph | N/A | ⬜ pending |
| 11-02-02 | 02 | 2 | STASH-07 | manual | right-click context menu in app | N/A | ⬜ pending |
| 11-03-01 | 03 | 2 | STASH-01, STASH-03, STASH-04, STASH-05, STASH-06 | manual | sidebar stash section in app | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/stash.rs` — test module with `make_state_map` helper + stash test fixtures; covers STASH-01, STASH-03, STASH-04, STASH-05, STASH-06

*(STASH-02 and STASH-07 are UI-only and covered by manual verification)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Stash entries appear as synthetic rows with square dots and dashed connectors in commit graph | STASH-02 | Svelte/canvas rendering, no DOM test harness | Create a stash, open app, verify graph shows stash row at parent commit with square dot and dashed connector |
| Right-click stash row shows context menu with pop/apply/drop | STASH-07 | Tauri native menu, not accessible via unit test | Right-click stash row in graph, verify pop/apply/drop items appear and trigger correct action |
| Sidebar stash list with create form and per-entry actions | STASH-03, STASH-01 | Svelte UI component, no e2e test setup | Open sidebar, verify stash section shows list and create form with optional name input |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
