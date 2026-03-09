---
phase: 8
slug: straight-rail-rendering
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust: `cargo test` (built-in), Frontend: none (visual inspection) |
| **Config file** | `src-tauri/Cargo.toml` for Rust tests |
| **Quick run command** | `cd src-tauri && cargo test git::graph` |
| **Full suite command** | `cd src-tauri && cargo test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test git::graph`
- **After every plan wave:** Run `cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | LANE-01 | manual | Visual inspection — continuous vertical lines | N/A (rendering) | ⬜ pending |
| 08-01-02 | 01 | 1 | LANE-03 | unit (Rust) | `cd src-tauri && cargo test git::graph::tests::branch_fork_topology` | ✅ | ⬜ pending |
| 08-01-03 | 01 | 1 | LANE-04 | unit (Rust) | `cd src-tauri && cargo test git::graph::tests::color_index_deterministic` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No new test framework installation needed.

- Backend graph tests already validate edge data emission (pass-through edges, color assignment)
- Frontend rendering is pure SVG — best validated visually

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Continuous vertical rail lines with no gaps at any zoom level | LANE-01 | SVG rendering visual quality; sub-pixel gaps are zoom-dependent | Open app, zoom in/out on commit graph, verify no visible seams between rows |
| Commit dots render on top of lane lines | LANE-01 | SVG z-ordering is visual | Open app, verify dots are visually above rail lines at intersections |
| Lane colors are vivid and distinguishable on dark background | LANE-04 | Color perception is subjective | Open app with multiple branches, verify all 8 colors are clearly visible |
| Manhattan edge routing with rounded corners | LANE-01 | Path rendering quality | Open app with merge/fork commits, verify horizontal-then-vertical routing with smooth corners |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
