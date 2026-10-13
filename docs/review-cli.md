# The review CLI

`trunk review` is the agent's way into a code review. It is a subcommand of the
app binary itself, and it reads and writes the same store the GUI uses, fully
offline. The running app reflects CLI writes within about a second, no restart.

The review document teaches agents everything below automatically:
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
trunk review address <thread-id> [--commit <rev>] [--repo <path>]
trunk review watch [--repo <path>]
```

- **list**: the repository's reviews visible to the agent: id, state
  (`open`/`stale`/`settled`, derived from the threads' stale markers as the app
  last computed them), title, and the number of threads it was sent. A
  review is visible once it holds a sent thread and until the user archives it.
- **show** — one review in full, as the same markdown document the app's
  Copy-as-markdown produces while its panel shows every thread: threads, states,
  excerpts, replies. The app's Copy holds only the threads its filter shows. A thread whose
  heading ends `(stale)` was written against code the repository had moved past
  when the app last computed the marker.
  Three shapes reach that state. A comment on uncommitted work is stale once the
  user has edited that work again. A comment on a tracked file's current content
  is stale once the lines it pinned occur nowhere in that file, which a rename or
  a deletion reaches the same way an edit does; it clears again on the app's
  next full recompute after the content returns, after a branch switch for
  instance. Deleting one of two
  byte-identical copies of the pinned lines raises no marker, because the comment
  still describes text the file holds. And a comment whose anchor commit is no
  longer in the repository, collected by a `git gc` that reached it, is stale
  whatever kind of commit it was: the excerpt is the only surviving copy of that
  code, so nothing can be compared against it. In every case the excerpt is what
  the code looked like when the comment was written, so the comment is still
  answerable; what changed is that the repository no longer holds that code
  where the comment pointed. For the first two shapes that means the file reads
  differently; for a collected anchor the file may be untouched and the commit
  simply gone. One older shape raises the marker by accident: a comment left
  before the review store's version 9 upgrade on a commit that claims the author
  Trunk's snapshots carry reads as a comment on a superseded snapshot, so it is
  stale although the code it names has not moved.
  The marker is the app's last computation, and the CLI never recomputes it:
  [How current the stale marker is](#how-current-the-stale-marker-is) says when
  it moves.
- **threads** — the review's threads as an index, one line each: id, state, the
  `(stale)` marker where the thread carries one, location (`file:start-end`,
  `file (whole file)` for a comment about the whole file, a commit-level
  thread's short oid, or `no target`), and the comment's first
  line. The marker means what it means under **show**, and it is on this line
  because the location beside it is where the code no longer was at the app's
  last recompute. `--state` keeps
  only threads in that state. This plain line is for human reading only: its ` — ` separator is not
  reserved, so a file path or comment whose first line contains it prints more
  fields than the format implies, and splitting on the separator can misread
  the location. An anchor's path is a tree entry name from the commits under
  review, so its content is whoever wrote the commit's. A current-file
  comment's path is an index entry and its text was read from the working
  tree, so its content is whoever last wrote that file. Either way it has the
  same provenance as the excerpt below. A newline in a path cannot forge a
  second index line, since both the location and the summary pass through a
  sanitizer; only within-line field-splitting is affected. `--json` is the
  sole parseable form: it carries a file location as a structured object,
  `anchor` or `content_pin`, each with `file_path`, `start_line` and
  `end_line`, so a separator inside a path is unambiguous there.
- **thread** — one thread in full: the document's own section for it (its
  location, stored excerpt, root comment, replies with their channel),
  then a `--- end of comment ---` rule, then its review id, its state, and
  what the agent channel may do from there. This is the route in when you
  hold a thread id from a `watch --json` event or a review document, without
  dumping the whole review. Comment, reply and excerpt bodies are reproduced
  as written and may contain any of those words, including a copy of the rule
  itself: the excerpt is the reviewed code, so its content is whoever wrote
  the commit's, or for a current-file comment whoever last wrote the
  working-tree file. The real rule is therefore the one whose `#` run is the
  longest of any line-opening run in the output, and it is always at least
  five. Split there, not at the first rule you meet.
- **reply** — post to a thread. `--stdin` reads the body from stdin for
  multi-line text. CLI writes are attributed as **agent**, whoever drove them.
- **address** — claim an `open` thread as `addressed` after acting on it. This
  is the only state the CLI can set: `done`, `dismissed`, and reopening are
  the human's, in the app, so an agent can never settle a review.
  `--commit <rev>` names the commit that fixes it. Any revision git understands
  works, and the full oid is kept, so the card reads "Agent marked addressed in
  a3f9c21". A revision the repository lacks fails and writes nothing.
