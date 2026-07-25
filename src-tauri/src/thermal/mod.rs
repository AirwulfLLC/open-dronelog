//! Thermal inspection support built on the DJI Thermal SDK.
//!
//! - `sdk`: dynamic FFI bindings to libdirp (radiometric JPEG decoding)
//! - `analysis`: temperature statistics + anomaly detection ("AI analysis")
//! - `commands`: Tauri commands exposed to the frontend (desktop builds)

pub mod analysis;
pub mod metashape;
pub mod multispectral;
pub mod network;
pub mod sdk;

#[cfg(feature = "tauri-app")]
pub mod bundle;

#[cfg(feature = "tauri-app")]
pub mod commands;

use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::Serialize;

static ID_COUNTER: AtomicI64 = AtomicI64::new(0);

/// Generate a unique, strictly increasing i64 id (wall-clock seeded).
/// Unlike a raw timestamp, concurrent or same-millisecond calls never collide.
pub fn next_id() -> i64 {
    let now = chrono::Utc::now().timestamp_millis();
    let prev = ID_COUNTER
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |prev| {
            Some(if now > prev { now } else { prev + 1 })
        })
        .unwrap();
    if now > prev {
        now
    } else {
        prev + 1
    }
}

/// A thermal asset (imported photo or video) as stored in the database.
#[derive(Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThermalAsset {
    pub id: i64,
    pub file_name: String,
    pub stored_path: String,
    pub file_hash: Option<String>,
    /// "image" | "video"
    pub asset_type: String,
    pub is_radiometric: bool,
    pub width: i32,
    pub height: i32,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub captured_at: Option<String>,
    pub camera_model: Option<String>,
    pub imported_at: Option<String>,
    pub notes: Option<String>,
    /// "thermal" (drone thermal/visual media) or "metashape" (photogrammetry export).
    #[serde(default = "default_asset_source")]
    pub source: String,
    /// Parsed metadata JSON (Metashape kind, preview file, CRS, camera count…).
    #[serde(default)]
    pub meta_json: Option<String>,
}

fn default_asset_source() -> String {
    "thermal".to_string()
}

/// Metadata extracted from an image's EXIF block.
#[derive(Default, Debug, Clone)]
pub struct ExifMeta {
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub captured_at: Option<String>,
    pub camera_model: Option<String>,
}

/// File extensions accepted by the thermal importer.
pub const IMAGE_EXTENSIONS: [&str; 3] = ["jpg", "jpeg", "png"];
pub const VIDEO_EXTENSIONS: [&str; 3] = ["mp4", "mov", "avi"];

pub fn asset_type_for(file_name: &str) -> Option<&'static str> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some("image")
    } else if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some("video")
    } else {
        None
    }
}

/// Return the thermal-assets folder for a profile
/// ("default" → `thermal`, anything else → `thermal/{profile}`).
pub fn thermal_folder(data_dir: &Path, profile: &str) -> std::path::PathBuf {
    if profile == "default" {
        data_dir.join("thermal")
    } else {
        data_dir.join("thermal").join(profile)
    }
}

fn rational_to_deg(field: &exif::Field) -> Option<f64> {
    if let exif::Value::Rational(ref vals) = field.value {
        if vals.len() >= 3 {
            let d = vals[0].to_f64();
            let m = vals[1].to_f64();
            let s = vals[2].to_f64();
            return Some(d + m / 60.0 + s / 3600.0);
        }
    }
    None
}

fn ref_is_negative(field: Option<&exif::Field>) -> bool {
    field
        .map(|f| {
            let s = f.display_value().to_string();
            s.contains('S') || s.contains('W')
        })
        .unwrap_or(false)
}

/// Best-effort EXIF metadata extraction (GPS position, capture time, camera model).
pub fn extract_exif(bytes: &[u8]) -> ExifMeta {
    let mut meta = ExifMeta::default();
    let exif_reader = exif::Reader::new();
    let Ok(data) = exif_reader.read_from_container(&mut Cursor::new(bytes)) else {
        return meta;
    };

    use exif::{In, Tag};

    if let Some(lat_field) = data.get_field(Tag::GPSLatitude, In::PRIMARY) {
        if let Some(mut lat) = rational_to_deg(lat_field) {
            if ref_is_negative(data.get_field(Tag::GPSLatitudeRef, In::PRIMARY)) {
                lat = -lat;
            }
            meta.gps_lat = Some(lat);
        }
    }
    if let Some(lon_field) = data.get_field(Tag::GPSLongitude, In::PRIMARY) {
        if let Some(mut lon) = rational_to_deg(lon_field) {
            if ref_is_negative(data.get_field(Tag::GPSLongitudeRef, In::PRIMARY)) {
                lon = -lon;
            }
            meta.gps_lon = Some(lon);
        }
    }
    if let Some(dt) = data
        .get_field(Tag::DateTimeOriginal, In::PRIMARY)
        .or_else(|| data.get_field(Tag::DateTime, In::PRIMARY))
    {
        // Ascii EXIF values render quoted; strip the quotes.
        meta.captured_at = Some(dt.display_value().to_string().replace('"', ""));
    }
    if let Some(model) = data.get_field(Tag::Model, In::PRIMARY) {
        meta.camera_model = Some(model.display_value().to_string().replace('"', ""));
    }
    meta
}

/// Full analysis summary for a radiometric image, returned to the frontend.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThermalAnalysis {
    pub asset_id: i64,
    pub width: u32,
    pub height: u32,
    pub stats: analysis::TempStats,
    pub params: MeasurementParamsJson,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MeasurementParamsJson {
    pub distance: f32,
    pub humidity: f32,
    pub emissivity: f32,
    pub reflection: f32,
    pub ambient_temp: f32,
}

impl From<sdk::DirpMeasurementParams> for MeasurementParamsJson {
    fn from(p: sdk::DirpMeasurementParams) -> Self {
        // Copy out of the packed struct before use (unaligned reads).
        let sdk::DirpMeasurementParams {
            distance,
            humidity,
            emissivity,
            reflection,
            ambient_temp,
        } = p;
        Self {
            distance,
            humidity,
            emissivity,
            reflection,
            ambient_temp,
        }
    }
}
