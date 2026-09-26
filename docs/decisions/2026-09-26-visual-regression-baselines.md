# Visual regression baselines: what is captured, how, and at what tolerance

Status: accepted 2026-09-26 (TRUNK-100).

## Context

Every graph test in Trunk ran without a layout engine. The render goldens compare markup
strings, and jsdom evaluates no clip-path or mask, so a rail erased on screen and one drawn
are the same string. TRUNK-255 shipped a graph that was empty on screen through six sessions
of green checks (revert `409d34b3`). João's direction on 2026-09-22 was that the graph be
rendered end to end through the real code against fixture repositories, that the screenshot
be the golden, and that any difference be reviewed by hand and otherwise treated as a break.

## What gets a baseline

The graph column of the commit list, and nothing else:

- one capture for each repository the `graph-lanes` and `graph-merges` fixture cases build
  (27 today), at the default column widths;
- one capture of `graph-merges/09-column-saturation`, the widest fixture, with the graph
  column dragged to 56 px. The lanes overflow that width and the rails still draw, which is
  the state TRUNK-255 broke. With the rail group's clip rectangle removed, every capture failed,
  this one included, and restoring it passed all of them (measured 2026-09-26).

Each capture is clipped to the graph column: as wide as the column's header cell, from below
the header row to the bottom of the list. The header's label is text, which the CI runner
draws differently (below), and it is not the graph. The branch, message, author, date and SHA columns are outside it, so a change to
them, or to anything else in the app, leaves every capture unchanged. A visible string added to every
commit message kept all 29 captures green (measured 2026-09-26). The diff pane was dropped from this card (TRUNK-288).

## Capture setup

- Engine: Playwright's WebKit, because Trunk renders in WKWebView on macOS (wry 0.55.1). A
  Chromium baseline would pin an engine Trunk never ships on.
- Platform: native macOS, locally and on the CI job's `macos-latest` runner. No container.
- The real `App` served by Vite, talking to a real `app_host` through Playwright bindings, one
  host per capture so the prefs one capture writes cannot reach the next.
- Viewport 1200 by 800, device scale factor 1, animations disabled, and the clock pinned to
  2026-09-01 so the relative dates in the rows do not move.
- Readiness is observed, never waited on: the first rail path exists, no command is in
  flight, two frames have painted, and two consecutive screenshots are identical. Events the
  host sends are not counted as in flight, so an event that lands after two identical
  captures would be missed. None was seen.

## Tolerance: 24 levels a channel

A capture passes when its bytes equal the baseline, or when decoding both finds no pixel
with a colour channel more than 24 levels of 255 away from the baseline's.

Two runs on this Mac were byte-identical for every capture, so this machine alone has no
variance to absorb. GitHub's `macos-latest` runner (macOS 26, arm64) does. Its first run
against the baselines recorded here (macOS 27) differed in 11 of 28 captures (CI run
36204042756):

- in 10, only the header's "GRAPH" label, by 94 to 100 pixels and up to 36 levels, which is
  why the capture starts below the header row;
- in one (`graph-lanes/08-stash-on-tip-behind`), 11 pixels along one diagonal connector, by
  at most 12 levels.

Below the header, the runner's captures are within 12 levels of this Mac's everywhere, and 24
is twice that. The rail-erasure mutant (the rail group's clip rectangle zero wide) moves at least
96 pixels per capture by more than 64 levels, and all 28 captures still fail under it with
the tolerance in place (measured 2026-09-26). What the tolerance admits is a change of 24
levels or fewer in every channel of a pixel: an antialiasing shift, or a colour nudged that
little. Under the mutant, the largest change in every capture was at least 173 levels.

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
second runner for 29 tests, and its comparator is the one rejected above.

## Why bindings and not the measurement bridge

`just measure` reaches `app_host` over an HTTP bridge with a token file. The suite owns its
browser, so `page.exposeFunction` gives the page a direct call into the host process, with
nothing listening on a port and no token to write.

## Where it runs

In `just check` and in CI as `Visual Baselines`, because the whole recipe takes 7.06 s with
builds warm on a quiet machine and needs no Docker. A run on a loaded machine took 17.38 s,
so whether it stays in the local gate is open on TRUNK-100. João's 2026-09-22 direction allows the local run when it is
under 10 seconds. Timings and the alternatives measured are in `docs/visual-regression.md`.

## Re-check

Re-run `just visual` twice with no change after a macOS update, a Playwright bump or a change
to the fonts installed. Two green runs mean the tolerance still covers this machine. A red
`Visual Baselines` job after a runner image update is the same question for the runner: its
`visual-differences` artifact holds the captures, and the largest channel difference below
the header decides whether 24 still covers it.
