# How established clients render large-file diffs

A survey of how mature editors, desktop git clients and web forges keep syntax highlighting
and diff rendering fast on very large files, run 2026-08-21 by five parallel researchers split
by client class. Written up as reference material, not as a plan.

## 1. What this is

Read it before designing anything in trunk's diff rendering path. For trunk's own measured
cost model, see [../architecture/diff-highlighting.md](../architecture/diff-highlighting.md).

Claims re-verified against primary sources are marked **[verified]**. The corrections made to
the researchers' own citations are in §6, and §4 records what trunk actually did with each
finding, including one that was tried and failed.

## 2. The source-quality gate

The bar, set before any searching: at least ~2 years old, with real production standing, because the
market now contains many git clients vibe-coded in about a month. Every researcher applied
it before recording technique. Nothing was dropped for age -- the youngest qualifying target
is Zed at 3-4 years, and the oldest is IntelliJ IDEA at 25. Bitbucket cleared the age gate
but published nothing about frontend rendering, so it contributes hard limits only.

## 3. The findings

### 3.1 Our closest analogue already solved this, and it is a staging surface

GitHub Desktop is Electron + React, and its diff view stages individual lines and hunks --
the same constraint `docs/decisions/2026-06-20-pierre-diffs.md` places on trunk. So none of
its techniques are read-only-only. It does three things we do not:

- **Row-level virtualization via `react-virtualized`**, over a flat row array built from all
  hunks (`app/src/ui/diff/side-by-side-diff.tsx`), with a row-height cache because rows wrap.
- **Highlighting scoped to lines that appear in diff hunks**, never the whole file
  (`getLineFilters()` in `app/src/ui/diff/syntax-highlighting/index.ts`). **[verified]**
- **Virtualization decoupled from highlighting**: rows render as plain text immediately and
  get colored when the worker resolves. Scrolling and staging clicks never wait on
  highlighting, because staging needs line identity, not color.

Its thresholds, all **[verified]** in `app/src/lib/git/diff.ts` at `development`:

    const MaxDiffBufferSize = 70e6
    const MaxReasonableDiffSize = MaxDiffBufferSize / 16
    const MaxCharactersPerLine = 5000

Crossing the soft ceiling gates *whether* to render behind a "Show Diff" button; clicking it
renders through the identical highlighted, virtualized path. The threshold decides whether,
not what with. Highlighting carries its own independent cap,
`MaxHighlightContentLength = 1024 * 1024`.

### 3.2 Two of the three big forges concluded row virtualization was the wrong trade

- **GitLab shipped JS virtual scrolling for MR diffs, then walked it back.** Rapid Diffs
  replaces it with server-rendered HTML plus `content-visibility: auto`: "Off-screen diff
  files should not cost layout or paint. `content-visibility: auto` with a server-provided
  row count reserves space without rendering files the user has not scrolled to."
  **[verified]** The DOM nodes still exist and stay addressable; the browser just skips
  layout and paint. Per-user interactive content is mounted client-side onto the
  server-rendered row after mount. The retreat was driven by the old virtual scroller being
  complex and bug-prone with accessibility gaps, plus Safari scroll-performance bugs
  (gitlab-org/gitlab#442772).
**CAVEAT, learned the hard way: this finding is about whole files, not rows.** GitLab applies
`content-visibility: auto` per diff *file* in a multi-file diff, to skip files the user has not
scrolled to. That is tens of containment boundaries. Applying it per *row* within one large
file creates thousands, each owing style, layout and paint at the moment it scrolls into view,
on the scroll thread, and it is far worse than doing nothing. A fixed `contain-intrinsic-size`
also mis-sizes wrapped rows, so each corrects its height on first render and shoves everything
below it. Trunk tried the per-row version and reverted it (§4 item 2).

- **Gerrit never virtualized at all.** It chunks the DOM *build* instead
  (`gr-diff-processor.ts`, `asyncThreshold` fed from the `num_lines_rendered_at_once` render
  preference), yielding between batches, but every row stays in the DOM permanently. Gerrit's
  diff is already heavily interactive per-row, and full-DOM-with-chunked-build is what kept
  that working.
- **GitHub did virtualize**, with TanStack Virtual, and documents the cost in its own
  changelog: in-browser find-in-page and select-all no longer see the whole diff. Its
  per-line interactive state is a comment thread anchored by a computed index, which
  reattaches on remount -- cheaper to re-anchor than staging state would be.

The pattern across all three: the more interactive the row, the less willing they are to
unmount it.

### 3.3 A viewport-clip paint range is the native-app version of the same idea

JetBrains computes the paint range straight from the AWT clip rectangle every paint call
(`EditorPainter.java`: `myClip = myGraphics.getClipBounds()`, then
`yToVisualLine(myClip.y)` .. `yToVisualLine(myClip.y + myClip.height - 1)`), and the diff
viewer inherits it by rendering both sides through the same editor component. No separate
virtualization layer exists; it falls out of the shared painter.

### 3.4 syntect can resume a parse from a checkpoint, and we are not using it

This is the finding that touches trunk's parse cost rather than its render layer.

`ParseState` implements `Clone`, and syntect's own docs say you can cache it "(probably along
with a `HighlightState`) and only re-start parsing from the point of a change", and
"You could also do something fancy like only highlight a bit past the end of a user's screen
and resume highlighting when they scroll down on large files." **[verified]** The README
frames the concrete strategy: "on the initial parse every 1000 lines or so copy the parse
state into a side-buffer for that line." **[verified]**

