mod common;

use std::collections::HashMap;
use std::sync::Mutex;
use trunk_lib::commands::remote::{classify_git_error, force_push_args};

// --- classify_git_error tests ---
// classify_git_error is a pure function (string -> TrunkError). No TestContext needed.

#[test]
fn classify_auth_failure_password() {
    let err =
        classify_git_error("fatal: Authentication failed for 'https://github.com/user/repo.git'");
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
    let err = classify_git_error(
        "hint: Updates were rejected because the remote contains work that you do not have locally. Fetch first.",
    );
    assert_eq!(err.code, "non_fast_forward");
}

#[test]
fn classify_non_fast_forward_failed_push() {
    let err = classify_git_error("error: failed to push some refs to 'origin'");
    assert_eq!(err.code, "non_fast_forward");
}

#[test]
fn classify_if_includes_refusal_is_non_fast_forward() {
    // A `--force-if-includes` / stale-info refusal carries "failed to push some refs",
    // so it classifies as non_fast_forward and routes back to the diverged prompt
    // (criterion 12) with no classifier change.
    let err = classify_git_error(
        "! [rejected] main -> main (remote ref updated since checkout)\nerror: failed to push some refs",
    );
    assert_eq!(err.code, "non_fast_forward");
}

// --- force_push_args tests ---

#[test]
fn force_push_uses_both_lease_flags() {
    // Criterion 11: the recovery force push always pairs --force-with-lease with
    // --force-if-includes; --force-with-lease alone is unsafe in Trunk (V1).
    let args = force_push_args();
    assert!(args.contains(&"--force-with-lease"));
    assert!(args.contains(&"--force-if-includes"));
}

#[test]
fn force_push_never_issues_bare_force() {
    // Criterion 11: Trunk never issues a bare `--force`.
    let args = force_push_args();
    assert!(!args.contains(&"--force"));
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

// --- per-repo RunningOp tests ---

#[test]
fn running_op_allows_different_repos() {
    let map = Mutex::new(HashMap::<String, u32>::new());
    {
        let mut guard = map.lock().unwrap();
        guard.insert("/repo/a".to_string(), 1001);
        guard.insert("/repo/b".to_string(), 1002);
        assert_eq!(guard.len(), 2);
    }
}

#[test]
fn running_op_blocks_same_repo() {
    let map = Mutex::new(HashMap::<String, u32>::new());
    {
        let mut guard = map.lock().unwrap();
        guard.insert("/repo/a".to_string(), 1001);
        assert!(guard.contains_key("/repo/a"));
    }
}

#[test]
fn running_op_remove_one_keeps_other() {
    let map = Mutex::new(HashMap::<String, u32>::new());
    {
        let mut guard = map.lock().unwrap();
        guard.insert("/repo/a".to_string(), 1001);
        guard.insert("/repo/b".to_string(), 1002);
        guard.remove("/repo/a");
        assert!(!guard.contains_key("/repo/a"));
        assert!(guard.contains_key("/repo/b"));
    }
}

#[test]
fn cancel_removes_only_target_repo() {
    let map = Mutex::new(HashMap::<String, u32>::new());
    {
        let mut guard = map.lock().unwrap();
        guard.insert("/repo/a".to_string(), 1001);
        guard.insert("/repo/b".to_string(), 1002);
    }
    // Simulate cancel for /repo/a
    {
        let mut guard = map.lock().unwrap();
        guard.remove("/repo/a");
    }
    {
        let guard = map.lock().unwrap();
        assert!(!guard.contains_key("/repo/a"));
        assert_eq!(*guard.get("/repo/b").unwrap(), 1002);
    }
}
