#!/usr/bin/env bash
#
# Build the QA fixture repositories for stash-vs-WIP lane placement.
#
#   scripts/qa-stash-fixtures.sh [OUTPUT_DIR]
#
# Every repository is rebuilt from scratch. Commit timestamps are explicit and
# spaced a day apart: the graph sorts with TOPOLOGICAL | TIME, so same-second
# commits sort arbitrarily and can render a coincidentally-correct layout.
set -euo pipefail

OUT="${1:-${TMPDIR:-/tmp}/trunk-qa-stash}"
OUT="${OUT%/}"

# 2026-01-01T00:00:00Z. Fixed so regenerating gives byte-identical history.
BASE=1767225600
DAY=86400

init_repo() {
	local dir="$OUT/$1"
	rm -rf "$dir"
	mkdir -p "$dir"
	git -C "$dir" init -q -b main
	git -C "$dir" config user.name "QA Fixture"
	git -C "$dir" config user.email "qa@trunk.test"
	git -C "$dir" config commit.gpgsign false
	echo "$dir"
}

# commit <repo> <day> <message>
commit() {
	local dir="$1" ts=$((BASE + $2 * DAY)) msg="$3"
	git -C "$dir" add -A
	GIT_AUTHOR_DATE="@$ts +0000" GIT_COMMITTER_DATE="@$ts +0000" \
		git -C "$dir" commit -qm "$msg"
}

# stash <repo> <day> <message> — needs a modification already in the worktree
stash() {
	local dir="$1" ts=$((BASE + $2 * DAY)) msg="$3"
	GIT_AUTHOR_DATE="@$ts +0000" GIT_COMMITTER_DATE="@$ts +0000" \
		git -C "$dir" stash push -q -m "$msg"
}

# Three commits on main, then one stash taken against the tip. `git stash`
# reverts the worktree, so the repo is left clean.
linear_with_stash() {
	local dir
	dir=$(init_repo "$1")
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add notes"
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 2 "Add app"
	echo "lib v1" >"$dir/lib.txt"
	commit "$dir" 3 "Add lib"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
	echo "$dir"
}

build_01_clean_inline() {
	linear_with_stash 01-clean-inline >/dev/null
}

build_02_dirty_tracked() {
	local dir
	dir=$(linear_with_stash 02-dirty-tracked)
	echo "notes v3 — uncommitted" >>"$dir/notes.txt"
}

build_03_dirty_untracked() {
	local dir
	dir=$(linear_with_stash 03-dirty-untracked)
	echo "scratch" >"$dir/scratch.txt"
}

build_04_dirty_staged() {
	local dir
	dir=$(linear_with_stash 04-dirty-staged)
	echo "staged" >"$dir/staged.txt"
	git -C "$dir" add staged.txt
}

build_05_dirty_conflicted() {
	local dir
	dir=$(init_repo 05-dirty-conflicted)
	echo "shared line" >"$dir/conflict.txt"
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add conflict seed"
	git -C "$dir" checkout -q -b other
	echo "their line" >"$dir/conflict.txt"
	commit "$dir" 2 "Their edit"
	git -C "$dir" checkout -q main
	echo "our line" >"$dir/conflict.txt"
	commit "$dir" 3 "Our edit"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
	git -C "$dir" merge other -q >/dev/null 2>&1 || true
}

build_06_ignored_stays_inline() {
	local dir
	dir=$(init_repo 06-ignored-stays-inline)
	printf 'build/\n' >"$dir/.gitignore"
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add notes and ignore rules"
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 2 "Add app"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
	mkdir -p "$dir/build"
	echo "object code" >"$dir/build/out.o"
}

build_07_multi_stash_clean() {
	local dir
	dir=$(linear_with_stash 07-multi-stash-clean)
	echo "app v2 — also stashed" >"$dir/app.txt"
	stash "$dir" 11 "second stash"
}

build_08_multi_stash_dirty() {
	local dir
	dir=$(linear_with_stash 08-multi-stash-dirty)
	echo "app v2 — also stashed" >"$dir/app.txt"
	stash "$dir" 11 "second stash"
	echo "lib v2 — uncommitted" >>"$dir/lib.txt"
}

# The topic tip sorts ABOVE the stash's parent, so it finds the stash's lane
# still held and moves a column right as well as changing colour.
build_09_topic_above_parent() {
	local dir
	dir=$(init_repo 09-topic-above-parent)
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add notes"
	git -C "$dir" checkout -q -b topic
	echo "topic work" >"$dir/topic.txt"
	commit "$dir" 5 "Topic work"
	git -C "$dir" checkout -q main
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 3 "Add app"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
}

# Same shape, but the topic tip sorts BELOW the stash's parent, so the lane is
# already free and only the colour moves.
build_10_topic_below_parent() {
	local dir
	dir=$(init_repo 10-topic-below-parent)
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add notes"
	git -C "$dir" checkout -q -b topic
	echo "topic work" >"$dir/topic.txt"
	commit "$dir" 2 "Topic work"
	git -C "$dir" checkout -q main
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 3 "Add app"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
}

build_11_stash_parent_mid_chain() {
	local dir
	dir=$(linear_with_stash 11-stash-parent-mid-chain)
	echo "later work" >"$dir/later.txt"
	commit "$dir" 11 "Commit taken after the stash"
}

