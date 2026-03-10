---
status: diagnosed
trigger: "Right-clicking on the header row of the commit list does nothing. There should be a context menu that allows toggling the visibility of each column."
created: 2026-03-09T00:00:00Z
updated: 2026-03-09T00:00:00Z
---

## Current Focus

hypothesis: Feature is entirely missing -- no context menu, no column visibility state, no conditional rendering
test: Searched entire src/ for contextmenu, oncontextmenu, columnVisibility, hiddenColumns
expecting: Zero matches confirms nothing exists
next_action: Document findings and architectural recommendation

## Symptoms

expected: Right-click on header row shows context menu with checkboxes for each column (Branch/Tag, Graph, Message, Author, Date, SHA); toggling hides/shows that column
actual: Right-click does nothing (default browser context menu may appear in dev, suppressed in Tauri)
errors: None -- missing feature, not a runtime error
reproduction: Right-click anywhere on the header row in CommitGraph
started: Never implemented

## Eliminated

- hypothesis: Feature exists but is broken
  evidence: grep for contextmenu, oncontextmenu, columnVisibility, hiddenColumns across src/ returned zero results; no context menu component exists in the project
  timestamp: 2026-03-09

## Evidence

- timestamp: 2026-03-09
  checked: src/components/CommitGraph.svelte (full read, 286 lines)
  found: |
    Header row is at lines 163-193. It is a plain `<div class="flex items-center px-2 flex-shrink-0">` with six child divs for the columns. No `oncontextmenu` handler exists. The six columns rendered are:
    1. Branch/Tag (ref) -- width: columnWidths.ref, has resize handle
    2. Graph -- width: columnWidths.graph, has resize handle
    3. Message -- flex-1, NO resize handle (fills remaining space)
    4. Author -- width: columnWidths.author, has resize handle
    5. Date -- width: columnWidths.date, has resize handle
    6. SHA -- width: columnWidths.sha, NO resize handle (last column)
    Column widths are loaded from store via getColumnWidths() and persisted via setColumnWidths().
  implication: The header row div is the target for oncontextmenu. Column visibility needs a parallel state alongside columnWidths.

- timestamp: 2026-03-09
  checked: src/lib/store.ts (full read, 85 lines)
  found: |
    Uses `@tauri-apps/plugin-store` with `LazyStore('trunk-prefs.json')`.
    Existing pattern: interface + const key + default + getter + setter, all async, all call store.save().
    ColumnWidths interface: { ref, graph, author, date, sha } (message is flex-1, no width).
    No column visibility state exists anywhere.
  implication: |
    New ColumnVisibility interface should follow the same pattern:
    - Interface: `ColumnVisibility { ref: boolean; graph: boolean; message: boolean; author: boolean; date: boolean; sha: boolean }`
    - Key: `'column_visibility'`
    - Default: all true
    - Getter/setter pair with save()

- timestamp: 2026-03-09
  checked: src/components/CommitRow.svelte (full read, 79 lines)
  found: |
    Props: { commit, onselect, maxColumns, columnWidths }.
    Renders all 6 columns unconditionally using the same column order and widths as the header.
    Each column is a separate div with explicit width from columnWidths (except Message which is flex-1).
    Connector line width (line 40) uses columnWidths.ref to calculate span.
  implication: |
    CommitRow needs a new `columnVisibility` prop to conditionally render columns.
    Each column div needs an `{#if columnVisibility.xxx}` wrapper.
    The connector line width calculation must also respect ref column visibility.

- timestamp: 2026-03-09
  checked: Entire src/ directory for existing context menu patterns
  found: |
    Zero matches for: contextmenu, context-menu, ContextMenu, oncontextmenu, right-click.
    No context menu component exists in the project.
    No Tauri menu plugin is installed (only @tauri-apps/api, plugin-dialog, plugin-store).
  implication: |
    This will be the first context menu in the app. Two implementation options:
    1. Pure HTML/CSS context menu (custom Svelte component) -- simpler, no new deps
    2. Tauri native menu via @tauri-apps/api Menu -- native feel, requires capability changes
    Recommendation: Pure HTML/CSS is simpler, consistent with the app's current approach of custom UI.

- timestamp: 2026-03-09
  checked: package.json and src-tauri/capabilities/default.json
  found: |
    Dependencies: @tauri-apps/api ^2, plugin-dialog ^2.6.0, plugin-store ^2.4.2
    Capabilities: core:default, dialog:allow-open, store:default
    No menu-related capability or plugin.
  implication: Using Tauri native menus would require adding a plugin dependency and capability. HTML context menu avoids this.

## Resolution

root_cause: |
  Feature is entirely unimplemented. Three things are missing:

  1. **No column visibility state** (store.ts): There is no `ColumnVisibility` interface, no store key, no getter/setter. The store only tracks `ColumnWidths` (numeric widths) but has no boolean visibility flags.

  2. **No context menu on header row** (CommitGraph.svelte): The header div at line 163 has no `oncontextmenu` handler. No context menu component exists anywhere in the project.

  3. **No conditional column rendering** (CommitRow.svelte + CommitGraph.svelte): Both the header row and CommitRow render all 6 columns unconditionally. There is no mechanism to hide a column.

fix: |
  Implementation plan (3 files to modify, 1 new component):

  **1. src/lib/store.ts -- Add ColumnVisibility state**
  ```typescript
  export interface ColumnVisibility {
    ref: boolean;
    graph: boolean;
    message: boolean;
    author: boolean;
    date: boolean;
    sha: boolean;
  }

  const COLUMN_VISIBILITY_KEY = 'column_visibility';
  const DEFAULT_VISIBILITY: ColumnVisibility = {
    ref: true, graph: true, message: true,
    author: true, date: true, sha: true,
  };

  export async function getColumnVisibility(): Promise<ColumnVisibility> {
    return (await store.get<ColumnVisibility>(COLUMN_VISIBILITY_KEY)) ?? DEFAULT_VISIBILITY;
  }

  export async function setColumnVisibility(v: ColumnVisibility): Promise<void> {
    await store.set(COLUMN_VISIBILITY_KEY, v);
    await store.save();
  }
  ```

  **2. New: src/components/HeaderContextMenu.svelte (or inline in CommitGraph)**
  - Pure HTML/CSS dropdown positioned at cursor
  - Shows checkbox for each column with label
  - Toggling calls `setColumnVisibility()` and updates local state
  - Closes on click-outside or Escape
  - Positioned via `style="left: {x}px; top: {y}px"` using mouse event coords

  **3. src/components/CommitGraph.svelte -- Wire up context menu + conditional rendering**
  - Import and manage `columnVisibility` state (same pattern as columnWidths)
  - Add `oncontextmenu` handler to header div (line 163):
    `oncontextmenu={(e) => { e.preventDefault(); showMenu(e.clientX, e.clientY); }}`
  - Wrap each header column div in `{#if columnVisibility.xxx}`
  - Pass `columnVisibility` to CommitRow
  - Render HeaderContextMenu when menu is open

  **4. src/components/CommitRow.svelte -- Respect visibility**
  - Add `columnVisibility` prop
  - Wrap each column div in `{#if columnVisibility.xxx}`
  - Adjust connector line calculation when ref column is hidden

  **Key design decisions:**
  - Message column should probably not be hideable (it's the primary data), or at minimum warn
  - At least one column must remain visible (prevent hiding everything)
  - Context menu should show column names with checkmarks/checkboxes
  - Visibility state persists via LazyStore alongside column widths

verification: N/A -- diagnosis only, feature not yet implemented
files_changed: []
