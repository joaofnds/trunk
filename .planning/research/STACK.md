# Technology Stack

**Project:** Trunk — Desktop Git GUI
**Researched:** 2026-03-03
**Confidence:** HIGH (versions verified from installed lockfiles and package.json)

---

## Recommended Stack

### Runtime & Toolchain

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Rust | 1.93.1 | Backend runtime | Pinned via mise.toml; edition 2021 targets; Tauri 2 requires stable |
| Bun | 1.3.8 | JS package manager + dev server runner | Pinned via mise.toml; faster installs than npm/pnpm; Tauri dev workflow calls `bun run dev` |
| Node/TypeScript | TS 5.6.3 | Type checking | Bundled with svelte-check; `strict: true`, `moduleResolution: "bundler"` |

### Core Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Tauri | 2.10.2 (Rust crate) | Desktop shell, IPC bridge, native APIs | Installed version from Cargo.lock; Tauri 2 is the current stable major; significant API changes from Tauri 1 |
| tauri-build | 2.5.5 | Build script helper | Required by Tauri 2 build pipeline |
| @tauri-apps/api | 2.10.1 | JS-side IPC client | Provides `invoke`, `listen`, `emit`; matched to Tauri 2.x Rust side |
| @tauri-apps/cli | 2.10.0 | Dev/build CLI | Orchestrates Vite + Cargo pipeline |

### Frontend Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Svelte | 5.53.6 | UI framework | Installed version; Svelte 5 runes are the current paradigm; compile-time reactivity, zero runtime overhead |
| @sveltejs/vite-plugin-svelte | 5.1.1 | Vite integration | Handles `.svelte` compilation in the Vite pipeline |
| Vite | 6.4.1 | Build tool / dev server | Current major; required by Tauri 2 dev workflow (`devUrl: "http://localhost:1420"`) |
| svelte-check | 4.x | Type checking for .svelte | Validates TS in Svelte component scripts |

> **SvelteKit vs plain Vite+Svelte**: The scaffold currently uses SvelteKit 2.53.4 with
> `adapter-static`. This must be migrated to plain Vite+Svelte before UI work begins.
> A desktop app has no routing, SSR, or server-side needs. SvelteKit adds `+page.svelte`
> conventions, `.svelte-kit/` generated files, and a runtime adapter layer that is pure waste.
> Migration: replace `@sveltejs/kit` + `@sveltejs/adapter-static` with direct
> `@sveltejs/vite-plugin-svelte`, update `vite.config.js` to use `svelte()` plugin directly,
> convert `src/routes/+page.svelte` to `src/App.svelte`, update `index.html`.

### Styling

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Tailwind CSS | ^4.x (v4 with Vite plugin) | Utility-first styling | PRD specifies Tailwind; v4 uses `@tailwindcss/vite` plugin (no `tailwind.config.js` required); faster than v3 |
| CSS custom properties | native | Theme tokens (dark/light) | Dark theme by default; `--color-bg`, `--color-surface` etc. for future light mode |

**Install:**
```bash
bun add -D tailwindcss @tailwindcss/vite
```

Add to `vite.config.js`:
```js
import tailwindcss from "@tailwindcss/vite";
plugins: [svelte(), tailwindcss()]
```

Add to `src/app.css`:
```css
@import "tailwindcss";
```

> **Do NOT use Tailwind v3.** v3 requires `tailwind.config.js`, PostCSS config, and a
> JIT-incompatible setup with Vite 6. v4's `@tailwindcss/vite` is the correct integration.

### Rust — Git Backend

| Crate | Version | Purpose | Why |
|-------|---------|---------|-----|
| git2 | 0.19 | libgit2 bindings | PRD-mandated; covers all v0.1 local operations (open, revwalk, index, refs, diff, commit) |
| notify | 7 | Filesystem watching | PRD-mandated; cross-platform async file events |
| notify-debouncer-mini | 0.5 | Debounced fs events | PRD-mandated; `0.5.x` is compatible with `notify ^7`; 300ms debounce to avoid event storms |
| serde | 1.0.228 | Serialization | Already in Cargo.lock; `features = ["derive"]`; required for all Tauri command return types |
| serde_json | 1.0.149 | JSON bridge | Already in Cargo.lock; Tauri uses serde_json internally for IPC |
| tokio | 1.50.0 | Async runtime | Already pulled in by Tauri; needed for async command handlers |

