# Trunk — Project Glossary

The project's domain terms, in the words João uses for them: one vocabulary across
conversation, code, tests, cards and docs. Read it when you start; add a term when you
learn one. A definition a card's acceptance criteria depend on is also inlined on the
card; this file is the shared reference, not hidden required context.

## Commit graph

**Lane** — a vertical swimlane in the graph column, identified by an integer column index
(0 = leftmost). One lane holds at most one chain at any given row.

**HEAD lane** — the lane holding the checked-out commit. Trunk reserves column 0 for it.

**Lane claim** — a commit taking a free column, which happens exactly once per lane and only
at a tip. Every commit below inherits the column until the lane ends and the column is freed
for reuse.

**Lane owner** — the ref on the commit that claimed the lane. It is what the ghost pill names,
and it is not the nearest ref above: a column reused by a later branch, or a tag pointing
inside someone else's lane, are both nearer without owning anything. A lane claimed by a tag
is owned by that tag, which is how a line whose branch was deleted keeps a name.

**Linear continuation** — a commit chain connected to a given commit by unbroken first-parent
links, with no intervening fork. A branch that is strictly ahead of another on the same line
is a linear continuation of it; a diverged branch is not.

**Tracking pair** — a local branch and the remote-tracking ref named by its
`branch.<name>.merge` upstream configuration, e.g. `main` and `origin/main`. A remote-tracking
ref that is not that branch's configured upstream is not its tracking pair, however similar
the name.

**Hidden ref** — a ref the user has switched off in the sidebar. It leaves the graph the way GitKraken hides it: its pill goes, and so does every commit reachable only through hidden refs, so the remaining history is laid out and coloured as if the ref did not exist. The repository is untouched. HEAD's own branch cannot be hidden, because column 0, the WIP row and the head-lane extension assume it is in the walk (João, 2026-09-02).

**Ref visibility** — the per-repository set of hidden refs, kept in the preferences file and restored when the repository opens. Every hidden ref is named in it individually. The sidebar's section and remote toggles are bulk actions that write each row they cover, not rules of their own, so the eye on a row always shows that row's own state and a group icon can never contradict the rows beneath it. Holding group state separately was tried first and reverted: it let a row be hidden by a rule its own eye did not show, and showing a group resurrected rows the user had hidden individually (João, 2026-09-02).

**Solo** — GitKraken's inverse of hide: show only the soloed refs. Not built; a follow-up card if wanted.

**Auto-fit** — a commit-graph column sizing itself to the widest content it has seen, rather than to a fixed width. The author column is the only one whose target depends on the commits on screen; the date column sizes for the widest label the relative clock can ever produce and the sha column for a seven-character sha, so neither moves as pages load. Auto-fit keeps a running maximum across loaded pages, so scrolling into a wider author widens the column and scrolling on never narrows it. Narrowing is correct only when the commits themselves changed, as a visibility toggle can do by hiding the widest author's commit. A column the user has dragged is exempt from auto-fit (TRUNK-133).

**Graph snapshot** — what the commit cache holds for one repository: the capture a walk read from it, the ref visibility that walk was laid out under, and the resulting layout. A visibility toggle re-lays out the cached capture and never opens the repository, and the visibility travels with the layout it produced, so the cache cannot serve a layout built under a different hidden set (TRUNK-129, TRUNK-120).

**Page** — one fixed-size slice of the laid-out graph the frontend fetches at a time,
200 rows. Both sides hold that size independently, the backend in `history.rs` and `BATCH`
in `CommitGraph.svelte`, which reads a short response as the end of history. A page is a slice
of the layout as it stands when the request is answered, so it is only meaningful against
the layout that produced it.

**Stale page** — a page that lands after the graph was rebuilt underneath it, describing a
layout that no longer exists. It is dropped rather than appended, because its rows were laid
out under the old graph while the paging offset now indexes the new one (TRUNK-135). A drop
is silent: it sets no error, and the caller sees only that the list did not grow.

**Non-progressing attempt** — a page request that returned without growing the loaded list,
whether it was rejected or dropped as stale. It is the one signature the two failure modes
share, and what a paging loop counts to know it is not getting anywhere (TRUNK-137).

