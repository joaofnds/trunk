//! The fixture corpus Trunk is tested against, built with git2, the library the app reads
//! repositories with. Every repository is build output of a case module; the byte-level
//! acceptance for each case is the fingerprint oracle under `oracle/`.

use std::sync::Once;

use git2::ConfigLevel;

pub mod cases;
pub mod fingerprint;

static ISOLATED: Once = Once::new();

/// Blank libgit2's global, XDG, system and ProgramData config search paths, so nothing in
/// the operator's `~/.gitconfig` can reach a fixture. libgit2 ignores `GIT_CONFIG_GLOBAL`
/// and locates the global file through `HOME`; blanking the search paths is the isolation
/// that works.
///
/// Process-global, and only effective before the first `Repository` is opened on any
/// thread: `main` and every test call it first. A call after libgit2 has already read a
/// config file leaves what it read in place.
pub fn isolate() {
    ISOLATED.call_once(|| {
        for level in [
            ConfigLevel::Global,
            ConfigLevel::XDG,
            ConfigLevel::System,
            ConfigLevel::ProgramData,
        ] {
            // SAFETY: libgit2's options are process-global and unsynchronised. This runs
            // once, before any other libgit2 use in the process, so nothing reads them
            // concurrently.
            unsafe { git2::opts::set_search_path(level, "") }
                .expect("blank libgit2's config search path");
        }
    });
}
