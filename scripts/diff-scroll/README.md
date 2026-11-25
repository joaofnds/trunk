# Native scrolling experiments

`run.py` replays eight native wheel flings over five seconds
in a real Trunk drive build. It preserves the screen recording, input events and
DOM geometry needed to investigate blank diffs. It is an investigation tool;
a passing run does not establish that scrolling is fixed.

`cadence.py` separately measures graph or diff pixel-change cadence and process
resources. Its `--geometry` mode checks diff coordinates and controls without
measuring cadence. These opt-in macOS experiments cover different observations;
passing one does not replace the others.

## Blank-paint experiment

The default `--profile slow` requests a peak of 3,750 input pixels per second.
The optional `--profile fast` requests 30,000 input pixels per second. Both profiles use 216 events. The manifest and input artifact record
which trace ran; compare runs with the same profile and initial position.

`run.py`, `renderer_pause.py` and `cadence.py` place the test window on the main
display by default, where it must stay uncovered for the whole run. `--display
virtual` creates a private 1280 × 800 display at a requested 60 Hz instead, and
`--refresh-rate 120` requests the faster condition used by the cadence comparison.
Use the virtual display only when a run needs it. On macOS 27.2 WindowServer
keeps every virtual display it has created until it restarts, with a backstop
window and a color restore timer that blocks its main thread on ColorSync twice
every five seconds. Eight runs raised those requests from 24 to about 215 a minute
and lagged the whole machine. Restarting ColorSync, sleeping the display and
reconfiguring it did not clear them, and a reboot does.

The manifest records `display_kind`, `requested_refresh_rate` (null on the main
display), the `native_display` response and the window's reported maximum frame
rate. A native display rate of zero means unspecified. A painting pass at the 60 Hz
request does not establish the same behavior at the 120 Hz request.

A strict one-shot timer delivers each event against a shared origin, with zero
requested leeway. Scheduling is still best effort. `native-input.json` records
`plannedStartMachTicksLowerBound`, `plannedStartMachTicksUpperBound`, and each
actual delivery timestamp. The two bounds bracket the scheduling-origin clock
read; compare that interval plus each `input.json` offset with actual delivery
before interpreting the requested cadence as delivered cadence.
Independent `dispatch_after` timers coalesced later events into bursts in a native
measurement, with over 200ms of scheduling delay. The strict timer avoids that
proportional timer leeway without polling.

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
repository. It places the test window on the chosen display, checks that the
window is visible there, and verifies native wheel coordinates against the browser's wheel
event and the event's window number before recording. It quits only the app and
recorder it started, and removes its temporary repository and app data on exit.

### Reading the blank-paint result

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

### Controlled renderer unavailability

`renderer_pause.py` uses the blank-paint runner's arguments and pixel oracle. It
plans a 100 ms whole-WebContent suspension after recording starts and offsets the
fling trace by 125 ms, so input begins while the renderer is stopped:

```sh
mise exec -- python3 scripts/diff-scroll/renderer_pause.py \
  --binary .boris/cadence-baseline \
  --source-revision baseline-source-label --profile fast \
  --lines 1500 --start-scroll 12000 --refresh-rate 120 \
  --output .boris/diff-scroll-pause-baseline
```

The runner identifies the test app's distinct WebContent process, records Mach
clock brackets around SIGSTOP and SIGCONT, verifies a stopped process state,
requires the first delivered event to fall within that pause, and verifies the
resumed state and unchanged process IDs. The resume attempt runs even when
recording or input fails, including SIGTERM cancellation. SIGKILL cannot be
handled. `pause.json` preserves timing and errors;
`pause-harness/` and `pause-harness.json` preserve the helper sources and hashes.
This uses the 216-event fling trace, not the cadence runner's 404-event admission
contract. Inspect the native delivery record before comparing runs.

A planned pause duration is not the observed duration; use its recorded clock
brackets. This bounded failure experiment does not estimate how often ordinary
main-thread contention occurs. Geometry markers become stale while WebContent is
stopped, so coverage markers cannot establish compositor paint during the pause.
The captured-pixel oracle supplies the painting observation within its documented
64 px gap threshold and temporal coverage.

## Cadence and resource comparisons