Against our code: `SyntaxTokenCache::tokens_for` in `src-tauri/src/git/token_cache.rs` parses
`text.split('\n')` from index 0 up to `max_line`, and its own doc comment records that "An
entry parsed less deep than `max_line` is replaced by a fresh parse from line 1". So a
shallow entry that later needs to go deeper pays the whole file again. Checkpointing
`ParseState`/`HighlightState` every N lines during that one pass would let the deeper request
resume from the nearest checkpoint.

Note what this does and does not buy. It cannot make the *first* parse of a new blob cheaper:
syntect's state machine is sequential, line N depends on line N-1, and there is no API to
start cold in the middle of a file. It buys the *extension* of an existing parse, which is
exactly the case our cache currently throws away.

### 3.5 Nobody degrades gracefully; they all fall off a cliff on purpose

Every qualifying target picks a hard threshold and drops to something cheap, rather than
trying to stay partly fast:

| Target | Threshold | Degrades to |
|---|---|---|
| VS Code | 20 MB / 300K lines **[verified]** | No tokenization at all, decided in the model constructor and never revisited |
| JetBrains | 2500 KB (`idea.max.intellisense.filesize`) | `PlainTextLanguage.INSTANCE` -- drops out of language-aware highlighting entirely |
| GitHub Desktop | ~4.375 MB, or any line over 5000 chars **[verified]** | Ask before rendering; render identically after |
| GitHub | 20,000 lines / 500 KB per file; 400 lines auto-loaded | "Load Diff" click |
| GitLab | `diff_max_patch_bytes` 200 KB default | Collapse at 10%, hard cutoff at the limit |
| Tower | 20 KB, user-configurable | Prompt before displaying |
| delta | `--max-syntax-highlighting-length` 400 chars/line | Line renders unhighlighted |
| difftastic | 1 MB, or 3M graph vertices | Plain line diff, no structural diffing |
| Ours today | `MAX_SYNTAX_HIGHLIGHT_LINE` 5,000 lines | Early return before the cache |

Two second-order lessons in that table. difftastic's second, independent graph-vertex cap
exists because a line-count cap alone does not bound pathological cost -- worth checking
whether our 5,000-line cap bounds worst-case syntect backtracking or only file length.
And SmartGit's users report the failure mode of getting this wrong: a gate that suppresses
*rendering* while the expensive computation still runs buys nothing. The gate has to sit
before the computation.

### 3.6 Cancellation: everyone cancels, most of them crudely

- JetBrains cancels the in-flight diff before starting the next (`DiffTaskQueue.abort()`
  calls `myProgressIndicator.cancel()` at the top of `executeAndTryWait`), and blocks briefly
  before falling back to an async path so fast diffs never flash a spinner.
- Gerrit's worker highlighter keeps the in-flight promise and calls `.cancel()` when a new
  pass supersedes it (`gr-syntax-layer-worker.ts`).
- GitHub Desktop does not cancel at all: it snapshots the parameters, and discards the result
  if the user moved on (`highlightParametersEqual`), plus an unconditional 5s
  `terminate()` on any worker that does not answer.
- Monaco puts a hard number on it: `maxComputationTime`, default 5000 ms, documented as
  "Timeout in milliseconds after which diff computation is cancelled."

