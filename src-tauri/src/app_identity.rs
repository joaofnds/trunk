//! The bundle identifiers Trunk runs under.

/// macOS files an app's preferences, caches and web data in folders named by its
/// identifier, and nothing removes them once the build is gone. A build under any
/// other identifier would start a set of them that outlives it.
const IDENTIFIERS: [&str; 3] = [
    "com.joaofnds.trunk",
    "com.joaofnds.trunk.dev",
    "com.joaofnds.trunk.drive",
];

pub fn refuse_unknown(identifier: &str) -> Result<(), String> {
    if IDENTIFIERS.contains(&identifier) {
        return Ok(());
    }

    Err(format!(
        "{identifier} is not one of Trunk's identifiers ({}), and macOS would keep the folders it creates under it. Build with one of those, or drive the app through `just drive-build`",
        IDENTIFIERS.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn declared_identifiers() -> Vec<(String, String)> {
        let src_tauri = Path::new(env!("CARGO_MANIFEST_DIR"));
        let overrides = std::fs::read_dir(src_tauri.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                let name = path.file_name().unwrap().to_string_lossy();
                name.starts_with("tauri.") && name.ends_with(".conf.json")
            });
        std::iter::once(src_tauri.join("tauri.conf.json"))
            .chain(overrides)
            .map(|path| {
                let config: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                let identifier = config["identifier"].as_str().unwrap().to_string();
                (path.display().to_string(), identifier)
            })
            .collect()
    }

    #[test]
    fn accepts_every_identifier_a_tracked_config_declares() {
        let declared = declared_identifiers();

        let refused: Vec<_> = declared
            .iter()
            .filter(|(_, identifier)| refuse_unknown(identifier).is_err())
            .collect();

        assert_eq!(declared.len(), 3, "got {declared:?}");
        assert!(refused.is_empty(), "refused {refused:?}");
    }

    #[test]
    fn refuses_an_identifier_no_config_declares() {
        assert!(refuse_unknown("com.joaofnds.trunk.observe").is_err());
    }
}
