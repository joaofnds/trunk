use crate::common::context::TestContext;
use trunk_lib::state::OpenRepos;

pub struct TestContextBuilder {
    steps: Vec<BuildStep>,
}

/// One index edit waiting for the next commit, kept in the order the caller
/// declared it.
enum PendingChange {
    Add(String),
    Remove(String),
}

enum BuildStep {
    WriteFile {
        path: String,
        content: Vec<u8>,
    },
    WriteBinaryFile {
        path: String,
        content: Vec<u8>,
    },
    RemoveFile {
        path: String,
    },
    Commit {
        message: String,
        secs: Option<i64>,
    },
    Branch {
        name: String,
    },
    Checkout {
        name: String,
    },
    Merge {
        branch: String,
    },
    Conflict {
        branch: String,
    },
    Tag {
        name: String,
    },
    Stash {
        message: Option<String>,
    },
    Remote {
        name: String,
    },
    Tracking {
        remote: String,
        branch: String,
    },
    Pushed {
        remote: String,
        branch: String,
    },
    RemoteCommit {
        remote: String,
        branch: String,
        path: String,
        content: String,
        message: String,
    },
}

/// 2026-01-01T00:00:00Z, the same base `scripts/qa-*-fixtures.sh` pin. Commits are spaced a
/// day apart because the graph sorts with `TOPOLOGICAL | TIME`: same-second commits sort
/// arbitrarily and can render a coincidentally-correct layout.
const FIXTURE_BASE_SECS: i64 = 1_767_225_600;
const FIXTURE_DAY_SECS: i64 = 86_400;

/// A signature pinned to `secs`, so a rebuild of one shape produces byte-identical history.
fn pinned_signature(secs: i64) -> git2::Signature<'static> {
    git2::Signature::new("Test User", "test@example.com", &git2::Time::new(secs, 0))
        .expect("build a pinned signature")
}

impl TestContextBuilder {
    pub const fn new() -> Self {
        Self { steps: Vec::new() }
    }

    pub fn with_file(&mut self, path: &str, content: &str) -> &mut Self {
        self.steps.push(BuildStep::WriteFile {
            path: path.to_string(),
            content: content.as_bytes().to_vec(),
        });
        self
    }

    pub fn with_binary_file(&mut self, path: &str, content: &[u8]) -> &mut Self {
        self.steps.push(BuildStep::WriteBinaryFile {
            path: path.to_string(),
            content: content.to_vec(),
        });
        self
    }

    /// Delete a tracked file from the workdir and the index, so the next commit
    /// records the removal. Paired with `with_file` under a new name, this is how
    /// a fixture states a rename that git must detect by content similarity.
    pub fn with_removed_file(&mut self, path: &str) -> &mut Self {
        self.steps.push(BuildStep::RemoveFile {
            path: path.to_string(),
        });
        self
    }

    pub fn with_commit(&mut self, message: &str) -> &mut Self {
        self.steps.push(BuildStep::Commit {
            message: message.to_string(),
            secs: None,
        });
        self
    }

    /// A commit at the timestamp the caller names, leaving the day-spacing clock
    /// `with_commit` reads exactly where it was.
    pub fn with_commit_at(&mut self, message: &str, secs: i64) -> &mut Self {
        self.steps.push(BuildStep::Commit {
            message: message.to_string(),
            secs: Some(secs),
        });
        self
    }

    pub fn with_branch(&mut self, name: &str) -> &mut Self {
        self.steps.push(BuildStep::Branch {
            name: name.to_string(),
        });
        self
    }

    pub fn checkout(&mut self, name: &str) -> &mut Self {
        self.steps.push(BuildStep::Checkout {
            name: name.to_string(),
        });
        self
    }

    pub fn merge(&mut self, branch: &str) -> &mut Self {
        self.steps.push(BuildStep::Merge {
            branch: branch.to_string(),
        });
        self
    }

    pub fn with_conflict(&mut self, branch: &str) -> &mut Self {
        self.steps.push(BuildStep::Conflict {
            branch: branch.to_string(),
        });
        self
    }

    pub fn with_tag(&mut self, name: &str) -> &mut Self {
        self.steps.push(BuildStep::Tag {
            name: name.to_string(),
        });
        self
    }

    pub fn with_stash(&mut self, message: Option<&str>) -> &mut Self {
        self.steps.push(BuildStep::Stash {
            message: message.map(std::string::ToString::to_string),
        });
        self
    }

    pub fn with_remote(&mut self, name: &str) -> &mut Self {
        self.steps.push(BuildStep::Remote {
            name: name.to_string(),
        });
        self
    }

    /// Points `branch` at `remote`, which `with_remote` deliberately leaves
    /// unconfigured, so a bare `git pull`/`git push` has a target.
    pub fn with_tracking(&mut self, remote: &str, branch: &str) -> &mut Self {
        self.steps.push(BuildStep::Tracking {
            remote: remote.to_string(),
            branch: branch.to_string(),
        });
        self
    }

