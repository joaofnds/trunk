# Build environment

What the gate's speed depends on outside the repo, and how to tell which one is
hurting when `just check` slows down. Warm on a settled tree the full gate is
~47s; cold after `cargo clean` it is ~2m12s (measured 2026-08-30, M5 Pro, 18
cores). If a run is minutes-slow with idle CPUs, the machine is the problem, not
the checks — start with the target dir's file count below, then Gatekeeper.

## One toolchain, pinned

Three files name the rust version and all three must agree: `rust-toolchain.toml`
pins it, `mise.toml` feeds CI through `mise-action`, and `release.yml` passes it
to `dtolnay/rust-toolchain`. `just toolchain-parity` fails the gate when they
drift, so bump the version by editing all three in one commit.

The pin is a rustup *directory override*: inside this repo it beats a toolchain
installed by name. Two consequences, both of which have bitten:

- mise exports `RUSTUP_TOOLCHAIN`, and an environment variable outranks even the
  pin file, so a mismatch there wins silently. The justfile unexports it so a
  version leaked into a session's environment cannot reach the gate's cargo calls.
- `dtolnay/rust-toolchain` does not read the pin file. Asking it for `stable`
  installs the cross-compile targets for stable, and the build then runs on the
  pinned version, which does not have them — the macOS release legs fail to link.
  It must be given the pinned version explicitly.

Why it matters: all sessions share one `src-tauri/target`. Artifacts are keyed
by compiler version, so every extra version in play multiplies cold builds and
disk (three versions once grew the dir to 113GB).

## macOS Gatekeeper can stall every fresh binary

Symptom: cargo runs sit for minutes with near-zero CPU; hour-long gates. A
`sample` of a stalled `rustc` shows the time inside `dlopen` →
`mapSegments` → `fcntl` (kernel code-signature registration), and `syspolicyd`
accumulates hours of CPU time. Every freshly linked binary — proc-macro dylibs,
the 25 test binaries, doctest executables — waits on a per-binary Gatekeeper
assessment, and a build produces thousands.

Check: compile and run a throwaway binary; first exec should be ~instant.

```bash
cd /tmp && echo 'int main(){return 0;}' > p.c && cc p.c -o p && time ./p
```

Fix (both were needed on 2026-08-30):

1. Exempt the app that spawns the builds: `sudo spctl developer-mode
   enable-terminal`, then System Settings → Privacy & Security → Developer
   Tools, enable the terminal / Claude app.
2. Reboot if `syspolicyd` shows hours of CPU time — it degrades and stays slow
   even for exempted processes until restarted.

## `src-tauri/target` grows without bound, and slows every build

Cargo keys each artifact by a build hash and never removes a superseded one.
`cargo clean` is all-or-nothing, so nothing prunes in between and a week of
builds accumulates artifacts for build configurations that no longer exist.

Measured 2026-09-03, after roughly a week:

| | |
|---|---|
| Files in `src-tauri/target` | 1,200,987 |
| Files a full `--workspace --all-targets` build needs | 19,239 |
| `.o` files in `debug/deps` | 1,035,318 |
| `.rlib` files in `debug/deps` | 1,786 |
| Compiled artifacts for 352 distinct crates | 2,809, about eight stale copies each |
| Files in `debug/deps` older than seven days | 0 |

Nothing there was stale by age. `aho_corasick` alone had four separately
compiled copies at one version, sixteen codegen units each.

The cost is paid on every cargo invocation, because cargo stats the tree each
time. An identical no-op build, nothing to compile and nothing else running:

| Target dir | Files | No-op build |
|---|---|---|
| freshly rebuilt | 19,239 | 5.6s |
| accumulated | 1,200,987 | 76.1s |

Both rows are this repository's own `src-tauri/target`, measured either side of
the deletion below: 73GB and 1.2M files before, 6.7GB and 19k files after.

Check it with `find src-tauri/target -type f | wc -l`. Past roughly 100k files,
delete the directory:

```bash
rm -rf src-tauri/target
```

That costs one cold build (46s for `--workspace --all-targets`, measured on the
real deletion) and restores 5s no-op builds. **Only when nothing is building.**
Check first:

```bash
pgrep -fl 'cargo|rustc'
```

Deleting artifacts under a running cargo corrupts that build in ways that
surface later as an unreproducible error, and this machine runs several
sessions at once — which is why this is a manual step and deliberately not a
`just` recipe any session could fire.

