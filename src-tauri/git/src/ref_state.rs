use crate::error::TrunkError;

/// Ref identities, stash order and upstream configuration, without a history or status walk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefState {
    refs: Vec<(Vec<u8>, Vec<u8>)>,
    upstreams: Vec<(String, String)>,
    fetch_refspecs: Vec<(String, Vec<String>)>,
    stashes: Vec<git2::Oid>,
    head: Option<(Vec<u8>, Vec<u8>)>,
}

impl RefState {
    /// Read refs, the worktree's HEAD, stash order and configured upstream mappings.
    ///
    /// # Errors
    ///
    /// Returns repository reference, configuration or reflog errors.
    pub fn read(repo: &git2::Repository) -> Result<Self, TrunkError> {
        let mut refs = repo
            .references()?
            .map(|reference| reference.map(|reference| identity(&reference)))
            .collect::<Result<Vec<_>, _>>()?;
        match repo.find_reference("HEAD") {
            Ok(head) => refs.push(identity(&head)),
            Err(error) if error.code() == git2::ErrorCode::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        refs.sort_unstable();
        let config = repo.config()?.snapshot()?;
        let mut upstreams = Vec::new();
        config.entries(Some("branch.*"))?.for_each(|entry| {
            if let Ok(name) = entry.name()
                && name
                    .rsplit_once('.')
                    .is_some_and(|(_, key)| matches!(key, "remote" | "merge"))
            {
                upstreams.push((
                    name.to_owned(),
                    entry.value().unwrap_or_default().to_owned(),
                ));
            }
        })?;
        upstreams.sort_unstable();
        // Upstream resolution uses the first matching fetch refspec. Sort remote keys,
        // but retain each remote's configured refspec order.
        let mut fetch_refspecs = std::collections::BTreeMap::<String, Vec<String>>::new();
        config.entries(Some("remote.*"))?.for_each(|entry| {
            if let Ok(name) = entry.name()
                && name.rsplit_once('.').is_some_and(|(_, key)| key == "fetch")
            {
                fetch_refspecs
                    .entry(name.to_owned())
                    .or_default()
                    .push(entry.value().unwrap_or_default().to_owned());
            }
        })?;
        let stashes = match repo.reflog("refs/stash") {
            Ok(log) => log.iter().map(|entry| entry.id_new()).collect(),
            Err(error) if error.code() == git2::ErrorCode::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        let head = match repo.head() {
            Ok(head) => Some(identity(&head)),
            Err(error)
                if matches!(
                    error.code(),
                    git2::ErrorCode::NotFound | git2::ErrorCode::UnbornBranch
                ) =>
            {
                None
            }
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            refs,
            upstreams,
            fetch_refspecs: fetch_refspecs.into_iter().collect(),
            stashes,
            head,
        })
    }

    #[must_use]
    pub fn changes_worktree_context(&self, previous: &Self) -> bool {
        self.head != previous.head || self.stashes != previous.stashes
    }
}

fn identity(reference: &git2::Reference<'_>) -> (Vec<u8>, Vec<u8>) {
    let target = reference.target().map_or_else(
        || {
            reference
                .symbolic_target_bytes()
                .unwrap_or_default()
                .to_vec()
        },
        |oid| oid.as_bytes().to_vec(),
    );
    (reference.name_bytes().to_vec(), target)
}

#[cfg(test)]
mod tests {
    use super::RefState;

    fn repository_with_two_upstream_destinations() -> (tempfile::TempDir, git2::Repository) {
        let directory = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init_bare(directory.path()).unwrap();
        let config = git2::Config::open(&repo.path().join("config")).unwrap();
        repo.set_config(&config).unwrap();
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let first_signature = git2::Signature::new(
            "Fixture",
            "fixture@example.invalid",
            &git2::Time::new(1_000, 0),
        )
        .unwrap();
        let first = repo
            .commit(
                Some("refs/heads/main"),
                &first_signature,
                &first_signature,
                "first",
                &tree,
                &[],
            )
            .unwrap();
        let second_signature = git2::Signature::new(
            "Fixture",
            "fixture@example.invalid",
            &git2::Time::new(2_000, 0),
        )
        .unwrap();
        let second = repo
            .commit(
                None,
                &second_signature,
                &second_signature,
                "second",
                &tree,
                &[],
            )
            .unwrap();
        drop(tree);
        repo.set_head("refs/heads/main").unwrap();
        repo.reference("refs/remotes/origin/main", first, false, "fixture")
            .unwrap();
        repo.reference("refs/remotes/alternate/main", second, false, "fixture")
            .unwrap();
        repo.remote("origin", "file:///unused-fixture-remote")
            .unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("branch.main.remote", "origin").unwrap();
        config
            .set_str("branch.main.merge", "refs/heads/main")
            .unwrap();

        (directory, repo)
    }

    #[test]
    fn an_upstream_fetch_mapping_change_invalidates_captured_inputs() {
        let (_directory, repo) = repository_with_two_upstream_destinations();
        let before = RefState::read(&repo).unwrap();
        let previous_upstream = repo
            .find_branch("main", git2::BranchType::Local)
            .unwrap()
            .upstream()
            .unwrap()
            .get()
            .target();

        repo.config()
            .unwrap()
            .set_str(
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/alternate/*",
            )
            .unwrap();
        let after = RefState::read(&repo).unwrap();
        let current_upstream = repo
            .find_branch("main", git2::BranchType::Local)
            .unwrap()
            .upstream()
            .unwrap()
            .get()
            .target();

        assert_ne!(previous_upstream, current_upstream);
        assert_ne!(
            before, after,
            "the capture stamp missed the changed upstream mapping"
        );
    }

    #[test]
    fn reordered_fetch_mappings_invalidate_the_upstream_capture() {
        let (_directory, repo) = repository_with_two_upstream_destinations();
        let mut config = repo.config().unwrap();
        config
            .set_multivar(
                "remote.origin.fetch",
                "^$",
                "+refs/heads/*:refs/remotes/alternate/*",
            )
            .unwrap();
        let before = RefState::read(&repo).unwrap();
        let previous_upstream = repo
            .find_branch("main", git2::BranchType::Local)
            .unwrap()
            .upstream()
            .unwrap()
            .get()
            .target();

        config.remove_multivar("remote.origin.fetch", ".*").unwrap();
        config
            .set_multivar(
                "remote.origin.fetch",
                "^$",
                "+refs/heads/*:refs/remotes/alternate/*",
            )
            .unwrap();
        config
            .set_multivar(
                "remote.origin.fetch",
                "^$",
                "+refs/heads/*:refs/remotes/origin/*",
            )
            .unwrap();
        let after = RefState::read(&repo).unwrap();
        let current_upstream = repo
            .find_branch("main", git2::BranchType::Local)
            .unwrap()
            .upstream()
            .unwrap()
            .get()
            .target();

        assert_ne!(previous_upstream, current_upstream);
        assert_ne!(before, after, "the capture stamp lost fetch-spec ordering");
    }
}
