# Phase 1: Foundation - Research

**Researched:** 2026-03-03
**Domain:** Tauri 2 + Vite + Svelte 5 project scaffold migration, Rust primitives, Tailwind CSS v4
**Confidence:** HIGH — All findings grounded in existing project lockfiles, STACK.md, PITFALLS.md, PRD.md, and CONTEXT.md. Web search unavailable; Tailwind v4 CSS import syntax verified via official docs fetch.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### SvelteKit Migration
- Remove SvelteKit entirely: delete `svelte.config.js`, `src/routes/+layout.ts`, `src/app.html`, `.svelte-kit/`
- Replace with plain Vite+Svelte: `vite.config.ts` uses `@sveltejs/vite-plugin-svelte` directly (no kit adapter)
- New entry: `index.html` at project root + `src/main.ts` + `src/App.svelte`
- Keep `svelte-check` for type checking; remove `svelte-kit sync` from scripts
- The existing `+page.svelte` greet example can be ported to `App.svelte` temporarily, then deleted in Phase 2

#### Rust Dependencies
- Add to `Cargo.toml`: `git2 = "0.19"`, `notify = "7"`, `notify-debouncer-mini = "0.5"`, `tauri-plugin-dialog = "2"`
- Remove `tauri-plugin-opener` (not needed for this project; was scaffold default)
- Add Tauri 2 capability file: `src-tauri/capabilities/default.json` with `dialog:allow-open` permission

#### Rust Module Structure
- Scaffold ALL modules from PRD now (empty stubs where not yet needed):
  - `src-tauri/src/error.rs` — `TrunkError { code: String, message: String }` implementing `serde::Serialize` and `From<git2::Error>`
  - `src-tauri/src/state.rs` — `RepoState(Mutex<HashMap<String, PathBuf>>)` — stores paths only, NOT Repository handles
  - `src-tauri/src/git/mod.rs`, `git/types.rs`, `git/repository.rs`, `git/graph.rs`
  - `src-tauri/src/commands/mod.rs` + empty stubs: `repo.rs`, `history.rs`, `branches.rs`, `staging.rs`, `commit.rs`, `diff.rs`
  - `src-tauri/src/watcher.rs` — stub only
  - Update `lib.rs` to declare all modules; register no commands yet (just proves it compiles)

#### TypeScript DTO Types
- Create `src/lib/types.ts` with ALL 10 Rust DTO types from the PRD upfront:
  - `GraphCommit`, `GraphEdge`, `RefLabel`, `BranchInfo`, `RefsResponse`
  - `WorkingTreeStatus`, `FileStatus`, `FileDiff`, `DiffHunk`, `DiffLine`, `CommitDetail`
  - Use TypeScript string literal unions for enums (e.g., `type EdgeType = 'Straight' | 'MergeLeft' | 'MergeRight' | 'ForkLeft' | 'ForkRight'`)

#### TypeScript Invoke Wrapper
- Create `src/lib/invoke.ts` with a typed `safeInvoke<T>` wrapper
- Tauri IPC errors arrive as raw strings; `catch(e) { e.message }` returns `undefined`
- Wrapper parses the raw string into `TrunkError { code: string, message: string }`
- All Tauri commands in subsequent phases use `safeInvoke` exclusively — never raw `invoke`

#### CSS / Theme Architecture
- Forced dark theme (not OS-preference toggle) per PRD
- CSS custom properties defined in `src/app.css` (global file imported in `main.ts`)
- Color palette: `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-accent`
- Graph lane colors: `--lane-0` through `--lane-7`
- Typography: `--font-mono`, `--font-sans`
- Tailwind v4: `@tailwindcss/vite` plugin in `vite.config.ts`, `@import "tailwindcss"` in `app.css`
- No `tailwind.config.js` needed (Tailwind v4 auto-detects)
- `body` gets `background-color: var(--color-bg); color: var(--color-text)`