**Loading edge** — the state where the virtual list's rendered range reaches within
`loadMoreThreshold` rows of the end of what is loaded, which is the condition that asks
for the next page. Reaching it is the whole trigger for paging. No search, jump or
gesture is required, only scrolling until the tail is in view (TRUNK-147).

**Dead effect** — a Svelte effect that returned before reading any reactive state, so the
runtime recorded no dependencies for it and nothing can ever invalidate it again. An
effect whose early-return guard reads only plain variables ends this way, and the symptom
is a feature that works until the first time its guard trips and never again (TRUNK-148).

**Loaded depth** — how many commit rows the frontend has actually paged in, which
`CommitGraph.loadedRows()` reports and a rebuild is asked to preserve. Distinct from the
rendered row count, which is the virtual list's window over that depth and stays small
however deep the list goes. A test that counts DOM rows measures the window, not the depth.

## Commit graph testing

**Fixture repository** — a git repository built from scratch by a generator, with pinned
author and committer timestamps and a fixed identity so two builds produce byte-identical
history. Timestamps must be spaced, never same-second: the graph sorts with
`TOPOLOGICAL | TIME`, and same-second commits sort arbitrarily. A fixture is a program, not a
directory: the generator is what is versioned, the repository is build output. The
generators are the case modules of the `trunk-fixtures` crate in `src-tauri/fixtures/`,
built by `just fixtures` into the gitignored `repos/` (TRUNK-108 ported them from a
repository of shell and python scripts, byte for byte).

**Case** — one generator and the set of fixture repositories it builds for one purpose
(`06-stash-lanes` builds 21, `09-kitchen-sink` builds 1). Eleven cases, 75 repositories.
Each case has a one-line summary `just fixtures-list` prints and, per built repository, a
`SCENARIO.md` saying what to look at and what would count as wrong (`06-stash-lanes` carries
one README for the corpus, `04` and `05` are described in `docs/fixtures.md`, and
`07-remote-branch` a `WALKTHROUGH.md`).

**Corpus fingerprint** — the text `fixtures fingerprint` prints for a set of built
repositories: HEAD, every ref, the stash reflog, the repository state, `MERGE_HEAD`,
`MERGE_MSG`, every unmerged index stage and the worktree status, in a fixed order. Two builds
of the same generator must print the same fingerprint, and one **oracle** fingerprint per
case lives under `src-tauri/fixtures/oracle/`, captured once from the shell corpus before the
port, which `tests/oracle.rs` compares a fresh build against. Refs alone were not enough: a
stopped merge can be lost without any ref moving (TRUNK-107). An oracle is a golden: never
edited to make a test pass.

**Byte parity** — the property that a verb of the fixture builder writes the same object bytes
`git` writes for the same inputs, so a repository built with git2 has the same OIDs as one
built with the CLI. Proven per verb by a test that builds the same scenario both ways and
compares fingerprints (`src-tauri/fixtures/tests/parity.rs`). The rules that make it hold
(message newlines, stash helper commits, reflog identity, merge labels, the spelled-out bare
clone) are in `docs/decisions/2026-09-02-fixtures-built-by-libgit2.md`.

**Fixture corpus** — the full set of fixture repositories the golden suites run over.

**Captured input** — a committed file recording everything `graph::snapshot` reads from one
fixture repository — the revwalk order, full unfiltered parent lists, the stash set,
`head_tip`, `tracked_upstream`, `worktree_dirty`, per-commit facts and refs — plus the
`wipCount` the app would pass alongside it. The golden suites and the named-rule tests read
these instead of building repositories, so the corpus scripts leave the test loop and only
`just graph-capture` reaches them.

Two directories, by audience. `src-tauri/tests/inputs/` holds one per **fixture corpus**
repository, feeding the golden suites. `src-tauri/tests/rule-inputs/` holds one per shape a
**named-rule test** reads, captured from `tests/common/graph_shapes.rs` by
`tests/test_graph_capture.rs`. They stay apart because `test_graph_goldens.rs` demands a
golden and an export for everything under `tests/inputs/`, and a rule input has neither.

