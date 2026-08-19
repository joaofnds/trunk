#!/usr/bin/env bash
#
# Build the QA fixture repositories for merge, multi-branch, ordering and
# column-pressure shapes.
#
#   scripts/qa-graph-merge-fixtures.sh [OUTPUT_DIR]
#
# Every repository is rebuilt from scratch. Commit timestamps are explicit and
# spaced a day apart: the graph sorts with TOPOLOGICAL | TIME, so same-second
# commits sort arbitrarily and can render a coincidentally-correct layout.
#
# Global git config is isolated. Without that an ambient commit.gpgsign makes
# every run produce different OIDs, and hooks and templates leak in.
#
# Coverage — every spec AC-2 "gaps to close" case and the fixture that covers it
# (`.boris/plans/2026-08-05-commit-graph-snapshot-testing-spec.md`):
#
#   octopus merge, 3+ parents ................... 01-octopus-merge
#   criss-cross merge ........................... 02-criss-cross
#   a merge whose parents are themselves merges .. 03-merge-of-merges
#   3+ concurrent topic branches ................ 04-three-topics
#   sequential merges into one line ............. 05-sequential-merges
#   a merge whose second parent sorts above it ... 06-merge-second-parent-newer
#   a fork whose sibling tip sorts older ........ 07-fork-sibling-older
#                          (contrasted against) . 08-fork-sibling-newer
#   column saturation and freed-column reuse .... 09-column-saturation
#   pagination boundary cutting a fork/merge .... 12-pagination-boundary
#
# Widened 2026-08-05 to target named mutation survivors. The 33-fixture corpus
# produces no MergeLeft and no ForkLeft edge at all, and never takes the
# leftward half of find_free_column_near's spiral:
#
#   merge edge pointing left (graph.rs:448) ..... 10-merge-parent-left
#   fork-out edge pointing left (graph.rs:334) .. 11-fork-in-left
#   leftward spiral search (graph.rs:44-46) ..... 13-freed-column-left
#   spiral tries right first (graph.rs:35) ...... 14-spiral-right-before-left
set -euo pipefail

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

OUT="${1:-${TMPDIR:-/tmp}/trunk-qa-graph-merge}"
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

slug() {
	local msg="$1"
	echo "${msg// /-}"
}

# commit <repo> <day> <message>
commit() {
	local dir="$1" ts=$((BASE + $2 * DAY)) msg="$3"
	echo "$msg" >"$dir/$(slug "$msg").txt"
	git -C "$dir" add -A
	GIT_AUTHOR_DATE="@$ts +0000" GIT_COMMITTER_DATE="@$ts +0000" \
		git -C "$dir" commit -qm "$msg"
}

