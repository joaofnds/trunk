//! Process-private background-fetch adapter. Native Git behavior lives in trunk-git.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use trunk_git::error::TrunkError;
pub use trunk_git::fetch::{FetchOutcome, FetchRequest as WorkerRequest, execute_with_receipt};

#[derive(Debug, Deserialize, Serialize)]
pub struct WorkerResult {
    pub error: Option<WorkerError>,
    pub metadata_written: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WorkerError {
    pub code: String,
    pub message: String,
}

/// Handle the private worker entry point before Tauri or its runtime starts.
#[must_use]
pub fn run_if_worker() -> bool {
    if std::env::args().nth(1).as_deref() != Some("--background-fetch-worker") {
        return false;
    }
    let outcome = match configure_worker().and_then(|()| read_request()) {
        Ok(request) => execute_with_receipt(&request),
        Err(error) => FetchOutcome {
            result: Err(error),
            metadata_written: false,
        },
    };
    let response = WorkerResult {
        error: outcome.result.err().map(|error| WorkerError {
            code: error.code,
            message: error.message,
        }),
        metadata_written: outcome.metadata_written,
    };
    let mut stdout = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut stdout, &response);
    let _ = stdout.write_all(b"\n");
    true
}

fn configure_worker() -> Result<(), TrunkError> {
    // This entry point runs before Tauri or any thread. Libgit2 timeout options
    // and noninteractive environment policy are process-global state.
    unsafe {
        std::env::set_var("GIT_TERMINAL_PROMPT", "0");
        std::env::set_var("GCM_INTERACTIVE", "never");
        std::env::set_var("SSH_ASKPASS_REQUIRE", "never");
        git2::opts::set_server_connect_timeout_in_milliseconds(10_000)
            .map_err(worker_setup_error)?;
        git2::opts::set_server_timeout_in_milliseconds(15_000).map_err(worker_setup_error)?;
    }
    Ok(())
}

fn worker_setup_error(_: git2::Error) -> TrunkError {
    TrunkError::new("worker_setup", "could not configure native fetch timeouts")
}

fn read_request() -> Result<WorkerRequest, TrunkError> {
    let mut input = String::new();
    std::io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut input)
        .map_err(|_| TrunkError::new("worker_request", "could not read fetch request"))?;
    serde_json::from_str(&input)
        .map_err(|_| TrunkError::new("worker_request", "invalid fetch request"))
}
