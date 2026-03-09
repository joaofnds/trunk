# Quick Task 5: Fix graph pane flicker on commit - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Task Boundary

The UI flickers a lot when committing — the graph pane flickers. The root causes are:
1. `{#key graphKey}` in App.svelte destroys/recreates the entire CommitGraph component on every refresh
2. Double `repo-changed` events (explicit emit from Rust commit handler + filesystem watcher ~300ms later) cause two full destroy/recreate cycles
3. No loading state preservation — graph goes blank (skeleton) before re-rendering

</domain>

<decisions>
## Implementation Decisions

### Graph remount strategy
- Use in-place data refresh: keep CommitGraph mounted, re-fetch data into existing state. Do NOT destroy/recreate the component. This preserves scroll position and avoids DOM teardown/skeleton flash.

### Double event deduplication
- Frontend debounce only: add a debounce/dedup guard on the `repo-changed` listener in App.svelte. No Rust-side changes needed.

### Loading state during refresh
- Keep old data visible while fetching new data, then swap in seamlessly. User sees no interruption — no skeleton flash, no spinner.

### Claude's Discretion
- Implementation details of the debounce mechanism (timing, approach)
- Whether to expose a `refresh()` method on CommitGraph or use a reactive signal

</decisions>

<specifics>
## Specific Ideas

- Remove `{#key graphKey}` wrapper around CommitGraph in App.svelte
- Add a reactive trigger (e.g. a `refreshSignal` prop or event) that CommitGraph listens to for re-fetching data in place
- CommitGraph should reset its `commits` array and re-fetch from offset 0 when triggered, but keep the component mounted
- Frontend debounce on `repo-changed` handler (~100-300ms) to collapse the double events

</specifics>
