#!/usr/bin/env bash
#
# Build a repo whose merge conflicts exercise the merge editor's chrome.
#
#   scripts/qa-merge-conflict-fixture.sh [FIXTURE_DIR]
#
# The merge editor's conflict header bars can only be looked at when there is a
# conflict on screen, and every automated check the project has runs in jsdom,
# which computes no layout. So this builds the one thing a person needs in order
# to see them: a merge that stops with real conflicts, in a file long enough that
# several conflict headers are visible at once and can be compared against each
# other and against the bars above and below them.
#
# Three conflicts rather than one, spread down the file, because a single header
# has nothing to line up against — the defect this fixture exists to reveal was a
# bar rendering one pixel shorter than its neighbours, which is invisible until
# two of them sit in the same viewport.
#
# Re-run to reset: the script deletes and rebuilds the directory, and leaves the
# repo mid-merge so opening it goes straight to the conflicted state.
set -euo pipefail

DEST="${1:-${TMPDIR:-/tmp}/trunk-qa-merge-conflict}"
DEST="${DEST%/}"
WORK="$DEST/repo"

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

git init --quiet -b main "$WORK"
git -C "$WORK" config user.name "Trunk QA"
git -C "$WORK" config user.email "qa@example.invalid"

# The base. Three regions far enough apart that each becomes its own conflict
# rather than merging into one hunk, with filler between them so the editor has
# to scroll and the headers appear at different heights on screen.
cat >"$WORK/settings.ts" <<'BASE'
export const NAME = "trunk";
export const VERSION = "1.0.0";

const FILLER_A = 1;
const FILLER_B = 2;
const FILLER_C = 3;
const FILLER_D = 4;
const FILLER_E = 5;

export const TIMEOUT_MS = 1000;
export const RETRIES = 3;

const FILLER_F = 6;
const FILLER_G = 7;
const FILLER_H = 8;
const FILLER_I = 9;
const FILLER_J = 10;

export const THEME = "dark";
export const DENSITY = "comfortable";
BASE

printf '# Merge conflict fixture\n\nOpen this repo and merge `topic` into `main`.\n' >"$WORK/README.md"
git -C "$WORK" add -A
commit "Add settings and README"

# The branch. Each of the three regions is edited differently on each side, so
# every one of them conflicts.
git -C "$WORK" checkout --quiet -b topic
sed -i.bak \
	-e 's/export const VERSION = "1.0.0";/export const VERSION = "2.0.0-topic";/' \
	-e 's/export const TIMEOUT_MS = 1000;/export const TIMEOUT_MS = 5000;/' \
	-e 's/export const RETRIES = 3;/export const RETRIES = 10;/' \
	-e 's/export const THEME = "dark";/export const THEME = "midnight";/' \
	-e 's/export const DENSITY = "comfortable";/export const DENSITY = "compact";/' \
	"$WORK/settings.ts"
rm -f "$WORK/settings.ts.bak"
git -C "$WORK" add -A
commit "Retune settings on the topic branch"

git -C "$WORK" checkout --quiet main
sed -i.bak \
	-e 's/export const VERSION = "1.0.0";/export const VERSION = "1.1.0";/' \
	-e 's/export const TIMEOUT_MS = 1000;/export const TIMEOUT_MS = 2000;/' \
	-e 's/export const RETRIES = 3;/export const RETRIES = 5;/' \
	-e 's/export const THEME = "dark";/export const THEME = "slate";/' \
	-e 's/export const DENSITY = "comfortable";/export const DENSITY = "cozy";/' \
	"$WORK/settings.ts"
rm -f "$WORK/settings.ts.bak"
git -C "$WORK" add -A
commit "Retune the same settings on main"

# Leave the repo mid-merge, so opening it lands on the conflicted state rather
# than asking the operator to reproduce it by hand.
if git -C "$WORK" merge --no-edit topic >/dev/null 2>&1; then
	echo "error: the merge did not conflict — the fixture is not exercising anything" >&2
	exit 1
fi

CONFLICTS="$(git -C "$WORK" diff --name-only --diff-filter=U | wc -l | tr -d ' ')"
printf 'Fixture ready: %s\n' "$WORK"
printf '  %s conflicted file(s), mid-merge.\n\n' "$CONFLICTS"
printf 'Open it in Trunk, click the conflicted file, and compare the "Conflict 1/2/3"\n'
printf 'header bars against each other and against the pane bars around them.\n'