### Claude's Discretion
- Exact color values for the dark theme palette (neutral dark grays; accent blue)
- Whether to use `app.css` or `src/styles/theme.css` — structure within the convention
- `safeInvoke` error message fallback text when parsing fails

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFRA-01 | Project uses plain Vite+Svelte (not SvelteKit) as the frontend framework | STACK.md migration guide; vite.config.ts pattern; tsconfig.json replacement documented |
| INFRA-02 | Rust backend includes git2 = "0.19", notify = "7", notify-debouncer-mini = "0.5", and tauri-plugin-dialog = "2" in Cargo.toml, and `cargo build` passes | STACK.md installation; existing Cargo.toml baseline documented; libgit2 system dep requirement noted |
| INFRA-03 | Rust backend has `error.rs`, `state.rs`, and `git/types.rs` scaffolded before any git2 logic | PITFALLS.md critical path; exact struct shapes from PRD; module declaration in lib.rs pattern |
| INFRA-04 | Frontend uses Tailwind CSS v4 with `@tailwindcss/vite` plugin and a dark theme via CSS custom properties | Tailwind v4 setup verified via official docs fetch; CSS custom property pattern documented |
</phase_requirements>

---

## Summary

Phase 1 is a pure infrastructure migration and scaffold phase — no user-visible git features. The work divides into three independent tracks: (1) remove SvelteKit and configure plain Vite+Svelte, (2) add Rust crate dependencies and scaffold all module stubs, (3) install Tailwind CSS v4 and wire the dark theme.

The project is a fresh Tauri 2 scaffold using SvelteKit with `adapter-static`. The migration away from SvelteKit is well-understood: swap the Vite plugin, replace `src/routes/+page.svelte` with `src/App.svelte`, create `src/main.ts`, replace `index.html`, fix `tsconfig.json`, and update `package.json` scripts. The existing `svelte.config.js` and SvelteKit-specific files are deleted.

The Rust side requires adding four crates to `Cargo.toml`, scaffolding the full module directory structure as empty stubs, and verifying `cargo build` passes. The CRITICAL design constraint — `state.rs` must store `PathBuf` only, never `Repository` handles — is already decided and must be enforced in the stub to prevent any future module from deviating. The TypeScript DTO types and `safeInvoke` wrapper must be created before any future phase writes IPC-calling code.

**Primary recommendation:** Execute in three parallel tracks (frontend migration, Rust scaffolding, CSS theme) then verify with `bun run dev` + `cargo build` as the acceptance gate.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | 5.53.6 | UI framework | Installed; runes-first; zero-runtime overhead |
| @sveltejs/vite-plugin-svelte | 5.1.1 | Svelte compilation in Vite | Direct plugin for non-SvelteKit usage; already in node_modules as transitive dep |
| Vite | 6.4.1 | Build tool / dev server | Current major; Tauri 2 dev workflow requires it at port 1420 |
| Tauri | 2.10.2 | Desktop shell, IPC bridge | Installed; Rust crate version from Cargo.lock |
| @tauri-apps/api | 2.10.1 | JS IPC client (`invoke`, `listen`) | Installed; Tauri 2 path is `@tauri-apps/api/core` |
| tailwindcss | ^4.x | Utility-first CSS | v4 requires only `@import "tailwindcss"` in CSS; no config file |
| @tailwindcss/vite | ^4.x | Vite integration for Tailwind v4 | Replaces PostCSS pipeline; direct Vite plugin |
| git2 | 0.19 | libgit2 Rust bindings | PRD-mandated; covers all local git operations |
| notify | 7 | Filesystem event watching | PRD-mandated; cross-platform |
| notify-debouncer-mini | 0.5 | Debounced fs events | PRD-mandated; compatible with `notify ^7` |
| tauri-plugin-dialog | 2 | Native file picker | PRD-mandated; needed for open-repo dialog |
| serde | 1.0 (features = ["derive"]) | Rust serialization | Already in Cargo.toml; required for all Tauri command return types |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| svelte-check | 4.x | Type checking for .svelte files | Keep; run as `svelte-check --tsconfig ./tsconfig.json` (remove `svelte-kit sync` prefix) |
| @tauri-apps/plugin-dialog | 2.x | JS-side file dialog API | Add to dependencies; `import { open } from "@tauri-apps/plugin-dialog"` |
| serde_json | 1.x | JSON bridge | Already in Cargo.toml; used internally by Tauri IPC |
| tokio | 1.x | Async runtime | Already pulled in by Tauri; needed for async Tauri commands |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@tailwindcss/vite` (v4) | Tailwind v3 + PostCSS | v3 requires `tailwind.config.js` + PostCSS; incompatible with Vite 6 seamless integration; do NOT use |
| git2 0.19 | gitoxide (gix) | gix is pure-Rust and faster but API less mature for diff/index ops needed in v0.1 |
| Manual TypeScript types | tauri-specta codegen | tauri-specta deferred to v0.2+ once API surface stabilizes |

### Installation

```bash
# Remove SvelteKit packages
bun remove @sveltejs/kit @sveltejs/adapter-static @tauri-apps/plugin-opener

