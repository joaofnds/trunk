//! Case 06: stash-vs-WIP lane placement, one repository per flavour of dirtiness, plus
//! orphan, detached, bare and backdated stashes. Transcribed from
//! cases/06-stash-lanes/build.sh.

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo, Signature, clone_bare};

const QA: Identity = Identity {
    name: "QA Fixture",
    email: "qa@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;

pub const CASE: Case = Case {
    name: "06-stash-lanes",
    summary: "Build the QA fixture repositories for stash-vs-WIP lane placement.",
    repos: &[
        "stash-lanes/01-clean-inline",
        "stash-lanes/02-dirty-tracked",
        "stash-lanes/03-dirty-untracked",
        "stash-lanes/04-dirty-staged",
        "stash-lanes/05-dirty-conflicted",
        "stash-lanes/06-ignored-stays-inline",
        "stash-lanes/07-multi-stash-clean",
        "stash-lanes/08-multi-stash-dirty",
        "stash-lanes/09-topic-above-parent",
        "stash-lanes/10-topic-below-parent",
        "stash-lanes/11-stash-parent-mid-chain",
        "stash-lanes/12-orphan-stash",
        "stash-lanes/13-detached-head",
        "stash-lanes/14-merge-tip",
        "stash-lanes/15-backdated-stash",
        "stash-lanes/16-bare-repo.git",
        "stash-lanes/17-no-stash-dirty",
        "stash-lanes/18-many-files",
        "stash-lanes/19-two-backdated",
        "stash-lanes/20-stash-on-stash",
        "stash-lanes/21-tagged-stash",
    ],
    build,
};

fn day(n: i64) -> Signature {
    QA.at(BASE_SECS + n * DAY_SECS)
}

fn init_repo(out: &Path, name: &str) -> Repo {
    let mut repo = Repo::init(&out.join("stash-lanes").join(name), "main", QA);
    repo.config("commit.gpgsign", "false");

    repo
}

/// `echo "$text" >"$dir/$rel"`.
fn echo(repo: &mut Repo, rel: &str, text: &str) {
    repo.write(rel, &format!("{text}\n"));
}

/// `echo "$text" >>"$dir/$rel"`.
fn append(repo: &mut Repo, rel: &str, text: &str) {
    let mut content = std::fs::read_to_string(repo.path().join(rel)).expect("read the file");
    content.push_str(text);
    content.push('\n');
    repo.write(rel, &content);
}

/// `commit <repo> <day> <message>`: stage everything, commit at the pinned day.
fn commit(repo: &mut Repo, on: i64, msg: &str) {
    repo.add_all();
    repo.commit(day(on), msg);
}

/// `stash <repo> <day> <message>`.
fn stash(repo: &mut Repo, on: i64, msg: &str) {
    repo.stash(day(on), msg, false);
}

/// Three commits on main, then one stash taken against the tip.
fn linear_with_stash(out: &Path, name: &str) -> Repo {
    let mut repo = init_repo(out, name);
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 2, "Add app");
    echo(&mut repo, "lib.txt", "lib v1");
    commit(&mut repo, 3, "Add lib");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");

    repo
}

fn build_01_clean_inline(out: &Path) {
    linear_with_stash(out, "01-clean-inline");
}

fn build_02_dirty_tracked(out: &Path) {
    let mut repo = linear_with_stash(out, "02-dirty-tracked");
    append(&mut repo, "notes.txt", "notes v3 — uncommitted");
}

fn build_03_dirty_untracked(out: &Path) {
    let mut repo = linear_with_stash(out, "03-dirty-untracked");
    echo(&mut repo, "scratch.txt", "scratch");
}

fn build_04_dirty_staged(out: &Path) {
    let mut repo = linear_with_stash(out, "04-dirty-staged");
    echo(&mut repo, "staged.txt", "staged");
    repo.add(&["staged.txt"]);
}

fn build_05_dirty_conflicted(out: &Path) {
    let mut repo = init_repo(out, "05-dirty-conflicted");
    echo(&mut repo, "conflict.txt", "shared line");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add conflict seed");
    repo.branch("other");
    repo.checkout("other");
    echo(&mut repo, "conflict.txt", "their line");
    commit(&mut repo, 2, "Their edit");
    repo.checkout("main");
    echo(&mut repo, "conflict.txt", "our line");
    commit(&mut repo, 3, "Our edit");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");
    repo.merge_stopped(None, "other")
        .expect("05-dirty-conflicted: the merge must stop");
}

fn build_06_ignored_stays_inline(out: &Path) {
    let mut repo = init_repo(out, "06-ignored-stays-inline");
    repo.write(".gitignore", "build/\n");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes and ignore rules");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 2, "Add app");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");
    echo(&mut repo, "build/out.o", "object code");
}

