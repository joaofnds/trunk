# Visual regression suite

`just visual` renders the real application in Playwright's WebKit against the repositories
the fixture crate builds, screenshots the graph column of the commit list for each, and
compares every capture with its committed baseline in `tests/visual/baselines/`. It is part
of `just check` and has its own CI job, `Visual Baselines`, on `macos-latest`.

It exists because every other graph suite runs without a layout engine. The render goldens
compare SVG markup, in which an erased rail and a drawn one are identical, and TRUNK-255 ran
six sessions of green checks against a graph that was empty on screen (revert `409d34b3`).
A green render golden is not evidence the graph draws. This suite is the one that looks.

Why it is built this way, what gets a baseline, and why a pixel may drift 24 levels before
it differs are in
[decisions/2026-09-26-visual-regression-baselines.md](decisions/2026-09-26-visual-regression-baselines.md).

## Running it

```bash
mise exec -- just visual
```

The recipe builds `app_host` and the `fixtures` binary, then runs
`vitest --config vitest.visual.config.ts`. It needs Playwright's WebKit, which no recipe
installs, so `just check` fails at the suite's setup on a machine without it. Install it
once:

```bash
mise exec -- bunx playwright install webkit
```

`TRUNK_VISUAL_PAGES` sets how many pages capture at once (default 4).

Vite serves the page from the project's own `vite.config.ts`, so a change to how the app is
built reaches the captures. The suite drops one plugin from that config,
`vite-plugin-svelte-testing-library`: inside any vitest process it empties the browser's
resolve conditions, and the page then loads Svelte's server build. The harness throws when
that plugin is no longer in the config, so the filter cannot outlive it. Vite's dependency
cache for the suite is `node_modules/.vite-visual`, apart from the shared one, because the
suite runs with `NODE_ENV=test` and the shared cache's hash differs, so each `just dev` would
otherwise send the next run through dependency optimization again.

## A capture differs

A difference is a suspected break until someone has looked at it. A pixel differs when any
of its four channels (red, green, blue, alpha) is more than 24 levels of 255 from the
baseline's. The failing test names the repository and the number of differing pixels, and
writes two files to `tests/visual/differences/` (gitignored):

- `<name>.capture.png`, what the app drew this run;
- `<name>.difference.png`, the baseline dimmed to grey with every differing pixel in red.

A capture with no baseline writes only `<name>.capture.png`.

In CI the same directory is uploaded as the `visual-differences` artifact.

Look at the difference image first. If the change is not intended, it is a defect: fix the
code, not the baseline.

A repository whose first row does not draw within 10 seconds fails with the commands the
host still owed the page, rather than at vitest's timeout.

## Accepting a change

Only at the user's explicit direction, and only after looking at the difference:

```bash
mise exec -- just visual-accept "why the new rendering is intended"
```

It refuses without a reason. With one, it rewrites every baseline that differs by more than
the tolerance and writes each missing one, then appends the date, the reason and the changed
files to [visual-baseline-changelog.md](visual-baseline-changelog.md), and clears the
differences. A capture within the tolerance leaves its baseline as it was. Review the change
as an image diff before committing it (GitHub's rich diff for PNGs, or `git difftool` with
an image viewer). Never set `TRUNK_ACCEPT_VISUAL_BASELINES` by hand: it skips the changelog.

A new repository in the `graph-lanes` or `graph-merges` case fails the suite twice until it
is accepted. The coverage test fails because the list in `graph.test.ts` does not name it,
and once it is named, its capture has no baseline. Removing a repository leaves its baseline
behind with nothing to flag it, so delete the PNG in the same change.

## Wall time

Measured 2026-09-26 on this 18-core Apple Silicon Mac, Playwright 1.63.0 WebKit, 29 tests
(28 captures and the coverage test), builds warm:

| Configuration | Wall time |
|---|---|
| `just visual`, the whole recipe with the cargo no-op build | 4.49, 4.10, 4.13 s |
| vitest alone | 3.88, 3.84, 3.82 s |