Prefer `rm -rf` over `cargo clean`, and never interrupt either. Observed
2026-09-03: a `cargo clean` interrupted at 14% left the tree half-deleted and
the build-directory lock held, and two cargo invocations in another session sat
on that lock for fifteen minutes accumulating 2.5s of CPU between them — not
slow, stopped. `rm -rf` takes no lock, so an interrupted one leaves nothing to
block on and can simply be re-run.

Two things this is *not*. It is not the cargo build lock: that costs 34.4s and
only when two builds overlap, where this is paid by every build. And it is not
fixed by giving each session its own target dir (TRUNK-139, dropped) — a fresh
dir is fast because it is empty, not because it is private, and seeding one by
cloning is worse than useless: `cp -c` is a per-inode operation, so cloning the
accumulated tree measured 525s against building it from empty in 46s.

## `just dev` cannot be driven by an agent's screen tools

`just dev` runs `target/debug/trunk` directly. A bare Mach-O executable has no
`.app` around it, so macOS registers no bundle identity for it: LaunchServices
never lists it, and the accessibility APIs that a session's screenshot and click
tools go through return no window for it. The process runs and draws on screen,
and a session cannot see or reach it.

The identifier is not what is missing. `tauri.dev.conf.json` already overrides it
to `com.joaofnds.trunk.dev`, and that override is real — it is what keeps dev
state out of the installed app's. It just has nothing to attach to without a
bundle, so changing it does not help.

`just dev-app` is the route that works. It builds a debug `.app` under the dev
identifier and opens it:

```bash
just dev-app
```

The result is addressable as `com.joaofnds.trunk.dev`, distinct from the
installed `/Applications/Trunk.app` (`com.joaofnds.trunk`), so a session can
drive its own copy while the developer's stays untouched. It embeds the built
frontend rather than pointing at Vite, so it needs no dev server and does not
hot-reload: rebuild to see a change.

Screenshots of the dev window work from the background as they are. Clicks
need one more thing: WebKit drops a mouse event aimed at a window that is not
key, so a background click is delivered and nothing happens. The overlay sets
`acceptFirstMouse` on the window, which lets a click on an inactive window
reach the webview, so clicks land without bringing the app forward and the
developer keeps working in whatever is in front. The shipped app keeps the
default, which is the GitKraken behaviour, so the setting lives only in the
overlay. The click tool still activates the app for an instant and refuses
while the developer is typing; wait a few seconds and retry rather than
escalating to full-screen control.

The overlay merges as an RFC 7396 patch, and a patch replaces an array whole:
the dev config must carry the entire window object, not just the extra key.
`just dev-conf-parity` fails the gate when the two windows differ by anything
but that key, so a change to the shipped window that is not copied into the
overlay cannot silently vanish from the dev build.

Two things the recipe encodes, both of which cost a session an hour on
2026-09-05:

- **`--no-bundle` is the wrong flag.** It skips producing the `.app`, which is
  the only part that matters here. The recipe passes `-b app` to get the bundle
  and skip the dmg.
- **mise's python shadows the system `xattr`.** Tauri's bundling step shells out
  to `xattr -cr`; the python one in mise's path does not accept `-r`, and the
  build fails at the bundling step with `failed to run xattr`. The recipe puts
  the system paths first. Prefixing `PATH` outside `mise exec` does not survive:
  mise re-resolves it, so the override has to be inside.

## Scanners must not walk `src-tauri/target`

The target dir is orders of magnitude bigger than the source. Biome's scanner is
force-excluded from it in `biome.json` (`!!src-tauri/target`); Vite's watcher and
the Tailwind scan are scoped in `vite.config.ts`. Any new repo-walking tool needs
the same exclusion — a 35s biome run on 264 files was the 113GB target dir being
walked, not lint cost. Once that dir was cleaned back to ~6GB the same walk cost
~0.13s, so the exclusion is cheap insurance against the dir growing again rather
than a standing 35s saving.

Write these exclusions as anchored paths, never as `!!**/target`. Biome's `!!` is
a force-exclude that outranks positive includes and cannot be overridden even by
naming a file explicitly, so a `**` pattern would also silently un-check any
source directory that happened to be called `target` or `node_modules` — plausible
names in a Git GUI — with the Biome job still reporting green.
