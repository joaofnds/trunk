# Phase 2: Repository Open + Commit Graph - Research

**Researched:** 2026-03-03
**Domain:** git2 (Rust), Svelte 5 virtual scroll, inline SVG commit graph, Tauri plugin-store, tauri-plugin-dialog
**Confidence:** HIGH (core stack), MEDIUM (graph lane algorithm detail)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Welcome state & empty state**
- Minimal welcome screen: centered "Open Repository" button with recent repos list below it
- 5 most recent repositories remembered and shown for quick re-open
- Welcome screen persists until a repo is opened; reappears when a repo is closed
- Recent repos stored across app restarts (persistent, not in-memory)

**Repo lifecycle (open / close / switch)**
- Tab bar with a single tab showing the open repo name; an X button closes the repo and returns to the welcome screen
- Tab bar layout is in place for multi-tab support in v0.2+ but only one tab is functional in this phase
- Opening another repo from the welcome screen replaces the current tab (no parallel open repos in v0.1)
- No explicit "switch" — user closes the current tab and opens another

**Layout — Phase 2 scope**
- Graph only: full-width commit graph with no sidebar or right panel stubs in this phase
- Sidebar (branches) added in Phase 3; staging panel added in Phase 4
- The final 3-pane layout (branch sidebar | graph | staging panel) matches the ui-goal.png reference

**Commit row layout**
- Columns (left to right): ref labels | lane graph | commit message
- Row height: 24–28px; font size: 12–13px
- Column layout is designed to be configurable in the finished product, but MVP ships only these 3 columns with no configuration UI
- No separate author, date, or hash columns in Phase 2

**Ref label styling**
- Labels appear as small rounded pill badges to the left of the lane graph
- Local branches: green pill
- Remote branches: muted gray/blue-gray pill
- HEAD (active branch): accent blue pill + bold text
- Tags: same pill style as local branches but with a tag icon prefix; no separate color needed
- Stashes: shown with a stash icon prefix; muted color
- Only the first ref label is shown per commit; if there are more, show +N as a muted indicator
- Hovering the +N indicator shows a tooltip listing all hidden labels
- Merge commits: larger dot (vs regular commit dot) with a contrasting ring/stroke

**Scroll & loading**
- Trigger point: next 200-commit batch loads when 50 rows remain in the loaded set
- Initial load: skeleton placeholder rows fill the viewport while the first batch loads from Rust
- Mid-scroll loading: skeleton rows appear at the bottom of the list while the next batch fetches
- End of history: list ends at the root commit with no special indicator
- Initial load error: inline error banner in the graph area with the TrunkError message; user stays on welcome screen
- Mid-scroll page load error: skeleton rows replaced by an error indicator + "Retry" button at the bottom of the loaded commits

### Claude's Discretion
- Exact pixel sizes for regular vs merge commit dots and ring stroke width
- Tag and stash icon choice (🏷, ◆, or SVG icon)
- Exact skeleton animation style (pulse, shimmer, etc.)
- Tooltip styling for the +N overflow indicator
- Recent repos persistence mechanism (Tauri store plugin, or write to a JSON file in app data dir)

### Deferred Ideas (OUT OF SCOPE)
- Configurable column picker (show/hide author, date, hash columns) — v0.2+ feature
- Multi-tab repo support — tab bar is laid out in v0.1 but multi-tab is a v0.2 feature
- Keyboard navigation in the commit graph (arrow keys to move between commits) — deferred to v0.2
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| REPO-01 | User can open a Git repository via native file dialog; repository is validated with git2, stored in managed state, and filesystem watcher is started | tauri-plugin-dialog `open({directory:true})` → Rust command validates with `Repository::open()` → stores PathBuf in `RepoState` Mutex |
| REPO-02 | User can close a repository, stopping its filesystem watcher and releasing its managed state | Rust command removes PathBuf from `RepoState`; watcher stub (Phase 4) is not yet started so no watcher teardown needed in Phase 2 |
| REPO-03 | App remembers recently opened repositories and presents them for quick access across sessions | `tauri-plugin-store` v2 persists JSON to app data dir; JS `LazyStore` reads/writes list of `{name,path}` on open/close |
| GRAPH-01 | User can view paginated commit history (200 commits per batch) with infinite scroll that fetches the next batch when approaching the end | Rust: `revwalk.skip(offset).take(200)` inside `spawn_blocking`; Svelte: `@humanspeak/svelte-virtual-list` with `onLoadMore` callback triggered at 50-items-from-end |
| GRAPH-02 | User can see a visual lane graph rendered as inline SVG per row, with correct topology showing forks, merges, and continuations | Rust graph.rs computes `column` + `edges` per `GraphCommit`; each Svelte row renders an inline `<svg>` reading those pre-computed values |
| GRAPH-03 | User can see branch, tag, and stash labels displayed inline on the commits they point to | `GraphCommit.refs: RefLabel[]` pre-populated in Rust via `references()` + `stash_foreach()`; rendered as pill badges in Svelte |
| GRAPH-04 | User can visually distinguish merge commits from regular commits via a larger dot with a ring stroke | `GraphCommit.is_merge: bool` drives CSS class on the SVG dot: larger circle radius + stroke ring |
</phase_requirements>

