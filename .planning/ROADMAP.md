# Roadmap: Trunk

## Overview

Trunk is built in strict dependency order: the foundation layer establishes the scaffold and shared primitives that every Rust command and Svelte component depends on, then repository open and the commit graph deliver the app's primary value proposition, then branch navigation and staging complete the daily-use workflow, and finally commit creation and diff display close the read-write loop. All 26 v1 requirements ship across 6 phases. Nothing is deferred from v0.1 scope.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Migrate scaffold to Vite+Svelte, wire Rust dependencies, scaffold error/state/DTO types, and configure Tailwind (completed 2026-03-03)
- [ ] **Phase 2: Repository Open + Commit Graph** - Open a repo via native file picker and render a scrollable, topologically correct visual commit graph
- [ ] **Phase 3: Branch Sidebar + Checkout** - List all branches/tags/stashes in sidebar and support branch checkout with dirty-workdir error handling
- [ ] **Phase 4: Working Tree + Staging** - Show live working tree status and support whole-file stage/unstage with auto-refresh via filesystem watcher
- [ ] **Phase 5: Commit Creation** - Create commits (and amend) with subject + body, with validation and immediate graph feedback
- [ ] **Phase 6: Diff Display** - Show unified diffs for workdir files, staged files, and historical commits with full commit metadata

## Phase Details

### Phase 1: Foundation
**Goal**: The scaffold is migrated to plain Vite+Svelte, all Rust dependencies are present and build, and the shared primitives (error type, state registry, DTO structs, Tailwind theme) are in place before any feature code is written
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04
**Success Criteria** (what must be TRUE):
  1. `bun run dev` launches the app as a plain Vite+Svelte SPA with no SvelteKit routes, adapters, or generated files
  2. `cargo build` passes with git2, notify, notify-debouncer-mini, and tauri-plugin-dialog present in Cargo.toml
  3. `error.rs` (TrunkError with code/message), `state.rs` (path-keyed repository registry), and `git/types.rs` (all serializable DTO structs) exist and compile
  4. The app renders with a dark theme defined via CSS custom properties; Tailwind v4 utility classes apply correctly in the browser
**Plans**: 3 plans

Plans:
- [ ] 01-01-PLAN.md — Frontend migration: SvelteKit to plain Vite+Svelte + Tailwind v4 dark theme + TypeScript DTO types + safeInvoke wrapper
- [ ] 01-02-PLAN.md — Rust scaffolding: crate dependencies + full module stub tree + error.rs + state.rs + git/types.rs
- [ ] 01-03-PLAN.md — Integration verification: automated build checks + visual dark theme confirmation

### Phase 2: Repository Open + Commit Graph
**Goal**: A developer can open any local Git repository via a native file picker and immediately see its full commit history as a scrollable visual lane graph
**Depends on**: Phase 1
**Requirements**: REPO-01, REPO-02, REPO-03, GRAPH-01, GRAPH-02, GRAPH-03, GRAPH-04
**Success Criteria** (what must be TRUE):
  1. Clicking "Open Repository" triggers the native OS file dialog; selecting a valid Git repo loads it and displays the commit graph
  2. The commit graph paginates in batches of 200 and loads the next batch automatically as the user scrolls toward the end
  3. Lane topology is correct across all scroll positions: forks, merges, and continuations render without visual errors for repos with thousands of commits
  4. Branch, tag, and stash labels appear inline on the commits they point to; merge commits are visually distinct (larger dot with ring stroke)
  5. Recently opened repositories are remembered and presented for quick re-open across app restarts
**Plans**: 6 plans

Plans:
- [ ] 02-01-PLAN.md — Rust test scaffolds: failing unit test stubs for repo commands, graph algorithm, and ref map helpers
- [ ] 02-02-PLAN.md — Dependency gate: install tauri-plugin-store + @humanspeak/svelte-virtual-list + register store plugin in lib.rs
- [ ] 02-03-PLAN.md — Rust backend: git/repository.rs helpers + git/graph.rs lane algorithm + commands/repo.rs + commands/history.rs (all tests green)
- [ ] 02-04-PLAN.md — Frontend shell: store.ts (recent repos) + WelcomeScreen.svelte + TabBar.svelte + App.svelte app shell
- [ ] 02-05-PLAN.md — Frontend graph components: CommitGraph.svelte + CommitRow.svelte + LaneSvg.svelte + RefPill.svelte
- [ ] 02-06-PLAN.md — Wire and verify: register commands in lib.rs + mount CommitGraph in App.svelte + visual verification checkpoint

