//! Validation shared by updater release tooling and the installed client.
mod registry;

use std::collections::BTreeMap;
use std::fmt::{self, Write};

use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use registry::{TARGETS, TargetPolicy, TargetRegistry};

pub const MAX_ARTIFACT_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Registry,
    Completeness,
    Version,
    Signature,
    Baseline,
    Format,
    Integrity,
    Url,
    Acceptance,
    Size,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "updater release rejected: {self:?}")
    }
}
impl std::error::Error for Error {}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub target: String,
    pub version: String,
    pub minimum_os_version: String,
    pub file: String,
    pub url: String,
    pub signature: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptanceRecord {
    pub target: String,
    pub minimum_os_version: String,
    pub oldest_os_tested: String,
    pub status: String,
    pub platform_signing: String,
    pub evidence: String,
}

impl AcceptanceRecord {
    /// Checks that durable packaged acceptance covers the lane's fixed baseline.
    ///
    /// # Errors
    /// Rejects unaccepted, unsigned, baseline-mismatched or undocumented records.
    pub fn validate(&self, target: &str, policy: &TargetPolicy) -> Result<(), Error> {
        if self.target != target
            || self.minimum_os_version != policy.minimum_os_version
            || self.oldest_os_tested != policy.minimum_os_version
            || self.status != "accepted"
            || self.platform_signing != "verified"
            || self.evidence.trim().is_empty()
        {
            return Err(Error::Acceptance);
        }

        Ok(())
    }
}

#[must_use]
pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

/// Assembles the complete stable feed from verified, once-built artifact bytes.
///
/// # Errors
/// Rejects any incomplete, unverifiable, oversized or inconsistent release.
pub fn assemble(
    registry: &TargetRegistry,
    version: &str,
    artifacts: &[Artifact],
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<serde_json::Value, Error> {
    let parsed = semver::Version::parse(version).map_err(|_| Error::Version)?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() || parsed.to_string() != version {
        return Err(Error::Version);
    }

    let mut platforms = BTreeMap::new();
    for artifact in artifacts {
        let policy = registry
            .targets
            .get(&artifact.target)
            .ok_or(Error::Completeness)?;
        if platforms.contains_key(&artifact.target) {
            return Err(Error::Completeness);
        }

        let bytes = files.get(&artifact.file).ok_or(Error::Completeness)?;
        verify_artifact(policy, version, artifact, bytes)?;
        platforms.insert(
            artifact.target.clone(),
            serde_json::json!({
                "url": artifact.url, "signature": artifact.signature,
                "sha256": artifact.sha256, "size": artifact.size,
                "minimumOsVersion": artifact.minimum_os_version,
            }),
        );
    }
    if platforms.len() != registry.targets.len() {
        return Err(Error::Completeness);
    }

    let manifest = serde_json::json!({"version":version, "platforms":platforms});
    if manifest.to_string().len() > MAX_MANIFEST_BYTES {
        return Err(Error::Size);
    }

    Ok(manifest)
}

fn verify_artifact(
    policy: &TargetPolicy,
    version: &str,
    artifact: &Artifact,
    bytes: &[u8],
) -> Result<(), Error> {
    if artifact.version != version {
        return Err(Error::Version);
    }
    if artifact.minimum_os_version != policy.minimum_os_version {
        return Err(Error::Baseline);
    }
    if artifact.size == 0 || artifact.size > MAX_ARTIFACT_BYTES {
        return Err(Error::Size);
    }
    if artifact.size != bytes.len() as u64 || artifact.sha256 != sha256(bytes) {
        return Err(Error::Integrity);
    }

    let expected_url = format!(
        "https://github.com/joaofnds/trunk/releases/download/v{version}/{}",
        artifact.file
    );
    if artifact.url != expected_url
        || !artifact
            .file
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(Error::Url);
    }
    if !matches_format(&artifact.target, &artifact.file, bytes) {
        return Err(Error::Format);
    }

    let key = PublicKey::decode(&registry::decode_text(&policy.public_key)?)
        .map_err(|_| Error::Signature)?;
    let signature = Signature::decode(&registry::decode_text(&artifact.signature)?)
        .map_err(|_| Error::Signature)?;
    key.verify(bytes, &signature, false)
        .map_err(|_| Error::Signature)?;
    let versions: Vec<_> = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|part| part.strip_prefix("version:"))
        .collect();
    if versions != [version] {
        return Err(Error::Version);
    }

    Ok(())
}

fn matches_format(target: &str, filename: &str, bytes: &[u8]) -> bool {
    match target {
        "darwin-aarch64" | "darwin-x86_64" => {
            filename.ends_with(".app.tar.gz") && bytes.starts_with(&[0x1f, 0x8b])
        }
        "windows-x86_64-nsis" => {
            std::path::Path::new(filename)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
                && bytes.starts_with(b"MZ")
        }
        "windows-x86_64-msi" => {
            std::path::Path::new(filename)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("msi"))
                && bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
        }
        "linux-x86_64-appimage" => {
            filename.ends_with(".AppImage")
                && bytes.starts_with(b"\x7fELF")
                && bytes.get(8..11) == Some(b"AI\x02")
        }
        _ => false,
    }
}
