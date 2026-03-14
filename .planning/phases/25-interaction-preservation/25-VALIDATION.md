---
phase: 25
slug: interaction-preservation
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-14
---

# Phase 25 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.0 |
| **Config file** | None (uses Vite config defaults) |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test`
- **After every plan wave:** Run `npm test` + manual interaction verification
- **Before `/gsd-verify-work`:** Full suite must be green + manual verification of all 3 requirements
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 25-01-01 | 01 | 1 | INTR-01 | manual + regression | `npm test` (existing tests pass) | N/A — UI wiring | ⬜ pending |
| 25-01-02 | 01 | 1 | INTR-02, INTR-03 | manual + regression | `npm test` (existing tests pass) | N/A — native menu | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No new test files needed.

Phase 25's requirements (INTR-01, INTR-02, INTR-03) are UI interaction behaviors that use native Tauri menus and DOM events — these cannot be unit-tested meaningfully. The underlying data pipeline (active-lanes, overlay-paths, overlay-visible) is already covered by existing tests. Backend stash operations are tested in `src-tauri/src/commands/stash.rs` (8 tests).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Click commit row → shows detail | INTR-01 | UI interaction through SVG overlay, needs visual confirmation | 1. Open a repo with commits. 2. Click a commit row. 3. Verify diff panel shows commit detail. 4. Verify row has selected background highlight. 5. Click same row again — verify deselect. |
| Right-click commit → context menu | INTR-02 | Native Tauri menu cannot be tested in-process | 1. Right-click a commit row. 2. Verify context menu appears with: Copy SHA, Copy Message, Checkout, Create Branch, Create Tag, Cherry-pick, Revert. |
| Right-click stash → stash menu | INTR-03 | Native Tauri menu + stash operations | 1. Create a stash (if none exist). 2. Right-click a stash row in the graph. 3. Verify menu shows Pop, Apply, Drop. 4. Click Drop — verify confirmation dialog appears. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
