#!/usr/bin/env bash
#
# Capture every QA fixture repository as a committed golden-suite input.
#
#   scripts/graph-capture.sh
#
# Builds the three graph corpora from the trunk-fixtures crate into a throwaway
# directory and writes one `src-tauri/tests/inputs/<corpus>-<name>.json` per repository.
# The golden suite reads those files, so nothing in `just check` builds a git repository
# any more — which is what makes a hand-applied mutation cycle cheap enough to sweep
# (`just graph-sweep`).
#
# Then rebuilds the named-rule shapes — the repositories `test_graph.rs`'s placement tests
# used to build inline — and writes `src-tauri/tests/rule-inputs/<shape>.json`. Those inputs
# are deliberately outside the golden corpus: they feed hand-asserted rule tests, not
# goldens, and `test_graph_goldens.rs` demands a golden and an export for everything in
# `tests/inputs/`.
#
# Rerun this after editing a graph case in `src-tauri/fixtures/src/cases/` (`graph_lanes.rs`,
# `graph_merges.rs`, `stash_lanes.rs`), or any shape in
# `src-tauri/tests/common/graph_shapes.rs` or `src-tauri/tests/test_graph_capture.rs`.
# Nothing else notices such an edit: the inputs are committed, and the goldens are computed
# from the inputs. `just graph-fidelity` is the check that a rule input still equals a fresh
# capture of its repository.
#
# This is NOT `graph-accept`. Capturing rewrites the inputs the goldens are computed
# from, which is upstream of the goldens themselves — so a capture that moves a layout
# turns the suite red, and that redness is the signal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src-tauri/tests/inputs"
MANIFEST="$ROOT/src-tauri/Cargo.toml"
TARGET="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"

# The capture reads `worktree_dirty`, which decides stash lane assignment, and libgit2
# reads the operator's ~/.gitconfig through HOME whatever GIT_CONFIG_GLOBAL says
# (TRUNK-109). The crate isolates its own builds; the capture example does not, so it
# runs under a HOME with nothing in it. Only the example: mise and rustup locate their
# own configuration through HOME, so the cargo invocations keep the real one.
SCRUB=(env -u GIT_EDITOR -u EDITOR -u VISUAL)
ISOLATED=(env -u XDG_CONFIG_HOME)

CORPORA=(
	"stash-lanes:stash"
	"graph-lanes:lane"
	"graph-merges:merge"
)

EMPTY_HOME="$(mktemp -d)"
trap 'rm -rf "$EMPTY_HOME"' EXIT
CORPUS="$(mktemp -d)"
trap 'rm -rf "$CORPUS" "$EMPTY_HOME"' EXIT

"${SCRUB[@]}" cargo run --quiet --manifest-path "$MANIFEST" -p trunk-fixtures -- \
	build 04-graph-lanes 05-graph-merges 06-stash-lanes --out "$CORPUS" >/dev/null

"${SCRUB[@]}" cargo build --quiet --manifest-path "$MANIFEST" --example graph_capture

mkdir -p "$OUT"
written=0

for entry in "${CORPORA[@]}"; do
	subdir="${entry%%:*}"
	prefix="${entry##*:}"
	for repo in "$CORPUS/$subdir"/*; do
		# The corpus directories hold non-repository files too; the bare fixture has no
		# `.git`, its HEAD sits at the top level.
		[ -d "$repo/.git" ] || [ -f "$repo/HEAD" ] || continue

		name="$(basename "$repo")"
		"${ISOLATED[@]}" HOME="$EMPTY_HOME" "$TARGET/debug/examples/graph_capture" "$repo" >"$OUT/$prefix-$name.json"
		written=$((written + 1))
	done
done

# The three corpora hold 48 repositories. Fewer means a corpus directory was renamed
# in the crate and the glob above walked past it, leaving stale inputs committed.
if [ "$written" -ne 48 ]; then
	echo "captured $written fixture inputs, expected 48: a corpus directory under the crate no longer matches CORPORA" >&2
	exit 1
fi

printf 'captured %d fixture inputs into %s\n' "$written" "${OUT#"$ROOT"/}"

# The named-rule shapes are built by `TestContext::builder` and raw git2, not by a fixture
# case, so a test binary writes them: `tests/common` is not part of the library an example
# links against.
"${SCRUB[@]}" TRUNK_CAPTURE_GRAPH_INPUTS=1 cargo test --quiet \
	--manifest-path "$MANIFEST" --test test_graph_capture -- --ignored >/dev/null

printf 'captured the named-rule inputs into %s\n' "src-tauri/tests/rule-inputs"
