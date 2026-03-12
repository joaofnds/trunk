---
phase: 16
slug: core-graph-rendering
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | Inline in package.json (`"test": "vitest run"`) |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 16-01-01 | 01 | 1 | RENDER-01 | unit | `npx vitest run src/lib/graph-cell.test.ts -t "viewBox"` | ❌ W0 | ⬜ pending |
| 16-01-02 | 01 | 1 | RENDER-02 | manual-only | Visual inspection in dev mode | N/A | ⬜ pending |
| 16-01-03 | 01 | 1 | RENDER-03 | manual-only | Side-by-side comparison in app | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/graph-cell.test.ts` — unit tests for viewBox clipping and path filtering/categorization logic
- Existing `graph-svg-data.test.ts` (15 tests) covers the data layer — no changes needed

*Existing infrastructure covers most phase requirements. Only RENDER-01 path filtering needs new test stubs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Commit dots render correctly (filled vs hollow) | RENDER-02 | Inherently visual — SVG rendering appearance | 1. Open app in dev mode 2. Find regular and merge commits 3. Verify filled circles for regular, hollow for merge |
| Visual parity with v0.3 output | RENDER-03 | Visual comparison cannot be automated without screenshot diffing infrastructure | 1. Run v0.3 and v0.4 side-by-side on same repo 2. Compare colors, routing, dot styles, lane positions 3. Verify no visible seams between rows |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
