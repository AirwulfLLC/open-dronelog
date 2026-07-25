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

pub(crate) fn sanitize_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("asset");
    base.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Shared import logic for both path-based and byte-based imports.
/// Accepts drone thermal/visual media (jpg/png/mp4…) and Agisoft Metashape
/// exports (GeoTIFF orthomosaics/DEMs, processing PDFs, camera XML/CSV,
/// point clouds, KML/KMZ overlays).
fn import_asset_impl(
    state: &State<'_, AppState>,
    file_name: &str,
    bytes: Vec<u8>,
) -> Result<ThermalAsset, String> {
    let db = state.db_authenticated()?;

    // Classify: thermal media first, then Metashape artifacts
    let (asset_type, source, metashape_kind) = match super::asset_type_for(file_name) {
        Some(t) => (t, "thermal", None),
        None => match super::metashape::detect_kind(file_name) {
            Some((kind, viewer_type)) => (viewer_type, "metashape", Some(kind)),
            None => {
                return Err(format!(
                    "Unsupported file type: {file_name} (supported: jpg/png/mp4/mov/avi, and \
                     Metashape exports: tif/tiff, pdf, xml, csv, las/laz/ply/obj, kml/kmz)"
                ))
            }
        },
    };

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

    // Probe radiometric data + resolution for thermal images
    let mut is_radiometric = false;
    let mut width = 0i32;
    let mut height = 0i32;
    if source == "thermal" && asset_type == "image" {
        if let Ok(m) = sdk::measure(&bytes, MeasureOverrides::default()) {
            is_radiometric = true;
            width = m.width as i32;
            height = m.height as i32;
        } else {
            is_radiometric = sdk::is_radiometric(&bytes);
        }
    }

    let exif = if source == "thermal" && asset_type == "image" {
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

    // Metashape metadata + orthomosaic preview
    let mut meta_json: Option<String> = None;
    let mut extra_files: Vec<std::path::PathBuf> = Vec::new();
    if let Some(kind) = metashape_kind {
        let mut meta = super::metashape::parse_metadata(kind, &bytes);
        if kind == "orthomosaic" {
            // Multispectral GeoTIFFs (≥4 bands beyond RGBA photos) get a
            // band-composite preview and expose their planes for index math.
            // A 4-band file that declares alpha (ExtraSamples) is a photo.
            let band_count = super::multispectral::probe_band_count(&bytes).unwrap_or(0);
            let has_alpha = band_count == 4 && super::multispectral::probe_has_alpha(&bytes);
            let mut handled_as_multispectral = false;
            if band_count >= 4 && !has_alpha {
                match super::multispectral::read_bands(&bytes) {
                    Ok(stack) if !(stack.bands.len() == 4 && stack.bits_per_sample == 8) => {
                        meta["kind"] = serde_json::json!("multispectral");
                        meta["bands"] = serde_json::json!(stack.bands.len());
                        meta["bitsPerSample"] = serde_json::json!(stack.bits_per_sample);
                        meta["width"] = serde_json::json!(stack.width);
                        meta["height"] = serde_json::json!(stack.height);
                        width = stack.width as i32;
                        height = stack.height as i32;
                        match super::multispectral::generate_composite_preview(
                            &stack,
                            &folder,
                            &format!("{id}"),
                        ) {
                            Ok(preview_name) => {
                                meta["previewFile"] = serde_json::json!(preview_name);
                                extra_files.push(folder.join(&preview_name));
                            }
                            Err(e) => {
                                meta["previewError"] = serde_json::json!(e);
                            }
                        }
                        handled_as_multispectral = true;
                    }
                    Ok(_) => {} // plain RGBA8 — fall through below
                    Err(e) => {
                        // Surface the reason (e.g. planar layout); the plain
                        // preview attempt below may still succeed and clear it.
                        meta["previewError"] = serde_json::json!(e);
                    }
                }
            }
            if !handled_as_multispectral {
                match super::metashape::generate_tiff_preview(&bytes, &folder, &format!("{id}")) {
                    Ok((w, h, preview_name)) => {
                        width = w as i32;
                        height = h as i32;
                        meta["previewFile"] = serde_json::json!(preview_name);
                        meta["width"] = serde_json::json!(w);
                        meta["height"] = serde_json::json!(h);
                        extra_files.push(folder.join(&preview_name));
                        // A band-read failure recorded above no longer matters
                        meta.as_object_mut().map(|o| o.remove("previewError"));
                    }
                    Err(e) => {
                        // Keep the original; it just won't render in the viewer.
                        // Prefer the band-read error when both paths failed —
                        // it is usually the more actionable one.
                        if meta.get("previewError").is_none() {
                            meta["previewError"] = serde_json::json!(e);
                        }
                    }
                }
            }
        }
        meta_json = Some(meta.to_string());
    }

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
        source: source.to_string(),
        meta_json,
    };

    if let Err(e) = db.insert_thermal_asset(&asset) {
        // Don't strand copied files if the row insert fails
        let _ = std::fs::remove_file(&stored_path);
        for f in &extra_files {
            let _ = std::fs::remove_file(f);
        }
        return Err(e.to_string());
    }
    db.get_thermal_asset(id).map_err(|e| e.to_string())
}

