# Visual regression suite

`just visual` renders the real application in Playwright's WebKit against the repositories
four of the fixture crate's cases build, screenshots the graph column of the commit list for
each, and compares every capture with its committed baseline in `tests/visual/baselines/`. It
also captures the design catalog, below. It is part of `just check` and has its own CI job,
`Visual Baselines`, on `macos-latest`.

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

`TRUNK_VISUAL_PAGES` sets how many pages capture at once (default 5). vitest runs at most five
tests at once, so a sixth page is opened and never used.

Vite serves the page from the project's own `vite.config.ts`, so a change to how the app is
built reaches the captures. The suite drops one plugin from that config,
`vite-plugin-svelte-testing-library`: inside any vitest process it empties the browser's
resolve conditions, and the page then loads Svelte's server build. The harness throws when
that plugin is no longer in the config, so the filter cannot outlive it. Vite's dependency
cache for the suite is `node_modules/.vite-visual`, apart from the shared one, because the
suite runs with `NODE_ENV=test` and the shared cache's hash differs, so each `just dev` would
otherwise send the next run through dependency optimization again.

## The design catalog

`src/lib/ui/Catalog.svelte` draws every token in `src/tokens.css` and every primitive in
`src/lib/ui/` on one screen (`docs/design-system.md`). Nothing in the app mounts it. The
suite captures it as `catalog`, so a token or primitive that changes paint or geometry fails
here before any screen that uses it does, and a reader can see the system whole.

`tests/visual/catalog.test.ts` opens `tests/visual/page/catalog.html` through its own
`CatalogHarness`: one Vite server and one WebKit page, with no `app_host` and no fixture
repository, since the catalog binds to nothing. vitest runs it in parallel with the graph
file, so it adds well under a second to the suite.

The capture masks every element carrying `data-catalog-text` with Playwright's mask color,
solid magenta. GitHub's `macos-latest` runner draws text up to 36 levels away from this Mac
(the Text bullet under What it does not cover), so a baseline that held glyphs would fail on
CI for every run. Masked, the baseline pins the tokens and the primitives' size, shape and
color, and each masked label is sized by its layout cell rather than by its text, so a font
metric change moves nothing in the type, color or spacing sections. A button's width is its
label's advance width, so a change to the system font's metrics would move the right edges
in the Button section; that is the one place text metrics still reach the capture.

To look at the catalog in a browser, start the dev server and open the page:

```bash
mise exec -- bunx vite
```

Then visit `/tests/visual/page/catalog.html` on the port it prints.

## A capture differs

A difference is a suspected break until someone has looked at it. A pixel differs when any
of its four channels (red, green, blue, alpha) is more than 24 levels of 255 from the
baseline's. The failing test names the repository and the number of differing pixels, and
writes two files to `tests/visual/differences/` (gitignored):

- `<name>.capture.png`, what the app drew this run;
- `<name>.difference.png`, the baseline dimmed to grey with every differing pixel in red.

A capture with no baseline writes only `<name>.capture.png`. Each run empties the directory
before it starts, so every image in it comes from the last run.

In CI the same directory is uploaded as the `visual-differences` artifact.

Look at the difference image first. If the change is not intended, it is a defect: fix the
code, not the baseline.

A capture sets no deadline of its own, because how long a runner takes to draw says nothing
about what it draws (TRUNK-304). Each of its waits ends when the page shows what it waits for,
or when vitest abandons the test at its 20-second timeout, which stays as the guard against a
page that never draws. That failure carries a note listing the commands the host still owed
the page. A runner that takes over 20 s on one capture still fails. The slowest test capture
recorded on a runner, not counting a page's first, took 8.4 s.

Before any test runs, each page captures `kitchen-sink` once and discards it, because a page's
first capture costs more than its later ones and the five pages take their first at once. In
the `Visual Baselines` job, the first five captures took 6.8 to 7.7 s against a median of 2.4 s
for the later ones (run 36877062639), 8.8 to 9.3 s against 2.5 s (36935676980, second
attempt), 9.8 to 11.0 s against 2.4 s (36937152860), and 11.9 to 13.2 s against 3.7 s
(36935676980, first attempt). On this Mac the first capture costs about 0.1 s more than a later
one, so what the runners' first capture pays for is not known, nor whether it is paid once per
page or once per run. With the warm-up, the first five tests took 2.5 to 3.6 s against a
median of 1.2 s (36995691692), and 2.5 to 2.9 s against 2.3 s on a runner as slow as the four
above (36998434686). One run still paid about twice the median on its first five and the
other little more than the median, so how much of that cost the warm-up pays is not settled.
On a fast runner before the warm-up, 36874399859, the first five took 1.3 s against 0.8 s.

Setup, warm-up included, must finish inside vitest's 60-second hook timeout, and each of the
warm-up's waits ends at Playwright's 30-second default. Setup and teardown together took 17 to
22 s on the slower runners above whose logs could be read and 6 s on the fast one before the
warm-up, and 20 s and 31 s on the two runs with it, reckoned as the run's duration less the
time its tests took five at a time. A warm-up capture that fails is
ignored, and that repository's own test takes it again and reports the failure.

## Accepting a change

Only at the user's explicit direction, and only after looking at the difference:

```bash
mise exec -- just visual-accept "why the new rendering is intended"
```

