# Fixtures

Every repository Trunk is tested against, built in one place: the `trunk-fixtures` crate
at `src-tauri/fixtures/`, on git2, the library the app reads repositories with.

```bash
just fixtures              # build every case into repos/
just fixtures-list         # what exists, without building anything
just fixtures nested       # one case; a name matches on any part
```

Repositories land in `repos/` at the repository root, which is **gitignored**.
`just check` needs no built `repos/`: the graph suites read committed captures, and the
crate's own tests build what they need into temp directories.

## The rule

**A fixture is a program, not a directory.** What lives in git is the case module; the
repository is build output. Edit a built repo freely, break it, resolve half a merge in
it, then rerun `just fixtures` and it is back.

That rule is the whole design, and it is not arbitrary:

- **Several fixtures are states git cannot commit.** `10-nested-conflict` is parked
  mid-merge with an index full of unmerged entries. A submodule or a committed
  repo-in-a-repo cannot carry that. A program can.
- **A committed repository is unreviewable.** A change to a fixture would arrive as
  binary pack churn. A change to a case module arrives as a diff you can read.
- **Determinism has to be enforced somewhere.** The `Repo` verbs in
  `src-tauri/fixtures/src/repo.rs` are that place.

## What every case gets

Every case is written in the crate's `Repo` verbs, which give it four properties so no
case has to remember them:

| Property | Why |
|---|---|
| Isolated git config | libgit2 reads the operator's `~/.gitconfig` and `~/.config/git/config` through `HOME` and, on the open path this crate uses, ignores `GIT_CONFIG_GLOBAL`. `trunk_fixtures::isolate()` blanks its config search paths before any repository is opened, in the binary and in every test. An ambient `core.excludesFile` moved a `-u` stash's OID in the experiment that settled the design; `tests/isolation.rs` builds under a hostile HOME to prove it cannot now. |
| Pinned timestamps | The commit graph sorts with `TOPOLOGICAL \| TIME`. Same-second commits sort arbitrarily and can render a layout that is correct only by coincidence. Every commit is a day apart (an hour in `07` and `08`), pinned to UTC. |
| Rebuild from scratch | Repos are disposable. `fixtures build` removes a previous build of each repository before building it. |
| Fixed identity | Three identities exist, kept exactly as the corpus had them so its OIDs hold: `Trunk Fixture <fixture@trunk.test>` (01, 02, 03, 09, 10, 11), `QA Fixture <qa@trunk.test>` (04, 05, 06) and `Trunk QA <qa@example.invalid>` (07, 08). |

Two builds of the whole corpus print the same **fingerprint** (`fixtures fingerprint
--root DIR PATH...`: HEAD, every ref, the stash reflog, the repository state, a stopped
merge's files, the unmerged index stages, the worktree status with blob ids, ignored paths
and branch upstreams). One fingerprint per case is committed under
`src-tauri/fixtures/oracle/`, captured once from the shell corpus this crate replaced, and
`tests/oracle.rs` compares a fresh build of each case against it. An oracle file is a
golden: a change to it is a fixture change, made on purpose, with the cause in the commit
message. When an oracle test goes red, the port is the suspect: the report names the
repository block and the first line that differs; compare the case module with what the
retired generator did before touching the oracle, and never edit an oracle to make the
test pass.

## The cases

`just fixtures-list` prints each case's one-line summary from the case modules; this
table says what each case is for. `tests/catalogue.rs` fails when a case is missing here.

| Case | Repos | What it is for |
|---|---|---|
| `01-commit-message` | 5 | Whether an editor opens at all, what it is pre-filled with, and what an empty message does: non-ff merge, fast-forward, conflict, revert, abort. |
| `02-diff-scenarios` | 1 | One diff-rendering scenario per commit, 36 of them: word emphasis, split pairing, hunk boundaries, markdown, renames, binaries, CRLF, submodules. |
| `03-staging-ignore-ws` | 6 | Staging must act on the hunks the view shows, not the ones it hid (TRUNK-73). One repo per gesture, because 7e is destructive. |
| `04-graph-lanes` | 13 + 9 bare remotes | HEAD-lane placement: behind, ahead, diverged, detached, tag-only chains, two remotes. |
| `05-graph-merges` | 14 | Merge, multi-branch, ordering and column-pressure shapes, including octopus and criss-cross. |
| `06-stash-lanes` | 21 | Stash-vs-WIP lane placement across every flavour of dirtiness, plus orphan, detached, bare and backdated stashes. |
| `07-remote-branch` | 1 + origin | The create-branch walk against a real origin with remote-only branches, and a worktree dirty the one way the backend counts. |
| `08-merge-conflict` | 1 | The merge editor's conflict header bars, which need several conflicts on screen at once to compare against each other. |
| `09-kitchen-sink` | 1 | Every graph shape at once: 18 branches, 5 tags of both kinds, 3 stashes, an orphan root, a criss-cross merge, a dirty worktree. |
| `10-nested-conflict` | 1 | A stopped merge across four directory levels, plus one file git calls resolved that still contains conflict markers. |
| `11-rendered-markdown` | 1 | The rendered markdown diff, one commit pair per defect: an unchanged image beside changed words, a markup-only edit, the fold inside a list and inside a blockquote, a quote that stops being a container, a task list. |
| `12-deep-history` | 1 | History several pages deep, for the jumps that must page commits in before they can land: a branch tip and a search hit that both sit below the first 200-row page (TRUNK-137). |