Both sit deliberately outside `src-tauri/tests/goldens/`: an input is a fixture change, not a
golden acceptance, and `scripts/graph-accept.sh` fingerprints that directory whole.

**Fidelity check** — `just graph-fidelity`: rebuilds every named-rule shape, re-runs
`graph::capture`, and byte-compares against the committed rule input. A migrated test never
calls `capture()`, so this is the only thing standing behind the claim that its data is what
the repository produces. Offline and `#[ignore]`d, because rebuilding the repositories is the
cost the migration removed from the fast loop. A mismatch is a suspected defect, never a
stale artifact.

**Layout golden** — a committed text artifact recording the complete layout `graph::snapshot`
produces for one fixture repository: every row's column, colour index, edges, flags, refs and
parent links. Rows are keyed by commit summary, not OID. The backend half of the guarantee.
"Golden" is the word the code, the recipes and the rule file use; **snapshot** names the
general technique and nothing committed.

**Layout export** — the machine-readable dump of one fixture's `graph::snapshot` output,
generated by the Rust side and committed for the TypeScript suite to consume as input. A
one-way handoff, not a cross-process test: it is what makes the frontend's conditional
guarantee ("given the backend's placement, we render it right") rest on placements the
backend actually produces.

**Render golden** — a committed serialization of the SVG the graph column emits for one
layout export: paths, dots, node shapes, and ref pills. Everything inside the `<svg>`
element. The frontend half of the guarantee.

**Named-rule test** — a hand-written, hand-asserted test whose name states a placement rule
(`upstream_outranks_a_topic_branch_for_the_head_lane`,
`stash_branches_right_when_worktree_dirty`). Distinct from a golden: a golden pins
everything and explains nothing, a named-rule test pins one rule and says what it is. Editing
one is the loud signal that intended behaviour changed.

**Ledger anchor** — the exact source text, indentation included, that one row of the
mutation ledger (`docs/commit-graph-mutation-ledger.md`) is measured at. Each row's verdict
describes the mutation of that text at that site, so the anchor is the record's key into the
code. `just graph-sweep-check` asserts every anchor matches its file exactly once and is the
only part of the sweep on the fast path. An anchor is per file, not per function: a
behaviour-preserving extraction that moves the text keeps the alarm green only while the text
and its indentation survive, and the rule file still asks for the moved rows to be re-measured.
Not a review thread's anchor, which is the lines a comment is pinned to.

**Surviving mutant** — a mutation of the placement code that the test suite fails to detect.
The operational measure of "nothing can be misplaced without a test breaking": every survivor
is a placement change no test notices.

**Row-count guard** — the assertion that a fixture's render produced one dot per row. Its
expected value is derived from the fixture, never from the render, because a truncated render is
self-consistent and an expectation stored in a golden would regenerate alongside the
truncation. Distinct from a golden in that it never regenerates.

**Silent truncation** — a render that drops rows off the tail while staying internally coherent,
deterministic and plausible. The measured failure mode of mounting the commit graph under jsdom,
where the virtual list reports a zero-height viewport and caps the render at 22 rows regardless
of fixture size. Worse than an empty render, because nothing about the artifact reveals the loss.

**Tie-break ordering / time ordering** — the two paths a fixture can take through the walk's
`TOPOLOGICAL | TIME` sort. Commits sharing a second resolve by tie-break; commits with distinct,
spaced timestamps resolve by time, and the two can yield different row orders. Fixtures built by
`TestContext::builder` always take the tie-break path, since it has no timestamp control; the
shell fixture corpus is day-spaced and takes the time path.

## Diff surfaces

**Old path** — where a renamed file came from, carried on every file diff as `old_path`
and null for every other status (TRUNK-82). Rename pairing runs over the whole tree
before a single file is picked out, so a rename arrives already paired from commit,
compare and staged diffs; an unstaged workdir rename is deliberately not paired, matching
git. A surface that reads a file's before side reads it by the old path, because at the
before rev the file exists only under that name: the rendered markdown view learned this
in TRUNK-162, where reading by the new path showed a moved document as all added.

