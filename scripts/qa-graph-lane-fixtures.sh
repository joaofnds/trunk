#!/usr/bin/env bash
#
# Build the QA fixture repositories for HEAD-lane placement of commits that
# descend from the checked-out commit.
#
#   scripts/qa-graph-lane-fixtures.sh [OUTPUT_DIR]
#
# Every repository is rebuilt from scratch. Commit timestamps are explicit and
# spaced a day apart: the graph sorts with TOPOLOGICAL | TIME, so same-second
# commits sort arbitrarily and can render a coincidentally-correct layout.
#
# Global git config is isolated. Without that an ambient commit.gpgsign makes
# every run produce different OIDs, and hooks and templates leak in.
set -euo pipefail

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

OUT="${1:-${TMPDIR:-/tmp}/trunk-qa-graph-lane}"
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

# commit_split <repo> <author-day> <committer-day> <message>
# Author and committer dates disagree, as they do after a rebase or amend.
commit_split() {
	local dir="$1" ats=$((BASE + $2 * DAY)) cts=$((BASE + $3 * DAY)) msg="$4"
	echo "$msg" >"$dir/$(slug "$msg").txt"
	git -C "$dir" add -A
	GIT_AUTHOR_DATE="@$ats +0000" GIT_COMMITTER_DATE="@$cts +0000" \
		git -C "$dir" commit -qm "$msg"
}

# stash <repo> <day> <message> — needs a modification already in the worktree
stash() {
	local dir="$1" ts=$((BASE + $2 * DAY)) msg="$3"
	GIT_AUTHOR_DATE="@$ts +0000" GIT_COMMITTER_DATE="@$ts +0000" \
		git -C "$dir" stash push -q -m "$msg"
}

# add_remote <repo> <remote-name>
add_remote() {
	local dir="$1" name="$2" bare
	bare="$OUT/.remotes/$(basename "$dir")-$name.git"
	rm -rf "$bare"
	mkdir -p "$(dirname "$bare")"
	git init -q --bare "$bare"
	git -C "$dir" remote add "$name" "$bare"
}

# --- 01: the reported bug. main is 3 behind origin/main, 0 ahead. ------------
build_01() {
	local dir
	dir=$(init_repo 01-behind-only)
	add_remote "$dir" origin
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" push -q -u origin main
	commit "$dir" 3 "upstream three"
	commit "$dir" 4 "upstream four"
	commit "$dir" 5 "upstream five"
	git -C "$dir" push -q origin main
	git -C "$dir" reset -q --hard HEAD~3
	git -C "$dir" fetch -q origin
}

# --- 02: same shape, no remotes at all. HEAD on old, new is 2 ahead. --------
build_02() {
	local dir
	dir=$(init_repo 02-local-ahead-no-remote)
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" branch -M old
	git -C "$dir" checkout -q -b new
	commit "$dir" 3 "new one"
	commit "$dir" 4 "new two"
	git -C "$dir" checkout -q old
}

# --- 03: detached HEAD several commits below every branch tip. --------------
build_03() {
	local dir
	dir=$(init_repo 03-detached-old)
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	commit "$dir" 3 "main three"
	commit "$dir" 4 "main four"
	git -C "$dir" checkout -q --detach "$(git -C "$dir" rev-parse main~3)"
}

# --- 04: two chains contend for the lane above HEAD. ------------------------
# origin/main is 3 ahead; local topic is 2 commits off the same tip.
build_04() {
	local dir
	dir=$(init_repo 04-tiebreak-upstream-vs-topic)
	add_remote "$dir" origin
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" push -q -u origin main
	commit "$dir" 3 "upstream three"
	commit "$dir" 4 "upstream four"
	commit "$dir" 5 "upstream five"
	git -C "$dir" push -q origin main
	git -C "$dir" reset -q --hard HEAD~3
	git -C "$dir" checkout -q -b topic
	commit "$dir" 6 "topic one"
	commit "$dir" 7 "topic two"
	git -C "$dir" checkout -q main
	git -C "$dir" fetch -q origin
}

# --- 05: diverged. main is 2 ahead and 2 behind. The DAG really forks. ------
build_05() {
	local dir
	dir=$(init_repo 05-diverged)
	add_remote "$dir" origin
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" push -q -u origin main
	commit "$dir" 3 "upstream three"
	commit "$dir" 4 "upstream four"
	git -C "$dir" push -q origin main
	git -C "$dir" reset -q --hard HEAD~2
	commit "$dir" 5 "local five"
	commit "$dir" 6 "local six"
	git -C "$dir" fetch -q origin
}

# --- 06: a chain whose only ref is a tag, descending from HEAD's tip. -------
build_06() {
	local dir
	dir=$(init_repo 06-tag-only-chain)
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" checkout -q -b scratch
	commit "$dir" 3 "released one"
	commit "$dir" 4 "released two"
	git -C "$dir" tag v1.0.0
	git -C "$dir" checkout -q main
	git -C "$dir" branch -q -D scratch
}

