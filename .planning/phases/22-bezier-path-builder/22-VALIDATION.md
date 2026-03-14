---
phase: 22
slug: bezier-path-builder
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-03-14
---

# Phase 22 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.0 |
| **Config file** | `vite.config.ts` (test section at lines 24-27) |
| **Quick run command** | `npx vitest run src/lib/overlay-paths.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~2 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/lib/overlay-paths.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 2 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 22-01-01 | 01 | 1 | CURV-01, CURV-02, CURV-04 | unit | `npx vitest run src/lib/overlay-paths.test.ts` | ❌ W0 | ⬜ pending |
| 22-01-02 | 01 | 1 | CURV-01, CURV-02, CURV-04 | unit | `npx vitest run src/lib/overlay-paths.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/overlay-paths.test.ts` — test stubs for CURV-01 (connection paths), CURV-02 (rail paths), CURV-04 (fixed radius)
- [ ] `OverlayPath` type in `src/lib/types.ts` — extends SvgPathData with `kind: 'rail' | 'connection'`

*Existing infrastructure covers all framework needs — Vitest already configured and working. 62 existing tests pass.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 2s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