# Add Tailwind v4 and plain Svelte plugin (vite-plugin-svelte already present as transitive)
bun add -D tailwindcss @tailwindcss/vite

# Add dialog plugin for JS side
bun add @tauri-apps/plugin-dialog
```

```toml
# src-tauri/Cargo.toml — replace tauri-plugin-opener with new deps
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
git2 = "0.19"
notify = "7"
notify-debouncer-mini = "0.5"
```

---

## Architecture Patterns

### Recommended Project Structure

After Phase 1 completes:

```
trunk/
├── index.html                    # Vite entry point (replaces src/app.html)
├── src/
│   ├── main.ts                   # Mounts App.svelte
│   ├── app.css                   # Global CSS: @import "tailwindcss" + CSS custom properties
│   ├── App.svelte                # Root component (placeholder for Phase 2)
│   └── lib/
│       ├── types.ts              # All 10 DTO TypeScript interfaces
│       └── invoke.ts             # safeInvoke<T> typed wrapper
├── static/                       # Static assets (favicon.png etc.)
├── vite.config.ts                # svelte() + tailwindcss() plugins
├── tsconfig.json                 # Updated — no longer extends .svelte-kit/tsconfig.json
├── package.json                  # Updated scripts (no svelte-kit sync)
└── src-tauri/
    ├── Cargo.toml                # With 4 new crates; tauri-plugin-opener removed
    ├── capabilities/
    │   └── default.json          # dialog:allow-open permission
    └── src/
        ├── lib.rs                # Declares all modules; no commands yet
        ├── main.rs               # Entry point (unchanged)
        ├── error.rs              # TrunkError { code, message }
        ├── state.rs              # RepoState(Mutex<HashMap<String, PathBuf>>)
        ├── watcher.rs            # Stub only
        ├── git/
        │   ├── mod.rs            # Re-exports
        │   ├── types.rs          # All serializable DTO structs
        │   ├── repository.rs     # Stub
        │   └── graph.rs          # Stub
        └── commands/
            ├── mod.rs            # Re-exports
            ├── repo.rs           # Stub
            ├── history.rs        # Stub
            ├── branches.rs       # Stub
            ├── staging.rs        # Stub
            ├── commit.rs         # Stub
            └── diff.rs           # Stub
```

### Pattern 1: Vite Config for Plain Svelte + Tailwind v4

**What:** Minimal `vite.config.ts` using `@sveltejs/vite-plugin-svelte` directly with Tailwind v4 plugin. Preserves all Tauri-required settings (port 1420, strictPort, src-tauri ignored).

**When to use:** Always — this is the entire frontend build configuration.

```typescript
// vite.config.ts
// Source: Verified via official Tailwind v4 docs + STACK.md
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
```

### Pattern 2: index.html Vite Entry (replacing src/app.html)

**What:** Plain HTML entry point at project root. Vite expects `index.html` at root (not inside `src/`).

**When to use:** This is the app shell; SvelteKit's `src/app.html` with `%sveltekit.*%` placeholders is incompatible with plain Vite.

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Trunk</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

### Pattern 3: main.ts Svelte Mount

**What:** Creates and mounts the root Svelte 5 component.

```typescript
// src/main.ts
import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
```

### Pattern 4: Tailwind v4 CSS + Dark Theme Custom Properties

**What:** Global CSS file with Tailwind import AND CSS custom property token definitions. Dark by default, no OS media query.

```css
/* src/app.css */
/* Source: Tailwind v4 official docs — use @import, not @tailwind directives */
@import "tailwindcss";

:root {
  /* Color tokens */
  --color-bg: #0d1117;
  --color-surface: #161b22;
  --color-border: #30363d;
  --color-text: #c9d1d9;
  --color-text-muted: #8b949e;
  --color-accent: #388bfd;

  /* Graph lane colors (from PRD palette) */
  --lane-0: #4dc9f6;
  --lane-1: #f67019;
  --lane-2: #f53794;
  --lane-3: #537bc4;
  --lane-4: #acc236;
  --lane-5: #166a8f;
  --lane-6: #00a950;
  --lane-7: #58595b;

  /* Typography */
  --font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
  --font-sans: Inter, system-ui, -apple-system, sans-serif;
}

