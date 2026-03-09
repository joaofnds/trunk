# Phase 4: Working Tree + Staging - Context

**Gathered:** 2026-03-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Add the staging panel to the right side of the 3-pane layout (branch sidebar | commit graph | staging panel). Users can see real-time unstaged and staged file lists, move files between them individually or all-at-once, and the panel updates automatically when external tools modify the repository. Diffs, commit form, and discard actions are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Panel layout
- Vertical split: "Unstaged Files (N)" section on top, "Staged Files (N)" section below
- Both sections are collapsible (▼ chevron), always visible simultaneously
- "Unstaged Files" header: count + "Stage All Changes" button on the right
- "Staged Files" header: count + "Unstage All" button on the right (symmetric to Stage All)
- Panel header shows: total file change count + current branch pill (e.g. "5 file changes on main")
- Panel width: Claude's discretion (fixed, not resizable in v0.1; roughly symmetric with branch sidebar width)

### File row interaction
- **Dedicated icon button on hover** (not whole-row click): a small icon (e.g. `+` or `→`) appears when hovering a row; clicking it stages/unstages the file
- Row itself does not trigger staging on click — only the hover icon button does
- Loading state during the async invoke: muted color or spinner on the row while the operation runs

### File status icons
- Status shown as a colored icon/symbol to the left of the filename (not a text badge)
- **New**: green `+`
- **Modified**: orange pencil icon
- **Deleted**: red `−`
- **Renamed**: blue `→`
- **Typechange / Conflicted**: Claude's discretion (pick colors consistent with the above set)
- Filename shown as-is; for files in subdirectories, show the relative path

### Auto-refresh on external change
- When the filesystem watcher fires, the panel updates **silently** — new `WorkingTreeStatus` is fetched and swapped in with no loading indicator
- No flash, no spinner — same as VS Code source control panel behavior
- Watcher uses Tauri event system: Rust emits a named event after debounce; Svelte `listen`s and re-fetches status

### Empty state
- When working tree is clean, **both section headers remain visible**: "Unstaged Files (0)" and "Staged Files (0)"
- Lists are empty underneath — no centered message, no illustration
- Consistent with how the branch sidebar handles empty sections (hidden if truly empty, but staging sections always show even at 0)

### Claude's Discretion
- Exact panel width (roughly symmetric with branch sidebar)
- Typechange and Conflicted icon colors (consistent with the green/orange/red/blue set)
- Hover icon button design (exact icon, size, padding)
- Loading indicator style on row during staging operation
- Whether to show the branch pill in the panel header as a `RefPill` or plain styled text

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/BranchSection.svelte`: Section header with count, collapsible chevron, optional action button — directly reusable or adaptable for Unstaged/Staged section headers
- `src/components/BranchRow.svelte`: 26px rows, hover background (`--color-surface`), loading state (muted color + "…"), error banner pattern — good reference for file rows
- `src/components/RefPill.svelte`: Branch pill styling — reusable for the branch name pill in the panel header
- `src/lib/types.ts`: `WorkingTreeStatus`, `FileStatus`, `FileStatusType` fully defined — no DTO work needed
- `src/lib/invoke.ts`: `safeInvoke<T>` ready — all staging commands use it

### Established Patterns
- Svelte 5 runes: `$state`, `$props`, `$derived` throughout; no stores unless cross-component sharing needed
- CSS custom properties: `--color-accent` (accent blue), `--color-surface` (hover), `--color-text-muted`, `--color-border`
- All git2 ops in Rust use `spawn_blocking` (Repository not Sync)
- TrunkError `{ code, message }` — frontend matches on `code` string never message text
- Row height: 26px (established in Phase 3)

### Integration Points
- `src/App.svelte`: Comment `<!-- Phase 4 adds StagingPanel here -->` already in the right slot of the 3-pane layout
- `src-tauri/src/commands/staging.rs`: Stub ready for `get_status`, `stage_file`, `unstage_file`, `stage_all`, `unstage_all` commands
- `src-tauri/src/watcher.rs`: Stub ready — `notify` + `notify-debouncer-mini` at 300ms debounce (already in Cargo.toml per INFRA-02); must emit a Tauri event to the frontend on change
- `lib.rs` `generate_handler![]`: New staging commands registered here
- Tauri event system: `app.emit("repo-changed", path)` in Rust → `listen("repo-changed", handler)` in Svelte

</code_context>

<specifics>
## Specific Ideas

- Reference image provided (right-panel-goal.png): shows the target layout clearly — unstaged on top with "Stage All Changes" button, staged below, collapsible sections, colored status icons (green + for New, orange pencil for Modified)
- The commit form visible at the bottom of the reference image is **Phase 5 scope** — not built in Phase 4
- File status icons should be colored symbols (not text), matching the visual style from the reference image

</specifics>

<deferred>
## Deferred Ideas

- ↑↓ Sort button (visible in reference image) — v2 feature, not in STAGE requirements
- Path/Tree view toggle (visible in reference image) — v2 feature, not in STAGE requirements
- Red discard-all trash button (visible in reference image) — WORK-V2-01, explicitly deferred to v0.2 per PROJECT.md
- Discard changes on individual files — WORK-V2-01, deferred to v0.2
- Inline diff preview in staging panel — STAGE-V2-02, deferred to v0.2

</deferred>

---

*Phase: 04-working-tree-staging*
*Context gathered: 2026-03-05*
