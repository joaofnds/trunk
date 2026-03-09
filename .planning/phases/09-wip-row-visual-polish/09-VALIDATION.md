---
phase: 9
slug: wip-row-visual-polish
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust `#[test]` (backend), no frontend test framework |
| **Config file** | `src-tauri/Cargo.toml` (Rust tests) |
| **Quick run command** | `cd src-tauri && cargo test --lib` |
| **Full suite command** | `cd src-tauri && cargo test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Visual inspection in dev server (`npm run tauri dev`)
- **After every plan wave:** Run `cd src-tauri && cargo test` (ensure no regressions)
- **Before `/gsd:verify-work`:** Full suite must be green + visual verification of all three requirements
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | VIS-01 | manual-only | N/A — SVG visual rendering | N/A | ⬜ pending |
| 09-01-02 | 01 | 1 | VIS-03 | manual-only | N/A — same visual change as VIS-01 | N/A | ⬜ pending |
| 09-02-01 | 02 | 1 | VIS-02 | manual-only | N/A — frontend-only visual rendering | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No new test framework setup needed. The `is_merge` flag is already tested in Rust backend (`graph.rs`). All phase changes are frontend visual SVG modifications validated by manual inspection.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Merge commits display as hollow circles with lane-colored stroke | VIS-01 | SVG visual rendering — no Rust logic changes, no frontend test framework | Run `npm run tauri dev`, find a merge commit in graph, verify hollow circle with colored stroke vs filled circle for regular commits |
| WIP row connects to HEAD via dashed lane line | VIS-02 | Frontend-only visual rendering — no automated framework | Run `npm run tauri dev` with dirty working tree, verify dashed line from WIP row to HEAD commit |
| Merge commits visually de-emphasized via hollow dot | VIS-03 | Same visual change as VIS-01 — hollow dot is the sole differentiator | Verify merge commits are visually distinct from regular commits via hollow styling |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (all manual — justified by visual-only changes)
- [x] Wave 0 covers all MISSING references (none needed)
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
