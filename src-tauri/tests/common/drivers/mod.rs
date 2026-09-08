// Driver modules -- added by Wave 2 plans
// Each module implements TestContext methods wrapping _inner functions (per D-03),
// except review.rs, which owns a mock_app and State<T> because the emit it drives
// lives in write_and_notify, which wraps the #[tauri::command] fn rather than an
// _inner twin.

pub mod branches;
pub mod commit;
pub mod commit_actions;
pub mod diff;
pub mod history;
pub mod interactive_rebase;
pub mod merge_editor;
pub mod operation_state;
pub mod remote;
pub mod repo;
pub mod review;
pub mod staging;
pub mod stash;