Both painting and cadence runners check for recognized competing builds/tests at
measurement entry and exit. `process-admission.json` retains the complete
PID/CPU/executable inventories, normalized matching workload labels and rejection
reasons. Command arguments are parsed transiently and are not saved. These
snapshots sit outside capture and resource-counter intervals. An identified
competitor, malformed inventory or missing interpreter arguments makes the run
inconclusive; the runner retains artifacts without killing other processes or
automatically retrying. This recognizes known tools and Rust test executables,
not every possible workload. Work that starts and finishes between snapshots,
including another benchmark or OCR, still requires external coordination.
Reanalysis also refuses a rejected or incomplete admission record. Newly generated
manifests require that record; older recordings without one are explicitly marked
as having unobserved workload admission. A pixel/input verdict on such a recording
does not establish a quiet measurement window.

`cadence.py` opens a disposable repository with 400 history commits and a
1,500-line added TypeScript file. The graph starts at 1,200 px and the diff at
12,000 px. Four alternating gestures each send 100 nonzero native wheel events:
12 px every 8 ms, followed by an end event at 800 ms. Gesture starts are 1,000 ms
apart. The full trace has 404 native events and must reach each 1,200 px excursion
or return. It is synthetic native input, not a physical trackpad gesture.

Build and freeze both application binaries before measuring. Build the native
tools separately, once for the comparison, in a new directory:

```sh
mkdir .boris/cadence-tools
clang -dynamiclib -fobjc-arc -framework AppKit -framework WebKit \
  -framework CoreGraphics scripts/diff-scroll/native-probe.m \
  -o .boris/cadence-tools/native-probe.dylib
swiftc -parse-as-library -O scripts/diff-scroll/native-capture.swift \
  -o .boris/cadence-tools/native-capture
```

Run one capture with an explicit binary and a new output path:

```sh
mise exec -- python3 scripts/diff-scroll/cadence.py \
  --binary .boris/cadence-baseline \
  --native-probe .boris/cadence-tools/native-probe.dylib \
  --recorder .boris/cadence-tools/native-capture \
  --source-revision baseline-source-label --mode diff --refresh-rate 120 \
  --output .boris/cadence-capture-1-baseline
```

Use `--mode graph` for the graph comparison. `--refresh-rate` requires either 60
or 120 and records the requested virtual mode. `--display main` is the default and
places the window on `CGMainDisplayID()` and verifies its display ID and
visibility. This can be a hardware or virtual display. The returned
`builtIn` field records `CGDisplayIsBuiltin`; `mainDisplay` alone does not establish
hardware provenance. In main-display mode the refresh-rate argument is recorded
but not applied, and `requested_refresh_rate` is null. Read the returned display metadata:
an `actualRefreshRate` of zero means unspecified, not verified 120 Hz. The recorder
requests a maximum cadence; its frame timestamps establish the observed capture
coverage, not the physical display's presentations. A screen's reported
`maximumFramesPerSecond` is its maximum, not a measurement of each presentation.

Use `--resources` instead of `--recorder` for a separate CPU, memory and I/O trial:

```sh
mise exec -- python3 scripts/diff-scroll/cadence.py \
  --binary .boris/cadence-baseline \
  --native-probe .boris/cadence-tools/native-probe.dylib \
  --resources --source-revision baseline-source-label \
  --mode diff --refresh-rate 120 \
  --output .boris/cadence-resources-1-baseline
```

Keep builds, tests, OCR, other captures and benchmarks outside these windows.
Both runners share `/tmp/trunk-native-diff-scroll.lock`; unrelated activity still
needs coordination. Alternate complete baseline/candidate pairs, retain rejected
attempts, and report independent launch counts, absolute samples and ranges.
The runner never automatically repeats a failed attempt.

### Admission and evidence

Cadence/resource runs install wheel and scroll listeners but no continuous rAF
observer or geometry marker. Two rAF callbacks settle the starting viewport before
measurement. Recording and resource capture run separately to avoid measuring the
recorder as part of the application workload.

`result.json` is `valid` with exit 0 only after input and the requested observation
pass validation. Exit 2 is `inconclusive`. A valid cadence result is a measurement,
not a performance budget or an improvement verdict. Input admission requires:

- All 404 planned native events, with matching window, coordinates, delta, phase
  and momentum, and exactly 400 matching nonzero browser receipts.
- Native delivery within -0.1 to 3 ms of each scheduled offset, evaluated against
  both recorded Mach-time start bounds. A slow first event cannot redefine the
  origin and conceal later delivery delays.
