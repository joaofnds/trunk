//! Trunk's libgit2 plumbing: repository reads, blob reads, and the commit graph
//! pipeline with its DTOs. It depends on neither Tauri nor the review domain.

pub mod blob_reader;
pub mod editor;
pub mod error;
pub mod graph;
pub mod graph_input;
pub mod layout_dump;
pub mod placement;
pub mod repository;
pub mod status;
pub mod tracked_files;
pub mod types;
