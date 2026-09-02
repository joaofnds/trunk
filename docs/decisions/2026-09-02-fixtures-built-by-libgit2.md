# Decision: the fixture corpus is built by libgit2, inside trunk

Status: **decided** (TRUNK-108). Date: 2026-09-02.

## TL;DR

The fixture repositories Trunk is tested against are built by a workspace crate,
`trunk-fixtures` at `src-tauri/fixtures/`, with git2, the library the app reads
repositories with. The separate repository of shell and python generators it replaced
is retired (TRUNK-108.22 archives it on GitHub). The crate reproduces that corpus byte
for byte: every case is compared against a fingerprint captured from the shell build
before the port.

## The problem

Trunk built test repositories in three places: two git2 builders
(`tests/common/builder.rs`, `tests/common/graph_shapes.rs`) and the shell corpus, driving
the `git` binary, that `scripts/graph-capture.sh` reached into a sibling checkout for. The
shell corpus carried its own toolchain (bash, python, bats, shellcheck, shfmt, ruff,
mise, CI) for one purpose. One builder, one language, one gate.

The alternative considered was a `test-util` module inside `trunk_lib` plus an example
binary. Rejected: the corpus is not an affordance on a production type; it is a separate
program whose only dependency is git2, and a crate boundary keeps it that way
(see `2026-08-31-test-only-api-on-production-types.md` for the test-util convention).

## What makes the bytes match

git2 writes the same object bytes as the git binary for every verb the corpus uses, with
these rules. Each is pinned by `src-tauri/fixtures/tests/parity.rs`, whose scenarios are
built through `Repo` and through `git` and compared by fingerprint.

- **Messages.** `git commit -m`, `git merge -m` and `git tag -a -m` store the message
  followed by one newline; libgit2 stores what it is given. Every verb appends the
  newline; no call site does.
- **Stash.** `Repository::stash_save` ends the WIP commit's message with a newline git
  does not write, which moves every stash OID. The stash is hand-rolled: the index and
  untracked helper commits end with a newline, the WIP commit does not; the helper
  subject is the HEAD commit's summary (its first paragraph joined); the reflog entry is
  rewritten under the pinned signature, because the ref update logs under the config
  identity and the wall clock; the ending is a hard reset plus deletion of the stashed
  untracked files and the directories they leave empty. With nothing untracked, `-u`
  writes no helper commit, as git does not; with nothing to stash the verb panics, where
  git would quietly make no stash.
- **A merge that stops.** `Repository::merge` with the labels `HEAD` and the branch name,
  then `MERGE_MSG` and `MERGE_MODE` overwritten with git's bytes: libgit2 words the
  message differently and writes `no-ff` unconditionally. The conflicted paths in the
  message follow git's index order, which is bytewise even on a case-insensitive
  checkout where libgit2 sorts its own index case-insensitively.
- **The diff3 re-checkout** (`git checkout -m` under `merge.conflictstyle diff3`) needs
  the ancestor label `base`; libgit2 writes `ancestor` by default.
- **A bare clone.** `RepoBuilder` puts the heads under `refs/remotes/origin/*` and writes
  a fetch refspec; `git clone --bare` mirrors `refs/heads/*`, copies every tag, and
  writes only `remote.origin.url`. The clone is spelled out that way.
- **Fetch.** git's first fetch records the remote's HEAD as `refs/remotes/<r>/HEAD`
  when it names a fetched branch; libgit2 leaves that to the caller, so the verb writes it.
- **Push.** libgit2's local transport overwrites the remote's ref; git refuses a push
  that does not fast-forward it. The verb refuses too. libgit2 1.9.7 updates
  `refs/remotes/<r>/<b>` after a local push through the remote's fetch refspec, as git
  does, so no verb writes it by hand.

One rule is pinned by the oracle rather than by parity. Cases 07 and 08 formatted their
dates without a zone in the shell, so git stored them in local time and their OIDs moved
with the machine's zone. The port pins every date to UTC and their oracles were captured
under `TZ=UTC`.

## Isolation

libgit2 ignores `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` on the open path this crate
uses and locates the global and XDG config files through `HOME`. The isolation that
works is `git2::opts::set_search_path(level, "")` for the Global, XDG, System and
ProgramData levels, called once before the first repository is opened, in `main` and in
every test binary (`trunk_fixtures::isolate()`). `tests/isolation.rs` spawns the binary
under a hostile HOME and proves the global and XDG levels; the system level cannot be
planted from a test. The same gap in trunk's own suite is TRUNK-109.

## Accepted differences from the git binary

None is read by Trunk and none is in the fingerprint.

- `AUTO_MERGE`: git writes a ref to the auto-merged tree during a stopped merge;
  libgit2 does not.
- `ORIG_HEAD` after a reset: git writes it; libgit2 writes it on merge only.
- HEAD's reflog text after a reset: libgit2 logs `reset: moving to <oid>` under the
  config identity and the wall clock; git logs the revspec under the pinned identity.

## Risks

- A shape only the git CLI produces can no longer appear in the corpus. A verb `Repo`
  lacks is added with a parity scenario, which is the cost of adding it.
- The octopus merge takes each head's base against the original HEAD; git reduces
  against the accumulated result and aborts when a later head touches a file main
  changed since the fork. The one octopus in the corpus (05-01) does not reach the
  difference, and the parity scenario pins that exact shape.
- git cleans `-m` messages (trailing whitespace, repeated blank lines, `#` lines in tag
  messages); the verbs store verbatim plus a newline. No corpus message is affected.

## How to re-check

Every command runs from the repository root with `mise exec --` and
`--manifest-path src-tauri/Cargo.toml`, as `CLAUDE.md` says.

- Parity of a verb: `cargo nextest run --manifest-path src-tauri/Cargo.toml -p trunk-fixtures --test parity`;
  the scenarios in `tests/parity.rs` are the record of what has been proven.
- Isolation: the same with `--test isolation`, and remove the `isolate()` call from
  `main.rs` to watch kitchen-sink's stash ref and 04's remote HEADs move.
- The corpus against its oracle: the same with `--test oracle`.
- The graph inputs against the corpus: `just graph-capture` must leave
  `src-tauri/tests/inputs/` unchanged.
