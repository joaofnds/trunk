//! The real background command and worker, against isolated local Git remotes.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use common::context::TestContext;
use common::graph_shapes::{raw_commit, sig_at};
use git2::{Oid, Repository};
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, Manager, WebviewWindow};
use trunk_lib::background_fetch::BackgroundFetch;
use trunk_lib::state::{CommitCache, GraphRebuild, RefVisibilityState, TrafficLights};
use trunk_lib::watcher::{RepoChanged, WatcherState};

struct Harness {
    app: App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    changes: Arc<Mutex<Vec<RepoChanged>>>,
    opened: Vec<String>,
}

impl Harness {
    fn setup() -> Self {
        Self::with_watcher(WatcherState::disabled())
    }

    fn with_watcher(watcher: WatcherState) -> Self {
        Self::with_worker(watcher, PathBuf::from(env!("CARGO_BIN_EXE_trunk")))
    }

    fn with_worker(watcher: WatcherState, worker: PathBuf) -> Self {
        let app = trunk_lib::configure_with_fetch_worker(
            mock_builder(),
            watcher,
            TrafficLights::disabled(),
            BackgroundFetch::new(worker),
        )
        .build(trunk_lib::context())
        .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let changes = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&changes);
        app.listen_any("repo-changed", move |event| {
            recorded
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
        Self {
            app,
            webview,
            changes,
            opened: Vec::new(),
        }
    }

    fn invoke(&self, command: &str, args: Value) -> Result<Value, Value> {
        invoke(&self.webview, command, args)
    }

    fn open(&mut self, path: &Path) {
        let path = path.to_str().unwrap();
        self.invoke("open_repo", json!({ "path": path })).unwrap();
        self.opened.push(path.to_owned());
    }

    fn fetch(&self, path: &Path) -> Value {
        self.invoke(
            "git_fetch_background",
            json!({ "path": path.to_str().unwrap() }),
        )
        .unwrap()
    }

    fn graph(&self, path: &Path) -> Value {
        self.invoke(
            "get_commit_graph",
            json!({ "path": path.to_str().unwrap(), "offset": 0 }),
        )
        .unwrap()
    }

    fn snapshot(&self, path: &Path) -> trunk_git::graph_input::GraphSnapshot {
        self.app
            .state::<CommitCache>()
            .snapshot(path.to_str().unwrap())
            .unwrap()
    }

    fn reconcile(&self, path: &Path) -> Option<trunk_lib::state::ReconciledGraph> {
        let cache = self.app.state::<CommitCache>();
        let visibility = self.app.state::<RefVisibilityState>();
        tauri::async_runtime::block_on(
            GraphRebuild::new(&cache, &visibility)
                .reconcile_refs(path.to_str().unwrap().to_owned(), path.to_path_buf()),
        )
        .unwrap()
    }

    fn changes(&self) -> Vec<RepoChanged> {
        self.changes.lock().unwrap().clone()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        for path in &self.opened {
            let _ = self.invoke("close_repo", json!({ "path": path }));
        }
    }
}

fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: tauri::http::HeaderMap::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

struct RemoteFixture {
    source: TestContext,
    remote: tempfile::TempDir,
    clone: tempfile::TempDir,
    root: Oid,
    existing: Oid,
}

impl RemoteFixture {
    fn new() -> Self {
        let source = TestContext::builder()
            .with_file("README.md", "root")
            .with_commit_at("Root", 1_700_000_000)
            .with_file("existing.txt", "existing")
            .with_commit_at("Existing object", 1_700_086_400)
            .build();
        let repo = source.repo();
        let existing = repo.head().unwrap().target().unwrap();
        let root = repo.find_commit(existing).unwrap().parent_id(0).unwrap();
        repo.reference("refs/heads/other", existing, true, "fixture")
            .unwrap();
        let remote = tempfile::tempdir().unwrap();
        let bare = Repository::init_bare(remote.path()).unwrap();
        bare.set_head("refs/heads/main").unwrap();
        repo.remote_anonymous(remote.path().to_str().unwrap())
            .unwrap()
            .push(
                &[
                    "refs/heads/main:refs/heads/main",
                    "refs/heads/other:refs/heads/other",
                ],
                None,
            )
            .unwrap();
        bare.reference("refs/heads/main", root, true, "fixture")
            .unwrap();
        let clone = tempfile::tempdir().unwrap();
        Repository::clone(remote.path().to_str().unwrap(), clone.path()).unwrap();
        Self {
            source,
            remote,
            clone,
            root,
            existing,
        }
    }

    fn remote(&self) -> Repository {
        Repository::open_bare(self.remote.path()).unwrap()
    }

    fn clone(&self) -> Repository {
        Repository::open(self.clone.path()).unwrap()
    }

