# Performance instrumentation

Standing tooling for measuring how long the app takes to do things. Off in every build
except a `just perf` session.

## Using it

```bash
just perf                 # dev server, instrumentation on, samples truncated at startup
# exercise the app: open files, scroll, stage, switch commits
just perf-report          # per-operation distributions
just perf-report 100      # also lists every individual sample at or over 100ms, in order
```

Samples land at `/tmp/trunk-perf/samples.jsonl`, one JSON object per line, and the path is
logged to the console at startup. The file is appended to while the app runs and flushed
every two seconds, so a report can be taken from a *running* app — including one whose UI is
stuck, which is the case a devtools session cannot serve.

`just perf-report` prints one row per operation, ordered by total time spent rather than by
call count, because the operation worth looking at is the one the session spent longest in:

```
operation                     kind     n   mean    p50    p90    p95    p99    max    total
idle                     frame-gap  2000   16.0   16.1   19.8   21.0   23.1   25.1  32015.8
invoke:diff_commit_file       span   400   60.4   62.5   85.6   91.2  102.4  114.9  24143.6
```

## What is measured

**Every backend command, automatically.** `safeInvoke` is the single frontend-to-backend
seam, so wrapping it times all of them under `invoke:<command>` with no edit at any call
site, and covers each command added later for free. A command that *failed* is timed too: a
slow error is exactly the cost that otherwise never shows up.

**Frame gaps**, sampled off `requestAnimationFrame`. `PerformanceObserver` on `longtask`
silently no-ops in this WKWebView — it never throws and never emits, including through a
demonstrated 369ms block — so frame gaps are the only usable main-thread-block measure here.

**Named spans**, wherever a caller wraps one:

```ts
await span("diff.openCommitFile", async () => { ... });   // async
const model = measure("diff.buildRows", () => build(...)); // synchronous
```

A frame gap is filed under the innermost span open when it happened, which is what turns "a
177ms stall occurred" into "a 177ms stall occurred during `diff.openCommitFile`". Spans that
overlap across an `await` attribute to the most recently opened one: an approximation in the
*name*, never in the timing.

## Attributes

A duration says which operation is slow and never on what input. A span's body is handed an
observation it can annotate, including with facts only known once the work is done:

```ts
await span("diff.openCommitFile", async (observation) => {
  observation.attr("path", path);
  const diffs = await fetch(...);
  observation.attr("lines", countLines(diffs));
});
```

Attributes show up beside each sample in the over-threshold listing, which is what turns
"`diff.openCommitFile` p95 is 300ms" into "300ms on an 89,999-line file".

## Percentiles

Nearest rank, no interpolation, so every number reported is a duration the app actually
measured. Aggregation happens in the report rather than at record time, so the raw samples
stay on disk and a better statistic never needs another run.

## The gate

`enablePerf` is an explicit call, made from `src/lib/perf-session.ts` only when
`VITE_PERF=1`. It is deliberately **not** `import.meta.env.DEV`: `DEV` is true under vitest,
and gating on it once silently routed two `DiffPanel` tests down an instrumented path.

With instrumentation off, `record`, `measure` and `span` cost one boolean check and nothing
else, and no IPC is issued. The Rust command is inert outside a debug build as well, so the
release build does not depend on the frontend gate alone. It takes no path argument: the
destination is fixed, so nothing on the frontend can direct a write elsewhere.

## Every instrumentation site has a test

Instrumentation rots silently: a wrapper dropped during an unrelated edit costs an operation
in the report and breaks nothing. Each site is therefore pinned by a test that asserts the
observation fires with its attributes — `RepoView.test.ts` for `diff.openCommitFile`, and
`FullFileView.test.ts` plus `HunkView.test.ts` for `diff.buildRows` and `diff.rowHeights`,
which both views record. Add one alongside any new span.

## Adding a span

Wrap the operation, don't sprinkle timers. A good span name is the user-visible operation
(`diff.openCommitFile`), not the function (`selectCommitFileIdempotent`) — the report is read
to answer "what is slow for the user", and a frame gap attributed to a private function name
does not answer it.
