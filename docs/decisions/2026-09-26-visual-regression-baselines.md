# Visual regression baselines: what is captured, how, and at what tolerance

Status: accepted 2026-09-26 (TRUNK-100). The runner question below is open until CI has run once.

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

Each capture is clipped to the graph column: as wide as the column's header cell and as tall
as the list. The branch, message, author, date and SHA columns are outside it, so a change to
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

## Tolerance: zero

A capture passes when its bytes equal the baseline, or when decoding both finds no pixel
whose colour differs in any channel. Two runs on this Mac were byte-identical for every
capture, so this machine has no renderer variance to absorb, and any tolerance would only
admit the partial erasures this suite exists to catch. Playwright's own comparator was not
used: by default it allows a colour threshold of 0.2 and skips anti-aliased pixels, and a thin
rail is mostly anti-aliased pixels.

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

## Open

Whether the `macos-latest` runner's captures equal this Mac's is unmeasured. The first CI run
after the push settles it. If they differ, the fallback measured during shaping (doc-149) is a
pinned Playwright Linux container, whose captures were byte-identical per architecture with a
maximum channel difference of 1 between arm64 and amd64. That fallback would move the suite
out of the local gate, since this machine runs Docker only on request.

## Re-check

Re-run `just visual` twice with no change after a macOS update, a Playwright bump or a change
to the fonts installed. Two green runs mean zero tolerance still holds on this machine.
