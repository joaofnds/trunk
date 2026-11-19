use super::*;
use serde_json::json;

#[test]
fn unaccepted_targets_cannot_start_signed_update_actions() {
    let mut coordinator = Coordinator::default();
    assert!(coordinator.begin(Phase::Checking).is_err());
    assert!(!coordinator.status.eligible);
    assert_eq!(coordinator.resting_phase(), Phase::Manual);
}

#[test]
fn network_actions_are_serial_and_cancellation_keeps_ownership_until_settled() {
    let mut coordinator = Coordinator::default();
    coordinator.status.eligible = true;
    coordinator.status.adopted = true;
    coordinator.settle(None);
    let cancel = coordinator.begin(Phase::Checking).unwrap();
    cancel.cancel();
    assert!(coordinator.begin(Phase::Downloading).is_err());
    coordinator.settle(Some("cancelled".into()));
    assert_eq!(coordinator.status.phase, Phase::Idle);
    assert!(coordinator.begin(Phase::Checking).is_ok());
}

#[test]
fn feed_rejects_a_changed_baseline_prerelease_oversize_and_cross_release_url() {
    let valid = json!({"version":"2.0.0","platforms":{"darwin-aarch64":{
        "url":"https://github.com/joaofnds/trunk/releases/download/v2.0.0/Trunk.app.tar.gz",
        "signature":"unused", "minimumOsVersion":"13.0", "size":4,
        "sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    }}});
    assert!(manifest_identity(&valid, "darwin-aarch64", "13.0").is_ok());
    for (path, value) in [
        ("/version", json!("2.0.0-beta.1")),
        ("/platforms/darwin-aarch64/minimumOsVersion", json!("14.0")),
        (
            "/platforms/darwin-aarch64/size",
            json!(MAX_ARTIFACT_BYTES + 1),
        ),
        (
            "/platforms/darwin-aarch64/url",
            json!("https://github.com/joaofnds/trunk/releases/download/v1.0.0/Trunk.app.tar.gz"),
        ),
    ] {
        let mut invalid = valid.clone();
        *invalid.pointer_mut(path).unwrap() = value;
        assert!(manifest_identity(&invalid, "darwin-aarch64", "13.0").is_err());
    }
}

const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE0OUVGNDc0NkZBNkU2RDcKUldUWDVxWnZkUFNlcERHV2cyYno4bjZBclFuQk13Z1FLMWdlVm9zb3JjYkx6Y3VuRCtLSitjWWU=";
const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUWDVxWnZkUFNlcFBGMnpzanZQL0wvVFF0QkxSbldSdmFxKzRvbUsxVUV1Z3RRcC9VU3JHaUkxdjc2MnNEeTNpZDNhb3I3YlJDOUVUeWVvdDZsTUhIcldvWjVoalVNMVFjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNjQ5MDUxCWZpbGU6cGF5bG9hZAl2ZXJzaW9uOjIuMC4wCkREcTJDTE9FbDVjUW1DMmVKUkhsblpQVlZpT1pzdTFDanBQS1FvZWk0QS9YQmZrRHFHTzBCK1FNcmNySGdFUTVxVjNtbmU3NXRkRldoSnBxVVhoOUFBPT0=";

fn prepared_app() -> tauri::App<tauri::test::MockRuntime> {
    use tauri::test::{mock_builder, mock_context, noop_assets};
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({"pubkey":PUBLIC_KEY,"requireSignedVersion":true}),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(crate::activity::ActivityState::default())
        .manage(UpdateState::default())
        .manage(crate::state::RepoState(Mutex::default()))
        .manage(crate::state::CommitCache::new(
            crate::state::GraphCache::default(),
        ))
        .build(context)
        .unwrap();
    let update = configured_updater(app.handle(), "darwin-aarch64", PUBLIC_KEY)
        .unwrap()
        .restore_update(json!({"version":"2.0.0","platforms":{"darwin-aarch64":{
            "url":"https://github.com/joaofnds/trunk/releases/download/v2.0.0/test.app.tar.gz",
            "signature":SIGNATURE
        }}}))
        .unwrap()
        .unwrap();
    update.verify(b"test").unwrap();
    {
        let state = app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        coordinator.status.eligible = true;
        coordinator.status.adopted = true;
        coordinator.status.version = Some("2.0.0".into());
        coordinator.installation = Some((
            "darwin-aarch64".into(),
            "/Applications/Trunk.app/Contents/MacOS/trunk".into(),
        ));
        coordinator.candidate = Some(Candidate {
            update,
            hash: trunk_update_release::sha256(b"test"),
            size: 4,
        });
        coordinator.bytes = Some(Arc::new(b"test".to_vec()));
        coordinator.settle(None);
    }
    app
}

#[test]
fn failed_refresh_preserves_the_verified_download() {
    let app = prepared_app();

    let result = tauri::async_runtime::block_on(check_with_discovery(
        app.handle().clone(),
        |_, target, _| async move {
            assert_eq!(target, "darwin-aarch64");
            Err("offline".into())
        },
    ));

    assert_eq!(result.err().as_deref(), Some("offline"));
    let refreshed = status(app.handle());
    assert_eq!(refreshed.phase, Phase::Ready);
    assert_eq!(refreshed.version.as_deref(), Some("2.0.0"));
    assert_eq!(refreshed.message.as_deref(), Some("offline"));
    {
        let state = app.state::<UpdateState>();
        let coordinator = state.0.lock().unwrap();
        coordinator
            .candidate
            .as_ref()
            .unwrap()
            .update
            .verify(coordinator.bytes.as_ref().unwrap())
            .unwrap();
    }
    let token = prepare(app.handle(), "2.0.0").unwrap();
    assert_eq!(status(app.handle()).phase, Phase::Preparing);
    abort(app.handle(), &token).unwrap();
}

#[test]
fn no_update_refresh_clears_an_undownloaded_candidate() {
    let app = prepared_app();
    {
        let state = app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        coordinator.bytes = None;
        coordinator.status.notes = Some("Earlier release notes".into());
        coordinator.status.downloaded = 2;
        coordinator.status.total = Some(4);
        coordinator.settle(None);
    }

    let refreshed = tauri::async_runtime::block_on(check_with_discovery(
        app.handle().clone(),
        |_, _, _| async { Ok(None) },
    ))
    .unwrap();

    assert_eq!(refreshed.phase, Phase::Idle);
    assert!(refreshed.version.is_none());
    assert!(refreshed.notes.is_none());
    assert_eq!(refreshed.downloaded, 0);
    assert!(refreshed.total.is_none());
    assert_eq!(refreshed.message.as_deref(), Some("Trunk is up to date"));
    assert!(
        app.state::<UpdateState>()
            .0
            .lock()
            .unwrap()
            .candidate
            .is_none()
    );
    assert!(tauri::async_runtime::block_on(download(app.handle().clone(), "2.0.0")).is_err());
}

#[test]
fn no_update_refresh_preserves_a_download_ready_to_install() {
    let app = prepared_app();

    let refreshed = tauri::async_runtime::block_on(check_with_discovery(
        app.handle().clone(),
        |_, _, _| async { Ok(None) },
    ))
    .unwrap();

    assert_eq!(refreshed.phase, Phase::Ready);
    assert_eq!(refreshed.version.as_deref(), Some("2.0.0"));
    assert_eq!(
        refreshed.message.as_deref(),
        Some("The downloaded update is ready to install")
    );
    let token = prepare(app.handle(), "2.0.0").unwrap();
    abort(app.handle(), &token).unwrap();
}

#[test]
fn preparation_waits_for_work_admitted_before_it() {
    let app = prepared_app();
    let activity = app.state::<crate::activity::ActivityState>();
    let work = activity.acquire().unwrap();

    let token = prepare(app.handle(), "2.0.0").unwrap();

    assert!(activity.acquire().is_err());
    drop(work);
    assert_eq!(drained(app.handle(), &token), Ok(()));
}

#[test]
fn preparation_checks_the_exact_downloaded_version() {
    let app = prepared_app();
    let activity = app.state::<crate::activity::ActivityState>();
    assert!(prepare(app.handle(), "3.0.0").is_err());
    let token = prepare(app.handle(), "2.0.0").unwrap();
    assert!(activity.acquire().is_err());
    assert!(!allow_exit(app.handle()));
    assert!(abort(app.handle(), "stale").is_err());
    abort(app.handle(), &token).unwrap();
    assert!(activity.acquire().is_ok());
}

#[test]
fn changed_download_is_rejected_before_any_install_and_reopens_work() {
    let app = prepared_app();
    let token = prepare(app.handle(), "2.0.0").unwrap();
    app.state::<UpdateState>().0.lock().unwrap().bytes = Some(Arc::new(b"tampered".to_vec()));
    assert!(install(app.handle(), "2.0.0", &token).is_err());
    assert_eq!(status(app.handle()).phase, Phase::Ready);
    assert!(
        app.state::<crate::activity::ActivityState>()
            .acquire()
            .is_ok()
    );
    assert!(
        app.state::<UpdateState>()
            .0
            .lock()
            .unwrap()
            .record
            .intent
            .is_none()
    );
}

#[test]
fn readiness_requires_same_lane_and_at_least_the_expected_stable_version() {
    let intent = persistence::Intent {
        from_version: "1.0.0".into(),
        to_version: "2.0.0".into(),
        target: "darwin-aarch64".into(),
        artifact_sha256: "fixture".into(),
    };
    assert!(install::readiness_matches(
        "2.0.0",
        Some("darwin-aarch64"),
        &intent
    ));
    assert!(install::readiness_matches(
        "2.1.0",
        Some("darwin-aarch64"),
        &intent
    ));
    for (version, target) in [
        ("1.0.0", Some("darwin-aarch64")),
        ("2.0.0", Some("darwin-x86_64")),
        ("2.0.0", None),
        ("2.1.0-beta", Some("darwin-aarch64")),
    ] {
        assert!(!install::readiness_matches(version, target, &intent));
    }
}

struct PersistenceFixture {
    app: tauri::App<tauri::test::MockRuntime>,
    directory: tempfile::TempDir,
}

impl PersistenceFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let isolated = directory.path().canonicalize().unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = isolated.to_str().unwrap().to_owned();
        let app = tauri::test::mock_builder()
            .manage(crate::activity::ActivityState::default())
            .manage(UpdateState::default())
            .build(context)
            .unwrap();
        assert_eq!(
            crate::commands::resolve_data_dir(app.handle()).unwrap(),
            isolated
        );
        assert_eq!(
            crate::commands::store_data_dir(app.handle()).unwrap(),
            isolated
        );

        Self { app, directory }
    }

    fn with_intent() -> Self {
        let fixture = Self::new();
        std::fs::write(fixture.path("trunk-prefs.json"), "{}").unwrap();
        drop(trunk_review::reviewdb::open(fixture.directory.path()).unwrap());
        let intent = persistence::Intent {
            from_version: "0.1.0".into(),
            to_version: fixture.app.package_info().version.to_string(),
            target: "darwin-aarch64".into(),
            artifact_sha256: trunk_update_release::sha256(b"test"),
        };
        persistence::save(
            fixture.directory.path(),
            &Record {
                adopted_for: None,
                intent: Some(intent),
            },
        )
        .unwrap();

        fixture
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.directory.path().join(name)
    }

    fn intent(&self) -> persistence::Intent {
        persistence::load(self.directory.path())
            .unwrap()
            .intent
            .unwrap()
    }

    fn ordinary_work_is_allowed(&self) -> bool {
        self.app
            .state::<crate::activity::ActivityState>()
            .acquire()
            .is_ok()
    }
}

#[test]
fn startup_preserves_intent_and_blocks_work_when_preferences_are_corrupt() {
    let fixture = PersistenceFixture::with_intent();
    let intent = fixture.intent();
    std::fs::write(fixture.path("trunk-prefs.json"), "{broken").unwrap();

    initialize(fixture.app.handle());

    assert_eq!(status(fixture.app.handle()).phase, Phase::Recovery);
    assert!(!fixture.ordinary_work_is_allowed());
    assert!(ready(fixture.app.handle()).is_err());
    assert_eq!(fixture.intent(), intent);
    assert_eq!(
        std::fs::read(fixture.path("trunk-prefs.json")).unwrap(),
        b"{broken"
    );
}

#[test]
fn startup_preserves_intent_and_blocks_work_when_reviews_are_corrupt() {
    let fixture = PersistenceFixture::with_intent();
    let intent = fixture.intent();
    std::fs::write(fixture.path("reviews.db"), "broken review data").unwrap();

    initialize(fixture.app.handle());

    assert_eq!(status(fixture.app.handle()).phase, Phase::Recovery);
    assert!(!fixture.ordinary_work_is_allowed());
    assert!(ready(fixture.app.handle()).is_err());
    assert_eq!(fixture.intent(), intent);
    assert_eq!(
        std::fs::read(fixture.path("reviews.db")).unwrap(),
        b"broken review data"
    );
    assert!(!fixture.path("reviews.db.corrupt").exists());
}

#[test]
fn readiness_preserves_intent_and_blocks_work_when_preferences_corrupt_after_startup() {
    let fixture = PersistenceFixture::with_intent();
    let intent = fixture.intent();
    initialize(fixture.app.handle());
    assert!(fixture.ordinary_work_is_allowed());
    std::fs::write(fixture.path("trunk-prefs.json"), "{broken").unwrap();

    let result = ready(fixture.app.handle());

    assert_eq!(
        result.err().as_deref(),
        Some("Saved preferences could not be verified")
    );
    assert_eq!(status(fixture.app.handle()).phase, Phase::Recovery);
    assert!(!fixture.ordinary_work_is_allowed());
    assert_eq!(fixture.intent(), intent);
    assert_eq!(
        std::fs::read(fixture.path("trunk-prefs.json")).unwrap(),
        b"{broken"
    );
}

#[test]
fn readiness_preserves_intent_and_blocks_work_when_reviews_corrupt_after_startup() {
    let fixture = PersistenceFixture::with_intent();
    let intent = fixture.intent();
    initialize(fixture.app.handle());
    assert!(fixture.ordinary_work_is_allowed());
    std::fs::write(fixture.path("reviews.db"), "broken review data").unwrap();

    let result = ready(fixture.app.handle());

    assert_eq!(
        result.err().as_deref(),
        Some("The saved review database could not be verified")
    );
    assert_eq!(status(fixture.app.handle()).phase, Phase::Recovery);
    assert!(!fixture.ordinary_work_is_allowed());
    assert_eq!(fixture.intent(), intent);
    assert_eq!(
        std::fs::read(fixture.path("reviews.db")).unwrap(),
        b"broken review data"
    );
    assert!(!fixture.path("reviews.db.corrupt").exists());
}

#[test]
fn malformed_updater_state_preserves_the_record_and_leaves_ordinary_work_usable() {
    let fixture = PersistenceFixture::new();
    std::fs::write(fixture.path("trunk-updater.json"), "{broken").unwrap();

    initialize(fixture.app.handle());

    assert_eq!(status(fixture.app.handle()).phase, Phase::Manual);
    assert!(fixture.ordinary_work_is_allowed());
    assert_eq!(ready(fixture.app.handle()).unwrap().phase, Phase::Manual);
    assert_eq!(
        std::fs::read(fixture.path("trunk-updater.json")).unwrap(),
        b"{broken"
    );
}

#[test]
fn release_checks_find_newer_versions_without_an_enabled_installation() {
    let fixture = PersistenceFixture::new();
    initialize(fixture.app.handle());

    let result = tauri::async_runtime::block_on(check_with_sources(
        fixture.app.handle().clone(),
        |_| async {
            Ok(br#"{"tag_name":"v999.0.0","draft":false,"prerelease":false,"body":null}"#.to_vec())
        },
        |_, _, _| async { Err("Unsigned discovery must not request an installer feed".into()) },
    ))
    .unwrap();

    assert_eq!(result.phase, Phase::Available);
    assert_eq!(result.version.as_deref(), Some("999.0.0"));
    assert!(!result.eligible);
    assert!(!result.adopted);
    assert!(
        tauri::async_runtime::block_on(download(fixture.app.handle().clone(), "999.0.0")).is_err()
    );
    assert!(prepare(fixture.app.handle(), "999.0.0").is_err());
}

#[test]
fn adopted_installations_keep_using_signed_discovery() {
    let app = prepared_app();

    let result = tauri::async_runtime::block_on(check_with_sources(
        app.handle().clone(),
        |_| async { Err("Adopted installations must not request unsigned discovery".into()) },
        |_, _, _| async { Ok(None) },
    ))
    .unwrap();

    assert_eq!(result.phase, Phase::Ready);
    assert_eq!(result.version.as_deref(), Some("2.0.0"));
}

#[test]
fn release_check_failure_preserves_a_previous_notice_and_allows_retry() {
    let fixture = PersistenceFixture::new();
    tauri::async_runtime::block_on(check_release_with_fetch(
        fixture.app.handle().clone(),
        |_| async { Ok(br#"{"tag_name":"v999.0.0","draft":false,"prerelease":false}"#.to_vec()) },
    ))
    .unwrap();

    let result = tauri::async_runtime::block_on(check_release_with_fetch(
        fixture.app.handle().clone(),
        |_| async { Err("offline".into()) },
    ));

    assert_eq!(result.err().as_deref(), Some("offline"));
    let snapshot = status(fixture.app.handle());
    assert_eq!(snapshot.phase, Phase::Available);
    assert_eq!(snapshot.version.as_deref(), Some("999.0.0"));
    assert_eq!(snapshot.message.as_deref(), Some("offline"));
    assert!(
        tauri::async_runtime::block_on(check_release_with_fetch(
            fixture.app.handle().clone(),
            |_| async {
                Ok(br#"{"tag_name":"v999.0.0","draft":false,"prerelease":false}"#.to_vec())
            },
        ))
        .is_ok()
    );
}

#[test]
fn current_release_clears_a_previous_notice() {
    let fixture = PersistenceFixture::new();
    tauri::async_runtime::block_on(check_release_with_fetch(
        fixture.app.handle().clone(),
        |_| async { Ok(br#"{"tag_name":"v999.0.0","draft":false,"prerelease":false}"#.to_vec()) },
    ))
    .unwrap();
    let current = status(fixture.app.handle()).current_version;

    let snapshot = tauri::async_runtime::block_on(check_release_with_fetch(
        fixture.app.handle().clone(),
        |_| async move {
            Ok(serde_json::to_vec(
                &json!({"tag_name":format!("v{current}"),"draft":false,"prerelease":false}),
            )
            .unwrap())
        },
    ))
    .unwrap();

    assert_eq!(snapshot.phase, Phase::Manual);
    assert!(snapshot.version.is_none());
    assert_eq!(snapshot.message.as_deref(), Some("Trunk is up to date"));
}

#[test]
fn release_checks_cannot_replace_recovery_state() {
    let fixture = PersistenceFixture::with_intent();
    initialize(fixture.app.handle());

    let result = tauri::async_runtime::block_on(check_release_with_fetch(
        fixture.app.handle().clone(),
        |_| async { panic!("recovery must not start a request") },
    ));

    assert!(result.is_err());
    assert_eq!(status(fixture.app.handle()).phase, Phase::Recovery);
}

#[tokio::test]
async fn release_checks_hold_request_ownership_until_completion() {
    let fixture = PersistenceFixture::new();
    let (started, observed) = tokio::sync::oneshot::channel();
    let (complete, response) = tokio::sync::oneshot::channel();
    let first = tokio::spawn(check_release_with_fetch(
        fixture.app.handle().clone(),
        |_| async {
            started.send(()).unwrap();
            response.await.unwrap()
        },
    ));
    observed.await.unwrap();

    let second = check_release_with_fetch(fixture.app.handle().clone(), |_| async {
        panic!("a second request must not start")
    })
    .await;

    assert!(second.is_err());
    assert_eq!(status(fixture.app.handle()).phase, Phase::Checking);
    complete
        .send(Ok(
            br#"{"tag_name":"v999.0.0","draft":false,"prerelease":false}"#.to_vec(),
        ))
        .unwrap();
    assert_eq!(first.await.unwrap().unwrap().phase, Phase::Available);
}

#[test]
fn adopting_an_installation_clears_the_unsigned_release_notice() {
    let fixture = PersistenceFixture::new();
    {
        let state = fixture.app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        coordinator.status.eligible = true;
        coordinator.installation = Some((
            "darwin-aarch64".into(),
            "/Applications/Trunk.app/Contents/MacOS/trunk".into(),
        ));
        coordinator.settle(None);
    }
    tauri::async_runtime::block_on(check_release_with_fetch(
        fixture.app.handle().clone(),
        |_| async { Ok(br#"{"tag_name":"v999.0.0","draft":false,"prerelease":false}"#.to_vec()) },
    ))
    .unwrap();

    let snapshot = enable(fixture.app.handle(), true).unwrap();

    assert!(snapshot.adopted);
    assert_eq!(snapshot.phase, Phase::Idle);
    assert!(snapshot.version.is_none());
    assert!(
        tauri::async_runtime::block_on(download(fixture.app.handle().clone(), "999.0.0")).is_err()
    );
}

#[test]
fn unsigned_discovery_cannot_replace_an_adopted_installations_candidate() {
    let app = prepared_app();

    let result =
        tauri::async_runtime::block_on(check_release_with_fetch(app.handle().clone(), |_| async {
            panic!("adopted installation must use signed discovery")
        }));

    assert!(result.is_err());
    assert_eq!(status(app.handle()).phase, Phase::Ready);
    assert_eq!(status(app.handle()).version.as_deref(), Some("2.0.0"));
}