Trunk has the cancel-before-start shape, in `RepoView.svelte`'s `warmChain`: a new commit's
warm loop cannot start until the previous one, in-flight call included, has settled.

## 4. What trunk did with each finding

Recorded so the survey is not read as a to-do list. Two of these are settled by measurement or
experiment, and re-proposing them needs evidence that contradicts what is here.

1. **Virtualize the diff views.** Still the answer to the freeze, and still unbuilt. Tracked
   separately. `src/components/VirtualList.svelte` exists and is proven in
   `CommitGraph.svelte`, so there is an in-repo starting point.
2. **Per-row `content-visibility: auto`. TRIED AND REJECTED. Do not retry it.** Applied to
   every diff row and measured live against a 3,201-line file, it was markedly worse than the
   unvirtualized baseline: the file visibly assembled itself during scroll. Two independent
   reasons, both covered in the caveat in §3.2. This came from misreading GitLab's finding as
   being about rows when it is about whole files in a multi-file diff.
3. **Scope highlighting to lines appearing in hunks**, as GitHub Desktop's `getLineFilters`
   does. **Measured and declined for trunk.** The saving it targets, theme matching and token
   building, is 4.1% of a cold highlight here, against a plan-of-record estimate of about a
   quarter. Parsing is 96%, and a sequential parser has to reach the deepest displayed line
   regardless. GitHub Desktop's version pays off because its highlighter is a different engine
   with different economics, not because the idea fails in general.
4. **Checkpoint `ParseState` every N lines in the token cache** so growing a shallow entry
   resumes instead of re-parsing from line 1 (§3.4). **Still open, unbuilt, unmeasured.** The
   open question is whether cache entries grow deeper often enough to pay for it.
5. **Move a size gate before the computation rather than before the paint**, and consider a
   second cap bounding pathological grammar cost rather than length (§3.5). **Still open.**
   Trunk's 5,000-line cap does sit before the cache, but nothing bounds worst-case backtracking
   independently of length.

## 5. Read-only dependencies, called out

Which borrowed techniques survive trunk's staging surface, where every row carries per-line
and per-hunk staging state. Explicitly:

- **Survives:** everything in GitHub Desktop §3.1 -- it is itself a staging surface.
- **Survives:** GitLab's `content-visibility: auto`, Gerrit's chunked build, JetBrains'
  clip-rect paint range. None of the three removes a row from the DOM or the component tree.
- **Depends on read-only-ness:** GitHub's aggressive row virtualization. Its per-row state is
  a comment anchor reattached by index on remount; staging state per line is heavier, and
  GitHub's own changelog documents that find-in-page and select-all break under it.

## 6. Corrections made to the researchers' citations

Recorded because the underlying claims survive but their sources did not. Each was caught by
re-checking the researcher's citation against the primary source.

- The "GitLab called its virtual scroller complex and bug-prone" claim was attributed to the
  Rapid Diffs dev docs, which do not mention virtual scrolling at all. The claim holds from
  the Reusable Rapid Diffs handbook design document and gitlab-org/gitlab#442772.
- syntect's "reduce highlighting time asymptotically to the length of the viewport" is not in
  syntect's docs. The viewport/resume-on-scroll sentence is real and is on `HighlightState`;
  the asymptotic framing was the researcher's.
- The "Sublime caches parse state every ~1000 lines" story is syntect's README describing a
  strategy "that text editors can use", not a description of Sublime's internals. Two
  researchers reached this independently; the second caught it. Treat Sublime's incremental
  highlighting as unestablished.

## 7. Could not establish

- Zed's numeric threshold for disabling highlighting on large files, and whether its
  highlighting is viewport-scoped at all (only incremental-by-edit is confirmed).
- Whether VS Code's diff editor virtualizes unchanged regions separately from line-level
  virtualization.
- Fork, Tower, GitKraken and SmartGit publish essentially nothing about rendering internals.
  Their only transferable contribution is the ask-before-render threshold pattern.
- Sublime Merge: no documented size threshold exists (still an open feature request), and
  users report lockups on an 80,000-line diff. Its GPU glyph-batching work is real and
  first-party but is renderer-wide, not diff-specific.
- Whether tree-sitter is a realistic swap for syntect here. Its headline incremental-parse
  win needs an `InputEdit` byte range, which a diff does not have -- the "edit" is a whole new
  file version. difftastic, which uses tree-sitter, fully re-parses both sides.
