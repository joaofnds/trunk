# Interaction performance

This is the interaction inventory and evidence record for Trunk's performance work.
The inventory describes source inspected on 2026-11-15, with the scrolling flow
added on 2026-11-16. The initial order records the hypotheses used to choose measurements; the measured
priority list below supersedes that order where evidence exists. Frequency estimates are assumptions
about a Git GUI workflow; this investigation has not collected usage telemetry.
Fresh measurements belong under **Measured experiments**, with the artifact and
fixture identity needed to repeat them.

## What completion means

An interaction has four separate observations:

| Observation | Observable condition |
| --- | --- |
| Start | The intended input is delivered to the application. Record the delivered timestamp, input type, and intended repository, OID, path, or action. A controller's scheduled timestamp alone does not establish delivery. |
| Immediate feedback | The first observed selection, busy control, loading label, dialog, or layout change acknowledges that input. A changed internal variable does not establish that the user saw feedback. |
| Correct usable result | The intended target's content is available and the relevant controls work. Check repository, OID, path, staged/unstaged kind, and requested content mode where applicable. For mutations, check the resulting Git state as well as the pane. |
| Background settlement | The work caused by the input has completed, including dependent status, graph, sidebar, statistics, review, and persistence operations. A resolved mutation command or an enabled submit button alone does not establish settlement. |

The flow table names the expected conditions. Each benchmark must provide its
concrete observation predicate and identify any endpoint it cannot observe. DOM
readiness and rAF callback cadence measure renderer behavior. A claim about visible
feedback or discontinuities additionally needs captured presentation evidence and
its observation coverage.

## Interaction map

Each row starts with delivery of its named gesture. The three following conditions
are feedback, usable result, and settlement, in that order. The source links are
entrypoints; command and helper names narrow the path without fragile line numbers.

| ID | Flow and entrypoints | Feedback; correct usable result; settlement | Representative variations |
| --- | --- | --- | --- |
| I01 | Open/switch repository tabs: [App](../src/App.svelte) `openRepoInTab`, [RepositoryTabs](../src/lib/repository-tabs.svelte.ts) | Active tab or opening state; matching repository graph and status; backend preparation, badges, and first-view reads complete | First process launch, first visit, revisited mounted tab, A/B/A, multiple open repositories |
| I02 | Graph/diff/review/merge/rebase view switching: [RepoView](../src/components/RepoView.svelte), [LazyView](../src/components/LazyView.svelte) | Requested pane or opening label; requested view's content and controls; view-specific reads complete | First dynamic import versus warm module, return from diff to graph, return from comment jump to review |
| I03 | Pane collapse/expand/resize and focus: [App](../src/App.svelte) keyboard handler, [RepoView](../src/components/RepoView.svelte) resize handlers | Pane/divider responds; final geometry and focus correct; preference writes complete | Cmd/Ctrl+J and K, repeated toggles, bounded divider drag, large visible diff, graph column resizing |
| I04 | Commit selection by click or ArrowUp/Down: [RepoView](../src/components/RepoView.svelte) `selectCommitIdempotent`, [CommitGraph](../src/components/CommitGraph.svelte) keyboard handler | Requested row selected; detail and file list match requested OID; statistics and remembered diff load complete | Narrow/wide commits, cold/warm reads, rapid consecutive selections, A/B/A |
| I05 | History navigation by older/newer, parent/child, or ref: [CommitDetail](../src/components/CommitDetail.svelte), [RepoView](../src/components/RepoView.svelte) `navigateToCommit`/`handleRefNavigate`, [CommitGraph](../src/components/CommitGraph.svelte) `scrollToOid` | Target selection; matching detail/diff and target graph row visible where graph is mounted; paging and stats complete | Loaded target versus deep history, remembered file present/absent, empty commit, repeated navigation |
| I06 | Commit-file open/switch/reopen: [RepoView](../src/components/RepoView.svelte) `selectCommitFileIdempotent`/`reloadCommitFile` | Path/loading state; matching diff usable; row construction and dependent reads complete | A/B/A, reused file versus first load, large file, rename, binary, full-file/hunk modes |
| I07 | Working-tree or index file selection: [RepoView](../src/components/RepoView.svelte) `handleFileSelect`/`readSelectedFileDiff` | Path/kind/loading; current requested diff usable; pending reader rerun and refreshes complete | Staged/unstaged side of same path, rapid file switches, save during read, last hunk removed |
| I08 | File finder and current-source open: [FileFinder](../src/components/FileFinder.svelte), [file-finder](../src/lib/file-finder.ts), [RepoView](../src/components/RepoView.svelte) `openFileFinder`/`openCurrentFile` | Dialog or query echo; ranked results then selected current source; source and dependent reads complete | Empty query, typing/backspace, many tracked paths, changed-first ordering, repeat source open |
| I09 | Commit search and next/previous match: [CommitGraph](../src/components/CommitGraph.svelte) search handlers, [SearchBar](../src/components/SearchBar.svelte) | Query echo; results match current query and selected commit; graph paging/detail complete | Rapid replacement/clear/close while request is pending, no matches, deep target, broad query |
| I10 | Compare commits and swap base/target: [RepoView](../src/components/RepoView.svelte) `applyCompare`/`reloadCompareFile` | Pair selected; file list/diff match that pair; statistics and diff reads complete | Wide changes, renames, repeated swaps, selection changes during request |
| I11 | Diff options and hunk navigation: [DiffPanel](../src/components/DiffPanel.svelte), [DiffViewer](../src/components/diff/DiffViewer.svelte) | Option or hunk target changes; requested content/layout/render mode or hunk visible; enrichment/layout completes | Full-file/hunk, unified/split, whitespace, wrap, Markdown source/rendered, repeated hunk keys |
| I12 | Stage/unstage file, directory, or all: [StagingPanel](../src/components/StagingPanel.svelte), [DiffPanel](../src/components/DiffPanel.svelte) file handlers | Busy control/file where supplied; intended index mutation and matching list movement; status/operation state/graph/diff refresh complete | Small/large index, rename, nested directory, partial staging, repeated actions and failure |
| I13 | Stage/unstage hunk or selected lines: [DiffPanel](../src/components/DiffPanel.svelte) hunk/line handlers | Mutation controls disabled; exact requested patch applied and remaining diff usable; status and graph refresh complete | Added/deleted lines, multiple hunks, last hunk, options affecting context, repeated input while busy, failure |
| I14 | Commit/amend/stash and undo/redo: [CommitForm](../src/components/CommitForm.svelte), [Toolbar](../src/components/Toolbar.svelte) | Busy submit; Git success or actionable failure; draft, HEAD, status, graph, and undo state consistent | Message-only amend, normal commit, hook failure, signing, partial staging, stash and restore |
| I15 | Conflict selection and resolution: [MergeEditor](../src/components/MergeEditor.svelte), [StagingPanel](../src/components/StagingPanel.svelte) | Selected conflict/choice/save state; intended merged file and index stages correct; status and next-file navigation complete | Many conflict regions, three-pane scrolling, take side/line, save/resolve, bulk resolve |
| I16 | Checkout, ref visibility, stash apply/pop, merge/rebase/cherry-pick/revert/reset: [BranchSidebar](../src/components/BranchSidebar.svelte), [CommitGraph](../src/components/CommitGraph.svelte), [Toolbar](../src/components/Toolbar.svelte) | Action/visibility feedback; intended repository state or actionable conflict; graph/sidebar/status complete | Hidden refs, large history, stopped operations and continue/skip/abort, disposable local remotes |
| I17 | Review selection, comment jumps, filtering, and read state: [ReviewPanel](../src/components/ReviewPanel.svelte), [RepoView](../src/components/RepoView.svelte) review jump handlers | Selected review/thread/filter; matching file/range or filtered threads; anchor resolution and read-state writes complete | Many threads, obsolete anchors, jump to another commit/file, keyboard thread navigation |
| I18 | Refresh after local changes or mutations, and background competition: [RepoView](../src/components/RepoView.svelte) repo subscription, [repo-change-subscription](../src/lib/repo-change-subscription.ts), [autofetch](../src/lib/autofetch.ts) | Foreground input remains acknowledged; affected views converge to correct state; causal readers drain | File-specific/unscoped/refs-only changes, command-completed event, repeated saves, active/inactive tabs, local fetch |
| I19 | Graph and diff scrolling: [CommitGraph](../src/components/CommitGraph.svelte), [ExactVirtualList](../src/components/diff/ExactVirtualList.svelte) | Captured content moves after delivered wheel input; intended rows remain painted through the gesture and final position is correct; virtual range catches up without replacing current content | Steady movement, reversal, fast fling, physical/virtual displays, renderer unavailable, split/wrapped rows, hunk jumps and resize |

## Initial investigation order

This order selects measurements. Measured delay, CPU, memory, and I/O are unknown
for these flows until an experiment below supplies them. A lower-priority row still
needs coverage; a measured bottleneck can move it ahead of the current hypotheses.

