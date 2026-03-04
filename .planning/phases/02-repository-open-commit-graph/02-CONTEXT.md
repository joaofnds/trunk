# Phase 2: Repository Open + Commit Graph - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Open a local Git repository via a native file picker and display its full commit history as a scrollable visual lane graph. Includes repository lifecycle (open, close, recent repos) and the complete commit graph UI with virtual scrolling, inline SVG lanes, and ref labels. Branch sidebar and staging panel are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Welcome state & empty state
- Minimal welcome screen: centered "Open Repository" button with recent repos list below it
- 5 most recent repositories remembered and shown for quick re-open
- Welcome screen persists until a repo is opened; reappears when a repo is closed
- Recent repos stored across app restarts (persistent, not in-memory)

### Repo lifecycle (open / close / switch)
- Tab bar with a single tab showing the open repo name; an X button closes the repo and returns to the welcome screen
- Tab bar layout is in place for multi-tab support in v0.2+ but only one tab is functional in this phase
- Opening another repo from the welcome screen replaces the current tab (no parallel open repos in v0.1)
- No explicit "switch" — user closes the current tab and opens another

### Layout — Phase 2 scope
- Graph only: full-width commit graph with no sidebar or right panel stubs in this phase
- Sidebar (branches) added in Phase 3; staging panel added in Phase 4
- The final 3-pane layout (branch sidebar | graph | staging panel) matches the ui-goal.png reference

### Commit row layout
- Columns (left to right): **ref labels | lane graph | commit message**
- Row height: 24–28px; font size: 12–13px
- Column layout is designed to be configurable in the finished product (like GitKraken column picker), but MVP ships only these 3 columns with no configuration UI
- No separate author, date, or hash columns in Phase 2

### Ref label styling
- Labels appear as small rounded pill badges to the left of the lane graph
- **Local branches**: green pill
- **Remote branches**: muted gray/blue-gray pill
- **HEAD (active branch)**: accent blue pill + bold text — visually distinct from other local branches
- **Tags**: same pill style as local branches but with a tag icon (🏷 or ◆) prefix; no separate color needed
- **Stashes**: shown with a stash icon prefix; muted color
- Only the **first ref label** is shown per commit; if there are more, show **+N** as a muted indicator
- Hovering the **+N** indicator shows a tooltip listing all hidden labels
- **Merge commits**: larger dot (vs regular commit dot) with a contrasting ring/stroke — satisfies GRAPH-04

### Scroll & loading
- **Trigger point**: next 200-commit batch loads when 50 rows remain in the loaded set
- **Initial load**: skeleton placeholder rows fill the viewport while the first batch loads from Rust
- **Mid-scroll loading**: skeleton rows appear at the bottom of the list while the next batch fetches
- **End of history**: list ends at the root commit with no special indicator — no "End of history" message
- **Initial load error**: inline error banner in the graph area with the TrunkError message; user stays on welcome screen
- **Mid-scroll page load error**: skeleton rows replaced by an error indicator + "Retry" button at the bottom of the loaded commits

### Claude's Discretion
- Exact pixel sizes for regular vs merge commit dots and ring stroke width
- Tag and stash icon choice (🏷, ◆, or SVG icon)
- Exact skeleton animation style (pulse, shimmer, etc.)
- Tooltip styling for the +N overflow indicator
- Recent repos persistence mechanism (Tauri store plugin, or write to a JSON file in app data dir)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/types.ts`: All DTO interfaces already defined — `GraphCommit`, `GraphEdge`, `RefLabel`, `RefType`, `EdgeType`. No type work needed in Phase 2.
- `src/lib/invoke.ts`: `safeInvoke<T>` wrapper ready — all Tauri commands in this phase use it exclusively.
- `src-tauri/src/git/types.rs`: Matching Rust DTO structs fully scaffolded — `GraphCommit`, `GraphEdge`, `RefLabel`, `EdgeType`.
- `src-tauri/src/state.rs`: `RepoState(Mutex<HashMap<String, PathBuf>>)` in place — stores paths only, opens fresh `Repository` per command.
- `src-tauri/src/commands/repo.rs`: Stub ready for repo open/close commands.
- `src-tauri/src/commands/history.rs`: Stub ready for graph/history commands.
- `src-tauri/src/git/repository.rs` and `git/graph.rs`: Stubs ready for git2 logic.
- `src-tauri/src/watcher.rs`: Stub in place (used in Phase 4, not Phase 2).

### Established Patterns
- All IPC errors use `TrunkError { code: String, message: String }` — frontend matches on `code` string, never message text.
- `spawn_blocking` required for all git2 operations — `Repository` is not `Sync`.
- Forced dark theme via CSS custom properties (`--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-accent`, `--lane-0` through `--lane-7`).
- Tailwind v4 utility classes + CSS custom properties — both available for component styling.
- `App.svelte` currently shows a placeholder status string; Phase 2 replaces it with the real app shell.

### Integration Points
- `lib.rs` `run()`: Register new Tauri commands here via `tauri::generate_handler![]`.
- `src-tauri/capabilities/default.json`: `dialog:allow-open` permission already granted (Phase 1).
- `GraphCommit.column` and `GraphCommit.edges` carry pre-computed layout from Rust — SVG rendering just reads these values; no layout algorithm in the frontend.
- Lane colors map to CSS custom properties `--lane-0` through `--lane-7` by `color_index`.

</code_context>

<specifics>
## Specific Ideas

- **Visual reference**: `ui-goal.png` in the project root shows the target layout — 3-pane layout (branch sidebar | commit graph | staging panel). Phase 2 delivers the center commit graph panel only; other panels added in later phases.
- Column layout is intentionally designed for future configurability (like GitKraken's column picker) — but v0.1 ships the fixed 3-column layout with no settings UI.
- The graph lane algorithm (O(n), ~5ms for 10k commits) runs entirely in Rust; Svelte reads `column` and `edges` from each `GraphCommit` and renders inline SVG — no layout math on the frontend.
- STATE.md note: "Virtual scroll + SVG lane rendering is the most complex UI component; research spike recommended before coding begins" — researcher should investigate virtual scroll strategies (custom vs library like svelte-virtual-list) and inline SVG coordinate calculation patterns.

</specifics>

<deferred>
## Deferred Ideas

- Configurable column picker (show/hide author, date, hash columns) — v0.2+ feature, mentioned during discussion as the eventual goal like GitKraken
- Multi-tab repo support — tab bar is laid out in v0.1 but multi-tab is a v0.2 feature per PROJECT.md
- Keyboard navigation in the commit graph (arrow keys to move between commits) — deferred to v0.2

</deferred>

---

*Phase: 02-repository-open-commit-graph*
*Context gathered: 2026-03-03*
