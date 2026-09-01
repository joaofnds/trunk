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
# That byte-identity is why the probe reads under an isolated git config. The
# layout it dumps includes worktree dirtiness, which consults core.excludesFile,
# core.fileMode and core.autocrlf — so without this an edit to the operator's
# global config moves a fixture in the diff with no code change at all.
set -euo pipefail

SCRUB=(env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null)

OUT="${1:?usage: scripts/qa-stash-probe.sh OUTPUT_DIR [FIXTURE_DIR]}"
FIXTURES="${2:-${TRUNK_FIXTURES:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/trunk-test-cases}/repos/stash-lanes}"
OUT="${OUT%/}"
FIXTURES="${FIXTURES%/}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/src-tauri/Cargo.toml"

if [ ! -d "$FIXTURES" ]; then
	echo "no fixtures at $FIXTURES — build them with ./build 06-stash-lanes in the trunk-test-cases repository, or pass their directory as the second argument" >&2
	exit 1
fi

"${SCRUB[@]}" cargo build --quiet --manifest-path "$MANIFEST" --example graph_probe

mkdir -p "$OUT"
for repo in "$FIXTURES"/*/; do
	repo="${repo%/}"
	name="$(basename "$repo")"
	if [ ! -d "$repo/.git" ] && [ ! -f "$repo/HEAD" ]; then
		continue
	fi
	"${SCRUB[@]}" cargo run --quiet --manifest-path "$MANIFEST" --example graph_probe -- "$repo" \
		>"$OUT/$name.txt"
	printf '  %s\n' "$name"
done

printf '\nLayouts in %s\n' "$OUT"
