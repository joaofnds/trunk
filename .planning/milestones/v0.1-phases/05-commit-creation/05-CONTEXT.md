# Phase 5: Commit Creation - Context

**Gathered:** 2026-03-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a commit form to the bottom of the existing StagingPanel. Users can create commits with a subject and optional body, amend the most recent commit (message or staged changes), with validation and immediate graph feedback. Diff display and hunk-level staging are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Commit form placement
- Form lives inside StagingPanel.svelte, pinned at the bottom below a permanent divider
- Unstaged + staged file sections use overflow scroll; commit form is always visible without scrolling
- Form is a separate CommitForm.svelte component (not inlined in StagingPanel) — consistent with Phase 3/4 component extraction pattern
- Body field (optional description) is always visible — no toggle or expand/collapse
- Form shares the existing 240px StagingPanel column; no layout restructuring needed

### Amend mode UX
- Checkbox labeled "Amend previous commit" in the form (below the body field, above the commit button)
- When the checkbox is checked: subject and body fields pre-populate with the most recent commit's message
- Amend message-only is allowed — staging area can be empty in amend mode (COMIT-03 explicitly covers "updating its message")
- When unchecked: fields revert to empty (or retain any edits the user made before toggling)

### Validation feedback
- Errors shown on submit attempt only (not real-time while typing)
- Subject empty: inline red/warning text below the subject field
- Staging area empty (non-amend mode): inline warning near the commit button
- Commit button is always enabled; validation runs on click and blocks submission if invalid
- Errors clear on the next successful submit or when the user modifies the relevant field

### Post-commit state reset
- On success: subject and body fields clear, amend checkbox unchecks, staging panel refreshes
- Silent reset — no toast, no success banner, no green flash
- Commit button shows a loading/disabled state during the async invoke (prevents double-submit; consistent with file row loading pattern from Phase 4)
- Graph refresh: Rust's create_commit command emits the existing `repo-changed` event after success; App.svelte adds a `listen("repo-changed", ...)` handler to bump `graphKey`; StagingPanel auto-refreshes via its existing `repo-changed` listener

### Claude's Discretion
- Exact form padding/spacing inside the 240px column
- Subject textarea vs single-line input (single-line input likely appropriate given narrow width)
- Body textarea row count
- Exact loading indicator style on the commit button during in-flight invoke
- Error text color and icon (red text, warning icon — consistent with existing muted/accent color palette)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/StagingPanel.svelte`: Form mounts at the bottom of this component; already has `repoPath` prop, `loadStatus()`, and `repo-changed` listener
- `src/lib/invoke.ts`: `safeInvoke<T>` ready for all commit commands
- `src/lib/types.ts`: Existing types available; may need to add `CommitInfo` DTO for amend pre-population (fetch last commit subject/body)
- `src-tauri/src/commands/commit.rs`: Stub file ready for `create_commit` and `amend_commit` implementations
- `src/App.svelte`: `handleRefresh()` function exists and bumps `graphKey` — needs a `repo-changed` listener added to call it after commits

### Established Patterns
- Svelte 5 runes: `$state`, `$props`, `$derived` throughout; no stores unless cross-component sharing needed
- CSS custom properties: `--color-accent`, `--color-surface`, `--color-text-muted`, `--color-border`, `--color-text`
- All git2 ops in Rust use `spawn_blocking` (Repository not Sync)
- `safeInvoke<T>` for all IPC; TrunkError `{ code, message }` — frontend matches on `code` string
- Row loading pattern (Phase 4): `loadingFiles` Set with immutable update pattern; muted color on in-flight rows
- Component extraction: FileRow, BranchRow, RefPill — each operation is its own component

### Integration Points
- `src/App.svelte`: Add `listen("repo-changed", handler)` to call `handleRefresh()` — same event StagingPanel already listens to
- `StagingPanel.svelte`: Import and mount `CommitForm` at the bottom; pass `repoPath` prop
- `src-tauri/src/commands/commit.rs`: Implement `create_commit` and `amend_commit`; both emit `app.emit("repo-changed", path)` on success
- `src-tauri/src/lib.rs` `generate_handler![]`: Register commit commands here
- Amend pre-population: needs a `get_head_commit_message` (or similar) command to fetch last commit subject+body when amend checkbox is toggled

</code_context>

<specifics>
## Specific Ideas

- Amend pre-population fires when the checkbox is checked — fetches last commit message via a Tauri invoke and populates the fields
- The `repo-changed` event reuse keeps the event surface small; App.svelte becomes the single place that refreshes the graph on any repo state change (watcher debounce or explicit commit)

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-commit-creation*
*Context gathered: 2026-03-05*
