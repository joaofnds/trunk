# Updater release contract

The updater feed is disabled while `src-tauri/updater-targets.json` contains
`{"targets":{}}`. The release workflow continues publishing its ordinary installers
and portable archives. Stable releases gain a feed only after individual lanes have
packaged acceptance evidence and a distinct updater verification key. Prereleases
remain outside this feed.

## Target registry

The registry is the client's trusted lane-to-key mapping. Its only top-level field
is `targets`. Supported keys are `darwin-aarch64`, `darwin-x86_64`,
`windows-x86_64-nsis`, `windows-x86_64-msi`, and `linux-x86_64-appimage`. Each enabled
entry has exactly these fields:

```json
{
  "publicKey": "base64-encoded Tauri minisign public-key text",
  "minimumOsVersion": "13.0",
  "acceptanceRecord": "docs/updater-acceptance/darwin-aarch64.json"
}
```

This example describes the schema; it is not an accepted lane or a usable key.
Keys must differ across lanes, including Windows installer families. The parser
rejects unknown fields, duplicate lane names, unsupported lanes, malformed keys,
shared public-key material, empty baselines, and acceptance paths outside `docs/`.
The release CLI also resolves each acceptance path and rejects symlinks escaping
the repository.

An acceptance record has exactly these fields:

```json
{
  "target": "darwin-aarch64",
  "minimumOsVersion": "13.0",
  "oldestOsTested": "13.0",
  "status": "accepted",
  "platformSigning": "verified",
  "evidence": "docs/updater-acceptance/darwin-aarch64-results.md"
}
```

The baseline and oldest tested OS must match the registry. The evidence must
cover the native acceptance checklist below.
A record is an assertion by the acceptance operator; parsing it does not execute
those tests. Keep the compatibility baseline fixed for clients already using the
lane. Raising it requires a separately designed compatibility feed or a manual
transition.

## Native acceptance checklist

Each enabled lane needs retained commands, platform versions, final artifact
digests, observed results and recovery instructions for these cases:

- Upgrade a real packaged Trunk from the preceding supported version and from a
  supported version that skipped intervening releases. Confirm the executable
  version, architecture, installer family and installation path after restart.
- Run on the oldest declared supported OS or distribution baseline. Match that
  baseline to the packaged application's requirements, including native libraries
  and WebView. A successful build or a declared minimum is not runtime evidence.
- Verify final platform signing and notarization where applicable before hashing
  the artifact, then verify the version-bound updater signature on those bytes.
- Preserve tabs, preferences, latest commit drafts and supported review composers
  through a packaged restart. Retain a dirty working tree and a paused durable
  Git operation. Busy commands, hooks and credential prompts must refuse restart
  without freezing ordinary work or queuing installation.
- Exercise watcher and external CLI activity, including CLI symlink resolution
  after replacement and compatible access to the shared review database. Save
  failures must stop installation and restore usable controls.
- Reject invalid signatures, version relabeling, wrong architecture/family keys,
  malformed or oversized metadata, incomplete downloads, and untrusted redirect
  or DNS destinations. Exercise offline discovery, cancellation and deadlines.
- Interrupt at download, verified-before-install, replacement, and restart
  boundaries. On macOS, cover the fallback rename gap separately from an atomic
  swap. Recover from a missing application path and from a target that launches
  but fails before readiness. Retain the intent until compatible saved data opens.
- Exercise read-only and unwritable installations, privilege escalation where
  required, insufficient disk space, temporary/translocated paths, and recognized
  package-manager or pinned installations. Measure download/install peak memory
  on the target. Document the manual recovery route and its limits.

The receipt attests to a lane only after its applicable cases pass. The arm64
ad-hoc fixture used during development does not substitute for this real Trunk
matrix or authorize another architecture, package family, or OS baseline.

## Native acceptance before signing

An enabled lane requires a fresh `updater-acceptance/<target>.json` receipt in its
build job, containing exactly:

```json
{
  "target": "darwin-aarch64",
  "version": "1.2.3",
  "minimumOsVersion": "13.0",
  "file": "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Trunk.app.tar.gz",
  "sha256": "sha256 of the accepted final archive",
  "size": 12345,
  "status": "accepted",
  "platformSigning": "verified"
}
```

