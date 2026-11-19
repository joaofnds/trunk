use std::sync::OnceLock;

static SHELL_PATH: OnceLock<String> = OnceLock::new();

const PATH_BEGIN: &str = "__TRUNK_PATH_BEGIN__";
const PATH_END: &str = "__TRUNK_PATH_END__";

/// PATH that matches what the user gets in their terminal.
///
/// GUI apps launched from Finder/Dock inherit launchd's minimal environment
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so git subprocesses resolve a different
/// `git`/`gpg`/`ssh` than the user's shell does — on this machine the app would
/// pick Apple's `/usr/bin/git` while the terminal uses the Nix `git`. That
/// divergence makes "Pull" behave unlike `git pull`, the exact surprise we want
/// to avoid.
///
/// We recover the real PATH by sourcing the user's login + interactive shell
/// once — the same `.zprofile`/`.zshrc` (etc.) the terminal sources — and
/// reading back `$PATH`. `path_helper` is a fallback: it only knows
/// `/etc/paths(.d)`, orders system dirs first, and never sees a user's package
/// manager.
pub fn system_path() -> &'static str {
    SHELL_PATH.get_or_init(resolve)
}

/// Resolve [`system_path`] on a thread of its own, so the user's first commit,
/// merge or push does not wait for their shell's startup files.
pub fn resolve_in_background() {
    let resolving = std::thread::Builder::new()
        .name("shell-path".into())
        .spawn(system_path);
    // Without the thread the first git action resolves the PATH itself.
    drop(resolving);
}

fn resolve() -> String {
    if let Some(path) = from_login_shell() {
        return path;
    }
    #[cfg(target_os = "macos")]
    if let Some(path) = from_path_helper() {
        return path;
    }
    std::env::var("PATH").unwrap_or_default()
}

/// Ask the user's login + interactive shell for its `$PATH`.
///
/// `-l -i -c` sources the same startup files the terminal does (login + rc),
/// then runs the print command and exits — `-c` means it never enters a REPL,
/// so it can't hang on input. Markers bracket the value so any banner the rc
/// files write to stdout is discarded; stderr (job-control chatter under `-i`)
/// is dropped.
fn from_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let script = format!("printf '%s%s%s' '{PATH_BEGIN}' \"$PATH\" '{PATH_END}'");
    let output = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_marked_path(&String::from_utf8_lossy(&output.stdout))
}

/// Extract the PATH the shell printed between our markers. Returns `None` when a
/// marker is missing or the value is empty, so `resolve` falls through.
fn parse_marked_path(stdout: &str) -> Option<String> {
    let start = stdout.find(PATH_BEGIN)? + PATH_BEGIN.len();
    let end = start + stdout[start..].find(PATH_END)?;
    let path = &stdout[start..end];
    if path.is_empty() {
        None
    } else {
        Some(path.to_owned())
    }
}

#[cfg(target_os = "macos")]
fn from_path_helper() -> Option<String> {
    let output = std::process::Command::new("/usr/libexec/path_helper")
        .arg("-s")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_path_helper_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(any(target_os = "macos", test))]
fn parse_path_helper_output(stdout: &str) -> Option<String> {
    // Output format: PATH="<paths>"; export PATH;\n
    let start = stdout.find('"')? + 1;
    let end = start + stdout[start..].find('"')?;
    Some(stdout[start..end].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_path_between_markers() {
        let input = format!("{PATH_BEGIN}/opt/homebrew/bin:/usr/bin{PATH_END}");
        assert_eq!(
            parse_marked_path(&input).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn ignores_rc_banner_around_markers() {
        let input =
            format!("Welcome to your shell!\n{PATH_BEGIN}/run/current-system/sw/bin{PATH_END}\n");
        assert_eq!(
            parse_marked_path(&input).as_deref(),
            Some("/run/current-system/sw/bin")
        );
    }

    #[test]
    fn returns_none_when_end_marker_missing() {
        let input = format!("{PATH_BEGIN}/usr/bin");
        assert!(parse_marked_path(&input).is_none());
    }

    #[test]
    fn returns_none_when_begin_marker_missing() {
        let input = format!("/usr/bin{PATH_END}");
        assert!(parse_marked_path(&input).is_none());
    }

    #[test]
    fn returns_none_on_empty_path() {
        let input = format!("{PATH_BEGIN}{PATH_END}");
        assert!(parse_marked_path(&input).is_none());
    }

    #[test]
    fn parses_sh_format() {
        let input = r#"PATH="/usr/bin:/opt/homebrew/bin:/usr/sbin"; export PATH;"#;
        assert_eq!(
            parse_path_helper_output(input).as_deref(),
            Some("/usr/bin:/opt/homebrew/bin:/usr/sbin")
        );
    }

    #[test]
    fn parses_csh_format() {
        // path_helper -c outputs: setenv PATH "/usr/bin:/bin";
        let input = r#"setenv PATH "/usr/bin:/bin";"#;
        assert_eq!(
            parse_path_helper_output(input).as_deref(),
            Some("/usr/bin:/bin")
        );
    }

    #[test]
    fn returns_none_on_empty() {
        assert!(parse_path_helper_output("").is_none());
    }

    #[test]
    fn returns_none_on_no_quotes() {
        assert!(parse_path_helper_output("PATH=/usr/bin").is_none());
    }

    #[test]
    fn returns_none_on_single_quote() {
        assert!(parse_path_helper_output(r#"PATH="/usr/bin"#).is_none());
    }
}
