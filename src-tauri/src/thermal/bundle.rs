//! Inspection bundle: a single-file archive (.odlbundle — gzipped tar) that
//! packages an inspection into one portable file:
//!
//! - the inspection report (JSON)
//! - every referenced asset (thermal media + Metashape exports), including
//!   generated previews, annotations, and heat-flow networks
//! - linked DJI flight data (metadata + full telemetry) for archival
//!
//! Bundles round-trip: importing one on any machine/profile recreates the
//! assets (deduplicated by content hash), annotations, networks, and report.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::database;
use crate::tauri_app::AppState;

use super::ThermalAsset;

pub const BUNDLE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleAssetEntry {
    asset: ThermalAsset,
    annotations: Option<String>,
    network: Option<String>,
    /// Path of the original file inside the archive.
    archive_file: String,
    /// Path of the preview PNG inside the archive, when one exists.
    preview_file: Option<String>,
    /// Path of the f32 raster sidecar (vegetation indices), when one exists.
    #[serde(default)]
    raster_file: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    version: u32,
    name: String,
    report_name: Option<String>,
    /// The saved ThermalReport JSON (asset ids are remapped on import).
    report_json: Option<String>,
    assets: Vec<BundleAssetEntry>,
    /// Number of flights archived in flights_full.json.
    flight_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleImportResult {
    pub report_id: Option<i64>,
    pub report_name: Option<String>,
    pub imported_assets: usize,
    pub skipped_assets: usize,
    pub archived_flights: usize,
}

fn tar_append_bytes<W: std::io::Write>(
    tar: &mut tar::Builder<W>,
    name: &str,
    data: &[u8],
) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, name, data)
        .map_err(|e| format!("Failed to write {name} into bundle: {e}"))
}

/// Export an inspection to a single .odlbundle file.
#[tauri::command]
pub async fn thermal_export_bundle(
    dest_path: String,
    name: String,
    report_id: Option<i64>,
    report_json: Option<String>,
    asset_ids: Vec<i64>,
    flight_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state.db_authenticated()?;

    // Prefer the live report JSON handed over by the builder; fall back to
    // the saved copy when only an id was provided.
    let (report_json, report_name) = if let Some(json) = report_json {
        (Some(json), Some(name.clone()))
    } else if let Some(id) = report_id {
        let json = db.get_thermal_report(id).map_err(|e| e.to_string())?;
        (Some(json), Some(name.clone()))
    } else {
        (None, None)
    };

    // Collect asset entries (deduplicated, missing ones skipped with a note)
    let mut seen = std::collections::HashSet::new();
    let mut entries: Vec<(BundleAssetEntry, PathBuf, Option<PathBuf>, Option<PathBuf>)> =
        Vec::new();
    for id in asset_ids {
        if !seen.insert(id) {
            continue;
        }
        let asset = match db.get_thermal_asset(id) {
            Ok(a) => a,
            Err(_) => continue, // referenced asset no longer exists
        };
        let src = PathBuf::from(&asset.stored_path);
        if !src.exists() {
            continue;
        }
        let archive_file = format!("assets/{}_{}", asset.id, asset.file_name);
        let preview_src = super::commands::preview_path_for(&asset).filter(|p| p.exists());
        let preview_file = preview_src
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| format!("assets/{}", n.to_string_lossy()));
        let raster_src = super::commands::raster_path_for(&asset).filter(|p| p.exists());
        let raster_file = raster_src
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| format!("assets/{}", n.to_string_lossy()));
        let annotations = db.get_thermal_annotations(id).ok().flatten();
        let network = db.get_thermal_network(id).ok().flatten();
        entries.push((
            BundleAssetEntry {
                asset,
                annotations,
                network,
                archive_file,
                preview_file,
                raster_file,
            },
            src,
            preview_src,
            raster_src,
        ));
    }

    // Collect flight archives (full telemetry)
    let mut flights = Vec::new();
    for id in flight_ids {
        let flight = match db.get_flight_by_id(id) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let telemetry = db
            .get_flight_telemetry(id, None, None)
            .map_err(|e| format!("Failed to read telemetry for flight {id}: {e}"))?;
        flights.push(serde_json::json!({ "flight": flight, "telemetry": telemetry }));
    }

    let manifest = BundleManifest {
        version: BUNDLE_VERSION,
        name,
        report_name,
        report_json,
        assets: entries.iter().map(|(e, _, _, _)| e).map(clone_entry).collect(),
        flight_count: flights.len(),
    };

    // Write the archive; on any failure remove the partial file so a
    // truncated, unopenable .odlbundle is never left at the destination.
    let dest = PathBuf::from(&dest_path);
    let write_result = (|| -> Result<(), String> {
        let file = std::fs::File::create(&dest)
            .map_err(|e| format!("Failed to create bundle file: {e}"))?;
        let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut tar = tar::Builder::new(gz);

        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
        tar_append_bytes(&mut tar, "manifest.json", &manifest_bytes)?;

        let flights_bytes = serde_json::to_vec(&flights)
            .map_err(|e| format!("Failed to serialize flight data: {e}"))?;
        tar_append_bytes(&mut tar, "flights_full.json", &flights_bytes)?;

        for (entry, src, preview_src, raster_src) in &entries {
            tar.append_path_with_name(src, &entry.archive_file)
                .map_err(|e| format!("Failed to add {} to bundle: {e}", entry.asset.file_name))?;
            if let (Some(p_src), Some(p_name)) = (preview_src, &entry.preview_file) {
                tar.append_path_with_name(p_src, p_name)
                    .map_err(|e| format!("Failed to add preview to bundle: {e}"))?;
            }
            if let (Some(r_src), Some(r_name)) = (raster_src, &entry.raster_file) {
                tar.append_path_with_name(r_src, r_name)
                    .map_err(|e| format!("Failed to add index raster to bundle: {e}"))?;
            }
        }

        tar.into_inner()
            .map_err(|e| format!("Failed to finalize bundle: {e}"))?
            .finish()
            .map_err(|e| format!("Failed to finalize bundle: {e}"))?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&dest);
        return Err(e);
    }

    Ok(dest.to_string_lossy().to_string())
}

