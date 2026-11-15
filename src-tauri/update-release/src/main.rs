use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use trunk_update_release::{
    AcceptanceRecord, Artifact, MAX_ARTIFACT_BYTES, MAX_MANIFEST_BYTES, TargetRegistry, assemble,
};

type Failure = Box<dyn std::error::Error>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseInput {
    version: String,
    artifacts: Vec<Artifact>,
}

fn main() {
    if let Err(error) = run(&env::args().skip(1).collect::<Vec<_>>()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(args: &[String]) -> Result<(), Failure> {
    match args {
        [command, registry, root] if command == "validate-registry" => {
            let registry = load_registry(Path::new(registry), Path::new(root))?;
            println!("{} enabled updater targets", registry.targets.len());
        }
        [command, registry, root, input, directory, output] if command == "assemble" || command == "verify-hosted" => {
            let registry = load_registry(Path::new(registry), Path::new(root))?;
            let input: ReleaseInput = serde_json::from_slice(&read_bounded(Path::new(input), MAX_MANIFEST_BYTES as u64)?)?;
            let files = load_artifacts(&input.artifacts, Path::new(directory))?;
            let manifest = assemble(&registry, &input.version, &input.artifacts, &files)?;
            if command == "verify-hosted" {
                let expected: serde_json::Value = serde_json::from_slice(&read_bounded(Path::new(output), MAX_MANIFEST_BYTES as u64)?)?;
                if expected != manifest {
                    return Err("hosted manifest differs from verified manifest".into());
                }
            } else {
                fs::write(output, serde_json::to_vec_pretty(&manifest)?)?;
            }
        }
        _ => return Err("usage: trunk-update-release validate-registry REGISTRY REPO | (assemble|verify-hosted) REGISTRY REPO INPUT ARTIFACT_DIRECTORY MANIFEST".into()),
    }

    Ok(())
}

fn load_registry(path: &Path, root: &Path) -> Result<TargetRegistry, Failure> {
    let registry = TargetRegistry::parse(std::str::from_utf8(&read_bounded(
        path,
        MAX_MANIFEST_BYTES as u64,
    )?)?)?;
    let canonical_root = root.canonicalize()?;
    for (target, policy) in &registry.targets {
        let path = root.join(&policy.acceptance_record).canonicalize()?;
        if !path.starts_with(&canonical_root) {
            return Err("acceptance record escapes repository".into());
        }

        let acceptance: AcceptanceRecord =
            serde_json::from_slice(&read_bounded(&path, MAX_MANIFEST_BYTES as u64)?)?;
        acceptance.validate(target, policy)?;
    }

    Ok(registry)
}

fn load_artifacts(
    artifacts: &[Artifact],
    directory: &Path,
) -> Result<BTreeMap<String, Vec<u8>>, Failure> {
    let mut files = BTreeMap::new();
    for artifact in artifacts {
        if artifact.file.is_empty()
            || !artifact
                .file
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err("invalid artifact filename".into());
        }

        let bytes = read_bounded(&directory.join(&artifact.file), MAX_ARTIFACT_BYTES)?;
        if files.insert(artifact.file.clone(), bytes).is_some() {
            return Err("duplicate artifact file".into());
        }
    }

    Ok(files)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(format!("{} exceeds byte limit", path.display()).into());
    }

    Ok(bytes)
}
