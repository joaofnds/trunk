# Cutting a release

`just release <version>` is the only way to bump the app's version. Tauri names every
bundle from `src-tauri/tauri.conf.json`'s `version` field, and the release workflow
(`.github/workflows/release.yml`) reads the same field into `TAURI_VERSION` to build the
DMG asset URLs it downloads — a version that only ever changes by hand drifts from the
tag the moment someone forgets the manual step, which is what left every release between
early development and 2026-09 shipping DMGs named `trunk_0.12.8_*.dmg` regardless of tag.

## What it does

1. Refuses if the working tree is dirty (`git status --porcelain`), so a tag is always
   cut from exactly what it claims to ship.
2. Refuses if `<version>` is not a strict increment over the version currently in
   `src-tauri/tauri.conf.json` (numeric triplet comparison, so `0.9.0` → `0.10.0` is
   accepted and `0.10.0` → `0.9.0` is refused).
3. Writes `<version>` into four files in lockstep: `package.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (the workspace member's own pinned
   entry — cargo silently rewrites this back to the on-disk `Cargo.toml` version on the
   next `cargo check`/`build` if it's left behind, so it has to move in the same commit),
   and `src-tauri/tauri.conf.json`.
4. Commits exactly those files as `chore(release): bump version to <version>`.
5. Tags the commit `v<version>`, matching the existing tag convention the release
   workflow's `on: push: tags: ['v*']` trigger expects.

The version bump and the tag push are separate steps on purpose: the recipe never
pushes. Push the commit and the tag yourself once you're ready to cut the release.

## Recovering from a failed run

If the recipe dies after committing but before tagging (or a tag push fails and gets
retried), a re-run refuses rather than committing a second bump on top of the first: it
recognizes a HEAD commit whose subject is `chore(release): bump version to <version>` with
no matching `v<version>` tag, and tells you to tag it by hand or reset past it.

## Version logic

The pure bump-and-validate logic lives in `scripts/release.ts`, unit-tested in
`scripts/release.test.ts` — the same split as `scripts/bench-normalize.ts`. The thin CLI
wrapper the justfile recipe invokes is `scripts/release-apply.ts`; the git plumbing (dirty
check, partial-failure detection, commit, tag) stays in the justfile recipe itself.
