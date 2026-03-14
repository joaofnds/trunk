---
phase: 24
slug: integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 24 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (latest, configured via vite) |
| **Config file** | vite.config.ts (test section) |
| **Quick run command** | `npx vitest run` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 24-01-01 | 01 | 1 | TUNE-01 | unit | `npx vitest run src/lib/graph-constants.test.ts -x` | ✅ (needs update) | ⬜ pending |
| 24-01-02 | 01 | 1 | TUNE-01 | unit | `npx vitest run src/lib/overlay-paths.test.ts -x` | ✅ (needs update) | ⬜ pending |
| 24-02-01 | 02 | 1 | TUNE-01 | unit | `npx vitest run` | ✅ | ⬜ pending |
| 24-02-02 | 02 | 1 | TUNE-02 | manual | Visual verification | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. Tests need value updates, not new test files.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| 8 lane colors render via CSS custom properties on SVG elements | TUNE-02 | CSS custom properties evaluated at runtime, not testable in unit tests | Open app, verify commit graph shows colored lanes using `--lane-0` through `--lane-7` |
| Virtual scrolling remains smooth at 5k+ commits | TUNE-01 | Performance is a runtime characteristic | Open large repo, scroll through commit history, verify no jank |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