Load averages over one minute were 4.3 to 6.7 for these runs, from the other sessions on the
machine. A reviewer's run of an earlier, slower version took 17.38 s with load averages of
11.57, 7.46 and 5.48, after waiting 3.64 s on another build's cargo lock. That is one sample,
and whether the suite stays in `just check` on a shared machine is an open question on
TRUNK-100.

Where the time goes, measured per capture at three pages: retiring the last host, spawning a
new one and writing the prefs 25 to 40 ms, loading the app 55 ms, drawing the first row
95 ms, settling 75 ms. Settling always takes two screenshots, since the second must match the
first. Before the first capture, Vite starts in about 130 ms and WebKit in about 270 ms, the
fixture build takes about 800 ms, and the pages finish loading the app about 1.2 s in.
Teardown takes about 160 ms.

Every speed alternative measured, vitest alone, each row adding to the one above unless it
says otherwise. Rows sharing a round were run in rotation, so the load hit each alike:

| Configuration | Wall time |
|---|---|
| Each capture loads every module from Vite (3 pages) | 5.95, 6.09 s |
| The browser caches the app's modules for the run | 4.55 to 4.70 s |
| Vite transforms the app's modules while the fixtures build | 4.01 to 4.26 s |
| Dependency cache apart from the shared one | 4.03 to 4.13 s, and 4.03 s from a cold cache |
| The page served from `vite.config.ts` instead of a restated config | 4.16 s |
| Readiness on the first row, and teardown that survives a failed setup | 4.32 s |
| Captures span the rows, in a window 1000 px tall (round A) | 4.32 to 4.45 s |
| The pages load the app while the fixtures build (round A) | 4.19 to 4.59 s, median 4.24 s |
| 1 page (round B) | 8.37, 8.27 s |
| 2 pages (round B) | 5.34, 5.00 s |
| 4 pages (round A), the default | 3.80 to 3.84 s |
| 6 pages (round A) | 3.88 to 3.94 s |

Six pages spent about 0.4 s more CPU than four for no gain, and each page carries its own
`app_host`, so four is the default on a machine several sessions share.

Alternatives not taken:

- Serving `vite.config.ts` with every plugin broke the page: `svelteTesting` made it load
  Svelte's server build, which is why that plugin is filtered.
- One `app_host` shared by every capture. Spawning one takes about 8 ms, so sharing would
  save under 0.1 s, and a shared host carries the prefs one capture writes into the next.
- Caching the fixture build between runs. The pages finish loading after the fixtures are
  built, so the build is no longer what the captures wait on.
- One browser context for every page, so the pages share one HTTP cache. In one rotation,
  separate pages took 3.87 to 3.98 s, one context loading every page at once 3.86 to 3.96 s,
  and one context loading a first page before the others 3.99 to 4.11 s. Each page loads the
  app once, before the first capture, so a shared cache has only that load to save.
- Mounting `CommitGraph.svelte` alone on the committed layout exports measured 3.99 s for 49
  fixtures during shaping (doc-149), but it bypasses the real app and its commands, so it is
  not the end-to-end render the suite is for.

## What it does not cover

- The system's WebKit. Playwright ships its own WebKit build (626+ for Playwright 1.63), not
  the WKWebView Trunk renders in on macOS. A macOS update that changes only the system
  WebKit passes this suite. Playwright's build still draws through the system's CoreGraphics,
  CoreText and QuartzCore, so a macOS update can move the captures that way, and a Playwright
  bump changes the engine the baselines pin. Treat a suite-wide failure after either as that:
  look at the images, and accept with the reason.
- Text. The capture holds no label: the column header and the ref pills are outside it, and
  GitHub's `macos-latest` runner draws text up to 36 levels away from this Mac.
- Ref pills, which sit in the Branch/Tag column.
- The `06-stash-lanes` repositories, so the dashed-square stash marker and stash placement
  against the WIP row have no baseline.
- A panned graph column. No capture pans it, so a break that shows only while it is panned
  passes.
- The diff pane (TRUNK-288).

TRUNK-289 proposes capturing the stash repositories, the pills and a panned column.

Every capture holds all of its repository's rows. A repository whose commit list would scroll
in the 1000 px window fails its capture and says to raise the window's height, rather than
leaving its last rows uncompared.
