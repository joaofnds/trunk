# Visual regression baselines: what is captured, how, and at what tolerance

Status: accepted 2026-09-26 (TRUNK-100), captures widened 2026-09-27 (TRUNK-289). Two
choices in it were made by the build without João's direction and stay unsettled until he
rules: the 24-level tolerance, and running the suite inside `just check`.

## Context

Every graph test in Trunk ran without a layout engine. The render goldens compare markup
strings, and jsdom evaluates no clip-path or mask, so a rail erased on screen and one drawn
are the same string. TRUNK-255 shipped a graph that was empty on screen through six sessions
of green checks (revert `409d34b3`).

João's direction on 2026-09-22: "If we had some fixture repos that we can use the real code
end to end to render the graph for those repos and take screenshots and we save those
screenshots every time there is a difference in the screenshot, that should be our golden.
That should be manually reviewed and make sure that the change is intentional and otherwise
consider it as a break."

On where it runs, the same day: "the screenshotting should be like additional in our suite.
Maybe run it also on a cron like every day on GitHub because it will probably be slow... So
we don't want to have to depend on it every time we need to verify stuff locally. So we
either find a way to make it really, really, really, really fast and run under like 10
seconds at most, or we accept that it will be slower and run [it nightly]."

## What gets a baseline

The graph column of the commit list, and nothing else:

- one capture for each repository the `graph-lanes`, `graph-merges`, `stash-lanes` and
  `kitchen-sink` fixture cases build (49 today), at the default column widths;
- one capture of `graph-merges/09-column-saturation`, the widest fixture, with the graph
  column's stored width set to 56 px before the app loads. The lanes overflow that width and
  the rails still draw, which is the state TRUNK-255 broke;
- one capture of that same narrowed column panned 20 px by a sideways wheel over it once the
  rows have drawn and the stored width has arrived, so lanes sit past both of its edges.

That is 51 captures. The stash and kitchen-sink repositories and the panned column joined on
2026-09-27 at João's direction (TRUNK-289), so that stash placement beside the WIP row, the WIP
marker and a panned column each have a baseline. Each is as wide as the graph column's header
cell and runs from the top of the first commit row to the bottom of the last, so its height
follows the repository and not the space the app gives the list. The branch, message, author,
date and SHA columns, the header, and the chrome around the list are outside it, so a change to
any of them leaves every capture unchanged, with one exception. The line from each ref pill to
its commit's dot runs into the graph column, so hiding the Branch/Tag column or restyling that
line changes the captures of the repositories with refs. Four pixels more of top bar, and a
visible string added to every commit message, each kept all 28 captures green (measured
2026-09-26). The window is 1800 px tall, enough for the longest repository's 61 rows
(`kitchen-sink`). A list that would scroll fails its capture rather than leave its last rows
uncompared.

Not captured, and why:

- The column header and the ref pills. Both are text, which GitHub's macOS runner draws up to
  36 levels away from this Mac (below). The pills also sit in the Branch/Tag column, outside
  the graph column, though the line joining each pill to its dot is captured where it
  crosses into the graph column.
- A column panned any other distance, or in any other repository. One pan is captured.
- The diff pane, which João's direction did not name (TRUNK-288).

Capturing the pills is proposed in TRUNK-290.

## Capture setup

- Engine: Playwright's WebKit build (626+ for Playwright 1.63), because Trunk renders in
  WKWebView on macOS (wry 0.55.1) and a Chromium baseline would pin an engine Trunk never
  ships on. Playwright's build is not the system WKWebView. It draws through the system's
  CoreGraphics, CoreText and QuartzCore, so a macOS update can still move a capture, but a
  change confined to the system's WebKit does not reach one.
- Platform: native macOS, locally and on the CI job's `macos-latest` runner. No container.
- The real `App`, served by Vite from `vite.config.ts` with one plugin removed, talking to a
  real `app_host` through Playwright bindings. The removed plugin, the Testing Library's
  Svelte plugin, empties the browser's resolve conditions inside any vitest process, and the
  page then loads Svelte's server build. One host per capture, so the prefs one capture writes
  cannot reach the next.
