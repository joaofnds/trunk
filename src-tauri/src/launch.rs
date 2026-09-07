//! What this process was started as.

/// A process is either a CLI invocation or a GUI launch.
///
/// Naming both arms keeps "start the GUI" from being the absence of a value:
/// a word outside the CLI set is a bundled app's own file argument or a bare
/// `trunk`, not a mistyped verb.
#[derive(Debug, PartialEq, Eq)]
pub enum Launch<'a> {
    /// argv addresses the CLI. Carries the whole command line.
    Cli(&'a [String]),
    /// argv is a launch of the app: a bare `trunk`, or the paths a bundled
    /// app is handed to open.
    Gui,
}

impl<'a> Launch<'a> {
    /// argv's second word routes to the CLI when it is one of these, and to
    /// the GUI otherwise.
    const CLI_WORDS: [&'static str; 6] = ["review", "help", "--help", "-h", "--version", "-V"];

    #[must_use]
    pub fn of(args: &'a [String]) -> Self {
        match args.get(1) {
            Some(word) if Self::CLI_WORDS.contains(&word.as_str()) => Self::Cli(args),
            _ => Self::Gui,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(std::string::ToString::to_string).collect()
    }

    #[test]
    fn a_bare_trunk_is_a_gui_launch() {
        assert_eq!(Launch::of(&argv(&["trunk"])), Launch::Gui);
    }

    #[test]
    fn a_file_path_argument_is_a_gui_launch() {
        assert_eq!(Launch::of(&argv(&["trunk", "some.file"])), Launch::Gui);
    }

    #[test]
    fn every_cli_word_is_a_cli_launch() {
        for word in Launch::CLI_WORDS {
            let args = argv(&["trunk", word]);
            assert_eq!(
                Launch::of(&args),
                Launch::Cli(&args),
                "{word} must route to the CLI"
            );
        }
    }
}
