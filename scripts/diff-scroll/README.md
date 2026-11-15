# Native diff scrolling experiment

This opt-in macOS experiment replays eight native wheel flings over five seconds
in a real Trunk drive build. It preserves the screen recording, input events and
DOM geometry needed to investigate blank diffs. It is an investigation tool;
a passing run does not establish that scrolling is fixed.

The default `--profile slow` peaks at 3,750 input pixels per second. The optional
`--profile fast` preserves the earlier aggressive trace at 30,000 input pixels
per second. Both profiles use 216 events. The manifest and input artifact record
which trace ran; compare runs with the same profile and initial position.

Build the artifact you want to measure, then name it explicitly:

```sh
mise exec -- just drive-build
mise exec -- python3 scripts/diff-scroll/run.py \
  --binary src-tauri/target/debug/trunk-drive \
  --source-revision "$(git rev-parse HEAD)" \
  --output .boris/diff-scroll-baseline
```

The supplied revision is a label, not proof that a binary came from that commit.
Use a descriptive label for an experimental build with uncommitted changes.
The manifest records the binary's measured SHA-256 so results can be tied to the
actual executable. Existing output directories are refused.

Requirements: Python 3.11 or later, Xcode command-line tools (`clang`, `swiftc`),
`ffmpeg`, `ffprobe`, and macOS Screen Recording permission for the launching
process. The normal drive route needs no Screen Recording permission; this
experiment additionally records actual window pixels through ScreenCaptureKit.
The injected helper uses the private `CGVirtualDisplay` and window-relative
`NSEvent` APIs. An unavailable API, covered window or recording failure makes
the experiment inconclusive.

The default fixture has 146 simple added TypeScript lines. `--lines 1500` and
`--lines 90000` select larger fixtures with the same bounded input trace. Large
fixtures can make experimental implementations expensive; run them deliberately.
Use `--lines 1500 --start-scroll 12000` to begin in the middle of the larger file.
Run captures serially. The harness holds a process lock against other copies of
itself; other capture tools must be coordinated separately.

The harness creates its own temporary repository and app data, keeps HEAD
detached, and adds a fixture tag so the graph can show the commit. Commit authors
are literal fixture object data. It does not change Git identity or the working
repository. It starts a private virtual display, checks that the test window is
visible there, and verifies native wheel coordinates against the browser's wheel
event and the event's window number before recording. It quits only the app and
recorder it started, and removes its temporary repository and app data on exit.

## Reading the result

| Exit | Verdict | Meaning |
| --- | --- | --- |
| 0 | `pass` | No qualifying blank region was found in this trace. |
| 1 | `fail` | A recorded frame was black where fixture content was expected. |
| 2 | `inconclusive` | Setup, capture, decoding or correlation was invalid. |

`result.json` reports blank frame indices, largest dark gap and duration lower
bounds, viewport dimensions, maximum mounted row count among captured geometry
markers, rAF gap p50, p95, p99 and maximum, captured FPS and presentation
timestamps. The row-count metric can miss a spike between captured markers;
`geometry.json` retains every observer sample. These timings are measurements, not unit-test deadlines
or performance budgets. `capture.mov.json` preserves ScreenCaptureKit statuses and
timestamps. `geometry.json`, `input.json`, `native-input.json`, `viewport.json`, `capture.mov` and the
logs retain the underlying evidence.

Duration lower bounds span the first through last captured bad frame in a run;
a failure visible in only one captured frame therefore has a zero lower bound.

Each animation-frame sample writes a 16-bit marker into the page. The analyzer
decodes that marker from the recording to select the geometry associated with the
painted frame. It refuses unknown or ambiguous markers, missing frames, mismatched
frame counts and recorder backpressure. Blank, suspended, missing or unknown
ScreenCaptureKit frame statuses make a run inconclusive; ordinary idle status is
valid. Recording readiness is announced only after the first complete frame is
encoded. Every encoded frame retains ScreenCaptureKit's display time, and every
native input event retains its delivery time, both in Mach absolute clock ticks.
The captured frame interval must bracket the entire delivered input interval.
The recorder remains bounded to five seconds; insufficient temporal coverage is
inconclusive, regardless of how many events were eventually delivered.

The harness also refuses a trace that did not move
through at least half one fling's requested travel or one viewport, whichever is
smaller, after clamping away overscroll. Only geometry markers actually present in
the recording can establish movement; later motion cannot validate earlier
pixels. An all-black file or a no-op trace cannot become a pass.

The pixel oracle is specific to the synthetic added-file fixture. It detects a
black pane or a contiguous vertical gap of at least 64 CSS pixels, requiring
both a missing green added-line stripe and a nearly black interior. The interior
crop excludes the scrollbar. A missing stripe alone is insufficient. The fixture
fills the viewport at every scroll position inside its bounds; missing content there is
reported even when DOM coverage is zero. Outside those bounds, substantial DOM
coverage is required before a whole dark pane is classified as a failure. The
partial-gap check clips its expected interval to the file bounds using the
sampled scroll offset. This excludes empty space during ordinary file-end bounce.

Evidence is classified as `missing_rows` when matching DOM rectangles cover less
than half the viewport, and `missing_paint` otherwise. Those labels describe an
observation, not a root cause. Compositor scrolling can advance independently of
the main thread, so marker correlation does not establish that every compositor
layer used the same scroll offset. Inspect a failing frame and its neighbors.

The observer reads visible row rectangles and writes the marker on each rAF. It
assumes the fixture's rows are in vertical DOM order, using a binary search to
avoid measuring every row in a large rendered file. This instrumentation has
cost and can change timing. Compare like-for-like runs. This runner always samples
geometry; an observer-free control needs a separate capture and cannot use this
marker-based analyzer. The experiment does not detect
gaps shorter than 64 pixels, test comments or wrapped rows, or reproduce a physical
trackpad's complete event distribution.

Run the analyzer and protocol guards without launching the app:

```sh
mise exec -- python3 -m unittest discover -s scripts/diff-scroll -p 'test_*.py'
```