- Viewport 1200 by 1800, device scale factor 1, and the clock pinned to 2026-09-01. The only
  dates the app draws are in the date column, outside the capture, so the pin guards against
  a date reaching the graph column rather than against any variance seen today.
- Readiness is observed, never waited on: a commit row exists, no command is in flight, two
  frames have painted, and two consecutive screenshots are identical. A row that has not drawn
  within 10 seconds fails the capture with the commands the host still owed. Readiness does not
  wait on the graph's paths, so a change that stops them drawing fails as a difference with an
  image, not as a timeout. Events the host sends are not counted as in flight, so an event that
  lands after two identical captures would be missed. None was seen.

## Tolerance: 24 levels a channel

A capture passes when its bytes equal the baseline, or when decoding both finds no pixel with
a channel (red, green, blue or alpha) more than 24 levels of 255 away from the baseline's.

With the tolerance at zero, two runs on this Mac matched every baseline, so this machine alone
has no variance to absorb. GitHub's `macos-latest` runner (macOS 26, arm64) does. Its first
run against baselines recorded here (macOS 27) differed in 11 of 28 captures (CI run
36204042756):

- in 10, only the header's "GRAPH" label, by 94 to 100 pixels and up to 36 levels, which is
  one reason the capture holds no text;
- in one (`graph-lanes/08-stash-on-tip-behind`), 11 pixels along one diagonal connector, by
  at most 12 levels.

Outside the header, the runner's captures are within 12 levels of this Mac's everywhere, and
24 is twice that. CI run 36232438441 passed every capture under the tolerance, with captures
cut below the header. Those were the 28 captures of 2026-09-26. The 23 added on 2026-09-27 had
not run on the runner when they were accepted, so a red first run of theirs is the Re-check
below.

What the tolerance admits is a change of 24 levels or fewer in every channel of a pixel: an
antialiasing shift, or a colour nudged that little. The two nearest lane colours, `--lane-0`
and `--lane-5`, are 27 levels apart in their closest channel, so a rail recoloured from one to
the other still fails, by a margin of 3. With the rail group's clip rectangle set zero wide,
all 28 captures fail (measured 2026-09-26).

Playwright's own comparator was not used: by default it allows a colour threshold of 0.2 and
skips anti-aliased pixels, and a thin rail is mostly anti-aliased pixels.

Paths considered when the runner differed, and what ruled each out:

- Drop the CI job and run only here. Every recipe in `just check` has a CI job and the
  `check-parity` job fails when one is missing, so this means an exception to that guard.
- A Playwright Linux container on both sides (doc-149 measured it at most 1 level between
  arm64 and amd64). This machine runs Docker only on request, so the suite would leave the
  local gate.
- Baselines per platform. Every accepted change would need two reviews, and the runner's
  set could only be produced from CI artifacts.
- Pin the runner to this Mac's macOS. This Mac updates on its own schedule, and whether the
  runner's difference comes from the OS or from rendering without a GPU is unmeasured.

## Why vitest and not `@playwright/test`

`playwright` is the library only. The suite runs under vitest like every other TypeScript
suite, so there is one runner, one config style and one report. `@playwright/test` would add a
second runner for one suite, and its comparator is the one rejected above.

## Why bindings and not the measurement bridge

`just measure` reaches `app_host` over an HTTP bridge with a token file. The suite owns its
browser, so `page.exposeFunction` gives the page a direct call into the host process, with
nothing listening on a port and no token to write.

## Where it runs

In `just check` and in CI as `Visual Baselines`. The whole recipe takes about 7 s with builds
warm and needs no Docker, which is inside the 10 seconds João's direction allows. The same
direction also says local verification should not have to depend on the suite, and `just
check` does depend on it: it fails on a machine without Playwright's WebKit installed. That is
why the placement is unsettled. Timings and every speed alternative measured are in
`docs/visual-regression.md`.

## Re-check

Re-run `just visual` twice with no change after a macOS update, a Playwright bump or a change
to the fonts installed. Two green runs mean the tolerance still covers this machine. A red
`Visual Baselines` job after a runner image update is the same question for the runner: its
`visual-differences` artifact holds the captures, and their largest channel difference
decides whether 24 still covers it.