fn build_07_multi_stash_clean(out: &Path) {
    let mut repo = linear_with_stash(out, "07-multi-stash-clean");
    echo(&mut repo, "app.txt", "app v2 — also stashed");
    stash(&mut repo, 11, "second stash");
}

fn build_08_multi_stash_dirty(out: &Path) {
    let mut repo = linear_with_stash(out, "08-multi-stash-dirty");
    echo(&mut repo, "app.txt", "app v2 — also stashed");
    stash(&mut repo, 11, "second stash");
    append(&mut repo, "lib.txt", "lib v2 — uncommitted");
}

fn build_09_topic_above_parent(out: &Path) {
    let mut repo = init_repo(out, "09-topic-above-parent");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    repo.branch("topic");
    repo.checkout("topic");
    echo(&mut repo, "topic.txt", "topic work");
    commit(&mut repo, 5, "Topic work");
    repo.checkout("main");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 3, "Add app");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");
}

fn build_10_topic_below_parent(out: &Path) {
    let mut repo = init_repo(out, "10-topic-below-parent");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    repo.branch("topic");
    repo.checkout("topic");
    echo(&mut repo, "topic.txt", "topic work");
    commit(&mut repo, 2, "Topic work");
    repo.checkout("main");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 3, "Add app");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");
}

fn build_11_stash_parent_mid_chain(out: &Path) {
    let mut repo = linear_with_stash(out, "11-stash-parent-mid-chain");
    echo(&mut repo, "later.txt", "later work");
    commit(&mut repo, 11, "Commit taken after the stash");
}

fn build_12_orphan_stash(out: &Path) {
    let mut repo = init_repo(out, "12-orphan-stash");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 2, "Add app");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");
    repo.reset_hard("HEAD~1");
}

fn build_13_detached_head(out: &Path) {
    let mut repo = init_repo(out, "13-detached-head");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 2, "Add app");
    echo(&mut repo, "lib.txt", "lib v1");
    commit(&mut repo, 3, "Add lib");
    repo.checkout_detached("HEAD");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");
}

fn build_14_merge_tip(out: &Path) {
    let mut repo = init_repo(out, "14-merge-tip");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    repo.branch("feat");
    repo.checkout("feat");
    echo(&mut repo, "feature.txt", "feature work");
    commit(&mut repo, 2, "Feature work");
    repo.checkout("main");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 3, "Add app");
    repo.merge(day(4), "Merge branch 'feat'", &["feat"]);
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");
}

fn build_15_backdated_stash(out: &Path) {
    let mut repo = init_repo(out, "15-backdated-stash");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 5, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 6, "Add app");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 1, "stash dated before its parent");
}

fn build_16_bare_repo(out: &Path) {
    let source = out.join("stash-lanes").join(".16-source");
    if source.exists() {
        std::fs::remove_dir_all(&source).expect("remove a previous run's clone source");
    }
    let mut repo = Repo::init(&source, "main", QA);
    repo.config("commit.gpgsign", "false");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 2, "Add app");
    drop(repo);
    clone_bare(&source, &out.join("stash-lanes").join("16-bare-repo.git"));
    std::fs::remove_dir_all(&source).expect("remove the clone's source");
}

fn build_17_no_stash_dirty(out: &Path) {
    let mut repo = init_repo(out, "17-no-stash-dirty");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 2, "Add app");
    append(&mut repo, "notes.txt", "notes v2 — uncommitted");
}

fn build_18_many_files(out: &Path) {
    let mut repo = init_repo(out, "18-many-files");
    for i in 1..=3000 {
        echo(
            &mut repo,
            &format!("src/file_{i}.txt"),
            &format!("content {i}"),
        );
    }
    commit(&mut repo, 1, "Add 3000 files");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 2, "Add notes");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 10, "half-finished notes");
    echo(&mut repo, "src/file_1.txt", "content changed");
}

fn build_19_two_backdated(out: &Path) {
    let mut repo = init_repo(out, "19-two-backdated");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 5, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 6, "Add app");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 1, "older, dated before its parent");
    echo(&mut repo, "app.txt", "app v2 — also stashed");
    stash(&mut repo, 2, "newer, dated before its parent");
}

fn build_20_stash_on_stash(out: &Path) {
    let mut repo = init_repo(out, "20-stash-on-stash");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 1, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 2, "Add app");
    echo(&mut repo, "notes.txt", "notes v2 — stash A");
    stash(&mut repo, 10, "stash A");
    repo.checkout_detached("stash@{0}");
    echo(&mut repo, "notes.txt", "notes v3 — stash B");
    stash(&mut repo, 8, "stash B");
}

