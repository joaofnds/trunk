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
  pending rerun. A notification starts a read at once when the last one finished at
  least the delay ago, and otherwise at the delay after it finished; later
  notifications do not postpone it. Explicit `run()` requests bypass that delay.
- [Command-completed notifications](../src/lib/repo-change-subscription.ts) request
  immediate refresh. RepoView filters file-specific reads by affected paths and
  defers refs-only graph publications until tab activation.
- RepoView uses generation, repository, OID, and path checks to reject obsolete
  commit, file, compare, and current-source responses. Commit-file reuse matches
  repository, OID, context lines, whitespace, and full-file options.
- CommitGraph rejects stale pages, limits non-progressing paging attempts, and
  reads statistics for visible commits in batches of at most 32. Hidden statistics
  columns avoid that read path. Stored ref visibility and the view's repo-changed
  listener gate the first page, and an unchecked first graph requests one refresh.
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

E06 retained the full list on its 1,000-file workload. All three prototypes were
rejected. The measured priority table below records the later 5,000-file case
and the implementation it supported. The decision weighs the measured benefit against painting, response and
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
under the measured build's single parse window both content modes span past the
5,000-line cap. A window longer than that skips highlighting entirely
(`MAX_SYNTAX_PARSE_LINES` in `src-tauri/src/commands/diff.rs`). Since E08's
per-cluster windows, the same hunk-mode diff parses about 500 lines and is
highlighted. This is a payload size baseline, and it cannot
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
lines highlights every new-side line, and under the measured build parsed the old
side from line 1 to its last deleted line. The cap's source comment records
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

### E08: highlighted large-file opening, one parse window per cluster

Flows I06 and I11. A highlighted TypeScript read cost about 223 ms in the diff
command, against 2 to 6 ms for the same file shape as plain text. Almost all of it parsed lines nobody
displays. The highlighter parsed one window per side, from 250 lines above the first
needed line down to the last one. With edits at line 1 and line 4,300 of a
4,800-line file, hunk mode parsed about 8,600 lines across both sides to display 13.
Each side now parses one window per cluster of needed lines, and
[the highlighting cost model](architecture/diff-highlighting.md) describes the rule.
A native A/B of the fixed build cut the highlighted read to 18 to 31 ms in hunk mode
and 138 to 163 ms in full mode, against 216 to 252 ms for a control build.

The fixture is E07's with 4,800 lines and 136,528 bytes per path, and edits at line
1 and line 4,300. Both content modes fit under the 5,000-line cap, so
`recognized.ts` is highlighted and `unsupported.txt`, which has no grammar, is the
control. The summarizer requires syntax spans on every `recognized.ts` row sample
and none on `unsupported.txt`, and the pilot passed that check. The binary, actions,
endpoints and conditions are E07's, so the build predates `4586dd1c` and the window
change. One launch in pilot 1's order is a pilot, not a cohort. The hypothesis, set
before launch, was that a highlighted read costs several times the plain-text read in
both modes, and that hunk mode costs about as much as full mode because the single
window ran from the first needed line to the last. It would have been refuted by
reads within a few milliseconds of each other.

| Action | Endpoint, ms | `invoke:diff_commit_file`, ms | Host CPU, ms |
| --- | --- | --- | --- |
| `recognized.ts`, first open in hunk mode | 244 | 223 | 240.4 |
| `unsupported.txt`, first open | 24 | 2 | 3.8 |
| `recognized.ts` again, retained payload | 13 | none | 1.8 |
| Mode switch, `recognized.ts` reloads in full | 244 | 224 | 227.7 |
| `unsupported.txt` in full | 26 | 6 | 5.2 |
| `recognized.ts` again in full, retained payload | 14 | none | 1.9 |

Host CPU tracks the read, and `diff.buildRows` took 2 ms or less. Hunk mode cost as
much as full mode, which is what the single window predicts: hunk mode parsed 4,300
old and 4,303 new lines, and full mode 4,300 old and 4,800 new. Under the new rule,
the line counts derived from the same needed sets are 252 old and 261 new in hunk
mode, and 252 old and 4,800 new in full mode. Highlighting runs parsing, theme
matching and token building on every parsed line, so its cost scales with lines
parsed. Scaling the measured reads by those counts predicts 13 to 15 ms in hunk mode
and 124 to 127 ms in full mode, the lower figure scaling the whole read and the
higher one only the part above the plain-text read. The A/B below measured both.
Action 4 read as long as action 1 after the syntax set had loaded for
action 1, so its first load is not a material part of the 223 ms. Full-file view of a highlighted file
near the cap stays the largest open cost, because it needs every new-side line.
Action 5 first built rows for the retained payload of the other mode, the E07
defect, so its endpoint includes that build.

Pilot 2 was refused at entry admission because another session's `just` and `cargo`
processes were running. No app launched, and it was not retried. The
[committed E08 record](performance-data/highlighted-open-2026-11-16.json) holds each
action's endpoints, reads and CPU, the fixture identities, the executable and harness
hashes and the derived line counts. Raw results and the harness stay in the
gitignored `.boris/highlighted-open-20261116/`.

The A/B used two binaries built in one tree with the same features, configuration,
profile and frontend. The control kept the original `diff.rs`, and the fixed build took
`3b1ad8d4`'s, so they differ in the parse windows alone. The control is a rebuild, not
the baseline binary above. Each harness is the baseline's with its executable swapped.
The launches ran serially, with process admission passing at entry and exit of each, in
the order control 1, fixed 1, fixed 2, control 2, so each build ran both action orders
once. The hypothesis, set before launch, was the prediction above. It would have been
refuted by a hunk read above 50 ms or a full read not below 180 ms.

| Build, pilot | Hunk read, ms | Hunk endpoint, ms | Full read, ms | Full endpoint, ms |
| --- | --- | --- | --- | --- |
| Control 1, hunk first | 233 | 253 | 252 | 274 |
| Fixed 1, hunk first | 31 | 58 | 138 | 159 |
| Fixed 2, full first | 18 | 41 | 163 | 182 |
| Control 2, full first | 216 | 234 | 243 | 265 |

The reads are `invoke:diff_commit_file` for `recognized.ts`. Host CPU tracked them
within 17 ms in every action. The hypothesis was not refuted. The ranges of the two
builds are far apart in both modes, and `unsupported.txt` read in 1 to 11 ms in every
pilot. Both modes came in above the point predictions, and in each fixed pilot the
mode opened first came in further above its prediction than the mode opened second.
That pattern fits a one-time cost on the first highlighted read in the process. It
is an inference from two pilots and has not been isolated. Four pilots are a
paired A/B, not a cohort, so the record carries no inferential verdict. A highlighted
full-file open of a file near the cap still costs about 140 to 160 ms, because it
parses every new-side line. The record's `confirmation` section holds each pilot, and the raw
results stay in the gitignored `.boris/highlighted-open-control-20261116/` and
`.boris/highlighted-open-after-20261116/`.

### E09: bulk conflict resolution and folder discard, one index write per action

Flow I15. Mark All Resolved and a conflicted folder's Resolve All staged one file per
command, and each command opened the repository, read the whole index and wrote it
back. On a large index the per-file cost multiplies by the number of conflicts. Both
actions now send one `stage_files` command, which reads the index once, stages every
path and writes once. A failure writes nothing, where the loop could leave some files
staged. The hypothesis was that the cost falls from one full index read and write per
path to one in total, so the batch would take a small fraction of the serial time at
200 paths. A batch within a factor of two of the serial loop would have refuted it.

The fixture is a disposable repository with 20,200 tracked files: 200 directories of
100 small files each, plus 200 files under `conflict/` changed on two branches so that
a merge leaves all 200 conflicted. While conflicted the index holds 20,600 entries and
1.65 MB. The saved conflicted index was copied back before every iteration. A
temporary criterion group in the bench target timed the backend functions directly,
built from bb285041 with only that group added, release profile, 10 samples per case,
on the M5 Pro. Each size ran serial then batch, not alternated, and load during the run
was not recorded. No fixture hash was kept.

| Paths | Serial `stage_file_inner` | One `stage_files_inner` |
|---|---|---|
| 20 | 167 to 174 ms, estimate 170 ms | 10 to 14 ms, estimate 12 ms |
| 200 | 1.72 to 3.58 s, estimate 2.63 s | 44 to 55 ms, estimate 50 ms |

The ranges are criterion's confidence intervals for the mean, not minimum to maximum.
The serial 200-path interval is wide, so its estimate is loose, and the batch interval
sits far below it either way. The measurement leaves out IPC, the status refresh after
the write and the watcher refreshes the old loop's 200 index writes could trigger, so
the user-visible gain is unmeasured. Index and status results are pinned by
`stage_files_resolves_every_conflicted_path_it_names` in `src-tauri/tests/test_staging.rs`.
The probe was not committed; the recipe above rebuilds the fixture.

A folder's Discard All had the same shape and a correctness defect on top of it. It
sent one `discard_file` per file in parallel, and each one wrote the index through its
checkout, so the calls raced for `index.lock`. A probe of 40 concurrent single-file
discards behind a barrier on a scratch repository failed 35, 34 and 34 of them in three
runs, every failure `git_locked`, and in each run left no file edited, because the
checkout writes the working tree before the index. The user saw "Discard failed" for a
discard that had happened, and the panel skipped its refresh. The action now sends one
`discard_files` command. It checks that every path has a working-tree change before
writing anything, restores the tracked paths in one checkout from the index and then
deletes the untracked ones. A deletion that fails after the checkout still leaves the
tracked paths discarded, as the per-file calls did, and the panel refreshes after a
failure as well as a success, so the list shows what is left.

The same fixture after `git merge --abort`, with the 200 `conflict/` files rewritten so
each has an unstaged change and the saved index restored before every iteration, gave:

| Paths | Serial `discard_file_inner` | One `discard_files_inner` |
|---|---|---|
| 20 | 168 to 175 ms, estimate 170 ms | 10.7 to 11.1 ms, estimate 10.8 ms |
| 200 | 1.75 to 1.98 s, estimate 1.85 s | 31 to 36 ms, estimate 33 ms |

This run was built from the change in `82168acd` with the temporary group added, so the
serial arm called the single-path function after it began delegating to the batch with
one path. It performs the same status read and checkout as before. Load average from
other work on the machine was 5.57 at the start and 4.09 at the end. The serial loop is
the sequential cost. The shipped code ran the calls in parallel, which is how they
collided, so its wall-clock time was not measured. Behavior is pinned by the
`discard_files_*` tests in `src-tauri/tests/test_staging.rs` and the folder discard
tests in `src/components/StagingPanel.test.ts`.

Overlapping writes used to collide. Two overlapping `stage_files` calls with the same 40
paths returned one `git_locked` in each of five probe runs, while all 40 files ended
staged, and the screening on TRUNK-442 saw that collision only with two clicks under
40 ms apart. A larger repository widens the window enough to lose work. In a drive build
on a repository with 20,000 new files, an Unstage clicked 300 ms into a 3.6 s Stage All
was written, then Stage All saved the index it had read and the file was staged again,
with nothing shown to the user. libgit2 takes `index.lock` only for the moment it writes,
so two commands that both read before either writes each save their own copy. The git
binary actions had the same gap, and a file staged while a commit's pre-commit hook ran
went into that commit, because plain `git commit` holds no lock while the hook runs and
reads the index again after it.

