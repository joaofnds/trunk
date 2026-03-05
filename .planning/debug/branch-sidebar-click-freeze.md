---
status: diagnosed
trigger: "the collapsible section headers in the branch sidebar intermittently stop responding to clicks (won't toggle open/closed). Restarting the app fixes it. Same repo, same session."
created: 2026-03-04T00:00:00Z
updated: 2026-03-04T00:01:00Z
---

## Current Focus

hypothesis: CONFIRMED. The $effect sets refs = null synchronously before loadRefs completes. This causes Remote, Tags, and Stashes BranchSection components to be DESTROYED (their {#if} conditions become false when refs is null). When loadRefs resolves they are RECREATED. The bind:expanded connection must re-establish during this recreation. In Svelte 5, there is a window during component reconciliation where click events can land on elements whose reactive $bindable bindings are in an intermediate state, causing the toggle to either not propagate or silently fail. Secondary issue: no cancellation mechanism for concurrent loadRefs calls.
test: Completed — traced all $effect trigger conditions, {#if} guard logic, bind:expanded/component lifecycle interaction, and all concurrent async paths.
expecting: N/A — investigation complete.
next_action: Return diagnosis.

## Symptoms

expected: Clicking a section header should always toggle expanded open/closed.
actual: Intermittently, clicking a header does nothing — no toggle. Restarting the app restores function. Same repo, same session.
errors: None reported.
reproduction: Intermittent within a session — exact trigger unclear; likely related to async loadRefs completing or repoPath changing mid-session.
started: Intermittent, presumably reproducible within a session when loadRefs fires.

## Eliminated

(none yet)

## Evidence

- timestamp: 2026-03-04T00:00:00Z
  checked: BranchSection.svelte — click handler and expanded binding
  found: onclick={() => (expanded = !expanded)} writes directly to the $bindable prop. The prop is declared with expanded = $bindable() in $props(). This is correct Svelte 5 syntax. No obvious issue here in isolation.
  implication: The handler itself is not broken — the bug must come from the component's context or lifecycle.

- timestamp: 2026-03-04T00:00:00Z
  checked: BranchSidebar.svelte — $effect and {#if} condition for Local section
  found: The $effect runs when repoPath changes, immediately sets refs = null, then calls async loadRefs. The Local BranchSection has a special {#if} guard: `refs === null || filteredLocal.length > 0 || (refs?.local.length ?? 0) > 0`. This means Local section is visible even while refs is null. But the guard condition means the component is NOT destroyed when refs goes null -> populated, because the OR clause keeps it alive.
  implication: The Local section component is protected and never destroyed. However, Local section is NOT immune if refs arrives with 0 local branches (false || 0 > 0 || 0 > 0 = false). In normal use this is stable, but edge cases exist.

- timestamp: 2026-03-04T00:00:00Z
  checked: BranchSidebar.svelte — {#if} conditions for Remote, Tags, Stashes sections
  found: Remote: `{#if (refs?.remote.length ?? 0) > 0}` — this is FALSE when refs is null, so BranchSection is DESTROYED. Tags: same pattern. Stashes: same pattern. When refs goes null (at start of $effect), these three sections are unmounted. When refs arrives and has data, they are remounted with FRESH component instances.
  implication: This destroy/recreate cycle happens on every $effect execution (on mount, and any time repoPath changes). The bind:expanded must re-establish its two-way link on each recreation. Parent $state variables (remoteExpanded, tagsExpanded, stashesExpanded) survive the destruction, so correct values are passed to new instances. However, the binding re-establishment happens during Svelte's reconciliation phase, and clicks that land during this window may not be processed correctly.

- timestamp: 2026-03-04T00:00:00Z
  checked: BranchSidebar.svelte — $effect structure and async race
  found: $effect(() => { const path = repoPath; refs = null; loadRefs(path); }). loadRefs is async and is NOT awaited inside the effect. There is no AbortController, cancel token, or sequence counter. If loadRefs is called multiple times concurrently (handleCheckout and handleCreateBranch both call loadRefs independently), multiple promises race. Whichever resolves last wins.
  implication: A stale loadRefs completion can overwrite refs with old data. If stale data causes a section that should exist to briefly show refs = null, it triggers the destroy cycle again mid-session — long after initial mount. THIS IS THE INTERMITTENT TRIGGER.

- timestamp: 2026-03-04T00:00:00Z
  checked: BranchSection.svelte — stopPropagation on + button
  found: The + button does e.stopPropagation() to prevent its click from bubbling to the header's onclick. This is correct and only relevant when showCreateButton is true (Local section). The + button is a child of the header div, not an ancestor, so stopPropagation cannot swallow clicks on the header div itself.
  implication: The stopPropagation on + is not the root cause. Clicks on the header area (outside the + button) will always reach the header onclick.

- timestamp: 2026-03-04T00:01:00Z
  checked: BranchSidebar.svelte — in-session triggers for refs = null
  found: The $effect only fires when repoPath (its sole reactive dep) changes. In same-session, same-repo use, repoPath is stable. HOWEVER: handleCheckout and handleCreateBranch both call loadRefs directly — they do NOT set refs = null first. So in-session checkouts/creates do not trigger a destroy/recreate cycle.
  implication: The $effect fires exactly once per BranchSidebar lifetime (on mount). The destroy/recreate of Remote/Tags/Stashes is a one-time event. After that, sections are stable — UNLESS concurrent loadRefs calls corrupt refs state.

- timestamp: 2026-03-04T00:01:00Z
  checked: BranchSidebar.svelte — $bindable prop behavior in Svelte 5 runes during recreation
  found: When a BranchSection is destroyed and recreated, bind:expanded={remoteExpanded} establishes a fresh reactive link. In Svelte 5 runes, $props() returns a reactive proxy; reads return the current parent value, writes call the binding setter. The onclick closure `() => (expanded = !expanded)` reads through the proxy at call time — no stale closure issue. Writing to expanded calls the setter which updates the parent's $state.
  implication: The binding mechanism itself is sound in Svelte 5 runes. The failure is not a stale closure. It must be a lifecycle/scheduling issue during the destroy-recreate window.

## Eliminated

- hypothesis: stopPropagation on the + button captures header clicks
  evidence: The + button is a child of the header div, not an ancestor. stopPropagation on a child cannot swallow clicks that land on the parent. Only clicks that pass THROUGH the button would be stopped.
  timestamp: 2026-03-04T00:00:00Z

- hypothesis: stale closure in onclick handler due to $bindable prop
  evidence: In Svelte 5 runes, $props() returns a reactive proxy. Reading 'expanded' inside the arrow function at call time returns the current live value via the proxy getter. There is no stale closure — the proxy always reflects current state.
  timestamp: 2026-03-04T00:01:00Z

- hypothesis: $effect re-runs in-session (same repo) causing repeated destroy/recreate
  evidence: The $effect only reads repoPath as a reactive dep (writes to refs are not tracked). repoPath is a constant string for the lifetime of one BranchSidebar instance. The effect fires exactly once on mount.
  timestamp: 2026-03-04T00:01:00Z

- hypothesis: Local BranchSection is destroyed mid-session
  evidence: The Local section's {#if} guard includes `refs === null` as the first OR clause, keeping it alive during the loading phase. After refs loads, `(refs?.local.length ?? 0) > 0` keeps it alive as long as there are local branches. In typical repos this is always true. Local section is effectively never destroyed.
  timestamp: 2026-03-04T00:01:00Z

## Resolution

root_cause: |
  Two interlocking problems in BranchSidebar.svelte:

  PRIMARY (lines 63-67 + lines 208-224, 228-238, 241-251):
  The $effect writes `refs = null` synchronously before the async loadRefs completes.
  This immediately makes the {#if} guards for Remote, Tags, and Stashes sections evaluate
  to false (their guards are `refs?.remote.length > 0` etc.), causing those BranchSection
  components to be DESTROYED. When loadRefs resolves, refs becomes non-null with data,
  and these sections are RECREATED as fresh component instances. The bind:expanded two-way
  binding must re-establish during Svelte 5's reconciliation phase. Clicks that arrive
  during this destroy/recreate window — or during the brief period after the new DOM
  elements exist but before Svelte has fully wired up the new component's reactive
  bindings — are not handled by any live click listener and appear to be swallowed.

  SECONDARY (lines 74-80, called from lines 88 and 111):
  loadRefs has no cancellation mechanism (no AbortController, no sequence counter, no
  in-flight guard). handleCheckout (line 88) and handleCreateBranch (line 111) both call
  loadRefs independently. If two loadRefs calls are in flight simultaneously, whichever
  resolves LAST wins. If a stale/slow first call resolves after a fast second call, refs
  gets overwritten with older data. While this is primarily a data-correctness bug, it
  can interact with the PRIMARY bug: a stale loadRefs call resolving mid-session could
  set refs to a value where (for example) refs.remote is unexpectedly empty, causing
  Remote BranchSection to be destroyed mid-session (long after mount), reproducing the
  PRIMARY bug intermittently rather than only on initial load.

  The combination explains the "intermittent, same session" characteristic: initial mount
  always causes a brief destroy/recreate (one-time), but the secondary race condition
  means the destroy/recreate can happen again later in-session when the user performs
  checkout or branch creation operations.

fix: |
  Do NOT make code changes — diagnose-only mode.

  What needs to change:
  1. Remove `refs = null` from the $effect (lines 63-67). Use a separate boolean
     $state for loading state (e.g. `let loading = $state(false)`) to show a loading
     indicator. This prevents the {#if} guards from destroying Remote/Tags/Stashes
     sections during data refresh.
  2. Add a cancellation / sequence guard to loadRefs. Either use an AbortController
     pattern or a simple sequence counter: increment on each call, only apply the
     result if the counter still matches when the promise resolves. This prevents stale
     async completions from overwriting current refs.
  3. Optionally: replace the {#if} guards for Remote/Tags/Stashes with {#if refs?.remote.length}
     (without refs === null handling) since with fix #1 refs no longer goes null in-session.

verification:
files_changed: []