fn build_21_tagged_stash(out: &Path) {
    let mut repo = init_repo(out, "21-tagged-stash");
    echo(&mut repo, "notes.txt", "notes v1");
    commit(&mut repo, 5, "Add notes");
    echo(&mut repo, "app.txt", "app v1");
    commit(&mut repo, 6, "Add app");
    echo(&mut repo, "notes.txt", "notes v2 — stashed");
    stash(&mut repo, 1, "stash dated before its parent");
    repo.tag("keep", "refs/stash");
}

fn build(out: &Path) {
    build_01_clean_inline(out);
    build_02_dirty_tracked(out);
    build_03_dirty_untracked(out);
    build_04_dirty_staged(out);
    build_05_dirty_conflicted(out);
    build_06_ignored_stays_inline(out);
    build_07_multi_stash_clean(out);
    build_08_multi_stash_dirty(out);
    build_09_topic_above_parent(out);
    build_10_topic_below_parent(out);
    build_11_stash_parent_mid_chain(out);
    build_12_orphan_stash(out);
    build_13_detached_head(out);
    build_14_merge_tip(out);
    build_15_backdated_stash(out);
    build_16_bare_repo(out);
    build_17_no_stash_dirty(out);
    build_18_many_files(out);
    build_19_two_backdated(out);
    build_20_stash_on_stash(out);
    build_21_tagged_stash(out);
    std::fs::write(out.join("stash-lanes").join("README.md"), README).expect("write the README");
}

/// The corpus README, verbatim from the script's heredoc.
const README: &str = r##"# Stash-vs-WIP lane placement — QA fixtures

Regenerate at any time with `scripts/qa-stash-fixtures.sh`. Every repo is rebuilt
from scratch, so edit them freely.

## The rule under test

A stash renders **inline** — same column as its parent, straight dashed line — only
when the worktree is **clean**. The moment the worktree is dirty the frontend draws
its WIP row in that same column, so the stash must **branch to the side** instead:
its own column, its own colour, and a dashed fork off the parent.

The one thing that is always wrong: a stash square sitting **on** the WIP line.

## Toggling

Every non-bare repo has a tracked `notes.txt`.

```sh
echo "edit" >> notes.txt      # dirty  -> stash should branch right
git checkout -- notes.txt     # clean  -> stash should go back inline
```

Watch it happen live with the app open — the change should land within ~500 ms.

## Scenarios

Columns are 0-indexed from the left. "colour N" just means *distinct* colour N;
compare across the clean/dirty pair rather than to a specific hue.

### Core placement

- [ ] **01-clean-inline** — ships clean. Stash inline at column 0, straight dashed
      line to `Add lib`, same colour as the chain, **no WIP row**. Then edit
      `notes.txt`: WIP row appears at column 0 and the stash jumps to column 1 with
      a dashed fork off `Add lib`. Revert and it goes back.
- [ ] **02-dirty-tracked** — ships dirty via a modified tracked file. Stash at
      column 1, dashed fork off `Add lib`. WIP row at column 0.
- [ ] **03-dirty-untracked** — ships dirty via one untracked file only. Identical
      layout to 02. If the stash is inline here, untracked files stopped counting.
- [ ] **04-dirty-staged** — ships dirty via one staged-but-uncommitted file.
      Identical layout to 02. If the stash is inline here, the index bits stopped
      counting.
- [ ] **06-ignored-stays-inline** — ships with an ignored `build/out.o` and nothing
      else. The stash must stay **inline** and **no WIP row** may appear: ignored
      files are not dirt. This is the inverse test — a false positive here means
      inline never fires again in any real repo.
- [ ] **17-no-stash-dirty** — dirty, no stash at all. WIP row plus a plain straight
      line to `Add app`. Control: nothing about the WIP row itself changed.

### Multiple stashes

- [ ] **07-multi-stash-clean** — clean. The **newest** stash inlines at column 0;
      the older one branches to column 1. Only one of them can inline. Editing
      `notes.txt` pushes them to columns 1 and 2, with two forks off `Add lib`.
- [ ] **08-multi-stash-dirty** — the same repo shipped dirty: columns 1 and 2, two
      dashed forks off `Add lib`.

### Accepted churn — this is by design, confirm it looks tolerable

A branching stash consumes a lane and a colour that an inline one does not, so
toggling dirtiness reshuffles unrelated branches. This was an accepted trade, not
an oversight. It is nil in single-lane repos, which is the common case.

- [ ] **09-topic-above-parent** — `Topic work` sorts above the stash's parent.
      Clean: topic at column 1, colour 1, 2 columns total. Dirty: topic at column
      **2**, colour **2**, 3 columns total — and the message/author/date columns
      shift right with it. Looking for: no crossed edges, no orphan rail, nothing
      worse than a clean shift.
