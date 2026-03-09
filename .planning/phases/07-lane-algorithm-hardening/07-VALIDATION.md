---
phase: 7
slug: lane-algorithm-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in `#[cfg(test)]` + `cargo test` |
| **Config file** | None needed — Rust test runner is built-in |
| **Quick run command** | `cd src-tauri && cargo test --lib git::graph` |
| **Full suite command** | `cd src-tauri && cargo test --lib` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test --lib git::graph`
- **After every plan wave:** Run `cd src-tauri && cargo test --lib`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 0 | ALGO-01 | unit | `cd src-tauri && cargo test --lib git::graph::tests::no_ghost_lanes_after_merge -- --exact` | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 0 | ALGO-01 | unit | `cd src-tauri && cargo test --lib git::graph::tests::no_ghost_lanes_criss_cross -- --exact` | ❌ W0 | ⬜ pending |
| 07-01-03 | 01 | 0 | ALGO-02 | unit | `cd src-tauri && cargo test --lib git::graph::tests::octopus_merge_compact -- --exact` | ❌ W0 | ⬜ pending |
| 07-01-04 | 01 | 0 | ALGO-02 | unit | `cd src-tauri && cargo test --lib git::graph::tests::octopus_no_column_zero_theft -- --exact` | ❌ W0 | ⬜ pending |
| 07-01-05 | 01 | 0 | ALGO-03 | unit | `cd src-tauri && cargo test --lib git::graph::tests::consistent_max_columns -- --exact` | ❌ W0 | ⬜ pending |
| 07-01-06 | 01 | 0 | ALGO-03 | unit | `cd src-tauri && cargo test --lib git::graph::tests::max_columns_pagination -- --exact` | ❌ W0 | ⬜ pending |
| 07-01-07 | 01 | 0 | LANE-05 | unit | `cd src-tauri && cargo test --lib git::graph::tests::freed_column_reuse -- --exact` | ❌ W0 | ⬜ pending |
| 07-01-08 | 01 | 0 | ALL | unit | `cd src-tauri && cargo test --lib git::graph::tests::color_index_deterministic -- --exact` | ❌ W0 | ⬜ pending |
| 07-01-09 | 01 | 0 | ALL | unit | `cd src-tauri && cargo test --lib git::graph::tests::color_index_head_zero -- --exact` | ❌ W0 | ⬜ pending |
| 07-ALL | ALL | ALL | ALL | regression | `cd src-tauri && cargo test --lib git::graph` | ✅ (7 tests) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/git/graph.rs::tests::no_ghost_lanes_after_merge` — stub for ALGO-01
- [ ] `src-tauri/src/git/graph.rs::tests::no_ghost_lanes_criss_cross` — stub for ALGO-01
- [ ] `src-tauri/src/git/graph.rs::tests::octopus_merge_compact` — stub for ALGO-02
- [ ] `src-tauri/src/git/graph.rs::tests::octopus_no_column_zero_theft` — stub for ALGO-02
- [ ] `src-tauri/src/git/graph.rs::tests::consistent_max_columns` — stub for ALGO-03
- [ ] `src-tauri/src/git/graph.rs::tests::max_columns_pagination` — stub for ALGO-03
- [ ] `src-tauri/src/git/graph.rs::tests::freed_column_reuse` — stub for LANE-05
- [ ] `src-tauri/src/git/graph.rs::tests::color_index_deterministic` — stub for color model
- [ ] `src-tauri/src/git/graph.rs::tests::color_index_head_zero` — stub for color model

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SVG width visually consistent when scrolling | ALGO-03 | Visual rendering in browser | Open app, scroll through commits, verify no horizontal jitter |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