| Order | Candidate flows | User impact and assumed frequency | Source-supported scaling/resource question | Change risk |
| --- | --- | --- | --- | --- |
| 1 | I04, I05, I06, I07: selection and navigation | Repeated throughout browsing and staging; an obsolete result can mislead the next action | Commit detail/files currently wait for optional `commit_stat` in one `Promise.all`. Working-tree/current-file reads serialize through one active reader. Measure command work, request queueing, payload/row costs, and reuse separately | Medium: stale-result guards, remembered file, failure UI, and rapid A/B/A are load-bearing |
| 2 | I12, I13, I14, I18: mutations and convergence | Central editing loop; correctness cost is high even when latency is short | Distinguish mutation duration from status, operation-state, graph, and selected-diff refresh. Count repeated reads and bound pending work during saves and command completion | High: Git semantics and truthful post-operation state |
| 3 | I01, I02, I18: repository/view switching and background work | Assumed frequent for multi-repository users; affects access to all foreground work | First import/mount versus preserved view, number of tabs, deferred repository opening, visible stats, autofetch, and worktree scans | Medium/high: lifecycle, listener teardown, background fairness |
| 4 | I08, I09: finder and history search | Frequency unknown; used to reach content unavailable in current viewport | Finder waits for file listing before opening and ranks all paths per query. History search has a 200 ms debounce and may page deeply. Check obsolete responses before optimizing query work | Medium: ordering, current query identity, navigation side effects |
| 5 | I03, I10, I11, I17: layout, compare, diff options, reviews | Frequency depends on workflow; repeated keys/drags need immediate feedback | Mounted DOM, layout propagation, changed-file width, full-file enrichment, thread count, anchor resolution | Medium: layout, content mode identity, comment position |
| 6 | I15, I16: conflict and history-changing workflows | Assumed less frequent, but delays interrupt recovery and Git correctness is critical | Conflict region count, worktree width, graph rebuild cost, sequential bulk actions | High: conflict recovery, hooks, reflog and operation state |

Two falsifiable hypotheses follow from the inspected code:

- **H01: optional statistics extend commit selection's critical path.** Compare
  individual `list_commit_files`, `get_commit_detail`, and `commit_stat` durations
  with the first correct usable detail/file list. If stats do not extend that path
  materially, changing the presentation order has no established performance case.
  An alternative must prevent late statistics or details from another OID appearing
  under the current selection.
- **H02: obsolete search responses change current results or selection.** The
  inspected search callback assigns results and selects their first OID without
  checking the current query or whether search was closed. Reproduce controlled
  out-of-order success/failure and close/clear while pending. Source inspection is
  a hypothesis about behavior, not a completed reproduction or a latency measurement.

## Responsiveness mechanisms to preserve

These mechanisms were read in source; their benefit still needs workload-specific
measurement before attaching a speedup claim to them.

- [Coalesced tasks](../src/lib/coalesced-task.ts) allow one active reader and one
  pending rerun. Notifications keep the first deadline rather than postponing work
  throughout a burst. Explicit `run()` requests bypass that notification delay.
- [Command-completed notifications](../src/lib/repo-change-subscription.ts) request
  immediate refresh. RepoView filters file-specific reads by affected paths and
  defers refs-only graph publications until tab activation.
- RepoView uses generation, repository, OID, and path checks to reject obsolete
  commit, file, compare, and current-source responses. Commit-file reuse matches
  repository, OID, context lines, whitespace, and full-file options.
- CommitGraph rejects stale pages, limits non-progressing paging attempts, and
  reads statistics for visible commits in batches of at most 32. Hidden statistics
  columns avoid that read path. Stored ref visibility gates the first page.
- RepositoryTabs prepares the foreground first, mounts visited views, and keeps
  unvisited views unmounted. App preserves visited views while switching tabs.
- Autofetch uses one completion-based queue with focus and manual-operation gates.
  Refs-only publications avoid worktree refreshes.
- DiffViewer distinguishes retained usable content from a pending new selection or
  content mode. Diff mutation handlers guard against overlapping hunk/line actions
  and await the relevant diff refresh. File list movement follows command success.
- [Diff highlighting](architecture/diff-highlighting.md) and
  [virtualization](architecture/diff-virtualization.md) document existing bounded
  parsing, source reuse, and rendering decisions. Their historical measurements
  are context, not fresh baselines for this investigation.

## Measurement record

Each experiment needs a flow ID, a falsifiable hypothesis, and a reproduction that
reaches the real caller. Record the build commit plus working-tree changes, binary
and fixture hashes, engine/display/window, process identities, input delivery, and
endpoint predicates. Recheck the result's identity and Git contents before using a
fast completion as evidence. Failed or superseded actions remain in the record.

Use bounded serial trials on this shared laptop. Keep builds, tests, OCR, and other
benchmarks outside measured windows. Record competing activity and rejected runs,
including why a pair is invalid; repeat complete pairs without discarding the
original evidence. Alternate before/after order. Preserve raw samples, sample count,
absolute times, variation, and observation coverage. Small samples support medians
and ranges, not trustworthy tail-percentile claims.

Workloads distinguish process-cold, first-open, and warm reuse; none implies a cold
OS filesystem cache without evidence. Record repository history depth, tracked-file
count, changed-file count, content sizes, index state, and relevant modes. Include
isolated actions and bounded rapid sequences with actual delivery checks. Mutations
run only against disposable fixtures, including failures and partial staging.

Resource measurements cover app-host/WebContent/GPU-process CPU time, memory
footprint, and available I/O counters over the same action windows. State whether
memory sums double-count shared pages and whether a GPU-process number is CPU time.
Record scheduling stalls separately from captured visible discontinuities. An
unavailable counter or an unobserved presentation interval remains an explicit
limitation, not zero cost. Measure resource trials separately from intrusive capture
or geometry probes where their overhead would confound the comparison.

[Performance instrumentation](performance-instrumentation.md) provides automatic
`invoke:<command>` timing, named `diff.openCommitFile`, `diff.buildRows`, and
`diff.rowHeights` spans, and buffered raw JSONL. The
[native drive client](../scripts/drive/client.ts) evaluates awaited page operations
in an isolated app instance. The [application harness](application-harness.md)
provides real Git commands and deterministic correctness observations in a headless
DOM. These tools cover different layers; command timing and headless DOM completion
do not establish native display latency.

## Prior diff-scrolling evidence

The prior report and artifacts are **local, gitignored evidence**, unavailable from
a fresh clone: [responsiveness report](../.boris/blank-diff/responsiveness-20261115/REPORT.md)
and [independent review](../.boris/blank-diff/responsiveness-20261115/REVIEW.md).
The report states CPU group median reductions of 13.49% at slow speed and 23.64%
at fast speed for the stationary-viewport fix, while its following bounds do not
resolve a normal responsiveness improvement or regression. Those numbers are
reported prior evidence, not freshly verified measurements here.

The scope was a native WKWebView path on a 60 Hz virtual display. It did not
establish physical-trackpad latency, high-refresh presentation, cold loading, or
file-switch latency. Controlled whole-WebContent suspension exposed an additional
response delay; it did not measure the frequency or cost of ordinary main-thread
contention. rAF timestamps and recorder counters did not count displayed frame drops.

Two rejected hypotheses remain in that report:

| Hypothesis | Prior disposition and reopening condition |
| --- | --- |
| Derive primitive range bounds to avoid unchanged slices/keyed-list work | Rejected: CPU and following measurements did not establish useful response improvement. Reopen only with a new workload/cause hypothesis. |
| Buffer virtual-range updates while moving the exact pixel offset | Rejected: more mounted content, no established response gain, and delayed input delivery confounded some CPU trials. Reopen only with a new hypothesis and validated delivery cadence. |

The associated source prototypes, recordings, scripts, delivery audits, and raw
statistics remain beside the local report. Lower CPU alone is insufficient to
accept an interaction improvement. The current investigation must establish fresh
baselines for the other flows.

## Measured experiments

### E01: optional statistics on the selection path

#### Debug-build screening

H01 is supported by native measurements. At 1,000 changed files, the first
`commit_stat` took roughly 270 ms while metadata and file enumeration took a few
milliseconds. The previous `Promise.all` made usable detail wait for that statistic.
The implementation requests all three reads concurrently, publishes the selected
OID, detail and file list together, then adds statistics for that same displayed
commit. It preserves the old coherent selection until the new metadata arrives.
A separate requested OID preserves repeated navigation and comparison intent.

Measurements ran on an Apple M5 Pro, 48 GiB RAM, 18 cores, arm64 macOS 27.2.1.
`sysctl`, `sw_vers` and `uname` verified this machine record.

The controlled series used four alternating before/after pairs at each width,
24 fresh processes and 96 selections total. Each process selected revision 2,
revision 1, then returned to 2 and 1. The three-commit fixture rewrites every line
in 10, 100 or 1,000 TypeScript files, each with 200 lines. This spans change width,
not realistic history depth or a representative language mix. First selection
includes a cold component import/mount; subsequent uncached selection reuses that
component. OS filesystem caches were not cleared. The graph statistics column was
explicitly disabled to prevent speculative graph statistics from warming this
selection measurement. Separate screening runs retained that competing work.

Times below are milliseconds, median [minimum, maximum]. Each cell has four
per-process samples. Warm cells summarize the median of two returns per process,
so they are four independent launch summaries, not eight independent launches.

| Changed files | First usable, before | First usable, after | Next uncached, before → after | Warm return, before → after |
| --- | --- | --- | --- | --- |
| 10 | 16 [14,17] | 13 [12,15] | 5 [5,6] → 2.5 [2,3] | 2.25 [2,2.5] → 2.5 [2.5,3] |
| 100 | 46 [45,47] | 20 [20,20] | 30 [30,30] → 4 [4,4] | 2.75 [2.5,3] → 3.5 [3,3.5] |
| 1,000 | 347.5 [343,356] | 88 [87,88] | 270 [268,277] → 13 [13,14] | 11 [10.5,11.5] → 12 [11.5,12.5] |

These are synthetic DOM-click to exact identity, file-list and layout readiness
measurements in native WKWebView. The oracle checks the selected row, exact short
OID, summary, all expected paths, visible/non-inert ancestry, and a laid-out row.
It does not establish first physical display presentation. Rounded page clocks
limit claims about sub-millisecond differences. No tail percentile is inferred.

The tradeoffs are explicit:

- Highlighting waits for metadata rather than moving ahead of the detail. At 1,000
  files the DOM highlight median changes from 1 to 6 ms on first selection and from
  1 to 11.25 ms on warm returns. This keeps displayed identity coherent.
- CPU work is not removed. Summed host/WebContent/GPU-process CPU for first
  selection changes from 484.9 [480.8,495.2] to 497.6 [493.6,502.7] ms at 1,000 files;
  warm CPU is 28.9 [27.2,30.3] versus 29.7 [28.4,31.0] ms. At 100 files first CPU is
  77.0 versus 81.6 ms. Earlier usability is the benefit, not a CPU saving.
- The three selection reads plus two rAF callbacks complete at median 360.5 versus
  304.5 ms on the first 1,000-file selection, and 290.5 versus 309 ms on the second.
  At 100 files the first interval is 54 versus 69.5 ms. Callback phase and statistics
  work still matter. This endpoint is **not global background settlement**.
- Summed end-of-window memory footprint at 1,000 files is 321.9 versus 320.2 MiB
  on first selection and 325.2 versus 324.1 MiB warm. These endpoints are not peak
  memory or deduplicated physical memory. Process CPU includes the GPU process's
  CPU, not hardware GPU utilization. The recorded I/O counters measure physical
  disk accounting; zero reads can coexist with cached filesystem work.
- The maximum rAF gap per first 1,000-file action has median 95.5 versus 90 ms.
  A large list still mounts synchronously. These gaps do not count displayed
  dropped frames. Warm gap medians are both 17 ms.

The implementation adds one requested-OID state and navigation props. It does not
add a cache, debounce or prefetch. Barrier-controlled tests cover late metadata and
statistics, dismissal, failed selection, opening a file before statistics, repeated
keys, and return to the displayed commit. Review findings and their final fixes are
recorded separately below.

The [committed sample record](performance-data/interaction-20261115.json) contains
binary hashes, fixture OIDs, harness hashes, CPU calibration, command spans and
per-action measurements. Local raw evidence is under
`.boris/interaction-performance-20261115/accepted-*`, with source manifests,
`task.patch`, both build logs and `variants.json`. Both binaries were built from one
frozen copy, including concurrent updater work present in the shared tree; only
this task's patch differed. The absolute results are for this debug-Rust,
production-Vite drive build, not a released app. The optimized confirmations below
include the reviewed selection implementation and the subsequent navigation fixes.

#### Optimized release confirmation

The selection changes were rebuilt with optimized Rust and production Vite
from one frozen copy at `11af5505`. Control reverses only
`final-production.patch`; candidate restores it. Candidate component bytes were
compared with the workspace before measurement. A final paragraph-only formatting
change produced byte-identical paths and contents for all 34 production Vite assets;
both source hashes and that equivalence are retained in the sample record. Four alternating pairs per width
again give 24 launches and 96 selections, separate from the debug series.

| Changed files | First usable, before → after | Next uncached, before → after | Warm return, before → after |
| --- | --- | --- | --- |
| 10 | 13 [13,14] → 11.5 [11,12] | 3 [3,3] → 2.5 [2,3] | 2 [2,2] → 2.25 [2,3] |
| 100 | 30.5 [30,32] → 19.5 [19,20] | 15 [14,15] → 3 [3,3] | 2.5 [2,3] → 2.5 [2.5,3] |
| 1,000 | 201 [199,201] → 84.5 [84,85] | 125 [125,126] → 10.5 [10,11] | 8.5 [8,9] → 8.5 [8.5,9.5] |

E01 is retained on this release evidence. It removes 116.5 ms from median first
usable detail and 114.5 ms from the next uncached 1,000-file selection, while the
warm median stays unchanged. The benefit scales with changed-file width; the
10-file difference is too small to generalize from these samples.

At 1,000 files, first-action CPU is 314.9 [309.5,320.7] → 329.1
[324.3,337.7] ms, and warm CPU 23.8 [23.2,25.0] → 24.9 [24.4,25.9] ms.
This accepts about 14.2 ms additional first-action process CPU for earlier useful
content. First end-footprint medians are 320.3 → 323.2 MiB, and warm 324.6 →
327.0 MiB. At 10 files the observed warm footprint is 229.1 [226.4,242.4] →
242.6 [241.4,243.4] MiB; at 100 files it is 251.8 [243.6,259.5] → 258.8
[245.4,260.3] MiB. These variable, summed process endpoints do not establish a
memory leak or memory neutrality; long-session behavior remains open.

DOM highlight medians at 1,000 files are 1 → 3 ms first and 1 → 7.5 ms warm.
Selection reads plus two rAF callbacks complete at 214.5 → 172.5 ms first,
146 → 164 ms second and 31.5 → 31.25 ms warm. Those later endpoints are not
background quiescence. First-action maximum-rAF-gap medians are 95 → 91.5 ms;
large-list synchronous rendering remains. There is no displayed-frame claim.

The release record and all per-action CPU, memory, I/O and command observations
are in the same committed JSON under `release_summary` and `release_runs`.
Local `release-*` directories, build logs, `release-measured-source-manifest.json`,
`final-production.patch` and `variants.json` carry the source/binary chain.

#### Confirmation of the delivered source

Ref/review navigation subsequently gained an explicit navigation-intent guard,
described under Review and regression evidence. The exact delivered component bytes
were copied into the frozen source and rebuilt. Four alternating pairs at 1,000
files, eight launches and 32 selections, confirm that binary against the same
optimized control. This series is separate from the width comparison above.

| Endpoint | Before, median [min,max], ms | Delivered candidate, median [min,max], ms |
| --- | --- | --- |
| First usable detail/files | 215 [201,227] | 86 [85,88] |
| Next uncached selection | 133.5 [126,141] | 11 [10,12] |
| Warm return, per-launch median | 8.75 [8.5,9.5] | 9.25 [8.5,9.5] |
| First selection reads plus two rAF callbacks | 229.5 [215,244] | 178.5 [169,182] |
| First maximum rAF gap | 98 [91,107] | 95 [92,97] |

Each cell has four independent launch summaries. The earlier CPU increase did not
repeat distinctly: first-action CPU is 348.8 [330.9,380.0] versus 346.9
[332.7,358.3] ms, with overlapping ranges. No CPU reduction is claimed. First
end-footprint is 319.8 [319.5,324.6] versus 323.3 [321.5,323.7] MiB; warm
end-footprint is 325.0 [324.2,328.3] versus 326.2 [324.7,326.7] MiB. The warm
readiness difference is within the observed ranges and page-clock granularity.
DOM highlight still trades immediate selection for coherent content: first
medians are 1 versus 3 ms and warm medians 0.5 versus 8.25 ms. The second selection's
reads plus two rAF callbacks take 150.5 versus 164 ms; early usability does not mean
all reads finish earlier. Physical I/O counters were zero in these windows, which
does not establish absence of cached I/O.

The committed `delivery_summary`, `delivery_runs` and `deliverySource` retain the
final samples, exact production patch, component and binary hashes. Local
`delivery-1000-*`, `delivery-v3-build.log` and `delivery-v3-production.patch` provide
the raw chain. The accepted benefit is earlier correct usable content in wide,
uncached selections, with the resource and feedback tradeoffs above.

### E02: rejected selection alternatives

The initial hypothesis was that publishing metadata sooner would be sufficient.
Warm-path native measurements falsified it for several render strategies.

| Alternative | Observation and disposition |
| --- | --- |
| Clear and remount detail before each request | Cold 1,000-file DOM readiness fell to about 44–46 ms, but warm readiness rose from about 10–12 to 34–36 ms. Rejected. |
| Keep detail mounted with inherited visibility/inert gating | Warm readiness remained about 33–36 ms. Removing inert and batching resets still took about 29–37 ms. Rejected. |
| Keep detail mounted in a hidden child wrapper | Superficial DOM readiness looked fast, but warm CPU rose from about 28 to 67 ms and rAF gaps reached about 47–52 ms. Rejected. |
| Opacity/inert gating | Warm readiness about 36 ms, with a similar scheduling gap. Rejected. |
| Atomic displayed selection with separate input cursor | Strict layout-aware before/after measurements are E01. Retained after the optimized confirmation and reviewed correctness fixes. |

These are screening observations from successive prototypes, not pooled samples.
Earlier scripts used a weaker DOM endpoint, so their absolute readiness values
cannot be compared with E01's stricter layout endpoint. Sources, binaries and raw
trials remain in `paired-*`, `retained-*`, `final-*` and the named variant files in
the local evidence directory. The historical `final-*` name refers to the rejected
hidden-wrapper prototype. Failed `pilot` and `pilot-2` observations are invalid:
Tauri's invoke property could not be replaced, and a substring could match a parent
OID. They support no performance claim. The replacement harness checks the exact
SHA control and uses the application's existing performance sink.