- Each 1,200 px excursion and return within 1 px, scroll values within the file,
  ordered observations, and the correct final position.

Capture admission additionally checks frame status, decoded-frame counts,
backpressure and coverage of the complete native input interval. The analyzer uses
two text crops by default and reports thresholds of 1, 3 and 5 mean absolute gray
levels. Each gesture needs frame comparisons within its 100–700 ms motion window.
Its 850–950 ms idle window contributes noise measurements where ScreenCaptureKit
encoded frames; a static window can omit complete frames there. At least one idle
comparison across the trace is required, and `idle_comparisons_by_gesture` exposes
missing idle coverage. Pixel-change intervals, unchanged spans and capture gaps
describe recorded content. They do not count physical display frame drops or
establish input-to-first-presentation latency.

Resource trials calibrate the process CPU counter conversion against Python's
`process_time_ns()` bracket before starting the app. They record host, WebContent
and GPU-process snapshots around the trace plus a 200 ms tail. Snapshot brackets
bound the observation interval; process IDs and start identities must remain
unchanged. CPU is reported in milliseconds, including the GPU process's CPU time,
not GPU utilization or a sampled CPU percentage. Resident size and physical
footprint are endpoints, not peaks; summing processes can count shared memory
more than once. Read/write byte counters describe physical I/O accounting, so zero
does not rule out cached filesystem work. A failed resource stage retains its
partial snapshot in `resource-attempt.json`.

Each output contains frozen executable harness sources under `harness/`. The
runner executes those copies, records their hashes, and records application,
native-probe and recorder hashes before and after the run. The manifest includes
the supplied source label, fixture OID and file hashes, platform, window, display,
process identities and inventory. `native_configuration` reads back the website
data store's persistence and identifier plus the availability and current value
of the near-60 rendering preference; the probe does not set that preference.
A source label still does not prove how a
binary was built: retain the frozen source manifest, exact production patch and
build log alongside it. The probe and recorder are supplied binaries; preserve
their compile commands and source hashes too.

Reanalyze saved capture evidence without launching the app, using the run's frozen
analyzer and a new output file:

```sh
mise exec -- python3 \
  .boris/cadence-capture-1-baseline/harness/diff-scroll/cadence_analysis.py \
  .boris/cadence-capture-1-baseline \
  --output .boris/cadence-capture-1-baseline/reanalysis.json
```

Resource reanalysis uses the same command with `--resources`. The analyzer also
accepts explicit `--manifest`, `--box` and `--crops` JSON paths for preserved
prototype evidence. It records overrides and file hashes; preserve the original
result and name why an override or newer analyzer was used. A new analyzer does
not retroactively change the original verdict.

Verify an experimental intervention before interpreting its result. For a style
change, read the computed property or affected geometry after applying it; an
inserted `<style>` element with no active stylesheet does not establish delivery.
Preserve that readback with the result. The same rule applies to negative controls:
a mutation that never reached the application cannot validate the oracle.

## Diff geometry and interaction checks

Use `--geometry` instead of the measurement modes; it requires `--mode diff`:

```sh
mise exec -- python3 scripts/diff-scroll/cadence.py \
  --binary .boris/cadence-baseline \
  --native-probe .boris/cadence-tools/native-probe.dylib \
  --geometry --source-revision baseline-source-label \
  --mode diff --refresh-rate 120 --output .boris/cadence-geometry-baseline
```

The frozen `geometry.js` checks hunk/full-file, inline/split and wrap modes at
four positions, including the end. It checks exact fixture text, row coordinates,
mounted-row bounds, gutter hit-testing, selecting and clearing four lines, the
first-hunk `[` boundary and wrapped-row anchoring after a sidebar keyboard resize
when that control is available. The fixture has only one hunk, so it cannot test
a previous-hunk jump. Gutter mouse events are dispatched to hit-tested elements
inside the page; they are not operating-system pointer delivery. A pass means
the DOM geometry and controls matched these predicates, not that pixels stayed
painted during native scrolling. Exit 0 is `pass`, 1 is `fail`, and setup errors
are `inconclusive` with exit 2. Results and any failed stage remain in
`geometry.json` and `result.json`.

## Harness checks

Run analyzer and protocol checks without launching the app:

```sh
mise exec -- python3 -m unittest discover -s scripts/diff-scroll -p 'test_*.py'
```
