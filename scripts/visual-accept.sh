#!/usr/bin/env bash
#
# Accept changed visual baselines as intended, recording why.
#
#   scripts/visual-accept.sh "the reason these captures changed"
#
# Refuses without a reason. A visual baseline that moves is a suspected defect
# until someone has looked at the difference and written down why it is not.
set -euo pipefail

REASON="${1:-}"
if [ -z "$REASON" ]; then
	cat >&2 <<-'MSG'
		refusing to accept: no reason given.

		A differing capture is a break until someone has looked at it. Open the
		difference images `just visual` wrote to tests/visual/differences/ first.
		If the new rendering is intended, say why:

		    just visual-accept "rails now fade under clamped dots, per <decision>"

		Never set TRUNK_ACCEPT_VISUAL_BASELINES by hand, and accept only at the
		user's explicit direction.
	MSG
	exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG="$ROOT/docs/visual-baseline-changelog.md"
BASELINES="tests/visual/baselines"

if [ ! -f "$CHANGELOG" ]; then
	printf '# Visual baselines: accepted changes\n\nEach entry records a deliberate change to the committed captures, and why it was accepted.\nWritten by `scripts/visual-accept.sh`; see `docs/visual-regression.md`.\n' >"$CHANGELOG"
fi

# Content, not `git status`: a brand-new baseline is untracked, so counting status
# lines reports a change on every run and records a reason for nothing.
fingerprint() {
	[ -d "$ROOT/$BASELINES" ] || return 0
	find "$ROOT/$BASELINES" -type f -name '*.png' -exec shasum {} + |
		sed "s|$ROOT/||" | sort
}

BEFORE="$(fingerprint)"

# A run that fails part way has still rewritten the baselines it reached, so the
# changelog records them before the failure is reported.
STATUS=0
(cd "$ROOT" && TRUNK_ACCEPT_VISUAL_BASELINES=1 just visual) || STATUS=$?

# `comm`, not `diff`: diff exits 1 when it finds a change, which pipefail turns
# into an abort before anything is recorded.
CHANGED="$(comm -13 <(printf '%s\n' "$BEFORE") <(fingerprint) |
	sed 's/^[0-9a-f]*  //' | sort)"
if [ -z "$CHANGED" ]; then
	echo "no baseline changed; nothing recorded." >&2
	exit "$STATUS"
fi

{
	printf '\n## %s\n\n%s\n' "$(date -u '+%Y-%m-%d')" "$REASON"
	if [ "$STATUS" -ne 0 ]; then
		printf '\nThe accepting run failed part way, so these are only the baselines it reached.\n'
	fi
	printf '\nChanged baselines:\n\n'
	printf '%s\n' "$CHANGED" | sed 's/^/    /'
} >>"$CHANGELOG"

if [ "$STATUS" -ne 0 ]; then
	printf '\nThe accepting run failed. Recorded the baselines it rewrote in %s.\n' "${CHANGELOG#"$ROOT"/}" >&2
	exit "$STATUS"
fi

rm -rf "$ROOT/tests/visual/differences"
printf '\nRecorded in %s. Review the image diff of %s before committing.\n' "${CHANGELOG#"$ROOT"/}" "$BASELINES"