fn clone_entry(e: &BundleAssetEntry) -> BundleAssetEntry {
    BundleAssetEntry {
        asset: e.asset.clone(),
        annotations: e.annotations.clone(),
        network: e.network.clone(),
        archive_file: e.archive_file.clone(),
        preview_file: e.preview_file.clone(),
        raster_file: e.raster_file.clone(),
    }
}

/// Remap old→new asset ids inside a report JSON value.
fn remap_report_ids(report: &mut serde_json::Value, map: &std::collections::HashMap<i64, i64>) {
    let remap = |v: &mut serde_json::Value| {
        if let Some(old) = v.as_i64() {
            if let Some(new) = map.get(&old) {
                *v = serde_json::json!(new);
            } else {
                *v = serde_json::Value::Null; // referenced asset wasn't in the bundle
            }
        }
    };
    if let Some(entries) = report.get_mut("imagingLog").and_then(|v| v.as_array_mut()) {
        for e in entries {
            if let Some(v) = e.get_mut("thermalAssetId") {
                remap(v);
            }
            if let Some(v) = e.get_mut("visualAssetId") {
                remap(v);
            }
        }
    }
    if let Some(entries) = report.get_mut("anomalies").and_then(|v| v.as_array_mut()) {
        for e in entries {
            if let Some(v) = e.get_mut("assetId") {
                remap(v);
            }
        }
    }
    if let Some(v) = report.get_mut("orthoAssetId") {
        remap(v);
    }
}

