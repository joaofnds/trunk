use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct TrunkError {
    pub code: String,
    pub message: String,
}

impl TrunkError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        TrunkError {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<git2::Error> for TrunkError {
    fn from(e: git2::Error) -> Self {
        TrunkError {
            code: "git_error".into(),
            message: e.message().to_owned(),
        }
    }
}
