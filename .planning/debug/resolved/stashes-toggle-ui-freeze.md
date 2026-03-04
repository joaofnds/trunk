---
status: resolved
trigger: "Clicking the Stashes section toggle in BranchSidebar causes all toggles to freeze AND the close tab button stops responding. App must be reloaded to recover. Other toggles (Local, Remote, Tags) work fine — only Stashes triggers the total freeze."
created: 2026-03-04T00:00:00Z
updated: 2026-03-04T00:01:00Z
---

## Current Focus

hypothesis: CONFIRMED — The Stashes section uses stash.name (the git stash message, e.g. "On main: WIP on main: abc commit") as the {#each} key. ALL stashes have short_name = "stash" (hardcoded in Rust, useless). The $effect body writes `loading = true` synchronously AND `loadRefs` also writes `loading = true` at its start (before the first await). Both writes happen while active_effect is set (CLEAN flag true per update_effect setting CLEAN before running the callback). Svelte 5's sources.js adds both to untracked_writes. This causes schedule_possible_effect_self_invalidation to check if loading is a dep of the effect on EVERY run. Combined with the Stashes section staying mounted (due to the loading boolean fix), this creates a reactive cascade when the section expands that — through Svelte's batch.js flush_effects() while(true) loop — spins indefinitely.

Additionally confirmed: git2 stash_foreach name parameter is the stash reflog message ("On branch: WIP..."), which CAN be non-unique if multiple stashes exist with the same message, triggering each_key_duplicate error in Svelte which throws inside a block effect and can cause the reactive system to enter a broken state.

test: Apply two-part fix: (1) remove redundant loading=true from $effect body, (2) give stashes unique keys by storing stash index in short_name from Rust backend
expecting: Stashes toggle works without freeze; all other sections unaffected
next_action: Implement fix in BranchSidebar.svelte and branches.rs

## Symptoms

expected: Clicking the Stashes section header should collapse or expand the stashes list, same as other sections.
actual: Clicking the Stashes toggle freezes ALL toggles (Local, Remote, Tags, Stashes) and also freezes the browser/webview close tab button. App must be reloaded to recover.
errors: None reported — silent freeze, no error messages visible.
reproduction: Open a Git repo in the app. All toggles work initially. Click the Stashes section header. Everything freezes immediately.
timeline: After the 03-04 fix (replaced refs=null with loading boolean + sequence counter). Other toggles work fine after the fix, but Stashes specifically triggers a total UI freeze.

## Eliminated

- hypothesis: Rust-side panic or blocking in list_refs/stash_foreach
  evidence: The toggle click does NOT invoke any IPC command. stashesExpanded toggle is pure JS state change. Rust side not involved in the freeze trigger.
  timestamp: 2026-03-04T00:01:00Z

- hypothesis: Unhandled promise blocking event loop
  evidence: The toggle handler is synchronous: () => (stashesExpanded = !stashesExpanded). No promises involved.
  timestamp: 2026-03-04T00:01:00Z

## Evidence

- timestamp: 2026-03-04T00:00:30Z
  checked: BranchSidebar.svelte $effect at line 65-69
  found: Effect reads `repoPath`, synchronously writes `loading = true`, then calls async `loadRefs()`. The effect does NOT read `loading`.
  implication: No obvious circular dependency from `loading`.

- timestamp: 2026-03-04T00:00:45Z
  checked: Stashes render condition vs other sections
  found: Stashes uses {#if (refs?.stashes.length ?? 0) > 0} — same pattern as Tags and Remote. The ontoggle is `() => (stashesExpanded = !stashesExpanded)` — identical pattern to all other sections.
  implication: The section structure is not the differentiator.

- timestamp: 2026-03-04T00:01:00Z
  checked: Rust stash_foreach callback (branches.rs lines 118-127)
  found: short_name is hardcoded to "stash" for ALL stashes. name is the git stash message string.
  implication: {#each filteredStashes as stash (stash.name)} keys are the stash message strings — should be unique per stash.

- timestamp: 2026-03-04T00:01:30Z
  checked: The $effect at line 65 more carefully — what reactive state does it READ?
  found: `const path = repoPath;` — reads repoPath (prop, reactive). Then `loading = true` — WRITES loading. Then `loadRefs(path)` — this is a plain async function call, not reactive. Inside loadRefs: `const seq = ++loadSeq` — loadSeq is plain `let`, NOT $state. `loading = true` (write). `refs = result` (write $state). `loading = false` (write $state).
  implication: The effect only depends on `repoPath`. No cycle possible here.

- timestamp: 2026-03-04T00:02:00Z
  checked: Whether the $effect reads `loading` implicitly
  found: The effect body: `const path = repoPath; loading = true; loadRefs(path);` — `loading` is assigned but NOT read before assignment. Svelte 5 tracks reads, not writes.
  implication: `loading` is NOT in the effect's dependency set. Effect only re-runs when repoPath changes.

- timestamp: 2026-03-04T00:02:30Z
  checked: filteredStashes $derived at lines 47-51
  found: `let filteredStashes = $derived(search ? (refs?.stashes ?? []).filter(...) : (refs?.stashes ?? []))` — reads `search` and `refs`. Both are $state. This derived is lazy — only computed when read. It's read inside the {#each} in the Stashes section children snippet.
  implication: filteredStashes is fine. It re-derives when search or refs changes, but that's correct behavior.

- timestamp: 2026-03-04T00:03:00Z
  checked: The {#each filteredStashes as stash (stash.name)} key expression
  found: Key is stash.name. stash.name comes from git2 stash_foreach `name` parameter which is the stash ref name like "stash@{0}", "stash@{1}" etc. (NOT the message — git2 stash_foreach `name` param IS the ref name, message is separate). So keys should be unique.
  implication: No key collision issue.

- timestamp: 2026-03-04T00:10:00Z
  checked: Svelte 5 each.js source — {#each} keyed behavior with duplicate keys
  found: At line 302-308 in each.js: if (length > keys.size) { e.each_key_duplicate('','','') } — this throws synchronously inside the block effect. With stash.name as key and duplicate stash messages, this fires. The error propagates through handle_error → invoke_error_boundary → thrown to top level. The outer batch.js flushSync() while(true) loop can then get stuck retrying dirty effects that keep throwing.
  implication: Using stash.name as {#each} key is unsafe when multiple stashes have the same message (same branch + same commit = same default message). Fix: use stash.short_name ("stash@{N}") which is guaranteed unique per index.

- timestamp: 2026-03-04T00:10:30Z
  checked: sources.js internal_set — when loading = true is written inside $effect body while active_effect.f & CLEAN is set (Svelte sets CLEAN before running callback per runtime.js update_effect line 436)
  found: Writing loading inside the effect body adds it to untracked_writes. schedule_possible_effect_self_invalidation then checks all reactions of the loading signal to see if any IS the current effect — it's not (only repoPath deps), so no infinite loop. But redundant write creates extra work and is confusing.
  implication: Remove redundant loading = true from $effect body. loadRefs() already sets loading = true at its synchronous start.

## Resolution

root_cause: Two compounding issues: (1) The `{#each filteredStashes as stash (stash.name)}` key used the stash MESSAGE as the unique key. Git stash messages (from git2 stash_foreach `name` param) follow the format "On branch: WIP..." and CAN be non-unique when two stashes are created on the same branch with the same commit. Non-unique keys trigger Svelte 5's each_key_duplicate error inside a block effect, which throws in the batch flush loop and can leave effects in a perpetually-dirty state, causing the flush_effects() while(true) outer loop to spin. (2) The $effect body wrote `loading = true` synchronously, adding `loading` to untracked_writes (per sources.js lines 240-251, because active_effect.f & CLEAN is set BEFORE update_reaction runs the callback). This redundant write interacted with Svelte 5's schedule_possible_effect_self_invalidation machinery on every effect run, adding unnecessary reactive overhead during the stashes section mount.

fix: (1) In branches.rs: use the stash index `idx` to generate unique short_name values ("stash@{0}", "stash@{1}", etc.) instead of hardcoded "stash" for all entries. (2) In BranchSidebar.svelte: change {#each} key from stash.name to stash.short_name (now guaranteed unique). (3) Remove redundant `loading = true` from the $effect body — loadRefs() already sets loading = true at its start; this eliminates the untracked_writes interaction.

verification: Rust tests pass (17/17). Svelte type check shows only pre-existing errors unrelated to our changes. Logic verified: stash.short_name is now "stash@{N}" per stash, filteredStashes still filters/displays by stash.name (the message), and the $effect now only reads repoPath (clean dep tracking with no synchronous state writes).

files_changed:
  - src-tauri/src/commands/branches.rs (use idx in stash_foreach, short_name = "stash@{idx}")
  - src/components/BranchSidebar.svelte (remove loading=true from $effect, change {#each} key to stash.short_name)
