use std::collections::BTreeMap;
use trunk_update_release::{Artifact, Error, TargetRegistry, assemble};

const KEY: &str = include_str!("fixtures/public-key.txt");
const SIGNATURE: &str = include_str!("fixtures/package.tar.gz.sig");
const BYTES: &[u8] = include_bytes!("fixtures/package.tar.gz");

fn registry() -> TargetRegistry {
    TargetRegistry::parse(
        &serde_json::json!({"targets":{"darwin-aarch64":{
            "publicKey":KEY.trim(), "minimumOsVersion":"13.0",
            "acceptanceRecord":"docs/updater-acceptance/darwin-aarch64.json"
        }}})
        .to_string(),
    )
    .unwrap()
}

fn artifact() -> Artifact {
    Artifact {
        target: "darwin-aarch64".into(),
        version: "2.0.0".into(),
        minimum_os_version: "13.0".into(),
        url: "https://github.com/joaofnds/trunk/releases/download/v2.0.0/Trunk_aarch64.app.tar.gz"
            .into(),
        signature: SIGNATURE.trim().into(),
        sha256: trunk_update_release::sha256(BYTES),
        size: BYTES.len() as u64,
        file: "Trunk_aarch64.app.tar.gz".into(),
    }
}

fn release(
    artifacts: &[Artifact],
    bytes: &[u8],
    version: &str,
) -> Result<serde_json::Value, Error> {
    let files = BTreeMap::from([("Trunk_aarch64.app.tar.gz".to_string(), bytes.to_vec())]);
    assemble(&registry(), version, artifacts, &files)
}

#[test]
fn verified_release_emits_a_single_target_manifest() {
    let manifest = release(&[artifact()], BYTES, "2.0.0").unwrap();

    assert_eq!(manifest["version"], "2.0.0");
    assert_eq!(manifest["platforms"].as_object().unwrap().len(), 1);
    assert_eq!(
        manifest["platforms"]["darwin-aarch64"]["signature"],
        SIGNATURE.trim()
    );
}

#[test]
fn missing_target_refuses_publication() {
    assert_eq!(release(&[], BYTES, "2.0.0"), Err(Error::Completeness));
}

#[test]
fn missing_signature_refuses_publication() {
    let mut package = artifact();
    package.signature.clear();

    assert_eq!(release(&[package], BYTES, "2.0.0"), Err(Error::Signature));
}

#[test]
fn mixed_versions_refuse_publication() {
    assert_eq!(release(&[artifact()], BYTES, "3.0.0"), Err(Error::Version));
}

#[test]
fn relabeled_signed_version_refuses_publication() {
    let mut package = artifact();
    package.version = "3.0.0".into();
    package.url = package.url.replace("2.0.0", "3.0.0");

    assert_eq!(release(&[package], BYTES, "3.0.0"), Err(Error::Version));
}

#[test]
fn tampered_bytes_refuse_publication_even_with_updated_digest() {
    let mut bytes = BYTES.to_vec();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    let mut package = artifact();
    package.sha256 = trunk_update_release::sha256(&bytes);

    assert_eq!(release(&[package], &bytes, "2.0.0"), Err(Error::Signature));
}

#[test]
fn unsupported_baseline_refuses_publication() {
    let mut package = artifact();
    package.minimum_os_version = "14.0".into();

    assert_eq!(release(&[package], BYTES, "2.0.0"), Err(Error::Baseline));
}

#[test]
fn wrong_package_family_refuses_publication() {
    let mut package = artifact();
    package.file = "Trunk.exe".into();
    package.url = package.url.replace("Trunk_aarch64.app.tar.gz", "Trunk.exe");
    let files = BTreeMap::from([(package.file.clone(), BYTES.to_vec())]);

    assert_eq!(
        assemble(&registry(), "2.0.0", &[package], &files),
        Err(Error::Format)
    );
}

#[test]
fn wrong_lane_key_refuses_publication() {
    let other_key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE0OUVGNDc0NkZBNkU2RDcKUldUWDVxWnZkUFNlcERHV2cyYno4bjZBclFuQk13Z1FLMWdlVm9zb3JjYkx6Y3VuRCtLSitjWWU=";
    let mut lanes = registry();
    lanes.targets.get_mut("darwin-aarch64").unwrap().public_key = other_key.into();
    let lanes = TargetRegistry::parse(&serde_json::to_string(&lanes).unwrap()).unwrap();
    let files = BTreeMap::from([(artifact().file, BYTES.to_vec())]);

    assert_eq!(
        assemble(&lanes, "2.0.0", &[artifact()], &files),
        Err(Error::Signature)
    );
}

#[test]
fn mismatched_digest_refuses_publication() {
    let mut package = artifact();
    package.sha256 = "0".repeat(64);

    assert_eq!(release(&[package], BYTES, "2.0.0"), Err(Error::Integrity));
}

#[test]
fn mismatched_size_refuses_publication() {
    let mut package = artifact();
    package.size += 1;

    assert_eq!(release(&[package], BYTES, "2.0.0"), Err(Error::Integrity));
}

#[test]
fn mutable_asset_urls_refuse_publication() {
    let mut package = artifact();
    package.url =
        "https://github.com/joaofnds/trunk/releases/latest/download/Trunk.app.tar.gz".into();

    assert_eq!(release(&[package], BYTES, "2.0.0"), Err(Error::Url));
}

#[test]
fn oversized_packages_refuse_publication() {
    let mut package = artifact();
    package.size = trunk_update_release::MAX_ARTIFACT_BYTES + 1;

    assert_eq!(release(&[package], BYTES, "2.0.0"), Err(Error::Size));
}

#[test]
fn duplicate_lane_artifacts_refuse_publication() {
    assert_eq!(
        release(&[artifact(), artifact()], BYTES, "2.0.0"),
        Err(Error::Completeness)
    );
}