**Rendered view** — the diff pane's markdown mode: both sides of a `.md` file are read at
their revs, parsed into blocks, and shown as one document with the changed blocks tinted
or word-marked, rather than as source lines. One fetch per file and rev pair; every
layout (inline/split × hunk/full) is a projection of the returned rows.

## Dates (trunk-55)

**Relative date** — the compact age label (`5m ago`, `2d ago`, `just now`) produced by
`relativeLabel` in `src/lib/relative-time.ts` and shown wherever a commit timestamp is
rendered: the commit list's date column, the rebase editor, the compare panel.

**Exact date** — the full local date and time behind a relative date, GitHub-style:
medium date + long time with the GMT offset (e.g. `Aug 30, 2026, 6:07:23 PM GMT-3`),
in the user's locale and timezone. Revealed on hover via the custom `tooltip` action
and carried as the trigger's `aria-label` for accessibility.

## Commit navigation (spec 2026-08-18)

**Commit switch** — the selected commit changing by any gesture: parent/child topology
chips, the detail-pane header pager, a graph row click, or a branch/ref jump.

**Diff-in-view navigation** — the mode where a commit file diff (or the empty-commit
placeholder) is open in the center pane and every commit switch keeps a diff in view:
the same file when the new commit touches that exact path, else the first file in the
new commit's file list. Ends when the user closes the diff or the placeholder.

**Empty commit** — a commit whose file list (`list_commit_files`) has zero entries.
During diff-in-view navigation it shows a placeholder in the still-open diff pane, and
the remembered file path survives the hop.

## Reviews (persistent model, spec 2026-08-11)

**Review** — a durable, per-repo collection of threads plus a lifecycle state. Persists
across restarts and across End Review. Identified by a short id and an editable title.
Multiple reviews per repo may exist in every state.

**Review states** — fully derived from one non-derived bit, **published** (set once
by Ending the review, never unset): `composing` = not published (not served by the
CLI; needs ≥1 thread to publish), `ready` = published with an `open` or `addressed`
thread ("ready for reading"; discussion runs), `settled` = published with none.
Ending a review is a publish, never a delete; publishing an all-resolved review
derives directly to `settled`. No close- or reopen-review gesture exists, and no
review state gates a thread action: thread states dictate actionability, so a
settled review gaining or reopening a thread is `ready` again. Destructive
operations: deleting a review (any state, confirmed), and deleting threads or
replies inside a *composing* review; a published thread leaves discussion only via
`dismissed`.

**Active review** — the single review, per repo, that comment gestures land in; may
be any review in any state (published reviews keep gaining threads; a settled one
flips back to `ready`). Switching it is a one-step UI action; a gesture with no
active review auto-creates a fresh composing one, never silently activating an
existing review.

**Thread** — one anchored root comment plus a flat, one-level list of replies.
The selection is the thread; replies carry no anchors and no states.