    fn advance_main(&self) -> Oid {
        let repo = self.source.repo();
        let parent = repo.find_commit(self.existing).unwrap();
        let oid = raw_commit(
            &repo,
            &sig_at(1_700_172_800),
            "refs/heads/main",
            "Remote update",
            "new.txt",
            "new",
            &[&parent],
        );
        repo.remote_anonymous(self.remote.path().to_str().unwrap())
            .unwrap()
            .push(&["refs/heads/main:refs/heads/main"], None)
            .unwrap();
        oid
    }
}

fn assert_changed_once(
    harness: &Harness,
    path: &Path,
    before: &trunk_git::graph_input::GraphSnapshot,
) {
    let after = harness.snapshot(path);
    assert!(
        !after.same_capture_as(before),
        "a changed remote must replace the cached capture"
    );
    let graph = harness.graph(path);
    let changes = harness.changes();
    assert_eq!(
        changes,
        vec![RepoChanged {
            repo: path.to_str().unwrap().to_owned(),
            paths: Vec::new(),
            graph_revision: graph["revision"].as_u64(),
            refs_only: true,
        }]
    );
    assert!(
        harness.reconcile(path).is_none(),
        "a later duplicate ref report must not rebuild the graph"
    );
    assert!(
        harness.snapshot(path).same_capture_as(&after),
        "cached consumption must preserve the published capture"
    );
}

#[test]
fn a_remote_update_publishes_one_cached_revision() {
    let fixture = RemoteFixture::new();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let before = harness.snapshot(fixture.clone.path());
    let oid = fixture.advance_main();

    let report = harness.fetch(fixture.clone.path());

    assert_eq!(report["outcome"], "changed");
    assert_eq!(report["remotes"][0]["outcome"], "changed");
    assert_eq!(report["graph_error"], Value::Null);
    assert_eq!(
        fixture
            .clone()
            .find_reference("refs/remotes/origin/main")
            .unwrap()
            .target(),
        Some(oid)
    );
    assert_changed_once(&harness, fixture.clone.path(), &before);
}

#[test]
fn a_remote_deletion_publishes_one_cached_revision() {
    let fixture = RemoteFixture::new();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let before = harness.snapshot(fixture.clone.path());
    fixture
        .remote()
        .find_reference("refs/heads/other")
        .unwrap()
        .delete()
        .unwrap();

    let report = harness.fetch(fixture.clone.path());

    assert_eq!(report["outcome"], "changed");
    assert_eq!(
        fixture
            .clone()
            .find_reference("refs/remotes/origin/other")
            .err()
            .unwrap()
            .code(),
        git2::ErrorCode::NotFound
    );
    assert_changed_once(&harness, fixture.clone.path(), &before);
}

#[test]
fn a_tag_only_update_publishes_one_cached_revision() {
    let fixture = RemoteFixture::new();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let before = harness.snapshot(fixture.clone.path());
    fixture
        .remote()
        .reference("refs/tags/release", fixture.root, false, "fixture")
        .unwrap();

    let report = harness.fetch(fixture.clone.path());

    assert_eq!(report["outcome"], "changed");
    assert_eq!(
        fixture
            .clone()
            .find_reference("refs/tags/release")
            .unwrap()
            .target(),
        Some(fixture.root)
    );
    assert_changed_once(&harness, fixture.clone.path(), &before);
}

#[test]
fn a_ref_move_to_an_existing_object_publishes_one_cached_revision() {
    let fixture = RemoteFixture::new();
    fixture.clone().find_object(fixture.existing, None).unwrap();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let before = harness.snapshot(fixture.clone.path());
    fixture
        .remote()
        .reference("refs/heads/main", fixture.existing, true, "fixture")
        .unwrap();

    let report = harness.fetch(fixture.clone.path());

    assert_eq!(report["outcome"], "changed");
    assert_eq!(
        fixture
            .clone()
            .find_reference("refs/remotes/origin/main")
            .unwrap()
            .target(),
        Some(fixture.existing)
    );
    assert_changed_once(&harness, fixture.clone.path(), &before);
}

struct LinkedWorktree {
    _directory: tempfile::TempDir,
    path: PathBuf,
}

impl LinkedWorktree {
    fn new(fixture: &RemoteFixture) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("linked");
        let repo = fixture.clone();
        repo.reference("refs/heads/topic", fixture.existing, false, "fixture")
            .unwrap();
        let reference = repo.find_reference("refs/heads/topic").unwrap();
        repo.worktree(
            "linked",
            &path,
            Some(git2::WorktreeAddOptions::new().reference(Some(&reference))),
        )
        .unwrap();
        Self {
            _directory: directory,
            path,
        }
    }
}

