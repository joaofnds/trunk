use std::fs;
use std::process::{Command, Output};

use serde_json::json;

struct ReleaseHarness {
    root: tempfile::TempDir,
}

impl ReleaseHarness {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/acceptance")).unwrap();
        fs::create_dir(root.path().join("artifacts")).unwrap();
        let bytes = include_bytes!("fixtures/package.tar.gz");
        fs::write(root.path().join("artifacts/fixture.app.tar.gz"), bytes).unwrap();
        let fixture = Self { root };
        fixture.write_json(
            "registry.json",
            &json!({"targets":{"darwin-aarch64":{
                "publicKey":include_str!("fixtures/public-key.txt").trim(),
                "minimumOsVersion":"13.0", "acceptanceRecord":"docs/acceptance/darwin.json"
            }}}),
        );
        fixture.write_json(
            "docs/acceptance/darwin.json",
            &json!({
                "target":"darwin-aarch64", "minimumOsVersion":"13.0", "oldestOsTested":"13.0",
                "status":"accepted", "platformSigning":"verified", "evidence":"fixture only"
            }),
        );
        fixture.write_json("input.json", &json!({"version":"2.0.0", "artifacts":[{
            "target":"darwin-aarch64", "version":"2.0.0", "minimumOsVersion":"13.0",
            "file":"fixture.app.tar.gz",
            "url":"https://github.com/joaofnds/trunk/releases/download/v2.0.0/fixture.app.tar.gz",
            "signature":include_str!("fixtures/package.tar.gz.sig").trim(),
            "sha256":trunk_update_release::sha256(bytes), "size":bytes.len()
        }]}));
        fixture
    }

    fn write_json(&self, name: &str, value: &serde_json::Value) {
        fs::write(self.root.path().join(name), value.to_string()).unwrap();
    }

    fn run(&self, command: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_trunk-update-release"))
            .current_dir(self.root.path())
            .args([
                command,
                "registry.json",
                ".",
                "input.json",
                "artifacts",
                "latest.json",
            ])
            .output()
            .unwrap()
    }
}

#[test]
fn assembled_manifest_verifies_against_downloaded_bytes() {
    let fixture = ReleaseHarness::new();

    let assembled = fixture.run("assemble");
    let hosted = fixture.run("verify-hosted");

    assert!(assembled.status.success(), "{assembled:?}");
    assert!(hosted.status.success(), "{hosted:?}");
}

#[test]
fn changed_hosted_bytes_fail_the_publication_gate() {
    let fixture = ReleaseHarness::new();
    assert!(fixture.run("assemble").status.success());
    fs::write(
        fixture.root.path().join("artifacts/fixture.app.tar.gz"),
        b"tampered",
    )
    .unwrap();

    let result = fixture.run("verify-hosted");

    assert!(!result.status.success());
}

#[test]
fn missing_acceptance_record_prevents_manifest_creation() {
    let fixture = ReleaseHarness::new();
    fs::remove_file(fixture.root.path().join("docs/acceptance/darwin.json")).unwrap();

    let result = fixture.run("assemble");

    assert!(!result.status.success());
    assert!(!fixture.root.path().join("latest.json").exists());
}