- [ ] **10-topic-below-parent** — same shape, topic sorts below the parent. Clean
      and dirty both keep topic at column 1; **only its colour changes**. Confirms
      the churn is bounded — not every branch moves.
- [ ] **12-orphan-stash** — `reset --hard` dropped the stash's parent from every
      ref, but the stash still points at it, so it keeps its row — and `Add app`
      is the revwalk tie-break extension of the HEAD lane, with the stash parented
      on its tip. Clean: one lane — stash at column 0 colour 1, straight dashed
      line down to `Add app` (also column 0, colour 1), `Add notes` below it at
      column 0 colour 0, no fork. Dirty (edit `notes.txt`): the WIP row suppresses
      the extension, so stash and `Add app` move to column 1 (both colour 1) and
      `Add notes` forks right into them. By design: `reset --hard` no longer
      visually removes a commit a stash holds — dropping the stash is what
      removes it.

### Shapes that must not change with dirtiness

- [ ] **11-stash-parent-mid-chain** — a commit was made after the stash, so the
      stash's parent is no longer the tip. It branches right **identically** clean
      and dirty. Toggle `notes.txt` and nothing about the stash may move.

### Ordering — a stash sorts above the commit it was taken on

Every stash below is dated *before* its parent. Ordering is topological, so the
date gets no vote. A stash drawn *below* its parent is the defect this group
exists to catch.

- [ ] **15-backdated-stash** — one stash, dated before its parent. Clean: inline
      at column 0 with a straight dashed line to `Add app`, 1 column total, and
      `Add app` is **not** a branch tip — the stash re-occupies its lane. Dirty:
      column 1, colour 1, dashed fork off `Add app`, 2 columns.
- [ ] **19-two-backdated** — two stashes on one parent, both dated before it.
      Clean: the **newer** inlines at column 0, the older takes column 1 and
      colour 1 with a dashed fork off `Add app`. Dirty: columns 1 and 2, two
      dashed forks. The same shape as 07 — being backdated earns no special rule.
- [ ] **20-stash-on-stash** — stash B was taken with HEAD detached on stash A, so
      B's parent *is* A, and B is dated **before** A. Clean: both inline at column
      0, B above A above `Add app`, dashed throughout, 1 column. Dirty: B moves to
      column 1 and A keeps column 0. A above B in either state means committer
      time beat topology.
- [ ] **21-tagged-stash** — a lightweight tag `keep` points at the stash commit,
      so it is reachable from `refs/tags` as well as `refs/stash`. Clean: exactly
      3 rows and 1 column — the stash, `Add app`, `Add notes`. Two rows carrying
      the same commit, the second drawn as a **merge**, means it entered the walk
      twice. No `index on main: …` row may appear either.

### Edge cases

- [ ] **05-dirty-conflicted** — mid-merge with one conflicted file and nothing else
      dirty. WIP row shows and the stash branches to column 1.
      **KNOWN DEFERRED DEFECT:** the tab shows **no dirty dot**, because the tab
      computes `staged + unstaged` and drops `conflicted`, while the WIP row uses
      all three. Verified here as `staged=0 unstaged=0 conflicted=1`. Tracked in
      `docs/known-issues/2026-08-02-tab-dirty-dot-ignores-conflicted.md`.
- [ ] **13-detached-head** — HEAD detached on the stash's parent, e.g. mid-rebase.
      Clean: inline at column 0. Dirty: column 1 with a fork. The WIP row anchors on
      the head chain, so it must still appear even with no branch checked out.
- [ ] **14-merge-tip** — the stash's parent is a merge commit. Clean: stash inline.
      Dirty: stash at column 1 and the merge dot also gains a fork. The merge dot's
      "branch tip" flag legitimately flips with dirtiness; watch for the dashed line
      starting at a visibly different point on the dot, which would be cosmetic
      rather than a placement bug.
- [ ] **16-bare-repo.git** — a bare repo. Must **open without an error toast** and
      render its two commits. `git status` refuses to run against a bare repo, so
      this is the fallback path. No WIP row (there is no worktree).
- [ ] **18-many-files** — 3000 tracked files, shipped dirty. The added worktree scan
      costs roughly +5-10 ms per refresh and scales with file count, not history.
      Looking for: editing a file still repaints promptly, no visible stutter.

## Regenerating the expected layouts

The layouts above were read off `walk_commits`, not predicted. Re-derive them with

```sh
scripts/qa-stash-probe.sh /tmp/qa-after
```

which dumps each row's column, colour, flags and edges to one file per repo — the
same shape the integration tests in `src-tauri/tests/test_graph.rs` assert on.
Capture a run before a change and one after, then `diff -r` the two directories to
see exactly which fixtures moved.
"##;