[E06](#e06-large-changed-file-lists-retain-the-full-dom) tested windowing within
CommitDetail's existing shared metadata/file viewport. Its three prototypes were
rejected for painting, response or resource costs, so the full-DOM list is retained.
Reopening requires a new causal hypothesis or representative workload; these results
do not justify a new cache or viewport restructuring.

### E03: broader interaction screening

Four native launches completed the original 37-action matrix, 148 successful
checks. These used the rejected hidden-wrapper prototype, so they screen other
paths rather than establish final selection performance. The matrix opens actual
file content, exercises staged and unstaged line/hunk/file/all mutations, commits,
checks HEAD/parent/content, switches repositories, searches history, uses j/k,
changes review views and opens current source through the finder.

| Flow | DOM usable median [min,max], ms | Interpretation |
| --- | --- | --- |
| First commit file | 140 [138,140] | Observed `diff_commit_file` command dominates; first import also contributes. |
| Different uncached file | 92.5 [91,94] | Backend command dominates this debug build; release comparison is needed. |
| Revisit file | 5 [4,6] | Existing reuse is effective in this fixture; preserve it. |
| Rapid file sequence, last delivered input to result | 5 [5,5] | Actual delivery spacing was 20–22 ms; no compressed catch-up schedule. |
| Commit search | 206 [206,207] | Includes the existing deliberate 200 ms debounce. |
| Rapid search, last input to result | 208–212 | Direct stale-response correctness was investigated separately. |
| Close search | 165.5 [158,177] | Includes the 150 ms closing transition; no proven optimization. |
| Stage line / unstage line | 32 [29,33] / 12 [9,13] | Partial patch and resulting lists checked. |
| Stage hunk / unstage hunk | 26 [26,27] / 5 [5,6] | Last-hunk removal can close the diff automatically. |
| Stage file / unstage file | 3.5 [3,4] / 3 [2,3] | No evidence for adding cache/debounce. |
| Commit | 168.5 [165,172] | Includes post-command UI consistency; hooks/signing were disabled here. |
| First visit to second repository | 19 [17,21] | Existing deferred open keeps this small fixture responsive. |
| Retained repository return | 3–4 | Preserved mounted views remain useful. |
| Finder current-source open | 45.5 [45,47] | File listing, selection and rendered source checked. |

This series used application Git command oracles, including expected patch markers.
Independent review required a stronger oracle: complete index/HEAD blob maps and
all working-tree bytes checked independently after each action. The final runner
adds that oracle, directory stage/unstage, rapid history keys, a deliberately
rejected commit and pane keyboard navigation. Its final results are recorded below.
The independent Git reads occur after resource snapshots and can warm the next
filesystem read. Matrix resource intervals include application correctness reads,
so they are not gesture-only CPU. Global background settlement remains unobserved.

#### Optimized matrix

Four optimized launches each completed all 51 actions, 204/204 checks,
including the full independent Git oracle after each action. A separate pilot
completed 51/51. The rejected commit left HEAD, index, worktree and draft intact;
the verified hook error was dismissed through the native dialog route. Directory
staging included a similarly named neighboring directory to check scope.

| Flow | Median [min,max], ms |
| --- | --- |
| First file / different uncached file | 38.5 [38,40] / 26.5 [26,27] |
| Revisit / rapid file sequence after last input | 5 [5,5] / 4.5 [4,5] |
| Stage/unstage selected line | 14 [13,18] / 8.5 [8,10] |
| Stage/unstage hunk | 10.5 [9,12] / 5.5 [5,6] |
| Stage/unstage file | 4 [4,4] / 3.5 [3,4] |
| Stage/unstage all | 5 [4,6] / 4.5 [4,5] |
| Stage/unstage directory | 5 [5,18] / 4 [3,4] |
| Commit success | 160 [157,162] |
| Rejected commit, including automatic dialog dismissal | 605.5 [584,622] |
| First/retained repository | 20 [18,22] / 4 [3,4] |
| Review open/return | 9 [8,10] / 4 [4,5] |
| Finder source open | 18 [17,19] |
| Search / rapid search after last input | 205 [204,207] / 208.5 [204,209] |
| Rapid older/newer history keys after last input | 2.5 [2,3] each direction |
| Four left/right collapse/reopen commands | Medians 1–2; all individual observations 1–2 |

These cells each summarize four launches. The file-open difference between this
release series and the debug screening is a build-profile observation, not a
product-change speedup. In the release pilot the command spans were 29/15 ms versus
44/26 ms total opens. Hunk/line timings in these two earlier matrices end at command
completion and status-list readiness, followed by exact Git verification. They do
not explicitly await remaining-diff controls. The structural evidence favors retaining current diff reuse;
new caching or prefetch is not justified by this fixture. E07 covers a wider file
size with highlighting skipped. Highlighted opens remain the next discriminating
measurement.

Resource windows include application correctness reads after DOM usability;
independent Git reads follow those snapshots. Median summed process CPU is 94.3 ms
for first file open, 76.2 ms for a different file and 39.8 ms for a reused file,
32.2 ms for line staging,28.3 ms for hunk staging,17.1 ms for directory staging
and 62.4 ms for committing. These are not gesture-only CPU comparisons. The
committed JSON's `matrix_release` includes count/range, end footprints, I/O, rAF
gaps and individual observations for all 51 flow positions, including fast flows.
Its unobserved presentation and background endpoints stay null. Raw requested
identities, delivery receipts, transitions and fixture OIDs are retained; exact
Git oracle maps are deduplicated by content hash. Native Find opening retains null
for identity/delivery fields its original result did not capture. The source
record includes the base commit, production patch and component hashes.

A forced controller failure separately verified that the runner preserves its
attempt, partial spans, resource snapshots and screenshot, then reaps its own app
(`failure-artifact-probe.log`). All final native runs ended before checks resumed.

#### Delivered-source matrix and stronger mutation endpoint

Four launches of the exact final binary completed 53 actions each, 212/212 checks.
The hunk/line endpoint now also requires the exact remaining visible added lines
and enabled hunk controls, or a closed diff when the selected side becomes empty.
Two consecutive branch-ref clicks additionally verify that repeated navigation
keeps the selected commit open. Every action again passes the independent full
HEAD/index/worktree oracle; successful and rejected commits retain their separate
parent/message/draft checks.

| Flow | Median [min,max], ms, n=4 |
| --- | --- |
| First / different uncached file | 38 [37,39] / 27 [26,27] |
| Revisit / rapid file sequence after last input | 5.5 [5,6] / 4 [4,5] |
| Stage / unstage line, including remaining-diff readiness | 14 [14,17] / 8 [8,9] |
| Stage / unstage hunk, including remaining-diff readiness | 11 [10,12] / 5.5 [5,8] |
| Stage / unstage directory | 5 [4,5] / 4 [3,4] |
| Commit success | 166 [163,173] |
| Rejected commit, including automatic dialog dismissal | 596.5 [593,600] |
| First / repeated branch-ref navigation | 5 [4,6] / 7 [4,10] |

All 53 positions, resource distributions, input/result identities and exact Git
oracles are committed under `matrix_delivery`. Local raw data is in
`matrix-delivery-verified`. An earlier attempt, `matrix-delivery-four`, stopped
because the new remaining-diff predicate was accidentally attached to close-detail;
its partial data and failure artifacts remain, and it supplies no accepted timing.
That predicate is now restricted to hunk/line mutations. No production mutation
algorithm changed. These fixtures establish bounded post-mutation consistency,
not larger-index performance or global background settlement.

### E04: search result ownership

Held-response tests reproduced an older search replacing a newer query's result
and selection. Search now invalidates pending requests on query replacement,
clear, close, repository/tab lifecycle changes, and rejects replies when the graph
is inactive. It preserves the existing debounce and completed search state across
tab switches. Runtime tests exercise successful and failed out-of-order replies, lifecycle
changes, repeated single-match navigation and superseded paging. Search uses the
idempotent navigation callback; a shared scroll owner cancels old paging scrolls
when the user picks another row, uses arrows, changes match or closes search.
Current metadata/search errors report a toast; obsolete errors stay ignored. This is a correctness improvement for rapid interaction;
no search-speed improvement is claimed. Once a valid search result has initiated
navigation, that accepted commit navigation follows the normal selection contract.
Typing another query does not by itself deselect that commit.

### E05: diff scroll cadence, native startup configuration and rejected CSS

Retain the macOS change that configures WebView rendering before initialization.
Four alternating pairs changed median captured diff-content intervals from
17.820 to 8.903 ms, at an additional 153.9–355.3 ms of process CPU per roughly
four-second paired resource window. Native painting and geometry checks below
preserve the existing stationary row layout. The private feature API falls back
to WebKit's default when unavailable; an actual older OS remains untested.
The window-wide preference also adds 212.0–254.1 ms of process CPU in the two
graph-scrolling pairs. An initial graph capture gap remains unexplained. A later
four-pair cohort overlapped another checkout's tests and is excluded. Four replacement
pairs passed workload admission; their median ranges overlap, and capture gaps
occur in both builds. They do not establish a graph smoothness change.

The user reported that diff scrolling looked less smooth than graph scrolling and
made I19 the next priority. The baseline was an optimized drive build from
`376835f4`. The steady trace uses a disposable repository with 400 history commits
and a 1,500-line added TypeScript file. Four alternating gestures each deliver 100
nonzero wheel events, 12 px every 8 ms, followed by an end event. Each gesture must
complete its 1,200 px excursion or return. This is injected native wheel input;
physical trackpad input remains unmeasured.

The admission check requires all 404 native events with the intended target,
delta and phase, exactly 400 matching browser receipts, native delivery within
-0.1 to 3 ms of the scheduled time, and the complete excursion/return within 1 px.
Delay uses both recorded Mach-time start bounds, including
`plannedStartMachTicksLowerBound`. Capture status and temporal coverage must also
pass. A requested 120 Hz virtual mode reported a refresh rate of zero, meaning
unspecified; the request alone does not establish its physical refresh rate.

The initial pixel analysis uses one text crop per view, a mean absolute grayscale
difference above 3, and the 100–700 ms portion of each gesture. These are observed
changes between captured frames, not physical display FPS or counts of dropped
frames. Within-run intervals are dependent observations, not independent launches.

| Baseline view | Admitted launches | Captured frames | Observed pixel-change interval, median [min,max], ms | Median rAF gap, ms |
| --- | --- | --- | --- | --- |
| Graph | 1 of 2 | 441 | 8.949 [7.624,19.156] | 17 |
| Diff | 1 of 2 | 469 | 17.623 [8.230,37.299] | 17 |

The excluded graph run lost 38 browser receipts and had 87.411 ms maximum native
delay. The excluded diff run had 9.568 ms maximum delay and a suspended capture
status. The admitted runs support a cadence difference in this fixture. Their
small count and single-crop analysis do not establish its frequency across normal
use. The identical rAF medians also show why rAF alone cannot compare the visible
motion of these two paths.

#### CSS scroll timelines: cadence improved, painting failed

WebKit documents compositor-thread updates for eligible scroll-driven animations
in [Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/).
That mechanism motivated replacing the diff's JavaScript-published pixel offset
with a CSS scroll timeline while retaining its mounted row window. Two admitted
steady captures of the finite-layer prototype recorded median pixel-change
intervals of 8.966 and 8.901 ms. Both still had 17 ms median rAF gaps.

The painting checks rejected this approach and its subsequent variants:

| Variant or diagnostic | Captured result and disposition |
| --- | --- |
| Moving finite layer | Fast-fling captures failed in all three attempts: 1/516, 1/488 and 1/528 frames had dark gaps of at least 64 px. Largest gaps were 157, 168 and 336 px. Rejected. |
| Fixed-origin, full-height layer | Normal fast flings passed in three captures; one was inconclusive because of capture status. A planned 100 ms WebContent suspension then exposed 13/545 blank frames, including a 698 px whole-pane gap, versus 0/550 for baseline. Rejected. |
| Limit animation to the mounted range | Suspension still exposed 4/518 blank frames, versus 0/482 for baseline. Rejected. |
| Remove the clipping ancestor | Suspension still exposed 2/498 blank frames. Rejected. |
| Attempt local window coordinates | The recording contains 6/496 blank frames, but the injected stylesheet's effect was never verified. This does not establish a tested local-coordinate alternative. |
| Freeze range publication during the gesture | The diagnostic contains 7/492 blank frames. It does not establish what would happen with a verified local-coordinate implementation. |

These suspension trials stop the entire WebContent process and verify its stopped
state. They test a failure boundary, not the occurrence rate or cost of ordinary
main-thread contention. DOM coverage markers stop updating with that process and
cannot prove that the compositor painted rows. A reported coverage of 1 therefore
does not overrule captured blank pixels. The compiled CSS candidates are rejected;
their cadence observations are not an accepted product optimization.

The local-coordinate intervention used an injected `<style>` element. A later
geometry negative control using the same mechanism showed `sheet=false` and an
unchanged computed offset, so insertion alone was not proof that CSS reached the
rendered element. Its initial pass is an invalid mutation experiment. A new
negative control sets the row offset directly with `style.setProperty`, verifies
that intervention, and fails at scroll position 450: expected row top -350 px,
observed 100 px. The raw local-coordinate and frozen-publication records remain,
but they cannot reject a local-coordinate design. The compiled finite, full-height
and bounded candidates, and the direct overflow change, retain their separate
painting evidence. Future interventions need computed-property or behavior
readback before their outcomes can settle a hypothesis.

The later four-pair fixed-layer capture batch has **zero complete admitted pairs**.
Pair 1's candidate exceeded the 3 ms delivery limit at 3.314 ms; pair 3's baseline
reached 3.122 ms. Baselines in pairs 2 and 4 lost receipts and reached 137.785 and
49.836 ms. Their apparently faster candidate captures cannot support a paired
performance claim. The separate resource batch has only two input-valid pairs,
and lacks a contemporaneous CPU conversion calibration and bracketed snapshots.
Its raw counters are exploratory evidence, not an accepted CPU or memory tradeoff.

#### Native rendering preference diagnostic

On the main display, which reports a maximum of 120 frames per second, one
baseline capture recorded a 17.844 ms median pixel-change interval. Changing the
private `PreferPageRenderingUpdatesNear60FPSEnabled` preference after WebView
creation recorded 17.805 ms; rAF medians stayed at 17 ms. The same after-creation
experiment on the virtual display recorded 17.932 ms. This change timing did not
remove the cadence limit in these trials.

A separate test-only native probe set the preference before WebView initialization.
Its main-display capture passed input and capture admission and recorded
8.897 ms median pixel changes, with 8 ms median rAF gaps. This is one diagnostic
launch using native method interception, not a shipped implementation or a measured
resource tradeoff. It supports testing configuration before initialization. The
preference and its feature-control API are private, so the experiment alone does
not establish a supported production integration.

Those probes placed the window on `CGMainDisplayID()`. Their `physical` label does
not prove that the main display was hardware; the reported maximum refresh rate
does not establish actual presentations either. The preserved artifacts retain
the original labels, with this provenance limit.

An initial application candidate sets the preference through a WebView
configuration before creating the main window. Its first capture was inconclusive
because one short idle window contained no pair of complete frames entirely
within its bounds. An explicit reanalysis
requires motion comparisons in all four gestures and idle comparisons across the
trace, reporting the per-gesture idle counts as `[0,10,10,1]`. Both text crops then
recorded 8.884 ms median pixel changes at threshold 3, with 253 intervals each
and a 7.516–19.198 ms range. Input and capture checks passed. The original verdict
and the reanalysis are retained separately. This single pilot supplies no accepted
before/after or resource claim; the planned four alternating pairs per observation
mode form the separate comparison below.

The frozen comparison candidate and baseline both passed the native geometry
probe's 32 mode/position combinations, selection and deselection, and wrapped
sidebar-resize anchoring. Both kept line index 332 as the first visible row while
the viewport narrowed from 812 to 804 px; their scroll positions adjusted from
12,000 to 11,980 px with 36 px rows. These are DOM geometry and synthetic pointer
checks, not painted-frame evidence. Native readback showed the baseline's near-60
preference enabled and the candidate's disabled. Both retained a nonpersistent
drive data store with a null identifier. An unavailable feature on an older
operating system remains a separate compatibility condition.

Store checks used a separate temporary build with a configuration-only overlay
and byte-identical native helper. A named persistent store returned its requested
identifier; incognito with that same requested identifier returned a nonpersistent
store and null identifier. These were not alternate configurations of the measured
final binary. A separate native probe made the feature-list query return nil in
the final binary: startup and the geometry probe completed, and the default near-60
preference remained enabled. This exercises a missing feature list on the current
OS; it does not establish behavior on an older OS or a missing selector there.

#### Native startup comparison

Four alternating baseline/candidate pairs completed each observation mode: eight
capture launches and eight separate resource launches. All 16 passed strict input
admission; all captures passed status and temporal coverage, and all resource
trials passed CPU calibration and process-identity checks. They used identical
frozen harness hashes and a requested 120 Hz virtual mode, whose reported refresh
rate remained unspecified. The production change configures the preference before
WebView creation; the measurement probe only reads it back.

The machine was an Apple M5 Pro with 48 GB memory and 18 cores, running macOS
27.2.1 (26B131). Fresh `system_profiler` output identifies display ID 1 as the
built-in 3456 × 2234 panel, with logical resolution 1728 × 1117 at 120.00 Hz.
That hardware record supplements the per-run display metadata; it does not
establish each frame's physical presentation.

Each cell summarizes four independent launches as median [minimum, maximum]. The
cadence row summarizes each launch's median at gray threshold 3, not all captured
intervals pooled together.

| Observation | Baseline | Native candidate |
| --- | --- | --- |
| Captured pixel-change interval, ms | 17.820 [17.781,17.923] | 8.903 [8.880,8.945] |
| Summed host/WebContent/GPU-process CPU, ms | 1,421.4 [1,410.1,1,425.6] | 1,638.2 [1,579.4,1,774.6] |
| Summed end-of-window footprint, MiB | 257.6 [254.5,258.7] | 260.1 [254.3,267.1] |

Both text crops produced the same cadence medians at thresholds 3 and 5;
threshold 1 preserved the separation. Resource intervals were 4.011–4.013 seconds,
including the 200 ms tail. The candidate spent 153.9–355.3 ms more process CPU in
each paired interval. The observed benefit is more frequent captured content
updates, with added CPU cost. GPU-process CPU is not hardware GPU utilization.
The overlapping memory endpoints do not establish memory neutrality or a leak.
All recorded physical read/write byte deltas were zero; cached I/O is not excluded.

Individual content-change intervals still ranged from 7.989 to 45.512 ms in
baseline and 7.393 to 29.628 ms in candidate. Motion-window capture gaps reached
19.172 and 18.525 ms, respectively, so the recordings cannot establish unseen
presentations. These runs omitted a continuous rAF observer. They establish this
bounded captured-cadence/CPU tradeoff, not physical input latency, a tail-latency
estimate, or a blank-painting verdict.

The preference applies to the main WebView, so its cost extends beyond the diff.
Two additional AB/BA graph-scrolling resource pairs passed the same admission
checks over 4.010–4.014 second windows:

| Graph pair | Baseline process CPU, ms | Native candidate, ms | Added CPU, ms |
| --- | --- | --- | --- |
| 1 | 1,992.974 | 2,247.080 | 254.106 |
| 2 | 1,999.827 | 2,211.832 | 212.005 |

Summed footprint endpoints were 256.0 and 262.7 MiB for baseline, versus 263.2
and 266.1 MiB for candidate. Physical I/O byte deltas were zero in both pairs.
These small samples retain the endpoint and cached-I/O limits described above.

One separate graph capture pair recorded median content-change intervals of
9.094 and 8.985 ms, respectively, in both crops and at all three thresholds. That
single pair does not establish a graph-cadence improvement. The candidate recording
also has a 57.093 ms motion-window capture gap, compared with 11.731 ms for
baseline, leaving motion unobserved during that interval. It cannot identify
application frame loss.

Four separately declared alternating graph capture pairs passed input and capture
checks, but all eight process inventories show another checkout's active Rust
tests. They are excluded from clean-run confirmation. Their retained, confounded
per-launch median intervals were 9.036
[9.011,9.041] ms for baseline and 8.923 [8.825,9.012] ms for candidate, with both
crops agreeing at threshold 3. Motion-capture gaps were at most 14.260 and
11.174 ms, respectively. Within-gesture browser wheel-receipt gaps were at most
16 and 14 ms. The original 57.093 ms capture gap did not recur in these recordings,
but this cohort cannot resolve its behavior under the intended quiet conditions.
Its cause remains unresolved, and the original pair is retained separately.
Neither the small median difference nor the excluded cohort establishes a
graph-cadence improvement or normal-use tail behavior. The retained change accepts the observed graph CPU
cost as well as the diff cost; other interactions and long-session costs remain
open.

Four replacement AB/BA graph pairs passed the entry/exit workload checks and the
input/capture contract. Their group medians [range of launch medians] were
9.010 [8.940,9.105] ms for baseline and 9.053 [9.010,9.129] ms for candidate,
with both crops agreeing at threshold 3. Motion-capture gaps reached 59.076 and
65.461 ms, respectively; within-gesture browser wheel gaps reached 15 and 14 ms,
and maximum native delivery delays were 1.215 and 1.710 ms. These overlapping
ranges do not establish a graph improvement or regression. The capture gaps leave
presentation unobserved and cannot count application frame losses or resolve
normal-use tails. The original gap remains unattributed. The predeclared cohort
was retained whole, without further runs selected to remove those gaps.

Two separate display-control pairs also passed admission. Each cell below is one
launch's median; these samples are not pooled with the four-pair batch.

| Display control | Baseline pixel-change interval, ms | Native candidate, ms |
| --- | --- | --- |
| Main display, verified built-in, reported maximum 120 FPS | 17.795 | 8.954 |
| Virtual display, requested 60 Hz, actual rate unspecified | 17.963 | 17.913 |

Both crops agree at threshold 3. The main-display manifests record display ID 1
and `CGDisplayIsBuiltin=1`; that establishes the built-in display as the capture
target. It does not turn injected wheel input into trackpad input or recorded
pixel intervals into physical display FPS. The 60 Hz request is a control
condition, not independent verification of the virtual display's actual rate.

#### Painting boundary and retained implementation

The measured native binary passed separate blank-paint checks at requested 60 and
120 Hz virtual modes. The initial 60 Hz runs recorded a window maximum of 60 FPS;
they did not establish painting behavior in the faster condition. The new 120 Hz
runs record the request and a window maximum of 120 FPS, with the actual display
mode rate still unspecified. Each cell below is one launch, reported as qualifying
blank frames / captured frames. The oracle checks whole-pane blanks and dark
vertical gaps of at least 64 px in the synthetic added-file fixture.

| Condition | 60 Hz request, baseline | 60 Hz request, native | 120 Hz request, baseline | 120 Hz request, native |
| --- | --- | --- | --- | --- |
| Fast fling, 1,500 lines, start at 12,000 px | 0/556 | 0/550 | 0/556 | 0/556 |
| Same fling with planned 100 ms WebContent suspension | 0/551 | 0/551 | 0/554 | 0/556 |
| Fast fling, 90,000 lines, start at 12,000 px | Not run | 0/550 | Not run | 0/556 |

All ten traces delivered their 216 native events and observed at most 118 mounted
rows. Maximum scheduling delays were 0.194–0.672 ms in the 60 Hz batch and
0.145–0.543 ms in the 120 Hz 1,500-line cases. The 120 Hz 90,000-line run had a
3.228 ms maximum delay; its pixel-oracle pass is retained, without a cadence
comparison claim. A separately declared 90,000-line confirmation at the 120 Hz
request recorded 0/556 blank frames and 0.141 ms maximum native delay, but its
artifact-creation interval overlaps the other checkout's active test run. It is
excluded from clean painting confirmation and does not replace the late-input
trial. The four 1,500-line requested-120-Hz checks completed before that test run.
A replacement 90,000-line trial passed entry/exit workload admission and recorded
0/550 qualifying blank frames. All 216 events matched the intended window, delta,
phase, momentum and position, with 0.223 ms maximum native delay. The requested
rate and window maximum were 120 Hz/FPS; the actual mode rate remained unspecified.
Its 8 ms median rAF interval is not a physical FPS measurement. The committed
record preserves the frozen harness hashes and raw-artifact hashes for this trial.
The 216-event painting protocol is separate from the 404-event cadence admission
contract.

At the 60 Hz request, suspension brackets were 103.350–103.407 ms for baseline and
109.640–109.765 ms for candidate. At 120 Hz they were 110.048–110.103 and
107.391–107.447 ms, respectively. The first input arrived inside each verified
stopped interval, and both processes resumed. A further candidate confirmation
after the harness cleanup fix passed at the 60 Hz request with 0/550 blank frames.
A SIGTERM smoke check separately observed cancellation while WebContent was
stopped, a resumed process, finalized recording metadata, exit 143 and all three
owned app processes gone. It is cleanup evidence, not a completed painting trial.

A pass establishes the pixel oracle's bounded observation. It does not
exclude smaller gaps, unseen frames, other content shapes or normal-user failure
rates. The 90,000-line run covers that mid-file position, not a traversal of the
entire file.

The retained implementation leaves the JavaScript offset and stationary virtual
row surface intact. It changes the main WebView's creation-time preference through
[the macOS configuration helper](../src-tauri/src/macos_webview.rs). The measured
benefit is more frequent captured diff-content updates, with added process CPU
in both diff and graph scrolling. Longer sessions, ordinary
trackpad gestures, other operating systems and hardware, and energy consumption
remain unmeasured.

The [committed scroll record](performance-data/scroll-cadence-2026-11-16.json)
retains artifact hashes, admitted and excluded run summaries, individual interval
samples, capture coverage, and prototype dispositions. Movies and full raw traces
remain local under `.boris/scroll-smoothness-20261116`; a fresh clone has their
hashes and the summarized evidence, not those recordings. The final source patch
is `native-final-production.patch`, tied to `source-native-final/source-manifest.json`
by `native-patch-provenance.json`. The older `native-production.patch` describes
the pilot before the reviewed startup fixes and cannot reconstruct the final
binary. The committed record preserves both identities. The maintained
[cadence runner and analyzer](../scripts/diff-scroll/README.md) provide multiple
crops, threshold sensitivity, strict delivery and calibrated resource capture.
The native comparison omits the continuous rAF observer used in the initial
screening. Existing one-crop results have not been silently reclassified as the
stronger analysis. The [runner instructions](../scripts/diff-scroll/README.md)
describe the idle-coverage rule, separate geometry checks and reanalysis route.

### E06: large changed-file lists, retain the full DOM

The large-list investigation is closed with the current full-DOM list retained.
Three ignored prototypes were rejected; none changes the application's production
source. The decision weighs the measured benefit against painting, response and
resource costs. It does not establish that future list optimization is impossible.
Reopen it for a new causal hypothesis or a workload that changes that tradeoff.

The fixture has 1,000 changed TypeScript files of 200 lines each, with graph
statistics disabled. Four fresh baseline launches reached DOM usability in
84/86/84/85 ms. A separate four-pair diagnostic measured unused directory-tree
construction at 1–2 ms and migration at 0 ms at page-clock precision. Skipping that
work left the first-action scheduling gap: usable medians were 85 versus 83.5 ms.
Tree preparation therefore does not explain the main observed delay.

V1 windowed the existing external viewport using flow spacers. Four alternating
AB/BA pairs used the same visible-row identity/geometry predicate on both builds,
including the full list extent. This endpoint differs from the earlier all-row
predicate; the cohorts are not pooled. First usable times were 83/83/84/84 ms for
baseline and 18/18/18/19 ms for V1, medians 83.5 and 18 ms. Both gave DOM feedback
in 3 ms. First-action summed CPU medians fell from 325.670 to 169.580 ms over a
longer read-completion-plus-two-rAF window. Oracle checks took 42–43 versus 0–1 ms,
including forced layout; subtracting that cost would not isolate application time.
Two pairs at each smaller size recorded 12/13 versus 14/14 ms at 10 files and
21/21 versus 18/18 ms at 100 files. Small-file warm-return medians also rose
slightly; the committed record retains each action rather than claiming uniform gain.

V1 failed the painting requirement. With a planned 100 ms WebContent suspension,
one encoded sample showed the entire 698 px list viewport blank at +87.462 ms
from first input, after resume at +79.904 ms. Adjacent populated samples were at
+77.972 and +96.010 ms. That establishes a blank sample with a zero-duration lower
bound, not its physical display duration or ordinary failure frequency. Independent
saved-frame review confirmed the counterexample. The four normal/paused captures
had maximum encoded gaps of 76.489/75.296/66.821/98.234 ms; incomplete coverage and
partial visual review cannot establish uninterrupted painting.

V2 adapted the existing stationary virtual-row surface while keeping overscan.
Its controlled-pause capture retained starting rows through the +81.993 ms sample;
the first inspected changed sample was +90.391 ms. Baseline already showed movement
at +4.489 ms. This is one controlled suspension comparison, not normal input
latency. Eight of 261 V2 frames were independently inspected. The largest capture
gap, 615.650 ms, occurred after input ended; it does not establish a display stall.

Ordinary V2 scrolling used four AB/BA capture pairs and four separate resource
pairs. Each launch delivered 404 native events across four alternating gestures;
capture requested five seconds at 120 Hz on a virtual display. Every paired trial
passed recorded collection, input, geometry, admission and cleanup validation.
At **filenames-inset, threshold 3**, launch pixel-change medians were
8.893 [8.813,9.014] ms for baseline and 8.933 [8.915,9.074] ms for V2, expressed as
group median [range of launch medians]. These overlapping ranges do not establish
a cadence benefit. Crop and threshold affect unchanged-span results:

| Crop and threshold | Baseline longest unchanged span range, ms | V2 range, ms |
| --- | --- | --- |
| Either crop, threshold 1; filenames-inset, threshold 3 | 0–10.459 | 9.141–9.698 |
| Status-and-filenames, threshold 3 | 0–52.579 | 9.141–58.418 |
| Either crop, threshold 5 | 0–59.625 | 9.178–61.288 |

These are observed sample spans, including capture gaps, not continuous display
stalls. The separate V2 pilot retained unchanged pixels for 188.231 ms at both
crops and all three thresholds. Its cause remains unresolved. It is retained
outside paired statistics; its nonrecurrence in four pairs does not dismiss it.

Across approximately four-second resource windows, baseline summed CPU was
1,280.907–1,385.571 ms and V2 was 1,751.811–1,783.240 ms. Each paired increase was
377.326–482.978 ms (27.23–37.71%). GPU-process CPU rose from 56.900–60.078 to
477.422–485.168 ms; this measures CPU, not hardware GPU activity. Summed endpoint
physical-footprint medians rose from 207,055,884 to 252,324,888 bytes while resident
size medians fell from 341,377,024 to 282,681,344 bytes. Neither metric is a peak;
sums may double-count shared pages. These costs and the suspension response
tradeoff rule out adopting V2 on the current evidence.

V3 tested whether the full-height moving plane caused that resource cost. Two
AB/BA pairs compared V2 with V3, separately from the full-DOM cohort. Native geometry
confirmed a reduction from 28,000 to 2,100 px with 75 mounted rows. GPU-process CPU
remained 465.146–485.860 ms for V3 versus 466.738–484.847 ms for V2. Paired total
CPU changes were −81.845 and +20.239 ms; endpoint footprint changed by −1,228,896
and −507,880 bytes from V2 values of 253,725,672 and 253,660,064 bytes. The small
sample leaves total-CPU direction unresolved and does not support plane height as
the main cause. V3 is rejected too. Distant retained focus can still enlarge its
plane. V2/V3 selection speed and full native correctness acceptance were not
measured, so neither inherits V1's selection gain.

The accepted change from E06 is measurement correctness commit `56b15954`:
convert to grayscale before FFmpeg cropping to preserve odd dimensions and origins.
Original failed pilot analysis remains preserved; corrected reanalysis is labeled
as derived evidence. The fix's recorded `just check` gate passed 1,980 Rust tests (one skipped),
4,533 frontend, 202 application and 53 visual tests. A separate Python harness
suite passed 144 tests. Those checks and its independent code review do not
constitute prototype acceptance.
The [committed E06 record](performance-data/large-file-list-2026-11-16.json) retains
individual samples, both crops and all thresholds, pilot outcomes, source/binary/
protocol/input hashes, reviews and local reproduction commands. A fresh clone has
those summaries and identities, not the ignored recordings, prototypes or adapters.
The maintained [interaction runner](../scripts/interaction-performance/run.py) and
[scroll tooling](../scripts/diff-scroll/README.md) remain available; exact prototype
reproduction requires the retained local artifacts. Physical trackpad timing,
normal-app presentation, background contention and long-session costs remain open.

### E07: large-file opening, no optimization and one correctness fix

At 6,000 lines with syntax highlighting skipped, opening a file is not a measured
bottleneck, so no optimization was attempted. The fixture was built past the
highlighting cap, so the path where highlighting runs, and its likely cost, is not
covered here. The pilots did expose a correctness defect, fixed in commit
`4586dd1c`. Commit, comparison and rebase views each stored one content mode, set
by whichever file loaded last. In full-file mode, after file B loaded in full,
returning to file A showed A's retained hunk payload under the full-file controls
until A's read landed. The stale-payload guard compared the view's mode rather than
the payload's. Each view's mode is now derived from the payload it shows, so that
payload is hidden behind "Loading diff…" until the read lands. Held-reply tests in
the commit, comparison and rebase suites pin the fix and failed against the earlier
code. Its gate, `mise exec -- env CARGO_BUILD_JOBS=2 NEXTEST_TEST_THREADS=2 just
check`, passed 1,980 Rust tests (one skipped), 4,539 frontend, 202 application and
53 visual tests. The fixed build has not been timed natively.

The fixture commit changes two files of 6,000 lines and 170,728 bytes each,
`recognized.ts` and `unsupported.txt`. Each edit is at line 1 and line 5,500, so
both content modes span past the 5,000-line parse window. A window longer than
that skips highlighting entirely (`MAX_SYNTAX_PARSE_LINES` in
`src-tauri/src/commands/diff.rs`). This is a payload size baseline, and it cannot
attribute a TypeScript versus plain-text difference to parsing. In hunk mode the
frontend receives a 13-line payload, and in full-file mode 6,002 lines.

Two fixed-order launches of E05's frozen native drive build each timed six actions.
The build predates `4586dd1c`. Each launch makes three opens in one mode, switches
mode, then makes two opens in the other mode. Pilot 1 starts in hunk mode with
`recognized.ts` and pilot 2 in full-file mode with `unsupported.txt`. The third
action in each mode returns to a file already loaded. Two launches in a fixed order
are a pilot, not a comparative cohort, and the runs did not start from a cold cache.
Actions are `HTMLElement.click()` events checked against a hit test, so native input
dispatch is outside the timing. Layout was inline, with word wrap, visible
whitespace, graph statistics and review threads all off.

The endpoint is the moment visible, hit-tested rows match the requested path, mode,
exact fixture text and gutter line numbers, together with the matching completed
read, then two rAF callbacks. A return to a loaded file must complete no new read
by its endpoint.

| Action | Pilot 1 endpoint, ms | Pilot 2 endpoint, ms |
| --- | --- | --- |
| First file, first open in the starting mode | 21 | 28 |
| Second file, first open | 26 | 21 |
| First file again, retained payload | 12 | 11 |
| Mode switch, first file reloads | 21 | 19 |
| Second file in the new mode | 27 | 25 |
| First file again in the new mode, retained payload | 14 | 9 |

The four full-file reads of 6,002 lines ended at 21 to 28 ms. Across all eight
actions that read from the backend, `invoke:diff_commit_file` took 2 to 13 ms and
`diff.buildRows` 3 ms or less. Usable content appeared 6 to 23 ms after input.
Summed host, WebContent and GPU-process CPU over each action window was 22.6 to
89.4 ms, and 8.3 to 15.5 ms for the four retained returns. Those windows run from
before the drive request to after its response, so they include harness transport
and predicate polling. In both pilots the fifth action, which opens the second file
in the new mode, first built rows for that file's retained payload of the other
mode, which is the defect above. Its timings and CPU include that wasted build.

Highlighted opens are the next candidate. A full-file view of a file under 5,000
lines highlights every line on both sides. The cap's source comment records
release-mode probe rates of about 85 ms per side at the cap on a quiet machine and
360 ms loaded, which would exceed every E07 endpoint. That figure is a probe
measurement of the highlighter alone, not an open measured through the app. Wrapped
rows, review threads and other grammars are also unmeasured.

Five earlier attempts are excluded and kept. `pilot-01` queried the graph before
the repository opened. `pilot-01b` was refused at process admission because a
competing `cargo`/`rustc` build was running, so no app launched. `pilot-01c` failed
on a quoting error in a setup script. `pilot-01e` set up the display before the web
view had a window. `pilot-01d` completed, but its usable-content check did not test
the content mode, and it accepted the retained payload of the other mode that
revealed the defect. The check now decides mode by line continuity, since the two
payloads share their top rows. Every launched attempt recorded complete cleanup.

The [committed E07 record](performance-data/large-file-open-2026-11-16.json) holds
each action's endpoints, spans and CPU, the fixture blob identities, executable and
harness hashes, the exclusion reasons and the local reproduction commands. Raw
results and the harness stay in the gitignored `.boris/large-file-open-20261116/`,
so exact reproduction needs those local artifacts. A fresh clone has the summaries
and identities only.

### Selection presentation and background limits

Three five-second ScreenCaptureKit attempts used a requested 60 Hz virtual display.
Two failed strict capture validation with a suspended/unknown frame status.
`capture-atomic-before-2` passed capture validation with 353 encoded frames and three
observed inputs; its manual visual classification is incomplete. It can be reviewed
without recapturing, but there is no validated candidate recording to pair with it.
Movies, decoded images, input receipts, identities and validation records remain
in `capture-atomic-*`. None yet establishes first-presented-frame bounds or absence
of visible discontinuities. Final snapshots and DOM/layout checks establish
content identity, not physical presentation timing. Physical input delivery and
timing in the normal app without drive instrumentation remain unmeasured. E05
separately investigates captured scrolling on the main display; it does not
supply selection-presentation evidence.

Background graph statistics were observed competing with selection in the earlier
screening series; disabling their column makes the controlled experiment explicit.
No claim of global background quiescence or remote-fetch fairness follows from it.
The current evidence does not cover large worktrees under saves, deep paging,
network activity, large conflict/review sets, or long-session memory growth.

## Measured priority and continuation

Frequency remains an assumption; no usage telemetry was collected.

| Priority | Next decision | Impact/frequency, evidence and risk |
| --- | --- | --- |
| 1 | Broaden I19 scrolling evidence while preserving the accepted behavior | The user made scrolling the priority. E05 changes captured diff-content cadence from 17.820 to 8.903 ms and accepts added process CPU in diff and graph scrolling. Painting checks pass at requested 60 and 120 Hz, including a replacement 90,000-line run with workload admission. Four admitted graph pairs have overlapping medians and capture gaps in both builds. Earlier competing-test confirmations remain excluded. Preserve the stationary row layout and configuration fallback. Physical trackpad timing, long-session cost and older-OS behavior remain open. High presentation risk. |
| 2 | Preserve the reviewed selection and navigation contracts | Browsing is assumed frequent. E01 removes 116.5 ms in the width series and 129 ms in the delivered-source confirmation at 1,000 files. Warm ranges overlap; CPU, memory and highlight costs remain explicit. Correctness risk requires held-response tests. |
| 3 | Next measurement: highlighted full-file opens under the 5,000-line cap | E07 opened 6,000-line files in 19 to 28 ms and returned to loaded ones in 9 to 14 ms, but its fixture skips highlighting. A full-file view under the cap highlights both sides, which the cap's probe estimates at about 85 ms per side at 5,000 lines on a quiet machine. Measure that through the app before optimizing. E07's pilots found and fixed a mixed-mode display defect. Preserve existing reuse. Medium correctness/render risk. |
| Closed | Large-list rendering investigation, E06 | Retain the full DOM. V1 improves first selection but blanks the viewport under controlled suspension; V2 adds scrolling CPU and footprint cost; V3 reduces plane height without removing that cost. Reopen only for a new causal hypothesis or representative workload. V2/V3 selection gains remain unmeasured. |
| 5 | Expand mutation/convergence scale and background contention | Small-fixture mutations are mostly single-digit to tens of milliseconds. Larger indexes, saves and local fetch can change that ranking. High Git correctness risk; use disposable repositories and exact content oracles. |
| 6 | Deep history, review/conflict/operation flows | Mapped but not performance-benchmarked here. History depth, conflict count and review size differ from file-count scale; do not extrapolate E01. |

The evidence supports retaining current warm diff reuse, mounted-tab reuse,
coalesced refresh, and the search debounce. It does not support another cache or
blanket debounce. Reopen rejected experiments only with a new bottleneck hypothesis.

## Review and regression evidence

Independent Codex reviewers covered Spec, Architecture, Security, Testing, Style
and Refactoring. Their findings exposed competing file-selection, comparison and
paged-search races, a single-match toggle, incomplete benchmark oracles, omitted
rounds, cleanup and provenance gaps. Held-response tests reproduced the races
before fixes. Comparison now publishes in the initiating synchronous transition;
file handoffs cancel pending commit metadata; context-menu comparison uses its
displayed anchor. A common scroll owner replaces repeated ad-hoc scroll guards.

Ref and review-header navigation also reject obsolete lookup and paging
continuations. A separate navigation-intent counter is necessary because a new
comparison can retain its anchor without starting another metadata read. Held-ref
tests reproduced replacement of a newer comparison, comparison-file selection,
swap and close. The guard now invalidates navigation while allowing useful pending
anchor metadata to finish. Repeated ref navigation is idempotent. The added tests
failed before the fix and pass afterward; the RepoView suites pass 152 tests.

The E01–E04 delivery gate, `mise exec -- just check`, passed 1,952 Rust tests (one skipped),
4,474 frontend tests, 197 application tests and 53 visual tests, plus static,
parity and contrast checks. Local logs and all review findings/dispositions are in
[REVIEW.md](../.boris/interaction-performance-20261115/REVIEW.md) and
`check-delivery-v3.log`. These local artifacts are gitignored; the maintained behavior,
measurements, limitations and reproduction routes are in this document and the
committed sample record. No benchmark threshold was added to CI from four samples.

E05 received separate native-code, harness and evidence reviews. Findings changed
startup-window ordering, native store/fallback coverage, the resize oracle, input
admission tests, display labeling and interrupted-run cleanup. The evidence review
also required painting checks in the faster rendering condition; the requested-120-Hz
checks and the earlier requested-60-Hz checks remain distinct. Its follow-up found
no remaining evidence findings within its examined claims. A subsequent process-inventory
audit found the competing-test overlap described above and reopened confirmation.
An independent review of the replacement cohort verified the exported calculations,
artifact hashes, workload records and exclusions. Its only finding was a stale
continuation sentence, corrected to point to the replacement painting trial. It
did not independently decode or classify pixels; that classification remains the
saved analyzer's observation. The raw review and disposition are local at
[quiet-evidence-review.md](../.boris/scroll-smoothness-20261116/quiet-evidence-review.md).
Raw review dispositions are local at
[native-review-dispositions.md](../.boris/scroll-smoothness-20261116/native-review-dispositions.md).

Five native unit tests cover startup configuration/order and absent-selector
fallback. Two viewport-resize tests preserve the renderer's row-window behavior;
removing resize observation makes them fail. The native geometry, store and
painting probes exercise behavior beyond those unit-test boundaries. The Python
harness suite passes 141 tests, including rejected input/capture traces, resource
identity, interruption cleanup, display-option propagation and competing-process
admission. A live admission probe rejected the observed foreign Rust test processes
before entering its measurement body. Entry/exit guards preserve executable
inventories and normalized workload reasons, without saving process arguments.
They cannot establish absence of work between those snapshots or recognize every
possible benchmark/OCR process; external coordination still applies.
Independent review exposed interpreter-option parsing, unavailable-argument
markers, secondary evidence-write failures and three tests that did not protect
the production integration. The fixes have direct regressions; removing either
capture guard or the frozen-module binding makes the new caller tests fail.
Reanalysis also rejects failed or missing required admission evidence, while
marking legacy absence as unobserved. These controls prevent reuse of the
excluded cohort as clean confirmation; they do not make that cohort valid.

An initial E05 full gate passed 1,957 Rust tests (one skipped), 4,526 frontend,
197 application and 53 visual tests, plus static, parity and contrast checks.
A later gate timed out in three Git-heavy Rust tests; a serial retry reproduced
the fixture-isolation timeout. Process samples showed file/object writes progressing,
and small create/delete probes were slow in both the system temporary directory
and checkout. Another checkout was running tests, but its causal contribution is
unconfirmed. After that check ended, the same 20-operation file probes fell from
17.277 to 0.082 ms median in system temp and from 15.665 to 0.068 ms in the
checkout. This temporal association supports contention, without isolating its
source. After the competing checks ended, the final full gate passed all 1,957
Rust tests (one skipped), 4,526 frontend, 197 application and 53 visual tests,
plus static, parity and contrast checks. It used
`mise exec -- env CARGO_BUILD_JOBS=2 NEXTEST_TEST_THREADS=2 just check`; only
concurrency was bounded, with the assertions and timeouts unchanged. The local
`check-final-bounded.log` records that pass; `check-final.log`,
`check-final-v2.log` and `gate-targeted-timeouts.log` retain the earlier outcomes.
These checks ran separately from the native measurement windows.

## Reproduction

All commands run from the repository root. Keep native runs serial and separate
from builds, tests, OCR and other benchmarks. The shared lock prevents these runners
from overlapping each other; process inventory still matters on a shared laptop.

```sh
mise exec -- python3 scripts/interaction-performance/prepare.py .boris/interaction-source
CARGO_TARGET_DIR="$PWD/src-tauri/target" mise exec -- just --justfile .boris/interaction-source/justfile drive-build
cp src-tauri/target/debug/trunk-drive .boris/interaction-candidate
clang -dynamiclib -fobjc-arc -framework AppKit -framework WebKit -framework CoreGraphics scripts/diff-scroll/native-probe.m -o .boris/interaction-probe.dylib
mise exec -- python3 scripts/interaction-performance/run.py --binary .boris/interaction-candidate --native-probe .boris/interaction-probe.dylib --output .boris/interaction-trial --files 1000 --rounds 4 --no-graph-stats
mise exec -- python3 scripts/interaction-performance/matrix.py --binary .boris/interaction-candidate --native-probe .boris/interaction-probe.dylib --output .boris/interaction-matrix --rounds 4
```

`prepare.py` copies source into a plain directory, adds a local-only instrumentation
sink to its drive entrypoint, records hashes and links existing node_modules. It
creates no branch/worktree and modifies no live source. Build a control from that
same copy with only the proposed production patch reversed, freeze its binary, then
alternate control/candidate launches. Use fresh output paths: scripts reject
existing output directories. `--graph-stats` or `--no-graph-stats` is mandatory.

`summarize.py <evidence-root> --prefix <name>` reads directories named
`<name>-<10|100|1000>-<pair>-<before|after>/<round>`, including all numbered rounds. Raw samples carry authoritative
endpoint definitions. The runner verifies process identity and Mach-timebase CPU
conversion, preserves partial failure evidence, and terminates only its own app.
The fixture helper writes deterministic disposable objects/index bytes and does not
change Git identity. Mutation commits use the user's existing Git identity.

For an optimized comparison, build the frozen source with `VITE_TRUNK_DRIVE=1`
as above, then from that copied directory run:

```sh
TAURI_CONFIG="$(cat tauri.drive.conf.json)" mise exec -- cargo build --release --jobs 2 --manifest-path src-tauri/Cargo.toml --target-dir /absolute/path/to/trunk/src-tauri/target/drive-build --bin trunk --features drive,tauri/custom-protocol
```

Freeze `target/drive-build/release/trunk` separately for each variant. The two-job
limit bounds build load. Run no build concurrently with a measured trial. This
optimized drive binary still differs from the user's normal app in drive transport,
instrumentation, and disabled occlusion throttling.

Optional `capture.py` takes `--binary`, `--native-probe`, `--recorder`, `--output`,
`--label`, `--files` and explicit graph-stat mode. Build the recorder from
`scripts/diff-scroll/native-capture.swift` following the existing diff-scroll
README. Capture is separate from resource trials. Its strict validation and manual
frame classification must both pass before presentation claims are made.
