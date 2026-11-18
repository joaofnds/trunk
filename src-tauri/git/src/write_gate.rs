//! One writer at a time for each repository, within this process.
//!
//! libgit2 takes `index.lock` only for the moment it writes the index, and nothing
//! guards the working tree or the stash list it reads before that. Two commands that
//! both read before either writes each save what they read, and the later save drops
//! the earlier one's change while both report success. Git's own commands lock the
//! index before they read it. A command run through [`hold`] holds its repository the
//! same way, from its first read to its last write, so the next command starts from
//! what it saved, and a writer whose work spans threads takes a [`Turn`] instead.
//! Another process meets only git's lock.

use std::borrow::Borrow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, PoisonError};

use crate::error::TrunkError;

#[derive(Default)]
struct Gate {
    taken: Mutex<bool>,
    freed: Condvar,
    #[cfg(feature = "test-util")]
    hooks: Mutex<Hooks>,
}

impl Gate {
    /// Wait until no writer holds this gate, then hold it. The flag is only ever set
    /// or cleared under the mutex, so a writer that panics while it holds the gate
    /// leaves nothing poisoned: its [`Turn`] frees the gate as the panic unwinds.
    fn take(&self) {
        let mut taken = self.taken.lock().unwrap_or_else(PoisonError::into_inner);
        if *taken {
            #[cfg(feature = "test-util")]
            {
                drop(taken);
                self.run_hook(|hooks| hooks.on_wait.take());
                taken = self.taken.lock().unwrap_or_else(PoisonError::into_inner);
            }
            while *taken {
                taken = self
                    .freed
                    .wait(taken)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        }
        *taken = true;
    }

    fn free(&self) {
        *self.taken.lock().unwrap_or_else(PoisonError::into_inner) = false;
        self.freed.notify_one();
        #[cfg(feature = "test-util")]
        self.run_hook(|hooks| hooks.on_release.take());
    }
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

fn refuse_to_wait_on_this_thread(repo: &Path) {
    let held_here = HELD_HERE.with_borrow(|held| held.iter().any(|path| path == repo));
    assert!(
        !held_here,
        "{} is already held by this thread, and waiting for it again would never end",
        repo.display()
    );
}

/// One repository's gate, held until this drops, on whichever thread it drops.
#[must_use = "the gate is freed as soon as the turn drops"]
pub struct Turn {
    gate: Arc<Gate>,
}

impl Turn {
    fn take(repo: &Path) -> Self {
        refuse_to_wait_on_this_thread(repo);
        let gate = gate_of(repo);
        gate.take();

        Self { gate }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        self.gate.free();
    }
}

/// Wait for this process's turn to write `repo`, for a writer whose work runs on more
/// than one thread, such as a pull that awaits its git process. The gate is held until
/// the [`Turn`] drops.
///
/// The calling thread blocks while it waits, so an async caller takes its turn inside
/// a blocking task. Nothing the writer runs while it holds the turn may wait for the
/// gate itself, since it would wait on its own turn for good.
///
/// # Panics
///
/// Panics when this thread already holds `repo`'s gate through [`hold`].
pub fn wait_for_turn(repo: &git2::Repository) -> Turn {
    Turn::take(repo.path())
}

/// The gate of one repository, held by this thread until it drops.
struct Held {
    repo: PathBuf,
    _turn: Turn,
}

impl Held {
    fn take(repo: &Path) -> Self {
        let turn = Turn::take(repo);

        HELD_HERE.with_borrow_mut(|held| held.push(repo.to_path_buf()));
        Self {
            repo: repo.to_path_buf(),
            _turn: turn,
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        HELD_HERE.with_borrow_mut(|held| held.retain(|path| path != &self.repo));
    }
}

/// Run `body` as this process's only writer of `repo`.
///
/// The index is read afresh once the gate is held, so `body` starts from what the
/// writer before it saved. `repo` is a shared or a mutable borrow, whichever `body`
/// needs. A writer that panicked frees the gate as it unwinds, and the fresh read
/// drops whatever it left half-written.
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
    hold_for_git(repo, |repo| {
        repo.borrow().index()?.read(false)?;
        body(repo)
    })
}

/// Run `body`, which leaves the writing to a git process, as this process's only
/// writer of `repo`.
///
/// Unlike [`hold`], the index is not read first: git reads it for itself, and an
/// index libgit2 cannot parse, such as a split index, would otherwise refuse an action
/// git can run. What `body` decides from `repo` itself, its refs and its files, is
/// read once the gate is held.
///
/// # Errors
///
/// Returns whatever `body` returns.
///
/// # Panics
///
/// Panics when this thread already holds `repo`'s gate, as [`hold`] does.
pub fn hold_for_git<R: Borrow<git2::Repository>, T>(
    repo: R,
    body: impl FnOnce(R) -> Result<T, TrunkError>,
) -> Result<T, TrunkError> {
    let _held = Held::take(repo.borrow().path());
    body(repo)
}

#[cfg(feature = "test-util")]
type Hook = Box<dyn FnOnce() + Send>;

/// What a test runs at a point inside the gate that no outside caller can reach.
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

/// Run `hook` when the next [`hold`] or [`wait_for_turn`] of `repo` finds the gate
/// taken, just before it waits, so a test can act once a command is known to be queued.
#[cfg(feature = "test-util")]
pub fn on_next_wait(repo: &git2::Repository, hook: impl FnOnce() + Send + 'static) {
    gate_of(repo.path()).set_hook(|hooks| &mut hooks.on_wait, Box::new(hook));
}

/// Run `hook` when the gate of `repo` is next released, by a [`hold`] ending or a
/// [`Turn`] dropping.
///
/// It runs on the releasing thread, after the release and before `hold` returns or the
/// drop ends, so a test can put another writer in the gap between one command's gated
/// work and whatever the command does next. A [`Turn`] held across awaits drops on an
/// async runtime thread, where a hook that waits for the gate blocks that thread.
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
    #[should_panic(expected = "is already held by this thread")]
    fn waiting_for_a_turn_from_inside_a_body_of_the_same_repository_panics() {
        let (_dir, repo) = repository();

        let _ = hold(&repo, |repo| {
            let _turn = wait_for_turn(repo);
            Ok(())
        });
    }

    #[test]
    fn a_repository_can_be_held_again_after_a_body_panicked() {
        let (_dir, repo) = repository();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            hold(&repo, |_| -> Result<(), TrunkError> {
                panic!("the body failed")
            })
        }));
        assert!(panicked.is_err());

        let again = hold(&repo, |_| Ok("again"));

        assert_eq!(again.unwrap(), "again");
    }

    #[test]
    fn a_body_may_hold_another_repository() {
        let (_one_dir, one) = repository();
        let (_two_dir, two) = repository();

        let held = hold(&one, |_| hold(&two, |_| Ok("both")));

        assert_eq!(held.unwrap(), "both");
    }

    #[test]
    fn a_git_process_can_be_held_for_on_an_index_libgit2_cannot_read() {
        let (dir, repo) = repository();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        git(&["add", "a.txt"]);
        git(&["update-index", "--split-index"]);

        let for_libgit2 = hold(&repo, |_| Ok(()));
        let for_git = hold_for_git(&repo, |_| Ok("ran"));

        assert!(for_libgit2.is_err(), "libgit2 reads a split index here");
        assert_eq!(for_git.unwrap(), "ran");
    }

    #[test]
    fn a_repository_can_be_held_again_once_its_body_returned() {
        let (_dir, repo) = repository();
        hold(&repo, |_| Ok(())).unwrap();

        let again = hold(&repo, |_| Ok("again"));

        assert_eq!(again.unwrap(), "again");
    }
}