/// Path of an asset's preview file, when its metadata declares one.
pub(crate) fn preview_path_for(asset: &ThermalAsset) -> Option<std::path::PathBuf> {
    meta_sibling_path(asset, "previewFile")
}

/// Path of an asset's raw f32 raster sidecar (vegetation indices).
pub(crate) fn raster_path_for(asset: &ThermalAsset) -> Option<std::path::PathBuf> {
    meta_sibling_path(asset, "rasterFile")
}

fn meta_sibling_path(asset: &ThermalAsset, key: &str) -> Option<std::path::PathBuf> {
    let meta: serde_json::Value = serde_json::from_str(asset.meta_json.as_deref()?).ok()?;
    let file = meta[key].as_str()?;
    let dir = std::path::Path::new(&asset.stored_path).parent()?;
    Some(dir.join(file))
}

/// Per-pixel value matrix for an asset: vegetation-index assets read their
/// f32 raster sidecar; radiometric images are measured through the SDK.
fn load_measurement(
    db: &crate::database::Database,
    asset_id: i64,
    overrides: MeasureOverrides,
) -> Result<(usize, usize, Vec<f32>, sdk::DirpMeasurementParams), String> {
    let asset = db.get_thermal_asset(asset_id).map_err(|e| e.to_string())?;
    if let Some(raster_path) = raster_path_for(&asset) {
        let meta: serde_json::Value =
            serde_json::from_str(asset.meta_json.as_deref().unwrap_or("{}"))
                .map_err(|e| format!("Invalid asset metadata: {e}"))?;
        let (w, h) = (
            meta["width"].as_u64().unwrap_or(0) as usize,
            meta["height"].as_u64().unwrap_or(0) as usize,
        );
        let bytes = std::fs::read(&raster_path)
            .map_err(|e| format!("Failed to read index raster: {e}"))?;
        if w == 0 || h == 0 || bytes.len() != w * h * 4 {
            return Err("Index raster is corrupt (size mismatch)".to_string());
        }
        let values: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        return Ok((w, h, values, sdk::DirpMeasurementParams::default()));
    }
    if asset.asset_type != "image" {
        return Err("Radiometric analysis is only available for images".to_string());
    }
    let bytes =
        std::fs::read(&asset.stored_path).map_err(|e| format!("Failed to read asset file: {e}"))?;
    let m = sdk::measure(&bytes, overrides)?;
    Ok((m.width, m.height, m.temps, m.params))
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

/// Raw-body import: the file content travels as the binary IPC body instead
/// of a JSON number array, which matters for large files (GeoTIFF
/// orthomosaics are routinely hundreds of MB). The file name arrives
/// base64-encoded in the `file-name-b64` header (UTF-8 safe).
#[tauri::command]
pub async fn thermal_import_asset_raw(
    request: tauri::ipc::Request<'_>,
    state: State<'_, AppState>,
) -> Result<ThermalAsset, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw binary body".to_string());
    };
    use base64::Engine as _;
    let file_name = request
        .headers()
        .get("file-name-b64")
        .and_then(|v| v.to_str().ok())
        .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
        .and_then(|raw| String::from_utf8(raw).ok())
        .ok_or_else(|| "Missing or invalid file-name-b64 header".to_string())?;
    import_asset_impl(&state, &file_name, bytes.clone())
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
    // Remove the stored file and any sidecars (best-effort), then the DB rows
    let _ = std::fs::remove_file(&asset.stored_path);
    if let Some(preview) = preview_path_for(&asset) {
        let _ = std::fs::remove_file(preview);
    }
    if let Some(raster) = raster_path_for(&asset) {
        let _ = std::fs::remove_file(raster);
    }
    db.delete_thermal_asset(asset_id).map_err(|e| e.to_string())
}

