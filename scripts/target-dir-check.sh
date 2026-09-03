#!/usr/bin/env bash
# Prove `just --evaluate target` resolves the three ways the build depends on.
#
# The derivation lives in one line of the justfile and decides which directory
# every cargo invocation writes to. Getting it wrong is not a visible failure:
# a session silently shares another's dir and waits on its build lock, or CI
# builds somewhere it does not expect. Neither shows up as a test failure
# anywhere else, so the recipe asserts it directly — the same shape as
# `toolchain-parity`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shared="$ROOT/src-tauri/target"
failures=0

# Each case runs `just --evaluate target` under a constructed environment.
# `env -u` rather than `unset` so nothing leaks in from the caller's shell:
# this script is run by sessions that have TRUNK_CARD set.
evaluate() {
    env -u CARGO_TARGET_DIR -u TRUNK_CARD "$@" \
        just --justfile "$ROOT/justfile" --evaluate target
}

expect() {
    local what="$1" want="$2" got="$3"
    if [ "$got" != "$want" ]; then
        echo "::error::$what: expected '$want', got '$got'"
        failures=$((failures + 1))
    fi
}

# A plain shell and CI carry neither variable. They must keep using the shared
# dir, or CI caches miss and every contributor's paths move.
expect "no card and no override" \
    "$shared" \
    "$(evaluate)"

# A session working a card gets a dir of its own, derived with no hand-export.
expect "a card keys its own dir" \
    "$ROOT/src-tauri/target-cards/trunk-139" \
    "$(evaluate TRUNK_CARD=trunk-139)"

# Two cards must never resolve to one dir; that is the whole point.
a="$(evaluate TRUNK_CARD=trunk-1)"
b="$(evaluate TRUNK_CARD=trunk-2)"
if [ "$a" = "$b" ]; then
    echo "::error::two different cards resolved to the same dir '$a'"
    failures=$((failures + 1))
fi

# An explicit CARGO_TARGET_DIR is how CI and one-off runs pin the location.
# It has to outrank the card, or a session working a card cannot be directed
# anywhere else.
expect "an explicit override outranks the card" \
    "/tmp/pinned-target" \
    "$(evaluate CARGO_TARGET_DIR=/tmp/pinned-target TRUNK_CARD=trunk-139)"

# An exported-but-empty TRUNK_CARD means "no card", not a malformed one. A
# shell profile that exports it unconditionally must not break a plain build.
expect "an empty card is treated as no card" \
    "$shared" \
    "$(evaluate TRUNK_CARD=)"

# A card name reaches the filesystem as a path segment. Anything that could
# escape target-cards/ must abort: falling back to the shared dir would leave a
# session waiting on another's build lock while believing it was isolated.
for bad in "../escape" "a/b" "." "with space" 'semi;colon'; do
    if got="$(evaluate TRUNK_CARD="$bad" 2>&1)"; then
        echo "::error::card name '$bad' was accepted, resolving to '$got'"
        failures=$((failures + 1))
    fi
done

if [ "$failures" -ne 0 ]; then
    echo "::error::target dir derivation is wrong in $failures case(s); see justfile 'target'"
    exit 1
fi
echo "target dir derivation: all cases hold"
