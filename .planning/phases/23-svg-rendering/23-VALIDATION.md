---
phase: 23
slug: svg-rendering
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 23 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (already installed) |
| **Config file** | `vitest.config.ts` (existing) |
| **Quick run command** | `npx vitest run src/lib/overlay-visible.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/lib/overlay-visible.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 23-01-01 | 01 | 1 | OVRL-04 | unit | `npx vitest run src/lib/overlay-visible.test.ts -x` | ❌ W0 | ⬜ pending |
| 23-01-02 | 01 | 1 | OVRL-04 | unit | `npx vitest run src/lib/overlay-paths.test.ts -x` | ✅ | ⬜ pending |
| 23-02-01 | 02 | 2 | CURV-03 | manual | Visual inspection — SVG `<g>` group order | N/A | ⬜ pending |
| 23-02-02 | 02 | 2 | DOTS-01 | manual | Visual inspection — dot shapes | N/A | ⬜ pending |
| 23-02-03 | 02 | 2 | DOTS-02 | manual | Visual inspection — WIP dot | N/A | ⬜ pending |
| 23-02-04 | 02 | 2 | DOTS-03 | manual | Visual inspection — stash square | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/overlay-visible.ts` — visibility filtering function (getVisibleOverlayElements)
- [ ] `src/lib/overlay-visible.test.ts` — unit tests for OVRL-04 (row-range filtering, edge intersection, buffer)
- [ ] `src/lib/types.ts` — OverlayPath extended with `minRow`/`maxRow` fields
- [ ] `src/lib/overlay-paths.ts` — updated to populate `minRow`/`maxRow` on output paths
- [ ] `src/lib/overlay-paths.test.ts` — updated tests to verify `minRow`/`maxRow` in output

*Existing test infrastructure (Vitest, test patterns) is sufficient — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Three-layer z-ordering (rails behind edges behind dots) | CURV-03 | Structural SVG DOM order — not behavioral | Inspect DOM: `<g class="overlay-rails">` first, `<g class="overlay-connections">` second, `<g class="overlay-dots">` third |
| Normal → filled circle, merge → hollow circle | DOTS-01 | Svelte template rendering — visual | View commit graph with mix of normal and merge commits |
| WIP → hollow dashed circle | DOTS-02 | Svelte template rendering — visual | View commit graph with uncommitted changes |
| Stash → filled square | DOTS-03 | Svelte template rendering — visual | Create a stash and view commit graph |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