---

## Summary

Phase 2 builds two parallel feature surfaces: the Rust backend (Tauri commands for repo open/close/history) and the Svelte frontend (welcome screen, tab bar shell, virtual-scrolling commit graph). The largest complexity lies in the commit graph UI: a virtual list that pages 200-commit batches on scroll while each row renders an inline SVG lane from pre-computed Rust data. The lane algorithm lives entirely in Rust; Svelte only reads `column` and `edges` fields.

The standard stack is well-established: `git2` for all git operations, `tauri-plugin-dialog` (already configured) for the file picker, `tauri-plugin-store` for persisting recent repos, and `@humanspeak/svelte-virtual-list` for virtual scrolling in Svelte 5. All of these have official documentation and clear APIs.

The most research-worthy area — the commit graph lane algorithm — runs entirely in Rust and the data model (`column`, `edges`, `EdgeType`) is already scaffolded. The Svelte side only needs to translate these values into SVG coordinates. The key insight is that the Rust layer is the source of truth for layout; the frontend is a pure render pass.

**Primary recommendation:** Implement Rust graph algorithm first, validate output with unit tests using a synthetic repo, then build the Svelte virtual list and SVG renderer against the verified data contract.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `git2` | 0.19 (already in Cargo.toml) | All git operations: open repo, revwalk, refs, stash | Canonical libgit2 Rust bindings; vendored-libgit2 for static linking |
| `tauri-plugin-dialog` | 2 (already installed) | Native OS file/folder picker | Already configured; `dialog:allow-open` capability already granted |
| `tauri-plugin-store` | 2 | Persistent key-value store for recent repos | Official Tauri plugin; zero custom file I/O needed |
| `@humanspeak/svelte-virtual-list` | latest | Virtual scrolling for 10k+ commit rows | Svelte 5 runes-native; built-in `onLoadMore` / `hasMore` API; MIT |
| Svelte 5 inline SVG | built-in | Per-row lane graph rendering | No extra library needed; SVG renders inside Svelte template directly |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tauri::async_runtime::spawn_blocking` | Tauri 2 built-in | Run git2 blocking ops off async runtime | Required for every Tauri command that calls git2 (Repository is not Sync) |
| `serde_json::json!` macro | 1 (already in Cargo.toml) | Construct JSON values for plugin-store | Used with tauri-plugin-store's `store.set(key, json!(...))` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@humanspeak/svelte-virtual-list` | `virtua/svelte` (~3 kB) | virtua is smaller but `onLoadMore` pattern requires more manual scroll event wiring in Svelte 5; humanspeak has first-class `onLoadMore`/`hasMore` API |
| `tauri-plugin-store` | Custom JSON file in app data dir | Plugin handles cross-platform path resolution, atomic writes, and JS/Rust shared access automatically |
| `revwalk.skip(offset).take(200)` | Cursor OID stored in state | Skip/take is simpler; cursor would require storing the last seen OID per repo, which adds state complexity |

**Installation (new dependencies only):**
```bash
# Rust
cargo add tauri-plugin-store

# Frontend
npm install @humanspeak/svelte-virtual-list @tauri-apps/plugin-store
```

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── lib/
│   ├── types.ts            # Already complete — GraphCommit, GraphEdge, RefLabel, etc.
│   ├── invoke.ts           # Already complete — safeInvoke<T>
│   └── store.ts            # NEW: recent repos persistence via LazyStore
├── components/
│   ├── WelcomeScreen.svelte      # NEW: Open button + recent repos list
│   ├── TabBar.svelte             # NEW: Single-tab shell with repo name + X close
│   ├── CommitGraph.svelte        # NEW: SvelteVirtualList host + pagination logic
│   ├── CommitRow.svelte          # NEW: Single row: ref pills | SVG lane | message
│   ├── LaneSvg.svelte            # NEW: Inline SVG lane segment for one commit row
│   └── RefPill.svelte            # NEW: Colored pill badge for branch/tag/stash labels
└── App.svelte              # REPLACE placeholder with app shell (welcome vs graph)

