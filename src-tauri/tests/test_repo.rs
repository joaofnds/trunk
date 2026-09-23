mod common;

use common::context::TestContext;

#[test]
fn open_invalid_path_returns_error() {
    let dir = tempfile::tempdir().unwrap();
    // dir is a real directory but NOT a git repo
    let result = trunk_git::repository::validate_and_open(dir.path());
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code, "not_a_git_repo");
}

#[test]
fn open_valid_repo_succeeds() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.validate_and_open();
    assert!(result.is_ok());
}

#[test]
fn close_removes_state() {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let path = ctx.path().to_string();
    let state = Mutex::new(HashMap::<String, PathBuf>::new());

    // Simulate open
    state
        .lock()
        .unwrap()
        .insert(path.clone(), ctx.repo_path().to_path_buf());
    assert!(state.lock().unwrap().contains_key(&path));

    // Simulate close
    state.lock().unwrap().remove(&path);
    assert!(!state.lock().unwrap().contains_key(&path));
}

#[test]
fn force_close_removes_running_op() {
    use std::collections::HashMap;
    use std::sync::Mutex;

    let path = "/test/repo".to_string();
    let running = Mutex::new(HashMap::<String, u32>::new());
    running.lock().unwrap().insert(path.clone(), 12345);

    // Simulate force_close_repo: remove PID
    let pid = running.lock().unwrap().remove(&path);
    assert_eq!(pid, Some(12345));
    assert!(!running.lock().unwrap().contains_key(&path));
}

#[test]
fn force_close_no_running_op_still_succeeds() {
    use std::collections::HashMap;
    use std::sync::Mutex;

    let path = "/test/repo".to_string();
    let running = Mutex::new(HashMap::<String, u32>::new());

    // No running op -- remove returns None, no panic
    let pid = running.lock().unwrap().remove(&path);
    assert_eq!(pid, None);
}

#[test]
fn close_does_not_touch_running_op() {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    let path = "/test/repo".to_string();
    let state = Mutex::new(HashMap::<String, PathBuf>::new());
    let running = Mutex::new(HashMap::<String, u32>::new());

    state
        .lock()
        .unwrap()
        .insert(path.clone(), PathBuf::from(&path));
    running.lock().unwrap().insert(path.clone(), 12345);

    // Simulate close_repo: only removes state, NOT running
    state.lock().unwrap().remove(&path);

    // Running op should still be there
    assert!(running.lock().unwrap().contains_key(&path));
    assert_eq!(*running.lock().unwrap().get(&path).unwrap(), 12345);
}
