---
phase: 21
slug: active-lanes-transformation
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-03-13
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | `vite.config.ts` (test section at line 24-27) |
| **Quick run command** | `npx vitest run src/lib/active-lanes.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~2 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/lib/active-lanes.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 3 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 21-01-01 | 01 | 1 | DATA-01 | unit | `npx vitest run src/lib/active-lanes.test.ts -t "returns OverlayGraphData" -x` | ❌ W0 | ⬜ pending |
| 21-01-01 | 01 | 1 | DATA-01 | unit | `npx vitest run src/lib/active-lanes.test.ts -t "node coordinates" -x` | ❌ W0 | ⬜ pending |
| 21-01-01 | 01 | 1 | DATA-01 | unit | `npx vitest run src/lib/active-lanes.test.ts -t "WIP" -x` | ❌ W0 | ⬜ pending |
| 21-01-01 | 01 | 1 | DATA-01 | unit | `npx vitest run src/lib/active-lanes.test.ts -t "stash" -x` | ❌ W0 | ⬜ pending |
| 21-01-01 | 01 | 1 | DATA-02 | unit | `npx vitest run src/lib/active-lanes.test.ts -t "coalesce" -x` | ❌ W0 | ⬜ pending |
| 21-01-01 | 01 | 1 | DATA-02 | unit | `npx vitest run src/lib/active-lanes.test.ts -t "property change" -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/active-lanes.test.ts` — stubs for DATA-01, DATA-02, all success criteria test scenarios
- [ ] `src/lib/active-lanes.ts` — implementation file (empty export initially)

*Framework install not needed — vitest already configured.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.* This is a pure data transformation with no UI.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 3s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
