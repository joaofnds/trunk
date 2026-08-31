# The application harness

A test drives the real Svelte component tree in a headless DOM, `invoke` reaches the real
`#[tauri::command]` functions, and those run against a real git repository on disk. No Tauri
IPC mock sits anywhere in the path.

```bash
just app-test
```

The recipe builds `src-tauri/examples/app_host` and runs `vitest.app.config.ts` over
`tests/app/`. It is part of `just check` and mirrored by the `Application Harness` job in CI,
a required check on `main`. It is deliberately not inside the `vitest` recipe: `just front`
and `just quick` are the tiers run most, and neither should wait on a Rust artifact.

## How it fits together

```
tests/app/*.test.ts          the tests
  └─ harness/index.ts        setup() / teardown()
       ├─ harness/host-client.ts   one host process per test, newline-delimited JSON
       ├─ harness/internals.ts     window.__TAURI_INTERNALS__, the invoke router
       ├─ harness/dom.ts           the jsdom polyfills
       ├─ fakes/                   menu, dialog, clipboard, opener, window, webview, path
       └─ drivers/                 repo, branches, staging, remote, review, rebase editor, events
```

`setup()` spawns a host, seeds a repository, installs the transport seam, runs the polyfills,
and mounts the same root `src/main.ts` mounts with the same two side effects. `teardown()`
unmounts, reaps the process and removes its tempdir.

**The host** (`src-tauri/examples/app_host.rs`) builds the real application on
`tauri::test::MockRuntime` from `trunk_lib::configure`, with the real capability set from
`trunk_lib::context()`. It answers five verbs on stdin: `seedRepo`, `invoke`, `emit`,
`watcherCount` and `shutdown`. One host process is one application is one test, and each gets
a fresh tempdir `HOME`, so every managed state and the resolved `app_data_dir` isolate without
a reset step — and writing to the installed app's data directory is structurally impossible.

**The seam is the global, never a module.** `@tauri-apps/api` reaches the runtime only through
`window.__TAURI_INTERNALS__`. Installing that before the root mounts means no `vi.mock`, no
hoisting, and nothing in `tests/app/harness/`, `tests/app/drivers/` or `tests/app/fakes/`
imports vitest — which is what makes the harness usable from another runner. A test asserts
that by inspection.

**Trunk's commands, the two event-registration commands and the frontend's own emits go to
the host.** The ACL check, the event id allocation and the Rust registration are all real. Only
the delivery hop is the harness's: Tauri delivers an event by evaluating a script this side
cannot observe, so the host mirrors each emit onto stdout and the harness dispatches from its
own id map. A frontend `emit` travels as the `plugin:event|emit` command rather than through
the host's own `emit` verb, so the plugin and the ACL are the real ones; the verb, which
`driver.events` uses to mirror the watcher, calls `app.emit` directly and skips both.

**Every other `plugin:` command goes to its Fake**, and one with no Fake and no host route
throws naming itself. That branch is load-bearing: nine commands answered `undefined` over the
old mocked transport with nothing noticing.

The menu Fake is the one worth knowing about. `@tauri-apps/api/menu` keeps no JavaScript
state — `isEnabled()` is an `invoke` — and it replaces every item's action with a `Channel`,
so a Fake that stored the action and called it would fire nothing. The Fake serializes the
argument object it is handed, decodes the `__CHANNEL__:` reference, and dispatches through
`runCallback`. That is what makes `driver.contextMenu.choose("Interactive Rebase...")` a
gesture, and what lets a test read an item's `enabled` flag by its label.

## What it covers today

The five interactive-rebase workflows that forced TRUNK-32's manual QA round
(`backlog/docs/doc-17`), in `tests/app/interactive-rebase.test.ts`: a reordered base commit,
a no-edit rebase that must not rewrite a hash, a rebase from the repository's root, a rebase
that stops with the toast it owes the user, and the fork-point entry point. Case 6 of that
document, the greyed-out menu item, stays deliberately outside: it is a predicate over
already-loaded data that crosses no boundary.

The stopped-rebase recovery workflow, in the same file: a drop that leaves the next commit
unappliable, the Abort that returns HEAD to `main` with the graph it started from, and the
same rebase retried and resolved — the conflicted file rewritten on disk, Mark All Resolved,
Continue Rebase — landing the graph with the dropped commit gone. Skip is offered on the
banner and deliberately not pressed; it is the same join as Continue with nothing staged.

The commit-actions workflow, in `tests/app/commit-actions.test.ts`: a revert whose message
rides the host-owned MessageEditor, the undo that removes it, and the redo that restores it
with the message it had — the message survives through the Redo stack, not the commit form.

The diff surfaces, in `tests/app/diff-surfaces.test.ts`: an unstaged edit read from the
panel, then a second file staged and its staged side read back. The two files carry different
edits, so the runtime choice between `diff_staged` and `diff_unstaged` cannot drift and still
show the right lines.

