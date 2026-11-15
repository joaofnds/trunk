# Desktop updates

Trunk uses Tauri's updater verifier and native installer behind its own download
and lifecycle coordinator. GitHub Releases hosts the metadata and packages. The
release contract and target activation requirements are in
[updater-release.md](../updater-release.md).

The initial target registry is empty. Check for Updates therefore explains the
manual update route, and the application makes no background update requests.
Enabling a target requires native acceptance evidence and a distinct public key.
Publishing installers, configuring signing credentials, and accepting a platform
remain separate release operations.

## Eligibility and consent

The client chooses its lane from the running executable's architecture and local
bundle marker. Debug and drive builds, unknown package types, mounted or
translocated applications, and recognized package-manager paths are ineligible.
An eligible installation still requires explicit adoption. Adoption records the
canonical installation path; moving the application requires adopting it again.
The path checks cannot identify every externally managed installation. The
adoption dialog asks the user to establish that this is a direct installation.

Adopted installations check after 15 seconds and every four hours while running.
A failed check gets at most three exponential retries with jitter. Checks pause
while downloading, while a downloaded update waits for installation, during
preparation, and during recovery. Resuming preserves the remaining check delay.
The sidebar footer keeps an update icon visible. When the sidebar is collapsed,
the icon moves to the top bar. The control remains reachable above the interactive
rebase editor. Its action follows the update state: check, download, or request a
restart. Checking animates unless reduced motion is enabled, and a
download shows progress. Hovering or focusing the icon exposes available release
notes; Tab enters their details action and Escape closes them. A completed
download produces one notice per version, with a Read more action.

Check for Updates in the native menu starts a check immediately for adopted,
eligible installations in idle, available, or ready state. Other states open their
details, including manual installation, adoption, download cancellation, and
recovery. Restart requires confirmation naming the exact downloaded version
before draft preparation begins. A changed version invalidates that confirmation.
A downloaded update stays in memory until quit; checking again, including a failed
check, preserves it. There is no automatic installation or downgrade.

This interaction follows T3 Code's sidebar updater at commit
`c2e54e3ac9c8c0d5ceaf7df5acd4f4374fa19b6f`, adapted to Trunk's existing icon button,
sidebar layout, and installation safeguards.

## Trust and bounded downloads

The installed registry supplies the lane's key and compatibility baseline. A
manifest cannot choose a verification key or change that baseline. The client
accepts stable versions and exact release asset paths, then requires the artifact
signature to authenticate the advertised version. Each installer lane uses a
different key because a platform label in unsigned metadata cannot bind an
artifact to an architecture or installer family.

The downloader allows HTTPS GitHub release endpoints and the official release
asset hosts. It validates each redirect, pins resolved public addresses, disables
proxies, and limits redirects to five. Corporate proxy-only networks therefore
need the manual update route. Metadata is limited to 256 KiB and 30 seconds;
artifacts to 128 MiB and 300 seconds. The limits cover streamed bytes and the whole
request, including resolution and redirects. Cancellation retains ownership until
the request settles. Network errors do not expose signed asset URLs.

The client checks byte count and SHA-256, then the plugin verifies the signature
and signed version. Installation verifies again. The hash detects metadata/asset
inconsistency; the signature establishes authenticity. Release notes are plain
text.

## Preparing to restart

The Rust activity gate admits ordinary commands and independent workers while
open. A command's lease follows its real blocking work, even if its IPC caller
is cancelled. Preparation closes admission only when all earlier leases have
settled. An ordinary read also needs admission because opening preferences or
review data can migrate or quarantine files.

The frontend refuses restart while ordinary IPC is pending, freezes input, and captures each
participant's draft generation. The backend then issues a preparation token.
Only preferences and review-draft persistence commands may carry that token
through the closed gate. Flushes must finish and generations must still match
before installation starts. Commit draft updates serialize their whole-map
read/modify/write. A supported review composer saves its recovery context.
Editors whose full state cannot be restored block restart with a reason.

Native Quit and closing the main window participate in the gate. An accepted
exit prevents a later preparation; preparation and installation prevent a normal
exit. The updater's explicit restart is allowed. Before replacement, a checked
window-state save runs on the main thread, and an atomic intent record is saved
outside the application bundle. Aborting reopens admission, invalidates repository
caches, and refreshes repositories and reviews after frontend input resumes.

The external review CLI remains a separate process. It can update the shared
review database while GUI admission is closed. SQLite and the existing schema
compatibility checks govern that coexistence; the updater does not acquire a
machine-wide lock over CLI work or external Git commands.

## Recovery

`trunk-updater.json` contains installation adoption and any outstanding install
intent: source version, expected version, target, and artifact hash. A malformed
or oversized record is preserved and stops updating. A preflight failure before
the installer runs reopens normal work. An installer error leaves work blocked
because an executable hash alone cannot establish that the whole bundle is intact.
Quit and manually install the attempted update version, or a compatible newer
stable version for the same architecture and installer family, in that case.
Reinstalling the older source version does not satisfy the outstanding intent.

At startup, an outstanding intent triggers preference parsing and a read-only
review database check before normal startup can quarantine data. A failed check
keeps the intent and blocks ordinary GUI work for data recovery. Read-only SQLite
access may create WAL bookkeeping files; it does not migrate, quarantine, or
change stored review data. A healthy frontend startup clears the intent only when
the running installation has the expected lane and at least the expected stable
version, and saved data passes another check. There is no automatic rollback or
claim that a successful installer call proves a successful relaunch.

The initial implementation cannot replace a lost or compromised updater key
through the single latest feed for clients that skipped intervening releases.
Manual reinstallation establishes new trust. The app bundle and saved data remain
separate during that recovery.

## Acceptance boundaries

The automated suite exercises the coordinator, real signature verifier, bounded
HTTP response reads, admission and cancellation, draft persistence, and release
assembly. A native macOS fixture also exercised Tauri installation and restart
from a disposable app bundle. It used ad-hoc signing on one arm64 host and did
not run Trunk's complete UI lifecycle.

Activation still requires a packaged Trunk upgrade with real draft/tab recovery,
platform signing and notarization where applicable, the oldest supported runtime,
each architecture and installer family, read-only and privileged paths, and
interruption/manual-recovery cases. The release workflow deliberately refuses an
enabled lane without its native acceptance receipt. These requirements are gates
to enabling distribution, not claims made by the unit tests.
