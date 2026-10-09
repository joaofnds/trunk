# Cutting a release

`just release-bump <major|minor|patch>` and `just release <version>` are the only ways to
bump the app's version. Tauri names every
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

## Choosing the version for you

`just release-bump major|minor|patch` computes the next version from the newest release
tag and hands it to `just release`, so the level is the only thing a caller decides. It
is the same computation the release skill used to spell out as prose and redo by hand
every release, which is why it now lives in `scripts/release.ts` under unit test: an
arithmetic slip there is what pushes a backwards tag.

An unrecognized level is refused before any git command runs, so the argument never
reaches `git commit` or `git tag`.

## Recovering from a failed run

If the recipe dies after committing but before tagging (or a tag push fails and gets
retried), a re-run refuses rather than committing a second bump on top of the first: it
recognizes a HEAD commit whose subject is `chore(release): bump version to <version>` with
no matching `v<version>` tag, and tells you to tag it by hand or reset past it.

The release workflow's build jobs retry `tauri build` once on their own, after deleting
`src-tauri/target`, and annotate the run with a warning when they do. The clean comes first
because a build script binary whose bytes are not a valid executable fails with `exit
status: 126` and `cannot execute binary file`, and when cargo's own hashed copy of it is
bad too, a retry in the same target directory runs it again. That is why tauri-action's
`retryAttempts` alone does not cover it. Before deleting, the step lists every build
script binary's size and first bytes under a collapsed group in the log, the only record
of the failing file once the runner is gone. A job that fails both attempts has a real
failure. When a run fails some other way, re-run
its failed jobs (`gh run rerun <run-id> --failed`). `publish` waits for every build, and
tauri-action replaces an asset already on the draft release, so the re-run is safe.

## Build cache

A tag build restores compiled dependencies from a cache it cannot save, because GitHub
lets a cache saved from a tag be read only by that same tag. The release workflow's
`warm-cache` job saves that cache from main instead, once a day on a schedule, with a
read-only token. It runs the same setup steps as the tag build, since rust-cache keys the
entry on the toolchains and environment those steps leave, then only looks the key up.
When the entry exists it stops there. When it does not, it compiles every target with
`tauri build --no-bundle` from a clean target directory and saves the dependencies.

Package versions do not enter the key, so a version bump keeps the cache. A dependency
change does change it, and so does a new Rust preinstalled on a GitHub runner image,
because rust-cache hashes every installed toolchain. A tag build in the day between such
a change and the next scheduled run restores an older entry for the same toolchains if
one exists, and otherwise compiles cold, as every release did before this cache existed.

A release binary therefore links dependency objects compiled by an earlier scheduled run
on main, not only ones compiled from source in its own job. A build failure caused by a
bad cached build script still recovers through the clean retry above. To make the next
scheduled run rebuild an entry from scratch, delete it with `gh cache delete <key>`; its
key starts with `v0-rust-release-`.

## Version logic

The pure bump-and-validate logic lives in `scripts/release.ts`, unit-tested in
`scripts/release.test.ts` — the same split as `scripts/bench-normalize.ts`. The thin CLI
wrappers the justfile recipes invoke are `scripts/release-apply.ts` and
`scripts/release-next.ts`; the git plumbing (dirty
check, partial-failure detection, commit, tag) stays in the justfile recipe itself.
