# Diff syntax highlighting: the cost model

What highlighting a diff actually costs, which guards bound it, and which optimisations were
measured and rejected. Read this before changing anything in `src-tauri/src/syntax.rs` or
the enrichment path in `src-tauri/src/commands/diff.rs`.

## The shape of the work

Highlighting runs in Rust, never in the frontend. `syntax.rs` builds a syntect
`HighlightLines` from the `two-face` extra-newlines syntax set and the `base16-ocean.dark`
theme, feeds it one line at a time, and maps each resulting foreground colour to a CSS class
by exact RGB match in `color_to_css_class`. The frontend receives spans with class names and
does no parsing of its own.

syntect's parser is a sequential state machine: line N's parse state is the output of line
N-1. What that state actually depends on, though, is the nearest enclosing construct, not the
top of the file. So the highlighter starts a fixed number of lines above each line the diff
needs rather than at line 1, and the lines it walks to get there are parsed for their state
and dropped.

Measured against 205 of this repo's own `.ts` and `.rs` files, 6,794 lines sampled: **0.059%
of lines differ from a full parse from line 1** at a 250-line window, against 6.359% with no
lookback at all. A difference is wrong colours on one line inside a long construct. Never a
crash, and never wrong content.

That corpus has no minified JavaScript, no very long string literals or block comments, and no
other pathological shapes. A user's repository can differ more often. The window size is the
only mitigation, and 250 was chosen over 100 for exactly that margin.

## The cost model, in line-parses

A side's needed lines fall into clusters: a needed line more than 251 lines below the previous
one starts a new cluster. Each cluster parses one window, from 250 lines above its first line,
at `max(1, first - 250)`, down to its last line, with a fresh highlighter. Lines parsed per
side is the sum of the window lengths, and the lines between two windows are never parsed. So
the first line of a cluster takes its colours from its own 250-line lookback, at the fidelity
measured above, rather than from a parse that ran down from the cluster above it.

**Cost follows clusters, not depth or distance.** A narrow hunk below line 251 costs its span
plus 250 lines wherever it sits, and one nearer the top costs less, because the top of the file
cuts its lookback short. A file whose hunks sit at line 3 and line 40,000 parses two short
windows, about 260 lines per side with their context, and is highlighted. Every separate cluster
below line 251 adds at least 251 lines, so about twenty well-separated narrow hunks reach the
cap by themselves. Cost grows past that only with a cluster's own span: one wide hunk, hunks
closer together than the lookback, an added file, or full-file view.

Until 2026-11-16 a side parsed one window, from the first needed line minus 250 to the last
needed line, so two narrow hunks far apart cost the whole distance between them. A native
pilot opened a 4,800-line TypeScript file with edits at lines 1 and 4,300 and spent 223 ms in
the diff command in hunk mode, against 2 to 6 ms for the same shape as plain text. The old
window parsed about 8,600 lines across the two sides to display 13 of them. The E08 section
of [`interaction-performance.md`](../interaction-performance.md) has the measurement and
[its record](../performance-data/highlighted-open-2026-11-16.json) the data.

Two baselines, because they differ:

- **Cold open**, nothing parsed yet. For a side the single window highlighted, the windows sit
  inside it without overlapping, so the side parses no more lines than before and fewer
  wherever its clusters are apart. A side whose single window ran past the cap used to skip
  parsing entirely. When its windows now fit under the cap it parses up to 5,000 lines, which
  is more work, spent on highlighting that was absent before.
- **Edit-save loop**, the file being edited. Before the bounded window, the committed side hit
  a content-OID token cache and only the working-tree side parsed, so the cost was one parse
  from line 1 to the deepest needed line. There is no cache now, so both sides parse their
  windows. **Better only when both sides' windows together are shorter than the deepest
  needed line.** Edits at lines 1 and 300 already break that: 252 old plus 261 new lines
  against 303.

Three consequences follow, and all three are real:

