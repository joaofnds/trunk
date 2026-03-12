---
phase: 15
slug: graph-data-engine
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (not yet installed) |
| **Config file** | none — Wave 0 installs |
| **Quick run command** | `npx vitest run src/lib/graph-svg-data.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/lib/graph-svg-data.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 15-01-01 | 01 | 0 | GRAPH-01 | infra | `npx vitest run` | ❌ W0 | ⬜ pending |
| 15-01-02 | 01 | 1 | GRAPH-01a | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "straight"` | ❌ W0 | ⬜ pending |
| 15-01-03 | 01 | 1 | GRAPH-01b | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "merge"` | ❌ W0 | ⬜ pending |
| 15-01-04 | 01 | 1 | GRAPH-01c | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "manhattan"` | ❌ W0 | ⬜ pending |
| 15-01-05 | 01 | 1 | GRAPH-01d | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "incoming"` | ❌ W0 | ⬜ pending |
| 15-01-06 | 01 | 1 | GRAPH-01e | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "sentinel"` | ❌ W0 | ⬜ pending |
| 15-01-07 | 01 | 1 | GRAPH-01f | manual | Visual inspection / Svelte devtools | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest` dev dependency install: `npm install -D vitest`
- [ ] Vitest config in `vite.config.ts` or standalone `vitest.config.ts`
- [ ] `src/lib/graph-svg-data.test.ts` — stub file covering GRAPH-01a through GRAPH-01e
- [ ] Test helper: `makeCommit()` factory for creating GraphCommit test fixtures

*Existing infrastructure does NOT cover phase requirements — Wave 0 setup needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Reactivity: `$derived.by()` recomputes on data change only | GRAPH-01f | Structural integration — reactive wiring is a Svelte component concern, not unit-testable | 1. Open Svelte devtools 2. Trigger data change 3. Verify `$derived.by()` fires 4. Scroll without data change 5. Verify no recomputation |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
