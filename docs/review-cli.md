# The review CLI

`trunk review` is the agent's way into a code review. It is a subcommand of the
app binary itself — nothing extra ships or installs — and it reads and writes
the same store the GUI uses, fully offline. The running app reflects CLI writes
within about a second, no restart.

The published review document teaches agents everything below automatically:
its header names the absolute binary path and the four verbs. This page is the
human-facing reference.

## Invocation

The binary is the installed app's executable:

```bash
/Applications/trunk.app/Contents/MacOS/trunk review list
```

A dev build (`just dev`) compiles the dev identifier into
`src-tauri/target/debug/trunk`, which therefore reads the dev store, never
your real one. `TRUNK_DATA_DIR` overrides the store location in both the app
and the CLI; it exists for tests.

## Verbs

```
trunk review list [--repo <path>]
trunk review show <review-id> [--repo <path>]
trunk review reply <thread-id> <text> | --stdin [--repo <path>]
trunk review address <thread-id> [--repo <path>]
trunk review watch [--repo <path>]
```

- **list** — the repository's published reviews: id, state
  (`ready`/`settled`), title, thread count.
- **show** — one review in full, as the same markdown document the app's
  Copy-as-markdown produces: threads, states, excerpts, replies.
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
partial write: usage mistakes exit 2, everything else exits 1. An illegal
state claim fails naming the thread's current state and changes nothing. A
target inside an unpublished (composing) review answers exactly as a missing
id does — an unpublished review's existence never leaks through the CLI, not
even through an ambiguous prefix.

## Concurrency and versions

Any number of CLI processes and the app may write at once; contention queues
(SQLite `busy_timeout`) rather than failing or corrupting. A store written by
a newer Trunk than the one answering is refused untouched, with an error that
says to restart; the app's poll stops on such a store rather than retrying.
