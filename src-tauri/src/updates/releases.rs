use serde::Deserialize;

#[derive(Clone)]
pub(super) struct Release {
    pub(super) version: String,
    pub(super) notes: Option<String>,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
}

pub(super) fn newer(bytes: &[u8], current: &str) -> Result<Option<Release>, String> {
    let invalid = || "GitHub returned invalid release metadata".to_string();
    let release: GithubRelease = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let tag = release.tag_name.strip_prefix('v').ok_or_else(invalid)?;
    let version = semver::Version::parse(tag).map_err(|_| invalid())?;
    if version.to_string() != tag || !version.pre.is_empty() || !version.build.is_empty() {
        return Err(invalid());
    }

    if release.draft || release.prerelease {
        return Err(invalid());
    }

    let installed = semver::Version::parse(current)
        .map_err(|_| "The installed Trunk version is invalid".to_string())?;
    if version.cmp_precedence(&installed).is_le() {
        return Ok(None);
    }

    Ok(Some(Release {
        version: version.to_string(),
        notes: release.body.map(|body| body.chars().take(4096).collect()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn metadata(tag: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "tag_name": tag, "draft": false, "prerelease": false, "body": "Release notes"
        }))
        .unwrap()
    }

    #[test]
    fn compares_numeric_versions_instead_of_text() {
        let result = newer(&metadata("v0.10.0"), "0.9.0").unwrap().unwrap();
        assert_eq!(result.version, "0.10.0");
        assert_eq!(result.notes.as_deref(), Some("Release notes"));
    }

    #[test]
    fn ignores_the_installed_release() {
        assert!(newer(&metadata("v0.62.2"), "0.62.2").unwrap().is_none());
    }

    #[test]
    fn ignores_an_older_release() {
        assert!(newer(&metadata("v0.62.1"), "0.62.2").unwrap().is_none());
    }

    #[test]
    fn ignores_build_metadata_when_comparing_precedence() {
        assert!(
            newer(&metadata("v0.62.2"), "0.62.2+local")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_a_prerelease_tag_even_when_marked_stable() {
        assert!(newer(&metadata("v0.63.0-beta.1"), "0.62.2").is_err());
    }

    #[test]
    fn rejects_a_tag_without_the_release_prefix() {
        assert!(newer(&metadata("0.63.0"), "0.62.2").is_err());
    }

    #[test]
    fn rejects_version_build_metadata_in_release_tags() {
        assert!(newer(&metadata("v0.63.0+build"), "0.62.2").is_err());
    }

    #[test]
    fn rejects_malformed_metadata() {
        assert!(newer(b"{broken", "0.62.2").is_err());
    }

    #[test]
    fn rejects_missing_release_visibility_fields() {
        assert!(newer(br#"{"tag_name":"v0.63.0"}"#, "0.62.2").is_err());
    }

    #[test]
    fn rejects_a_draft() {
        let bytes = br#"{"tag_name":"v0.63.0","draft":true,"prerelease":false}"#;
        assert!(newer(bytes, "0.62.2").is_err());
    }

    #[test]
    fn rejects_a_release_marked_as_prerelease() {
        let bytes = br#"{"tag_name":"v0.63.0","draft":false,"prerelease":true}"#;
        assert!(newer(bytes, "0.62.2").is_err());
    }
}