### Phase 3: Branch Sidebar + Checkout
**Goal**: A developer can see the full branch/tag/stash structure of the open repository in a sidebar and switch branches safely, with a visible error when the working tree is dirty
**Depends on**: Phase 2
**Requirements**: BRNCH-01, BRNCH-02, BRNCH-03, BRNCH-04
**Success Criteria** (what must be TRUE):
  1. The sidebar lists all local branches, remote branches, tags, and stashes in collapsible sections; the active branch is highlighted
  2. Typing in a search field filters the branch list immediately without a round-trip to the backend
  3. Clicking a branch checks it out; if the working tree is dirty, an inline error banner appears and the branch does not switch
  4. User can create a new local branch, optionally from a specific commit OID, and it appears immediately in the sidebar
**Plans**: 3 plans

Plans:
- [ ] 03-01-PLAN.md — Rust backend (TDD): branches.rs with list_refs, checkout_branch, create_branch + 7 unit tests
- [ ] 03-02-PLAN.md — Svelte sidebar components: BranchSidebar + BranchSection + BranchRow + RemoteGroup
- [ ] 03-03-PLAN.md — Wire and verify: register branch commands in lib.rs + 2-pane App.svelte layout + visual verification checkpoint

### Phase 4: Working Tree + Staging
**Goal**: A developer can see the real-time state of staged and unstaged files and move files between the two lists, with the view updating automatically when external tools modify the repository
**Depends on**: Phase 3
**Requirements**: STAGE-01, STAGE-02, STAGE-03, STAGE-04
**Success Criteria** (what must be TRUE):
  1. The staging panel shows two distinct lists — unstaged and staged — each with file status labels (New, Modified, Deleted, Renamed, Typechange, Conflicted)
  2. Clicking a file stages or unstages it (whole-file); dedicated "Stage All" and "Unstage All" buttons act on all files at once
  3. When an external tool (terminal, IDE) modifies repository files, the staging panel refreshes automatically within approximately 300ms without any user action
**Plans**: TBD

### Phase 5: Commit Creation
**Goal**: A developer can complete the write loop by creating a commit from staged changes, with the new commit appearing in the graph immediately
**Depends on**: Phase 4
**Requirements**: COMIT-01, COMIT-02, COMIT-03
**Success Criteria** (what must be TRUE):
  1. Submitting the commit form with a subject line and staged files creates a commit; the new commit appears at the top of the graph immediately
  2. The form refuses to submit and shows a validation message if the subject is empty or the staging area is empty
  3. User can amend the most recent commit, updating its message or adding currently staged changes, and the graph reflects the amended commit
**Plans**: TBD

### Phase 6: Diff Display
**Goal**: A developer can inspect exactly what changed in any file — before staging, after staging, or in any historical commit — by clicking it
**Depends on**: Phase 5
**Requirements**: DIFF-01, DIFF-02, DIFF-03, DIFF-04
**Success Criteria** (what must be TRUE):
  1. Clicking an unstaged file shows the unified diff between the working directory and the index
  2. Clicking a staged file shows the unified diff between HEAD and the index
  3. Clicking a commit in the graph shows the full diff for all files changed in that commit (vs first parent, or vs empty tree for root commits)
  4. When a commit is selected, full metadata (OID, author, timestamp, committer if different, full message body) appears above the diff
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete   | 2026-03-03 |
| 2. Repository Open + Commit Graph | 2/6 | In Progress|  |
| 3. Branch Sidebar + Checkout | 2/3 | In Progress|  |
| 4. Working Tree + Staging | 0/? | Not started | - |
| 5. Commit Creation | 0/? | Not started | - |
| 6. Diff Display | 0/? | Not started | - |
