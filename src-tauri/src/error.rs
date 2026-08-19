use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct TrunkError {
    pub code: String,
    pub message: String,
}

impl TrunkError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        TrunkError {
            code: code.into(),
            message: message.into(),
        }
    }

    /// Serialize to the JSON string a Tauri command returns as its `Err` payload.
    /// Serializing a two-string struct cannot realistically fail; the fallback
    /// avoids a panic on the impossible case instead of `.unwrap()`.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            String::from(r#"{"code":"serialize_error","message":"failed to serialize error"}"#)
        })
    }
}

impl From<git2::Error> for TrunkError {
    fn from(e: git2::Error) -> Self {
        TrunkError {
            code: git_error_code(e.code()).into(),
            message: e.message().to_owned(),
        }
    }
}

/// The `code` a libgit2 failure carries to the frontend. The `git_` prefix keeps
/// these out of the namespace of the domain codes commands raise by hand, so a
/// `.code` branch can tell "libgit2 said not-found" from "we decided not-found".
fn git_error_code(code: git2::ErrorCode) -> &'static str {
    use git2::ErrorCode::*;

    match code {
        GenericError => "git_error",
        NotFound => "git_not_found",
        Exists => "git_exists",
        Ambiguous => "git_ambiguous",
        BufSize => "git_buf_size",
        User => "git_user",
        BareRepo => "git_bare_repo",
        UnbornBranch => "git_unborn_branch",
        Unmerged => "git_unmerged",
        NotFastForward => "git_not_fast_forward",
        InvalidSpec => "git_invalid_spec",
        Conflict => "git_conflict",
        Locked => "git_locked",
        Modified => "git_modified",
        Auth => "git_auth",
        Certificate => "git_certificate",
        Applied => "git_applied",
        Peel => "git_peel",
        Eof => "git_eof",
        Invalid => "git_invalid",
        Uncommitted => "git_uncommitted",
        Directory => "git_directory",
        MergeConflict => "git_merge_conflict",
        HashsumMismatch => "git_hashsum_mismatch",
        IndexDirty => "git_index_dirty",
        ApplyFail => "git_apply_fail",
        Owner => "git_owner",
        Timeout => "git_timeout",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn converted(code: git2::ErrorCode) -> TrunkError {
        git2::Error::new(code, git2::ErrorClass::Reference, "boom").into()
    }

    #[test]
    fn keeps_the_libgit2_classification_in_the_code() {
        assert_eq!(converted(git2::ErrorCode::NotFound).code, "git_not_found");
    }

    #[test]
    fn spells_an_unborn_branch_apart_from_a_missing_object() {
        assert_eq!(
            converted(git2::ErrorCode::UnbornBranch).code,
            "git_unborn_branch"
        );
    }

    #[test]
    fn leaves_an_unclassified_failure_as_git_error() {
        assert_eq!(converted(git2::ErrorCode::GenericError).code, "git_error");
    }

    #[test]
    fn carries_the_libgit2_message_through() {
        let err: TrunkError = git2::Error::new(
            git2::ErrorCode::Conflict,
            git2::ErrorClass::Checkout,
            "1 conflict prevents checkout",
        )
        .into();

        assert_eq!(err.message, "1 conflict prevents checkout");
    }
}