src-tauri/src/
├── commands/
│   ├── repo.rs             # NEW: open_repo, close_repo, get_recent_repos commands
│   └── history.rs          # NEW: get_commit_graph command
├── git/
│   ├── repository.rs       # NEW: validate_and_open, build_ref_map helpers
│   └── graph.rs            # NEW: walk_commits, assign_lanes, build_graph_commit
└── lib.rs                  # UPDATE: register new commands in generate_handler![]
```

### Pattern 1: Tauri Command with spawn_blocking + RepoState

**What:** Every Tauri command that touches git2 must run inside `spawn_blocking` because `git2::Repository` is not `Sync`. The command clones the PathBuf from the mutex, then opens a fresh Repository inside the blocking closure.

**When to use:** Every command in `repo.rs` and `history.rs`.

**Example:**
```rust
// Source: Tauri docs + established Phase 1 pattern
#[tauri::command]
async fn get_commit_graph(
    path: String,
    offset: usize,
    state: tauri::State<'_, RepoState>,
) -> Result<Vec<GraphCommit>, String> {
    // Clone PathBuf out of mutex before moving into spawn_blocking
    let repo_path = {
        let map = state.0.lock().map_err(|e| e.to_string())?;
        map.get(&path)
            .cloned()
            .ok_or_else(|| "repo_not_open".to_string())?
    };

    tauri::async_runtime::spawn_blocking(move || {
        let repo = git2::Repository::open(&repo_path)
            .map_err(|e| TrunkError::from(e))?;
        let commits = git::graph::walk_commits(&repo, offset, 200)?;
        Ok(commits)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: TrunkError| serde_json::to_string(&e).unwrap())
}
```

### Pattern 2: Revwalk for Paginated Commit Graph

**What:** Use `revwalk.push_glob("refs/*")` to start from all reachable refs, set `Sort::TOPOLOGICAL | Sort::TIME`, then use `.skip(offset).take(batch_size)` for pagination. Build graph layout (lane column assignment) during this walk.

**When to use:** `history.rs` `get_commit_graph` command.

**Example:**
```rust
// Source: docs.rs/git2/latest/git2/struct.Revwalk.html
fn walk_commits(repo: &Repository, offset: usize, limit: usize)
    -> Result<Vec<GraphCommit>, TrunkError>
{
    let mut revwalk = repo.revwalk()?;
    // Push all reachable refs (branches, tags, etc.)
    revwalk.push_glob("refs/*")?;
    // Topological order (children before parents) with time tiebreak
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;

    let oids: Vec<git2::Oid> = revwalk
        .skip(offset)
        .take(limit)
        .collect::<Result<Vec<_>, _>>()?;

    // Build GraphCommit DTOs with lane layout
    build_graph(repo, &oids, offset)
}
```

### Pattern 3: Collecting All Refs for RefLabel Population

**What:** Iterate `repo.references()` to collect local branches, remote branches, and tags. Use `repo.stash_foreach()` for stashes (stashes are not standard refs). Build a `HashMap<Oid, Vec<RefLabel>>` to look up labels when constructing `GraphCommit`.

**When to use:** Before the revwalk, build the ref map once per command call.

**Example:**
```rust
// Source: docs.rs/git2/latest/git2/struct.Repository.html
fn build_ref_map(repo: &Repository) -> HashMap<git2::Oid, Vec<RefLabel>> {
    let mut map: HashMap<git2::Oid, Vec<RefLabel>> = HashMap::new();

    // Branches and tags via references iterator
    if let Ok(refs) = repo.references() {
        for reference in refs.flatten() {
            if let Some(oid) = reference.target() {
                let label = ref_to_label(&reference, repo);
                map.entry(oid).or_default().push(label);
            }
        }
    }

    // Stashes via dedicated callback (not in references())
    let _ = repo.stash_foreach(|_index, name, oid| {
        let label = RefLabel {
            name: name.to_string(),
            short_name: name.trim_start_matches("stash@{").trim_end_matches('}').to_string(),
            ref_type: RefType::Stash,
            is_head: false,
        };
        map.entry(*oid).or_default().push(label);
        true // continue
    });

    map
}
```

### Pattern 4: Lane/Column Assignment Algorithm

**What:** O(n) single-pass algorithm that assigns each commit a `column` integer and produces `edges: Vec<GraphEdge>` for the row's SVG. Maintains an `active_lanes: Vec<Option<Oid>>` where index = column, `None` = free.

**When to use:** `git/graph.rs` — the core of this phase.

**Algorithm (conceptually):**
1. For each commit in topological order:
   - If commit OID already occupies a lane (it's a parent of a prior commit), take that column
   - Otherwise assign the first free lane column
2. Draw `Straight` edges from occupied columns that continue to the next row
3. For each parent of the commit:
   - If parent not yet seen: reserve its column (keep the current column for first parent, find a new one for others)
   - Draw `ForkLeft`/`ForkRight` or `MergeLeft`/`MergeRight` edges as appropriate
4. Free the commit's column (no longer active after processing)

**Key insight from research:** The EdgeType enum (`Straight`, `MergeLeft`, `MergeRight`, `ForkLeft`, `ForkRight`) already captures all the cases needed for Svelte to render correct SVG paths without any layout logic on the frontend.

### Pattern 5: Per-Row Inline SVG Lane Rendering (Svelte)

**What:** Each `CommitRow` renders a fixed-width `<svg>` containing the lane for that row. The SVG reads `commit.column` and `commit.edges` — no layout computation in the browser.

**When to use:** `LaneSvg.svelte` component.

**Example:**
```svelte
<!-- Source: established pattern from pvigier.github.io commit graph algorithm -->
<script lang="ts">
  import type { GraphCommit, GraphEdge } from '$lib/types';

  interface Props { commit: GraphCommit; laneWidth: number; rowHeight: number; }
  let { commit, laneWidth = 12, rowHeight = 26 }: Props = $props();

  // Convert column/edge data to SVG coordinates
  const cx = (col: number) => col * laneWidth + laneWidth / 2;
  const cy = rowHeight / 2;
  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
</script>

<svg width={/* totalLanes * laneWidth */} height={rowHeight}>
  <!-- Straight continuation lines from edges -->
  {#each commit.edges as edge}
    {#if edge.edge_type === 'Straight'}
      <line
        x1={cx(edge.from_column)} y1={0}
        x2={cx(edge.to_column)}   y2={rowHeight}
        stroke={laneColor(edge.color_index)} stroke-width="2"
      />
    {:else}
      <!-- Bezier curve for fork/merge edges -->
      <path
        d={`M ${cx(edge.from_column)} ${cy} C ${cx(edge.from_column)} ${rowHeight}, ${cx(edge.to_column)} ${0}, ${cx(edge.to_column)} ${rowHeight}`}
        fill="none" stroke={laneColor(edge.color_index)} stroke-width="2"
      />
    {/if}
  {/each}

  <!-- Commit dot -->
  <circle
    cx={cx(commit.column)}
    cy={cy}
    r={commit.is_merge ? 6 : 4}
    fill={laneColor(commit.column % 8)}
    stroke={commit.is_merge ? 'var(--color-bg)' : 'none'}
    stroke-width={commit.is_merge ? 2 : 0}
  />
</svg>
```

### Pattern 6: Virtual List with Pagination (Svelte 5)

**What:** Use `@humanspeak/svelte-virtual-list` with `onLoadMore` callback. The callback calls `safeInvoke` for the next batch and appends to the reactive commits array. `hasMore` becomes `false` when a batch returns fewer than 200 items.

**When to use:** `CommitGraph.svelte`.

**Example:**
```svelte
<script lang="ts">
  import SvelteVirtualList from '@humanspeak/svelte-virtual-list';
  import { safeInvoke } from '$lib/invoke';
  import type { GraphCommit } from '$lib/types';

  interface Props { repoPath: string; }
  let { repoPath }: Props = $props();

  let commits = $state<GraphCommit[]>([]);
  let hasMore = $state(true);
  let loading = $state(false);
  let offset = $state(0);
  const BATCH = 200;

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    try {
      const batch = await safeInvoke<GraphCommit[]>('get_commit_graph', {
        path: repoPath,
        offset,
      });
      commits.push(...batch);    // Svelte 5: direct push triggers reactivity
      offset += batch.length;
      if (batch.length < BATCH) hasMore = false;
    } catch (e) {
      // surface error to user
    } finally {
      loading = false;
    }
  }

  // Load initial batch on mount
  $effect(() => { loadMore(); });
</script>

<SvelteVirtualList
  items={commits}
  onLoadMore={loadMore}
  loadMoreThreshold={50}
  {hasMore}
>
  {#snippet renderItem(commit)}
    <CommitRow {commit} />
  {/snippet}
</SvelteVirtualList>
```

### Pattern 7: Recent Repos Persistence with tauri-plugin-store

**What:** Store the list of recent repos (max 5) as a JSON array in `tauri-plugin-store`. Read on welcome screen mount, write on every repo open/close.

**When to use:** `src/lib/store.ts` + `WelcomeScreen.svelte`.

**Example:**
```typescript
// Source: v2.tauri.app/reference/javascript/store/
import { LazyStore } from '@tauri-apps/plugin-store';

export interface RecentRepo { name: string; path: string; }

const store = new LazyStore('trunk-prefs.json');
const RECENT_KEY = 'recent_repos';
const MAX_RECENT = 5;

export async function addRecentRepo(repo: RecentRepo): Promise<void> {
  const current = await store.get<RecentRepo[]>(RECENT_KEY) ?? [];
  const updated = [repo, ...current.filter(r => r.path !== repo.path)].slice(0, MAX_RECENT);
  await store.set(RECENT_KEY, updated);
  await store.save();
}

export async function getRecentRepos(): Promise<RecentRepo[]> {
  return await store.get<RecentRepo[]>(RECENT_KEY) ?? [];
}
```

### Anti-Patterns to Avoid

- **Storing `git2::Repository` in `RepoState`:** Repository is not Sync — the compiler will reject it. Always store `PathBuf` only, open fresh per command inside `spawn_blocking`.
- **Running git2 on the async runtime thread:** `git2` operations block the OS thread. Always wrap in `tauri::async_runtime::spawn_blocking`.
- **Computing lane layout in the browser:** The EdgeType/column values from Rust are the contract. Never recalculate in TypeScript — that would double the work and risk topology errors.
- **Rendering all commits in the DOM:** Even at 24px per row, 50k commits = 1.2MB of DOM nodes. The virtual list must be in place before any real repos are tested.
- **Using `revwalk.push_head()` only:** This misses commits reachable only from non-HEAD branches. Use `push_glob("refs/*")` to ensure all branches, tags, and remote refs are included.
- **Using `revwalk.skip(offset)` without topological sort:** Without `Sort::TOPOLOGICAL | Sort::TIME`, skip produces non-deterministic results when called across multiple batches.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Persistent key-value storage | Custom JSON file write/read | `tauri-plugin-store` | Cross-platform path resolution, atomic writes, JS+Rust shared access |
| Virtual list DOM management | CSS `overflow: auto` + render-all | `@humanspeak/svelte-virtual-list` | 10k+ rows will freeze the browser without virtualization |
| Virtual list scroll events | `onscroll` + manual threshold check | `onLoadMore` + `loadMoreThreshold` props | Race conditions, debouncing, concurrent load prevention already handled |
| Stash enumeration via refs | `references_glob("refs/stash")` | `repo.stash_foreach()` | Stashes are stored at `refs/stash` but the standard API for listing them is `stash_foreach` |

**Key insight:** The hardest problems in this phase (virtual scroll correctness, persistent storage, git ref enumeration) all have first-class solutions in the existing stack. The only truly custom code is the lane layout algorithm in `graph.rs`.

---

## Common Pitfalls

### Pitfall 1: `push_glob("refs/*")` misses some refs

**What goes wrong:** `push_glob("refs/*")` matches only one level deep. Remote branches are at `refs/remotes/origin/main` (three levels).

**Why it happens:** The glob `*` doesn't cross directory separators.

**How to avoid:** Use `push_glob("refs/heads")`, `push_glob("refs/remotes")`, `push_glob("refs/tags")` separately, or use `push_glob("refs/heads/*")` etc. According to the libgit2 docs, `push_glob` automatically appends `/*` if the pattern lacks `?`, `*`, or `[` — so `push_glob("refs/heads")` becomes `push_glob("refs/heads/*")`.

**Warning signs:** Graph missing commits from non-HEAD branches on first load.

### Pitfall 2: Lane algorithm produces wrong topology on batch boundaries

**What goes wrong:** When displaying commits 200–400, the lane state from rows 0–199 is lost, causing fork/merge edges to appear in wrong columns.

**Why it happens:** The lane state (which OIDs are in which columns) must be threaded through all batches, not recomputed per batch.

**How to avoid:** Two options:
1. Walk the full commit list in Rust (all N commits) once and cache the computed `GraphCommit` list server-side (memory cost: ~500 bytes × N commits = ~50 MB for 100k commits — acceptable).
2. Store the lane state snapshot at the end of each batch and pass it as input to the next batch call.

**Recommendation:** For Phase 2, walk all commits once per `open_repo` and cache in the app state as `Vec<GraphCommit>`. The `get_commit_graph` command then just slices the cached vec. This avoids the boundary problem entirely and keeps the frontend simple.

**Warning signs:** Visual lane continuity breaks at scroll positions divisible by 200.

### Pitfall 3: Revwalk pagination inconsistency across calls

**What goes wrong:** Calling `skip(200).take(200)` on a fresh `revwalk` for the second batch works only if the walk order is deterministic. Without topological sort, commit time changes (e.g., rebase) can reorder the walk.

**Why it happens:** `Sort::NONE` produces insertion-order traversal which can vary.

**How to avoid:** Always set `Sort::TOPOLOGICAL | Sort::TIME` before the walk.

**Warning signs:** Commits appearing in different positions after refreshing the graph.

### Pitfall 4: Svelte 5 reactive array — reassign vs mutate

**What goes wrong:** `commits = [...commits, ...batch]` creates a new array, which can cause the virtual list to scroll-jump to the top.

**Why it happens:** The virtual list tracks items by reference; a full array replacement loses scroll position.

**How to avoid:** Use `commits.push(...batch)` instead. In Svelte 5, `$state` arrays are deep proxies; `.push()` is reactive without reassignment.

**Warning signs:** Scroll position resets to top after each batch load.

### Pitfall 5: TrunkError not surfaced as structured object from safeInvoke

**What goes wrong:** Matching on `e.code` inside a catch block receives `undefined`.

**Why it happens:** Tauri throws IPC errors as raw strings, not Error objects. The existing `safeInvoke` handles this — but only if `catch` receives the result of `safeInvoke`, not the raw `invoke`.

**How to avoid:** Always use `safeInvoke` (never raw `invoke`). In catch blocks, treat the error as `TrunkError` (imported from `invoke.ts`) and check `e.code`.

**Warning signs:** `e.message` is undefined in error handlers.

### Pitfall 6: Plugin-store not registered — silent no-op

**What goes wrong:** `LazyStore` works in JS but data is never persisted across restarts.

**Why it happens:** `tauri_plugin_store::Builder::default().build()` must be added to `tauri::Builder::default()` in `lib.rs`, AND the npm package must be installed.

**How to avoid:** Register the plugin in `lib.rs` during Wave 0. Verify by checking `trunk-prefs.json` exists in the platform app-data directory after first use.

**Warning signs:** Recent repos list is empty on every app start.

---

## Code Examples

### Opening a repo and validating with git2

```rust
// Source: docs.rs/git2/latest/git2/struct.Repository.html
pub fn validate_and_open(path: &std::path::Path) -> Result<(), TrunkError> {
    git2::Repository::open(path).map_err(|e| TrunkError {
        code: "not_a_git_repo".into(),
        message: e.message().to_owned(),
    })?;
    Ok(())
}
```

### Tauri command: open_repo

```rust
#[tauri::command]
async fn open_repo(
    path: String,
    state: tauri::State<'_, RepoState>,
) -> Result<(), String> {
    let path_buf = std::path::PathBuf::from(&path);

    // Validate on blocking thread
    tauri::async_runtime::spawn_blocking({
        let p = path_buf.clone();
        move || git2::Repository::open(&p).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: git2::Error| {
        serde_json::to_string(&TrunkError::from(e)).unwrap()
    })?;

    // Store path (use full path as key)
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.insert(path.clone(), path_buf);
    Ok(())
}
```

### Opening a directory picker (frontend)

```typescript
// Source: v2.tauri.app/plugin/dialog/
import { open } from '@tauri-apps/plugin-dialog';

async function openRepository(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}
```

### Skeleton row (Svelte 5 + Tailwind v4)

```svelte
<!-- Used while loading — matches locked 24-28px row height -->
<div class="flex items-center gap-2 px-2 animate-pulse" style="height: 26px">
  <!-- Ref label placeholder -->
  <div class="rounded-full bg-[var(--color-border)] w-16 h-3"></div>
  <!-- Lane placeholder -->
  <div class="rounded bg-[var(--color-border)] w-8 h-full"></div>
  <!-- Message placeholder -->
  <div class="rounded bg-[var(--color-border)] h-3 flex-1"></div>
</div>
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Svelte 4 store-based reactivity | Svelte 5 `$state` runes | Svelte 5.0 (2024) | Arrays are deep proxies; `.push()` is reactive without reassignment |
| `svelte-virtual-list` (official, unmaintained) | `@humanspeak/svelte-virtual-list` or `virtua` | 2024 | Official svelte-virtual-list has no Svelte 5 support; community forks are the standard |
| `tauri::window::Window::data_dir()` (v1) | `app.store("file.json")` via plugin | Tauri v2 (2024) | Plugin handles path resolution; no manual `app_data_dir()` needed |
| Full DOM render (all commits) | Virtual list (render only visible rows) | Industry standard | Required for any list > ~500 items in desktop apps |

**Deprecated/outdated:**
- `sveltejs/svelte-virtual-list`: Official Svelte team package, last updated for Svelte 4; not Svelte 5 compatible — do not use.
- `tauri::api::path` (v1): Replaced by `tauri::path` in v2; the plugin handles this internally.

---

## Open Questions

1. **Full commit list caching vs per-batch lane computation**
   - What we know: Lane topology requires knowledge of prior rows' state to correctly assign columns
   - What's unclear: Whether the memory cost of caching all `GraphCommit` DTOs is acceptable for very large repos (500k+ commits)
   - Recommendation: For Phase 2, cache the full computed list on `open_repo` (acceptable for repos up to ~200k commits; ~100 MB). Add lazy re-computation only if profiling shows it as a problem in a later phase.

2. **Total commit count for `hasMore` determination**
   - What we know: `loadMoreThreshold=50` triggers `onLoadMore` 50 rows before the end; `hasMore=false` when batch < 200
   - What's unclear: Whether the virtual list needs to know the total count upfront for the scrollbar to scale correctly
   - Recommendation: The locked decision says "end of history — list ends at root commit with no special indicator." No total count needed. The scrollbar will grow dynamically as batches load, which is the standard infinite-scroll UX.

3. **Edge coordinate system for SVG lane rendering**
   - What we know: `GraphEdge.from_column` and `to_column` map to horizontal positions; the SVG height equals the row height
   - What's unclear: Whether edges should connect to the top/bottom of the row or to the center-y of each row
   - Recommendation: Straight edges span full row height (y1=0 to y2=rowHeight); fork/merge Bézier curves start at center-y of the row and curve to the top or bottom edge.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rust built-in `#[cfg(test)]` + `#[test]` (no external test crate needed for unit tests) |
| Config file | none — Rust tests live in the same file as the module under test |
| Quick run command | `cargo test -p trunk --lib -- graph` (runs only graph module tests) |
| Full suite command | `cargo test -p trunk` |

Note: No frontend test framework is present and none is needed for Phase 2 — the rendering logic is pure SVG coordinate math driven by Rust-provided data. Frontend visual correctness is validated via the phase success criteria checklist.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REPO-01 | `open_repo` rejects non-git path with `not_a_git_repo` code | unit (Rust) | `cargo test -p trunk --lib -- repo::tests::open_invalid_path` | ❌ Wave 0 |
| REPO-01 | `open_repo` accepts valid git repo path and stores it in state | unit (Rust) | `cargo test -p trunk --lib -- repo::tests::open_valid_repo` | ❌ Wave 0 |
| REPO-02 | `close_repo` removes path from state | unit (Rust) | `cargo test -p trunk --lib -- repo::tests::close_removes_state` | ❌ Wave 0 |
| REPO-03 | Recent repos persist across store load/save cycle | unit (Rust via plugin-store test) | manual-only — requires Tauri runtime | manual |
| GRAPH-01 | `walk_commits(repo, 0, 200)` returns exactly 200 commits for a repo with 500+ commits | unit (Rust) | `cargo test -p trunk --lib -- graph::tests::walk_first_batch` | ❌ Wave 0 |
| GRAPH-01 | Second batch `walk_commits(repo, 200, 200)` starts at commit 201 | unit (Rust) | `cargo test -p trunk --lib -- graph::tests::walk_second_batch` | ❌ Wave 0 |
| GRAPH-02 | Lane columns are assigned without gaps for a linear repo | unit (Rust) | `cargo test -p trunk --lib -- graph::tests::linear_topology` | ❌ Wave 0 |
| GRAPH-02 | Merge commit has `is_merge: true` and both parent edges present | unit (Rust) | `cargo test -p trunk --lib -- graph::tests::merge_commit_edges` | ❌ Wave 0 |
| GRAPH-03 | `build_ref_map` returns HEAD ref with `is_head: true` | unit (Rust) | `cargo test -p trunk --lib -- repository::tests::ref_map_head` | ❌ Wave 0 |
| GRAPH-03 | `build_ref_map` includes stash entries | unit (Rust) | `cargo test -p trunk --lib -- repository::tests::ref_map_stash` | ❌ Wave 0 |
| GRAPH-04 | Commit with 2 parents has `is_merge: true` | unit (Rust) | `cargo test -p trunk --lib -- graph::tests::is_merge_flag` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `cargo test -p trunk --lib -- graph`
- **Per wave merge:** `cargo test -p trunk`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/commands/repo.rs` — add `#[cfg(test)]` module with `open_invalid_path`, `open_valid_repo`, `close_removes_state` tests
- [ ] `src-tauri/src/git/graph.rs` — add `#[cfg(test)]` module with `linear_topology`, `merge_commit_edges`, `is_merge_flag`, `walk_first_batch`, `walk_second_batch` tests
- [ ] `src-tauri/src/git/repository.rs` — add `#[cfg(test)]` module with `ref_map_head`, `ref_map_stash` tests
- [ ] Test helper: `fn make_test_repo() -> TempDir` — creates a bare in-memory repo with at least one merge commit for use across all graph tests

---

## Sources

### Primary (HIGH confidence)

- `docs.rs/git2/latest/git2/struct.Revwalk.html` — Revwalk methods, sort flags, push_glob behavior
- `docs.rs/git2/latest/git2/struct.Repository.html` — Repository::open, references(), stash_foreach
- `docs.rs/git2/latest/git2/struct.Sort.html` — Sort flag definitions and combination rules
- `v2.tauri.app/plugin/dialog/` — open() with directory:true, return type
- `v2.tauri.app/reference/javascript/store/` — LazyStore, set, get, save API
- `docs.rs/tauri/latest/tauri/async_runtime/fn.spawn_blocking.html` — spawn_blocking signature
- `github.com/humanspeak/svelte-virtual-list` README — onLoadMore, hasMore, loadMoreThreshold props, Svelte 5 requirement
- `github.com/rust-lang/git2-rs/blob/master/src/stash.rs` — stash_foreach callback signature

### Secondary (MEDIUM confidence)

- `dolthub.com/blog/2024-08-07-drawing-a-commit-graph/` — Lane column assignment algorithm (topological-based)
- `pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html` — Branch vs merge child distinction, EdgeType classification
- `github.com/tauri-apps/tauri-plugin-store README` — Cargo.toml setup, JS/Rust shared store pattern
- `v2.tauri.app/develop/calling-rust/` — async command pattern with Mutex state

### Tertiary (LOW confidence)

- WebSearch results on skeleton loading patterns — cross-verified with Tailwind v4 `animate-pulse` which is confirmed in the existing app.css import

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified against official docs; versions confirmed against existing Cargo.toml and package.json
- Architecture (Rust commands + spawn_blocking): HIGH — verified against Tauri v2 official docs
- Architecture (lane algorithm): MEDIUM — algorithm description verified against two independent sources (DoltHub blog + pvigier blog) but exact implementation is custom; unit tests are the validation gate
- Architecture (virtual list integration): HIGH — API verified against humanspeak README
- Pitfalls: HIGH for Rust patterns (Repository not Sync, push_glob behavior); MEDIUM for lane boundary pitfall (logical reasoning from algorithm structure)

**Research date:** 2026-03-03
**Valid until:** 2026-06-03 (stable stack; git2 0.19 and Tauri 2 APIs are stable)