    /// Publishes `branch` to `remote` and points the tracking ref at it, standing
    /// in for the clone the repository would have come from.
    pub fn with_pushed(&mut self, remote: &str, branch: &str) -> &mut Self {
        self.steps.push(BuildStep::Pushed {
            remote: remote.to_string(),
            branch: branch.to_string(),
        });
        self
    }

    /// Commits straight into the bare remote, standing in for another clone
    /// pushing to it. `branch` must already exist there: push it first.
    pub fn with_remote_commit(
        &mut self,
        remote: &str,
        branch: &str,
        path: &str,
        content: &str,
        message: &str,
    ) -> &mut Self {
        self.steps.push(BuildStep::RemoteCommit {
            remote: remote.to_string(),
            branch: branch.to_string(),
            path: path.to_string(),
            content: content.to_string(),
            message: message.to_string(),
        });
        self
    }

    pub fn build(&mut self) -> TestContext {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let mut repo = git2::Repository::init(dir.path()).expect("failed to init repo");
        // Every commit-producing step takes the next day off this clock. `repo.signature()`
        // reads the wall clock, which made two builds of one shape produce different OIDs and
        // left the graph's TOPOLOGICAL | TIME sort resolving by tie-break at machine speed.
        let mut clock = FIXTURE_BASE_SECS;

        // Configure user identity
        let mut cfg = repo.config().expect("failed to get config");
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        drop(cfg);

        // Set HEAD to point at main branch
        repo.set_head("refs/heads/main").unwrap();

        // Index edits waiting for the next Commit, in declaration order: a step
        // rewriting a path the same commit removed must land as the caller wrote
        // it, not be cancelled by a removal replayed afterwards.
        let mut pending: Vec<PendingChange> = Vec::new();
        let mut stash_counter: usize = 0;

        for step in &self.steps {
            match step {
                BuildStep::WriteFile { path, content }
                | BuildStep::WriteBinaryFile { path, content } => {
                    let full_path = dir.path().join(path);
                    if let Some(parent) = full_path.parent() {
                        std::fs::create_dir_all(parent).unwrap();
                    }
                    std::fs::write(&full_path, content).unwrap();
                    pending.push(PendingChange::Add(path.clone()));
                }

                BuildStep::RemoveFile { path } => {
                    std::fs::remove_file(dir.path().join(path)).unwrap();
                    pending.push(PendingChange::Remove(path.clone()));
                }

                BuildStep::Commit { message, secs } => {
                    let sig = if let Some(secs) = secs {
                        pinned_signature(*secs)
                    } else {
                        let sig = pinned_signature(clock);
                        clock += FIXTURE_DAY_SECS;
                        sig
                    };
                    let mut index = repo.index().unwrap();

                    for change in &pending {
                        match change {
                            PendingChange::Add(file) => {
                                index.add_path(std::path::Path::new(file)).unwrap();
                            }
                            PendingChange::Remove(file) => {
                                index.remove_path(std::path::Path::new(file)).unwrap();
                            }
                        }
                    }
                    index.write().unwrap();
                    pending.clear();

                    let tree_oid = index.write_tree().unwrap();
                    let tree = repo.find_tree(tree_oid).unwrap();

                    // Get current HEAD as parent (if it exists)
                    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
                    let parents: Vec<&git2::Commit> =
                        parent.as_ref().map(|p| vec![p]).unwrap_or_default();

                    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
                        .unwrap();
                }

                BuildStep::Branch { name } => {
                    let head = repo.head().unwrap().peel_to_commit().unwrap();
                    repo.branch(name, &head, false).unwrap();
                }

                BuildStep::Checkout { name } => {
                    repo.set_head(&format!("refs/heads/{name}")).unwrap();
                    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
                        .unwrap();
                }

                BuildStep::Merge { branch } => {
                    let sig = pinned_signature(clock);
                    clock += FIXTURE_DAY_SECS;

                    // Find the branch tip
                    let branch_ref = repo.find_branch(branch, git2::BranchType::Local).unwrap();
                    let their_commit = branch_ref.get().peel_to_commit().unwrap();

                    // Get current HEAD
                    let our_commit = repo.head().unwrap().peel_to_commit().unwrap();

                    // Merge the two trees
                    let ancestor = repo
                        .find_commit(repo.merge_base(our_commit.id(), their_commit.id()).unwrap())
                        .unwrap();
                    let ancestor_tree = ancestor.tree().unwrap();
                    let our_tree = our_commit.tree().unwrap();
                    let their_tree = their_commit.tree().unwrap();

                    let mut merge_index = repo
                        .merge_trees(&ancestor_tree, &our_tree, &their_tree, None)
                        .unwrap();

                    let tree_oid = merge_index.write_tree_to(&repo).unwrap();
                    let tree = repo.find_tree(tree_oid).unwrap();

                    let msg = format!("Merge branch '{branch}'");
                    repo.commit(
                        Some("HEAD"),
                        &sig,
                        &sig,
                        &msg,
                        &tree,
                        &[&our_commit, &their_commit],
                    )
                    .unwrap();
                }

                BuildStep::Conflict { branch } => {
                    let branch_ref = repo.find_branch(branch, git2::BranchType::Local).unwrap();
                    let their_commit = branch_ref.get().peel_to_commit().unwrap();
                    let annotated = repo.find_annotated_commit(their_commit.id()).unwrap();

                    repo.merge(&[&annotated], None, None).unwrap();
                    // Leave the repo in merge/conflict state -- do NOT commit
                }

                BuildStep::Tag { name } => {
                    let head = repo.head().unwrap().peel_to_commit().unwrap();
                    let obj = head.as_object();
                    repo.tag_lightweight(name, obj, false).unwrap();
                }

                BuildStep::Stash { message } => {
                    let sig = pinned_signature(clock);
                    clock += FIXTURE_DAY_SECS;

                    // Need a tracked file that is modified to create a stash
                    let stash_marker = dir.path().join(".stash_marker");
                    if !stash_marker.exists() {
                        // Create and commit the marker file first
                        std::fs::write(&stash_marker, "initial").unwrap();
                        let mut index = repo.index().unwrap();
                        index
                            .add_path(std::path::Path::new(".stash_marker"))
                            .unwrap();
                        index.write().unwrap();

                        let tree_oid = index.write_tree().unwrap();
                        let tree = repo.find_tree(tree_oid).unwrap();
                        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
                        let parents: Vec<&git2::Commit> =
                            parent.as_ref().map(|p| vec![p]).unwrap_or_default();
                        repo.commit(
                            Some("HEAD"),
                            &sig,
                            &sig,
                            "Add stash marker",
                            &tree,
                            &parents,
                        )
                        .unwrap();
                    }

                    // Modify the tracked file to create something to stash
                    std::fs::write(&stash_marker, format!("modified-{stash_counter}")).unwrap();
                    stash_counter += 1;

                    let msg = message.as_deref();
                    repo.stash_save(&sig, msg.unwrap_or("stash"), None).unwrap();
                }

                BuildStep::Remote { name } => {
                    // Create a bare repo as the remote
                    let bare_path = dir.path().join(format!("{name}.git"));
                    git2::Repository::init_bare(&bare_path).unwrap();

                    let bare_url = bare_path.display().to_string();
                    repo.remote(name, &bare_url).unwrap();
                }

                BuildStep::Tracking { remote, branch } => {
                    let mut cfg = repo.config().unwrap();
                    cfg.set_str(&format!("branch.{branch}.remote"), remote)
                        .unwrap();
                    cfg.set_str(
                        &format!("branch.{branch}.merge"),
                        &format!("refs/heads/{branch}"),
                    )
                    .unwrap();
                }

                BuildStep::Pushed { remote, branch } => {
                    let mut handle = repo.find_remote(remote).unwrap();
                    handle
                        .push(&[format!("refs/heads/{branch}:refs/heads/{branch}")], None)
                        .unwrap();

                    let tip = repo
                        .find_reference(&format!("refs/heads/{branch}"))
                        .unwrap()
                        .peel_to_commit()
                        .unwrap();

                    // Written here rather than left to the push: over the local transport
                    // libgit2 need not update the tip, and without it the branch has no
                    // upstream to be ahead of.
                    repo.reference(
                        &format!("refs/remotes/{remote}/{branch}"),
                        tip.id(),
                        true,
                        "seed the tracking ref",
                    )
                    .unwrap();
                }

                BuildStep::RemoteCommit {
                    remote,
                    branch,
                    path,
                    content,
                    message,
                } => {
                    let sig = pinned_signature(clock);
                    clock += FIXTURE_DAY_SECS;

                    let bare_path = dir.path().join(format!("{remote}.git"));
                    let bare = git2::Repository::open(&bare_path).unwrap();
                    let tip = bare
                        .find_reference(&format!("refs/heads/{branch}"))
                        .unwrap()
                        .peel_to_commit()
                        .unwrap();

                    let blob = bare.blob(content.as_bytes()).unwrap();
                    let mut tree = bare.treebuilder(Some(&tip.tree().unwrap())).unwrap();
                    tree.insert(path, blob, git2::FileMode::Blob.into())
                        .unwrap();
                    let tree = bare.find_tree(tree.write().unwrap()).unwrap();

                    bare.commit(
                        Some(&format!("refs/heads/{branch}")),
                        &sig,
                        &sig,
                        message,
                        &tree,
                        &[&tip],
                    )
                    .unwrap();
                }
            }
        }

        drop(repo);

        let path = dir.path().display().to_string();
        let state_map = OpenRepos::from_iter([(path.clone(), dir.path().to_path_buf())]);

        TestContext::from_parts(dir, path, state_map)
    }
}