Every command that writes the index, the working tree or the stash list now runs under
`trunk_git::write_gate`, which holds a per-repository gate from the command's first read
to its last write: the libgit2 writers through `hold`, which reads the index afresh once
held, the git binary actions through `hold_for_git`, and pull through a `Turn` it holds
across its awaits from its safety copy to settling it (`ed5a0354`, `3ebe401e` and
`65e43445`). A second action waits for the first and then starts from what it saved, and a
file staged during a commit's hook stays staged for the next commit. The cost is the
wait: a Stage clicked during a pull waits for the pull's fetch, and one clicked during a
long pre-commit hook waits for the hook. The `when_another_writer_*` modules in the
staging, stash, branch, commit, commit-action, merge, rebase and remote suites run each
command while another writer holds the gate, and each test fails with its command's
gating removed. Taking turns has one more consequence: an Undo or an Amend queued behind
a pull would run on the HEAD the pull left and take back or replace a commit the user
never saw. Each now names the commit it was aimed at and refuses, changing nothing, once
HEAD is another commit (`c2742dbc`), as Redo already did. Each linked worktree has a gate
of its own, since each has its own index and working tree. Another process meets only
git's own lock.

### E10: core flow walk, whether each result is the one the user meant

Flows I01 to I18, walked on 2026-11-17 to find where the app did something other than
what the user asked. This is a defect walk, not a benchmark, so it has no hypothesis
and no artifact identity of the kind the measurement record asks for. It sits here
because it walked this document's interaction map, and the open defects it found live
on board cards rather than in `known-issues/`. Three walkers
drove the drive build (`just drive-build`: a production `vite build` frontend over a
debug Rust binary with the drive feature) through the drive route in
[build-environment.md](build-environment.md), at the default 1280x800 window, on `/tmp`
copies of the fixture corpus (`just fixtures`). The binary was built before the walk
began, from trunk at about `de8b0b48`, and rebuilt during the session as fixes landed.
No record shows which build each walker drove, and no binary hash was kept. The
walkers' reports were deleted at cleanup. What remains is the working ledger,
`.boris/flow-walk-20261117/LEDGER.md`, and the review of the fixes,
`.boris/reviews/flow-walk-20261117/REVIEW.md`, both local to the machine that ran it.

To see a defect again, export the source before its fix (`git archive <fix>^` into a
plain directory), link the checkout's `node_modules` into it as `prepare.py` in the
Reproduction section does, and run that copy's `drive-build` with `CARGO_TARGET_DIR`
pointing inside the copy, since the recipe replaces `debug/trunk-drive` under whatever
target it is given. Copy a fixture repository out of `repos/`, keeping only remotes that point
inside the copy, launch the copy with `drive launch`, and drive the flow's gesture
from the interaction map, reading the result from the DOM and from git in the copy.
The drive route cannot send a shortcut the native menu owns, so such a gesture goes
through `menu-bar`.

The walkers were asked to time each interaction page-side, from the delivered drive
event to when the expected DOM appeared. The ledger keeps only their summary: every
interaction under about 370 ms except two. Commit settlement took 650 to 1,400 ms,
against a predicate nobody recorded, so it is not comparable with E03's Commit,
usable at a 168.5 ms median with hooks and signing disabled. The refresh after an
edit made outside the app took about 530 ms, of which about 500 ms is deliberate: the
watcher's 300 ms debounce (`src-tauri/src/watcher.rs`) and the 200 ms
`REPO_CHANGE_DELAY_MS` the refresh coalesces over (`src/lib/coalesced-task.ts`).
The walkers did not separate first feedback from the usable result, so these numbers
support no speed claim. E01, E03, E07 and E08 hold the timed evidence. A later trace
split the commit reading. In one launch of the drive build on a five-commit scratch
repository, with hooks and signing off, the page timed each Commit click to the new
row in the graph and the cleared summary, and logged every command through the page's
IPC transport. The first commit was usable at 163 ms and the next five at 29 to
37 ms, with `create_commit` ending at 21 to 30 ms and the refresh it starts ending
within 10 ms after. The last command ended at 527 to 535 ms every time: the watcher's
refresh, which starts after the 500 ms of deliberate delay above and repeats reads the
commit's own refresh already made. The walk's 650 to 1,400 ms most likely ran to the
end of that refresh and added the drive client's own overhead, which is inference,
since the walk recorded no predicate. The commit the user sees is fast. A Commit
click inside that delay after a `git add` made outside the app ran no `create_commit`,
because the panel had not yet seen the new index, and by the form's code it shows "No
files staged" until it does. No
action follows: a person types a summary for longer than the delay.

The same page-side timer, one drive-build launch per fixture copy, then covered the
flows the walk left untimed. Each reading runs from the delivered event to a predicate
on the page, checked every frame:

| Flow | Fixture copy and predicate | Usable, ms |
| --- | --- | --- |
| I16 checkout from the branch menu, n=4 | deep-history (843 commits): header and sidebar name the new branch | 78 to 97, of which `checkout_branch` 69 to 85 |
| I10 compare from the commit menu, n=6 | deep-history, tip against commits 796 to 810: pair and changed files shown | 9 to 15 |
| I10 swap direction, n=1 | same: pair shown reversed | 12 |
| I10 open a file in a compare, n=4 | same: path and its added line shown | 6 to 14 |
| I11 open a 3,000-line file with 20 hunks, n=3 | diff-scenarios plus that file: path and first hunk shown | 10 to 14 |
| I11 `]` and `[` hunk steps, n=9 | same: scroll moves, then holds for three frames | moves 2 to 9, settles 27 to 37 |
| I11 full file, hunks, split and inline, n=3 each | same: toolbar title flipped and the pane's markup present | 13 to 36 |
| I15 open the merge editor, n=1 | merge-conflict, 3 conflicts: navigation and Take All shown | 21 |
| I15 take a side, n=3 | same: that side reports pressed | 2 to 3 |
| I15 Save and Mark Resolved, n=1 | same: file listed resolved and none conflicted | 12, index stage 0 checked in git |
| I16 merge from the graph menu, n=1 | a five-commit scratch repository, main and a feature branch: merge message dialog shown | 171, of which `merge_branch_begin` 166 |
| I16 save that merge message, n=1 | same: graph shows the merge commit | 37 |
| I16 cherry-pick from the commit menu, n=1 | same, a third branch's commit onto main: graph shows the new commit | 20 |
| I16 revert from the commit menu, n=1 | same: revert message dialog shown, then after Save the graph shows the revert | 24, then 37 |
| I16 stash a staged change, n=1 | same: stash row in the graph and a clean worktree | 14 |
| I16 stash with only unstaged changes, n=1 | same: the refusal message shown | 11 |
| I16 pop from the toolbar, n=1 | same: stash row gone and the change listed unstaged | 18 |
| I16 rebase main onto the feature branch, n=1 | same: graph shows main rebuilt on the feature tip | 39 |
| I16 soft reset from the commit menu, n=1 | same: header names the target commit and its changes listed staged | 33 after the confirm dialog closed, HEAD and index checked in git |

The deep-history rows were read on a build that stored its objects loose. Since
2b178196 (2026-11-19) that fixture stores its history as one pack, so a re-run
compared against them also compares two storage forms.

After every mutation here the last command ended 527 to 855 ms after the event,
which is the watcher refresh described above. Compare and diff options start no
refresh. These are one-launch readings on small fixtures in a debug Rust build, so
they show that nothing in these flows waits on the user, not how they scale. The I16
history operations wait on no refresh either: the page is usable within 40 ms of the
git command's end, except the merge begin, whose 166 ms is the command preparing the
merge. I18 refresh has only the walk's reading above. The merge editor run
also showed that taking the incoming side of a conflict whose current side is already
taken keeps both, which is recorded on TRUNK-451.

Not every row is a walker's observation. A walker saw dead `[` presses at the last
hunk; the stale cursor, the whole-file stepping and the comment jump in that row came
up while fixing them. The ArrowDown row came up while the Ctrl+Tab fix was being
checked, and the partly taken side in the I15 row came from the review. An
independent review of the fixes through `0d5fc406` found several incomplete or
regressing something else, and the later commits in the Fix column repair them, so
take every commit in a row, not the first alone. Those later commits had no
independent review. Two more review fixes sit beside the rows: `649344ed` stops
the whole-file view's `c` key commenting on lines in a hidden tab or under the rebase
editor, and `1757135a` holds the landing flash still where reduced motion is
preferred. Every fix adds a test except three. The checkout advice changes only its
wording. The footer overflow and the reduced-motion hold are layout and CSS that no
current suite captures: the headless DOM does not lay out or apply media queries, and
the visual suite, which runs real WebKit, captures only the commit graph and the
design catalog. Some of the first tests passed with their subject broken, and
`66ca1336` left Continue's disabled state untested. `03565fab` and `56932a3d` rewrote
or added those tests. Each was seen to fail with its subject broken, except the
rebase cancel test, which was checked by reading. After the last fix, a session that wrote none of them drove a drive build of
`2ba1be06` through every row and the `c` key fix, and saw each behave as fixed. It
did not observe the reduced-motion hold, and it could not reach a drag that reopens a
collapsed pane, because a collapsed pane's splitter is hidden. The same session met
defects the walk had not. A cherry-pick of a change HEAD already has was left in
progress with a Continue that saved nothing, fixed in `53911414`, and the cherry-pick
banner's label was cut off at 1280 px, fixed in `ec642575`. A drive build of
`ec642575` showed both fixed: the pick ended with a dialog saying HEAD already had
the change, and the label fit beside Continue and Abort at 1280 px. Three wait on a product
question: ending a review reopens the last diff shown in it at its top (TRUNK-453), a
click on the file the staging panel has just moved to closes its diff (TRUNK-454),
and the uncommitted-changes row never shows as selected (TRUNK-455).

