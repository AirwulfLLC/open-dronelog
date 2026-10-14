pub mod addons;
pub mod airdata_parser;
pub mod api;
pub mod battery_pairs;
pub mod database;
pub mod dronelogbook_parser;
pub mod litchi_parser;
pub mod models;
pub mod parser;
pub mod plugins;
pub mod profile_auth;
pub mod thermal;

#[cfg(feature = "web")]
pub mod server;

#[cfg(feature = "web")]
pub mod session_store;

#[cfg(feature = "tauri-app")]
mod tauri_app;

/// The desktop app state, exposed for the integration tests that drive the
/// Tauri commands directly (see `tests/flir_adas_smoke.rs`).
#[cfg(feature = "tauri-app")]
pub use tauri_app::AppState;

#[cfg(feature = "tauri-app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	// Reuse the existing Tauri bootstrap so desktop and mobile share one startup path.
	tauri_app::run();
}

pub use database::Database;
pub use models::*;
pub use parser::LogParser;
pub use airdata_parser::AirdataParser;
pub use litchi_parser::LitchiParser;
pub use dronelogbook_parser::DroneLogbookParser;
