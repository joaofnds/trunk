---
phase: 20
slug: foundation-types-constants-overlay-container
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 20 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | `vite.config.ts` (test section) |
| **Quick run command** | `npx vitest run` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run`
- **After every plan wave:** Run `npx vitest run` + manual scroll/click test
- **Before `/gsd-verify-work`:** Full suite must be green + decision gate manual test
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 20-01-01 | 01 | 1 | OVRL-01 | manual | Visual: SVG in DOM, height matches contentHeight | ❌ Manual | ⬜ pending |
| 20-01-02 | 01 | 1 | OVRL-02 | manual | Visual: scroll and verify SVG moves with rows | ❌ Manual | ⬜ pending |
| 20-01-03 | 01 | 1 | OVRL-03 | manual | Click rows, right-click context menu through overlay | ❌ Manual | ⬜ pending |
| 20-01-04 | 01 | 1 | — | unit | `npx vitest run src/lib/graph-constants.test.ts` | ❌ W0 | ⬜ pending |
| 20-01-05 | 01 | 1 | — | unit | `npx vitest run src/lib/graph-svg-data.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/graph-constants.test.ts` — verify new overlay constants exist and have expected values
- [ ] Existing `src/lib/graph-svg-data.test.ts` must continue passing (no changes to existing constants)

*Note: OVRL-01, OVRL-02, OVRL-03 are inherently manual/visual tests (DOM placement, scroll behavior, pointer passthrough). They constitute the decision gate and are verified by running the app.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SVG spans full graph height inside scroll container | OVRL-01 | DOM placement is visual/structural | Open app, inspect DOM, verify SVG is child of `.virtual-list-content` with matching height |
| SVG scrolls natively with content | OVRL-02 | Scroll feel/sync is perceptual | Open repo with 500+ commits, scroll rapidly, verify SVG moves with rows at 60fps |
| Pointer events pass through SVG | OVRL-03 | Click/right-click behavior is interactive | Click rows to select, right-click for context menu, verify all work through overlay |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
