# Diff syntax highlighting: the cost model

What highlighting a diff actually costs, which guards bound it, and which optimisations were
measured and rejected. Read this before changing anything in `src-tauri/src/git/syntax.rs`,
`src-tauri/src/git/token_cache.rs`, or the enrichment path in `src-tauri/src/commands/diff.rs`.

## The shape of the work

Highlighting runs in Rust, never in the frontend. `syntax.rs` builds a syntect
`HighlightLines` from the `two-face` extra-newlines syntax set and the `base16-ocean.dark`
theme, feeds it one line at a time, and maps each resulting foreground colour to a CSS class
by exact RGB match in `color_to_css_class`. The frontend receives spans with class names and
does no parsing of its own.

The decisive property is that **syntect's parser is a sequential state machine**. Line N's
parse state is the output of line N-1, so there is no way to start cold in the middle of a
file. Highlighting the deepest displayed line means parsing every line above it.

That single fact produces the cost curve everything else here exists to manage.

## Measured costs

All numbers from `src-tauri/benches/bench_commands.rs`, `diff_ts_large_file` group, on a
3,002-line TypeScript file whose only change is one line. Measured 2026-08-22 with the load
average under 3. Benchmarks on this path are load-sensitive, so check `uptime` reads below 4
before trusting a run.

| Case | Time | What it is |
|---|---|---|
| `early_change` | 1.3563 ms | The changed line sits near the top, so the parse stops early |
| `late_change` | 130.42 ms | The same one-line change near the bottom, so the parse walks the whole file |
| `cache_hit` | 837.15 µs | Either of the above, served from the token cache |

**A late change costs 96 times an early one** when it has to be parsed. This is not a function
of diff size. The diff is identical in both cases. It is a function of how deep the change
sits, which is why the cache below is the fix rather than any amount of tuning.

### Where the time goes inside one parse

Measured separately on the same fixture, splitting a cold highlight into its halves:

| Case | Time |
|---|---|
| `ParseState::parse_line` + `ScopeStack::apply` only | 60.086 ms |
| syntect's full `HighlightLines` | 62.086 ms |
| Our shipped path, including `SyntaxToken` building | 62.677 ms |

**Parsing is 96% of the cost. Theme matching and token building together are 4.1%.** If you
are looking for a win, it is in avoiding parses, not in making the work downstream of them
cheaper. See the rejected optimisation below, which learned this the expensive way.

## The guards

Three bounds keep pathological input off this path. Removing any of them needs a measurement,
not an argument.

**A 5,000-line cap.** `MAX_SYNTAX_HIGHLIGHT_LINE` in `commands/diff.rs` returns an empty
result before the cache is consulted when the deepest needed line exceeds it. Files with
changes below line 5,000 are served without highlighting rather than slowly.

**The Markdown grammar is refused outright.** syntect's Markdown grammar catastrophically
backtracks on lines mixing bold and inline code, up to about 250 ms for a single line.
`syntax.rs` refuses to build a highlighter for it at all, by extension and by fenced-block
language token. The extension list is syntect's own, deliberately not the frontend's
rendered-view set.

**Word-level spans skip large blocks.** `compute_word_spans_for_hunk` gives up on blocks over
40 paired lines.

## The token cache

`SyntaxTokenCache` holds per-line tokens keyed by `(content OID, extension)`.

**It needs no invalidation, and must never grow any.** A git OID is content identity, so a hit
is correct by construction. This holds for the working-tree side too, which carries a
content-addressed OID like any other. There is no mtime check, no staleness check, and no
generation counter anywhere in this cache. Adding one would mean someone misunderstood why it
is safe.

The cache is bounded by a byte budget, 64 MB by default, and evicts the coldest entry when the
budget is exceeded. Because the 5,000-line cap sits in front of it, no single entry can be
unbounded.

**One known inefficiency, deliberate.** An entry parsed less deep than a later request needs is
replaced by a fresh parse from line 1. syntect's `ParseState` implements `Clone`, and syntect's
own documentation describes caching it every thousand lines or so to resume a parse from the
nearest checkpoint instead of restarting. We do not do this. It would remove the re-parse when
an entry has to grow deeper, and it cannot make a first parse cheaper. Nobody has measured
whether entries actually grow often enough to be worth it.

## Warming

Selecting a commit walks its file list and calls `warm_diff` once per file, one at a time,
fired and not awaited so it never blocks selection. `warm_diff` runs the identical
`diff_commit_file_inner` function that `diff_commit_file` runs and throws the result away, so
warming can never drift from the real diff path. It stops when the selection moves and skips
files that would push it past a 2 MB budget, skipping rather than stopping so one huge file
does not starve the rest.

A module-level promise chain in `RepoView.svelte` serialises warm loops across selections. The
generation counter alone is not enough: it stops a stale loop at its next iteration, but not
the call already in flight, and not a new commit's loop racing to start beside it. Both were
measured happening, with two commits parsing the same file at once while the user waited on a
third.

## Rejected: skipping the theme layer for undisplayed prefix lines

Parsing to reach line 3,000 means running theme matching on 3,000 lines when the diff might
display forty of them. Skipping the theme layer for the lines nobody sees looks like an obvious
win, and the plan of record estimated it at about a quarter of every cold parse.

**Measured, it is 4.1%**, and that is a ceiling the change could not reach, since it saves only
on the prefix. It was rejected in favour of leaving `easy::HighlightLines` alone, on a code
path whose last three defects were all state-handling bugs. Do not re-propose it without a
measurement that contradicts the table above.

## What this pipeline is not responsible for

The backend is fast and bounded. When a large file feels slow to open, measure before assuming
this is why. Cached fetches of a 3,201-line file were measured at 15-17 ms while the app still
felt sluggish, and the cause was the frontend rendering every line of the file with no
virtualisation. That is tracked separately. Per-row CSS `content-visibility: auto` was tried
against it and made scrolling materially worse, because per-row containment moves style, layout
and paint onto the scroll thread thousands of times.