Branch mutation, in `tests/app/branch-mutation.test.ts`: a branch created through the
sidebar's + input lands as a graph pill with HEAD on it, and deleting it through the
confirmation dialog removes the row and the pill.

Stash, in `tests/app/stash.test.ts`: the toolbar stash clears the WIP row into a graph
stash and restores the committed file on disk; the pop reverses all three observations.

The rendered markdown diff, in `tests/app/markdown-diff.test.ts`: a deleted and an added
paragraph read from the plain diff, then the rendered toggle, and the same paragraphs read
back from the red and green blocks. A paragraph merely reworded would collapse to word-level
marks inside one block, so the fixture keeps the two changes structurally apart.

The merge editor, in `tests/app/merge-editor.test.ts`: a rebase conflict opened from the
conflicted row, the incoming side taken whole, and the save that leaves that side's content
on disk with the file in the resolved section.

History search, in `tests/app/history-search.test.ts`: the search bar opened through the
accelerator's `search-toggle` event (the host makes the same emit the native menu item
does), a query typed, and the match count and auto-selected first match read back.

The remote workflow, in `tests/app/remote.test.ts`: a push refused by a remote that has moved,
the recovery prompt it raises, and the pull (rebase) and second push that leave the branch
level with its upstream. Force Push is offered there and deliberately not pressed — the lease
refuses it in that fixture, which is a second scenario the budget has no room for.

The hunk-and-line staging workflow, in `tests/app/staging.test.ts`: staging one hunk of a
two-hunk file and reading the partial state back from the panel, then discarding two of three
inserted lines and reading the working-tree file back from disk. It runs in the default inline
hunk mode; the split and full-file views render the same four buttons and reaching either
costs a mode switch no criterion needs.

The review workflow, in `tests/app/review.test.ts`: a comment left on a hunk of a commit's
diff, the thread the review panel shows for it, the publish that keeps the thread and drops its
Delete action, the Mark done that only a human can give it, and the copied review doc carrying
the thread's heading and its state. Reading a thread card back needs care: `HunkView` renders
every thread a second time inside a hidden `.comment-probe` to measure its height, so a query
naming `.comment-card` alone answers with the probe's copy whether or not the panel ever
opened.

`backlog/docs/doc-26` ranks what still has no end-to-end test and is the queue new scenarios
come off; its §2 table carries the driven-command count and how to re-derive it.

## What it does not cover

The filesystem watcher is off — `WatcherState::disabled()`, so `open_repo` runs unchanged while
no watch is created — and `driver.events.externalChange(path)` fires the identical
`app.emit("repo-changed", path)` call `watcher.rs:45` makes. What that gives up is one link:
whether the watcher itself fires.

The macOS traffic-light reposition is off too, through `TrafficLights::disabled()`.
`WebviewWindow::ns_window()` under `MockRuntime` is built from a dangling `NSView*`, so asking
for the native window there segfaults the process. The command still runs; only the AppKit call
is skipped.

A headless DOM cannot observe layout and paint, scroll and virtualization, WKWebView-specific
rendering, native OS chrome, or real pointer gestures. Those still need a human or a render
golden. In particular jsdom lays nothing out, so `harness/dom.ts` stubs a 4000 px viewport —
without it the commit graph renders 22 rows however tall the fixture is, coherently and wrongly.
The same stub answers `clientWidth` as well as `clientHeight`, because the diff pane needs a
width too: `HunkView` withholds its rows entirely until the pane measures wider than zero, so
a diff opened without it renders no hunks at all and says nothing about why.

## Writing a test

```ts
const app = await setup({ repo: { steps: [
  { step: "file", path: "a.txt", content: "one" },
  { step: "commit", message: "First" },
] } });

await app.repo.open();

expect(app.repo.commitRows()).toEqual(["First"]);
```

The spec's steps map onto `TestContextBuilder` in `src-tauri/tests/common/builder.rs`; add a
variant on both sides to reach a shape it cannot build yet. Commits are day-spaced unless a
step pins `at`, because the graph sorts `TOPOLOGICAL | TIME` and same-second commits sort
arbitrarily.

Assert post-event state with `waitFor` rather than sleeping out the 200 ms `repo-changed`
debounce. `driver.settle()` is the fallback for a negative assertion — "nothing else
refetched" — which has no state to wait for, and it costs the whole quiet window.

`waitFor`'s 5 000 ms deadline is a safety net, not a budget, and it is not the thing to raise
when a run goes red. Measured over 448 waits, 336 on a quiet machine and 112 with the CPU
oversubscribed two to one: the slowest legitimate wait was 849 ms, it was a `settle()` paying
out its own quiet window, the mean was 51 ms, and none reached one second. Load did not move
those figures — the loaded suite took 23 s of wall against a 7.4 s median and its slowest wait
was 801 ms — because a wait is bounded by a round trip, not by the clock. So a wait that
reaches 5 000 ms is one whose state never arrived, and a longer deadline only makes the same
failure take longer to report.