| Flow | What the user met | Fix |
| --- | --- | --- |
| I13 | Stage Lines joined a staged added line onto the line before it when that line was the file's unterminated last line, and Stage, Unstage and Discard Lines failed in any hunk whose old and new start lines differ | `73b40293`, `6be485a1` |
| I13 | A double click on Stage Hunk staged that hunk and the next one, because the next hunk's button moved under the pointer | `11f8404a` |
| I13 | The missing-newline marker offered a line grip that selected nothing, and a single discarded line was counted as "1 selected lines" | `00701031` |
| I11 | Switching full file, split or inline jumped to the top or to the first hunk | `5555b7ec`, `56932a3d` |
| I11 | `[` pressed past the last hunk did nothing, `]` and `[` stepped from a stale hunk instead of from where the reader was, they did nothing with the whole file shown, and a comment jump in the inline whole-file view did not scroll | `a410d09a`, `e906dbfd` |
| I02, I06 | Closing a diff returned the graph to its top and dropped the pages the user had scrolled through | `a705615a` |
| I06 | A binary file opened from a commit or the staged list showed "No changes to show" | `f7a808cf` |
| I01 | The graph opened scrolled past the uncommitted-changes row | `9dcf3447` |
| I01 | After switching tabs with Ctrl+Tab, the arrow keys did nothing | `1e9933b0` |
| I04 | In a dirty repository, ArrowDown from the uncommitted-changes row selected it again, so the arrow keys could not leave it | `556e87ad` |
| I03 | A collapsed sidebar kept focus, so typing landed in its hidden filter, and a pane collapsed by dragging reopened at the narrow width it was dragged to (64 and 70 px in the walk) | `a95bffb1`, `0ac9d12a` |
| I07 | The staged and unstaged lists each showed a highlighted row with no diff open | `866dc0ee` |
| I08 | A file opened from the finder showed a Modified badge though it was unchanged, numbered each line twice when shown whole, and ranked `f142` above `f42` for the query `42` | `ab6a9f9d`, `ccf67006`, `23436cc2` |
| I12 | Stage All and Unstage All showed no busy state while they ran | `8ba04756` |
| I02 | Cancelling the interactive rebase editor cleared the commit selection | `85490107`, `9d601915` |
| I16 | A merge from the graph's context menu wrote "Merge branch 'refs/heads/feature'" | `b73121be`, `daba151d` |
| I16 | A cherry-pick or revert that stopped on conflicts arrived as an error alert with git's command-line hints, and Continue was enabled with unmerged files | `66ca1336`, `c5be508b`, `d8d18101` |
| I16 | "Fast-forward main to here" was offered on commits that do not descend from HEAD, and failed with git's raw error | `cc637feb` |
| I16 | The stopped-rebase footer overflowed the staging panel at 1280 px, so Abort Rebase was cut off and overlapped Skip, and Abort Merge ran into the panel's padding | `f80c04f4` |
| I16 | At the detail pane's 200 px floor the stopped-rebase footer still cut off Abort Rebase, 20 px past the window's edge, and the stopped-merge footer put Abort Merge 49 px past it. The rebase's abort button now reads Abort, and the merge footer's two buttons stack when they do not fit one row | `d566ce52`, `cdaa6195` |
| I16 | The reset dialogs named neither the branch nor the commit | `4c7d711f`, `d8d18101` |
| I16 | A checkout refused over local changes advised stashing them, which Stash refuses while the changes are unstaged | `2e60aa0a` |
| I15 | The merge editor's conflict headers had the same accessible name in both panes and did not say which side was taken, or that a side was partly taken | `0d5fc406`, `1cb79633` |
| I15 | The merge editor and a conflicted file's Take All Current and Take All Incoming showed and saved a second merge run in TypeScript, which merged hunks git left in conflict, raised conflicts git had merged, and saved the current side of a file git does not merge. A conflict between symbolic links was read and saved through the link | `e75a157c`, `ef15db6c` |

Three defects stay open, each on a board card awaiting admission with the product
question its fix depends on. Mark All Resolved and a folder's Resolve All stage a file
that still holds conflict markers without a warning, and whether to warn, refuse, or
list the files is open (TRUNK-449). Applying or popping a stash is refused while
anything is staged, where git applies it, and whether to apply through the git binary
or over a dirty index is open (TRUNK-450). In a rebase conflict the merge editor's
output starts as the onto side, so saving at once drops the user's own change, and
where the output should start is open (TRUNK-451). Three more went to cards that
already held their area. Skip in a stopped rebase asks for no confirmation where Abort
does, and the merge editor does not move on to the next conflicted file after a save
(both TRUNK-445). Overlapping index writes collided on `index.lock`
(TRUNK-442). The screening on that card saw it only with clicks under 40 ms apart, but on
a repository of 20,000 new files the window lasts seconds and a write was lost, and the
write gate in E09 now makes overlapping actions take turns. Cmd+F does nothing while a diff covers the
graph: the native menu's Find reaches only the graph's search, which ignores it while
covered. The walker pressed it through the drive route, which never reaches the
menu, so the report came from the wrong route, and the code confirms it. TRUNK-29
holds the find over a diff.

One finding waited on a product decision, on TRUNK-452. At the default window on a
repository with wide branch labels, the SHA column shrank to its 28 px floor and showed
one or two characters. The product owner first kept the clip, and the card was archived
as designed. On 2026-11-25 they asked for the column to hold its whole header word, so
SHA's floor is now its seven characters, and
[the column-width decision](decisions/2026-09-21-column-widths-are-measured-not-declared.md)
records the new yield order.

The walk reported behaviors that were ruled by design. Four rest on a source. A stash
pops its staged changes into the working tree, as TRUNK-231 designs it. "Interactive
Rebase X..." on a branch replays onto the fork point, as phase 41's locked decisions
set it ("For branch menus, auto-detect fork point as base commit", `git show
5fd4683:.planning/milestones/v0.8-phases/41-interactive-rebase-editor/41-CONTEXT.md`). The file finder opens only from a review, because it is the picker for a
review's Comment on a file action, as the glossary's Current-file view says. Undo
commit leaves the message box empty, which a GitKraken feature request asking for the
message back (feedback.gitkraken.com/suggestions/203053) implies GitKraken did when
it was filed. Five rest on the walk's reading of the code and no product decision, so a later walk may raise them again. Jump to commit
from a review that is not active leaves review mode for the graph, which shows the
active review's comments. Leaving review shows the view under it, as a staging diff
does. The review state chips are labelled toggles that hide their state, with presets
beside them that filter to one. A disabled Commit merge sits under the Conflicted
Files section, which gives the reason and the count. The full-file and layout toggles
carry no pressed state because each names the action it takes, the pattern the
Markdown toggle beside them broke until `2ba1be06`. A report that an interactive
rebase over merges shows no message did not reproduce: the toast names the merge
commits it cannot replay.

Walker C's findings are numbered with gaps (C10, C16, C17 and C19 are missing), and
the walkers' reports are gone, so a flow with no row here is not shown clean. The
walk did not cover the flows under load, large conflict sets, signing or hooks, or
remote operations against a real network.

### E11: graph rebuild after a commit, remembering what earlier captures read

Flows I12 to I14 and I18. Every command opens a fresh repository handle, so each graph
rebuild after a commit, checkout, stash or ref change walked and parsed the whole
history again, and on a deep history that rebuild sits between the user's action and
the graph showing its result. Capture now keeps each commit's parents, committer time
and facts from the last walk, in a memo the open repository owns, and reads only the
commits it lacks (`d6087c97`, ownership and graft fixes in `9e6ec1b9`). The hypothesis
was that a rebuild after one new commit would cost a small fraction of a full walk. A
rebuild within a factor of two of the old one would have refuted it.

The fixture is a generated repository with 30,000 commits on three branches, about 4%
merges and about 30% of commits in the same second as the one before, in one pack with
no commit-graph file. Each build ran three times, alternating with the other, on a fresh
copy: one first capture, then 21 rounds of committing once on `main` and timing one
capture through a fresh handle. The probe called the backend capture directly in a
release build on an Apple M5 Pro with 48 GB, so the numbers exclude the commit itself,
status, the watcher refresh and the frontend.

| Build | First capture (ms) | Rebuild after a commit, median per run (ms) | Range over all 63 rebuilds (ms) |
|---|---|---|---|
| Before (`d6087c97^`) | 123.9 to 136.2 | 95.0, 95.3, 104.5 | 94.2 to 114.4 |
| After (`9e6ec1b9`) | 111.6 to 124.8 | 7.4, 7.4, 7.5 | 7.1 to 8.8 |

The ranges do not overlap, so the hypothesis stands: a rebuild after a commit costs
about 8% of the old one, and the first capture of a session is no slower. Opening the
capture's own object handle, which keeps parents correct when `shallow` or
`info/grafts` changes under an open handle, costs about 0.1 ms. Recapture equality for
checkout, amend, branch deletion, fetch, stash and stash pop is held by the unit tests
in `graph.rs` and was not timed here. The memo's memory cost was not measured.
The [committed E11 record](performance-data/graph-rebuild-2026-11-18.json) holds the
generator, both probes and every timing.

### E12: an edit made outside the app, shown at once

Flows I12, I13 and I18. A file saved in an editor or a command run in a terminal reached
the staging panel about half a second later, every time, even after a long quiet spell.
E10 traced the cause: the watcher's 300 ms trailing debounce, then the frontend's fixed
200 ms first deadline, stacked on every change. The watcher now reads `notify` events
itself, gathers them for 25 ms and delivers; a 300 ms interval starts only after a batch
that refreshed something, and a due batch waits, for up to a second, while Git holds the
worktree's `index.lock`. The frontend starts a read at once when its last read finished
at least 200 ms ago (`f87985e8`). The hypothesis was that a lone outside edit would show
in under 100 ms. A reading at or above that in any trial would have refuted it.

Each trial armed a `MutationObserver` in the page for a new file's name, wrote that file
into a scratch repository from Python, and took the page's clock when the name first
appeared, 1.5 s apart, twelve per build. Both builds were the debug drive build in one
launch each on an Apple M5 Pro with 48 GB, and the window was occluded, so the reading is
when the DOM changed, not when it painted.

| Build | Outside write to the row in the panel (ms) |
|---|---|
| Before (`f87985e8^`) | 508 to 525 in eleven trials; the first, 5,190, is unexplained |
| After (`f87985e8`) | 27 to 37 in all twelve, median 32.5 |

The hypothesis stands. A commit made in a terminal replaced the two committed files'
rows with the new commit in the graph, and left the uncommitted ones in the panel; that
one reading includes git and the drive client and is not a latency claim. Not measured:
the app's CPU while ignored build output churns, which can now cost one routing pass per
25 ms where the debounce cost one per quiet spell, and how long the `index.lock` wait
holds a refresh during a real terminal rebase. The
[committed E12 record](performance-data/outside-edit-2026-11-18.json) holds the probe and
every timing.

### E13: deep-history graph layout, only the worktree state the user sees

Flows I01, I12 to I14 and I18. Every graph capture laid out the whole history twice,
once for a clean and once for a dirty worktree, before the graph could show, although
only the observed state's plan is drawn. On a deep history that layout outweighed the
capture itself, and it sat between opening a repository, or committing, checking out or
changing a ref, and the graph showing the result. A snapshot now lays out only the
observed state before it is published, and the rebuild lays out the other state in the
background afterwards, so the first edit after a commit usually finds it ready
(`68c7e75d`, sweep rows in `9d8b049b`). The hypothesis was that the layout a capture
waits for would fall to at most 60% of the old one. A reading above that in any run
would have refuted it.

The fixture is E11's generator run for 300,000 commits, in one pack with no
commit-graph file. Each build ran three times, alternating with the other: one capture
and layout with an empty memo, then seven recaptures with the memo held, each followed
by the snapshot's layout and by asking for the other worktree state. The probe called
the backend directly in a release build on an Apple M5 Pro with 48 GB, so the numbers
exclude status, the watcher and the frontend, and the probe never starts the
background layout.

| Build | Capture, memo held (ms) | Layout a capture waits for (ms) | First use of the other worktree state (ms) |
|---|---|---|---|
| Before (`68c7e75d^`) | 96.2 to 103.6 | 377.7 to 408.4 | 0.0, laid out up front |
| After (`68c7e75d`) | 96.8 to 104.1 | 153.0 to 172.5 | 140.1 to 160.8 when the background layout has not run |