body {
  background-color: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  margin: 0;
}
```

### Pattern 5: tsconfig.json Without SvelteKit Extension

**What:** The existing `tsconfig.json` extends `.svelte-kit/tsconfig.json` which won't exist after migration. Replace with a standalone config that preserves the same `compilerOptions`.

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "moduleResolution": "bundler",
    "target": "ESNext",
    "module": "ESNext",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "paths": {
      "$lib": ["./src/lib"],
      "$lib/*": ["./src/lib/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"],
  "exclude": ["node_modules", "build", ".svelte-kit"]
}
```

### Pattern 6: Rust error.rs

**What:** Unified error type for all Tauri commands. MUST implement `serde::Serialize` (Tauri requirement). `From<git2::Error>` enables `?` operator in git2 code.

```rust
// src-tauri/src/error.rs
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct TrunkError {
    pub code: String,
    pub message: String,
}

impl TrunkError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        TrunkError {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<git2::Error> for TrunkError {
    fn from(e: git2::Error) -> Self {
        TrunkError {
            code: "git_error".into(),
            message: e.message().to_owned(),
        }
    }
}
```

### Pattern 7: Rust state.rs (path-only registry)

**What:** Managed state stores `PathBuf` per repo, NOT `Repository` handles. This is the critical thread-safety decision — `git2::Repository` is not `Sync`; fresh repo opens happen per command.

```rust
// src-tauri/src/state.rs
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct RepoState(pub Mutex<HashMap<String, PathBuf>>);
```

### Pattern 8: safeInvoke TypeScript Wrapper

**What:** Typed wrapper that parses Tauri's string rejection into a structured `TrunkError`. Never use raw `invoke` in feature code.

```typescript
// src/lib/invoke.ts
import { invoke } from "@tauri-apps/api/core";

export interface TrunkError {
  code: string;
  message: string;
}

export async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e: unknown) {
    // Tauri rejects with a string, not an Error object
    let parsed: TrunkError;
    try {
      parsed = JSON.parse(e as string) as TrunkError;
    } catch {
      parsed = {
        code: "unknown_error",
        message: typeof e === "string" ? e : "An unexpected error occurred",
      };
    }
    throw parsed;
  }
}
```

### Pattern 9: Tauri Capabilities — dialog:allow-open

**What:** Replace the existing `opener:default` permission with `dialog:allow-open` (and remove opener entirely).

```json
// src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open"
  ]
}
```

### Pattern 10: lib.rs Module Declarations (stub)

**What:** Declare all modules upfront so the compiler validates the full module tree, even though commands/implementations are stubs.