The native acceptance runner must create this receipt from the artifact it tested,
using the release version, target architecture, installer family and fixed OS
baseline it observed. It must finalize platform signing before testing and hashing:
Developer ID signing and notarization for direct macOS distribution; Authenticode
for Windows installers; the accepted Linux distribution policy for AppImage.
Updater minisign signatures do not establish any of those platform properties.
The configured macOS ad-hoc identity is insufficient to assert Developer ID
acceptance.

The current workflow has no producer for these receipts. Enabling a registry lane
therefore stops release publication until its native acceptance step is connected.
The checked-in empty registry preserves the existing release route while these
platform gates are established. A synthetic archive fixture cannot enable a lane.

The wrapper checks the receipt's version, target, baseline, file location, byte
count and SHA-256 before signing. It copies those bytes without rebuilding or
repacking them. `bun tauri signer sign --app-version <version>` binds the release
version into the signature's authenticated comment. The CLI verifies the real
signature using `minisign-verify`, matching the updater's verifier, before upload.

The build job reads one secret pair per lane. The names are
`UPDATER_DARWIN_AARCH64_KEY` / `_PASSWORD`, `UPDATER_DARWIN_X86_64_KEY` /
`_PASSWORD`, `UPDATER_WINDOWS_X86_64_NSIS_KEY` / `_PASSWORD`,
`UPDATER_WINDOWS_X86_64_MSI_KEY` / `_PASSWORD`, and
`UPDATER_LINUX_X86_64_APPIMAGE_KEY` / `_PASSWORD`. `_PASSWORD` here replaces the
final `_KEY` suffix. These are passed to the local Tauri CLI through its signing
environment, never command arguments. This change does not configure secrets or
provide production credentials.

## Final publication gate

The build jobs retain their verified artifacts as workflow artifacts and upload
immutable, lane-qualified asset names into the existing draft. One
`finalize-updater` job then:

1. Collects all build receipts and their exact bytes.
2. Assembles one `latest.json`, requiring exactly one artifact per enabled lane.
3. Verifies stable version agreement, signed version, lane key, fixed baseline,
   byte count, SHA-256, filename and package magic. It restricts URLs to
   `https://github.com/joaofnds/trunk/releases/download/v<version>/<filename>`.
4. Downloads the draft's hosted payloads and repeats verification against the
   local manifest.
5. Uploads the manifest and compares the downloaded manifest with its local bytes.

The existing publish job depends on that final stage. Failure leaves the release
a draft. Uploads never replace existing assets with different bytes. Package magic
rejects obvious format substitutions; native acceptance owns archive contents,
executable version, architecture and installer-family verification. The trusted
build and signing environment remains responsible for assigning packages to lanes.

Artifacts are limited to 128 MiB and manifests to 256 KiB, matching the initial
client policy. Both CLI reads and validation enforce these bounds. Signing and
publication do not rebuild the packages. Ordinary installers remain available for
manual recovery, including updater-key replacement. Clients that miss an
intermediate release cannot rotate to a new key through the single latest feed;
reinstall through the manual distribution route to establish new trust.

## Local validation

These commands do not upload or publish:

```sh
mise exec -- cargo test --manifest-path src-tauri/Cargo.toml -p trunk-update-release -j 2
mise exec -- cargo run --manifest-path src-tauri/Cargo.toml -p trunk-update-release -- validate-registry src-tauri/updater-targets.json .
mise exec -- python3 scripts/updater-release.py prepare darwin-aarch64
```

With an enabled lane, the last command requires its native receipt and local
signing environment, and writes reviewable files under `updater-output/`. The
workflow adds `--upload` only in the existing draft release path.

For an existing local artifact set, an input JSON object contains `version` and
an `artifacts` array. Each artifact contains `target`, `version`,
`minimumOsVersion`, `file` (basename), `url`, `signature` (Tauri base64 signature),
`sha256`, and `size`. The validator exposes:

```sh
mise exec -- cargo run --manifest-path src-tauri/Cargo.toml -p trunk-update-release -- assemble REGISTRY REPO INPUT ARTIFACT_DIRECTORY MANIFEST
mise exec -- cargo run --manifest-path src-tauri/Cargo.toml -p trunk-update-release -- verify-hosted REGISTRY REPO INPUT DOWNLOADED_DIRECTORY MANIFEST
```

The Rust tests retain a small synthetic app archive and public signatures made
with a disposable Tauri CLI key during the updater research. No private fixture
key is retained. They prove cryptographic rejection and release-contract behavior;
they do not prove platform signing, native installer behavior, or an OS baseline.