The ranges do not overlap, so the hypothesis stands: the wait fell to about 40% of the
old one, so a rebuild there costs about 260 ms instead of about 490, and the first
capture of a session about 1.26 s instead of about 1.5. That first capture, about
1.09 s, is unchanged and is now the open cost at this depth; `git rev-list
--topo-order --all` took 0.95 to 1.1 s on the same fixture, so the walk is near Git's
own floor without a commit-graph file. Not measured: whether the background layout
finishes before a real first edit, and real repositories of this depth. Lane
assignment's remaining cost is mostly hashing and allocation in its maps keyed by
commit id; a faster hasher alone measured 12 to 18% of a layout and was not taken. The
[committed E13 record](performance-data/deep-history-layout-2026-11-18.json) holds the
probe and every timing.

### E14: ignored build output, one index parse per change to it

Flow I18. E12 left the app's CPU unmeasured while ignored output churns. To drop a
batch's ignored paths, the watcher opened the repository and parsed the whole index for
every batch, and a batch arrives every 25 ms while a build writes. A release probe of
that path at 20,000 tracked files measured 3.7 ms a batch, 0.073 ms of it the open,
across 41 runs. The hypothesis was that keeping the parsed index would cut the app's CPU
under ignored churn by an order of magnitude. A reading under churn within a factor of
ten of the old one would have refuted it.

Each run launched the debug drive build on a generated repository of 20,000 tracked
files with an ignored `target/`, waited 5 s, read the process's CPU time from `ps`, left
it idle for 15 s, then rewrote one of 40 ignored files every 10 ms for 15 s from Python.
The builds alternated, two runs each, on an Apple M5 Pro.

| Build | Idle, 15 s (CPU s) | Ignored churn, 15 s (CPU s) |
|---|---|---|
| Before (`7928445c^`) | 0.02 to 0.03 | 5.87 to 5.92 in four runs |
| One kept handle (`7928445c`) | 0.02 to 0.03 | 0.27 and 0.29 |
| Kept index, fresh open per batch (`8ce8069a`) | 0.02 to 0.03 | 0.58 and 0.59 |

The hypothesis stands. The kept handle was the cheapest, but review found that libgit2
reads `core.excludesFile` and `core.ignoreCase` once per handle and keeps a deleted
index's entries, so its answers drifted from a fresh read. The delivered build opens
the repository for each batch and keeps only the parsed index, which costs the doubled
reading against the kept handle and gives the answers the code gave before. Not
measured: a release build, a real compiler's write pattern, and the memory the kept
index holds per watched repository. The
[committed E14 record](performance-data/ignored-churn-2026-11-19.json) holds the probe
and every reading.

### E15: deep-history first capture, what a commit-graph file would change

Flow I01. E13 left the first capture of a session, about 1.1 s at 300,000 commits, as
the open cost at that depth, measured without a commit-graph file. Git keeps one in
most repositories it maintains, and with it `git rev-list --topo-order --all` on E13's
fixture fell from 0.79 to 0.80 s to 0.26 to 0.28 s. The hypothesis was that libgit2's
walk, which the capture's order reproduces, would gain as much from it. A walk within
10% of the no-file walk would refute it.

A release probe linking `trunk-git` timed one walk or capture per process on four
copies of E13's fixture: no file, git 2.56's default file, a version-1 file
(`-c commitGraph.generationVersion=1`) and a split chain (`--split`), on an Apple M5
Pro with 48 GB.

| Copy | libgit2 walk, unsorted (ms) | Trunk's cold capture (ms) |
|---|---|---|
| No commit-graph | 830.4 to 833.6 | 1,188.0 to 1,193.3 |
| git 2.56 default file | 835.9 to 841.6 | 1,177.1 to 1,197.5 |
| Version-1 file | 82.9 to 93.3 | not run |
| Split chain | 835.3 to 837.1 | not run |

The hypothesis is refuted for the files git writes today. libgit2 1.9 rejects any
commit-graph chunk it does not know, and the generation-data chunk git writes by
default is one of them. It also opens only `objects/info/commit-graph`, never a chain,
and every repository past 100 commits under `~/code` on this machine keeps a chain.
Only a version-1 file is read, and then the walk takes about a tenth of the time.

The walk is not the whole capture either. The capture reads every commit's summary,
body and author along with its parents, which needs every object inflated whatever the
walk reads them from: that walk alone took 989.5 to 1,004.8 ms. So a faster first capture
needs both a commit-graph reader of Trunk's own, for chains and the current chunks, and
commit facts read after the first page rather than for the whole history up front.
Search and review's check for rewritten commits read every commit's facts, so they
would wait for that read. Turning off libgit2's strict hash verification saved 2 to 10% of the capture and
was not taken. Not measured: real repositories of this depth, whose longer messages
raise the facts share, and fresh clones, which carry no commit-graph until git
maintenance or `git gc` writes one. The
[committed E15 record](performance-data/deep-history-commit-graph-2026-11-19.json)
holds the probe and every timing.

### E16: a save in a large worktree, what one shared scan would change

Flows I12 and I18. In the release drive build on an Apple M5 Pro, a line appended to
a tracked file reached the staging list in 91 to 110 ms across 20 trials in a
generated repository of 20,000 tracked files, against 31 to 51 ms in a 30-file
repository in the same runs. A save starts four readers, each a full worktree status
scan or diff: the staging list's `get_status`, the counts' `get_dirty_counts`, the
graph refresh's dirtiness read and `get_wip_diff_stats`. When the save adds a file to
the list, RepoView reads the counts a second time. The hypothesis was that one scan
shared by every reader of a change would bring the staging list's read close to a
lone scan. A shared read no faster than today's four would refute it.

A release probe linking `trunk-git` ran each set of readers on its own threads, five
rounds, on generated repositories with one edit, and at 100,000 files again with the
sets in reverse order. The first round of the first run read a cold cache, 137.4 ms at
20,000 files and 689.4 ms at 100,000 for status alone, and is left out:

| Readers running together | 20,000 files, status read (ms) | 100,000 files, status read (ms) |
|---|---|---|
| Status alone | 45.1 to 50.7 | 217.0 to 247.9 |
| Status and WIP diff | 66.6 to 70.2 | 330.9 to 353.9 |
| Status, graph dirtiness and WIP diff | 54.2 to 57.3 | 271.6 to 293.8 |
| All four | 65.4 to 72.8 | 332.9 to 403.5 |

The hypothesis is refuted. Sharing one scan among status, counts and dirtiness leaves
the status read beside the WIP diff alone, and that pair measured no faster than all
four. The cost is not monotone in the number of scans, and the cause was not
isolated. Dropping only the counts scan, so that the status read carries the counts,
measured fastest, about 12 ms faster than all four at 20,000 files and about 65 ms at 100,000, comparing medians. At 100,000 files a lone
libgit2 scan took about twice git 2.56's threaded `git status` (100 ms), with `lstat`
in about 420 of 720 samples, so a parallel scan is likely the larger lever there (inferred, not built).

No repository in use reaches these sizes. The largest under `~/code` on this machine
has 8,655 tracked files, so the work is deferred, and the counts carried by the status
read are the first option to reopen. Not measured: the page trial at 100,000 files,
and untracked trees of that size. The
[committed E16 record](performance-data/large-worktree-save-2026-11-19.json) holds the
probe and every timing.

### E17: fifth flow sweep, keeping the selected target and reading position