Cases 04, 05 and 06 are also the corpus Trunk's committed graph inputs are captured
from, via `just graph-capture`, which builds them into a throwaway directory and must
leave `src-tauri/tests/inputs/` unchanged.

Each built repository carries a `SCENARIO.md` saying what to look at and what would count
as wrong; read it when you open the repo. Three cases document themselves differently:
`06` carries one README for the whole set, `04` and `05` are described here only, and `07`
carries a `WALKTHROUGH.md` beside its repository. `tests/catalogue.rs` fails when a case
builds a repository without its document; a new case that documents itself at corpus
level is added to that test's lists.

Three scenarios still name the retired repository's commands inside their repositories:
the untracked `SCENARIO.md` of `08`, `09` and `10` say `./build 08-merge-conflict` or
`cases/…/build.sh`. Their bytes are part of the oracle captured from that repository, so
the text stays as captured; the command is `just fixtures <case>`.

For a change to the graph pipeline, `scripts/qa-stash-probe.sh` dumps every stash-lanes
fixture's layout as one text file: capture a baseline before the change and one after,
and `diff -r` the two directories to see which fixtures moved.

## Checks

The crate's tests run inside `just check` (`cargo nextest run --workspace`):

| Suite | What breaks if it fails |
|---|---|
| `parity` | A `Repo` verb writes different bytes from the `git` binary. The scenarios are built both ways and compared by fingerprint; a verb the corpus needs is added here first. |
| `oracle` | A case no longer builds the repositories the shell corpus built. "This fixture moved" is a real signal, not noise about the clock. |
| `isolation` | The operator's global or XDG git config reaches a fixture. This shipped once, in the shell era: a `core.hooksPath` pre-commit was baked into 20 fixtures while the build still exited 0. The system level cannot be planted from a test; the oracle comparison covers it on a machine that has one. |
| `catalogue` | A case has no summary, or builds a repository nobody can judge a result against. |
| `cli` | `fixtures build` and `fixtures list` stop behaving the way the scripts and recipes rely on. |
| `fingerprint` | The fingerprint prints something other than what Trunk can observe, or prints it in an unstable order. |

## Writing a new case

Copy the shape of an existing module under `src-tauri/fixtures/src/cases/`: a `CASE`
constant (name, one-line summary, the repository paths under `repos/`, the build function),
one function per repository, every git operation a `Repo` verb. Register it in `CASES` in
case order. Then capture its oracle:

```bash
just fixtures 12-my-case
cargo run --manifest-path src-tauri/Cargo.toml -p trunk-fixtures -- \
  fingerprint --root repos my-case > src-tauri/fixtures/oracle/12-my-case.txt
```

Commit the oracle with the case, add the case's test to `tests/oracle.rs`, and add the
case's row to the table above. Two conventions the tests cannot check for you:

- **State the expectation, not just the shape.** A repo whose `SCENARIO.md` only
  describes what it contains cannot be QA'd; say what would count as a defect.
- **Name files and symbols, never line numbers.** Citations with line numbers go stale
  silently.

A verb git has and `Repo` lacks is added with a parity scenario first: the same steps
spawned through `git` and written through `Repo`, fingerprints compared. The byte rules
that make parity hold are in
[decisions/2026-09-02-fixtures-built-by-libgit2.md](decisions/2026-09-02-fixtures-built-by-libgit2.md).

## Provenance

The corpus was a repository of shell and python generators, `joaofnds/trunk-test-cases`,
retired when this crate replaced it (TRUNK-108; its GitHub archival is TRUNK-108.22).
Every case was ported byte for byte:
the oracle files were captured from that repository's build before the port, and each
case's test still compares against them. Its history is the provenance of two cases that
were hand-built in March 2026 and rebuilt by nothing until then:

- `09-kitchen-sink` was `test/`. Its original `build-test-repo.sh` turned out to be stored
  inside its own `stash@{0}`, and was recovered from there, so this case is the author's
  own script with its dates pinned.
- `10-nested-conflict` was `conflict/`. No generator survived for it, so each commit's
  file tree was extracted from the original and is replayed from
  `src-tauri/fixtures/content/nested-conflict/`.

Cases 07 and 08 dated their commits in local time in the shell; the port pins them to UTC,
and their oracles were captured under `TZ=UTC`.