**Thread states** — `open` (default at creation, so composing-review threads carry
states too), `addressed` (the agent's claim, settable via CLI), `done`
(user-confirmed fixed), `dismissed` (user withdrew or rejected the comment). State
lives on the thread. The CLI may only move `open → addressed`; the UI may move
`open|addressed → done|dismissed`, `addressed → open`, and `done|dismissed → open`;
nothing reaches `addressed` from the UI — it is the agent's claim by definition.
Text edits never change state. Attribution is by channel: UI = human, CLI = agent.

**Stale marker** — an orthogonal, derived flag on a thread whose *anchored lines* no
longer match the current content of the surface the thread targets (current-file →
working tree; snapshot → superseded; commit-diff threads never go stale — the orphan
classifier covers them). Recomputed by the app on repo-changed events, persisted
only as a last-computed value for the CLI to print, and it can clear again after,
e.g., a branch switch. Not a state; a thread can be `open` and
stale at once.

**Snapshot** — a dangling commit holding the working tree or the index as it stood
when a comment was left on uncommitted work, so the comment has something to anchor
to. One per kind per repo, reused while the tree is unchanged, and **superseded**
when the tree changes and the next comment gesture mints a new one.

**Snapshot pin** — the keepalive ref under `refs/trunk/review-snapshots/` that holds
a snapshot against `git gc`. Without it the snapshot is collected and the comment
anchored to it drops out of the panel as `CommitGone`.

**Pin sweep** — what reclaims snapshot pins. It may only delete a pin for a
snapshot a thread has *ever* anchored to and none anchors to now. A snapshot that
never carried a thread may belong to a comment still being submitted, so it is
kept until a grace window passes. See
`docs/decisions/2026-08-31-snapshot-pin-sweep.md`.

**Current-file comment** — a comment anchored to the present content of a tracked
file, independent of any pending change. Pins to the content at comment time; the
stale marker arrives when the *anchored lines* change, not on any edit elsewhere in
the file. Never re-anchored forward.

**Review CLI** — the Trunk-shipped, fully local command-line tool agents use to list
`ready`/`settled` reviews, read one in full, reply to threads, and claim `addressed`.
It inverts the integration dependency: Trunk never connects to an agent; the agent's
process invokes the CLI.

**Review doc** — the agent-addressed markdown rendering of a review, copied to the
clipboard on demand for any review in any state. One rendering of the store, not the
store itself.

## Remote operations

**Push recovery prompt** — the persistent in-app surface Trunk shows when a push fails
with an *actionable failure*, offering quick actions that resolve the failure without
leaving the app. Ephemeral app state, scoped to one repo tab; unlike the operation
banner, it is not backed by a git repository state.

**Actionable failure** — a remote-operation failure Trunk can offer a resolving action
for. Currently `non_fast_forward` (local and remote have diverged) only.

**Actionless failure** — a remote-operation failure with no button that fixes it,
e.g. `auth_failure` (missing SSH key, bad credential helper), `remote_error`, or
`no_upstream` (branch was never published — actionless because, under the user's
`push.autoSetupRemote` config, a plain push already sets the upstream). Gets persistent
feedback, no quick actions.

**Diverged push** — a push rejected because the remote branch has commits the local
branch does not, while the local branch also has commits the remote does not. Surfaces as
the `non_fast_forward` error code.

**Lease-protected force push** — Trunk's only force push: `git push --force-with-lease
--force-if-includes`. Both flags are required. `--force-with-lease` alone is unsafe in
Trunk because a silent periodic background fetch refreshes the remote-tracking ref the
lease is validated against; `--force-if-includes` additionally requires that the remote
tip be reachable from the local reflog, proving the user actually integrated that work.
Trunk never issues a bare `--force`.

**Lease refusal** — a lease-protected force push rejected because the local reflog does not
contain the current remote tip: the user fetched remote commits but never integrated them.
Git reports it as `remote ref updated since checkout` or `stale info`, both of which
re-classify as `non_fast_forward`, so the error code alone cannot distinguish a lease refusal
from a first-time divergence — the stderr can. Retrying the force push is a guaranteed no-op
until the user integrates, so Trunk offers no force-push action on a lease refusal.

## Application harness (spec 2026-08-25)

**Application harness** — the Harness that boots the real application headlessly: the real
Svelte component tree mounted in a headless DOM, with `invoke` routed to the real
`#[tauri::command]` functions against a real git repository on disk. Exposes
`setup(options)` and `teardown()`, and hands the test an **application driver**. Distinct
from `TestContext` (`src-tauri/tests/common/context.rs`), the backend-only harness that
already exists and stops below the IPC boundary.

**Application driver** — the test's view of the application's public interface, in gestures
rather than transport: `driver.contextMenu.choose("Interactive Rebase...")`, not an
`invoke` call. Per-domain drivers aggregate under one root, mirroring
`src-tauri/tests/common/drivers/`.

**Join** — the pairing of a frontend call site with the Rust command it names: command
name, argument names, response shape, and error code. Each half is declared separately
(e.g. `RebaseTodo` in `src-tauri/src/commands/interactive_rebase.rs` and in
`src/lib/types.ts`) and nothing today fails when the two disagree.

**Workflow** — a user-visible sequence that crosses the IPC boundary. The unit of admission
to the harness layer: one end-to-end test per workflow. Edge cases, permutations, error
branches and rule variants stay at the base of the pyramid and are never replayed wide.

**Coverage hole** — a workflow where each half is only ever asserted against a hand-written
assumption about the other. Mechanically findable from the `safeInvoke` call sites and what
asserts them.

**Harness residue** — the named classes of correctness a headless DOM cannot observe, and
which therefore still need a human: layout and paint, scroll and virtualization,
WKWebView-specific rendering, native OS chrome, and real pointer gestures. Naming the
residue is what makes "no manual QA for correctness" an honest claim rather than a slogan.

**The `_inner` seam is not the command.** Between an `_inner` function and the frontend sit
the commit-cache write, `app.emit("repo-changed", …)`, the `.to_json()` error flattening and
argument deserialization (see `src-tauri/src/commands/interactive_rebase.rs:341`). Neither
existing suite exercises that layer.

**Compare** — the A→B diff view between any two commits picked in the graph (TRUNK-1).
Distinct from a single commit's diff (parent(0) vs commit) and from a review range (which
requires ancestry). A compare has no ancestry requirement and is a plain two-tree diff.

