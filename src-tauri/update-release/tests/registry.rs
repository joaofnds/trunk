use trunk_update_release::TargetRegistry;

#[test]
fn empty_registry_preserves_manual_updates() {
    let registry = TargetRegistry::parse(r#"{"targets":{}}"#).unwrap();

    assert!(registry.targets.is_empty());
}

fn policy() -> serde_json::Value {
    serde_json::json!({
        "publicKey": include_str!("fixtures/public-key.txt").trim(),
        "minimumOsVersion":"13.0",
        "acceptanceRecord":"docs/updater-acceptance/darwin-aarch64.json"
    })
}

#[test]
fn duplicate_target_names_are_rejected() {
    let json = format!(
        r#"{{"targets":{{"darwin-aarch64":{},"darwin-aarch64":{}}}}}"#,
        policy(),
        policy()
    );

    assert!(TargetRegistry::parse(&json).is_err());
}

#[test]
fn shared_lane_keys_are_rejected() {
    let json = serde_json::json!({"targets":{"darwin-aarch64":policy(),"darwin-x86_64":policy()}});

    assert!(TargetRegistry::parse(&json.to_string()).is_err());
}

#[test]
fn unknown_lanes_are_rejected() {
    let json = serde_json::json!({"targets":{"linux-x86_64-deb":policy()}});

    assert!(TargetRegistry::parse(&json.to_string()).is_err());
}

#[test]
fn unknown_policy_fields_are_rejected() {
    let mut entry = policy();
    entry["enabled"] = true.into();
    let json = serde_json::json!({"targets":{"darwin-aarch64":entry}});

    assert!(TargetRegistry::parse(&json.to_string()).is_err());
}

#[test]
fn ignored_acceptance_records_are_rejected() {
    let mut entry = policy();
    entry["acceptanceRecord"] = ".boris/acceptance.json".into();
    let json = serde_json::json!({"targets":{"darwin-aarch64":entry}});

    assert!(TargetRegistry::parse(&json.to_string()).is_err());
}

#[test]
fn untested_baseline_record_is_rejected() {
    let policy = serde_json::from_value(policy()).unwrap();
    let record: trunk_update_release::AcceptanceRecord =
        serde_json::from_value(serde_json::json!({
            "target":"darwin-aarch64", "minimumOsVersion":"13.0", "oldestOsTested":"15.0",
            "status":"accepted", "platformSigning":"verified", "evidence":"docs/acceptance-log.md"
        }))
        .unwrap();

    assert_eq!(
        record.validate("darwin-aarch64", &policy),
        Err(trunk_update_release::Error::Acceptance)
    );
}
