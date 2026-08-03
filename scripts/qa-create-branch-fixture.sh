#!/usr/bin/env bash
#
# Build the fixture repo for the create_branch -> dirty_workdir manual walk.
#
#   scripts/qa-create-branch-fixture.sh [FIXTURE_DIR]
#
# Five call sites answer one backend outcome four different ways, and no
# automated test covers any of them. This builds a repo that reaches all five:
# an origin carrying two remote-only branches, so both remote-checkout gestures
# have something to click, and a working tree dirty in the one way the backend
# actually counts.
#
# That last part is the trap. `is_repo_dirty` (src-tauri/src/git/repository.rs:7)
# passes `include_untracked(false)`, so a fixture whose only change is an
# untracked file reads CLEAN and every gesture below takes the success path
# instead — the walk would look like it passed while testing nothing. The dirt
# here is a modified tracked file.
#
# Re-run to reset: each gesture creates a branch even when the checkout is
# skipped, and `create_branch` refuses a name that already exists, so a second
# pass over a used fixture reports "branch exists" rather than dirty_workdir.
set -euo pipefail

DEST="${1:-${TMPDIR:-/tmp}/trunk-qa-create-branch}"
DEST="${DEST%/}"
WORK="$DEST/repo"
ORIGIN="$DEST/origin.git"

# Build under a neutral config so the operator's global settings — gpgsign,
# init.defaultBranch, commit hooks — cannot change the fixture's shape.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

# Same-second commits sort arbitrarily under the graph's TOPOLOGICAL|TIME
# revwalk, which can render a coincidentally-correct layout. Space them.
STAMP=1750000000

commit() {
	local msg="$1"
	STAMP=$((STAMP + 3600))
	local when
	when="$(date -u -r "$STAMP" +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || date -u -d "@$STAMP" +"%Y-%m-%dT%H:%M:%S")"
	GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" \
		git -C "$WORK" commit --quiet -m "$msg"
}

rm -rf "$DEST"
mkdir -p "$DEST"

git init --quiet --bare -b main "$ORIGIN"
git init --quiet -b main "$WORK"
git -C "$WORK" config user.name "Trunk QA"
git -C "$WORK" config user.email "qa@example.invalid"
git -C "$WORK" remote add origin "$ORIGIN"

printf '# Fixture\n\nA repo for the create_branch walk.\n' >"$WORK/README.md"
printf 'export const VERSION = "0.1.0";\n' >"$WORK/version.ts"
git -C "$WORK" add -A
commit "Add README and version"

for n in 1 2 3; do
	printf 'export const STEP_%d = %d;\n' "$n" "$n" >>"$WORK/version.ts"
	git -C "$WORK" add -A
	commit "Extend version with step $n"
done

# Two remote-only branches: pushed to origin, then deleted locally, so they
# appear under Remote in the sidebar and as remote ref pills in the graph.
for branch in feature/alpha feature/beta; do
	git -C "$WORK" checkout --quiet -b "$branch"
	printf 'export const %s = true;\n' "$(echo "$branch" | tr 'a-z/' 'A-Z_')" \
		>>"$WORK/version.ts"
	git -C "$WORK" add -A
	commit "Work on $branch"
	git -C "$WORK" push --quiet origin "$branch"
	git -C "$WORK" checkout --quiet main
	git -C "$WORK" branch --quiet -D "$branch"
done

git -C "$WORK" push --quiet -u origin main

# The dirt: a MODIFIED TRACKED file. Untracked would not count.
printf '\nAn uncommitted edit. Do not commit this — it is the fixture.\n' >>"$WORK/README.md"

cat >"$DEST/WALKTHROUGH.md" <<'WALK'
# create_branch -> dirty_workdir: manual walk

Open the repo at `repo/` in Trunk (the **dev** build — `just dev`; a computer-use
click activates the installed app, not `target/debug/trunk`).

**Before you start**, confirm the fixture is actually dirty:

    git -C repo status --short      # expect exactly:  M README.md

If that line is missing, stop — every gesture below will take the success path
and the walk proves nothing.

Backend behaviour being exercised: `create_branch` creates the branch, THEN
checks the working tree, and returns `dirty_workdir` with the branch already
created and HEAD unmoved (`src-tauri/src/commands/branches.rs:386-397`). All
five sites below receive that same outcome. They answer it four different ways.

Record what you see in the "Observed" column. Any difference from "Expected" is
a regression introduced by the error-reporting sweep.

| # | Gesture | Expected today | Observed |
|---|---------|----------------|----------|
| 1 | Sidebar -> Remote -> click `feature/alpha` | **RED** error toast reading "Branch created but working tree has uncommitted changes — checkout skipped". Local `feature/alpha` IS created but does **not** appear in the sidebar. | |
| 2 | Sidebar -> new-branch input -> `qa-sidebar` | **GREEN** toast "Branch created (checkout skipped — uncommitted changes)". `qa-sidebar` **appears** in the sidebar. | |
| 3 | Toolbar branch button -> `qa-toolbar` | **GREEN** toast, identical copy. `qa-toolbar` does **not** appear until something else refreshes. | |
| 4 | Graph -> right-click any commit -> Create Branch -> `qa-graph` | **GREEN** toast, identical copy. `qa-graph` does **not** appear until refresh. No modal. | |
| 5 | Graph -> click the `origin/feature/beta` ref pill | **RED** error toast, same message as #1. Local `feature/beta` created, not shown. | |

Three of the five report success for an outcome the other two report as failure,
and three of the five leave a branch the user cannot see. That asymmetry is the
CURRENT behaviour and is what this walk pins — it is not what you are being
asked to judge.

Confirm the branches really were created, despite what the UI said:

    git -C repo branch --list

Expect all five: `feature/alpha`, `feature/beta`, `qa-graph`, `qa-sidebar`,
`qa-toolbar` — plus `main`, which is still HEAD.

## Control: the clean path

Prove the fixture was the variable, not the app:

    git -C repo checkout -- README.md
    git -C repo status --short      # expect: no output

Now repeat gesture 2 with a fresh name, e.g. `qa-clean`. Expect a **GREEN**
toast reading "Checked out qa-clean", and HEAD moves to it. Different copy from
the dirty path — that is how you know the dirty path was really taken above.

## Reset

Re-run the builder. Each gesture leaves a branch behind even when the checkout
is skipped, and `create_branch` refuses an existing name, so a second pass over
a used fixture reports "branch exists" instead of `dirty_workdir`.
WALK

printf 'fixture ready\n\n'
printf '  repo:        %s\n' "$WORK"
printf '  origin:      %s\n' "$ORIGIN"
printf '  walkthrough: %s\n\n' "$DEST/WALKTHROUGH.md"
printf 'working tree (must show a modified tracked file):\n'
git -C "$WORK" status --short
printf '\nremote-only branches:\n'
git -C "$WORK" branch -r