# --- 07: a tag sitting on an unpulled commit. ------------------------------
build_07() {
	local dir
	dir=$(init_repo 07-tag-on-unpulled)
	add_remote "$dir" origin
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" push -q -u origin main
	commit "$dir" 3 "upstream three"
	commit "$dir" 4 "upstream four"
	git -C "$dir" tag v2.0.0 HEAD~1
	git -C "$dir" push -q origin main
	git -C "$dir" reset -q --hard HEAD~2
	git -C "$dir" fetch -q origin
}

# --- 08: a stash on the HEAD tip while main is behind its upstream. --------
# Worktree is left clean, so today's rules want the stash inline at column 0 —
# the same column the unpulled commits would move into.
build_08() {
	local dir
	dir=$(init_repo 08-stash-on-tip-behind)
	add_remote "$dir" origin
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" push -q -u origin main
	commit "$dir" 3 "upstream three"
	commit "$dir" 4 "upstream four"
	git -C "$dir" push -q origin main
	git -C "$dir" reset -q --hard HEAD~2
	echo "half-finished" >"$dir/$(slug "base two").txt"
	stash "$dir" 9 "half-finished work"
	git -C "$dir" fetch -q origin
}

# --- 09: contention at a commit BELOW HEAD, plus an unpulled chain above. ---
build_09() {
	local dir
	dir=$(init_repo 09-branch-point-below-head)
	add_remote "$dir" origin
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" push -q -u origin main
	git -C "$dir" checkout -q -b feature
	commit "$dir" 3 "feature one"
	commit "$dir" 4 "feature two"
	git -C "$dir" push -q -u origin feature
	git -C "$dir" checkout -q main
	commit "$dir" 5 "upstream five"
	commit "$dir" 6 "upstream six"
	git -C "$dir" push -q origin main
	git -C "$dir" reset -q --hard HEAD~2
	git -C "$dir" fetch -q origin
}

# --- 10: two remotes both carrying main. Only origin is the upstream. ------
build_10() {
	local dir
	dir=$(init_repo 10-two-remotes)
	add_remote "$dir" origin
	add_remote "$dir" upstream
	commit "$dir" 1 "base one"
	commit "$dir" 2 "base two"
	git -C "$dir" push -q -u origin main
	git -C "$dir" push -q upstream main
	commit "$dir" 3 "shared three"
	commit "$dir" 4 "shared four"
	git -C "$dir" push -q origin main
	git -C "$dir" push -q upstream main
	git -C "$dir" reset -q --hard HEAD~2
	git -C "$dir" fetch -q origin
	git -C "$dir" fetch -q upstream
}

# --- 11: a merge commit inside the HEAD chain, with an unpulled chain above -
build_11() {
	local dir
	dir=$(init_repo 11-merge-in-head-chain)
	add_remote "$dir" origin
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b side
	commit "$dir" 2 "side one"
	git -C "$dir" checkout -q main
	commit "$dir" 3 "main two"
	GIT_AUTHOR_DATE="@$((BASE + 4 * DAY)) +0000" GIT_COMMITTER_DATE="@$((BASE + 4 * DAY)) +0000" \
		git -C "$dir" merge -q --no-ff side -m "merge side into main"
	git -C "$dir" push -q -u origin main
	commit "$dir" 5 "upstream five"
	commit "$dir" 6 "upstream six"
	git -C "$dir" push -q origin main
	git -C "$dir" reset -q --hard HEAD~2
	git -C "$dir" fetch -q origin
}

# --- 12: two chains off a detached HEAD whose author and committer order --
# disagree. `beta` is the newer commit; `alpha` is the newer-looking one.
build_12() {
	local dir
	dir=$(init_repo 12-author-vs-committer)
	commit "$dir" 1 "base one"
	git -C "$dir" checkout -q -b alpha
	commit_split "$dir" 30 2 "alpha tip looks newest"
	git -C "$dir" checkout -q main
	git -C "$dir" checkout -q -b beta
	commit_split "$dir" 2 20 "beta tip is newest"
	git -C "$dir" checkout -q --detach main
}

# --- 13: a chain taller than jsdom's 22-row virtual-list cap. ---------------
# Placement here is trivial by design. It exists so the render suite has one
# fixture whose golden goes red when the viewport height stub is dropped; every
# other fixture is short enough to render identically truncated or not.
build_13() {
	local dir day
	dir=$(init_repo 13-tall-linear)
	for day in $(seq 1 30); do
		commit "$dir" "$day" "tall $(printf '%02d' "$day")"
	done
}

for n in 01 02 03 04 05 06 07 08 09 10 11 12 13; do
	"build_$n"
	printf '  %s\n' "$OUT"/"$n"-*
done

printf '\nFixtures in %s\n' "$OUT"