- **watch**: block and stream changes to the repo's visible reviews. After
  a `# watching …` readiness line, output arrives as changes land —
  event-driven, no polling: every Trunk process that writes the store rings
  the watcher over a local socket, except for the narrower stale pass under
  [How current the stale marker is](#how-current-the-stale-marker-is).
  macOS/Linux only for now. Held comments,
  reviews with nothing sent, archived reviews and draft typing never produce
  output. Plain mode prints the
  changed review's id, one per line (format unstable). `--json` prints one
  self-contained NDJSON event per change, so a harness never refetches or
  rediffs.

### How current the stale marker is

The `(stale)` marker and the `stale` field are the app's last computation,
stored for the CLI to print, and a review's `stale` state is derived from them
when it is read. No verb recomputes them.

The app runs a full recompute when it first shows a repository's tab, and after
that on every change to the repository's working tree or checkout until the tab
closes, whether or not the tab is on screen. Other ref changes, a fetch for
instance, run a narrower pass over comments on commits that are not Trunk's
snapshots, and only while the tab is on screen: a ref change in a background
tab waits until the user selects it. The narrower pass does not ring `watch`.
Its marker changes show in `list`, `show` and `threads` at once, but `watch`
reports them only after some later write to the store rings it.

Three things the app does not see leave the marker describing code as it stood
before them: an edit made while Trunk is not running, an edit to a repository
that has no tab or whose restored tab nobody has selected since launch, and a
commit collected from the object store with no other change, as a `git gc` can
do. The next full recompute for that repository catches each. A recompute that
fails, for instance during a repack, leaves every marker as it stood.

### `--json` on `threads` and `thread`

Both reuse `watch`'s field names, so one reader parses every stream. `threads`
prints one object per line — `review`, `thread`, `state`, `stale`, `text`, and
at most one of `anchor`, `commit_oid` and `content_pin`, and `whole_file` when
the comment is about the whole file, as `watch` sends them on `thread_added`.
`thread` prints a single object with those fields plus
`channel`, `excerpt`, `replies` (each `reply`, `channel`, `text`), and
`allowed_transitions`: the states the agent channel may move this thread to,
taken from the same matrix the writes enforce, never restated.

### `watch --json` events

One JSON object per line, discriminated by `event`. Evolution is additive:
new fields and event kinds may appear; existing ones keep their meaning.
The one exception came when comments began reaching the agent the moment they
are sent: `review_added` replaced `review_published`, and a review's state
became `open`, `stale` or `settled` where it had been `composing`, `ready` or
`settled`. A harness written against the old names has to move to the new ones.

| `event` | carries |
|---------|---------|
| `review_added` | `review`, `title`, `state`, sent when a review becomes visible through its first sent thread, and followed by `thread_added`/`reply_added` for its full content |
| `review_retitled` | `review`, `title` |
| `review_state_changed` | `review`, `from`, `to` (`open`/`stale`/`settled`). A review is `stale` when every thread still waiting on someone points at code that is gone, as the app last computed it ([How current the stale marker is](#how-current-the-stale-marker-is)) |
| `review_deleted` | `review`, sent when the user deletes the review or the last thread the agent was sent |
| `review_archived` | `review`, sent when the user puts a review away. Its ids stop resolving, and unarchiving it sends `review_added` with its full content again |
| `thread_added` | `review`, `thread`, `state`, `text`, and its location: `anchor` (`file_path`, `start_line`, `end_line`, `commit_oid`, `source`, `side`), `commit_oid` for a commit-level note, or `content_pin` (`file_path`, `start_line`, `end_line`, `block`, `ordinal`) for a comment on a file's current content. A pin's lines are where the block stood when the comment was written, `block` is the text it pinned, read from the working tree and as untrusted as any excerpt, and `ordinal` is which occurrence of a repeated block was picked, counting from 0. `whole_file: true` marks a comment about the whole file rather than the lines its location spans, which then span the file, and its `content_pin` leaves out `block` and `ordinal`, since the block would be the whole file. A target-less thread carries none of the three, and a key that does not apply is absent, never null |
| `thread_edited` | `review`, `thread`, `text` |
| `thread_state_changed` | `review`, `thread`, `from`, `to` |
| `thread_stale_changed` | `review`, `thread`, `stale`, sent when the stored marker changes, and for a change from the app's narrower ref pass only once a later write rings `watch` ([How current the stale marker is](#how-current-the-stale-marker-is)) |
| `reply_added` | `review`, `thread`, `reply`, `channel` (`human`/`agent`), `text` |
| `reply_edited` | `review`, `thread`, `reply`, `text` |
| `thread_deleted` | `review`, `thread`, sent when the user removes a thread with its replies |
| `reply_deleted` | `review`, `thread`, `reply` |

The user can delete a thread or a reply at any time, so an id read earlier can
stop resolving. A thread's deletion carries no `reply_deleted` for its replies.

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
nothing. A held comment, a review with nothing sent, and anything inside an
archived review answer exactly as a missing id does, so such a review's existence never leaks through
the CLI, not even through an ambiguous prefix.

## Concurrency and versions

Any number of CLI processes and the app may write at once; contention queues
(SQLite `busy_timeout`) rather than failing or corrupting. A store written by
a newer Trunk than the one answering is refused untouched, with an error that
says to restart; the app's poll stops on such a store rather than retrying.
