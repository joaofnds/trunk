# Visual regression suite

`just visual` renders the real application in WebKit against the repositories the fixture
crate builds, screenshots the graph column of the commit list for each, and compares every capture with
its committed baseline in `tests/visual/baselines/`. It is part of `just check` and has its
own CI job, `Visual Baselines`, on `macos-latest`.

It exists because every other graph suite runs without a layout engine. The render goldens
compare SVG markup, in which an erased rail and a drawn one are identical, and TRUNK-255 ran
six sessions of green checks against a graph that was empty on screen (revert `409d34b3`).
A green render golden is not evidence the graph draws. This suite is the one that looks.

Why it is built this way, what gets a baseline, and why a pixel may drift 24 colour levels
before it differs are in
[decisions/2026-09-26-visual-regression-baselines.md](decisions/2026-09-26-visual-regression-baselines.md).

## Running it

```bash
mise exec -- just visual
```

The recipe builds `app_host` and the `fixtures` binary, then runs
`vitest --config vitest.visual.config.ts`. It needs Playwright's WebKit, which no recipe
installs, so `just check` fails at the suite's setup on a machine without it. Install it
once with `mise exec -- bunx playwright install webkit`.

`TRUNK_VISUAL_PAGES` sets how many pages capture at once (default 3).

## A capture differs

A difference is a suspected break until someone has looked at it. A pixel differs when one
of its colour channels is more than 24 levels of 255 from the baseline's. The failing test
names the repository and the number of differing pixels, and writes two files to
`tests/visual/differences/` (gitignored):

- `<name>.capture.png`, what the app drew this run;
- `<name>.difference.png`, the baseline dimmed to grey with every differing pixel in red.

A capture with no baseline writes only `<name>.capture.png`.

In CI the same directory is uploaded as the `visual-differences` artifact.

Look at the difference image first. If the change is not intended, it is a defect: fix the
code, not the baseline.

## Accepting a change

Only at the user's explicit direction, and only after looking at the difference:

```bash
mise exec -- just visual-accept "why the new rendering is intended"
```

It refuses without a reason. With one, it rewrites every baseline whose pixels changed and
writes each missing one, then appends the date, the reason and the changed files to
[visual-baseline-changelog.md](visual-baseline-changelog.md), and clears the differences.
Review the change as an image diff before committing it (GitHub's rich diff for PNGs, or
`git difftool` with an image viewer). Never set `TRUNK_ACCEPT_VISUAL_BASELINES` by hand: it
skips the changelog.

A new repository in the `graph-lanes` or `graph-merges` case fails the suite twice until it
is accepted. The coverage test fails because the list in `graph.test.ts` does not name it,
and once it is named, its capture has no baseline.

## Wall time

Measured 2026-09-26 on this 18-core Apple Silicon Mac, Playwright 1.63.0 WebKit, 29 tests
(27 repositories plus the narrowed-column capture), builds warm, one run at a time with no
other gate running here. Load averages were not recorded for these runs:

| Configuration | Wall time |
|---|---|
| `just visual`, the whole recipe with the cargo no-op build (3 pages) | 7.06 s |
| vitest alone, 3 pages, fixture build in parallel with Vite and WebKit launch | 6.05, 6.19, 6.14 s |
| vitest alone, 4 pages | 5.46, 5.59 s |
| vitest alone, 1 page, serial | 10.6 s |

Under load the time more than doubles. An independent reviewer's run took 17.38 s (vitest
13.00 s) with load averages of 11.57, 7.46 and 5.48, after waiting 3.64 s on another build's
cargo lock. The suite joined `just check` on the quiet-machine number, and whether it stays
there when the machine is shared is an open question on TRUNK-100.

Per capture on one page: host spawn 8 ms, prefs 14 ms, page load 80 ms, first rails 50 ms,
settling about 140 ms. Setup (fixtures, Vite, WebKit) is about 1.2 s.

Alternatives measured and not taken:

- One page, serial, is over the 10-second budget.
- Four pages save about 0.6 s over three. Three was kept because this machine runs several
  sessions at once, and each page carries its own `app_host`.
- Mounting `CommitGraph.svelte` alone on the committed layout exports measured 3.99 s for 49
  fixtures during shaping (doc-149), but it bypasses the real app and its commands, so it is
  not the end-to-end render the suite is for.

## What it does not cover

- The column header is not captured. GitHub's `macos-latest` runner draws its label up to
  36 levels away from this Mac, and below it the runner stays within 12. A runner image
  update can move that, and the decision record says how to re-measure it.
- `--font-sans` starts with Inter, which is not installed here, so captures use the system
  sans-serif. A machine with Inter installed draws different text and fails.
- A macOS update can change WebKit's or the system font's rendering. Treat a suite-wide
  failure after an OS update as that, look at the images, and accept with the reason.
- The diff pane has no baseline (TRUNK-288).
