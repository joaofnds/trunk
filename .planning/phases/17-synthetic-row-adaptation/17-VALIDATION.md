---
phase: 17
slug: synthetic-row-adaptation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | `vite.config.ts` (test block) |
| **Quick run command** | `npx vitest --run -x` |
| **Full suite command** | `npx vitest --run --reporter=verbose` |
| **Estimated runtime** | ~3 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest --run -x`
- **After every plan wave:** Run `npx vitest --run --reporter=verbose`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 17-01-T1 | 01 | 1 | SYNTH-01, SYNTH-02 | unit (TDD) | `npx vitest --run -t "sentinel" -x` | ❌ W0 (in-task) | ⬜ pending |
| 17-02-T1 | 02 | 2 | SYNTH-01, SYNTH-02 | build | `npx vite build` | ✅ | ⬜ pending |
| 17-02-T2 | 02 | 2 | SYNTH-02 | build + unit | `npx vitest --run -x` | ✅ | ⬜ pending |
| 17-02-T3 | 02 | 2 | SYNTH-01, SYNTH-02 | visual | manual | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

TDD plan (17-01) creates its own tests as part of the RED phase — no separate Wave 0 needed.

- [ ] `src/lib/graph-svg-data.test.ts` — update "skips sentinel" tests to verify paths ARE generated with dashed flag
- [ ] `src/lib/graph-svg-data.test.ts` — add WIP connector path coordinate tests
- [ ] `src/lib/graph-svg-data.test.ts` — add stash connector path coordinate tests

*Wave 0 is embedded in Plan 01 (TDD plan) — test-first by design.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| WIP row dashed connector visually correct | SYNTH-01 | SVG rendering appearance | Run `cargo tauri dev`, open repo with uncommitted changes, verify dashed line from WIP to HEAD |
| Stash square dots visible | SYNTH-02 | SVG rendering appearance | Create stash, verify square dot appears in graph |
| Virtual scrolling smooth with synthetic rows | SYNTH-01, SYNTH-02 | Performance/scroll behavior | Scroll rapidly through commits with WIP and stash rows present |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