/// Import an .odlbundle file: recreate assets (deduplicated by hash),
/// annotations, networks, and the report (with remapped asset ids).
#[tauri::command]
pub async fn thermal_import_bundle(
    src_path: String,
    state: State<'_, AppState>,
) -> Result<BundleImportResult, String> {
    let db = state.db_authenticated()?;
    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err(format!("Bundle not found: {src_path}"));
    }

    let profile = database::get_active_profile(&state.data_dir);
    let folder = super::thermal_folder(&state.data_dir, &profile);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Failed to create thermal folder: {e}"))?;

    // Extract to a temp dir on the same volume so renames into place are cheap
    let tmp_dir = folder.join(format!(".bundle_import_{}", super::next_id()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create temp folder: {e}"))?;
    let cleanup = |dir: &Path| {
        let _ = std::fs::remove_dir_all(dir);
    };

    let result = (|| -> Result<BundleImportResult, String> {
        let file =
            std::fs::File::open(&src).map_err(|e| format!("Failed to open bundle: {e}"))?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);

        let mut manifest: Option<BundleManifest> = None;
        let mut archived_flights = 0usize;
        for entry in archive
            .entries()
            .map_err(|e| format!("Invalid bundle archive: {e}"))?
        {
            let mut entry = entry.map_err(|e| format!("Invalid bundle entry: {e}"))?;
            let path = entry
                .path()
                .map_err(|e| format!("Invalid path in bundle: {e}"))?
                .to_path_buf();
            let name = path.to_string_lossy().replace('\\', "/");
            if name == "manifest.json" {
                let mut buf = Vec::new();
                entry
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Failed to read manifest: {e}"))?;
                manifest = Some(
                    serde_json::from_slice(&buf)
                        .map_err(|e| format!("Invalid bundle manifest: {e}"))?,
                );
            } else if name == "flights_full.json" {
                let mut buf = Vec::new();
                entry
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Failed to read flight data: {e}"))?;
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {
                    archived_flights = v.as_array().map(|a| a.len()).unwrap_or(0);
                }
            } else if let Some(file_name) = name.strip_prefix("assets/") {
                // Flatten to the temp dir under the bare archive file name
                let safe = Path::new(file_name)
                    .file_name()
                    .ok_or_else(|| format!("Unsafe path in bundle: {name}"))?;
                let dest = tmp_dir.join(safe);
                let mut out = std::fs::File::create(&dest)
                    .map_err(|e| format!("Failed to extract {name}: {e}"))?;
                std::io::copy(&mut entry, &mut out)
                    .map_err(|e| format!("Failed to extract {name}: {e}"))?;
            }
        }

        let manifest = manifest.ok_or("Bundle has no manifest.json")?;
        if manifest.version > BUNDLE_VERSION {
            return Err(format!(
                "Bundle version {} is newer than this app supports ({BUNDLE_VERSION})",
                manifest.version
            ));
        }

        // Recreate assets, deduplicating by content hash. Per-asset failures
        // skip that asset rather than aborting the whole import.
        let mut id_map: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
        let mut imported = 0usize;
        let mut skipped = 0usize;
        for entry in &manifest.assets {
            let old_id = entry.asset.id;
            if let Some(hash) = &entry.asset.file_hash {
                if let Ok(Some(existing)) = db.find_thermal_asset_by_hash(hash) {
                    // The file already exists locally — but the bundle may
                    // carry annotations/network the local copy lacks. Never
                    // overwrite local work; fill in only when absent.
                    if let Some(ann) = &entry.annotations {
                        if db.get_thermal_annotations(existing.id).ok().flatten().is_none() {
                            let _ = db.set_thermal_annotations(existing.id, ann);
                        }
                    }
                    if let Some(net) = &entry.network {
                        if db.get_thermal_network(existing.id).ok().flatten().is_none() {
                            let _ = db.set_thermal_network(existing.id, net);
                        }
                    }
                    id_map.insert(old_id, existing.id);
                    skipped += 1;
                    continue;
                }
            }

            let archive_base = match Path::new(&entry.archive_file)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
            {
                Some(b) => b,
                None => {
                    skipped += 1;
                    continue;
                }
            };
            let extracted = tmp_dir.join(&archive_base);
            if !extracted.exists() {
                skipped += 1;
                continue;
            }

            // SECURITY: the manifest file name is untrusted — a crafted
            // bundle could smuggle path separators / dot segments and make
            // the join below escape the thermal folder (arbitrary file
            // write). Sanitize exactly like the normal import path, and
            // verify containment as defense in depth.
            let new_id = super::next_id();
            let safe_name = super::commands::sanitize_file_name(&entry.asset.file_name);
            let stored_path = folder.join(format!("{new_id}_{safe_name}"));
            if !stored_path.starts_with(&folder) {
                skipped += 1;
                continue;
            }
            if std::fs::rename(&extracted, &stored_path).is_err() {
                skipped += 1;
                continue;
            }

            // Strip stale sidecar references; re-add each only after its
            // file has actually been placed.
            let mut meta_json = entry.asset.meta_json.clone().map(|json| {
                match serde_json::from_str::<serde_json::Value>(&json) {
                    Ok(mut meta) => {
                        if let Some(o) = meta.as_object_mut() {
                            o.remove("previewFile");
                            o.remove("rasterFile");
                        }
                        meta.to_string()
                    }
                    Err(_) => json,
                }
            });
            let place_sidecar = |archive_name: &Option<String>,
                                 dest_name: String,
                                 meta_key: &str,
                                 meta_json: &mut Option<String>|
             -> bool {
                let Some(archive) = archive_name else { return false };
                let Some(base) = Path::new(archive)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                else {
                    return false;
                };
                let extracted = tmp_dir.join(&base);
                if extracted.exists()
                    && std::fs::rename(&extracted, folder.join(&dest_name)).is_ok()
                {
                    if let Some(json) = meta_json.as_ref() {
                        if let Ok(mut meta) = serde_json::from_str::<serde_json::Value>(json) {
                            meta[meta_key] = serde_json::json!(dest_name);
                            *meta_json = Some(meta.to_string());
                        }
                    }
                    true
                } else {
                    false
                }
            };
            place_sidecar(
                &entry.preview_file,
                format!("{new_id}_preview.png"),
                "previewFile",
                &mut meta_json,
            );
            let raster_placed = place_sidecar(
                &entry.raster_file,
                format!("{new_id}_raster.f32"),
                "rasterFile",
                &mut meta_json,
            );

            let mut asset = entry.asset.clone();
            // An index asset without its raster can't feed the analysis
            // pipeline — don't advertise it as measurable.
            if entry.raster_file.is_some() && !raster_placed {
                asset.is_radiometric = false;
            }
            asset.id = new_id;
            asset.file_name = safe_name;
            asset.stored_path = stored_path.to_string_lossy().to_string();
            asset.imported_at = None;
            asset.meta_json = meta_json;
            if db.insert_thermal_asset(&asset).is_err() {
                let _ = std::fs::remove_file(&stored_path);
                skipped += 1;
                continue;
            }
            if let Some(ann) = &entry.annotations {
                let _ = db.set_thermal_annotations(new_id, ann);
            }
            if let Some(net) = &entry.network {
                let _ = db.set_thermal_network(new_id, net);
            }
            id_map.insert(old_id, new_id);
            imported += 1;
        }

        // Recreate the report with remapped asset ids
        let mut report_id = None;
        let mut report_name = None;
        if let Some(json) = &manifest.report_json {
            let mut report: serde_json::Value = serde_json::from_str(json)
                .map_err(|e| format!("Invalid report JSON in bundle: {e}"))?;
            remap_report_ids(&mut report, &id_map);
            let name = manifest
                .report_name
                .clone()
                .unwrap_or_else(|| manifest.name.clone());
            let name = format!("{name} (imported)");
            let id = db
                .save_thermal_report(None, &name, &report.to_string())
                .map_err(|e| e.to_string())?;
            report_id = Some(id);
            report_name = Some(name);
        }

        Ok(BundleImportResult {
            report_id,
            report_name,
            imported_assets: imported,
            skipped_assets: skipped,
            archived_flights,
        })
    })();

    cleanup(&tmp_dir);
    result
}
