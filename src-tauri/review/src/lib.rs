//! Trunk's code review domain: the review store, the review document, and resolving a
//! comment against the repository it was made on. It depends on neither Tauri nor the
//! app's syntax highlighting.

pub mod doc;
pub mod range;
pub mod resolution;
pub mod reviewdb;
pub mod types;
