# The review CLI

`trunk review` is the agent's way into a code review. It is a subcommand of the
app binary itself, and it reads and writes the same store the GUI uses, fully
offline. The running app reflects CLI writes within about a second, no restart.

The published review document teaches agents everything below automatically:
its header names the absolute binary path and every verb. This page is the
human-facing reference.

## Invocation

The Homebrew cask links the app's executable onto your `PATH`, so the bare name
works:

```bash
trunk review list
```

That symlink points at the app's own executable, which is also the way in
without the cask:

```bash
/Applications/Trunk.app/Contents/MacOS/trunk review list
```

A dev build (`just dev`) compiles the dev identifier into
`src-tauri/target/debug/trunk`, which therefore reads the dev store, never
your real one. `TRUNK_DATA_DIR` overrides the store location in both the app
and the CLI; it exists for tests.

`trunk --help`, `-h`, `help`, `--version` and `-V` answer directly, without
opening the app: the binary is one CLI parsed by `clap`, and only `review` and
those help/version words are the CLI's own — any other argument (a bare
`trunk`, or the file paths a bundled app is handed to open) starts the GUI.
`trunk review <verb> --help` prints that verb's own positionals and flags.

## Verbs

```
trunk review list [--repo <path>]
trunk review show <review-id> [--repo <path>]
trunk review threads <review-id> [--state <state>] [--json] [--repo <path>]
trunk review thread <thread-id> [--json] [--repo <path>]
trunk review reply <thread-id> <text> | --stdin [--repo <path>]
trunk review address <thread-id> [--repo <path>]
trunk review watch [--repo <path>]
```

- **list** — the repository's published reviews: id, state
  (`ready`/`settled`), title, thread count.
- **show** — one review in full, as the same markdown document the app's
  Copy-as-markdown produces: threads, states, excerpts, replies. A thread whose
  heading ends `(stale)` was written against code the repository has moved past:
  a comment on uncommitted work the user has since edited. Its excerpt is what
  the code looked like when the comment was written, so the comment is still
  answerable; what changed is that the file no longer reads that way.
- **threads** — the review's threads as an index, one line each: id, state,
  location (`file:start-end`, a commit-level thread's short oid, or `no
  target`), and the comment's first line. `--state` keeps only threads in that
  state. This plain line is for human reading only: its ` — ` separator is not
  reserved, so a file path or comment whose first line contains it prints more
  fields than the format implies, and splitting on the separator can misread
  the location. The path is a tree entry name from the commits under review,
  so its content is whoever wrote the commit's, the same provenance as the
  excerpt below. A newline in a path cannot forge a second index line, since
  both the location and the summary pass through a sanitizer; only
  within-line field-splitting is affected. `--json` is the sole parseable
  form: it carries the anchor as a structured object (`file_path`,
  `start_line`, `end_line`), so a separator inside a path is unambiguous
  there.
- **thread** — one thread in full: the document's own section for it (anchor
  coordinates, stored excerpt, root comment, replies with their channel),
  then a `--- end of comment ---` rule, then its review id, its state, and
  what the agent channel may do from there. This is the route in when you
  hold a thread id from a `watch --json` event or a review document, without
  dumping the whole review. Comment, reply and excerpt bodies are reproduced
  as written and may contain any of those words, including a copy of the rule
  itself: the excerpt is the reviewed code, so its content is whoever wrote
  the commit's. The real rule is therefore the one whose `#` run is the
  longest of any line-opening run in the output, and it is always at least
  five. Split there, not at the first rule you meet.
- **reply** — post to a thread. `--stdin` reads the body from stdin for
  multi-line text. CLI writes are attributed as **agent**, whoever drove them.
- **address** — claim an `open` thread as `addressed` after acting on it. This
  is the only state the CLI can set: `done`, `dismissed`, and reopening are
  the human's, in the app, so an agent can never settle a review.
- **watch** — block and stream changes to the repo's published reviews. After
  a `# watching …` readiness line, output arrives as changes land —
  event-driven, no polling: every Trunk process that writes the store rings
  the watcher over a local socket. macOS/Linux only for now. Composing
  reviews and draft typing never produce output. Plain mode prints the
  changed review's id, one per line (format unstable). `--json` prints one
  self-contained NDJSON event per change, so a harness never refetches or
  rediffs.

### `--json` on `threads` and `thread`

Both reuse `watch`'s field names, so one reader parses every stream. `threads`
prints one object per line — `review`, `thread`, `state`, `stale`, `text`, and
`anchor` or `commit_oid`. `thread` prints a single object with those fields
plus `channel`, `excerpt`, `replies` (each `reply`, `channel`, `text`), and
`allowed_transitions`: the states the agent channel may move this thread to,
taken from the same matrix the writes enforce, never restated.

### `watch --json` events

One JSON object per line, discriminated by `event`. Evolution is additive:
new fields and event kinds may appear; existing ones keep their meaning.

| `event` | carries |
|---------|---------|
| `review_published` | `review`, `title`, `state` — followed by `thread_added`/`reply_added` for its full content |
| `review_retitled` | `review`, `title` |
| `review_state_changed` | `review`, `from`, `to` (`ready`/`settled`) |
| `review_deleted` | `review` |
| `thread_added` | `review`, `thread`, `state`, `text`, and `anchor` (`file_path`, `start_line`, `end_line`, `commit_oid`, `source`, `side`) or `commit_oid` for a commit-level note |
| `thread_edited` | `review`, `thread`, `text` |
| `thread_state_changed` | `review`, `thread`, `from`, `to` |
| `thread_stale_changed` | `review`, `thread`, `stale` |
| `reply_added` | `review`, `thread`, `reply`, `channel` (`human`/`agent`), `text` |
| `reply_edited` | `review`, `thread`, `reply`, `text` |

Post-publish permanence means nothing below a review ever disappears; the
only removal event is `review_deleted`.

The repository is discovered from the working directory (any subdirectory
works) or named with `--repo`; symlinked paths resolve to the same reviews the
app sees.

Ids accept any unambiguous prefix, case-insensitively, with Crockford
normalization (`O`→`0`, `I`/`L`→`1`).

## Error contract

Output is markdown on stdout. Errors go to stderr with a nonzero exit and no
partial write: usage mistakes exit 2, help and `--version` exit 0, everything
else exits 1. A mistyped verb is refused naming the closest real one when one
is close enough to suggest. `--json` on a verb with no JSON form (`list`,
`show`, `reply`, `address`) is a usage error, not accepted and ignored. An
illegal state claim fails naming the thread's current state and changes
nothing. A target inside an unpublished (composing) review answers exactly as
a missing id does — an unpublished review's existence never leaks through the
CLI, not even through an ambiguous prefix.

## Concurrency and versions

Any number of CLI processes and the app may write at once; contention queues
(SQLite `busy_timeout`) rather than failing or corrupting. A store written by
a newer Trunk than the one answering is refused untouched, with an error that
says to restart; the app's poll stops on such a store rather than retrying.
