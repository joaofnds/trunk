---
phase: 01-foundation
plan: 01
subsystem: infra
tags: [vite, svelte5, tailwindcss, typescript, tauri2]

# Dependency graph
requires: []
provides:
  - Plain Vite+Svelte SPA entry point (no SvelteKit)
  - Tailwind CSS v4 with forced dark theme CSS custom properties
  - $lib path alias in tsconfig.json
  - src/lib/types.ts with all 11 TypeScript DTO interfaces
  - src/lib/invoke.ts with safeInvoke<T> and TrunkError
affects: [02-rust-foundation, 03-history, 04-branches, 05-working-tree, 06-commit]

# Tech tracking
tech-stack:
  added:
    - tailwindcss@4.2.1
    - "@tailwindcss/vite@4.2.1"
    - "@tauri-apps/plugin-dialog@2.6.0"
    - Removed "@sveltejs/kit", "@sveltejs/adapter-static", "@tauri-apps/plugin-opener"
  patterns:
    - Svelte 5 mount() API (not new App() — Svelte 4 pattern)
    - "@import tailwindcss (v4 syntax, not @tailwind directives)"
    - safeInvoke<T> for all Tauri IPC — never raw invoke()
    - CSS custom properties for theme tokens (no Tailwind config needed)
    - String literal unions for TS enums (matches serde serialization)

key-files:
  created:
    - vite.config.ts
    - index.html
    - src/main.ts
    - src/App.svelte
    - src/app.css
    - src/lib/types.ts
    - src/lib/invoke.ts
  modified:
    - tsconfig.json
    - package.json
    - bun.lock
  deleted:
    - svelte.config.js
    - vite.config.js
    - src/routes/+page.svelte
    - src/routes/+layout.ts
    - src/app.html

key-decisions:
  - "Use @sveltejs/vite-plugin-svelte directly (not SvelteKit adapter) — desktop app has no routing/SSR needs"
  - "Tailwind v4 with @tailwindcss/vite plugin — no tailwind.config.js needed, auto-detects"
  - "safeInvoke parses Tauri string rejections into TrunkError{code,message} — prevents silent error swallowing"
  - "Forced dark theme via CSS custom properties — no OS media query toggle per PRD spec"
  - "String literal unions for TypeScript enums to match serde default serialization"
  - "src/app.css created in Task 1 (Rule 3 auto-fix) to unblock build — src/main.ts imports it"

patterns-established:
  - "safeInvoke<T>: All Tauri IPC goes through safeInvoke, never raw invoke()"
  - "CSS custom properties: All theme values via --color-* and --lane-* tokens in :root"
  - "TypeScript string literal unions: EdgeType, RefType, FileStatusType, DiffOrigin match serde"
  - "$lib alias: All shared code imported via $lib/* (tsconfig paths configured)"

requirements-completed: [INFRA-01, INFRA-04]

# Metrics
duration: 3min
completed: 2026-03-03
---

# Phase 1 Plan 01: Foundation Summary

**Plain Vite+Svelte SPA replacing SvelteKit, Tailwind v4 dark theme, and all shared TypeScript contracts (11 DTO interfaces + safeInvoke wrapper)**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-03T20:53:24Z
- **Completed:** 2026-03-03T20:55:50Z
- **Tasks:** 2
- **Files modified:** 10 (7 created, 3 modified, 5 deleted)

## Accomplishments
- Removed SvelteKit entirely and migrated to plain Vite+Svelte with svelte() plugin directly
- Installed Tailwind CSS v4 via @tailwindcss/vite plugin with @import "tailwindcss" syntax
- Created dark theme with CSS custom properties (--color-bg through --lane-7) forced on, no OS media query
- Created src/lib/types.ts with all 11 DTO TypeScript interfaces mirroring Rust structs
- Created src/lib/invoke.ts with safeInvoke<T> that parses Tauri string rejections into TrunkError
- bun run build exits 0 with vite v6 output, no SvelteKit references

## Task Commits

Each task was committed atomically:

1. **Task 1: Migrate from SvelteKit to plain Vite+Svelte** - `0440423` (feat)
2. **Task 2: Tailwind v4 dark theme + TypeScript primitives** - `f70c2b6` (feat)

**Plan metadata:** (pending final commit)

## Files Created/Modified
- `vite.config.ts` - Vite config with svelte() + tailwindcss() plugins and Tauri dev server settings
- `index.html` - Plain HTML Vite entry point (no SvelteKit %sveltekit.*% placeholders)
- `src/main.ts` - Svelte 5 mount() entry point, imports App.svelte and app.css
- `src/App.svelte` - Root component placeholder with dark theme
- `src/app.css` - Tailwind v4 @import with all CSS custom property tokens
- `src/lib/types.ts` - All 11 DTO interfaces: GraphCommit, GraphEdge, RefLabel, BranchInfo, RefsResponse, WorkingTreeStatus, FileStatus, FileDiff, DiffHunk, DiffLine, CommitDetail
- `src/lib/invoke.ts` - safeInvoke<T> wrapper and TrunkError interface
- `tsconfig.json` - Standalone config (no .svelte-kit extension), $lib path alias
- `package.json` - Updated scripts (no svelte-kit sync), updated deps

## Decisions Made
- Used `@sveltejs/vite-plugin-svelte` directly instead of SvelteKit adapter — desktop app needs no routing or SSR
- Tailwind v4 `@import "tailwindcss"` syntax (not v3 `@tailwind` directives)
- Forced dark theme via CSS custom properties — no OS media query toggle as specified in PRD
- `safeInvoke<T>` wrapper prevents silent error swallowing (Tauri errors arrive as raw strings)
- TypeScript string literal unions instead of TS enums — matches serde default serialization naturally

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created src/app.css during Task 1 to unblock build**
- **Found during:** Task 1 (Migrate from SvelteKit to plain Vite+Svelte)
- **Issue:** src/main.ts (created in Task 1) imports "./app.css" which was a Task 2 file — build failed with "Could not resolve ./app.css"
- **Fix:** Created src/app.css with full Tailwind v4 content (the complete Task 2 content) during Task 1 to unblock build verification
- **Files modified:** src/app.css
- **Verification:** bun run build exits 0 after creating the file
- **Committed in:** f70c2b6 (Task 2 commit — file staged with Task 2 files)

---

**Total deviations:** 1 auto-fixed (1 blocking issue)
**Impact on plan:** The task ordering in the plan had app.css as Task 2 but main.ts (Task 1) importing it. Creating it in Task 1 was necessary for build verification — no scope change, just ordering adjustment.

## Issues Encountered
- Task 1 build verification initially failed because src/app.css didn't exist yet (imported by src/main.ts). Applied Rule 3 auto-fix to create the file. No further issues.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Frontend foundation complete: Vite+Svelte SPA builds successfully
- All TypeScript DTO interfaces defined — ready for Rust struct implementations in Plan 02
- safeInvoke<T> ready — all future Tauri IPC calls use this wrapper
- CSS custom property tokens defined — all UI components use these for theming
- Plan 02 (Rust foundation) is ready to begin: Cargo.toml changes already applied (pre-existing working tree changes)

## Self-Check: PASSED

All created files verified to exist on disk. All task commits verified in git log.

---
*Phase: 01-foundation*
*Completed: 2026-03-03*