**Add to `Cargo.toml`:**
```toml
git2 = "0.19"
notify = "7"
notify-debouncer-mini = "0.5"
```

### Tauri Plugins

| Plugin | Version | Purpose | When to Use |
|--------|---------|---------|-------------|
| tauri-plugin-opener | 2.5.3 | Open URLs/files with default app | Already in scaffold; not core to git UI |
| tauri-plugin-dialog | 2.x | Native file picker dialog | Required for `open_repo` — file dialog to select repository folder |
| tauri-plugin-fs | 2.x | Filesystem permissions | May be needed for reading git repository paths; evaluate when implementing watcher |

**Add for `open_repo`:**
```toml
# Cargo.toml
tauri-plugin-dialog = "2"
```
```json
// tauri.conf.json — permissions
"permissions": ["dialog:default"]
```
```ts
// Frontend
import { open } from "@tauri-apps/plugin-dialog";
```

---

## Tauri 2 Specifics vs Tauri 1

This matters because the scaffold is Tauri 2 and documentation for Tauri 1 is abundant but
wrong for this project.

| Concern | Tauri 1 (old) | Tauri 2 (current) |
|---------|--------------|-------------------|
| `invoke` import | `@tauri-apps/api/tauri` | `@tauri-apps/api/core` |
| Plugin crates | `tauri-plugin-*` via git | `tauri-plugin-*` published to crates.io |
| Plugin JS packages | `@tauri-apps/plugin-*` via npm | Same, but now stable on npm |
| Permissions model | `allowlist` in tauri.conf.json | Capability files in `src-tauri/capabilities/` |
| Mobile support | Not supported | Supported (iOS/Android) |
| `#[tauri::command]` | Same | Same |
| `tauri::Builder::default()` | Same | Same |
| Managed state | `tauri::State<T>` | Same |
| Event emit | `window.emit()` | `app_handle.emit()` or `window.emit()` |

The scaffold already uses the correct Tauri 2 import (`@tauri-apps/api/core`). The `tauri.conf.json`
uses `"$schema": "https://schema.tauri.app/config/2"`, confirming Tauri 2 format.

**Permissions (Tauri 2):** Plugins require explicit capability grants. Create
`src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for Trunk",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "opener:default"
  ]
}
```

---

## Svelte 5 Runes Patterns

The scaffold already uses Svelte 5 runes (`let name = $state("")` in `+page.svelte`).
The full project must use runes exclusively.

### Runes to Use

| Rune | Purpose | Example |
|------|---------|---------|
| `$state` | Reactive local state | `let commits = $state<GraphCommit[]>([])` |
| `$derived` | Computed values | `let hasChanges = $derived(status.unstaged.length > 0)` |
| `$effect` | Side effects (like `onMount` or `$:`) | `$effect(() => { fetchStatus(repoPath) })` |
| `$props` | Component props | `let { commit }: { commit: GraphCommit } = $props()` |
| `$bindable` | Two-way bindable props | Avoid for most cases; use for input bindings only |

### Runes to Avoid / Deprecations

| Old Pattern | Replacement | Reason |
|-------------|-------------|--------|
| `export let x` (props) | `$props()` | Svelte 5 convention |
| `$:` reactive statements | `$derived` / `$effect` | Rune equivalents are explicit |
| `on:click={handler}` | `onclick={handler}` | Svelte 5 uses DOM event attributes directly |
| Svelte stores (`writable`, `readable`) | `$state` objects | Runes replace stores in most cases; use stores only for cross-component shared state without prop drilling |
| `<svelte:self>` | Regular component import | Self-referential components work normally |

### Component Pattern for This Project