# orphan_branch <repo> <name>
# A parentless branch. Its root terminates its lane wherever the root sorts,
# which is the only way a fixture can free a column part-way down the walk: a
# branch hanging off the HEAD tip is absorbed into the HEAD lane instead.
orphan_branch() {
	local dir="$1" name="$2"
	git -C "$dir" checkout -q --orphan "$name"
	git -C "$dir" rm -rq --cached .
	rm -f "$dir"/*.txt
}

# merge <repo> <day> <message> <committish...>
merge() {
	local dir="$1" ts=$((BASE + $2 * DAY)) msg="$3"
	shift 3
	GIT_AUTHOR_DATE="@$ts +0000" GIT_COMMITTER_DATE="@$ts +0000" \
		git -C "$dir" merge -q --no-ff -m "$msg" "$@"
}

# --- 01: one merge with three parents. ---------------------------------------
build_01() {
	local dir
	dir=$(init_repo 01-octopus-merge)
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b topic-a
	commit "$dir" 2 "topic a one"
	git -C "$dir" checkout -q main
	git -C "$dir" checkout -q -b topic-b
	commit "$dir" 3 "topic b one"
	git -C "$dir" checkout -q main
	git -C "$dir" checkout -q -b topic-c
	commit "$dir" 4 "topic c one"
	git -C "$dir" checkout -q main
	commit "$dir" 5 "main two"
	merge "$dir" 6 "octopus three topics" topic-a topic-b topic-c
}

# --- 02: alpha and beta each merge the other. --------------------------------
build_02() {
	local dir
	dir=$(init_repo 02-criss-cross)
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b alpha
	commit "$dir" 2 "alpha one"
	git -C "$dir" checkout -q main
	git -C "$dir" checkout -q -b beta
	commit "$dir" 3 "beta one"
	git -C "$dir" checkout -q alpha
	merge "$dir" 4 "alpha takes beta" beta
	git -C "$dir" checkout -q beta
	merge "$dir" 5 "beta takes alpha" alpha~1
	git -C "$dir" checkout -q alpha
}

# --- 03: a merge whose first and second parents are both merges. -------------
build_03() {
	local dir
	dir=$(init_repo 03-merge-of-merges)
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b feed-a
	commit "$dir" 2 "feed a one"
	git -C "$dir" checkout -q main
	git -C "$dir" checkout -q -b feed-b
	commit "$dir" 3 "feed b one"
	git -C "$dir" checkout -q main
	git -C "$dir" checkout -q -b left
	commit "$dir" 4 "left one"
	merge "$dir" 5 "left takes feed a" feed-a
	git -C "$dir" checkout -q main
	git -C "$dir" checkout -q -b right
	commit "$dir" 6 "right one"
	merge "$dir" 7 "right takes feed b" feed-b
	git -C "$dir" checkout -q left
	merge "$dir" 8 "merge of two merges" right
}

# --- 04: four topic branches alive at once, contending for lanes. ------------
build_04() {
	local dir
	dir=$(init_repo 04-three-topics)
	commit "$dir" 1 "base one"
	commit "$dir" 2 "main two"
	local n
	for n in one two three four; do
		git -C "$dir" checkout -q -b "topic-$n" main~1
	done
	git -C "$dir" checkout -q topic-one
	commit "$dir" 3 "topic one work"
	git -C "$dir" checkout -q topic-two
	commit "$dir" 4 "topic two work"
	git -C "$dir" checkout -q topic-three
	commit "$dir" 5 "topic three work"
	git -C "$dir" checkout -q topic-four
	commit "$dir" 6 "topic four work"
	git -C "$dir" checkout -q main
}

# --- 05: three branches merged one after another into main. ------------------
build_05() {
	local dir
	dir=$(init_repo 05-sequential-merges)
	commit "$dir" 1 "base one"
	local n day=2
	for n in one two three; do
		git -C "$dir" checkout -q -b "feature-$n" main
		commit "$dir" $day "feature $n work"
		git -C "$dir" checkout -q main
		day=$((day + 1))
	done
	merge "$dir" 6 "main takes feature one" feature-one
	merge "$dir" 7 "main takes feature two" feature-two
	merge "$dir" 8 "main takes feature three" feature-three
}

# --- 06: the merge's second parent is newer than its first, so it sorts -------
# above it in the walk.
build_06() {
	local dir
	dir=$(init_repo 06-merge-second-parent-newer)
	commit "$dir" 1 "base one"
	commit "$dir" 2 "main two"
	git -C "$dir" checkout -q -b side main~1
	commit "$dir" 9 "side one is newest"
	git -C "$dir" checkout -q main
	merge "$dir" 10 "main takes side" side
}

# --- 07: a fork whose sibling tip sorts OLDER than the first-parent chain's ---
# next commit. Contrast with 08, which is the same shape sorting newer.
build_07() {
	local dir
	dir=$(init_repo 07-fork-sibling-older)
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b side
	commit "$dir" 2 "side tip"
	git -C "$dir" checkout -q main
	commit "$dir" 5 "main one"
	commit "$dir" 6 "main two"
}

# --- 08: 07's shape with the sibling tip sorting NEWER. ----------------------
build_08() {
	local dir
	dir=$(init_repo 08-fork-sibling-newer)
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b side
	commit "$dir" 7 "side tip"
	git -C "$dir" checkout -q main
	commit "$dir" 5 "main one"
	commit "$dir" 6 "main two"
}

# --- 09: enough live branches to push max_columns past the corpus's previous --
# maximum of 3. The orphan's root gives column 1 back part-way down, and the
# first lane tip below it takes the column over.
build_09() {
	local dir
	dir=$(init_repo 09-column-saturation)
	commit "$dir" 1 "base one"
	commit "$dir" 25 "main two"
	local n day=20
	for n in one two three four five; do
		git -C "$dir" checkout -q -b "lane-$n" main~1
		commit "$dir" $day "lane $n work"
		day=$((day - 1))
	done
	orphan_branch "$dir" orphan
	commit "$dir" 22 "orphan root"
	commit "$dir" 30 "orphan tip"
	git -C "$dir" checkout -q -f main
}

# --- 10: a merge whose second parent already sits LEFT of it, which is the ----
# only way graph.rs emits MergeLeft. The feature branch merges main, so the
# merge lands right of the HEAD lane while its second parent is on it.
build_10() {
	local dir
	dir=$(init_repo 10-merge-parent-left)
	commit "$dir" 1 "base one"
	commit "$dir" 2 "main two"
	git -C "$dir" checkout -q -b feature main~1
	commit "$dir" 3 "feature one"
	merge "$dir" 4 "feature takes main" main
	git -C "$dir" checkout -q main
}

# --- 11: a fork-out edge pointing left. The merge claims "shared point" at ----
# column 2 before alpha's chain reaches it from column 1, so at its own row the
# fork-in lane sits to its left.
build_11() {
	local dir
	dir=$(init_repo 11-fork-in-left)
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b shared
	commit "$dir" 2 "shared point"
	git -C "$dir" checkout -q -b alpha
	commit "$dir" 3 "alpha one"
	git -C "$dir" checkout -q main
	commit "$dir" 4 "main two"
	merge "$dir" 9 "main takes shared" shared
	git -C "$dir" checkout -q alpha
	commit "$dir" 10 "alpha two is newest"
	git -C "$dir" checkout -q main
}

# --- 12: a fork and a merge that a page boundary cuts mid-shape. -------------
build_12() {
	local dir
	dir=$(init_repo 12-pagination-boundary)
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b side main
	commit "$dir" 2 "side one"
	commit "$dir" 3 "side two"
	git -C "$dir" checkout -q main
	commit "$dir" 4 "main two"
	commit "$dir" 5 "main three"
	merge "$dir" 6 "main takes side" side
	commit "$dir" 7 "main four"
	git -C "$dir" checkout -q -b late main~2
	commit "$dir" 8 "late tip"
	git -C "$dir" checkout -q main
}

# --- 13: a freed column LEFT of a later allocation target, which is the only --
# geometry that reaches find_free_column_near's leftward spiral.
#
# `orphan` holds column 1 until its own root, which terminates the lane low in
# the walk. `gamma` hangs off the base and so keeps column 3 down to that root.
# `delta` then arrives below the orphan's root with its parent already pending
# at column 2: rightward is occupied all the way, so the search steps back to
# the column the orphan gave up.
build_13() {
	local dir
	dir=$(init_repo 13-freed-column-left)
	commit "$dir" 1 "base one"
	commit "$dir" 24 "main two"
	commit "$dir" 25 "main three"
	git -C "$dir" checkout -q -b beta main~2
	commit "$dir" 3 "beta bottom"
	commit "$dir" 29 "beta top"
	git -C "$dir" checkout -q -b gamma main~2
	commit "$dir" 28 "gamma tip"
	git -C "$dir" checkout -q -b delta beta~1
	commit "$dir" 4 "delta steps back to column one"
	orphan_branch "$dir" orphan
	commit "$dir" 5 "orphan root"
	commit "$dir" 30 "orphan tip"
	git -C "$dir" checkout -q -f main
}

# --- 14: the spiral must try the RIGHT of its target before the left. 13's ---
# geometry cannot tell the two apart: with column 3 occupied there, rightward
# and leftward both end at column 1. Drop `gamma` and column 3 is past the end
# of `active_lanes`, so the search extends rightward while column 1 sits free.
build_14() {
	local dir
	dir=$(init_repo 14-spiral-right-before-left)
	commit "$dir" 1 "base one"
	commit "$dir" 24 "main two"
	commit "$dir" 25 "main three"
	git -C "$dir" checkout -q -b beta main~2
	commit "$dir" 3 "beta bottom"
	commit "$dir" 29 "beta top"
	git -C "$dir" checkout -q -b delta beta~1
	commit "$dir" 4 "delta lands right of beta"
	orphan_branch "$dir" orphan
	commit "$dir" 5 "orphan root"
	commit "$dir" 30 "orphan tip"
	git -C "$dir" checkout -q -f main
}

for n in 01 02 03 04 05 06 07 08 09 10 11 12 13 14; do
	"build_$n"
	printf '  %s\n' "$OUT"/"$n"-*
done

printf '\nFixtures in %s\n' "$OUT"