```rust
// src-tauri/src/lib.rs
mod commands;
mod error;
mod git;
mod state;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::RepoState(Default::default()))
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Anti-Patterns to Avoid

- **Keeping `svelte-kit sync` in package.json scripts:** Fails after SvelteKit is removed; causes CI breakage. Replace `check` with `svelte-check --tsconfig ./tsconfig.json` only.
- **Storing `Repository` in managed state:** `git2::Repository` is not `Sync`. Store `PathBuf` only; open fresh per command.
- **Using `@tauri-apps/api/tauri` import path:** That is Tauri 1. Tauri 2 uses `@tauri-apps/api/core`. The scaffold already uses the correct path.
- **Using Tailwind v3 with PostCSS:** Tailwind v4 uses `@tailwindcss/vite` directly. No `tailwind.config.js`, no PostCSS config needed.
- **Using `%sveltekit.*%` placeholders in index.html:** Those are SvelteKit-specific; plain Vite uses `<script type="module" src="/src/main.ts">`.
- **Using `svelte/mount` before Svelte 5.0:** In Svelte 5, mount is `import { mount } from "svelte"` — NOT `new App({ target })` (Svelte 4 pattern).
- **Using TypeScript enum for DTO types:** Svelte 5 + serde naturally produce string unions. Use `type EdgeType = 'Straight' | 'MergeLeft' | ...` instead of `enum EdgeType`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Filesystem event debouncing | Custom debounce logic over `notify` raw events | `notify-debouncer-mini = "0.5"` | Handles cross-platform event coalescing (inotify vs FSEvents vs ReadDirectoryChanges) |
| Git error serialization | Custom error type mapping per command | `TrunkError` with `From<git2::Error>` in `error.rs` | Single mapping point; all commands use `?` operator |
| Typed Tauri IPC calls | Ad-hoc try/catch in each component | `safeInvoke<T>` in `src/lib/invoke.ts` | Centralized error parsing; prevents silent error swallowing |
| Dark theme color picking | Computed theme colors from a single base | Static CSS custom properties in `app.css` | Graph lane colors must be stable values, not computed |

**Key insight:** All the "hard" problems in this phase (event debouncing, error serialization, typed IPC) have library or pattern solutions that must be in place before feature code is written. Building these correctly in Phase 1 prevents rewrites across all subsequent phases.

---

## Common Pitfalls

### Pitfall 1: Repository Not Sync — Must Store PathBuf Only

**What goes wrong:** Storing `git2::Repository` in `Mutex<HashMap<String, Repository>>` in Tauri managed state. `Repository` is `Send` but NOT `Sync`. Long operations lock the mutex and block all other commands.

**Why it happens:** Natural instinct is to keep a repo handle open as a "connection". git2 is not designed for this.

**How to avoid:** `state.rs` stores `Mutex<HashMap<String, PathBuf>>`. Each command opens a fresh `Repository::open(path)` inside `tauri::async_runtime::spawn_blocking`. `Repository::open()` is microseconds; re-opening is the correct pattern.

**Warning signs:** `cargo build` error about `Repository` not being `Sync`, or UI hangs when loading large repos.

### Pitfall 2: git2 Lifetime Traps — Define DTOs First

**What goes wrong:** Trying to store or return `git2::Commit<'repo>`, `Diff<'repo>` etc. These carry repo lifetimes and cannot be stored or sent across threads.

**Why it happens:** git2 API is designed for short-lived borrow patterns, not caching.

**How to avoid:** Define ALL DTO structs in `git/types.rs` with `#[derive(Serialize, Clone)]` using owned types (String, Vec, i64) before writing any git2 code. Every git2 access converts immediately: `commit_to_dto(c: &Commit) -> GraphCommit`.

**Warning signs:** Compiler errors "lifetime 'repo does not live long enough"; any struct that tries to hold a `git2::*<'_>` field.

### Pitfall 3: Tauri Invoke Errors Are Strings, Not Error Objects

**What goes wrong:** `catch(e) { e.message }` returns `undefined` for Tauri command errors. Errors disappear silently.

**Why it happens:** Tauri serializes `Err(TrunkError)` as a JSON string, not an `Error` object. The `catch` block receives a string.

**How to avoid:** Always use `safeInvoke<T>` from `src/lib/invoke.ts`. Never use raw `invoke` from `@tauri-apps/api/core` directly in feature code.

**Warning signs:** git operations fail with no visible UI feedback; `console.log(e.message)` logs `undefined`.

### Pitfall 4: tsconfig.json Breaks After SvelteKit Removal