On 2026-11-21, the flow walk checked I05 to I07, I09, I11 and I16 in the macOS
[drive build](build-environment.md#an-agent-checks-the-running-app-through-the-drive-route)
at `cff9d0af` and again at `6fd5a288`. Both process inventories admitted the
final replay. The native observations
cover DOM content, focus, viewport geometry and saved preferences. Physical
input, presented frames, latency and resource cost were outside this walk.

- **Graph navigation.** Set `fixture_dir=$(mktemp -d)`, then generate
  [cases 09 and 12](fixtures.md#the-cases) with
  `mise exec -- just fixtures 09-kitchen-sink 12-deep-history --out "$fixture_dir"`.
  In the kitchen sink, put local branch `release` at `HEAD~1` and tag
  `release` at `HEAD~2`. Clicking Local's `release` showed the tag's commit
  before and the branch tip afterward. In a separate remote-row check,
  `refs/remotes/orphan` and `refs/remotes/unknown/orphan` both displayed as
  `orphan`. Each opened its own commit. In deep
  history, start at the top, use **Edit > Find** and type `commit 4`. Click
  **Next match** as soon as it enables. For the replay, register a
  `MutationObserver` for the button’s `disabled` attribute before dispatching
  the input event. On the first enabled observation, disconnect and click.
  The old build selected `commit 498` in detail
  while the viewport stayed at HEAD. The new build also brings that row fully into
  view. For the hidden-tip check, make a side branch with one commit of its own
  near HEAD and return to `main`. In a fresh graph, hide that branch with its eye
  and click its name twice. Detail opens on both builds. In the observed fixture
  each old click appended 200 unrelated rows, growing the graph from 5,616 to
  16,816 px. The new graph stayed at 5,616 px. A search for the side commit's
  unique subject showed zero matches and disabled **Next match** after Hide.
  Show restored the single match and enabled the button.
- **Reading a diff.** Commit two 400-line text files, `alpha.txt` and `beta.txt`,
  then change every tenth line through line 300 in both. In that commit's inline
  Source diff, choose **Show full file**, select line 1 and press Escape. The old
  pane closed. The new pane stays open and clears the selection. In full-file
  mode, visit `alpha.txt`, switch to `beta.txt`, scroll down and return to
  `alpha.txt`. It used to inherit the 4,800 px scroll position and now opens at
  the top. Scroll into the unchanged tail and choose **Show hunks**. The old view
  jumped to the first hunk and the new one reaches the last change at line 300.
  For rendered Markdown, commit two files with 40 numbered headings each,
  distinct text per file and paragraphs between headings. Change headings 2, 9,
  16, 23, 30 and 37 in both in a second commit. In the full rendered diff,
  scroll just past change 16 and press `]`. It used to jump to change 9 and now
  reaches change 23, with a 0.6 s highlight on that heading. In a one-sided
  split diff with four headings that fit the viewport, two successive presses
  of `]` highlighted the second and third headings while scrollTop stayed at zero.
- **Diff identity.** On `alpha.txt`, stage a change near the top, then make a
  distinct unstaged change farther down. In Source hunk mode, switch from the
  Unstaged entry to the Staged entry for that path. The old view briefly offered
  **Unstage Hunk** over working-tree text. The new view clears both while it loads
  the index diff. With one Markdown file open in rendered mode, click the other
  in the commit's file list. The old body briefly appeared under the new filename.
  The new body shows loading until the requested file's rendering arrives. For
  each switch, call the row's `click()` and inspect the content in the same
  page script's next microtask (`Promise.resolve().then(...)`). For Staged,
  inspect both the working-tree sentinel line and the Unstage Hunk button. For
  Markdown, read the rendered heading before waiting for its replacement.
- **Settings and sidebar.** With list view and the Diff and Author columns shown,
  visit two repository tabs. Enable tree view and use the graph header menu to
  hide Diff in the first. Switch to the other tab and hide Author there. The old
  second tab still showed list view and Diff, and a newly opened third tab showed
  Diff again. Now the second tab picks up tree view and the hidden Diff column,
  and the third opens with both columns hidden. Collapse Local and click its
  **Create new branch** button. The old form stayed hidden until Local expanded.
  The new click expands Local and focuses the name. Hide a branch in each of two
  repositories, then click Show and Hide in quick succession on the second. The
  native check read back both saved sets after the first two hides and observed
  the latest eye state after the rapid clicks.

The forced interleavings were checked headlessly. These cover an initial search
overtaken by a ref-visibility change, a pending page or search superseded by a newer
navigation, and late staging or rendered Markdown replies crossing a selection.
They also cover preserving both hidden sets when saves overlap, getting Show's
graph and saved state after clicking it during a pending Hide, and honoring
column or eye clicks while saved preferences load. The native checks exercise
the ordinary gestures and do not establish those reply orderings.
[Search](../tests/app/history-search.test.ts),
[graph](../src/components/CommitGraph.runtime.test.ts),
[selection](../src/components/RepoView.selection.runtime.test.ts),
[rendering](../src/components/diff/RenderedDiff.test.ts),
[sidebar](../src/components/BranchSidebar.runtime.test.ts),
[store](../src/lib/store.test.ts) and
[mounted preferences](../src/components/RepoView.preferences.runtime.test.ts) record the cases.

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
The selection timing series leaves open large worktrees under saves, deep paging
cost, network activity, large conflict/review sets and long-session memory growth.
[E17](#e17-fifth-flow-sweep-keeping-the-selected-target-and-reading-position) checks
whether a deep search match reaches the viewport.

### E18: a tracked edit during a local background fetch

Flow I18. In the macOS drive app on an Apple M5 Pro, the exact modified row
appeared in Unstaged while the server still held the first fetch advertisement in
both 30-file fetch trials. The controller held the unchanged request for 194.359 ms
and the changed request for 107.452 ms, including the round trip to acknowledge the
row. This triplet checks edit visibility during a transport wait.

At 20,000 tracked files, the server released the advertisement just after the
write. Each native cohort ran three rotating blocks of no fetch, an unchanged
origin and an origin with one new branch. The table spans the smallest lower
bound and largest upper bound for each condition, rounded outward to 0.1 ms.

| Drive build and fixture index | Write to row, no fetch (ms) | Write to row, unchanged origin (ms) | Write to row, new branch (ms) | Release to branch in sidebar and commit in graph (ms) |
|---|---:|---:|---:|---:|
| Debug, copied | 1,619.1 to 1,632.0 | 1,615.3 to 1,645.0 | 1,621.6 to 1,647.3 | 3,073.4 to 4,054.2 |
| Optimized, copied | 1,477.2 to 1,523.4 | 1,468.6 to 1,509.5 | 1,459.1 to 1,532.4 | 3,541.9 to 3,659.3 |
| Same optimized binary, refreshed copy | 154.7 to 167.0 | 143.5 to 155.1 | 145.0 to 163.2 | 101.2 to 117.1 |

The large-run holds lasted 0.126 to 0.175 ms. The unchanged fetches reported
zero graph rebuilds and the changed fetches reported one each. With the optimized
copied index, the changed fetch IPC reply arrived after the row in all three
trials. With the refreshed index it arrived before the row in all three,
97.2 to 112.1 ms after release. The new branch and graph commit appeared
4 to 5 ms after those replies on the page clock.

The lower bound of the fastest optimized copied-index row is 1,292 ms above
the upper bound of the slowest refreshed-index row. The shift includes the
no-fetch controls. The refreshed cohort's pre-refresh witness showed a different
inode and ctime in the copied index from those in its worktree. Refresh aligned
them with the worktree and preserved the complete staged-entry listing
byte-for-byte. The clean status probe took 1,504 to 1,638 ms on the copied
index and 81 to 90 ms on the refreshed index, on the page clock. The cohorts
ran in sequence. The refreshed cohort also read the staged entries and stat
witness before and after refresh. The control and fetch ranges overlap within
each index preparation. Keep the current background fetch path for this case.
Opening established repositories after users' own Git operations remains
unmeasured.

For replay, generate the 20,000-file tree from the saved E16 generator and
unpack the E18 sources into a scratch directory under `.boris/` as described in
the record. Use a fresh drive instance per trial, with automatic fetch and
graph Diff statistics off. Before arming the observer, wait for the first
unscoped repository-change event, a clean status reply and the baseline DOM
checks. The watcher sends that event at startup. Other whole-repository changes
use the same payload, so the event alone cannot identify its cause. On the disposable worktree
the app will open, compare `git ls-files --debug` with on-disk inode, ctime and
mtime, including after a fresh clone or checkout has been copied. To replay
the refreshed-copy cohort, run `git update-index --really-refresh` in that
disposable copy before launching the app and check that
`git ls-files --stage -z` is unchanged. The frozen runner records this check.

Drive calls `git_fetch_background` over Tauri IPC against a loopback
`git http-backend`. The server receipts bracket the complete append between
advertisement arrival and backend start, with the release in between. The
observer timestamps the first exact modified Unstaged row with Staged empty,
and, for the changed origin, the first observation of both the new branch
and the graph row at the expected summary and SHA prefix. Three host/page
clock brackets on each side, with a 1 ms allowance for each page clock read,
bound the intervals from the host's open-through-close write or barrier
release. The Git oracle checks the exact edited bytes, index digest and staged
entry, HEAD, refs with their symbolic targets, and the one-path porcelain
status. Only the changed case gains a tracking ref and requires an upload-pack
POST. All 60 entry and exit process inventories admitted their trials.

The recorded endpoints are DOM and IPC. Paint, input response, remaining startup
work and global settlement were unmeasured, as were CPU time, memory, I/O and
energy. The admission snapshots can miss work between them. The direct invocation
leaves automatic scheduling, unheld or wide-area transport, and sustained
tracked-file churn open. The [E18 record](performance-data/fetch-edit-overlap-2026-11-21.json)
contains every admitted sample, binary digests, process-admission receipts,
earlier exclusions and the probe sources.

### E19: replay of the reported long-graph scroll hitch

Flow I19, TRUNK-281, 2026-11-21. In the September WKWebView traces, three of
twelve long-graph vertical phases across six launches had clusters of 11, 10
and 10 `requestAnimationFrame` (rAF) intervals above 25 ms. The gaps in those
clusters span 353, 356 and 291 ms from first to last. The longest strictly
consecutive runs were 9, 6 and 10 intervals. The initial November rAF replay
saw two isolated intervals above 25 ms in four long-graph vertical phases.
A subsequent matched-motion cohort tested recurrence with long idle and short
scroll controls at both requested display rates.

The initial rAF and native wheel replays ran in a macOS 27.2.1 (26B131) drive
app on an Apple M5 Pro. The virtual display request was 120 Hz, the 1280 × 770
window reported a maximum of 120 FPS, and the actual display-mode rate was
unspecified. The drive build used a production frontend and debug Rust from
`6fd5a288`. The following revision `345af69e` changed only documentation. The
source, build and fixture hashes are in the [E19 record](performance-data/scroll-replay-2026-11-21.json).

#### Animation-frame replay

Each launch warmed six mounted repository tabs with automatic fetch and graph
Diff statistics disabled. The long tab was a detached Trunk clone at `345af69e`
with 4,187 reachable commits. Its loaded history grew from 200 to 400 to 600
commits during the trial. The short tab was a copy of the kitchen-sink fixture
with 61 commits reachable across all refs. After 3 s idle, use the September
probe's point lookup and dispatch synthetic wheel events with 2 px horizontal
and 14 px vertical drift. Advance the viewport 14 px per frame for 4 s. Reverse at the
ends of the scroll range. Pan the Message column for 4 s and leave a nonzero
offset, then advance the viewport 14 px per frame for another 4 s. The measured
offsets were −309 px on the long tab and −55 px on the short tab.

Each cell gives the maximum rAF interval in ms and the number above 25 ms in
parentheses. The six marked September long-tab idle phases had 181 intervals
each and zero above 25 ms. Both horizontal pan phases also had zero above 25 ms
in all six launches. Both types of vertical phase had a cluster in at least one
launch. All four November tab observations passed entry and exit process admission.

| September launch | Idle | Vertical drift | Vertical after pan |
| --- | ---: | ---: | ---: |
| Base 1 | 23 (0) | 18 (0) | 26 (1) |
| Base 2 | 18 (0) | 26 (1) | 35 (11) |
| Base 3 | 18 (0) | 22 (0) | 19 (0) |
| Head 1 | 18 (0) | 37 (10) | 37 (10) |
| Head 2 | 18 (0) | 18 (0) | 18 (0) |
| Head 3 | 18 (0) | 22 (0) | 19 (0) |

| November launch | Tab | Idle | Vertical drift | Vertical after pan |
| --- | --- | ---: | ---: | ---: |
| 2, short first | Short | 10 (0) | 21 (0) | 14 (0) |
| 2, short first | Long | 20 (0) | 28 (1) | 19 (0) |
| 3, long first | Long | 12 (0) | 26 (1) | 16 (0) |
| 3, long first | Short | 22 (0) | 29 (1) | 23 (0) |

In the separate September `joao-rerun.jsonl`, 76 of 2,552 gaps exceeded 25 ms,
including 59 labeled `idle`. The sampler uses that label when no instrumentation
span is open. This rerun has zero probe phase marks, so those labels cannot
identify which gestures were underway or supply a matched idle control.

September's `VITE_PERF` sampler records differences between rAF callback
timestamp arguments and uses `Date.now()` to place samples between phase
marks. The November probe buffers the same timestamp arguments in the page
with a `performance.now()` reading immediately after the `await`. The second
clock measures when the probe continued before taking the scroll step.
Callback entry time and paint are unobserved. The November long-tab drift had
one interval over 25 ms in each launch on both clocks. The maxima were 28 and
26 ms from the arguments and 28 and 27 ms after awaiting rAF.

The timestamp-argument median was 17 ms in each marked September long-tab idle
and vertical phase and 8 ms in the corresponding November phases. At 14 px per
callback, those medians imply about 824 and 1,750 px/s, respectively. The
November traces show 1,675–1,682 px/s from sampled offsets and elapsed time in
the four long-tab vertical phases. The replay applies roughly twice the
scroll distance per second. September ran frontends `987eca38` and `b96d9f84`
in the instrumented dev app and included a final horizontal Graph pan. The
November drive probe omitted that phase and its first attempt timed out on a
stale tab selector before measurement.

#### Matched-motion rAF cohort

Ten admitted pairs each ran one fresh drive process at a requested 60 Hz and
one at 120 Hz. Both used the same frozen `trunk-drive` (`06d906f2`), whose
SHA-256 matches the executable from the in-place `just drive-build`. The
before and after fingerprints both yielded `3d6536e8` by taking `HEAD` and
overlaying working changes in `src/`, `src-tauri/`, `scripts/` and `tests/`.
Working changes elsewhere and other build inputs were outside that fingerprint.
The exact binary is retained locally. The fingerprint tree is outside the
reachable commit history. The 1280 × 770 windows reported maximum frame rates
of 60 and 120 FPS respectively. The actual display-mode rate was unspecified.
Native configuration readback recorded `preferNear60=false` and a nonpersistent
website data store in both arms.

Each launch warmed six repository tabs with automatic fetch and graph Diff
statistics off. The long tab used the `deep-history` fixture with 843 commits
across all refs and warmed the second graph page before measurement. The short
tab used `kitchen-sink` with 61 commits across all refs. At the start of each
phase, the 698 px viewport returned to the top. Its scroll height stayed at
11,216 px on the long tab and 1,724 px on the short tab, keeping pagination
outside the measured phases. Each launch ran a four-second long-tab idle
phase and four-second unpanned vertical scroll phases on both tabs. The pair
used the same phase order for both rates. Across pairs, the runner alternated
refresh-rate order and rotated or reversed phase order.

The probe sends a synthetic wheel event and advances `scrollTop` by up to
14 px once per visited slot on a nominal 60-step/s grid. The slot is the
elapsed rAF timestamp in seconds multiplied by 60, then rounded. Repeated
slots produce one step, skipped slots receive no catch-up, and the probe
reverses at the scroll boundary. In block 03 at 60 Hz, a 17 ms interval from
2,008 to 2,025 ms advanced from slot 120 to 122, skipping slot 121. There were
13 such two-slot advances after 17 ms intervals. Nineteen of the phase's 241
eligible callbacks repeated a slot, leaving 222 steps and 3,108 px of travel
despite an 18 ms maximum interval. The grid matches the target motion rate
across arms. The realized workload still depends on timestamp rounding.
Long-tab travel over four seconds was 3,108–3,374 px at the 60 Hz request and
3,346–3,374 px at 120 Hz. The long-idle median rAF timestamp interval was 17 ms
in every 60 Hz launch and 8 ms in every 120 Hz launch. Admission required those
medians to fall within 14–20 ms and 6–11 ms respectively.

A burst means at least ten rAF timestamp intervals strictly above 25 ms whose
ending timestamps fit within an inclusive 400 ms window. Every admitted phase
passed entry and exit process admission, stayed visible on the intended tab,
and kept its viewport geometry. The second attempted pair stopped before
the 60 Hz short scroll when process admission could not read a Node process's
arguments. The complete 120 Hz half remains in the receipts, and the runner
repeated both arms in the same planned slot.

| Requested rate | Phase | Bursts / phases | Total intervals above 25 ms | Range of per-phase maxima (ms) |
| --- | --- | ---: | ---: | ---: |
| 60 Hz | Long scroll | 0/10 | 1 | 18–27 |
| 60 Hz | Long idle | 0/10 | 5 | 21–37 |
| 60 Hz | Short scroll | 0/10 | 0 | 18–23 |
| 120 Hz | Long scroll | 0/10 | 0 | 10–24 |
| 120 Hz | Long idle | 0/10 | 5 | 19–30 |
| 120 Hz | Short scroll | 0/10 | 0 | 13–18 |

No admitted phase had two intervals above 25 ms in the same 400 ms window.
The paired comparisons against long idle and short scroll had zero discordant
bursts at either rate. This cohort found no evidence that the September burst
recurs above either control for fixed-depth, unpanned scrolls. With zero hits
in ten long-scroll phases per rate, the one-sided 95% upper bound is 25.9% per
rate under independent trials with a constant hit probability. The card's
under-one-in-twenty stopping condition remains unresolved. This drive replay
uses a different source snapshot, fixture, input schedule and instrumentation
from the `just perf` re-baseline proposed in October. It also leaves paging,
scrolling after a Message pan, the cause of the original burst, physical input
and actual presentation unmeasured. No burst occurred to profile in a WebKit
timeline. The 120 admitted entry and exit snapshots retain the executable
inventory and recorded verdicts. The classifier used interpreter arguments at
collection time. The receipts show its recorded decisions, while independent
reclassification requires the omitted arguments. Activity between snapshots
is unobserved.

For the frozen binary, raw traces and process receipts, use the local cohort
directory below. The analyzer reads the saved pair receipts offline. To replay
the measured executable on macOS, run the second command separately with no
other builds, tests or capture work. The runner targets ten admitted pairs
within twelve attempts and 420 seconds, using a fresh output path.

```sh
matched=.boris/trunk-281-native/matched
cohort="$matched/cohort-3d6536"
mise exec -- python3 -B "$matched/analyze.py" "$cohort"
mise exec -- python3 "$matched/run-matched.py" \
  --binary "$cohort/trunk-drive" \
  --revision 3d6536e841166ae2281b68a72a34cc70fb41c435 \
  --sha256 06d906f235ca634b2a42d19481b466dd0d2ccf0eed6365333e2ca966020e3d51 \
  --probe .boris/trunk-281-native/tools/native-probe.dylib \
  --output "$matched/cohort-replay-1"
```

For a new cohort, start in a clean scratch checkout detached at committed
`c6a5dd63`. Extract `matched_motion_rAF.replay_sources` to
`.boris/trunk-281-native/matched/`. Use the initial replay's frozen E05 harness
from `345af69e`, native probe and historical wheel helpers in the same relative
locations under `.boris/trunk-281-native/`. Generate the fixtures with a fresh
`--out` directory using the fixture generator below, adding `deep-history` to
the case list. Copy `deep-history` to `matched/fixtures/long` and the other
five repositories to their `matched/fixtures/` slot names. Compare their
heads, all-ref commit counts and worktree states with `fixture-manifest.txt`.
Run the following in Bash from that scratch checkout. The new receipt records
the committed source and the new executable's digest.

```sh
set -euo pipefail
revision=c6a5dd638618bfeeb6083e02cd4bb94597472e56
test "$(git rev-parse HEAD)" = "$revision"
test -z "$(git status --porcelain=v1)"
matched="$PWD/.boris/trunk-281-native/matched"
mise exec -- bun install --frozen-lockfile
mise exec -- just drive-build
binary="$PWD/src-tauri/target/debug/trunk-drive"
digest=$(shasum -a 256 "$binary" | cut -d ' ' -f 1)
out=$(mktemp -d "${TMPDIR:-/tmp}/trunk281-new.XXXXXXXX")
mise exec -- python3 "$matched/run-matched.py" \
  --binary "$binary" --revision "$revision" --sha256 "$digest" \
  --probe "$matched/../tools/native-probe.dylib" --output "$out/cohort"
```

See the trial schedule, per-phase results, reconstruction inputs and receipt
digests in the [E19 record](performance-data/scroll-replay-2026-11-21.json).

#### Native wheel and captured pixels

The E05 runner opened one scratch fixture with 400 history commits and a
1,500-line added TypeScript file. Graph runs started 1,200 px down within the
first 200 loaded commits. Diff runs started 12,000 px down. These native runs
recorded `preferNear60=false` and a nonpersistent website data store. Four
alternating gestures sent 100 events of 12 px at 8 ms intervals plus an end event
each.
Every admitted launch recorded 404 native deliveries, 400 matching nonzero
browser wheel receipts, and four complete 1,200 px excursions or returns.

The table reports timings in ms. Native lateness covers the entire delivery
sequence. The other columns use the interior 100–700 ms of each gesture. The
capture gap measures adjacent retained frames. Pixel intervals measure time
between captured changes. Both text crops agree at the analyzer's threshold of
3 mean absolute gray levels.

| Launch | Max native lateness | Max wheel receipt gap | Max browser scroll-event gap | Median pixel interval | Max pixel interval | Max capture gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph 1 | 0.210 | 13 | 16 | 9.103 | 25.995 | 11.166 |
| Graph 2 | 0.624 | 13 | 17 | 9.234 | 56.790 | 56.790 |
| Diff 1 | 1.456 | 10 | 17 | 8.941 | 55.319 | 55.319 |
| Diff 3 | 1.653 | 10 | 17 | 8.814 | 36.325 | 18.660 |

The 56.790 ms graph gap and the 55.319 ms diff gap each overlap six browser
wheel receipts and six progressing scroll offsets. This uses approximate
alignment by elapsed time from the first native delivery and first browser
wheel receipt, with 4 ms trimmed from both edges of the capture gap. The
browser records show dispatch and scroll progress around those gaps. The
ScreenCaptureKit recorder retained no complete frames inside either gap.
Whether the app continued to present during those intervals remains unknown.
Physical trackpad timing was outside both protocols.

Graph 3 and short 1 and 2 failed entry workload admission. Diff 2 failed exit
admission. Short 3 passed both snapshots but event 10 was 7.039 ms late against
the 3 ms limit. The short native variant used 72 history commits and a 56 px
origin to fit the same gestures. The short-repository comparison is limited to
the rAF replay. Process admission samples activity at entry and exit.

#### Paging-boundary replay

On 2026-11-24 three fresh drive launches tested the paging that the matched
cohort kept outside its phases. Each opened one tab on a copy of the 4,187-commit
long fixture at the 120 FPS window, with debug Rust and a production frontend
matching `3b87b857` in everything but one renamed function. The probe set
`scrollTop` 14 px further on every rAF callback from the top for 12 s, which
travelled about 20,100 px. It then stayed 3 s idle at that depth and scrolled back
and forth through the loaded range for 12 s. The one-minute load average was
2.5 to 4.9 across the three runs.

| Launch | Page appends crossed | Paging scroll max (ms, count above 25) | Deep idle max | Loaded scroll max |
| --- | ---: | ---: | ---: | ---: |
| 1 | 4 | 32 (1) | 18 (0) | 29 (1) |
| 2 | 4 | 31 (1) | 17 (0) | 20 (0) |
| 3 | 4 | 22 (0) | 15 (0) | 30 (1) |

The probe saw each append as a growth in the viewport's scroll height. No phase
had a burst. Every interval above 25 ms was a single one, 39 to 43 ms into the
phase, on the first scroll steps, and none fell within 250 ms of an append. The
median interval was 8 ms in every phase. These runs leave scrolling after a
Message pan, physical trackpad input and actual presentation unmeasured, as
before. The probe, runner, analyzer and raw results are in
`.boris/trunk-281-native/paging-2026-11-24/`.

#### Physical trackpad session

On 2026-11-25 João scrolled the long fixture by trackpad for 24 s in a `just perf`
build at `37505c22` and recorded the window with the macOS screen recorder.
No hitch was felt. The scroll crossed 21 page appends. Of the 2,819 rAF intervals,
two were 58 and 59 ms, each alone, and seven were 21 to 27 ms, each about 9 ms after
an append, which is one dropped frame at 120 Hz. None of these formed a burst.
The recording showed no freeze, so presentation agreed with the rAF clock.

The recording did show a different defect. During the fastest flicks, 12 times in
24 s, the lower part of the graph was blank for 17 to 67 ms, up to nine tenths of
its height, with history continuing below it. A drive probe
scrolling the same fixture by script, at up to 600 px per rAF, never left a row
missing from the viewport, so the list's own range and paging keep up with every
offset the page sees. The blank band therefore appears only when the compositor
draws trackpad offsets ahead of the page. That is the symptom the diff pane had
before `0dccb409`, which moved its rows into a stationary viewport.

#### Native fling replay of the blank graph rows

On 2026-11-25 the `scripts/diff-scroll` native input and capture drove the graph of
a copy of the long fixture: eight alternating fast flings (the runner's `fast`
profile) from 40,000 px, 120 Hz virtual display, a frame marker tying each captured
frame to DOM geometry, and a pixel oracle that counts a dark run of 64 px or more in
the Message column. Every row of that fixture has a message, so such a run is
missing content.

| Build | Runs | Captured frames | Blank frames | Largest dark run |
| --- | ---: | ---: | ---: | ---: |
| `ededd2fc`, rows moved by a transform in the scrolled document | 5 | 2,549 | 20 | 698 px, the whole graph |
| Rows in a stationary surface | 4 | 1,661 | 0 | 40 px |

Every baseline blank had the mounted rows covering the whole viewport, so the list's
range was complete and the paint was missing, as in the diff pane. They clustered
where one fling reversed the last. One-way flings showed none in either build.
Moving the rows and the lane overlay into a viewport-high sticky surface, the design
of `0dccb409`, left none in four runs. An earlier candidate whose surface covered
only the viewport's content box had one 86 px blank in 1,475 frames, in which the
rows jumped about 60 px past their path for one frame and came back on the next. The
final surface spans the viewport's padding. Neither build showed a bounce at the top
under this synthetic input, so the bounce is unverified here. The runner and raw
captures are in `.boris/trunk-523/`.

#### Replay and evidence

Run from a fresh scratch checkout pinned to `345af69e`. The rAF wrapper
refuses changes to either harness directory relative to that revision.
The commands below use Bash and start in the checkout that holds the E19
record. The [E05 instructions](../scripts/diff-scroll/README.md) describe
macOS capture prerequisites and admission checks.

```sh
set -euo pipefail
source_root=$(git rev-parse --show-toplevel)
record="$source_root/docs/performance-data/scroll-replay-2026-11-21.json"
revision=345af69e73195d6eb6556cc0ae6296a24c8cb90d
scratch=$(mktemp -d "${TMPDIR:-/tmp}/trunk-e19.XXXXXXXX")
git clone --no-hardlinks --no-checkout "$source_root" "$scratch/source"
cd "$scratch/source"
git switch --detach "$revision"
test "$(git rev-parse HEAD)" = "$revision"
git diff --exit-code "$revision" -- scripts/diff-scroll scripts/interaction-performance
test -z "$(git status --porcelain=v1)"

p="$PWD/.boris/trunk-281-native"
long="$p/repos/long"
mkdir -p "$p/tools" "$p/repos" "$p/native-graph-1/harness"
python3 - "$record" "$p" <<'PY'
import json
import sys
from pathlib import Path

record = json.loads(Path(sys.argv[1]).read_text())
root = Path(sys.argv[2])
for name, source in record['replay_sources'].items():
    (root / name).write_text(source)
(root / 'long-refs.tsv').write_text('\n'.join(record['long_fixture']['refs']) + '\n')
PY
cp -R scripts/diff-scroll scripts/interaction-performance "$p/native-graph-1/harness/"
cp -R "$p/native-graph-1/harness" "$p/short-harness"
patch -s "$p/short-harness/diff-scroll/cadence.py" "$p/short-harness.patch"
```

The original long fixture has detached HEAD, 4,187 commits reachable from HEAD
and from all refs, and 136 refs. Its `origin/main` points to `345af69e`, while
the source checkout's `origin/main` at review pointed to `cff9d0af`. Checking out
the same commit alone leaves a clone's refs dependent on its source. If you
have the saved fixture, run
`cp -a "$source_root/.boris/trunk-281-native/repos/long" "$long"` and skip the
following block. Otherwise, recreate the refs in an empty repository from the
full scratch clone's object store. Git will refuse a required object that is missing.

```sh
test ! -e "$long"
test "$(git rev-parse --is-shallow-repository)" = false
test ! -e .git/objects/info/alternates
git init -q --initial-branch=main "$long"
cp -R .git/objects/. "$long/.git/objects/"
awk -F '\t' '$3 == "" { print "create " $1 " " $2 }' "$p/long-refs.tsv" |
  git -C "$long" update-ref --stdin
while IFS=$'\t' read -r ref object symbolic_target; do
  if [ -n "$symbolic_target" ]; then
    git -C "$long" symbolic-ref "$ref" "$symbolic_target"
  fi
done < "$p/long-refs.tsv"
git -C "$long" remote add origin "$source_root"
git -C "$long" config --local branch.main.remote origin
git -C "$long" config --local branch.main.merge refs/heads/main
git -C "$long" switch --detach "$revision"
```

Verify either fixture against the manifest before building. Use a new output
directory for the [fixture generator](fixtures.md), which replaces repositories
in its output path. Compare the five copied fixtures' `HEAD`,
`git rev-list --all --count` and `git status --porcelain=v1` outputs with
`rAF_fixture_manifest` in the record.

```sh
test "$(git -C "$long" rev-parse HEAD)" = "$revision"
test "$(git -C "$long" rev-parse --is-shallow-repository)" = false
test -z "$(git -C "$long" branch --show-current)"
test "$(git -C "$long" rev-list HEAD --count)" = 4187
test "$(git -C "$long" rev-list --all --count)" = 4187
test -z "$(git -C "$long" status --porcelain=v1)"
git -C "$long" for-each-ref --format='%(refname)%09%(objectname)%09%(symref)' |
  diff -u "$p/long-refs.tsv" -

fixtures=$(mktemp -d "$scratch/fixtures.XXXXXXXX")
mise exec -- cargo run --quiet --manifest-path src-tauri/Cargo.toml \
  -p trunk-fixtures --bin fixtures -- build kitchen-sink nested-conflict \
  rendered-markdown snapshot-impostor graph-lanes --out "$fixtures"
cp -a "$fixtures/kitchen-sink" "$p/repos/short"
cp -a "$fixtures/nested-conflict" "$p/repos/nested"
cp -a "$fixtures/rendered-markdown" "$p/repos/markdown"
cp -a "$fixtures/snapshot-impostor" "$p/repos/snapshot"
cp -a "$fixtures/graph-lanes/02-local-ahead-no-remote" "$p/repos/lanes"
```

Build and freeze the tools from the pinned scratch source before measuring.
If using the frozen tools from the original `.boris/trunk-281-native/tools/`
instead, copy them into `$p/tools` and compare their digests with the record.
A rebuilt binary can have a new digest. Record it with the new trial.

```sh
mise exec -- bun install --frozen-lockfile
mise exec -- just drive-build
cp src-tauri/target/debug/trunk-drive "$p/tools/trunk-drive"
clang -dynamiclib -fobjc-arc -framework AppKit -framework WebKit \
  -framework CoreGraphics scripts/diff-scroll/native-probe.m -o "$p/tools/native-probe.dylib"
swiftc -parse-as-library -O scripts/diff-scroll/native-capture.swift -o "$p/tools/native-capture"
shasum -a 256 "$p/tools/"{trunk-drive,native-probe.dylib,native-capture}
```

Run serially outside builds, tests, OCR and other capture work. Use a fresh
output path for each launch. Native cadence exit 2 records an inconclusive
attempt, whose receipts stay in that output directory.

```sh
out=$(mktemp -d "$scratch/runs.XXXXXXXX")
bash "$p/replay.sh" graph "$out/native-graph-1" || test "$?" -eq 2
bash "$p/replay.sh" diff "$out/native-diff-1" || test "$?" -eq 2
bash "$p/replay.sh" short "$out/native-short-1" || test "$?" -eq 2
bash "$p/replay.sh" raf-short-first "$out/raf-1"
bash "$p/replay.sh" raf-long-first "$out/raf-2"
mise exec -- python3 "$p/summarize.py" "$out"
```

For prior-run reanalysis, the original `.boris/trunk-281-native/` contains the
raw November receipts and recordings, and `.boris/probe-scroll/perf-2026-09-24/app/`
contains the September traces. `summarize.py` and `historical-summary.py`
regenerate the saved trial summaries from those directories. The E19 record
also holds the marked-long-phase and separate rerun counts.

### E20: finding a tracked file and opening the intended repository or rebase plan

On a disposable repository with 8,002 tracked paths, open Review and choose
**Comment on a file…**. The finder at `345af69e` waited for the tracked-file
reply before mounting its input. It then mounted all 8,002 options in a 435 px
viewport. At `c6a5dd63` the finder focused the input while the list was loading
and mounted 26 options when the first viewport filled.

| Milliseconds from the gesture | Baseline `345af69e` | Final `c6a5dd63` |
| --- | --- | --- |
| Search input present | 114, 115 | 3, 3 |
| First option laid out | 201, 202 | 43, 43 |
| Enough options laid out to fill the viewport | 202, 203 | 50, 44 |
| Input event for `file-1999` to the single matching option | 34, 34 | 2, 3 |

Each trial used fresh macOS drive processes, a production frontend and debug
Rust. The table records DOM observations in WKWebView from two trials per
build that passed entry and exit process admission. A pilot observer stopped
at one mounted option. Filling the 435 px viewport with 34 px rows required
13. A baseline pilot failed entry admission during `bun test`. A candidate
pilot failed exit admission during frontend checks.

In an earlier candidate replay with 2,002 paths, zoom narrowed the window
from 1,280 to 1,163 CSS px and reduced mounted options from 26 to 24. The
search input kept focus and the mounted options had negative `tabIndex`.
PageDown selected position 12. Clicking the last option after scrolling to it
opened `project/file-1999.txt`. The first attempt to reopen the finder timed
out while that diff was open. The successful replay pressed Escape, reopened
the finder, filtered to `file-0123` and pressed Enter to open it. A separate
scroll-to-end probe then pressed Enter with the input still focused. The
earlier build opened the offscreen `change-1.txt`. The later build opened
the visible, selected `project/file-1988.txt`. Physical Tab traversal, first
displayed pixels, CPU and memory were outside these observations.

In the same repository, the branch `release` pointed at C2 and the tag
`release` pointed at its parent C1. Opening **Interactive Rebase** on C2
displayed “onto release” at `345af69e`. It displayed “onto 655ba48”, the
actual parent, at `c6a5dd63`. In the headless application test, opening
C3 uses C2 as the base, where `decoy` names a tag at C2 and a branch at C3.
Opening C2 uses its unreferenced parent C1. Each case asserts the exact toolbar
text using the base commit's short SHA from the graph. The filtered calls from
the context-menu choice through that toolbar read contain one `get_rebase_todo`
and zero `list_refs` or `resolve_ref` calls. [Rebase preview regression](../tests/app/rebase-preview.test.ts)

A separate native Start replay marked C2 to drop in a plan for `main`, then
switched to `topic-000` at the same tip before pressing **Start Rebase**.
At `345af69e`, Start rewrote `topic-000`, removing C2 from its history, while
`main` kept its tip. At `c6a5dd63`, Start reported that the branch had changed
and both refs kept their original tips. The application regression checks
the same refusal on a same-tip `sibling` branch, the two full ref SHAs, the
toast and the closed editor. An external Git process can still change HEAD
after Trunk's final check and before Git reads it. [Start regression](../tests/app/rebase-preview.test.ts)

A separate native I01 replay used three disposable repositories with distinct
commits. It opened A and held B's `open_repo` callback in the webview after
Rust opened B. A separate `head_oid` call confirmed B's exact commit while
the UI still showed A. After choosing C, the probe waited for C's graph, A's
close and the Recent write before releasing B. At `345af69e` the picker
switched to B and closed C. At `c6a5dd63` it kept C selected and saved, closed B
and returned `not_open` for B's HEAD. In the Escape case, the baseline switched
to B and closed A. The final build kept A selected and saved and closed B, with
zero writes to Recents or saved tabs. All eight checks passed in both final cases
on the same executable used for the finder and rebase comparisons.
[Repository-open regressions](../src/App.repository-open.test.ts)

The committed comparison used drive binaries `d23bb3c8` and `54a2f8f4`. The
baseline executable was built at `6fd5a288`, which has the same build inputs
as `345af69e`. The finder fix landed in `8dbec7da` and the picker fix in
`8c69f288`. The record includes the fixture, replay scripts, build fingerprints
and earlier observations.
[E20 record](performance-data/file-finder-rebase-2026-11-21.json)

### E21: returning to a populated review

I01, I02 and I17. The macOS drive replay used two disposable repositories and
a private review store. The primary repository had three commits and ten short
TypeScript files. Its archive held 15 synthetic threads, 20 replies and one
thread on a missing file. Each repository had its own one-thread active review.
The functional baseline used `6fd5a288` (`d23bb3c8`).

Open Review, expand **Archived** and pick the synthetic archive. Use `J` and `K`
to reach thread 12 below the initial viewport, then press Enter. The replay
checked commit `281aa3f`, `file-0002.ts`, added line 32 and its adjacent inline
thread inside the diff viewport. **Close diff** focused thread 12, kept its
382 CSS px offset inside the review viewport and left scroll at 2,146 CSS px.
The other tab showed its own review and thread. Returning kept the same 15
archive thread IDs. The baseline cleared focus and cursor, reset scroll to 0
and collapsed **Archived**. The next `J` landed on thread 01.

The build from `52da110` (`45d7fd51`) reached the same diff and restored the
same review position on **Close diff**. After switching tabs and back, thread
12 kept the cursor, focus and 382 CSS px offset. Scroll stayed at 2,146 CSS px and
**Archived** stayed open. The next `J` advanced to thread 13. Both builds showed
**Orphaned** with a **File gone** tooltip for the missing file.

In a separate serial launch of `4de11c15`, three warm archive selections
reached the correct title, card count and laid-out target card in 18, 20 and
15 ms. The one-thread active control took 4, 5 and 3 ms. The archive takes a
second read after the active review batch, so this comparison cannot isolate
thread-count cost. Both `4de11c15` runs passed entry and exit process admission.
The samples cover DOM readiness. The other builds supplied functional checks.
Physical input, presented frames, background settlement and resource use remain
unmeasured. The unfocused drive window leaves foreground read-state behavior
open, and the workload leaves review-size scaling and usage frequency open.
The record contains the synthetic fixture generator, executable replay and raw
observations needed to repeat the checks. [E21 record](performance-data/review-navigation-2026-11-21.json)

## Measured priority and continuation

Frequency remains an assumption; no usage telemetry was collected.

| Priority | Next decision | Impact/frequency, evidence and risk |
| --- | --- | --- |
| 1 | Broaden I19 scrolling evidence while preserving the accepted behavior | The user made scrolling the priority. E05 changes captured diff-content cadence from 17.820 to 8.903 ms and accepts added process CPU in diff and graph scrolling. Painting checks pass at requested 60 and 120 Hz, including a replacement 90,000-line run with workload admission. Four admitted graph pairs have overlapping medians and capture gaps in both builds. E19 found zero historical bursts in ten matched long-scroll, idle and short-scroll trials at each requested rate. Preserve the stationary row layout and configuration fallback. Revisit the hitch when a new trace captures it. Physical trackpad timing, long-session cost and older-OS behavior remain open. High presentation risk. |
| 2 | Preserve the reviewed selection and navigation contracts | Browsing is assumed frequent. E01 removes 116.5 ms in the width series and 129 ms in the delivered-source confirmation at 1,000 files. Warm ranges overlap; CPU, memory and highlight costs remain explicit. E17 and E20 cover switching files, repositories and rebase plans while an earlier request is pending. In E20 the 8,002-file finder filled its viewport in 44 to 50 ms. Keep the held-response regressions for selection order. |
| Closed | Large-list rendering investigation, E06 | E06 retained the full list for its workload. At 5,000 changed files, `bb7d4b38` rendered the visible band plus one viewport on either side. In the M5 Pro drive app with a production frontend and debug Rust, the observed commit-open freeze fell from 382 to 40 ms. In E06, V1 improves first selection but blanks the viewport under controlled suspension; V2 adds scrolling CPU and footprint cost; V3 reduces plane height without removing that cost. Reopen only for a new causal hypothesis or representative workload. V2/V3 selection gains remain unmeasured. |
| 5 | Measure the remaining per-file mutation paths at large-index scale | E09 measured each per-path command re-reading and rewriting the whole index, 8.5 to 13 ms a path on a 20,200-file repository, so a loop of 200 took 1.85 to 2.63 s where one batched command took 33 to 50 ms. Folder stage, unstage, resolve and discard now send one command. Overlapping in-app actions take turns at a per-repository write gate (E09), so none reports a lock failure or drops another's write. E14 cut the watcher's CPU under ignored build output to about a tenth. E16 measured a save at 20,000 tracked files reaching the list in 91 to 110 ms and found sharing one scan among its readers no faster; the largest repository in use has 8,655 files. In E18's refreshed 20,000-file fixture, the edit appeared within 167 ms in the no-fetch controls and when a local fetch overlapped the write. The server released the fetch after the write. Production scheduling and sustained tracked-file churn remain open. High Git correctness risk; use disposable repositories and exact content oracles. |
| 6 | Deep history, review and operation flows | E09 covers bulk conflict resolution. E11 measured the graph rebuild after a commit at 30,000 commits falling from about 95 to 7.4 ms in the backend capture. E13 measured the layout a capture waits for at 300,000 commits falling from about 390 to about 160 ms; the first capture, about 1.09 s there and 112 to 136 ms at 30,000, is unchanged and is the open cost. E15 found libgit2 reads none of the commit-graph files git writes today, and that cutting the first capture needs a commit-graph reader of Trunk's own and commit facts read after the first page. The deepest repository under `~/code` on this machine has 5,077 commits (2026-11-19). Conflict-region count is measured in the backend and the editor's TypeScript, on generated conflicts on an Apple M5 Pro: after `a0f61f2a` the merge editor's read takes 11.5 ms at 20,000 lines and 500 conflicts and 57 ms at 100,000 lines and 2,500, most of the rest being libgit2's SHA-1, and a click's output rebuild takes under 1 ms and 2.3 to 4.8 ms there under bun. The webview's share, a reply about three times the file's size and an output textarea rewritten on each click, is unmeasured. [E21](#e21-returning-to-a-populated-review) checked tab return on a 15-thread archive. Review-size scaling and history depth beyond the graph rebuild remain unmeasured. E10 walked flows I01 to I18 on the fixture corpus for whether each result was the one the user meant; its timings are unrepeated drive-build readings, a later trace put commit usable at 29 to 163 ms, with the rest of its 650 to 1,400 ms reading being the watcher's deliberate refresh, which E12 cut from about 515 to 27 to 37 ms for an outside edit; the same timer put checkout, compare, hunk navigation, diff options, merge-editor actions, cherry-pick, revert, rebase, reset and stash under 100 ms on small fixtures, and a merge's message dialog at 171 ms. Both slow readings match the cost of a process's first git-binary action, which waited for the user's login shell to start: in the drive instance on 2026-11-19 the first `merge_branch_begin` took 180 to 185 ms against 28 ms for the second, and after `8a6efda3` started that shell at launch the first took 28 to 31 ms. The E10 readings themselves were not retaken. |
| Last | Weigh highlighted full-file opens near the parse cap | E08's native A/B measured per-cluster windows cutting a highlighted 4,800-line TypeScript read from 216 to 252 ms to 18 to 31 ms in hunk mode and 138 to 163 ms in full mode. Plain text reads in 1 to 11 ms. Full mode still parses every new-side line, so it is now the largest open cost measured. Reducing it means highlighting less than the whole file up front, which changes the reply and the frontend. E08 observed usable full-file content in 153 to 175 ms on this fixture. Fresh near-cap opens in ordinary use have no frequency measurement. Retain the current reply and exact colors unless a recurring slow workflow warrants changing when syntax becomes visible. The review finder and a full-file read for anchoring a comment can also request this work independently of the display preference. The installed copy used hunk mode on 2026-11-19. The cap is 5,000 parsed lines per side. Sparse hunks in a larger file can retain highlighting. In full-file mode the new side exceeds the cap when it has more than 5,000 lines, while deleted lines can retain highlighting if their old-side windows fit. The first-read cost in each process is inferred and not isolated. E07's pilots found and fixed a mixed-mode display defect. Preserve existing reuse. Medium risk: a far hunk's colours rest on the 250-line lookback. |

The evidence supports retaining current warm diff reuse, mounted-tab reuse,
coalesced refresh, and the search debounce. It does not support another cache or
blanket debounce. Reopen rejected experiments only with a new bottleneck hypothesis.

## Review and regression evidence

To check keyboard tab restoration, open three disposable repositories with
different tip commits and select the first tab. Press Cmd+3, quit, and reopen
the same profile. Repeat from the first tab with Ctrl+Tab. The native replays
used synthetic WebKit key events. At `345af69e`, the selected graph changed,
but the saved selection still named the first tab. After `drive quit`, a fresh
process reopened that tab in both cases. At `6e1adf81`, the probe requested
AppKit termination after observing the selected tab, without awaiting a
preference write. A fresh process restored the third and second repositories
respectively, each at the expected Git tip. Held-write application tests cover
the ordering separately. [Tab persistence tests](../tests/app/tab-persistence.test.ts)

For remote navigation, use a disposable repository with two or more commits
and a configured remote named `origin`. Create `refs/remotes/origin/main` at
the tip and `refs/remotes/origin/release/HEAD` at its parent, both as direct
refs. Point the symbolic `refs/remotes/origin/HEAD` at `refs/remotes/origin/main`.
Open the repository and expand the remote branches. At `345af69e`, the sidebar
listed only **main** under **origin**. At `26889b95` it also showed
**release/HEAD**. Clicking that row selected the parent commit. The symbolic
default-branch alias stayed out of the list. [Branch listing tests](../src-tauri/tests/test_branches.rs)

The steps above can be repeated from the named commits. The original drive
scripts and receipts are local artifacts under `.boris/trunk440-sixth/`
(`tab-native/` and `remote-head*.json`).

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
