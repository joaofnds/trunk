# Requirements: Trunk

**Defined:** 2026-03-03
**Core Value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits — all without touching the terminal.

## v1 Requirements

Requirements for v0.1. Each maps to a roadmap phase.

### Infrastructure (Foundation)

- [ ] **INFRA-01**: Project uses plain Vite+Svelte (not SvelteKit) as the frontend framework
- [ ] **INFRA-02**: Rust backend includes git2 = "0.19", notify = "7", notify-debouncer-mini = "0.5", and tauri-plugin-dialog = "2" in Cargo.toml, and `cargo build` passes
- [ ] **INFRA-03**: Rust backend has `error.rs` (TrunkError with code/message, serializable), `state.rs` (path-keyed repository registry with Mutex), and `git/types.rs` (all serializable DTO structs) scaffolded before any git2 logic is written
- [ ] **INFRA-04**: Frontend uses Tailwind CSS v4 with `@tailwindcss/vite` plugin and a dark theme defined via CSS custom properties

### Repository

- [ ] **REPO-01**: User can open a Git repository via native file dialog; repository is validated with git2, stored in managed state, and filesystem watcher is started
- [ ] **REPO-02**: User can close a repository, stopping its filesystem watcher and releasing its managed state
- [ ] **REPO-03**: App remembers recently opened repositories and presents them for quick access across sessions

### Commit Graph

- [ ] **GRAPH-01**: User can view paginated commit history (200 commits per batch) with infinite scroll that fetches the next batch when approaching the end
- [ ] **GRAPH-02**: User can see a visual lane graph rendered as inline SVG per row, with correct topology showing forks, merges, and continuations across all scroll positions
- [ ] **GRAPH-03**: User can see branch, tag, and stash labels displayed inline on the commits they point to
- [ ] **GRAPH-04**: User can visually distinguish merge commits from regular commits via a larger dot with a ring stroke

### Branches

- [ ] **BRNCH-01**: User can see all local branches, remote branches, tags, and stashes in collapsible sidebar sections with the active branch highlighted
- [ ] **BRNCH-02**: User can filter the branch list by typing a search string; filtering happens on the frontend without a round-trip to Rust
- [ ] **BRNCH-03**: User can checkout a local branch; if the working tree is dirty, an inline error banner appears with instructions and the branch does not switch
- [ ] **BRNCH-04**: User can create a new local branch, optionally from a specific commit OID

### Staging

- [ ] **STAGE-01**: User can see the current working tree status with files split into distinct unstaged and staged lists, including file status type (New, Modified, Deleted, Renamed, Typechange, Conflicted)
- [ ] **STAGE-02**: User can stage or unstage individual files (whole-file only; no hunk-level staging in v0.1)
- [ ] **STAGE-03**: User can stage all unstaged files at once and unstage all staged files at once with dedicated buttons
- [ ] **STAGE-04**: Working tree status refreshes automatically when external tools modify repository files, via filesystem watcher with 300ms debounce

### Commit

- [ ] **COMIT-01**: User can create a commit with a subject line and optional description body; author identity is read from gitconfig via `repo.signature()`
- [ ] **COMIT-02**: App refuses to create a commit if the subject is empty or the staging area is empty, with a visible validation message
- [ ] **COMIT-03**: User can amend the most recent commit, updating its message or adding currently staged changes to it

### Diffs

- [ ] **DIFF-01**: User can view a unified diff for an unstaged file by clicking it in the unstaged list (index vs working directory)
- [ ] **DIFF-02**: User can view a unified diff for a staged file by clicking it in the staged list (HEAD vs index)
- [ ] **DIFF-03**: User can view all file diffs for a historical commit by clicking it in the commit graph (commit vs its first parent, or vs empty tree for root commits)
- [ ] **DIFF-04**: User can see full commit metadata (full OID, short OID, author name/email, timestamp, committer if different, full message body) above the diff when a commit is selected

## v2 Requirements

Deferred to future releases. Acknowledged but not in current roadmap.

### Staging

- **STAGE-V2-01**: User can stage or unstage individual hunks within a file (hunk-level staging)
- **STAGE-V2-02**: User can view an inline diff within the staging panel before deciding to stage

### Remote Operations

- **REMOT-V2-01**: User can push current branch to its upstream remote
- **REMOT-V2-02**: User can pull (fetch + merge/rebase) from upstream remote
- **REMOT-V2-03**: User can fetch all remotes without merging

### Working Tree

- **WORK-V2-01**: User can discard all changes to a file (revert to HEAD)
- **WORK-V2-02**: User can create a stash from current changes
- **WORK-V2-03**: User can pop/apply a stash from the stash list

### History

- **HIST-V2-01**: User can amend the most recent commit message or add staged changes to it
- **HIST-V2-02**: User can search/filter commit history by message or author

### UI

- **UI-V2-01**: User can resize sidebar and right panel by dragging splitters
- **UI-V2-02**: User can use keyboard shortcuts for common operations (stage, commit, checkout)

## Out of Scope

Explicitly excluded from v0.1. Prevents scope creep.

| Feature | Reason |
|---------|--------|
| Push / Pull / Fetch | SSH/HTTPS auth is a deep complexity trap; explicitly deferred to v0.2 |
| Merge / Rebase / Cherry-pick | High correctness bar; deferred to v0.3 |
| Conflict resolution UI | Requires merge support; deferred to v0.3+ |
| Stash create/pop | Stashes listed read-only in v0.1 sidebar; create/pop deferred to v0.2 |
| Hunk-level staging | Whole-file only in v0.1; complexity deferred to v0.2 |
| Syntax highlighting in diffs | Aspirational; deferred to v0.3 |
| Resizable panels | Fixed proportions in v0.1; resizable splitters in v0.2 |
| Keyboard shortcuts | Deferred to v0.2 |
| Multi-repo functional tabs | Tab bar visible but non-functional in v0.1; functional in v0.3 |
| Settings/preferences UI | Deferred to v1.0 |
| Commit signing | Deferred to v1.0 |
| Auto-update | Deferred to v1.0 |
| tauri-specta TypeScript codegen | Manual types for v0.1; adopt after API surface stabilizes |
| Mobile / web versions | Desktop only |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Pending |
| INFRA-02 | Phase 1 | Pending |
| INFRA-03 | Phase 1 | Pending |
| INFRA-04 | Phase 1 | Pending |
| REPO-01 | Phase 2 | Pending |
| REPO-02 | Phase 2 | Pending |
| REPO-03 | Phase 2 | Pending |
| GRAPH-01 | Phase 2 | Pending |
| GRAPH-02 | Phase 2 | Pending |
| GRAPH-03 | Phase 2 | Pending |
| GRAPH-04 | Phase 2 | Pending |
| BRNCH-01 | Phase 3 | Pending |
| BRNCH-02 | Phase 3 | Pending |
| BRNCH-03 | Phase 3 | Pending |
| BRNCH-04 | Phase 3 | Pending |
| STAGE-01 | Phase 4 | Pending |
| STAGE-02 | Phase 4 | Pending |
| STAGE-03 | Phase 4 | Pending |
| STAGE-04 | Phase 4 | Pending |
| COMIT-01 | Phase 5 | Pending |
| COMIT-02 | Phase 5 | Pending |
| COMIT-03 | Phase 5 | Pending |
| DIFF-01 | Phase 6 | Pending |
| DIFF-02 | Phase 6 | Pending |
| DIFF-03 | Phase 6 | Pending |
| DIFF-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-03*
*Last updated: 2026-03-03 after initial definition*