It refuses without a reason. With one, it rewrites every baseline that differs by more than
the tolerance and writes each missing one, then appends the date, the reason and the changed
files to [visual-baseline-changelog.md](visual-baseline-changelog.md). A capture within the
tolerance leaves its baseline as it was. Review the change as an image diff before committing
it (GitHub's rich diff for PNGs, or `git difftool` with an image viewer). Never set
`TRUNK_ACCEPT_VISUAL_BASELINES` by hand: it skips the changelog.

A new repository in `graph-lanes`, `graph-merges` or `stash-lanes` fails the suite twice until
it is accepted. The coverage test fails because the list in `graph.test.ts` does not name it,
and once it is named, its capture has no baseline. `kitchen-sink` is one repository, found as
its case's directory, so a repository added to that case outside that directory is neither
captured nor flagged. Removing a repository leaves its baseline behind with nothing to flag
it, so delete the PNG in the same change.

## Wall time

Measured 2026-09-27 on this 18-core Apple Silicon Mac, Playwright 1.63.0 WebKit, 52 tests
(51 captures and the coverage test), builds warm:

| Measure | Five consecutive runs |
|---|---|
| `just visual`, the whole recipe with the cargo no-op build | 6.79, 6.72, 6.72, 6.92, 6.72 s |
| vitest's own duration within those runs | 6.44, 6.36, 6.37, 6.57, 6.36 s |
| Load average over one minute before each run | 7.60, 8.67, 8.22, 7.95, 7.87 |

The load came from the other sessions on the machine. Two runs by a reviewer the same day took
8.15 and 6.97 s at load averages of 3.77 and 3.94, so the spread is wider than these five show.
At 29 tests, on 2026-09-26, the recipe took 4.06 to 4.33 s at load averages of 4.9 to 5.2. A
reviewer's run of an earlier, slower version took 17.38 s with load averages of 11.57, 7.46
and 5.48, after waiting 3.64 s on another build's cargo lock. That is one sample, and whether
the suite stays in `just check` on a shared machine is unsettled, as the decision record says.

The slowest captures are `stash-lanes/18-many-files`, about 560 ms, and `kitchen-sink`, about
440 ms. The four fixture cases build in one process each, side by side, in 2.08 to 2.16 s,
against 2.80 to 2.86 s for all four in one process.

Where the time goes, measured per capture at three pages on 2026-09-26, with two cases:
retiring the last host, spawning a new one and writing the prefs 25 to 40 ms, loading the app
55 ms, drawing the first row 95 ms, settling 75 ms. Settling always takes two screenshots,
since the second must match the first. Before the first capture, Vite starts in about 130 ms
and WebKit in about 270 ms, the fixture build takes about 800 ms, and the pages finish loading
the app about 1.2 s in. Teardown takes about 160 ms.

The warm-up capture each page takes before the tests adds about half a second. On 2026-10-02,
three runs of vitest alone alternating with and without it took 7.24, 6.97 and 6.96 s with it
against 6.47, 6.55 and 6.73 s without, at load averages of 1.4 to 6.3.

Every speed alternative measured on 2026-09-26, with two cases and 29 tests, vitest alone,
each row adding to the one above unless it says otherwise. Rows sharing a round were run in
rotation, so the load hit each alike:

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
| 4 pages (round A) | 3.80 to 3.84 s |
| 6 pages, vitest running at most five tests (round A) | 3.88 to 3.94 s |
| 4 pages (round D) | 3.76 to 3.82 s |
| 5 pages (round D), the default | 3.65 to 3.75 s |
| 6 pages, vitest running six tests at once (round D) | 3.57 to 3.75 s |
| 8 pages, vitest running eight tests at once (round D) | 3.68 to 3.74 s |

Five pages beat four in each of round D's three rotations, by 0.07 to 0.12 s. Six and eight
pages, with vitest's `maxConcurrency` raised to match, were no faster than five, and each page
carries its own `app_host`, so five is the default: the most tests vitest runs at once
without a change to its configuration.

Alternatives not taken:

- Serving `vite.config.ts` with every plugin broke the page: `svelteTesting` made it load
  Svelte's server build, which is why that plugin is filtered.
- One `app_host` shared by every capture. Spawning one takes about 8 ms, so sharing would
  save under 0.1 s, and a shared host carries the prefs one capture writes into the next.
- Caching the fixture build between runs. With four cases the build alone takes about 2.1 s,
  against the 1.2 s the pages took to load when that was last measured, so a cache would
  likely save time now. It would also have to notice every change to the fixture crate, and
  the suite runs inside 10 s without one.
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
- Text. The graph capture holds no label: the column header and the ref pills are outside it,
  and GitHub's `macos-latest` runner draws text up to 36 levels away from this Mac. The
  catalog capture masks its text for the same reason, so a type step that changes only its
  glyphs passes.
- Ref pills, which sit in the Branch/Tag column (TRUNK-290). The line joining each pill to
  its dot is captured where it crosses into the graph column.
- A graph pan other than the one captured, `09-column-saturation` at 56 px panned 20 px. A
  break that shows only at another offset, or in another repository, passes.
- The diff pane (TRUNK-288).

Every capture holds all of its repository's rows. A repository whose commit list would scroll
in the 1800 px window fails its capture and says to raise the window's height, rather than
leaving its last rows uncompared.
