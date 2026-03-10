---
phase: 7
slug: lane-algorithm-hardening
status: complete
nyquist_compliant: true
wave_0_complete: true
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
| 07-01-01 | 01 | 0 | ALGO-01 | unit | `cd src-tauri && cargo test --lib git::graph::tests::no_ghost_lanes_after_merge -- --exact` | ✅ | ✅ green |
| 07-01-02 | 01 | 0 | ALGO-01 | unit | `cd src-tauri && cargo test --lib git::graph::tests::no_ghost_lanes_criss_cross -- --exact` | ✅ | ✅ green |
| 07-01-03 | 01 | 0 | ALGO-02 | unit | `cd src-tauri && cargo test --lib git::graph::tests::octopus_merge_compact -- --exact` | ✅ | ✅ green |
| 07-01-04 | 01 | 0 | ALGO-02 | unit | `cd src-tauri && cargo test --lib git::graph::tests::octopus_no_column_zero_theft -- --exact` | ✅ | ✅ green |
| 07-01-05 | 01 | 0 | ALGO-03 | unit | `cd src-tauri && cargo test --lib git::graph::tests::consistent_max_columns -- --exact` | ✅ | ✅ green |
| 07-01-06 | 01 | 0 | ALGO-03 | unit | `cd src-tauri && cargo test --lib git::graph::tests::max_columns_pagination -- --exact` | ✅ | ✅ green |
| 07-01-07 | 01 | 0 | LANE-05 | unit | `cd src-tauri && cargo test --lib git::graph::tests::freed_column_reuse -- --exact` | ✅ | ✅ green |
| 07-01-08 | 01 | 0 | ALL | unit | `cd src-tauri && cargo test --lib git::graph::tests::color_index_deterministic -- --exact` | ✅ | ✅ green |
| 07-01-09 | 01 | 0 | ALL | unit | `cd src-tauri && cargo test --lib git::graph::tests::color_index_head_zero -- --exact` | ✅ | ✅ green |
| 07-ALL | ALL | ALL | ALL | regression | `cd src-tauri && cargo test --lib git::graph` | ✅ (18 tests) | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. All 9 planned tests were implemented during plan 07-01 execution (TDD approach).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SVG width visually consistent when scrolling | ALGO-03 | Visual rendering in browser | Open app, scroll through commits, verify no horizontal jitter |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 10s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-03-10

---

## Validation Audit 2026-03-10

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |
