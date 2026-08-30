# Build environment

What the gate's speed depends on outside the repo, and how to tell which one is
hurting when `just check` slows down. Warm on a settled tree the full gate is
~47s; cold after `cargo clean` it is ~2m12s (measured 2026-08-30, M5 Pro, 18
cores). If a run is minutes-slow with idle CPUs, the machine is the problem, not
the checks.

## One toolchain, pinned

`rust-toolchain.toml` pins the compiler; `mise.toml` must name the same version
(mise exports `RUSTUP_TOOLCHAIN`, which outranks the pin file, so a mismatch
silently wins). The justfile additionally unexports `RUSTUP_TOOLCHAIN` so a
version leaked into a session's environment cannot reach the gate's cargo calls.

Why it matters: all sessions share one `src-tauri/target`. Artifacts are keyed
by compiler version, so every extra version in play multiplies cold builds and
disk (three versions once grew the dir to 113GB). Bump the version by editing
both files in one commit.

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

## Scanners must not walk `src-tauri/target`

The target dir is orders of magnitude bigger than the source. Biome's scanner is
force-excluded from it in `biome.json` (`!!**/target`); Vite's watcher and the
Tailwind scan are scoped in `vite.config.ts`. Any new repo-walking tool needs
the same exclusion — a 35s biome run on 264 files was this, not lint cost.