fn head_oid(graph: &Value) -> &str {
    graph["commits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["is_head"] == true)
        .unwrap()["oid"]
        .as_str()
        .unwrap()
}

fn has_ref(graph: &Value, name: &str) -> bool {
    graph["commits"].as_array().unwrap().iter().any(|row| {
        row["refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| reference["name"] == name)
    })
}

#[test]
fn a_shared_ref_update_preserves_each_worktrees_head_dirtiness_and_visibility() {
    let fixture = RemoteFixture::new();
    let linked = LinkedWorktree::new(&fixture);
    let mut repo = fixture.clone();
    std::fs::write(fixture.clone.path().join("README.md"), "saved change").unwrap();
    let stash = repo
        .stash_save(&sig_at(1_700_100_000), "Saved change", None)
        .unwrap();
    std::fs::write(linked.path.join("README.md"), "unsaved change").unwrap();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    harness.open(&linked.path);
    harness.invoke("set_ref_visibility", json!({
        "path": fixture.clone.path().to_str().unwrap(),
        "visibility": { "hiddenRefs": ["refs/remotes/origin/other"], "hiddenStashes": [] }, "loaded": 0,
    })).unwrap();
    let before_a = harness.snapshot(fixture.clone.path());
    let before_b = harness.snapshot(&linked.path);
    fixture.advance_main();

    let report = harness.fetch(fixture.clone.path());
    let graph_a = harness.graph(fixture.clone.path());
    let graph_b = harness.graph(&linked.path);
    let expected_a = serde_json::to_value(
        trunk_git::graph::snapshot(&mut fixture.clone(), before_a.visibility()).unwrap(),
    )
    .unwrap();
    let expected_b = serde_json::to_value(
        trunk_git::graph::snapshot(
            &mut Repository::open(&linked.path).unwrap(),
            before_b.visibility(),
        )
        .unwrap(),
    )
    .unwrap();
    let wip_a = harness
        .invoke(
            "get_wip_diff_stats",
            json!({ "path": fixture.clone.path().to_str().unwrap() }),
        )
        .unwrap();
    let wip_b = harness
        .invoke(
            "get_wip_diff_stats",
            json!({ "path": linked.path.to_str().unwrap() }),
        )
        .unwrap();

    assert_eq!(report["outcome"], "changed");
    assert_eq!(report["graph_error"], Value::Null);
    assert_eq!(head_oid(&graph_a), fixture.root.to_string());
    assert_eq!(head_oid(&graph_b), fixture.existing.to_string());
    assert_eq!(wip_a["files_changed"], 0);
    assert_eq!(wip_b["files_changed"], 1);
    assert_eq!(graph_a["commits"], expected_a["commits"]);
    assert_eq!(graph_b["commits"], expected_b["commits"]);
    assert!(
        graph_a["commits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["is_stash"] == true && row["oid"] == stash.to_string())
    );
    assert!(
        graph_b["commits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["is_stash"] == true && row["oid"] == stash.to_string())
    );
    assert!(!has_ref(&graph_a, "refs/remotes/origin/other"));
    assert!(has_ref(&graph_b, "refs/remotes/origin/other"));
    assert_eq!(
        harness.snapshot(fixture.clone.path()).visibility(),
        before_a.visibility()
    );
    assert_eq!(
        harness.snapshot(&linked.path).visibility(),
        before_b.visibility()
    );
    assert!(
        !harness
            .snapshot(fixture.clone.path())
            .same_capture_as(&before_a)
    );
    assert!(!harness.snapshot(&linked.path).same_capture_as(&before_b));
    let mut changes = harness.changes();
    changes.sort_unstable_by(|a, b| a.repo.cmp(&b.repo));
    let mut expected = vec![
        RepoChanged {
            repo: fixture.clone.path().to_str().unwrap().to_owned(),
            paths: Vec::new(),
            graph_revision: graph_a["revision"].as_u64(),
            refs_only: true,
        },
        RepoChanged {
            repo: linked.path.to_str().unwrap().to_owned(),
            paths: Vec::new(),
            graph_revision: graph_b["revision"].as_u64(),
            refs_only: true,
        },
    ];
    expected.sort_unstable_by(|a, b| a.repo.cmp(&b.repo));
    assert_eq!(changes, expected);
    assert!(harness.reconcile(fixture.clone.path()).is_none());
    assert!(harness.reconcile(&linked.path).is_none());
}

#[test]
fn cached_visibility_changes_preserve_the_capture_without_a_repository_read() {
    let fixture = RemoteFixture::new();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let before = harness.snapshot(fixture.clone.path());
    let git_dir = fixture.clone().path().to_path_buf();
    let parked = fixture.clone.path().join("parked-git");
    std::fs::rename(&git_dir, &parked).unwrap();

    let changed = harness.invoke(
        "set_ref_visibility",
        json!({
            "path": fixture.clone.path().to_str().unwrap(),
            "visibility": { "hiddenRefs": ["refs/remotes/origin/other"], "hiddenStashes": [] },
            "loaded": 200,
        }),
    );
    std::fs::rename(&parked, &git_dir).unwrap();
    let changed = changed.unwrap();

    assert!(
        harness
            .snapshot(fixture.clone.path())
            .same_capture_as(&before)
    );
    assert!(!has_ref(&changed, "refs/remotes/origin/other"));
}

#[test]
fn uncached_visibility_capture_is_stamped_for_the_next_unchanged_fetch() {
    let fixture = RemoteFixture::new();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let path = fixture.clone.path().to_str().unwrap();
    let warmed = harness.fetch(fixture.clone.path());
    assert_eq!(warmed["graph_error"], Value::Null);
    assert!(matches!(
        remote_outcome(&warmed, "origin")["outcome"].as_str(),
        Some("changed" | "unchanged")
    ));

    // Keep the repository registered while forcing the visibility command down
    // its uncached capture path, as when the first graph has not landed yet.
    harness.app.state::<CommitCache>().open_session(path);
    let visible = harness
        .invoke(
            "set_ref_visibility",
            json!({
                "path": path,
                "visibility": {
                    "hiddenRefs": ["refs/remotes/origin/other"],
                    "hiddenStashes": []
                },
                "loaded": 0,
            }),
        )
        .unwrap();
    let before = harness.snapshot(fixture.clone.path());
    let changes = harness.changes();
    assert!(!has_ref(&visible, "refs/remotes/origin/other"));

    let report = harness.fetch(fixture.clone.path());
    let after = harness.snapshot(fixture.clone.path());

    assert_eq!(report["outcome"], "unchanged");
    assert_eq!(report["graph_rebuilds"], 0);
    assert!(after.same_capture_as(&before));
    assert_eq!(after.visibility(), before.visibility());
    assert!(!has_ref(
        &harness.graph(fixture.clone.path()),
        "refs/remotes/origin/other"
    ));
    assert_eq!(harness.changes(), changes);
}

#[test]
fn each_linked_worktree_fetches_its_private_destination_and_fetch_head() {
    let fixture = RemoteFixture::new();
    let linked = LinkedWorktree::new(&fixture);
    fixture
        .clone()
        .config()
        .unwrap()
        .set_str(
            "remote.origin.fetch",
            "+refs/heads/main:refs/worktree/from-origin",
        )
        .unwrap();
    let repo_a = fixture.clone();
    let repo_b = Repository::open(&linked.path).unwrap();
    let fetch_head_a = repo_a.path().join("FETCH_HEAD");
    let fetch_head_b = repo_b.path().join("FETCH_HEAD");
    let _ = std::fs::remove_file(&fetch_head_a);
    let _ = std::fs::remove_file(&fetch_head_b);
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    harness.open(&linked.path);
    let oid = fixture.advance_main();

    let report_a = harness.fetch(fixture.clone.path());
    let first_fetch_head = std::fs::read_to_string(&fetch_head_a).unwrap();
    let private_b_before = repo_b
        .find_reference("refs/worktree/from-origin")
        .err()
        .unwrap()
        .code();
    let report_b = harness.fetch(&linked.path);

    assert_eq!(report_a["outcome"], "changed");
    assert_eq!(report_b["outcome"], "changed");
    assert_eq!(private_b_before, git2::ErrorCode::NotFound);
    assert_eq!(
        repo_a
            .find_reference("refs/worktree/from-origin")
            .unwrap()
            .target(),
        Some(oid)
    );
    assert_eq!(
        repo_b
            .find_reference("refs/worktree/from-origin")
            .unwrap()
            .target(),
        Some(oid)
    );
    assert!(first_fetch_head.contains(&oid.to_string()));
    assert!(
        std::fs::read_to_string(fetch_head_b)
            .unwrap()
            .contains(&oid.to_string())
    );
    assert_eq!(
        std::fs::read_to_string(fetch_head_a).unwrap(),
        first_fetch_head
    );
}

fn remote_outcome<'a>(report: &'a Value, remote: &str) -> &'a Value {
    report["remotes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|outcome| outcome["remote"] == remote)
        .unwrap()
}

#[test]
fn a_failed_remote_backs_off_while_healthy_updates_are_published() {
    let fixture = RemoteFixture::new();
    fixture
        .clone()
        .remote(
            "z-failed",
            fixture.remote.path().join("missing.git").to_str().unwrap(),
        )
        .unwrap();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let clock = harness.app.state::<BackgroundFetch>();
    clock.set_time_ms(10_000);
    let oid = fixture.advance_main();

    let first = harness.fetch(fixture.clone.path());
    let first_graph = harness.graph(fixture.clone.path());
    let first_fetch_head =
        std::fs::read_to_string(fixture.clone().path().join("FETCH_HEAD")).unwrap();
    let first_target = fixture
        .clone()
        .find_reference("refs/remotes/origin/main")
        .unwrap()
        .target();
    let first_failed = remote_outcome(&first, "z-failed");
    let first_retry = first_failed["retry_at_ms"].as_u64().unwrap();
    let first_attempt = first_failed["last_attempt_ms"].as_u64().unwrap();
    assert_eq!(first_attempt, 10_000);
    assert!((96_000..=120_000).contains(&(first_retry - first_attempt)));
    fixture
        .remote()
        .reference("refs/heads/main", fixture.existing, true, "fixture")
        .unwrap();
    clock.set_time_ms(first_retry - 1);
    let second = harness.fetch(fixture.clone.path());

    assert_eq!(first["outcome"], "failed");
    assert_eq!(remote_outcome(&first, "z-failed")["outcome"], "failed");
    assert_eq!(
        remote_outcome(&first, "z-failed")["last_success_ms"],
        Value::Null
    );
    assert!(
        remote_outcome(&first, "z-failed")["retry_at_ms"]
            .as_u64()
            .unwrap()
            > remote_outcome(&first, "z-failed")["last_attempt_ms"]
                .as_u64()
                .unwrap()
    );
    assert_eq!(remote_outcome(&first, "origin")["outcome"], "changed");
    assert_eq!(first["graph_error"], Value::Null);
    assert_eq!(first_target, Some(oid));
    assert!(
        first_fetch_head.contains(&oid.to_string()),
        "a later remote failure must preserve the healthy remote's fetch metadata"
    );
    assert!(
        first_graph["commits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["oid"] == oid.to_string())
    );
    assert_eq!(
        remote_outcome(&second, "z-failed")["outcome"],
        "skipped_backoff"
    );
    assert_eq!(
        remote_outcome(&second, "z-failed")["last_attempt_ms"],
        remote_outcome(&first, "z-failed")["last_attempt_ms"]
    );
    assert_eq!(
        remote_outcome(&first, "z-failed")["last_attempt_ms"],
        10_000
    );
    assert_eq!(
        remote_outcome(&first, "z-failed")["retry_at_ms"],
        first_retry
    );
    assert_eq!(remote_outcome(&second, "origin")["outcome"], "changed");
    assert!(remote_outcome(&second, "origin")["last_success_ms"].is_u64());
    assert_eq!(
        fixture
            .clone()
            .find_reference("refs/remotes/origin/main")
            .unwrap()
            .target(),
        Some(fixture.existing)
    );
    assert_eq!(harness.changes().len(), 2);

    clock.set_time_ms(first_retry);
    let retried = harness.fetch(fixture.clone.path());
    assert_eq!(remote_outcome(&retried, "z-failed")["outcome"], "failed");
    assert_eq!(
        remote_outcome(&retried, "z-failed")["last_attempt_ms"],
        first_retry
    );
    let second_retry = remote_outcome(&retried, "z-failed")["retry_at_ms"]
        .as_u64()
        .unwrap();
    assert!((192_000..=240_000).contains(&(second_retry - first_retry)));
    assert_eq!(harness.changes().len(), 2);
}

#[test]
fn failed_and_unsupported_remotes_before_origin_do_not_preserve_stale_fetch_head() {
    let fixture = RemoteFixture::new();
    let repo = fixture.clone();
    repo.remote(
        "a-missing",
        fixture.remote.path().join("missing.git").to_str().unwrap(),
    )
    .unwrap();
    repo.remote("b-unsupported", fixture.remote.path().to_str().unwrap())
        .unwrap();
    repo.config()
        .unwrap()
        .set_str("remote.b-unsupported.uploadpack", "custom-upload-pack")
        .unwrap();
    let fetch_head = repo.path().join("FETCH_HEAD");
    let stale = format!("{}\t\tbranch 'stale' of stale\n", fixture.root);
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    std::fs::write(&fetch_head, stale.as_bytes()).unwrap();
    let updated = fixture.advance_main();

    let first = harness.fetch(fixture.clone.path());
    let first_metadata = std::fs::read(&fetch_head).unwrap();
    let first_lines = String::from_utf8(first_metadata.clone()).unwrap();
    let mut first_oids: Vec<String> = first_lines
        .lines()
        .map(|line| line.split_whitespace().next().unwrap().to_owned())
        .collect();
    first_oids.sort();
    let mut expected_oids = vec![updated.to_string(), fixture.existing.to_string()];
    expected_oids.sort();

    assert_eq!(remote_outcome(&first, "a-missing")["outcome"], "failed");
    assert_eq!(
        remote_outcome(&first, "b-unsupported")["outcome"],
        "unsupported"
    );
    assert_eq!(remote_outcome(&first, "origin")["outcome"], "changed");
    assert_eq!(first["graph_rebuilds"], 1);
    assert_eq!(
        first_lines.lines().count(),
        2,
        "only origin's branches belong in FETCH_HEAD"
    );
    assert_eq!(first_oids, expected_oids);
    assert!(!first_lines.contains("stale"));

    let path = fixture.clone.path().to_str().unwrap();
    harness
        .invoke("close_repo", json!({ "path": path }))
        .unwrap();
    harness.open(fixture.clone.path());
    let second = harness.fetch(fixture.clone.path());
    let second_metadata = std::fs::read(&fetch_head).unwrap();

    assert_eq!(remote_outcome(&second, "a-missing")["outcome"], "failed");
    assert_eq!(
        remote_outcome(&second, "b-unsupported")["outcome"],
        "unsupported"
    );
    assert_eq!(remote_outcome(&second, "origin")["outcome"], "unchanged");
    assert_eq!(second["graph_rebuilds"], 0);
    assert_eq!(
        second_metadata, first_metadata,
        "reopening and retrying must not accumulate FETCH_HEAD lines"
    );
    assert_eq!(harness.changes().len(), 1);
}

#[test]
fn a_successful_manual_fetch_clears_failure_and_suppresses_an_immediate_background_check() {
    let fixture = RemoteFixture::new();
    let repo = fixture.clone();
    repo.remote_set_url(
        "origin",
        fixture.remote.path().join("missing.git").to_str().unwrap(),
    )
    .unwrap();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let clock = harness.app.state::<BackgroundFetch>();
    clock.set_time_ms(10_000);
    let failed = harness.fetch(fixture.clone.path());
    assert_eq!(remote_outcome(&failed, "origin")["outcome"], "failed");
    assert!(remote_outcome(&failed, "origin")["error_code"].is_string());
    repo.remote_set_url("origin", fixture.remote.path().to_str().unwrap())
        .unwrap();
    clock.set_time_ms(20_000);

    let manual = harness
        .invoke(
            "git_fetch",
            json!({ "path": fixture.clone.path().to_str().unwrap() }),
        )
        .unwrap();
    let cached = harness.snapshot(fixture.clone.path());
    let changes = harness.changes();
    let automatic = harness.fetch(fixture.clone.path());

    assert_eq!(manual["outcome"], "unchanged");
    assert_eq!(manual["graph_error"], Value::Null);
    let success = remote_outcome(&manual, "origin");
    assert_eq!(success["outcome"], "unchanged");
    assert_eq!(remote_outcome(&failed, "origin")["last_attempt_ms"], 10_000);
    assert_eq!(success["last_success_ms"], 20_000);
    assert_eq!(success["last_attempt_ms"], success["last_success_ms"]);
    assert_eq!(success["retry_at_ms"], Value::Null);
    assert_eq!(success["error_code"], Value::Null);
    assert_eq!(success["error_message"], Value::Null);
    assert_eq!(automatic["outcome"], "skipped_fresh");
    assert_eq!(
        remote_outcome(&automatic, "origin")["outcome"],
        "skipped_fresh"
    );
    assert_eq!(
        remote_outcome(&automatic, "origin")["last_success_ms"],
        success["last_success_ms"]
    );
    assert!(
        harness
            .snapshot(fixture.clone.path())
            .same_capture_as(&cached)
    );
    assert_eq!(harness.changes(), changes);

    clock.set_time_ms(79_999);
    let still_fresh = harness.fetch(fixture.clone.path());
    assert_eq!(
        remote_outcome(&still_fresh, "origin")["outcome"],
        "skipped_fresh"
    );
    clock.set_time_ms(80_000);
    let due = harness.fetch(fixture.clone.path());
    assert_eq!(remote_outcome(&due, "origin")["outcome"], "unchanged");
    assert_eq!(remote_outcome(&due, "origin")["last_attempt_ms"], 80_000);
    assert_eq!(remote_outcome(&due, "origin")["last_success_ms"], 80_000);

    clock.set_time_ms(140_000);
    let next = harness.fetch(fixture.clone.path());
    assert_eq!(remote_outcome(&next, "origin")["outcome"], "unchanged");
    assert_eq!(remote_outcome(&next, "origin")["last_attempt_ms"], 140_000);
    assert_eq!(remote_outcome(&next, "origin")["last_success_ms"], 140_000);
}

#[test]
fn a_successful_manual_pull_resets_only_its_healthy_upstream_remote() {
    let fixture = RemoteFixture::new();
    fixture
        .clone()
        .remote(
            "z-failed",
            fixture.remote.path().join("missing.git").to_str().unwrap(),
        )
        .unwrap();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let clock = harness.app.state::<BackgroundFetch>();
    clock.set_time_ms(10_000);
    let previous = harness.fetch(fixture.clone.path());
    assert_eq!(remote_outcome(&previous, "origin")["outcome"], "unchanged");
    assert_eq!(remote_outcome(&previous, "z-failed")["outcome"], "failed");
    let oid = fixture.advance_main();
    clock.set_time_ms(20_000);

    let pulled = harness
        .invoke(
            "git_pull",
            json!({ "path": fixture.clone.path().to_str().unwrap(), "strategy": "ff-only" }),
        )
        .unwrap();
    let cached = harness.snapshot(fixture.clone.path());
    let changes = harness.changes();
    let automatic = harness.fetch(fixture.clone.path());

    assert_eq!(fixture.clone().head().unwrap().target(), Some(oid));
    assert_eq!(pulled["graph_error"], Value::Null);
    let healthy = remote_outcome(&pulled, "origin");
    assert_eq!(healthy["outcome"], "unchanged");
    assert!(
        healthy["last_success_ms"].as_u64().unwrap()
            >= remote_outcome(&previous, "origin")["last_success_ms"]
                .as_u64()
                .unwrap()
    );
    assert_eq!(healthy["last_attempt_ms"], healthy["last_success_ms"]);
    assert_eq!(healthy["retry_at_ms"], Value::Null);
    assert_eq!(healthy["error_code"], Value::Null);
    assert_eq!(
        remote_outcome(&pulled, "z-failed"),
        remote_outcome(&previous, "z-failed")
    );
    assert_eq!(
        remote_outcome(&automatic, "origin")["outcome"],
        "skipped_fresh"
    );
    assert_eq!(
        remote_outcome(&automatic, "origin")["last_success_ms"],
        healthy["last_success_ms"]
    );
    assert_eq!(
        remote_outcome(&automatic, "z-failed")["outcome"],
        "skipped_backoff"
    );
    assert_eq!(
        remote_outcome(&automatic, "z-failed")["last_attempt_ms"],
        remote_outcome(&previous, "z-failed")["last_attempt_ms"]
    );
    assert_eq!(
        remote_outcome(&automatic, "z-failed")["retry_at_ms"],
        remote_outcome(&previous, "z-failed")["retry_at_ms"]
    );
    assert_eq!(
        remote_outcome(&automatic, "z-failed")["error_code"],
        remote_outcome(&previous, "z-failed")["error_code"]
    );
    assert!(
        harness
            .snapshot(fixture.clone.path())
            .same_capture_as(&cached)
    );
    assert_eq!(harness.changes(), changes);
}

fn error_code(error: Value) -> String {
    serde_json::from_str::<Value>(error.as_str().unwrap()).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn graph_indexed_reads_reject_a_replaced_revision_before_any_notification() {
    let fixture = RemoteFixture::new();
    let mut harness = Harness::setup();
    harness.open(fixture.clone.path());
    let old_revision = harness.graph(fixture.clone.path())["revision"]
        .as_u64()
        .unwrap();
    fixture
        .clone()
        .reference(
            "refs/remotes/origin/main",
            fixture.existing,
            true,
            "external fetch",
        )
        .unwrap();
    let published = harness.reconcile(fixture.clone.path()).unwrap();

    let page = harness.invoke("get_commit_graph", json!({ "path": fixture.clone.path().to_str().unwrap(), "offset": 200, "revision": old_revision }));
    let stats = harness.invoke("get_commit_stats", json!({ "path": fixture.clone.path().to_str().unwrap(), "offset": 0, "revision": old_revision }));
    let current = harness
        .invoke(
            "get_commit_graph",
            json!({ "path": fixture.clone.path().to_str().unwrap(), "offset": 0, "loaded": 400 }),
        )
        .unwrap();

    assert!(
        harness.changes().is_empty(),
        "revision fencing must work before an event is emitted"
    );
    assert!(published.revision > old_revision);
    assert_eq!(error_code(page.unwrap_err()), "graph_changed");
    assert_eq!(error_code(stats.unwrap_err()), "graph_changed");
    assert_eq!(current["revision"], published.revision);
    assert_eq!(current["commits"].as_array().unwrap().len(), 2);
}

#[cfg(unix)]
mod cancellation {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::thread::{self, JoinHandle};

    use super::*;
    use trunk_lib::state::RunningOp;

    struct BlockedWorker {
        directory: tempfile::TempDir,
        executable: PathBuf,
        wake: std::fs::File,
        reader: Option<JoinHandle<()>>,
        exit: PathBuf,
        exit_reader: Option<JoinHandle<()>>,
    }

    enum FetchEvent {
        WorkerBlocked,
        DescendantExited,
        WorktreeChanged(RepoChanged),
        Finished(Value),
    }

    impl BlockedWorker {
        fn setup(events: Sender<FetchEvent>) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let ready = dir.path().join("ready");
            let blocked = dir.path().join("blocked");
            let exit = dir.path().join("helper-lifetime");
            create_fifo(&ready);
            create_fifo(&blocked);
            create_fifo(&exit);
            let ready_file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&ready)
                .unwrap();
            let descendant_script = dir.path().join("blocked-descendant.sh");
            std::fs::write(
                &descendant_script,
                format!(
                    "exec 3> {}\nprintf 'ready\\n' > {}\nIFS= read -r marker < {}\n",
                    shell_quote(&exit),
                    shell_quote(&ready),
                    shell_quote(&blocked),
                ),
            )
            .unwrap();
            let executable = dir.path().join("fetch-worker");
            std::fs::write(
                &executable,
                format!(
                    "#!/bin/sh\nIFS= read -r request || [ -n \"$request\" ]\ncase \"$request\" in\n  *'\"remote\":\"blocked\"'*) /bin/sh {} & descendant=$!; wait \"$descendant\" ;;\n  *) printf '%s' \"$request\" | {} --background-fetch-worker ;;\nesac\n",
                    shell_quote(&descendant_script),
                    shell_quote(Path::new(env!("CARGO_BIN_EXE_trunk"))),
                ),
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let exit_path = exit.clone();
            let exit_events = events.clone();
            let exit_reader = thread::spawn(move || {
                let mut lifetime = std::fs::File::open(exit_path).unwrap();
                let mut byte = [0_u8; 1];
                assert_eq!(lifetime.read(&mut byte).unwrap(), 0);
                let _ = exit_events.send(FetchEvent::DescendantExited);
            });
            let mut ready = BufReader::new(ready_file.try_clone().unwrap());
            let reader = thread::spawn(move || {
                let mut line = String::new();
                ready.read_line(&mut line).unwrap();
                if line == "ready\n" {
                    let _ = events.send(FetchEvent::WorkerBlocked);
                }
            });
            Self {
                directory: dir,
                executable,
                wake: ready_file,
                reader: Some(reader),
                exit,
                exit_reader: Some(exit_reader),
            }
        }

        fn shell_setup(events: Sender<FetchEvent>) -> Self {
            let worker = Self::setup(events);
            let shell = worker.directory.path().join("blocked-descendant.sh");
            let script = std::fs::read_to_string(&shell).unwrap();
            std::fs::write(&shell, format!("#!/bin/sh\n{script}")).unwrap();
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::write(
                &worker.executable,
                format!(
                    "#!/bin/sh\nexport SHELL={}\nexec {} --background-fetch-worker\n",
                    shell_quote(&shell),
                    shell_quote(Path::new(env!("CARGO_BIN_EXE_trunk"))),
                ),
            )
            .unwrap();

            worker
        }

        fn wait_for_request(events: &Receiver<FetchEvent>) {
            match events.recv().unwrap() {
                FetchEvent::WorkerBlocked => {}
                FetchEvent::DescendantExited => {
                    panic!("the descendant exited before reaching its request barrier")
                }
                FetchEvent::WorktreeChanged(_) => {
                    panic!("a local edit was reported before the descendant request barrier")
                }
                FetchEvent::Finished(report) => {
                    panic!("the fetch finished before reaching the worker barrier: {report}")
                }
            }
        }

        fn wait_for_exit(events: &Receiver<FetchEvent>) {
            loop {
                match events.recv().unwrap() {
                    FetchEvent::DescendantExited => break,
                    FetchEvent::Finished(_) | FetchEvent::WorktreeChanged(_) => {}
                    FetchEvent::WorkerBlocked => {
                        panic!("the descendant request barrier was reported twice")
                    }
                }
            }
        }
    }

    fn wait_for_worktree_change(events: &Receiver<FetchEvent>, paths: &[&str]) -> RepoChanged {
        loop {
            match events.recv().unwrap() {
                FetchEvent::WorktreeChanged(change)
                    if change
                        .paths
                        .iter()
                        .any(|file| paths.contains(&file.as_str())) =>
                {
                    return change;
                }
                FetchEvent::WorktreeChanged(_) => {}
                FetchEvent::WorkerBlocked => {
                    panic!("the descendant request barrier was reported twice")
                }
                FetchEvent::DescendantExited => {
                    panic!("the descendant exited before the local edit was observed")
                }
                FetchEvent::Finished(report) => {
                    panic!("the fetch finished before the local edit was observed: {report}")
                }
            }
        }
    }

    impl Drop for BlockedWorker {
        fn drop(&mut self) {
            let _ = self.wake.write_all(b"closed\n");
            self.reader.take().unwrap().join().unwrap();
            // Also unblock the lifetime reader if a transport failure never launched
            // the descendant. Opening both ends never waits for a second FIFO opener.
            drop(
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&self.exit)
                    .unwrap(),
            );
            self.exit_reader.take().unwrap().join().unwrap();
        }
    }

    fn create_fifo(path: &Path) {
        let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: the path is a valid NUL-terminated string in an owned temporary directory.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    }

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
    }

    #[test]
    fn cancellation_covers_a_worker_blocked_in_login_shell_initialization() {
        let fixture = RemoteFixture::new();
        let (events, observations) = mpsc::channel();
        let worker = BlockedWorker::shell_setup(events.clone());
        let mut harness = Harness::with_worker(WatcherState::disabled(), worker.executable.clone());
        harness.open(fixture.clone.path());
        let path = fixture.clone.path().to_str().unwrap().to_owned();
        let webview = harness.webview.clone();
        let worker_path = path.clone();
        let job = thread::spawn(move || {
            let report = invoke(
                &webview,
                "git_fetch_background",
                json!({"path": worker_path}),
            )
            .unwrap();
            let _ = events.send(FetchEvent::Finished(report.clone()));
            report
        });
        BlockedWorker::wait_for_request(&observations);

        harness
            .invoke("cancel_remote_op", json!({"path": path}))
            .unwrap();
        let report = job.join().unwrap();
        BlockedWorker::wait_for_exit(&observations);

        assert_eq!(report["outcome"], "cancelled");
        assert!(
            !harness
                .app
                .state::<RunningOp>()
                .0
                .lock()
                .unwrap()
                .busy(&path)
        );
    }

    #[test]
    fn cancellation_survives_a_fetch_metadata_repair_failure() {
        let fixture = RemoteFixture::new();
        let repo = fixture.clone();
        repo.remote_delete("origin").unwrap();
        repo.remote("aaa", fixture.remote.path().to_str().unwrap())
            .unwrap();
        repo.remote("blocked", fixture.remote.path().to_str().unwrap())
            .unwrap();
        repo.remote("zzz", fixture.remote.path().to_str().unwrap())
            .unwrap();
        let (events, observations) = mpsc::channel();
        let worker = BlockedWorker::setup(events.clone());
        let mut harness = Harness::with_worker(WatcherState::disabled(), worker.executable.clone());
        harness.open(fixture.clone.path());
        let path = fixture.clone.path().to_str().unwrap().to_owned();
        let webview = harness.webview.clone();
        let worker_path = path.clone();
        let job = thread::spawn(move || {
            let report = invoke(
                &webview,
                "git_fetch_background",
                json!({ "path": worker_path }),
            )
            .unwrap();
            let _ = events.send(FetchEvent::Finished(report.clone()));
            report
        });
        BlockedWorker::wait_for_request(&observations);
        let metadata = repo.path().join("FETCH_HEAD");
        assert!(!std::fs::read(&metadata).unwrap().is_empty());
        std::fs::remove_file(&metadata).unwrap();
        std::fs::create_dir(&metadata).unwrap();
        harness
            .invoke("cancel_remote_op", json!({ "path": path }))
            .unwrap();
        let report = job.join().unwrap();
        BlockedWorker::wait_for_exit(&observations);

        assert_eq!(report["outcome"], "cancelled");
        let remotes = report["remotes"].as_array().unwrap();
        assert_eq!(
            remotes.len(),
            2,
            "cancellation must not start the last remote"
        );
        assert_eq!(remotes[1]["remote"], "blocked");
        assert_eq!(remotes[1]["outcome"], "cancelled");
        assert_eq!(remotes[1]["error_code"], "cancelled");
        assert_eq!(remotes[1]["metadata_error_code"], "fetch_head_error");
        assert!(remotes[1]["metadata_error_message"].is_string());
        assert!(
            !harness
                .app
                .state::<RunningOp>()
                .0
                .lock()
                .unwrap()
                .busy(&path)
        );
    }

    #[test]
    fn cancellation_joins_a_blocked_worker_and_allows_the_next_job() {
        let fixture = RemoteFixture::new();
        let other = RemoteFixture::new();
        let repo = fixture.clone();
        repo.remote("blocked", fixture.remote.path().to_str().unwrap())
            .unwrap();
        let (events, observations) = mpsc::channel();
        let worker = BlockedWorker::setup(events.clone());
        let mut harness = Harness::with_worker(WatcherState::disabled(), worker.executable.clone());
        harness.open(fixture.clone.path());
        harness.open(other.clone.path());
        let path = fixture.clone.path().to_str().unwrap().to_owned();
        let worker_webview = harness.webview.clone();
        let worker_path = path.clone();
        let job = thread::spawn(move || {
            let report = invoke(
                &worker_webview,
                "git_fetch_background",
                json!({ "path": worker_path }),
            )
            .unwrap();
            let _ = events.send(FetchEvent::Finished(report.clone()));
            report
        });
        BlockedWorker::wait_for_request(&observations);
        assert!(
            harness
                .app
                .state::<RunningOp>()
                .0
                .lock()
                .unwrap()
                .busy(&path)
        );

        let busy = harness.fetch(fixture.clone.path());
        let other_busy = harness.fetch(other.clone.path());
        let manual_busy = harness.invoke("git_fetch", json!({ "path": path }));
        harness
            .invoke("cancel_remote_op", json!({ "path": path }))
            .unwrap();
        let cancelled = job.join().unwrap();
        BlockedWorker::wait_for_exit(&observations);
        repo.remote_delete("blocked").unwrap();
        let next = harness.fetch(fixture.clone.path());

        assert_eq!(busy["outcome"], "skipped_busy");
        assert_eq!(other_busy["outcome"], "skipped_busy");
        assert_eq!(error_code(manual_busy.unwrap_err()), "op_in_progress");
        assert_eq!(cancelled["outcome"], "cancelled");
        assert_eq!(cancelled["remotes"][0]["outcome"], "cancelled");
        assert!(
            !harness
                .app
                .state::<RunningOp>()
                .0
                .lock()
                .unwrap()
                .busy(&path)
        );
        assert_eq!(
            next["outcome"], "changed",
            "removing the blocked remote invalidates the captured fetch mappings"
        );
        assert_eq!(next["remotes"][0]["outcome"], "unchanged");
        assert!(next["remotes"][0]["last_success_ms"].is_u64());
    }

    #[test]
    fn a_local_edit_remains_observable_while_a_background_fetch_is_blocked() {
        let fixture = RemoteFixture::new();
        let repo = fixture.clone();
        repo.remote("blocked", fixture.remote.path().to_str().unwrap())
            .unwrap();
        let (events, observations) = mpsc::channel();
        let worker = BlockedWorker::setup(events.clone());
        let mut harness = Harness::with_worker(WatcherState::default(), worker.executable.clone());
        harness.open(fixture.clone.path());
        let path = fixture.clone.path().to_str().unwrap().to_owned();
        let worker_webview = harness.webview.clone();
        let worker_path = path.clone();
        let worker_events = events.clone();
        let job = thread::spawn(move || {
            let report = invoke(
                &worker_webview,
                "git_fetch_background",
                json!({ "path": worker_path }),
            )
            .unwrap();
            let _ = worker_events.send(FetchEvent::Finished(report.clone()));
            report
        });
        BlockedWorker::wait_for_request(&observations);
        let watched_path = path.clone();
        harness.app.listen_any("repo-changed", move |event| {
            let change: RepoChanged = serde_json::from_str(event.payload()).unwrap();
            if change.repo == watched_path
                && change
                    .paths
                    .iter()
                    .any(|file| file == "README.md" || file == ".git/index")
            {
                let _ = events.send(FetchEvent::WorktreeChanged(change));
            }
        });

        std::fs::write(
            fixture.clone.path().join("README.md"),
            "edited during fetch\n",
        )
        .unwrap();
        let change = wait_for_worktree_change(&observations, &["README.md"]);
        let unstaged = harness
            .invoke("get_status", json!({ "path": path }))
            .unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        let index_change = wait_for_worktree_change(&observations, &[".git/index"]);
        let staged = harness
            .invoke("get_status", json!({ "path": path }))
            .unwrap();
        let wip = harness
            .invoke("get_wip_diff_stats", json!({ "path": path }))
            .unwrap();
        let held_during_edit = harness
            .app
            .state::<RunningOp>()
            .0
            .lock()
            .unwrap()
            .busy(&path);
        harness
            .invoke("cancel_remote_op", json!({ "path": path }))
            .unwrap();
        let cancelled = job.join().unwrap();
        BlockedWorker::wait_for_exit(&observations);

        assert_eq!(change.repo, path);
        assert!(change.paths.iter().any(|file| file == "README.md"));
        assert!(!change.refs_only);
        assert_eq!(change.graph_revision, None);
        assert_eq!(index_change.repo, path);
        assert!(index_change.paths.iter().any(|file| file == ".git/index"));
        assert!(!index_change.refs_only);
        assert_eq!(index_change.graph_revision, None);
        assert!(
            unstaged["unstaged"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file["path"] == "README.md")
        );
        assert!(
            staged["staged"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file["path"] == "README.md")
        );
        assert!(staged["unstaged"].as_array().unwrap().is_empty());
        assert_eq!(wip["files_changed"], 1);
        assert!(
            held_during_edit,
            "local changes must be delivered before the fetch reservation is released"
        );
        assert_eq!(cancelled["outcome"], "cancelled");
    }

    fn assert_local_context_event(change: &RepoChanged, path: &str) {
        assert_eq!(change.repo, path);
        assert!(!change.refs_only);
        assert_eq!(change.graph_revision, None);
    }

    #[test]
    fn head_config_and_stash_changes_remain_observable_while_a_fetch_is_blocked() {
        let fixture = RemoteFixture::new();
        let mut repo = fixture.clone();
        std::fs::write(
            fixture.clone.path().join("README.md"),
            "saved before fetch\n",
        )
        .unwrap();
        let stash = repo
            .stash_save(&sig_at(1_700_100_000), "Saved before fetch", None)
            .unwrap();
        repo.remote("blocked", fixture.remote.path().to_str().unwrap())
            .unwrap();
        let (events, observations) = mpsc::channel();
        let worker = BlockedWorker::setup(events.clone());
        let mut harness = Harness::with_worker(WatcherState::default(), worker.executable.clone());
        harness.open(fixture.clone.path());
        assert!(
            harness.graph(fixture.clone.path())["commits"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["is_stash"] == true && row["oid"] == stash.to_string())
        );
        let path = fixture.clone.path().to_str().unwrap().to_owned();
        let worker_webview = harness.webview.clone();
        let worker_path = path.clone();
        let worker_events = events.clone();
        let job = thread::spawn(move || {
            let report = invoke(
                &worker_webview,
                "git_fetch_background",
                json!({ "path": worker_path }),
            )
            .unwrap();
            let _ = worker_events.send(FetchEvent::Finished(report.clone()));
            report
        });
        BlockedWorker::wait_for_request(&observations);
        let watched_path = path.clone();
        harness.app.listen_any("repo-changed", move |event| {
            let change: RepoChanged = serde_json::from_str(event.payload()).unwrap();
            if change.repo == watched_path
                && change.paths.iter().any(|file| {
                    [
                        ".git/HEAD",
                        ".git/config",
                        ".git/refs/stash",
                        ".git/logs/refs/stash",
                    ]
                    .contains(&file.as_str())
                })
            {
                let _ = events.send(FetchEvent::WorktreeChanged(change));
            }
        });

        repo.set_head_detached(fixture.root).unwrap();
        let head_change = wait_for_worktree_change(&observations, &[".git/HEAD"]);
        let detached = harness
            .invoke(
                "refresh_commit_graph",
                json!({ "path": path, "loaded": 200 }),
            )
            .unwrap();
        repo.config()
            .unwrap()
            .set_str("branch.main.merge", "refs/heads/other")
            .unwrap();
        let config_change = wait_for_worktree_change(&observations, &[".git/config"]);
        let configured = harness
            .invoke("list_refs", json!({ "path": path }))
            .unwrap();
        repo.stash_drop(0).unwrap();
        let stash_change =
            wait_for_worktree_change(&observations, &[".git/refs/stash", ".git/logs/refs/stash"]);
        let without_stash = harness
            .invoke(
                "refresh_commit_graph",
                json!({ "path": path, "loaded": 200 }),
            )
            .unwrap();
        let current_refs = harness
            .invoke("list_refs", json!({ "path": path }))
            .unwrap();
        let expected = serde_json::to_value(
            trunk_git::graph::snapshot(
                &mut repo,
                &trunk_git::graph_input::RefVisibility::default(),
            )
            .unwrap(),
        )
        .unwrap();
        let held_during_changes = harness
            .app
            .state::<RunningOp>()
            .0
            .lock()
            .unwrap()
            .busy(&path);
        harness
            .invoke("cancel_remote_op", json!({ "path": path }))
            .unwrap();
        let cancelled = job.join().unwrap();
        BlockedWorker::wait_for_exit(&observations);

        assert_local_context_event(&head_change, &path);
        assert_local_context_event(&config_change, &path);
        assert_local_context_event(&stash_change, &path);
        assert!(repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().target(), Some(fixture.root));
        assert_eq!(
            detached["commits"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["oid"] == fixture.root.to_string())
                .unwrap()["column"],
            0
        );
        assert_eq!(
            detached["commits"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|row| row["refs"].as_array().unwrap())
                .find(|reference| reference["name"] == "refs/heads/main")
                .unwrap()["is_head"],
            false,
        );
        assert_eq!(
            configured["local"]
                .as_array()
                .unwrap()
                .iter()
                .find(|branch| branch["name"] == "main")
                .unwrap()["upstream"],
            "origin/other"
        );
        assert!(current_refs["stashes"].as_array().unwrap().is_empty());
        assert!(
            without_stash["commits"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["is_stash"] == false)
        );
        assert_eq!(without_stash["commits"], expected["commits"]);
        assert_eq!(
            without_stash["commits"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["oid"] == fixture.root.to_string())
                .unwrap()["column"],
            0
        );
        assert!(
            held_during_changes,
            "local Git context changes must be delivered before the blocked fetch is released"
        );
        assert_eq!(cancelled["outcome"], "cancelled");
    }
}