```svelte
<script lang="ts">
  import type { GraphCommit } from "$lib/types";

  let { commit, onSelect }: {
    commit: GraphCommit;
    onSelect: (oid: string) => void;
  } = $props();
</script>
```

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Desktop framework | Tauri 2 | Electron | Electron bundles Chromium + Node (~100MB); Tauri uses OS webview (~5-10MB); non-negotiable per project constraints |
| Desktop framework | Tauri 2 | Flutter | Different language (Dart); no Rust ecosystem access; no git2 integration |
| Frontend | Svelte 5 | React | Non-negotiable per constraints; also Svelte has less overhead for desktop |
| Frontend | Svelte 5 | SvelteKit | SvelteKit is wrong tool for single-window desktop app (no routing/SSR); must migrate away |
| Git backend | git2 0.19 | gitoxide (gix) | gix is pure-Rust and faster but API is less mature; git2 has broader API coverage for diff/index operations needed in v0.1 |
| Git backend | git2 0.19 | shell-out to git | Acceptable for remote ops (v0.2+) but not for local reads/writes due to parsing fragility |
| Styling | Tailwind v4 | Tailwind v3 | v4 uses `@tailwindcss/vite` for better Vite 6 integration; no config file required; faster build |
| Styling | Tailwind v4 | UnoCSS | Tailwind v4 is the standard; UnoCSS is an alternative but less community support for Svelte 5 |
| Package manager | Bun 1.3.8 | npm/pnpm | Project already uses Bun (pinned in mise.toml + bun.lock exists) |
| FS watching | notify 7 + debouncer-mini 0.5 | inotify directly | notify abstracts cross-platform differences; debouncer-mini prevents event storms on rapid file changes |

---

## Migration: SvelteKit -> Plain Vite+Svelte

This is the first task before any UI work. The current scaffold uses SvelteKit
(`svelte.config.js` imports `adapter-static`, `vite.config.js` uses `sveltekit()` plugin).

**Steps:**
1. Remove `@sveltejs/kit` and `@sveltejs/adapter-static` from devDependencies
2. Add `@sveltejs/vite-plugin-svelte` directly (already installed at 5.1.1 as a transitive dep)
3. Replace `vite.config.js` plugin: `sveltekit()` -> `svelte()`
4. Delete `svelte.config.js` (or simplify to just `vitePreprocess()`)
5. Move `src/routes/+page.svelte` -> `src/App.svelte`
6. Update `index.html` to use `src/main.ts` as entry (create `src/main.ts` that mounts `App.svelte`)
7. Update `tsconfig.json` to not extend `.svelte-kit/tsconfig.json`
8. Remove `.svelte-kit/` from project

**Result:** `vite build` outputs to `build/` (as already configured in `tauri.conf.json` `frontendDist: "../build"`)

---

## Type Safety Bridge: Rust <-> TypeScript

**v0.1 approach:** Manual TypeScript interfaces in `src/lib/types.ts` mirroring Rust structs.
All Rust command return types must have `#[derive(Serialize, Clone)]`; all command argument
types must have `#[derive(Deserialize)]`.

**Future (v0.2+):** `tauri-specta` generates TypeScript types from Rust automatically.
Not used in v0.1 to avoid adding complexity before the core workflow is validated.

---

## Installation

### Add to `src-tauri/Cargo.toml`

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
git2 = "0.19"
notify = "7"
notify-debouncer-mini = "0.5"
```

### Add to `package.json` (after SvelteKit migration)

```bash
bun remove @sveltejs/kit @sveltejs/adapter-static
bun add -D @sveltejs/vite-plugin-svelte tailwindcss @tailwindcss/vite
bun add @tauri-apps/plugin-dialog
```

---

## Sources

| Source | Confidence | Notes |
|--------|------------|-------|
| `/Users/joaofnds/code/trunk/src-tauri/Cargo.lock` | HIGH | Exact locked versions of tauri, serde, tokio |
| `/Users/joaofnds/code/trunk/node_modules/*/package.json` | HIGH | Exact installed versions of svelte, vite, tauri-apps/api |
| `/Users/joaofnds/code/trunk/package.json` | HIGH | Declared dependency ranges |
| `/Users/joaofnds/code/trunk/src-tauri/Cargo.toml` | HIGH | Declared Rust dependency ranges |
| `/Users/joaofnds/code/trunk/PRD.md` | HIGH | Architecture decisions and dependency choices |
| `/Users/joaofnds/code/trunk/mise.toml` | HIGH | Pinned Rust 1.93.1 and Bun 1.3.8 |
| Tauri 2 migration guide (training data, August 2025 cutoff) | MEDIUM | Tauri 1 vs 2 API differences; verify permissions model against https://v2.tauri.app/security/capabilities/ |
| Svelte 5 runes (training data, August 2025 cutoff) | MEDIUM | Rune syntax stable since Svelte 5.0.0 release; verify against https://svelte.dev/docs/svelte/what-are-runes |
| Tailwind v4 Vite integration (training data) | MEDIUM | `@tailwindcss/vite` is the v4 integration method; verify against https://tailwindcss.com/docs/installation/vite |
