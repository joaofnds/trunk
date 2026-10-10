use crate::error::TrunkError;

/// Ref identities and targets only: comparing these never walks commit history or status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefState {
    refs: Vec<(Vec<u8>, Vec<u8>)>,
    upstreams: Vec<(String, String)>,
    stashes: Vec<git2::Oid>,
    head: Option<(Vec<u8>, Vec<u8>)>,
}

impl RefState {
    /// Read loose and packed refs, symbolic targets and the worktree's HEAD.
    ///
    /// # Errors
    ///
    /// Returns the repository's reference-reading error.
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
