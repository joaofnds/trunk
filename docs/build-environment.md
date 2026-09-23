# Build environment

What the build's speed depends on beyond the code, and how to tell which cause is
hurting when `just check` or `just dev` slows down. If switching between `just
dev`, `just dev-app` and `just check` rebuilds dependencies with busy CPUs, start
with the shared layer section below. Warm on a settled tree the full gate is
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

## Switching between builds must not rebuild the shared layer

`just dev`, `just check` and `just dev-app` build different configurations into
that one target dir. They differ in tauri's features, so tauri and the crates
built on it are separate units in each. The C libraries and the crates between
them and tauri are the same units in all three, so they must look identical to
all three. If they differ, each switch rebuilds them for whichever build comes
next. Two things keep them identical:

- **One `MACOSX_DEPLOYMENT_TARGET`.** `tauri build`, which `just dev-app` runs,
  exports tauri.conf.json's `bundle.macOS.minimumSystemVersion` under that name,
  and `tauri dev` and bare cargo export nothing. The build scripts of libgit2-sys,
  libsqlite3-sys, libz-sys, openssl-sys, onig_sys and objc2-exception-helper
  rerun when it changes. With the two values different, every switch between
  `just dev-app` and any other build recompiled 42 crates, 81s each way
  (measured 2026-09-23). `.cargo/config.toml` gives the same value to every
  cargo run started inside the repo, and `just toolchain-parity` fails when the
  two files disagree. The pin loses to a value already exported in the shell,
  because the entry does not set `force`. A shell that exports a different
  `MACOSX_DEPLOYMENT_TARGET` brings the rebuilds back while the check stays
  green. Setting `minimumSystemVersion` to `null` would stop tauri exporting
  the variable at all, but it also removes `LSMinimumSystemVersion` from the
  shipped bundle's Info.plist.
- **An rlib-only lib.** With `staticlib` or `cdylib` in its `crate-type`, cargo
  drops the hash from the lib's file names. The dev build, the test build
  (`test-util` on) and the bundle build then share one copy of `trunk`, and each
  switch recompiled it: 7s going from `just check` to `just dev`. Nothing checks
  this one. The comment on `crate-type` in `src-tauri/Cargo.toml` is all that
  stands against re-adding them, which Tauri's mobile setup does.

One switch still costs a `trunk` recompile, about 7s, and only `trunk`. The
`trunk` build script reruns when `TAURI_CONFIG` changes. `just dev` and `just
dev-app` set it to the dev overlay, and a bare `cargo build` in `src-tauri`
shares `just dev`'s build units without setting it. Alternating the two
recompiles `trunk` each way. `just check` is not affected, because it builds
different units.

When a switch recompiles something it should not, ask cargo why. Put the log
variable on the recipe that recompiles, so the build runs with that route's
environment. A bare `cargo build` does not, and can report a cause it created
itself:

```bash
CARGO_LOG=cargo::core::compiler::fingerprint=info mise exec -- just dev 2>&1 | grep '    dirty: '
```

Each line names a unit (`package_id=… target="…"`) and why it is dirty.
`StaleDependency`, `StaleDepFingerprint` and `UnitDependencyInfoChanged` are
knock-on effects of a dependency rebuilding. Any other reason is a cause, often
the same one on several units. `EnvVarChanged` names the variable, and
`FeaturesChanged` on a unit you did not reconfigure means two builds share its
slot.

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

Which cargo command that no-op timed is not recorded. A no-op has also measured
fast on a larger tree: on 2026-09-23, with 1,511,655 files, a no-op of the build
`just dev` runs (`cargo build --no-default-features`) took 0.21s, right after
other builds had run. How the cost depends on the command and on what the
filesystem has cached is not established.

Check it with `find src-tauri/target -type f | wc -l`. Past roughly 100k files,
time a no-op of the command that is slow. If that no-op is slow too, delete the
directory:

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

`just dev-app` is the route that works. It builds and opens `Trunk Dev.app`
under the dev identifier:

```bash
just dev-app
```

The result is named `Trunk Dev` and addressable as `com.joaofnds.trunk.dev`,
distinct from the installed `/Applications/Trunk.app` (`Trunk`,
`com.joaofnds.trunk`), so the two running apps are easy to tell apart and a
session can drive its own copy while the developer's stays untouched. It embeds
the built frontend rather than pointing at Vite, so it needs no dev server and
does not hot-reload: rebuild to see a change.

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

The computer-use tools are `list_granted_applications`, which reports which
applications the session may reach, `request_access`, which asks for one,
`app_list_windows`, which returns each window's `window_id`, title and bounds,
`app_screenshot`, which captures one of those windows, and `app_click`,
`app_type`, `app_key`, `app_scroll` and `app_drag`, which drive it.
`app_ax_find` searches the captured accessibility elements, `app_batch` runs a
predictable sequence in one call, and `app_release` drops the background lock.
Ask for `com.joaofnds.trunk.dev`, the dev bundle. A registry search finds them
under the `mcp__computer-use__` namespace rather than bare, so search on that
prefix or on a fragment like `granted` before concluding the tools are absent.
Several sessions have held none of them at all, so a session that finds nothing
has learned its own capability rather than a fact about the machine.

