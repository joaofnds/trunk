//! Trunk's libgit2 plumbing: repository reads, the commit graph pipeline, and the DTOs
//! the app sends to its frontend. It depends on neither Tauri nor the review domain.

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
pub mod workdir_snapshot;
