# Desktop updates

Trunk uses Tauri's updater verifier and native installer behind its own download
and lifecycle coordinator. GitHub Releases hosts the metadata and packages. The
release contract and target activation requirements are in
[updater-release.md](../updater-release.md).

Release discovery works independently of installation eligibility. Copies without
an adopted updater target check GitHub's latest public release and link to that
release for manual installation. This needs neither an updater key nor Apple
signing credentials. The initial target registry is empty, so this is the current
distribution path. Enabling in-app installation still requires native acceptance
evidence and a distinct public key for the target.

## Eligibility and consent

The client chooses its lane from the running executable's architecture and local
bundle marker. Debug and drive builds, unknown package types, mounted or
translocated applications, and recognized package-manager paths are ineligible
for in-app installation. They can still check for public releases.
An eligible installation still requires explicit adoption. Adoption records the
canonical installation path; moving the application requires adopting it again.
The path checks cannot identify every externally managed installation. The
adoption prompt asks the user to establish that this is a direct installation.

Release checks run after 15 seconds and every four hours while running.
A failed check gets at most three exponential retries with jitter. Checks pause
while downloading, while a downloaded update waits for installation, during
preparation, and during recovery. Resuming preserves the remaining check delay.
Background failures do not open the panel or show a notification; explicit checks
show errors in the panel.

The existing title bar shows an update icon after the repository controls only
when an update is available, downloading, or ready to restart. Idle and automatic
checks add no window controls. The icon stays in the same app-level location
across repositories, reviews, and interactive rebase, without adding a row or
reducing content height. For manual updates, clicking the icon opens the matching
GitHub release in the default browser. Package-managed copies keep using their
original installation method. For adopted updater targets, the icon downloads
the signed package, opens progress and cancellation controls, or requests a
restart. Hovering or focusing the
icon opens a compact anchored panel with the current state and its actions, even
when release notes are absent. Update details opens the matching GitHub release
in the default browser; release notes are not rendered inside Trunk. Tab enters
the panel and Escape closes it. A completed download changes the button to its
restart state without opening a panel or showing a notification.

Check for Updates in the native menu starts a check immediately in manual, idle,
available, or ready state, including copies without updater adoption. Other
states open their anchored panel, including download cancellation and recovery.
An explicit menu request or an explicit check error can reveal the control
outside its usual actionable states. Restart requires confirmation inside that
panel, naming the exact downloaded version before draft preparation begins. A
changed version invalidates that confirmation. Updates use no modal dialog.
A downloaded update stays in memory until quit; checking again, including a failed
check, preserves it. There is no automatic installation or downgrade.

This interaction follows T3 Code's sidebar updater at commit
`c2e54e3ac9c8c0d5ceaf7df5acd4f4374fa19b6f`, adapted to Trunk's existing title bar,
icon button, and installation safeguards.

## Trust and bounded downloads

Manual release discovery requests the fixed GitHub API endpoint for this
repository's latest release. It accepts only a newer canonical stable version
tag, constructs the release-page link from that version, and never creates an
installable candidate from this response. The installer feed's trust rules remain
separate from release notices.

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
is cancelled. Preparation closes admission at once and then waits, off the main
thread, for the leases admitted before it to settle, so background work the user
never sees delays the restart rather than refusing it. Aborting or exiting ends
that wait. No flush is admitted until every earlier lease has settled. Startup
recovery still closes admission only when nothing is running. An ordinary read
also needs admission because opening preferences or
review data can migrate or quarantine files.

An editor whose full state cannot be restored refuses the restart at the click,
with a reason. Otherwise the frontend first waits for its pending IPC while
Trunk stays usable, so a running push stays cancellable and the panel offers to
cancel the restart. Once nothing is pending it freezes input, opens the panel,
and captures each participant's draft generation. The backend then issues a
preparation token and waits for the work it admitted earlier, which lasts as
long as that hidden work runs. The panel offers to cancel through that wait too.
Cancelling aborts the token and reopens Trunk with no draft flushed.
Only preferences and review-draft persistence commands may carry that token
through the closed gate. Flushes must finish and generations must still match
before installation starts. Commit draft updates serialize their whole-map
read/modify/write. A supported review composer saves its recovery context.

Native Quit and closing the main window participate in the gate. An accepted
exit prevents a later preparation. A preparation still waiting on earlier work
ends and lets the exit through. Once that earlier work has settled, preparation
and installation prevent a normal exit. The updater's explicit restart is
allowed. Before replacement, a checked window-state save runs on the main
thread, and an atomic intent record is saved outside the application bundle.
Aborting reopens admission, invalidates repository caches, and refreshes
repositories and reviews after frontend input resumes.

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
