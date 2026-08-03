#!/usr/bin/env bash
#
# Dump the graph layout of every QA stash fixture, one text file per repo.
#
#   scripts/qa-stash-probe.sh OUTPUT_DIR [FIXTURE_DIR]
#
# The fixtures are built from fixed timestamps, so two runs over an unchanged
# tree are byte-identical: capture a baseline before a change, capture again
# after, and `diff -r` the two directories to see exactly which fixtures moved.
set -euo pipefail

OUT="${1:?usage: scripts/qa-stash-probe.sh OUTPUT_DIR [FIXTURE_DIR]}"
FIXTURES="${2:-${TMPDIR:-/tmp}/trunk-qa-stash}"
OUT="${OUT%/}"
FIXTURES="${FIXTURES%/}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/src-tauri/Cargo.toml"

if [ ! -d "$FIXTURES" ]; then
	echo "no fixtures at $FIXTURES — run scripts/qa-stash-fixtures.sh first" >&2
	exit 1
fi

cargo build --quiet --manifest-path "$MANIFEST" --example graph_probe

mkdir -p "$OUT"
for repo in "$FIXTURES"/*/; do
	repo="${repo%/}"
	name="$(basename "$repo")"
	if [ ! -d "$repo/.git" ] && [ ! -f "$repo/HEAD" ]; then
		continue
	fi
	cargo run --quiet --manifest-path "$MANIFEST" --example graph_probe -- "$repo" \
		>"$OUT/$name.txt"
	printf '  %s\n' "$name"
done

printf '\nLayouts in %s\n' "$OUT"
