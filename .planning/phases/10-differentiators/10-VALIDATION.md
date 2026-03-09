---
phase: 10
slug: differentiators
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust `#[cfg(test)]` for backend; manual for frontend |
| **Config file** | Inline `#[cfg(test)] mod tests` in graph.rs |
| **Quick run command** | `cd src-tauri && cargo test --lib` |
| **Full suite command** | `cd src-tauri && cargo test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test --lib`
- **After every plan wave:** Run `cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | DIFF-01 | unit | `cd src-tauri && cargo test graph::tests::ref_label_color_index` | ❌ W0 | ⬜ pending |
| 10-01-02 | 01 | 1 | DIFF-01 | unit | `cd src-tauri && cargo test graph::tests::ref_label_color_index_no_refs` | ❌ W0 | ⬜ pending |
| 10-01-03 | 01 | 1 | DIFF-01 | manual | Visual inspection — pill renders with lane color | N/A | ⬜ pending |
| 10-01-04 | 01 | 1 | DIFF-01 | manual | Visual inspection — remote-only refs dimmed | N/A | ⬜ pending |
| 10-01-05 | 01 | 1 | DIFF-01 | manual | Visual inspection — connector line from pill to dot | N/A | ⬜ pending |
| 10-02-01 | 02 | 1 | DIFF-02 | manual | Visual: resize column, reload, check preserved | N/A | ⬜ pending |
| 10-02-02 | 02 | 1 | DIFF-02 | manual | Visual: header row visible and aligned | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `graph::tests::ref_label_color_index` — verify RefLabel.color_index matches commit color_index after graph walk
- [ ] `graph::tests::ref_label_color_index_no_refs` — commits without refs should still work (no panic)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Pill renders with lane color background | DIFF-01 | Visual/CSS rendering | Open repo with branches, verify pill bg matches lane color |
| Remote-only refs dimmed, shared refs full opacity | DIFF-01 | Visual opacity check | Push a branch, verify remote-only ref is dimmed |
| Connector line from pill to dot | DIFF-01 | SVG visual rendering | Open repo with branches not in column 0, verify horizontal line |
| Column widths persist via LazyStore | DIFF-02 | Requires app reload | Resize a column, reload app, verify width preserved |
| Header row visible and aligned with rows | DIFF-02 | Visual alignment check | Scroll through commits, verify header stays aligned |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
