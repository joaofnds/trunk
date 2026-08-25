# Diff syntax highlighting: the cost model

What highlighting a diff actually costs, which guards bound it, and which optimisations were
measured and rejected. Read this before changing anything in `src-tauri/src/git/syntax.rs` or
the enrichment path in `src-tauri/src/commands/diff.rs`.

## The shape of the work

Highlighting runs in Rust, never in the frontend. `syntax.rs` builds a syntect
`HighlightLines` from the `two-face` extra-newlines syntax set and the `base16-ocean.dark`
theme, feeds it one line at a time, and maps each resulting foreground colour to a CSS class
by exact RGB match in `color_to_css_class`. The frontend receives spans with class names and
does no parsing of its own.

syntect's parser is a sequential state machine: line N's parse state is the output of line
N-1. What that state actually depends on, though, is the nearest enclosing construct, not the
top of the file. So the highlighter starts a fixed number of lines above the first line the
diff needs rather than at line 1, and the lines it walks to get there are parsed for their
state and dropped.

Measured against 205 of this repo's own `.ts` and `.rs` files, 6,794 lines sampled: **0.059%
of lines differ from a full parse from line 1** at a 250-line window, against 6.359% with no
lookback at all. A difference is wrong colours on one line inside a long construct. Never a
crash, and never wrong content.

That corpus has no minified JavaScript, no very long string literals or block comments, and no
other pathological shapes. A user's repository can differ more often. The window size is the
only mitigation, and 250 was chosen over 100 for exactly that margin.

## The cost model, in line-parses

Write `max` and `min` for the deepest and shallowest line a side's diff needs, and
`start = max(1, min - 250)`. Lines parsed per side is `max - start + 1`.

**The win is per-span, not per-file.** A narrow hunk anywhere in a file costs its span plus
250 lines, wherever it sits. A file whose hunks run from line 3 to line 40,000 has `start` at
1 and a 40,000-line span, which is over the cap and skipped, exactly as before. A file whose
hunks span 4,000 lines parses 4,000 lines per side, not 251.

Two baselines, because they differ:

- **Cold open**, nothing parsed yet. Before, each side parsed `max`. Now each parses
  `max - start + 1`. Never worse, often far better.
- **Edit-save loop**, the file being edited. Before, the committed side hit a content-OID
  token cache and only the working-tree side parsed, so the cost was one parse of `max`. There
  is no cache now, so both sides parse: `2·(max - start + 1)`. **Better only when
  `2·(max - start + 1) < max`**, which is any narrow span, and worse whenever `start` lands at
  1.

Three consequences follow, and all three are real:

1. **Saving is about 2x slower wherever the needed span reaches the top of the file.** Two
   3,000-line parses against one. Sub-millisecond when the span is small; 127 ms against 63 ms
   on a 3,000-line file with a full-width span.
2. **Full-file view pays that on every save.** `apply_request_options` sets `context_lines` to
   100,000 when `show_full_file` is set, so every line becomes a Context line with a line
   number, the needed set is 1..N, and `start` is 1. It is a persisted preference, so a user
   parked in that mode pays it until they leave it.
3. **Highlighting now depends on the view mode for files over the cap.** A tracked file over
   5,000 lines with one narrow deep hunk is highlighted in hunk mode and unhighlighted in
   full-file view. Before this change neither mode highlighted it. A per-hunk window — several
   windows per side rather than one — would remove consequences 1 and 3 and shrink 2; it was
   considered and left unbuilt.

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

`edit_save_wide_span` is consequence 1 with a number on it. `late_change` and `edit_save_loop`
now agree, because a narrow hunk costs the same wherever it sits.

Repeat views of one diff got slower too: 816.63 µs from the cache before, about 11.5 ms now.
Below perception, and the reason the cache was not worth its 197 lines plus the warming
machinery around it.

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
result for a side whose window would run longer than that: `max - start + 1 > 5000`. The bound
is on lines parsed, not on how deep the deepest one sits, which is what lets a narrow hunk past
line 5,000 be highlighted while a 90,000-line added file is still skipped. An added file's
diff is one hunk whose every line is an Add carrying a line number, so its needed set is 1..N
and its window is the whole file; full-file view reaches the same set by a different route.

**The Markdown grammar is refused outright.** syntect's Markdown grammar catastrophically
backtracks on lines mixing bold and inline code, up to about 250 ms for a single line.
`syntax.rs` refuses to build a highlighter for it at all, by extension and by fenced-block
language token. The extension list is syntect's own, deliberately not the frontend's
rendered-view set.

**Word-level spans skip large blocks.** `compute_word_spans_for_hunk` gives up on blocks over
40 paired lines.

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

The backend is fast and bounded. When a large file feels slow to open, measure before assuming
this is why. Cached fetches of a 3,201-line file were measured at 15-17 ms while the app still
felt sluggish, and the cause was the frontend rendering every line of the file with no
virtualisation. That is tracked separately. Per-row CSS `content-visibility: auto` was tried
against it and made scrolling materially worse, because per-row containment moves style, layout
and paint onto the scroll thread thousands of times.
