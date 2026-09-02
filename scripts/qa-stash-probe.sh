#!/usr/bin/env bash
#
# Dump the graph layout of every QA stash fixture, one text file per repo.
#
#   scripts/qa-stash-probe.sh OUTPUT_DIR [FIXTURE_DIR]
#
# The fixtures are built from fixed timestamps, so two runs over an unchanged
# tree are byte-identical: capture a baseline before a change, capture again
# after, and `diff -r` the two directories to see exactly which fixtures moved.
#
# That byte-identity is why the probe runs under a HOME with nothing in it. The
# layout it dumps includes worktree dirtiness, which consults core.excludesFile,
# core.fileMode and core.autocrlf, and libgit2 reads the operator's ~/.gitconfig
# through HOME whatever GIT_CONFIG_GLOBAL says (TRUNK-109) — so without this an
# edit to the operator's global config moves a fixture in the diff with no code
# change at all. Only the probe runs there: mise and rustup locate their own
# configuration through HOME, so the cargo build keeps the real one.
set -euo pipefail

OUT="${1:?usage: scripts/qa-stash-probe.sh OUTPUT_DIR [FIXTURE_DIR]}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="${2:-$ROOT/repos/stash-lanes}"
OUT="${OUT%/}"
FIXTURES="${FIXTURES%/}"

MANIFEST="$ROOT/src-tauri/Cargo.toml"
TARGET="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"

if [ ! -d "$FIXTURES" ]; then
	echo "no fixtures at $FIXTURES — build them with 'just fixtures 06-stash-lanes', or pass their directory as the second argument" >&2
	exit 1
fi

cargo build --quiet --manifest-path "$MANIFEST" --example graph_probe
EMPTY_HOME="$(mktemp -d)"
trap 'rm -rf "$EMPTY_HOME"' EXIT

mkdir -p "$OUT"
for repo in "$FIXTURES"/*/; do
	repo="${repo%/}"
	name="$(basename "$repo")"
	if [ ! -d "$repo/.git" ] && [ ! -f "$repo/HEAD" ]; then
		continue
	fi
	env -u XDG_CONFIG_HOME HOME="$EMPTY_HOME" "$TARGET/debug/examples/graph_probe" "$repo" >"$OUT/$name.txt"
	printf '  %s\n' "$name"
done

printf '\nLayouts in %s\n' "$OUT"