**Base / Target** — the two sides of a compare. Base is the left/old side and is the
first-selected commit; Target is the right/new side. Selection order sets direction; the
compare header offers a swap. A contiguous-range compare uses parent(oldest) as Base and
the newest commit as Target, so it shows every selected commit's changes (GitKraken
behavior, João 2026-08-30).

## Time in the frontend (TRUNK-110, 2026-09-02)

**Scheduler** — the seam through which a component schedules a callback for later
(`setTimeout`/`clearTimeout` today; intervals and rAF join under TRUNK-111). Lives in
`src/lib/scheduler.ts`; components read it from Svelte context under an exported key and
fall back to the real one when nothing set it, so a plain mount and the unit suites'
`vi.useFakeTimers` keep working. Distinct from the **clock** (reading the current time,
`now.svelte.ts`), which TRUNK-111 owns.

**Owned timer** — a component's single pending callback, created during initialisation
from `src/lib/owned-timer.ts`. Arming it replaces whatever was pending, destroying the
component cancels it, and arming after destroy does nothing, so no callback can fire
against a component that is gone. It reads the scheduler from context, so the fake
scheduler drives it and a plain mount uses real time. The review panel's three revert
timers and the comment composer's draft autosave are its callers. A bare `setTimeout` in
a component is the leak TRUNK-22 and TRUNK-169 were; the sites still bare are TRUNK-111's
(TRUNK-22, 2026-09-05).

**Fake scheduler** — the harness's double for the scheduler: timers queue instead of firing.
Installed through `mount()`'s `context` option before the root mounts, the same shape as the
transport seam. `flush()` fires whatever is pending now; `elapse()` waits for a timer to be
armed and then fires it, so a test says "the debounce ran" instead of guessing a quiet
window. `elapseUntil()` fires timers while waiting on a condition, for the actions that emit
`repo-changed` more than once; `settled()` runs every refresh out before a gesture a
re-render would disturb. Retires `settle()` and its quiet window.

**Open repositories** — the repositories the app currently has open, mapping the path the
frontend addresses a repository by to where it lives on disk. Commands take a snapshot of it
rather than holding the lock across their work, so a repository closed mid-command still
resolves. The window is the command's own duration. Asking it for a repository it does not
hold is the `not_open` error every command seam owes the frontend, pinned at each seam by
`test_not_open_contract.rs`.

**Graph cache** — the built commit graph held for each open repository. A rebuild writes a
whole entry rather than mutating one, so a reader sees either the graph as it was or the
graph as it now is, never a half-updated one. An operation that rebuilds several
repositories' graphs builds them aside and absorbs them in one step, so a concurrent
refresh of another repository is not rolled back.

**Remote operation registry** — the fetch, pull or push running for each repository, by
process id. It answers two questions with one entry: which process the cancel button
signals, and whether a second remote operation may start on that repository at all.

**Stats cache** — the diff stat computed for each commit, per repository, filling the
graph's Diff column. A commit's diff never changes, so an entry is never invalidated,
only dropped wholesale when its repository closes. Filled lazily and only while that
column is visible.

