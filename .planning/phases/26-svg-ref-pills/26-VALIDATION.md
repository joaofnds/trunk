---
phase: 26
slug: svg-ref-pills
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 26 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.0 |
| **Config file** | Inline in package.json (`"test": "vitest run"`) |
| **Quick run command** | `npx vitest run src/lib/ref-pill-data.test.ts src/lib/text-measure.test.ts -x` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/lib/ref-pill-data.test.ts src/lib/text-measure.test.ts -x`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 26-01-01 | 01 | 1 | PILL-01 | unit | `npx vitest run src/lib/ref-pill-data.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-01-01 | 01 | 1 | PILL-01 | unit | `npx vitest run src/lib/text-measure.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-01-02 | 01 | 1 | PILL-02 | unit | `npx vitest run src/lib/ref-pill-data.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-01-02 | 01 | 1 | PILL-03 | unit | `npx vitest run src/lib/ref-pill-data.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-02-01 | 02 | 2 | PILL-04 | unit | `npx vitest run src/lib/ref-pill-data.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-02-02 | 02 | 2 | PILL-04 | manual | Visual verification of hover interaction | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/ref-pill-data.test.ts` — stubs for PILL-01, PILL-02, PILL-03, PILL-04 (data computation)
- [ ] `src/lib/text-measure.test.ts` — covers text measurement and truncation logic
- [ ] Constants in `src/lib/graph-constants.ts` — pill-specific constants (PILL_HEIGHT, etc.)

*Note: Text measurement tests can mock `measureText()` with a simple character-width function for deterministic testing without a real Canvas context. `buildRefPillData()` accepts `measureText` as a parameter for testability.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Hover expansion shows all refs one per line | PILL-04 | Interactive CSS animation; requires visual/hover verification | Hover over pill or +N badge, verify all refs expand one per line with ~150-200ms smooth animation |
| Capsule shape and visual styling | PILL-01 | Visual appearance check | Verify pills have fully rounded ends, correct colors, proper text alignment |
| Remote dimming visual appearance | PILL-03 | Opacity/brightness visual check | Verify remote-only pills appear at 65-70% opacity, non-HEAD at brightness(0.75) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