build_12_orphan_stash() {
	local dir
	dir=$(init_repo 12-orphan-stash)
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add notes"
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 2 "Add app"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
	git -C "$dir" reset -q --hard HEAD~1
}

build_13_detached_head() {
	local dir
	dir=$(init_repo 13-detached-head)
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add notes"
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 2 "Add app"
	echo "lib v1" >"$dir/lib.txt"
	commit "$dir" 3 "Add lib"
	git -C "$dir" checkout -q --detach HEAD
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
}

build_14_merge_tip() {
	local dir
	dir=$(init_repo 14-merge-tip)
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add notes"
	git -C "$dir" checkout -q -b feat
	echo "feature work" >"$dir/feature.txt"
	commit "$dir" 2 "Feature work"
	git -C "$dir" checkout -q main
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 3 "Add app"
	local ts=$((BASE + 4 * DAY))
	GIT_AUTHOR_DATE="@$ts +0000" GIT_COMMITTER_DATE="@$ts +0000" \
		git -C "$dir" merge feat -q --no-ff -m "Merge branch 'feat'"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
}

# Known deferred defect: the walk orders stashes by committer time alone, so a
# stash older than its parent sorts below it.
build_15_backdated_stash() {
	local dir
	dir=$(init_repo 15-backdated-stash)
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 5 "Add notes"
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 6 "Add app"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 1 "stash dated before its parent"
}

build_16_bare_repo() {
	local src="$OUT/.16-source" dir="$OUT/16-bare-repo.git"
	rm -rf "$src" "$dir"
	mkdir -p "$src"
	git -C "$src" init -q -b main
	git -C "$src" config user.name "QA Fixture"
	git -C "$src" config user.email "qa@trunk.test"
	git -C "$src" config commit.gpgsign false
	echo "notes v1" >"$src/notes.txt"
	commit "$src" 1 "Add notes"
	echo "app v1" >"$src/app.txt"
	commit "$src" 2 "Add app"
	git clone -q --bare "$src" "$dir"
	rm -rf "$src"
}

build_17_no_stash_dirty() {
	local dir
	dir=$(init_repo 17-no-stash-dirty)
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 1 "Add notes"
	echo "app v1" >"$dir/app.txt"
	commit "$dir" 2 "Add app"
	echo "notes v2 — uncommitted" >>"$dir/notes.txt"
}

# The added status read scales with worktree file count, not commit count.
build_18_many_files() {
	local dir
	dir=$(init_repo 18-many-files)
	mkdir -p "$dir/src"
	local i
	for i in $(seq 1 3000); do
		echo "content $i" >"$dir/src/file_$i.txt"
	done
	commit "$dir" 1 "Add 3000 files"
	echo "notes v1" >"$dir/notes.txt"
	commit "$dir" 2 "Add notes"
	echo "notes v2 — stashed" >"$dir/notes.txt"
	stash "$dir" 10 "half-finished notes"
	echo "content changed" >"$dir/src/file_1.txt"
}

# Expected layouts below were read off `walk_commits` against these exact fixtures,
# not predicted. Regenerate them with the probe described at the bottom of the file.
write_readme() {
	cat >"$OUT/README.md" <<'MARKDOWN'
# Stash-vs-WIP lane placement — QA fixtures

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

### Shapes that must not change with dirtiness

- [ ] **11-stash-parent-mid-chain** — a commit was made after the stash, so the
      stash's parent is no longer the tip. It branches right **identically** clean
      and dirty. Toggle `notes.txt` and nothing about the stash may move.
- [ ] **12-orphan-stash** — the stash's parent is unreachable from any ref. Stash
      renders as a standalone dashed square at column 1 with **no connector at
      all**, clean or dirty. No ghost rail hanging off it.
- [ ] **15-backdated-stash** — **KNOWN DEFERRED DEFECT, not a regression.** The
      stash's committer date predates its parent's, so it sorts *below* both
      commits with its dashed line running upward. Tracked in
      `.planning/todos/pending/2026-08-02-stash-sorts-below-its-parent-when-backdated.md`.
      Unaffected by dirtiness. Only report it if the *placement* looks new.

### Edge cases

- [ ] **05-dirty-conflicted** — mid-merge with one conflicted file and nothing else
      dirty. WIP row shows and the stash branches to column 1.
      **KNOWN DEFERRED DEFECT:** the tab shows **no dirty dot**, because the tab
      computes `staged + unstaged` and drops `conflicted`, while the WIP row uses
      all three. Verified here as `staged=0 unstaged=0 conflicted=1`. Tracked in
      `.planning/todos/pending/2026-08-02-tab-dirty-dot-ignores-conflicted.md`.
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

The layouts above were read off `walk_commits`, not predicted. To re-derive them
after a change, open each repo with `git2` and print each row's column, colour,
`is_stash` and edges — the same shape the integration tests in
`src-tauri/tests/test_graph.rs` assert on.
MARKDOWN
}

main() {
	mkdir -p "$OUT"
	local fn
	for fn in $(declare -F | awk '{print $3}' | grep '^build_' | sort); do
		printf '  %s\n' "${fn#build_}"
		"$fn"
	done
	write_readme
	printf '\n%s\n\nStart with %s/README.md\n' "Fixtures in $OUT" "$OUT"
}

main "$@"
