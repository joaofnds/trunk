//! One writer at a time for each repository, within this process.
//!
//! libgit2 takes `index.lock` only for the moment it writes the index, and nothing
//! guards the working tree or the stash list it reads before that. Two commands that
//! both read before either writes each save what they read, and the later save drops
//! the earlier one's change while both report success. Git's own commands lock the
//! index before they read it. A command run through [`hold`] holds its repository the
//! same way, from its first read to its last write, so the next command starts from
//! what it saved. Another process meets only git's lock.

use std::borrow::Borrow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, TryLockError};

use crate::error::TrunkError;

#[derive(Default)]
struct Gate {
    held: Mutex<()>,
    #[cfg(feature = "test-util")]
    hooks: Mutex<Hooks>,
}

static GATES: LazyLock<Mutex<HashMap<PathBuf, Arc<Gate>>>> = LazyLock::new(Mutex::default);

thread_local! {
    /// The repositories whose gate this thread holds. A body that asked for its own
    /// repository's gate again would wait on itself for good.
    static HELD_HERE: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
}

fn gate_of(repo: &Path) -> Arc<Gate> {
    let mut gates = GATES.lock().unwrap_or_else(PoisonError::into_inner);
    Arc::clone(gates.entry(repo.to_path_buf()).or_default())
}

/// The gate of one repository, held by this thread until it drops.
struct Held<'a> {
    repo: &'a Path,
    _guard: MutexGuard<'a, ()>,
}

impl<'a> Held<'a> {
    fn take(gate: &'a Gate, repo: &'a Path) -> Self {
        let held_here = HELD_HERE.with_borrow(|held| held.iter().any(|path| path == repo));
        assert!(
            !held_here,
            "{} is already held by this thread, and waiting for it again would never end",
            repo.display()
        );

        let guard = match gate.held.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => {
                #[cfg(feature = "test-util")]
                gate.run_hook(|hooks| hooks.on_wait.take());
                gate.held.lock().unwrap_or_else(PoisonError::into_inner)
            }
        };

        HELD_HERE.with_borrow_mut(|held| held.push(repo.to_path_buf()));
        Self {
            repo,
            _guard: guard,
        }
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        HELD_HERE.with_borrow_mut(|held| held.retain(|path| path != self.repo));
    }
}

/// Run `body` as this process's only writer of `repo`.
///
/// The index is read afresh once the gate is held, so `body` starts from what the
/// writer before it saved. `repo` is a shared or a mutable borrow, whichever `body`
/// needs. A poisoned gate still serves, since the fresh read drops whatever the
/// panicking writer left.
///
/// # Errors
///
/// Returns the git error when the index will not read, and whatever `body` returns.
///
/// # Panics
///
/// Panics when this thread already holds `repo`'s gate, which would otherwise wait
/// on itself forever.
pub fn hold<R: Borrow<git2::Repository>, T>(
    repo: R,
    body: impl FnOnce(R) -> Result<T, TrunkError>,
) -> Result<T, TrunkError> {
    let path = repo.borrow().path().to_path_buf();
    let gate = gate_of(&path);

    let done = {
        let _held = Held::take(&gate, &path);
        repo.borrow().index()?.read(false)?;
        body(repo)
    };

    #[cfg(feature = "test-util")]
    gate.run_hook(|hooks| hooks.on_release.take());
    done
}

#[cfg(feature = "test-util")]
type Hook = Box<dyn FnOnce() + Send>;

/// What a test runs at a point inside [`hold`] that no outside caller can reach.
#[cfg(feature = "test-util")]
#[derive(Default)]
struct Hooks {
    on_wait: Option<Hook>,
    on_release: Option<Hook>,
}

#[cfg(feature = "test-util")]
impl Gate {
    fn run_hook(&self, pick: impl FnOnce(&mut Hooks) -> Option<Hook>) {
        let hook = pick(&mut self.hooks.lock().unwrap_or_else(PoisonError::into_inner));
        if let Some(hook) = hook {
            hook();
        }
    }

    fn set_hook(&self, place: impl FnOnce(&mut Hooks) -> &mut Option<Hook>, hook: Hook) {
        *place(&mut self.hooks.lock().unwrap_or_else(PoisonError::into_inner)) = Some(hook);
    }
}

/// Run `hook` when the next [`hold`] of `repo` finds the gate taken, just before it
/// waits, so a test can act once a command is known to be queued.
#[cfg(feature = "test-util")]
pub fn on_next_wait(repo: &git2::Repository, hook: impl FnOnce() + Send + 'static) {
    gate_of(repo.path()).set_hook(|hooks| &mut hooks.on_wait, Box::new(hook));
}

/// Run `hook` when the next [`hold`] of `repo` releases the gate.
///
/// It runs on that `hold`'s thread, after the release and before `hold` returns, so a
/// test can put another writer in the gap between one command's gated body and
/// whatever the command does next.
#[cfg(feature = "test-util")]
pub fn on_next_release(repo: &git2::Repository, hook: impl FnOnce() + Send + 'static) {
    gate_of(repo.path()).set_hook(|hooks| &mut hooks.on_release, Box::new(hook));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> (tempfile::TempDir, git2::Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    #[test]
    fn a_held_repository_reads_what_another_handle_staged_after_this_one_read_the_index() {
        let (dir, repo) = repository();
        assert_eq!(repo.index().unwrap().len(), 0);
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        let other = git2::Repository::open(dir.path()).unwrap();
        let mut index = other.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();

        let staged = hold(&repo, |repo| Ok(repo.index()?.len())).unwrap();

        assert_eq!(staged, 1);
    }

    #[test]
    #[should_panic(expected = "is already held by this thread")]
    fn holding_a_repository_again_from_inside_its_body_panics() {
        let (_dir, repo) = repository();

        let _ = hold(&repo, |repo| hold(repo, |_| Ok(())));
    }

    #[test]
    fn a_body_may_hold_another_repository() {
        let (_one_dir, one) = repository();
        let (_two_dir, two) = repository();

        let held = hold(&one, |_| hold(&two, |_| Ok("both")));

        assert_eq!(held.unwrap(), "both");
    }

    #[test]
    fn a_repository_can_be_held_again_once_its_body_returned() {
        let (_dir, repo) = repository();
        hold(&repo, |_| Ok(())).unwrap();

        let again = hold(&repo, |_| Ok("again"));

        assert_eq!(again.unwrap(), "again");
    }
}
