#!/usr/bin/env bash
#
# Capture every QA fixture repository as a committed golden-suite input.
#
#   scripts/graph-capture.sh
#
# Builds all three fixture corpora into a throwaway directory and writes one
# `src-tauri/tests/inputs/<corpus>-<name>.json` per repository. The golden suite reads
# those files, so nothing in `just check` builds a git repository any more — which is
# what lets `cargo mutants` run the suite at all.
#
# Rerun this after editing any `scripts/qa-*-fixtures.sh`. Nothing else notices such an
# edit: the inputs are committed, and the goldens are computed from the inputs.
#
# This is NOT `graph-accept`. Capturing rewrites the inputs the goldens are computed
# from, which is upstream of the goldens themselves — so a capture that moves a layout
# turns the suite red, and that redness is the signal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src-tauri/tests/inputs"

# The fixture scripts do not agree on git config isolation, and `worktree_dirty` decides
# stash lane assignment, not just the exported wip count. Capture freezes that value into
# a committed file, so both the build and the read run under one scrubbed environment.
SCRUB=(env -u GIT_EDITOR -u EDITOR -u VISUAL GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null)

CORPORA=(
	"qa-stash-fixtures.sh:stash"
	"qa-graph-lane-fixtures.sh:lane"
	"qa-graph-merge-fixtures.sh:merge"
)

# The fixture scripts never wipe their target, so a reused directory silently mixes
# corpora from different runs.
CORPUS="$(mktemp -d)"
trap 'rm -rf "$CORPUS"' EXIT

for entry in "${CORPORA[@]}"; do
	script="${entry%%:*}"
	subdir="${entry##*:}"
	"${SCRUB[@]}" "$ROOT/scripts/$script" "$CORPUS/$subdir" >/dev/null
done

"${SCRUB[@]}" cargo build --quiet --manifest-path "$ROOT/src-tauri/Cargo.toml" --example graph_capture

mkdir -p "$OUT"
written=0

for entry in "${CORPORA[@]}"; do
	subdir="${entry##*:}"
	for repo in "$CORPUS/$subdir"/*; do
		# The corpus directories hold non-repository files too; the bare fixture has no
		# `.git`, its HEAD sits at the top level.
		[ -d "$repo/.git" ] || [ -f "$repo/HEAD" ] || continue

		name="$(basename "$repo")"
		"${SCRUB[@]}" cargo run --quiet --manifest-path "$ROOT/src-tauri/Cargo.toml" \
			--example graph_capture -- "$repo" >"$OUT/$subdir-$name.json"
		written=$((written + 1))
	done
done

printf 'captured %d fixture inputs into %s\n' "$written" "${OUT#"$ROOT"/}"