1. **Saving costs about twice the cache era when both sides need one cluster that runs from
   near the top to deep in the file**, such as a rewrite spanning the file. The measured case is
   `edit_save_wide_span` under the single window: 127 ms against 63 ms on a 3,000-line file
   with hunks at both ends, which that window parsed as one span. Per-cluster windows parse that
   fixture as two short windows, so the 2x for a true single cluster is inferred from line
   counts and has not been measured.
2. **Full-file view parses the whole new side on every save.** `apply_request_options` sets
   `context_lines` to 100,000 when `show_full_file` is set, so every line becomes a Context line
   with a line number, and Context lines take their tokens from the new side. The new side's
   needed set is 1..N and its one window is the whole file. The old side needs only its deleted
   lines, so its windows stay short. A save therefore costs one whole-file parse plus about 250
   lines per cluster of deletions, close to what the cache era paid and far more than hunk mode.
   It is a persisted preference, so a user parked in that mode pays it until they leave it.
3. **Highlighting depends on the view mode for files over the cap.** A tracked file over 5,000
   lines with narrow hunks is highlighted in hunk mode. In full-file view its new-side and
   Context lines are unhighlighted, because the new side needs every line, while its deleted
   lines stay highlighted when their windows fit under the cap.

## Measured costs

All numbers from `src-tauri/benches/bench_commands.rs`, `diff_ts_large_file` group, on a
3,002-line TypeScript file. Benchmarks on this path are load-sensitive, so check `uptime` reads
below 4 before trusting a run: the before column was measured 2026-08-25 at load 2.14, the
after column 2026-08-26 at load 2.64. Both ran the same suite, the before column against the
unchanged pipeline.

| Case | Before | After | What it is |
|---|---|---|---|
| `early_change` | 1.2465 ms | 1.2558 ms | One changed line near the top |
| `late_change` | 123.58 ms | 11.292 ms | The same one-line change near the bottom |
| `edit_save_loop` | 63.085 ms | 11.459 ms | A late change rewritten every iteration, as a save does |
| `edit_save_wide_span` | 63.222 ms | 126.89 ms | The same loop with hunks at both ends of the file |
| `cache_hit` | 816.63 µs | — | Deleted with the cache it measured |

`late_change` and `edit_save_loop` agree, because a narrow hunk below line 251 costs the same
wherever it sits. The after column predates per-cluster windows. `edit_save_wide_span` changes the two ends
of the file, which one window covered top to bottom and two windows now cover separately. Re-run
on 2026-11-16 with per-cluster windows, it took 11.445 ms, beside 10.811 ms for `edit_save_loop`
in the same run, so hunks at both ends now cost about what one late hunk does. That run's load
was not recorded, though the machine had no build or test running when it started.

Repeat views of one diff got slower too: 816.63 µs from the cache before, about 11.5 ms now.
Below perception, and the reason the cache was not worth its 197 lines plus the warming
machinery around it.

### Current-source reuse

The current-file view has a different cost: a measured reopen of unchanged full source spent
32–99 ms in its native command, almost entirely in `build_side_lines`. It therefore keeps one
app-owned result for the last current-source view. A request first passes through
`read_tracked_working_tree_file`, including its index and no-symlink checks, and then matches the
exact file path and raw text bytes. An edit or a different path builds a new result. A binary
read clears the text entry and returns the binary view. A failed secure read returns its error
without consulting the entry.

The result is built outside the cache lock and only retained when the approximate owned
allocation is at most 2 MiB. That accounting includes the input bytes, the output's nested
vectors and strings, and their capacities. Larger files still open, without retention. This
does not change the ordinary diff enrichment path or the 5,000-line parsing guard. The
uncached `current_file_diff` remains for direct callers and baseline measurements.

An optimized native comparison on the M5 Pro opened three current source files twice, in
two runs per build with background fetch disabled. Repeat `open_current_file` IPC latency
fell from 40–115 ms to 4–7 ms. The reuse helper took about 0.5 ms and did no enrichment on
a hit; command response cloning and serialization remain included in IPC latency. A miss
still builds and enriches the source. These observations cover that bounded workflow, not
overall application CPU or responsiveness.

