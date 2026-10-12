//! Tauri commands for the add-ons screen.

use tauri::State;

use crate::tauri_app::AppState;

use super::{addons_dir, list_installed, set_disabled, uninstall, AddonInfo};

#[tauri::command]
pub async fn addons_list(state: State<'_, AppState>) -> Result<Vec<AddonInfo>, String> {
    Ok(list_installed(&state.data_dir))
}

#[tauri::command]
pub async fn addons_set_enabled(
    id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    set_disabled(&state.data_dir, &id, !enabled)
}

/// The add-ons folder (created on demand so it can be opened in the file manager).
#[tauri::command]
pub async fn addons_dir_path(state: State<'_, AppState>) -> Result<String, String> {
    let dir = addons_dir(&state.data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create add-ons folder: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn addons_uninstall(id: String, state: State<'_, AppState>) -> Result<(), String> {
    uninstall(&state.data_dir, &id)
}