**What goes wrong:** `"extends": "./.svelte-kit/tsconfig.json"` fails because `.svelte-kit/` no longer exists. `svelte-check` fails. The `$lib` path alias also disappears (it was provided by SvelteKit's generated tsconfig).

**Why it happens:** The SvelteKit scaffold auto-generates `.svelte-kit/tsconfig.json` at runtime; plain Vite+Svelte does not.

**How to avoid:** Replace the entire `tsconfig.json` with a standalone config that includes `"paths": { "$lib": ["./src/lib"], "$lib/*": ["./src/lib/*"] }` and `"include": ["src/**/*.ts", "src/**/*.svelte"]`. See Pattern 5 above.

**Warning signs:** `svelte-check` reports "Cannot find tsconfig" or "Cannot find module '$lib/types'".

### Pitfall 5: Tailwind v4 Uses @import Not @tailwind Directives

**What goes wrong:** Using `@tailwind base; @tailwind components; @tailwind utilities;` (v3 syntax) in CSS. With Tailwind v4, these directives are removed.

**Why it happens:** All Tailwind v3 tutorials and docs use the `@tailwind` directive syntax.

**How to avoid:** Use `@import "tailwindcss";` as the single CSS import. Tailwind v4 processes this automatically through the `@tailwindcss/vite` plugin.

**Warning signs:** Tailwind utility classes don't apply; vite build fails with "Unknown at-rule @tailwind".

### Pitfall 6: Tauri Plugin Cleanup — Remove opener, Add dialog

**What goes wrong:** Leaving `tauri-plugin-opener` in both `Cargo.toml` and `capabilities/default.json` after removing it from `lib.rs`. OR adding `dialog:allow-open` to capabilities without also adding the Rust plugin init to `tauri::Builder`.

**Why it happens:** Plugin initialization has three independent touch points: Cargo.toml, lib.rs, and capabilities JSON. Missing one causes either a build error or a runtime panic.

**How to avoid:** Remove `tauri-plugin-opener` from all three locations. Add `tauri-plugin-dialog` to all three. Verify by running `cargo build`.

**Warning signs:** `cargo build` fails with unused import; runtime panic "plugin not found".

---

## Code Examples

### All TypeScript DTO Types (src/lib/types.ts)

```typescript
// src/lib/types.ts
// Source: PRD.md Data Models section — manual TypeScript mirrors of Rust DTOs

export type EdgeType = 'Straight' | 'MergeLeft' | 'MergeRight' | 'ForkLeft' | 'ForkRight';
export type RefType = 'LocalBranch' | 'RemoteBranch' | 'Tag' | 'Stash';
export type FileStatusType = 'New' | 'Modified' | 'Deleted' | 'Renamed' | 'Typechange' | 'Conflicted';
export type DiffOrigin = 'Context' | 'Add' | 'Delete';

export interface GraphEdge {
  from_column: number;
  to_column: number;
  edge_type: EdgeType;
  color_index: number;
}

export interface RefLabel {
  name: string;
  short_name: string;
  ref_type: RefType;
  is_head: boolean;
}

export interface GraphCommit {
  oid: string;
  short_oid: string;
  summary: string;
  body: string | null;
  author_name: string;
  author_email: string;
  author_timestamp: number;
  parent_oids: string[];
  column: number;
  edges: GraphEdge[];
  refs: RefLabel[];
  is_head: boolean;
  is_merge: boolean;
}

export interface BranchInfo {
  name: string;
  is_head: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  last_commit_timestamp: number;
}

export interface RefsResponse {
  local: BranchInfo[];
  remote: BranchInfo[];
  tags: RefLabel[];
  stashes: RefLabel[];
}

export interface FileStatus {
  path: string;
  status: FileStatusType;
  is_binary: boolean;
}

export interface WorkingTreeStatus {
  unstaged: FileStatus[];
  staged: FileStatus[];
  conflicted: FileStatus[];
}

export interface DiffLine {
  origin: DiffOrigin;
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
}

export interface DiffHunk {
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  is_binary: boolean;
  hunks: DiffHunk[];
}

export interface CommitDetail {
  oid: string;
  short_oid: string;
  summary: string;
  body: string | null;
  author_name: string;
  author_email: string;
  author_timestamp: number;
  committer_name: string;
  committer_email: string;
  committer_timestamp: number;
  parent_oids: string[];
}
```

### Rust git/types.rs DTO Structs

```rust
// src-tauri/src/git/types.rs
// Source: PRD.md Data Models — all derive Serialize + Clone, owned types only
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub enum EdgeType {
    Straight,
    MergeLeft,
    MergeRight,
    ForkLeft,
    ForkRight,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphEdge {
    pub from_column: usize,
    pub to_column: usize,
    pub edge_type: EdgeType,
    pub color_index: usize,
}

#[derive(Debug, Serialize, Clone)]
pub enum RefType {
    LocalBranch,
    RemoteBranch,
    Tag,
    Stash,
}

#[derive(Debug, Serialize, Clone)]
pub struct RefLabel {
    pub name: String,
    pub short_name: String,
    pub ref_type: RefType,
    pub is_head: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_timestamp: i64,
    pub parent_oids: Vec<String>,
    pub column: usize,
    pub edges: Vec<GraphEdge>,
    pub refs: Vec<RefLabel>,
    pub is_head: bool,
    pub is_merge: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub last_commit_timestamp: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct RefsResponse {
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
    pub tags: Vec<RefLabel>,
    pub stashes: Vec<RefLabel>,
}

#[derive(Debug, Serialize, Clone)]
pub enum FileStatusType {
    New,
    Modified,
    Deleted,
    Renamed,
    Typechange,
    Conflicted,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileStatus {
    pub path: String,
    pub status: FileStatusType,
    pub is_binary: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct WorkingTreeStatus {
    pub unstaged: Vec<FileStatus>,
    pub staged: Vec<FileStatus>,
    pub conflicted: Vec<FileStatus>,
}

#[derive(Debug, Serialize, Clone)]
pub enum DiffOrigin {
    Context,
    Add,
    Delete,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffLine {
    pub origin: DiffOrigin,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileDiff {
    pub path: String,
    pub is_binary: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_timestamp: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_timestamp: i64,
    pub parent_oids: Vec<String>,
}
```

### App.svelte Placeholder

```svelte
<!-- src/App.svelte — placeholder; greet example for smoke-test, replaced in Phase 2 -->
<script lang="ts">
  import { safeInvoke } from "$lib/invoke";

  let status = $state("Phase 1 scaffold active");
</script>

<main class="flex items-center justify-center h-screen">
  <p class="text-text">{status}</p>
</main>
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| SvelteKit adapter-static for Tauri | Plain Vite+Svelte | Tauri docs now recommend plain Vite | Removes routing machinery, generated files, adapter overhead |
| Tailwind v3 + PostCSS | Tailwind v4 + @tailwindcss/vite | Tailwind v4 released early 2025 | No config file, faster builds, `@import "tailwindcss"` only |
| `@tauri-apps/api/tauri` (invoke path) | `@tauri-apps/api/core` | Tauri 2 release | Breaking change from Tauri 1; scaffold already correct |
| `allowlist` in tauri.conf.json | Capability files in `src-tauri/capabilities/` | Tauri 2 release | More granular permission model |
| `export let x` for component props | `$props()` rune | Svelte 5 release | Svelte 5 runes are the current paradigm; no Svelte 4 patterns |
| `on:click={handler}` event syntax | `onclick={handler}` | Svelte 5 release | DOM event attributes directly |

**Deprecated/outdated:**
- `@tailwind base; @tailwind components; @tailwind utilities;` — Tailwind v3 directives; replaced by `@import "tailwindcss"` in v4
- `svelte-kit sync` — SvelteKit-specific; removed after migration
- `tauri-plugin-opener` — Scaffold default; not needed for Trunk; remove
- `"./.svelte-kit/tsconfig.json"` extension — SvelteKit generated; replace tsconfig.json entirely

---

## Open Questions

1. **serde enum serialization — string vs variant name**
   - What we know: Rust `#[derive(Serialize)]` on enums serializes as the variant name by default (e.g., `"Straight"`, `"MergeLeft"`). TypeScript string literal union uses the same strings.
   - What's unclear: Whether serde's default snake_case rename applies to enum variants. By default, serde does NOT rename enum variants — `Straight` serializes as `"Straight"`, not `"straight"`. This matches the TypeScript union types defined above.
   - Recommendation: Verify with a quick `cargo test` printing JSON output once `git/types.rs` compiles. If case mismatch occurs, add `#[serde(rename_all = "camelCase")]` or keep as-is.

2. **tauri-plugin-dialog JS package name**
   - What we know: Rust crate is `tauri-plugin-dialog = "2"`. JS package is `@tauri-apps/plugin-dialog`.
   - What's unclear: Whether `@tauri-apps/plugin-dialog` needs to be explicitly installed or comes with `@tauri-apps/api`.
   - Recommendation: Run `bun add @tauri-apps/plugin-dialog` explicitly during setup. The `open` function import `from "@tauri-apps/plugin-dialog"` will fail without the package.

3. **git2 0.19 system libgit2 dependency on macOS**
   - What we know: `git2` crate links against `libgit2`. The `bundled` feature bundles libgit2 statically; without it, a system libgit2 must be present.
   - What's unclear: Whether the current project uses `bundled` feature or requires `brew install libgit2`. `git2 = "0.19"` without features means system libgit2.
   - Recommendation: If `cargo build` fails with "libgit2 not found", add `git2 = { version = "0.19", features = ["bundled"] }`. The bundled feature adds build time but removes the system dependency. Prefer bundled for portability.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | None yet — no test infrastructure in scaffold |
| Config file | Wave 0 creates none — Phase 1 is infrastructure, compile checks suffice |
| Quick run command | `cargo build` (Rust) + `bun run check` (TypeScript) |
| Full suite command | `cargo build && bun run check` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFRA-01 | `bun run dev` launches as plain Vite+Svelte SPA with no SvelteKit routes | smoke | `bun run build` (build succeeds without SvelteKit) | Wave 0 creates index.html + main.ts |
| INFRA-02 | `cargo build` passes with all 4 crates present | compile | `cd src-tauri && cargo build` | Wave 0 modifies Cargo.toml |
| INFRA-03 | error.rs, state.rs, git/types.rs compile and are declared in lib.rs | compile | `cd src-tauri && cargo build` | Wave 0 creates these files |
| INFRA-04 | Tailwind v4 utility classes apply in browser; dark theme visible | smoke | `bun run build` (CSS emitted without errors) | Wave 0 creates app.css |

All four requirements are validated by compile/build checks — no unit test framework needed for Phase 1. The success criteria are binary: builds pass or they don't.

### Sampling Rate

- **Per task commit:** `cargo build` (Rust track tasks) or `bun run build` (frontend track tasks)
- **Per wave merge:** `cargo build && bun run build && bun run check`
- **Phase gate:** All three commands green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `index.html` — root entry point (replaces `src/app.html`)
- [ ] `src/main.ts` — Svelte mount entry
- [ ] `src/App.svelte` — placeholder root component
- [ ] `src/app.css` — `@import "tailwindcss"` + CSS custom properties
- [ ] `src/lib/types.ts` — all 10 DTO TypeScript interfaces
- [ ] `src/lib/invoke.ts` — `safeInvoke<T>` wrapper
- [ ] `src-tauri/src/error.rs` — `TrunkError`
- [ ] `src-tauri/src/state.rs` — `RepoState`
- [ ] `src-tauri/src/git/types.rs` — all Rust DTO structs
- [ ] `src-tauri/src/git/mod.rs` — stub mod with re-exports
- [ ] `src-tauri/src/git/repository.rs` — stub
- [ ] `src-tauri/src/git/graph.rs` — stub
- [ ] `src-tauri/src/commands/mod.rs` — stub
- [ ] `src-tauri/src/commands/repo.rs` — stub
- [ ] `src-tauri/src/commands/history.rs` — stub
- [ ] `src-tauri/src/commands/branches.rs` — stub
- [ ] `src-tauri/src/commands/staging.rs` — stub
- [ ] `src-tauri/src/commands/commit.rs` — stub
- [ ] `src-tauri/src/commands/diff.rs` — stub
- [ ] `src-tauri/src/watcher.rs` — stub
- [ ] Framework install: `bun add -D tailwindcss @tailwindcss/vite` + `bun add @tauri-apps/plugin-dialog`

---

## Sources

### Primary (HIGH confidence)

- `/Users/joaofnds/code/trunk/.planning/research/STACK.md` — Verified stack versions from Cargo.lock and node_modules; migration steps
- `/Users/joaofnds/code/trunk/.planning/research/PITFALLS.md` — Critical pitfalls from domain research; git2 lifetime traps, Tauri error handling
- `/Users/joaofnds/code/trunk/PRD.md` — Authoritative source for DTO structs, module structure, architecture decisions
- `/Users/joaofnds/code/trunk/.planning/phases/01-foundation/01-CONTEXT.md` — Locked decisions from user discussion
- `/Users/joaofnds/code/trunk/src-tauri/Cargo.toml` — Current Rust dependencies baseline
- `/Users/joaofnds/code/trunk/package.json` — Current JS dependencies baseline
- `/Users/joaofnds/code/trunk/tsconfig.json` — Current TypeScript config (needs replacement)
- `/Users/joaofnds/code/trunk/src-tauri/capabilities/default.json` — Existing capabilities file (needs update)
- Tailwind v4 official docs (fetched 2026-03-03) — `@import "tailwindcss"` syntax verified

### Secondary (MEDIUM confidence)

- Training knowledge (August 2025 cutoff) — Svelte 5 `mount()` API, Tauri 2 plugin init patterns, `notify-debouncer-mini` usage; aligns with STACK.md findings

### Tertiary (LOW confidence)

- None — all claims have HIGH or MEDIUM support

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions from existing lockfiles; STACK.md is the authoritative reference
- Architecture patterns: HIGH — derived from PRD.md decisions + CONTEXT.md locked decisions
- Pitfalls: HIGH — grounded in PITFALLS.md which documents git2/Tauri behavior patterns
- Tailwind v4 CSS syntax: HIGH — verified via official docs fetch

**Research date:** 2026-03-03
**Valid until:** 2026-09-03 (stable technologies; Tauri 2 API changes slowly; Svelte 5 runes API stable)