`app.events.externalChange()` waits for the application's in-flight `listen` calls before it
emits, because registering a listener costs a host round trip. Two of the four `repo-changed`
registrations, `RepoView.svelte:836` and `StagingPanel.svelte:752`, had still not landed when
`repo.open()` returned, by a measured margin of one to four milliseconds. The real watcher
emits over and over and never notices a lost first event, so nothing in the product cares; a
test emits once, so the listener that missed it never hears about the change and the wait that
follows times out five seconds later saying only that the state never arrived (TRUNK-45).

## Budget

`just app-test` runs in **7.5 s** of wall time against a 10 s ceiling, with the host binary
already built: the median of twelve runs, each alternated against a run on the `forks` pool so
machine drift hit both arms. The same twelve runs on `forks` measured 9.4 s, and one of them
came in at 10.25 s — the ceiling was already being breached occasionally before the pool
changed. That is the recipe's own wall clock, not the `Duration` vitest prints, which comes out
about half a second smaller.

**Scenario count is not the budget term, and the cost is not per scenario.** Two things set the
wall clock:

1. **The Svelte compile, once per worker.** A single app-mounting test file costs 5.2 s on its
   own: 3.75 s of transform and 4.11 s of import for the application tree, against 240 ms of
   actual test. `tests/app/host-client.test.ts`, which never imports the app, costs 554 ms all
   in. This floor is most of the budget and no vitest setting removes it; `pool: "threads"`
   shares it between files where `forks` recompiles per worker, which is the 1.8 s that change
   bought.
2. **App boots**, at roughly 0.15 s each beyond the first few, running as wide as the machine
   has cores. One `it` that calls `setup()` is one boot.

File count is nearly free on a machine with cores to spare. Measured on `forks`, one
app-mounting file cost 5.16 s, two 5.96 s, four 6.26 s and six 8.71 s — the jump at the end is
the two files carrying nine and six boots, not the two extra files. Adding the review workflow,
a whole new file with a 335 ms scenario, moved the median by 0.05 s, which is smaller than the
spread of either arm it was measured against.

So the question to ask of a new scenario is how many application boots it adds, not how many
milliseconds its assertions take. Splitting a file to spread its scenarios does not help: boots
already run in parallel.

Two limits on every number here. They come from an 18-core machine, where six workers have
cores to spare; on a smaller machine the boots stop being free and file count starts costing
real time. And CI wall time is a different number (the job runs about six minutes) on a
2-core runner, and is not what this budget measures.

The boot count is not the whole marginal cost when a scenario is long. The stopped-rebase
recovery scenario (TRUNK-41.4) runs two full rebases, an abort and a `settle()`, about 4.5 s
of in-test time, and it moved the suite's wall clock to roughly 9 s: measured 2026-08-31 as an
8.9 / 9.0 / 9.2 s cluster across six runs on a machine at load average 8, with 16–21 s
outliers that are the contention, not the suite. A quiet-machine median was not obtainable
that day.

With all eleven TRUNK-41 workflows in, the quiet-machine measurement (2026-08-31, load
average ~2 at start, eight serial runs, all exit 0) is **10.2 s median**, a 9.9–10.6 s
cluster with two unexplained outliers at 19.0 s and 29.6 s that did not repeat — outlier
territory is tracked as TRUNK-44. **The 10 s ceiling is breached on a quiet machine.** The
budget decision (TRUNK-63) is the owner's; the first lever remains the compile floor above,
not trimming a workflow.

## Measuring the rendered DOM

The harness runs in jsdom, which computes no layout: every rect is zero, so it cannot answer
how tall anything renders. The Tauri window cannot be driven from a tool session either. So
pixel questions used to be settled by argument, and were wrong repeatedly.

```bash
just measure
```

That builds the host, puts it behind HTTP (`scripts/measure/bridge.ts`), and serves
`scripts/measure/index.html`, which mounts the same `App` with the same `TauriInternals` seam
and the same Fakes, pointed at that host. Open it in a browser and every element answers
`getBoundingClientRect()` for real, against a real seeded repository.

Use it before proposing a fix for anything measured in pixels, and again to check the fix. A
census of every distinct chrome height is a few lines in the console, and it finds the
elements nobody thought to look at.

The bridge reaches the real command set, destructive commands included, so it is not open to
whatever else the browser has open. Each run writes a random token to
`scripts/measure/.bridge-token.txt` (gitignored) and rejects every request that does not carry
it in `x-bridge-token`; the page reads the token as a `?raw` import and reaches the bridge
through Vite's `/bridge` proxy, so it is same-origin and there are no CORS headers. The
request handling lives in `scripts/measure/router.ts`, apart from the socket, so
`router.test.ts` can drive it directly — that is where to add a route, and where the
rejection cases are pinned.
