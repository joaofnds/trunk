use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Component, Path};

use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::PublicKey;
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::Error;

pub const TARGETS: [&str; 5] = [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64-nsis",
    "windows-x86_64-msi",
    "linux-x86_64-appimage",
];

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetRegistry {
    #[serde(deserialize_with = "unique_targets")]
    pub targets: BTreeMap<String, TargetPolicy>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetPolicy {
    pub public_key: String,
    pub minimum_os_version: String,
    pub acceptance_record: String,
}

impl TargetRegistry {
    /// Parses the locally trusted lane registry.
    ///
    /// # Errors
    /// Rejects malformed, duplicated, unsupported or incompletely configured lanes.
    pub fn parse(json: &str) -> Result<Self, Error> {
        let registry: Self = serde_json::from_str(json).map_err(|_| Error::Registry)?;
        let mut keys = BTreeSet::new();
        for (target, policy) in &registry.targets {
            let key_text = decode_text(&policy.public_key)?;
            PublicKey::decode(&key_text).map_err(|_| Error::Registry)?;
            let key_line = key_text.lines().nth(1).ok_or(Error::Registry)?;
            let key_bytes = STANDARD.decode(key_line).map_err(|_| Error::Registry)?;
            if !TARGETS.contains(&target.as_str())
                || policy.minimum_os_version.trim().is_empty()
                || !durable_path(&policy.acceptance_record)
                || !keys.insert(key_bytes.get(10..).ok_or(Error::Registry)?.to_vec())
            {
                return Err(Error::Registry);
            }
        }

        Ok(registry)
    }
}

fn unique_targets<'de, D>(deserializer: D) -> Result<BTreeMap<String, TargetPolicy>, D::Error>
where
    D: Deserializer<'de>,
{
    struct UniqueTargets;
    impl<'de> Visitor<'de> for UniqueTargets {
        type Value = BTreeMap<String, TargetPolicy>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a map of unique updater targets")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, TargetPolicy>()? {
                if result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate updater target"));
                }
            }

            Ok(result)
        }
    }

    deserializer.deserialize_map(UniqueTargets)
}

pub fn decode_text(encoded: &str) -> Result<String, Error> {
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|_| Error::Signature)?;
    String::from_utf8(bytes).map_err(|_| Error::Signature)
}

fn durable_path(path: &str) -> bool {
    path.starts_with("docs/")
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        && !path.contains('\\')
}
