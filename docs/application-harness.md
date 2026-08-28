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
       └─ drivers/                 repo, branches, staging, rebase editor, events
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

**Trunk's commands and the two event-registration commands go to the host.** The ACL check,
the event id allocation and the Rust registration are all real. Only the delivery hop is the
harness's: Tauri delivers an event by evaluating a script this side cannot observe, so the host
mirrors each emit onto stdout and the harness dispatches from its own id map.

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

`backlog/docs/doc-26` ranks what still has no end-to-end test — 29 of the 115 registered
commands are driven here — and is the queue new scenarios come off.

## What it does not cover

The filesystem watcher is off — `WatcherState::disabled()`, so `open_repo` runs unchanged while
no watch is created — and `driver.events.externalChange(path)` fires the identical
`app.emit("repo-changed", path)` call `watcher.rs:24` makes. What that gives up is one link:
whether the watcher itself fires.

The macOS traffic-light reposition is off too, through `TrafficLights::disabled()`.
`WebviewWindow::ns_window()` under `MockRuntime` is built from a dangling `NSView*`, so asking
for the native window there segfaults the process. The command still runs; only the AppKit call
is skipped.

A headless DOM cannot observe layout and paint, scroll and virtualization, WKWebView-specific
rendering, native OS chrome, or real pointer gestures. Those still need a human or a render
golden. In particular jsdom lays nothing out, so `harness/dom.ts` stubs a 4000 px viewport —
without it the commit graph renders 22 rows however tall the fixture is, coherently and wrongly.

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

## Budget

`just app-test` runs in 8.4 s of **wall** time against a 10 s ceiling, with the host binary
already built: the median of three runs on a quiet machine. That is the recipe's own wall
clock, not the `Duration` vitest prints, which comes out about half a second smaller. The same
three runs on a loaded machine measured 8.8, 9.7 and 12.1 s, so a number taken while something
else is compiling says nothing. A scenario that boots the application and reads the graph costs
130-150 ms, one that waits out the debounce 275 ms, a full stage-and-commit workflow about
500 ms, and the remote workflow, which drives real `git` twice, about 560 ms. A test file costs
about 0.2 s of vite transform, so file count is a budget term, not a filing preference.

About a second and a half of headroom is left, which is two or three more scenarios. The ceiling is the
design constraint, not a target to negotiate: a suite that outgrows it is a decision for the
repository's owner — raise the budget, or move the suite out of `just check` — not a reason to
trim a workflow. CI wall time is a different number (the job runs about six minutes) and is
not what this budget measures.

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