/// Return displayable bytes for an asset: the PNG preview when one exists
/// (GeoTIFF orthomosaics), otherwise the original file.
#[tauri::command]
pub async fn thermal_read_asset_preview(
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let db = state.db_authenticated()?;
    let asset = db.get_thermal_asset(asset_id).map_err(|e| e.to_string())?;
    if let Some(preview) = preview_path_for(&asset) {
        if preview.exists() {
            let bytes = std::fs::read(&preview)
                .map_err(|e| format!("Failed to read preview file: {e}"))?;
            return Ok(tauri::ipc::Response::new(bytes));
        }
    }
    let bytes =
        std::fs::read(&asset.stored_path).map_err(|e| format!("Failed to read asset file: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
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

/// Analyze a radiometric image or index raster: statistics + histogram.
#[tauri::command]
pub async fn thermal_analyze(
    asset_id: i64,
    overrides: Option<MeasureOverrides>,
    state: State<'_, AppState>,
) -> Result<ThermalAnalysis, String> {
    let db = state.db_authenticated()?;
    let (w, h, values, params) = load_measurement(&db, asset_id, overrides.unwrap_or_default())?;
    let stats = analysis::compute_stats(&values, w);
    Ok(ThermalAnalysis {
        asset_id,
        width: w as u32,
        height: h as u32,
        stats,
        params: params.into(),
    })
}

/// Return the full value matrix as binary data:
/// 8-byte header (u32 LE width, u32 LE height) followed by w*h f32 LE values
/// (°C for thermal images, index units for vegetation indices).
#[tauri::command]
pub async fn thermal_get_temp_matrix(
    asset_id: i64,
    overrides: Option<MeasureOverrides>,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let db = state.db_authenticated()?;
    let (w, h, values, _params) = load_measurement(&db, asset_id, overrides.unwrap_or_default())?;

    let mut out = Vec::with_capacity(8 + values.len() * 4);
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    for t in &values {
        out.extend_from_slice(&t.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(out))
}

/// Run anomaly detection ("AI analysis") on a radiometric image or index raster.
#[tauri::command]
pub async fn thermal_detect_anomalies(
    asset_id: i64,
    options: Option<AnomalyOptions>,
    overrides: Option<MeasureOverrides>,
    state: State<'_, AppState>,
) -> Result<AnomalyResult, String> {
    let db = state.db_authenticated()?;
    let (w, h, values, _params) = load_measurement(&db, asset_id, overrides.unwrap_or_default())?;
    let opts = options.unwrap_or(AnomalyOptions {
        z_threshold: None,
        min_region_px: None,
        max_regions: None,
        range_low: None,
        range_high: None,
    });
    Ok(analysis::detect_anomalies(&values, w, h, opts))
}

// ---------------- Vegetation indices ----------------

/// Compute a vegetation index over a multispectral asset and store the
/// result as a new library asset: a colormapped PNG (viewable/annotatable)
/// plus a raw f32 raster sidecar that feeds the analysis pipeline
/// (histogram, range isolation, anomaly detection).
#[tauri::command]
pub async fn thermal_compute_index(
    asset_id: i64,
    index_name: String,
    formula: String,
    band_mapping: std::collections::HashMap<String, usize>,
    state: State<'_, AppState>,
) -> Result<ThermalAsset, String> {
    let db = state.db_authenticated()?;
    let data_dir = state.data_dir.clone();
    // Decoding a multi-hundred-MB GeoTIFF and evaluating the formula per
    // pixel is heavy CPU work — keep it off the async runtime's core threads.
    tauri::async_runtime::spawn_blocking(move || {
        compute_index_impl(&db, &data_dir, asset_id, index_name, formula, band_mapping)
    })
    .await
    .map_err(|e| format!("Index computation task failed: {e}"))?
}

fn compute_index_impl(
    db: &crate::database::Database,
    data_dir: &std::path::Path,
    asset_id: i64,
    index_name: String,
    formula: String,
    band_mapping: std::collections::HashMap<String, usize>,
) -> Result<ThermalAsset, String> {
    let source = db.get_thermal_asset(asset_id).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&source.stored_path)
        .map_err(|e| format!("Failed to read source asset: {e}"))?;

    // Uppercase the mapping keys so formula variables match case-insensitively
    let vars: std::collections::HashMap<String, usize> = band_mapping
        .into_iter()
        .map(|(k, v)| (k.to_ascii_uppercase(), v))
        .collect();
    if vars.is_empty() {
        return Err("Map at least one band before computing an index".to_string());
    }

    let stack = super::multispectral::read_bands(&bytes)?;
    for (name, &band) in &vars {
        if band >= stack.bands.len() {
            return Err(format!(
                "Band {} mapped to '{name}' does not exist (raster has {} bands)",
                band + 1,
                stack.bands.len()
            ));
        }
    }
    let expr = super::multispectral::parse_formula(&formula, &vars)?;
    let raster = super::multispectral::compute_index(&stack, &expr);
    let render = super::multispectral::render_index(&raster, stack.width, stack.height)?;

    // Store: colormapped PNG as the asset file + f32 sidecar raster
    let profile = database::get_active_profile(data_dir);
    let folder = super::thermal_folder(data_dir, &profile);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Failed to create thermal folder: {e}"))?;

    let id = super::next_id();
    let file_name = sanitize_file_name(&format!("{index_name}.png"));
    let stored_path = folder.join(format!("{id}_{file_name}"));
    render
        .png
        .save_with_format(&stored_path, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to write index image: {e}"))?;

    let raster_name = format!("{id}_raster.f32");
    let raster_path = folder.join(&raster_name);
    let mut raw = Vec::with_capacity(raster.len() * 4);
    for v in &raster {
        raw.extend_from_slice(&v.to_le_bytes());
    }
    if let Err(e) = std::fs::write(&raster_path, &raw) {
        let _ = std::fs::remove_file(&stored_path);
        return Err(format!("Failed to write index raster: {e}"));
    }

    let file_hash = sha256_hex(&raw);
    let meta = serde_json::json!({
        "kind": "vegetation_index",
        "indexName": index_name,
        "formula": formula,
        "bandMapping": vars,
        "sourceAssetId": asset_id,
        "width": stack.width,
        "height": stack.height,
        "rasterFile": raster_name,
        "stats": { "min": render.min, "max": render.max, "mean": render.mean },
        "displayRange": { "low": render.range.0, "high": render.range.1 },
    });

    let asset = ThermalAsset {
        id,
        file_name,
        stored_path: stored_path.to_string_lossy().to_string(),
        file_hash: Some(file_hash),
        asset_type: "image".to_string(),
        // The analysis pipeline treats index rasters like measurements
        is_radiometric: true,
        width: stack.width as i32,
        height: stack.height as i32,
        gps_lat: source.gps_lat,
        gps_lon: source.gps_lon,
        captured_at: source.captured_at.clone(),
        camera_model: source.camera_model.clone(),
        imported_at: None,
        notes: None,
        source: "metashape".to_string(),
        meta_json: Some(meta.to_string()),
    };
    if let Err(e) = db.insert_thermal_asset(&asset) {
        let _ = std::fs::remove_file(&stored_path);
        let _ = std::fs::remove_file(&raster_path);
        return Err(e.to_string());
    }
    db.get_thermal_asset(id).map_err(|e| e.to_string())
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

// ---------------- AI thermal analysis (Claude / OpenAI / Gemini) ----------------

/// Settings-table key for the selected AI provider ("claude" | "openai" | "gemini").
const THERMAL_AI_PROVIDER_SETTING: &str = "thermal_ai_provider";
/// Legacy single-key setting from before provider selection existed (Claude).
const THERMAL_AI_LEGACY_KEY_SETTING: &str = "thermal_ai_api_key";

const AI_PROVIDERS: [&str; 3] = ["claude", "openai", "gemini"];

fn validate_provider(provider: &str) -> Result<(), String> {
    if AI_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("Unknown AI provider '{provider}'"))
    }
}

fn provider_key_setting(provider: &str) -> String {
    format!("thermal_ai_api_key_{provider}")
}

fn get_ai_provider(db: &crate::database::Database) -> String {
    db.get_setting(THERMAL_AI_PROVIDER_SETTING)
        .ok()
        .flatten()
        .filter(|p| AI_PROVIDERS.contains(&p.as_str()))
        .unwrap_or_else(|| "claude".to_string())
}

fn get_ai_key(db: &crate::database::Database, provider: &str) -> Option<String> {
    let key = db
        .get_setting(&provider_key_setting(provider))
        .ok()
        .flatten()
        .filter(|k| !k.trim().is_empty());
    if key.is_some() {
        return key;
    }
    // Fall back to the pre-provider-selection key (was always a Claude key)
    if provider == "claude" {
        return db
            .get_setting(THERMAL_AI_LEGACY_KEY_SETTING)
            .ok()
            .flatten()
            .filter(|k| !k.trim().is_empty());
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThermalAiConfig {
    pub provider: String,
    pub has_claude_key: bool,
    pub has_openai_key: bool,
    pub has_gemini_key: bool,
}

#[tauri::command]
pub async fn thermal_ai_get_config(state: State<'_, AppState>) -> Result<ThermalAiConfig, String> {
    let db = state.db_authenticated()?;
    Ok(ThermalAiConfig {
        provider: get_ai_provider(&db),
        has_claude_key: get_ai_key(&db, "claude").is_some(),
        has_openai_key: get_ai_key(&db, "openai").is_some(),
        has_gemini_key: get_ai_key(&db, "gemini").is_some(),
    })
}

#[tauri::command]
pub async fn thermal_ai_set_provider(provider: String, state: State<'_, AppState>) -> Result<(), String> {
    validate_provider(&provider)?;
    let db = state.db_authenticated()?;
    db.set_setting(THERMAL_AI_PROVIDER_SETTING, &provider)
        .map_err(|e| e.to_string())
}

/// True when the currently selected provider has a key configured.
#[tauri::command]
pub async fn thermal_ai_has_api_key(state: State<'_, AppState>) -> Result<bool, String> {
    let db = state.db_authenticated()?;
    let provider = get_ai_provider(&db);
    Ok(get_ai_key(&db, &provider).is_some())
}

#[tauri::command]
pub async fn thermal_ai_set_api_key(
    provider: String,
    api_key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_provider(&provider)?;
    let key = api_key.trim();
    if key.is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    let db = state.db_authenticated()?;
    db.set_setting(&provider_key_setting(&provider), key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thermal_ai_remove_api_key(
    provider: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_provider(&provider)?;
    let db = state.db_authenticated()?;
    db.set_setting(&provider_key_setting(&provider), "")
        .map_err(|e| e.to_string())?;
    if provider == "claude" {
        // Clear the legacy fallback too, or removal would appear to fail
        let _ = db.set_setting(THERMAL_AI_LEGACY_KEY_SETTING, "");
    }
    Ok(())
}

const AI_SYSTEM_PROMPT: &str =
    "You are an expert building-envelope thermographer analyzing drone thermal \
     imagery (DJI radiometric cameras). You write concise, professional \
     inspection findings. Format all math as plain text — no LaTeX. Keep \
     responses focused and brief; lead with the most important finding.";

fn ai_user_prompt(file_name: &str, context_json: &str) -> String {
    format!(
        "This is a thermal inspection image ({file_name}). Measured analysis data \
         from the DJI Thermal SDK (temperatures in °C):\n\n{context_json}\n\n\
         Write a thermal inspection narrative with these sections:\n\
         1. Summary — one short paragraph on the overall thermal condition.\n\
         2. Findings — for each detected anomaly region (reference them by \
         their id numbers), interpret what the temperature variance most \
         likely indicates (insulation gap, air leak, moisture, thermal \
         bridging, electrical, HVAC…), including the ΔT versus baseline.\n\
         3. Recommendations — prioritized repair actions ordered by severity, \
         plus any energy-saving upgrades.\n\
         Be specific and reference the measured values. If the data suggests \
         a benign explanation (solar loading, reflections, sky background), \
         say so rather than inventing defects."
    )
}

/// Generate an AI narrative analysis of a thermal image via the provider
/// selected in Settings (Claude, OpenAI, or Gemini). `context_json` carries
/// the measured stats/anomalies/network results the frontend already has;
/// the stored asset image is attached for vision.
#[tauri::command]
pub async fn thermal_ai_generate_findings(
    asset_id: i64,
    context_json: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state.db_authenticated()?;
    let provider = get_ai_provider(&db);
    let api_key = get_ai_key(&db, &provider).ok_or_else(|| {
        format!(
            "No API key configured for the selected AI provider ({provider}) — add one in \
             Settings (below the DJI API key)."
        )
    })?;

    let (asset, bytes) = load_asset_bytes(&db, asset_id)?;
    let media_type = if asset.file_name.to_lowercase().ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    use base64::Engine as _;
    let image_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let user_text = ai_user_prompt(&asset.file_name, &context_json);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    match provider.as_str() {
        "claude" => generate_claude(&client, &api_key, media_type, &image_b64, &user_text).await,
        "openai" => generate_openai(&client, &api_key, media_type, &image_b64, &user_text).await,
        "gemini" => generate_gemini(&client, &api_key, media_type, &image_b64, &user_text).await,
        other => Err(format!("Unknown AI provider '{other}'")),
    }
}

async fn generate_claude(
    client: &reqwest::Client,
    api_key: &str,
    media_type: &str,
    image_b64: &str,
    user_text: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": "claude-opus-5",
        "max_tokens": 16000,
        "system": AI_SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": image_b64}
                },
                {"type": "text", "text": user_text}
            ]
        }]
    });

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude request failed: {e}"))?;

    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Claude response: {e}"))?;
    if !status.is_success() {
        let msg = json["error"]["message"].as_str().unwrap_or("unknown error");
        return Err(format!("Claude request failed ({status}): {msg}"));
    }
    // Check stop_reason before reading content — safety classifiers can
    // decline with an HTTP 200 and an empty/partial content array.
    if json["stop_reason"].as_str() == Some("refusal") {
        return Err(
            "Claude declined to analyze this image (safety refusal). Try again or adjust \
             the image."
                .to_string(),
        );
    }
    let text = json["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Claude returned an empty response".to_string());
    }
    Ok(text)
}

