use std::fs::File;
use std::io::Read;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;

const FILE_NAME: &str = "trunk-updater.json";
const MAX_RECORD_BYTES: u64 = 8 * 1024;

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub adopted_for: Option<String>,
    pub intent: Option<Intent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    pub from_version: String,
    pub to_version: String,
    pub target: String,
    pub artifact_sha256: String,
}

pub(super) fn load(dir: &Path) -> Result<Record, String> {
    let file = match File::open(dir.join(FILE_NAME)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Record::default()),
        Err(_) => return Err("Update state could not be read".into()),
    };
    let metadata = file
        .metadata()
        .map_err(|_| "Update state could not be inspected")?;
    if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES {
        return Err("Update state exceeds its supported size or is not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Update state could not be read")?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Update state exceeds its supported size".into());
    }

    serde_json::from_slice(&bytes)
        .map_err(|_| "Update state is malformed; preserve it for recovery".into())
}

pub(super) fn save(dir: &Path, record: &Record) -> Result<(), String> {
    load(dir)?;
    let json = serde_json::to_string(record).map_err(|_| "Update state could not be encoded")?;
    if json.len() as u64 > MAX_RECORD_BYTES {
        return Err("Update state exceeds its supported size".into());
    }
    crate::storage::atomic_write_json(&dir.join(FILE_NAME), &json)
        .map_err(|_| "Update state could not be saved")?;
    #[cfg(unix)]
    File::open(dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "Update state directory could not be synchronized")?;

    Ok(())
}

pub(super) fn installation() -> Option<(String, String)> {
    if cfg!(any(debug_assertions, feature = "drive")) {
        return None;
    }
    let executable = std::env::current_exe().ok()?.canonicalize().ok()?;
    if !executable.is_file() || blocked_path(&executable) {
        return None;
    }
    let bundle = tauri::utils::platform::bundle_type()?;
    let (target, installed) = match (std::env::consts::OS, std::env::consts::ARCH, bundle) {
        ("macos", arch @ ("aarch64" | "x86_64"), BundleType::App)
            if mac_bundle_executable(&executable) =>
        {
            (format!("darwin-{arch}"), executable)
        }
        ("windows", "x86_64", kind @ (BundleType::Msi | BundleType::Nsis)) => {
            if !windows_local_executable(&executable) {
                return None;
            }
            (format!("windows-x86_64-{kind}"), executable)
        }
        ("linux", "x86_64", BundleType::AppImage) => {
            let image = std::path::PathBuf::from(std::env::var_os("APPIMAGE")?)
                .canonicalize()
                .ok()?;
            if !image.is_file() || blocked_path(&image) {
                return None;
            }
            ("linux-x86_64-appimage".into(), image)
        }
        _ => return None,
    };

    Some((target, installed.to_str()?.to_owned()))
}

fn blocked_path(path: &Path) -> bool {
    path.components().any(|part| {
        let Component::Normal(part) = part else {
            return false;
        };
        matches!(
            part.to_string_lossy().to_ascii_lowercase().as_str(),
            "volumes" | "apptranslocation" | "caskroom" | "cellar" | "nix" | "snap" | "flatpak"
        )
    })
}

fn mac_bundle_executable(path: &Path) -> bool {
    let Some(macos) = path.parent() else {
        return false;
    };
    let Some(contents) = macos.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };

    path.is_absolute()
        && macos.file_name().is_some_and(|name| name == "MacOS")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && bundle
            .extension()
            .is_some_and(|extension| extension == "app")
        && !blocked_path(path)
}

#[cfg(windows)]
fn windows_local_executable(path: &Path) -> bool {
    let local = matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)));

    local
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

#[cfg(not(windows))]
const fn windows_local_executable(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared() -> Record {
        Record {
            adopted_for: Some("/Applications/Trunk.app/Contents/MacOS/trunk".into()),
            intent: Some(Intent {
                from_version: "1.0.0".into(),
                to_version: "1.1.0".into(),
                target: "darwin-aarch64".into(),
                artifact_sha256: "0123456789abcdef".repeat(4),
            }),
        }
    }

    #[test]
    fn missing_state_starts_without_adoption_or_intent() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(load(dir.path()).unwrap(), Record::default());
    }

    #[test]
    fn intent_survives_reloading_the_saved_record() {
        let dir = tempfile::tempdir().unwrap();
        let record = prepared();

        save(dir.path(), &record).unwrap();

        assert_eq!(load(dir.path()).unwrap(), record);
    }

    #[test]
    fn corrupt_state_is_preserved_and_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, b"{partial").unwrap();

        assert!(load(dir.path()).is_err());
        assert!(save(dir.path(), &Record::default()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"{partial");
    }

    #[test]
    fn a_record_at_the_size_boundary_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        let record = prepared();
        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.resize(usize::try_from(MAX_RECORD_BYTES).unwrap(), b' ');
        std::fs::write(dir.path().join(FILE_NAME), bytes).unwrap();

        assert_eq!(load(dir.path()).unwrap(), record);
    }

    #[test]
    fn oversized_state_is_preserved_and_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let oversized = vec![b' '; usize::try_from(MAX_RECORD_BYTES).unwrap() + 1];
        std::fs::write(&path, &oversized).unwrap();

        assert!(load(dir.path()).is_err());
        assert!(save(dir.path(), &Record::default()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), oversized);
    }

    #[test]
    fn a_failed_replacement_preserves_the_recorded_intent() {
        let dir = tempfile::tempdir().unwrap();
        let record = prepared();
        save(dir.path(), &record).unwrap();
        std::fs::create_dir(dir.path().join("trunk-updater.json.tmp")).unwrap();

        assert!(save(dir.path(), &Record::default()).is_err());
        assert_eq!(load(dir.path()).unwrap(), record);
    }

    #[test]
    fn an_oversized_new_record_preserves_the_recorded_intent() {
        let dir = tempfile::tempdir().unwrap();
        let record = prepared();
        save(dir.path(), &record).unwrap();
        let oversized = Record {
            adopted_for: Some("a".repeat(8192)),
            intent: None,
        };

        assert!(save(dir.path(), &oversized).is_err());
        assert_eq!(load(dir.path()).unwrap(), record);
    }

    #[test]
    fn a_direct_mac_bundle_has_the_required_executable_layout() {
        assert!(mac_bundle_executable(Path::new(
            "/Applications/Trunk.app/Contents/MacOS/trunk"
        )));
    }

    #[test]
    fn an_unbundled_executable_is_ineligible() {
        assert!(!mac_bundle_executable(Path::new("/usr/local/bin/trunk")));
    }

    #[test]
    fn a_mounted_installer_is_ineligible() {
        assert!(!mac_bundle_executable(Path::new(
            "/Volumes/Trunk/Trunk.app/Contents/MacOS/trunk"
        )));
    }

    #[test]
    fn a_translocated_bundle_is_ineligible() {
        assert!(!mac_bundle_executable(Path::new(
            "/private/var/folders/x/AppTranslocation/id/Trunk.app/Contents/MacOS/trunk"
        )));
    }

    #[test]
    fn a_homebrew_bundle_is_ineligible() {
        assert!(!mac_bundle_executable(Path::new(
            "/opt/homebrew/Caskroom/trunk/1.0/Trunk.app/Contents/MacOS/trunk"
        )));
    }

    #[test]
    fn a_managed_linux_executable_is_ineligible() {
        assert!(blocked_path(Path::new("/nix/store/package/bin/trunk")));
    }

    #[test]
    fn a_development_executable_is_ineligible() {
        assert_eq!(installation(), None);
    }
}
