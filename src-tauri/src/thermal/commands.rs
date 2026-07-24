//! Tauri commands for the thermal inspection module (desktop builds).

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::database;
use crate::tauri_app::AppState;

use super::analysis::{self, AnomalyOptions, AnomalyResult};
use super::sdk::{self, MeasureOverrides};
use super::{ThermalAnalysis, ThermalAsset};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThermalSdkStatus {
    pub available: bool,
    pub sdk_dir: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn thermal_sdk_status() -> Result<ThermalSdkStatus, String> {
    let (available, sdk_dir, error) = sdk::sdk_status();
    Ok(ThermalSdkStatus {
        available,
        sdk_dir,
        error,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn sanitize_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("asset");
    base.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Shared import logic for both path-based and byte-based imports.
fn import_asset_impl(
    state: &State<'_, AppState>,
    file_name: &str,
    bytes: Vec<u8>,
) -> Result<ThermalAsset, String> {
    let db = state.db_authenticated()?;

    let asset_type = super::asset_type_for(file_name)
        .ok_or_else(|| format!("Unsupported file type: {file_name}"))?;

    let file_hash = sha256_hex(&bytes);
    if let Some(existing) = db
        .find_thermal_asset_by_hash(&file_hash)
        .map_err(|e| e.to_string())?
    {
        return Err(format!(
            "This file was already imported as \"{}\"",
            existing.file_name
        ));
    }

    // Probe radiometric data + resolution for images
    let mut is_radiometric = false;
    let mut width = 0i32;
    let mut height = 0i32;
    if asset_type == "image" {
        if let Ok(m) = sdk::measure(&bytes, MeasureOverrides::default()) {
            is_radiometric = true;
            width = m.width as i32;
            height = m.height as i32;
        } else {
            is_radiometric = sdk::is_radiometric(&bytes);
        }
    }

    let exif = if asset_type == "image" {
        super::extract_exif(&bytes)
    } else {
        super::ExifMeta::default()
    };

    // Store the file in the profile's thermal folder
    let profile = database::get_active_profile(&state.data_dir);
    let folder = super::thermal_folder(&state.data_dir, &profile);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Failed to create thermal folder: {e}"))?;

    let id = super::next_id();
    let safe_name = sanitize_file_name(file_name);
    let stored_path = folder.join(format!("{id}_{safe_name}"));
    std::fs::write(&stored_path, &bytes).map_err(|e| format!("Failed to store asset: {e}"))?;

    let asset = ThermalAsset {
        id,
        file_name: safe_name,
        stored_path: stored_path.to_string_lossy().to_string(),
        file_hash: Some(file_hash),
        asset_type: asset_type.to_string(),
        is_radiometric,
        width,
        height,
        gps_lat: exif.gps_lat,
        gps_lon: exif.gps_lon,
        captured_at: exif.captured_at,
        camera_model: exif.camera_model,
        imported_at: None,
        notes: None,
    };

    if let Err(e) = db.insert_thermal_asset(&asset) {
        // Don't strand the copied file if the row insert fails
        let _ = std::fs::remove_file(&stored_path);
        return Err(e.to_string());
    }
    db.get_thermal_asset(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thermal_import_asset(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<ThermalAsset, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {file_path}"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {e}"))?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("asset.jpg")
        .to_string();
    import_asset_impl(&state, &name, bytes)
}

#[tauri::command]
pub async fn thermal_import_asset_bytes(
    file_name: String,
    file_bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<ThermalAsset, String> {
    import_asset_impl(&state, &file_name, file_bytes)
}

#[tauri::command]
pub async fn thermal_list_assets(state: State<'_, AppState>) -> Result<Vec<ThermalAsset>, String> {
    let db = state.db_authenticated()?;
    db.list_thermal_assets().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thermal_delete_asset(asset_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db_authenticated()?;
    let asset = db.get_thermal_asset(asset_id).map_err(|e| e.to_string())?;
    // Remove the stored file (best-effort), then the DB rows
    let _ = std::fs::remove_file(&asset.stored_path);
    db.delete_thermal_asset(asset_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thermal_update_asset_notes(
    asset_id: i64,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db_authenticated()?;
    db.update_thermal_asset_notes(asset_id, notes.as_deref())
        .map_err(|e| e.to_string())
}

/// Return the raw bytes of a stored asset (for previews / annotation base images).
#[tauri::command]
pub async fn thermal_read_asset_file(
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let db = state.db_authenticated()?;
    let asset = db.get_thermal_asset(asset_id).map_err(|e| e.to_string())?;
    let bytes =
        std::fs::read(&asset.stored_path).map_err(|e| format!("Failed to read asset file: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

fn load_asset_bytes(db: &crate::database::Database, asset_id: i64) -> Result<(ThermalAsset, Vec<u8>), String> {
    let asset = db.get_thermal_asset(asset_id).map_err(|e| e.to_string())?;
    if asset.asset_type != "image" {
        return Err("Radiometric analysis is only available for images".to_string());
    }
    let bytes =
        std::fs::read(&asset.stored_path).map_err(|e| format!("Failed to read asset file: {e}"))?;
    Ok((asset, bytes))
}

/// Analyze a radiometric image: statistics, histogram, measurement params.
#[tauri::command]
pub async fn thermal_analyze(
    asset_id: i64,
    overrides: Option<MeasureOverrides>,
    state: State<'_, AppState>,
) -> Result<ThermalAnalysis, String> {
    let db = state.db_authenticated()?;
    let (_asset, bytes) = load_asset_bytes(&db, asset_id)?;
    let m = sdk::measure(&bytes, overrides.unwrap_or_default())?;
    let stats = analysis::compute_stats(&m.temps, m.width);
    Ok(ThermalAnalysis {
        asset_id,
        width: m.width as u32,
        height: m.height as u32,
        stats,
        params: m.params.into(),
    })
}

/// Return the full temperature matrix as binary data:
/// 8-byte header (u32 LE width, u32 LE height) followed by w*h f32 LE values (°C).
#[tauri::command]
pub async fn thermal_get_temp_matrix(
    asset_id: i64,
    overrides: Option<MeasureOverrides>,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let db = state.db_authenticated()?;
    let (_asset, bytes) = load_asset_bytes(&db, asset_id)?;
    let m = sdk::measure(&bytes, overrides.unwrap_or_default())?;

    let mut out = Vec::with_capacity(8 + m.temps.len() * 4);
    out.extend_from_slice(&(m.width as u32).to_le_bytes());
    out.extend_from_slice(&(m.height as u32).to_le_bytes());
    for t in &m.temps {
        out.extend_from_slice(&t.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(out))
}

/// Run anomaly detection ("AI analysis") on a radiometric image.
#[tauri::command]
pub async fn thermal_detect_anomalies(
    asset_id: i64,
    options: Option<AnomalyOptions>,
    overrides: Option<MeasureOverrides>,
    state: State<'_, AppState>,
) -> Result<AnomalyResult, String> {
    let db = state.db_authenticated()?;
    let (_asset, bytes) = load_asset_bytes(&db, asset_id)?;
    let m = sdk::measure(&bytes, overrides.unwrap_or_default())?;
    let opts = options.unwrap_or(AnomalyOptions {
        z_threshold: None,
        min_region_px: None,
        max_regions: None,
        range_low: None,
        range_high: None,
    });
    Ok(analysis::detect_anomalies(&m.temps, m.width, m.height, opts))
}

// ---------------- Thermal network (heat flow) ----------------

/// Solve a lumped-parameter thermal network (radiation exchange, conduction,
/// transient diffusion). Pure computation — no database access.
#[tauri::command]
pub async fn thermal_solve_network(
    network: super::network::ThermalNetwork,
    options: super::network::SolveOptions,
) -> Result<super::network::SolveResult, String> {
    // Solving is CPU-bound; keep it off the async runtime's core threads.
    tauri::async_runtime::spawn_blocking(move || super::network::solve(&network, &options))
        .await
        .map_err(|e| format!("Solver task failed: {e}"))?
}

#[tauri::command]
pub async fn thermal_get_network(
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let db = state.db_authenticated()?;
    db.get_thermal_network(asset_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thermal_set_network(
    asset_id: i64,
    network: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db_authenticated()?;
    db.set_thermal_network(asset_id, &network)
        .map_err(|e| e.to_string())
}

// ---------------- Annotations ----------------

#[tauri::command]
pub async fn thermal_get_annotations(
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let db = state.db_authenticated()?;
    db.get_thermal_annotations(asset_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thermal_set_annotations(
    asset_id: i64,
    annotations: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db_authenticated()?;
    db.set_thermal_annotations(asset_id, &annotations)
        .map_err(|e| e.to_string())
}

// ---------------- Reports ----------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThermalReportMeta {
    pub id: i64,
    pub name: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[tauri::command]
pub async fn thermal_list_reports(
    state: State<'_, AppState>,
) -> Result<Vec<ThermalReportMeta>, String> {
    let db = state.db_authenticated()?;
    let rows = db.list_thermal_reports().map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, name, created_at, updated_at)| ThermalReportMeta {
            id,
            name,
            created_at,
            updated_at,
        })
        .collect())
}

#[tauri::command]
pub async fn thermal_get_report(
    report_id: i64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state.db_authenticated()?;
    db.get_thermal_report(report_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thermal_save_report(
    report_id: Option<i64>,
    name: String,
    report_json: String,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let db = state.db_authenticated()?;
    db.save_thermal_report(report_id, &name, &report_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thermal_delete_report(report_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db_authenticated()?;
    db.delete_thermal_report(report_id).map_err(|e| e.to_string())
}
