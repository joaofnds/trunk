use crate::error::TrunkError;

/// Classifies git stderr output into structured error codes.
pub fn classify_git_error(stderr: &str) -> TrunkError {
    // Stub - will be implemented in GREEN phase
    TrunkError::new("unimplemented", stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- classify_git_error tests ---

    #[test]
    fn classify_auth_failure_password() {
        let err = classify_git_error("fatal: Authentication failed for 'https://github.com/user/repo.git'");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_auth_failure_ssh() {
        let err = classify_git_error("permission denied (publickey).");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_auth_failure_remote_read() {
        let err = classify_git_error("fatal: could not read from remote repository.");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_auth_failure_host_key() {
        let err = classify_git_error("Host key verification failed.");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_auth_failure_connection_refused() {
        let err = classify_git_error("ssh: connect to host github.com port 22: Connection refused");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_non_fast_forward() {
        let err = classify_git_error("! [rejected] main -> main (non-fast-forward)");
        assert_eq!(err.code, "non_fast_forward");
    }

    #[test]
    fn classify_non_fast_forward_fetch_first() {
        let err = classify_git_error("hint: Updates were rejected because the remote contains work that you do not have locally. Fetch first.");
        assert_eq!(err.code, "non_fast_forward");
    }

    #[test]
    fn classify_non_fast_forward_failed_push() {
        let err = classify_git_error("error: failed to push some refs to 'origin'");
        assert_eq!(err.code, "non_fast_forward");
    }

    #[test]
    fn classify_no_upstream() {
        let err = classify_git_error("fatal: The current branch feature has no upstream branch.");
        assert_eq!(err.code, "no_upstream");
    }

    #[test]
    fn classify_generic_error() {
        let err = classify_git_error("some random error that doesn't match any pattern");
        assert_eq!(err.code, "remote_error");
    }

    #[test]
    fn classify_mixed_case_auth() {
        let err = classify_git_error("FATAL: AUTHENTICATION FAILED");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_combined_stderr_with_progress_and_error() {
        let stderr = "Counting objects: 100% (3/3), done.\nfatal: Authentication failed for 'https://github.com/user/repo.git'";
        let err = classify_git_error(stderr);
        assert_eq!(err.code, "auth_failure");
    }
}