async fn generate_openai(
    client: &reqwest::Client,
    api_key: &str,
    media_type: &str,
    image_b64: &str,
    user_text: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": "gpt-5",
        "max_completion_tokens": 16000,
        "messages": [
            {"role": "system", "content": AI_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": format!("data:{media_type};base64,{image_b64}")}
                },
                {"type": "text", "text": user_text}
            ]}
        ]
    });

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;

    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse OpenAI response: {e}"))?;
    if !status.is_success() {
        let msg = json["error"]["message"].as_str().unwrap_or("unknown error");
        return Err(format!("OpenAI request failed ({status}): {msg}"));
    }
    let choice = &json["choices"][0];
    if choice["finish_reason"].as_str() == Some("content_filter") {
        return Err("OpenAI declined to analyze this image (content filter).".to_string());
    }
    let text = choice["message"]["content"].as_str().unwrap_or_default();
    if text.trim().is_empty() {
        return Err("OpenAI returned an empty response".to_string());
    }
    Ok(text.to_string())
}

async fn generate_gemini(
    client: &reqwest::Client,
    api_key: &str,
    media_type: &str,
    image_b64: &str,
    user_text: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "system_instruction": {"parts": [{"text": AI_SYSTEM_PROMPT}]},
        "contents": [{
            "role": "user",
            "parts": [
                {"inline_data": {"mime_type": media_type, "data": image_b64}},
                {"text": user_text}
            ]
        }],
        "generationConfig": {"maxOutputTokens": 16000}
    });

    let resp = client
        .post("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent")
        .header("x-goog-api-key", api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;

    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gemini response: {e}"))?;
    if !status.is_success() {
        let msg = json["error"]["message"].as_str().unwrap_or("unknown error");
        return Err(format!("Gemini request failed ({status}): {msg}"));
    }
    if let Some(reason) = json["promptFeedback"]["blockReason"].as_str() {
        return Err(format!("Gemini declined to analyze this image ({reason})."));
    }
    let text = json["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Gemini returned an empty response".to_string());
    }
    Ok(text)
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
