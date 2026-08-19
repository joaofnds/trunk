#!/usr/bin/env bash
#
# Accept a new commit-graph layout as intended, recording why.
#
#   scripts/graph-accept.sh "the reason this layout changed"
#
# Refuses without a reason. A graph golden that moves is a suspected defect until
# someone writes down why it is not; regenerating without that note destroys the
# only signal the goldens exist to produce.
set -euo pipefail

REASON="${1:-}"
if [ -z "$REASON" ]; then
	cat >&2 <<-'MSG'
		refusing to regenerate: no reason given.

		A red graph golden is a suspected defect, not a stale artifact. Investigate
		first. If the new layout is genuinely intended, say why:

		    just graph-accept "second parent now sorts above the first, per <decision>"
	MSG
	exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG="$ROOT/docs/commit-graph-changelog.md"

if [ ! -f "$CHANGELOG" ]; then
	printf '# Commit graph — accepted layout changes\n\nEach entry records a deliberate change to the pinned layout, and why it was accepted.\nWritten by `scripts/graph-accept.sh`; see `.claude/rules/commit-graph.md`.\n' >"$CHANGELOG"
fi

# The layout the backend computes, and the render the frontend paints from it.
# Both halves of the guarantee move together, so both are accepted under one reason.
GOLDEN_DIRS=("src-tauri/tests/goldens" "src/__tests__/goldens/graph-render")

# Content, not `git status`: a brand-new golden is untracked, so counting status
# lines reports a change on every run and records a reason for nothing.
fingerprint() {
	local dir
	for dir in "${GOLDEN_DIRS[@]}"; do
		# Absent on the run that first creates it, which is not a drift signal.
		[ -d "$ROOT/$dir" ] || continue
		find "$ROOT/$dir" -type f \( -name '*.txt' -o -name '*.json' \) -exec shasum {} +
	done | sed "s|$ROOT/||" | sort | shasum | cut -d' ' -f1
}

BEFORE="$(fingerprint)"

TRUNK_ACCEPT_GRAPH_GOLDENS=1 \
	env -u GIT_EDITOR -u EDITOR -u VISUAL GIT_CONFIG_GLOBAL=/dev/null \
	cargo test --quiet --manifest-path "$ROOT/src-tauri/Cargo.toml" \
	--test test_graph_goldens matches_its_committed

# After the exports, never before: the render goldens are taken from them.
(
	cd "$ROOT"
	TRUNK_ACCEPT_GRAPH_GOLDENS=1 \
		bun run test -- --run src/components/CommitGraph.render.test.ts
)

if [ "$BEFORE" = "$(fingerprint)" ]; then
	echo "no golden changed; nothing recorded." >&2
	exit 0
fi

{
	printf '\n## %s\n\n%s\n\nChanged goldens:\n\n' "$(date -u '+%Y-%m-%d')" "$REASON"
	git -C "$ROOT" status --porcelain --untracked-files=all "${GOLDEN_DIRS[@]}" |
		sed 's/^/    /'
} >>"$CHANGELOG"

printf '\nRecorded in %s\n' "${CHANGELOG#"$ROOT"/}"