### Where the time goes inside one parse

Measured separately on the same fixture, splitting a cold highlight into its halves:

| Case | Time |
|---|---|
| `ParseState::parse_line` + `ScopeStack::apply` only | 60.086 ms |
| syntect's full `HighlightLines` | 62.086 ms |
| Our shipped path, including `SyntaxToken` building | 62.677 ms |

**Parsing is 96% of the cost. Theme matching and token building together are 4.1%.** If you
are looking for a win, it is in parsing fewer lines, not in making the work downstream of them
cheaper. See the rejected optimisation below, which learned this the expensive way.

## The guards

Three bounds keep pathological input off this path. Removing any of them needs a measurement,
not an argument.

**A 5,000-line parse cap.** `MAX_SYNTAX_PARSE_LINES` in `commands/diff.rs` returns an empty
result for a side whose windows together would parse more lines than that. The bound is on
lines parsed, not on how deep the deepest one sits, which is what lets narrow hunks past line
5,000 be highlighted while a 90,000-line added file is still skipped. A side with many hunks
can reach the cap through the sum alone: twenty-five narrow hunks a thousand lines apart parse
more than 6,000 lines and are skipped. An added file's diff is one hunk whose every line is an Add carrying a line number, so its needed set is 1..N
and its window is the whole file; full-file view reaches the same set by a different route.

**The Markdown grammar is refused outright.** syntect's Markdown grammar catastrophically
backtracks on lines mixing bold and inline code, up to about 250 ms for a single line.
`syntax.rs` refuses to build a highlighter for it at all, by extension and by fenced-block
language token. The extension list is syntect's own, deliberately not the frontend's
rendered-view set.

**Word-level spans bound each replacement run and share a file deadline.**
[`word_spans.rs`](../../src-tauri/src/word_spans.rs) skips refinement when a delete/add
run exceeds 100,000 combined text bytes, any line exceeds 500 bytes, or the file's
500 ms refinement deadline has elapsed. The deadline is shared across hunks and
passed into line and inline diffing. Unrefined runs retain plain add/delete coloring;
the guard is not a paired-line count.

## Rejected: skipping the theme layer for undisplayed prefix lines

Walking to line 3,000 means running theme matching on the lines in between when the diff might
display forty of them. Skipping the theme layer for the lines nobody sees looks like an obvious
win, and the plan of record estimated it at about a quarter of every cold parse.

**Measured, it is 4.1%**, and that is a ceiling the change could not reach, since it saves only
on lines the window walks past. It was rejected in favour of leaving `easy::HighlightLines`
alone, on a code path whose last three defects were all state-handling bugs. Do not re-propose
it without a measurement that contradicts the table above.

## Rejected: caching parser state instead of tokens

syntect's own documentation describes snapshotting `ParseState` every thousand lines or so and
resuming from the nearest checkpoint. It does not compile here: `ParseState.stack` holds
`StateLevel.captures`, which holds an `onig::Region` wrapping raw pointers, and onig declares
`Send` for `Regex` only. Every diff command runs inside `tauri::async_runtime::spawn_blocking`,
so consecutive requests land on different pool threads. Reaching a comparable win that way
would mean a dedicated long-lived highlighting thread owning the state, with a channel protocol
and a shutdown path; the bounded window reaches it by deletion instead.

## What this pipeline is not responsible for

The backend's narrow-diff path is bounded. When a large file feels slow to open, measure before
assuming this is why. Cached fetches of a 3,201-line file were measured at 15-17 ms while the
app still felt sluggish, and the cause was the frontend rendering every line of the file with no
virtualisation. That is tracked separately. Per-row CSS `content-visibility: auto` was tried
against it and made scrolling materially worse, because per-row containment moves style, layout
and paint onto the scroll thread thousands of times.