The working order is `list_granted_applications`, then `request_access` if the
list is empty, then `app_list_windows` for the `window_id`, then
`app_screenshot`. Verified end to end on 2026-09-15: empty allowlist to real
window content in four calls, with the grant returning tier `full`. If the app
is not running, `open_application` starts it in the background without taking
the developer's focus, so it does not have to be open before you begin.

Typing needs a focusing click first. The webview exposes no positional text
element, so an `app_type` aimed straight at a field's coordinate fails with
"there is no text field at this point" — which reads like a permission problem
and is not one. Click the field and type in the same `app_batch`. Two related
traps, both measured on 2026-09-15: `overwrite_existing: true` is refused here
because it blocks the raw-keystroke fallback, so clear a field with
`mode: "replace"` or with backspaces; and `key` with `repeat: N` delivered one
keystroke rather than N, so send individual actions when you need several.

Clicking and typing were confirmed to land on 2026-09-15: a click switched the
active repo tab and the graph changed with it, and typed text appeared in the
commit summary field. That session needed no separate Accessibility grant, which
means the host process was already trusted — not that the grant is irrelevant.
Where `AXIsProcessTrusted()` is 0, clicks are dropped while capture still works,
which is exactly what TRUNK-154.1 hit.

Prefer element indices to coordinates. `app_screenshot` returns an
accessibility summary beside the image, each line carrying an `[N]` index, a
role, a title and bounds; passing that `N` as `element_index` to `app_click` or
`app_type` targets the element directly and sidesteps the coordinate frame,
which is the full-resolution one even when the image was scaled down. The dev
window reported 58 elements, 33 of them actionable.

The approval is granted per session and does not carry over. Every session that
has checked found `list_granted_applications` empty at the start, and an empty
list means the approval has not been given yet rather than that it was refused.
`request_access` raises a dialog that has to reach João before the session can
capture anything, and returns `user_denied` when he does not approve it. One
recorded `user_denied` came from the dialog never reaching him rather than from
a refusal, so treat it as a wait on João. A session on 2026-09-15 confirmed both
halves: the list was empty at the start despite five earlier sessions on the same
card, and the dialog reached him and returned a grant. Re-check these names when the
computer-use server is upgraded, since a rename leaves the old ones reading as
absent.

Accessibility in System Settings is a separate approval from the computer-use
one, and it matters for a different thing. It is not what unblocks window
capture: asking for it to fix a black or missing screenshot was the wrong ask on
TRUNK-154 and its three children, across three sessions, before TRUNK-190
recorded the right one. It IS what unblocks clicking and typing. TRUNK-190:43,
on João's call, reads "either grant Screen Recording (and Accessibility, if
clicking is wanted)", and TRUNK-154.1:166 records a dispatched agent that could
screenshot the app but could not click, with `AXIsProcessTrusted()=0` verified
there by a compiled probe (TRUNK-154.1:190). So a genuine Accessibility denial
is real and blocks input; it is simply not the fix for a capture failure.

A dispatched agent usually holds no screen tools at all. This is the common
case, not an anomaly: agents spawned here have reported holding only `Read` and
`Bash`, with no computer-use tool and no `ToolSearch` with which to find one
(TRUNK-232.1:53 and TRUNK-232.2:61, "the computer-use MCP tools are not
available inside a subagent in this session, and ToolSearch is disabled there";
TRUNK-232.2 records a session that held the tools while the agent it dispatched
did not). So a session that holds the tools cannot pass that capability on by
dispatching, and a no-tools report from an agent is the expected outcome rather
than something to retry.

Two narrower failures are also recorded, for agents that did hold tools: a
`getApp` call that hung and needed interrupting (TRUNK-210:143), and an
Accessibility denial that allowed screenshots but no clicks (TRUNK-154.3).

Granting the app to the parent does not change this. Probed on 2026-09-15 from a
session holding `com.joaofnds.trunk.dev` at tier `full`, with `app_screenshot`
already returning real window content: the agent it spawned reported `Read` and
`Bash` only. The tools themselves do not cross the spawn, so there is no grant to
inherit. Dispatch for a CLI or a written record, which needs no screen tool;
observe the window from a session that holds them.

`screencapture -l <window_id>` returns real window content too, and captures a
different moment than `app_screenshot` does. Hover-revealed UI present in an
`app_screenshot` was missing from a `screencapture` taken seconds later, so
capture anything that depends on hover through `app_screenshot`, in the same
batch as the pointer action that reveals it. Re-check that divergence after a
macOS or computer-use server upgrade.

The m-8 chain (TRUNK-233 through TRUNK-240) builds a command channel into the
running dev build, and TRUNK-241, type docs, then repoints this section and the
definition-of-done item at it. Whether that channel needs an approval is not
settled on any card, so do not plan on it replacing the grant.

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
