# Phase 1: Foundation - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Remove SvelteKit and configure the project as a plain Vite+Svelte SPA. Add all required Rust crate dependencies. Scaffold the shared Rust primitives that every subsequent module depends on: `error.rs`, `state.rs`, `git/types.rs`. Wire Tailwind CSS v4 with a dark theme. No user-visible git features in this phase — this is infrastructure only.

</domain>

<decisions>
## Implementation Decisions

### SvelteKit Migration
- Remove SvelteKit entirely: delete `svelte.config.js`, `src/routes/+layout.ts`, `src/app.html`, `.svelte-kit/`
- Replace with plain Vite+Svelte: `vite.config.ts` uses `@sveltejs/vite-plugin-svelte` directly (no kit adapter)
- New entry: `index.html` at project root + `src/main.ts` + `src/App.svelte`
- Keep `svelte-check` for type checking; remove `svelte-kit sync` from scripts
- The existing `+page.svelte` greet example can be ported to `App.svelte` temporarily, then deleted in Phase 2

### Rust Dependencies
- Add to `Cargo.toml`: `git2 = "0.19"`, `notify = "7"`, `notify-debouncer-mini = "0.5"`, `tauri-plugin-dialog = "2"`
- Remove `tauri-plugin-opener` (not needed for this project; was scaffold default)
- Add Tauri 2 capability file: `src-tauri/capabilities/default.json` with `dialog:allow-open` permission

### Rust Module Structure
- Scaffold ALL modules from PRD now (empty stubs where not yet needed), so the full structure is in place:
  - `src-tauri/src/error.rs` — `TrunkError { code: String, message: String }` implementing `serde::Serialize` and `From<git2::Error>`
  - `src-tauri/src/state.rs` — `RepoState(Mutex<HashMap<String, PathBuf>>)` — stores paths only, NOT Repository handles (critical for thread safety)
  - `src-tauri/src/git/mod.rs`, `git/types.rs`, `git/repository.rs`, `git/graph.rs`
  - `src-tauri/src/commands/mod.rs` + empty stubs: `repo.rs`, `history.rs`, `branches.rs`, `staging.rs`, `commit.rs`, `diff.rs`
  - `src-tauri/src/watcher.rs` — stub only
  - Update `lib.rs` to declare all modules; register no commands yet (just proves it compiles)

### TypeScript DTO Types
- Create `src/lib/types.ts` with ALL 10 Rust DTO types from the PRD upfront:
  - `GraphCommit`, `GraphEdge`, `RefLabel`, `BranchInfo`, `RefsResponse`
  - `WorkingTreeStatus`, `FileStatus`, `FileDiff`, `DiffHunk`, `DiffLine`, `CommitDetail`
  - Use TypeScript string literal unions for enums (e.g., `type EdgeType = 'Straight' | 'MergeLeft' | 'MergeRight' | 'ForkLeft' | 'ForkRight'`) — avoids TS enum verbosity, matches serde serialization naturally

### TypeScript Invoke Wrapper
- Create `src/lib/invoke.ts` with a typed `safeInvoke<T>` wrapper
- Tauri IPC errors arrive as raw strings (not Error objects) — `catch(e) { e.message }` returns `undefined`
- Wrapper parses the raw string into `TrunkError { code: string, message: string }`
- All Tauri commands in subsequent phases use `safeInvoke` exclusively — never raw `invoke`

### CSS / Theme Architecture
- Forced dark theme (not OS-preference toggle) per PRD: "dark theme by default"
- CSS custom properties defined in `src/app.css` (global file imported in `main.ts`):
  - Color palette: `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-accent`
  - Graph lane colors as CSS custom properties: `--lane-0` through `--lane-7`
  - Typography: `--font-mono` (for graph/diffs), `--font-sans` (elsewhere)
- Tailwind v4 setup: `@tailwindcss/vite` plugin in `vite.config.ts`, `@import "tailwindcss"` in `app.css`
- No `tailwind.config.js` needed (Tailwind v4 auto-detects)
- `body` gets `background-color: var(--color-bg); color: var(--color-text)` — dark by default, no media query needed

### Claude's Discretion
- Exact color values for the dark theme palette (neutral dark grays; accent blue)
- Whether to use `app.css` or `src/styles/theme.css` — structure within the convention
- `safeInvoke` error message fallback text when parsing fails

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/routes/+page.svelte`: Already uses `$state` runes and `import { invoke } from "@tauri-apps/api/core"` (correct Tauri 2 path). The greet function pattern can inform how `safeInvoke` is called.
- `lib.rs`: Clean slate. The `greet` command registration pattern shows how `tauri::generate_handler!` works — useful reference for Phase 2 when real commands are registered.

### Established Patterns
- Tauri 2 `invoke` import path is `@tauri-apps/api/core` (already correct in scaffold) — NOT `@tauri-apps/api/tauri` (Tauri 1 path)
- `serde = { version = "1", features = ["derive"] }` already in `Cargo.toml` — all DTO structs can use `#[derive(Serialize, Clone)]` immediately
- `serde_json` already present

### Integration Points
- `lib.rs`'s `run()` function is where `tauri::Builder` is configured — all plugins, state, and command handlers register here
- `Cargo.toml` `[dependencies]` block needs the 4 new crates added
- `src-tauri/capabilities/` directory does not exist yet — needs creating with `default.json`
- `vite.config.ts` does not exist yet (SvelteKit used `svelte.config.js`) — needs creating for plain Vite+Svelte

</code_context>

<specifics>
## Specific Ideas

- PITFALLS.md critical warning: `Repository` is not `Sync` — state must store `PathBuf` only, never `Repository` handles. This is already captured in the state.rs decision above.
- PITFALLS.md critical warning: git2 types carry repo lifetimes (`Commit<'repo>`, `Diff<'repo>`) — ALL DTO structs must be owned types defined in `git/types.rs` before any git2 code is written. This is why `git/types.rs` is in Phase 1.
- PITFALLS.md: `safeInvoke` wrapper is explicitly called out as a Day 1 requirement to prevent silent error swallowing.
- PRD specifies exact DTO structure — `types.ts` should mirror it precisely to avoid type drift.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-03-03*
