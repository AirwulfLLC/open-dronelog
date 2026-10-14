//! Thermal inspection support built on the DJI Thermal SDK.
//!
//! - `sdk`: dynamic FFI bindings to libdirp (radiometric JPEG decoding)
//! - `analysis`: temperature statistics + anomaly detection ("AI analysis")
//! - `commands`: Tauri commands exposed to the frontend (desktop builds)

pub mod analysis;
pub mod flir;
pub mod metashape;
pub mod multispectral;
pub mod network;
pub mod radiometric;
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
    /// "thermal" (drone thermal/visual media), "metashape" (Metashape export)
    /// or "photogrammetry" (visual photos/videos for the photogrammetry report).
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
    /// Camera manufacturer (EXIF Make) and body serial number, when recorded —
    /// the report builder fills the "camera used" fields from them.
    pub camera_make: Option<String>,
    pub camera_serial: Option<String>,
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

/// Longest display name a rename accepts (characters).
pub const MAX_DISPLAY_NAME_CHARS: usize = 200;

/// Characters that would hide inside a printed name or reorder it: C0/C1
/// controls plus the zero-width and bidirectional-override format characters.
fn is_hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}'
        )
}

/// The display name an asset gets when the user renames it. The display name
/// is what the libraries list and the reports print; the file on disk keeps
/// its internal `{id}_{sanitized}` name, so the display name may carry spaces
/// and punctuation — only path separators, control characters and names
/// without a stem are refused. The extension is locked to the current one
/// (typed or not, in any case): it decides how the file is served (MIME type)
/// and probed, and the user is naming the picture, not converting it.
pub fn display_name_for_rename(current_file_name: &str, requested: &str) -> Result<String, String> {
    let name = requested.trim();
    if name.chars().any(|c| c == '/' || c == '\\' || is_hidden_char(c)) {
        return Err("The name cannot contain slashes or control characters.".to_string());
    }
    let ext = Path::new(current_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let suffix = if ext.is_empty() { String::new() } else { format!(".{ext}") };
    // Drop a typed copy of the extension (any letter case) — it is re-added
    // below. `get` refuses a cut inside a multibyte character, so a non-ASCII
    // name is simply treated as having no typed extension.
    let stem = if suffix.is_empty() {
        name
    } else {
        name.len()
            .checked_sub(suffix.len())
            .and_then(|cut| name.get(..cut).zip(name.get(cut..)))
            .filter(|(_, typed_ext)| typed_ext.eq_ignore_ascii_case(&suffix))
            .map(|(stem, _)| stem)
            .unwrap_or(name)
    };
    // Trailing dots/spaces would read as a different extension or vanish on
    // some file systems; a dot-only or empty stem is no name at all
    let stem = stem.trim_end_matches(|c: char| c == '.' || c.is_whitespace()).trim();
    if stem.is_empty() {
        return Err("Enter a name.".to_string());
    }
    if stem.chars().count() + suffix.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(format!(
            "The name is too long (at most {MAX_DISPLAY_NAME_CHARS} characters)."
        ));
    }
    Ok(format!("{stem}{suffix}"))
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
    let text = |field: &exif::Field| {
        let s = field.display_value().to_string().replace('"', "");
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    };
    if let Some(make) = data.get_field(Tag::Make, In::PRIMARY) {
        meta.camera_make = text(make);
    }
    if let Some(serial) = data.get_field(Tag::BodySerialNumber, In::PRIMARY) {
        meta.camera_serial = text(serial);
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

#[cfg(test)]
mod tests {
    use super::{display_name_for_rename, MAX_DISPLAY_NAME_CHARS};

    #[test]
    fn rename_keeps_the_stored_extension() {
        assert_eq!(display_name_for_rename("DJI_0001.JPG", "North wall").unwrap(), "North wall.JPG");
        // A typed extension is recognised in any letter case and not doubled
        assert_eq!(display_name_for_rename("DJI_0001.JPG", "North wall.jpg").unwrap(), "North wall.JPG");
        assert_eq!(display_name_for_rename("DJI_0001.JPG", "North wall.JPG").unwrap(), "North wall.JPG");
        // Dots inside the stem are part of the name
        assert_eq!(display_name_for_rename("a.JPG", "panel 3.v2").unwrap(), "panel 3.v2.JPG");
        // Another extension is not a conversion — it stays inside the stem
        assert_eq!(display_name_for_rename("frame.png", "roof.jpg").unwrap(), "roof.jpg.png");
        // No extension on the stored name: the stem is the whole name
        assert_eq!(display_name_for_rename("noext", "Roof").unwrap(), "Roof");
    }

    #[test]
    fn rename_trims_and_allows_punctuation() {
        assert_eq!(display_name_for_rename("x.JPG", "  Roof – bay 2, east  ").unwrap(), "Roof – bay 2, east.JPG");
        assert_eq!(display_name_for_rename("x.JPG", "Roof. ").unwrap(), "Roof.JPG");
        assert_eq!(display_name_for_rename("x.JPG", "Северная стена").unwrap(), "Северная стена.JPG");
    }

    #[test]
    fn rename_refuses_empty_paths_and_control_characters() {
        for bad in ["", "   ", ".JPG", ".", "..", "...", ". ."] {
            assert!(display_name_for_rename("x.JPG", bad).is_err(), "{bad:?} should be refused");
        }
        assert!(display_name_for_rename("x.JPG", "a/b").is_err());
        assert!(display_name_for_rename("x.JPG", "a\\b").is_err());
        assert!(display_name_for_rename("x.JPG", "a\nb").is_err());
        assert!(display_name_for_rename("x.JPG", "a\u{0}b").is_err());
        // Bidi override and zero-width characters could disguise a printed name
        assert!(display_name_for_rename("x.JPG", "a\u{202E}b").is_err());
        assert!(display_name_for_rename("x.JPG", "\u{200B}").is_err());
        let long = "n".repeat(MAX_DISPLAY_NAME_CHARS);
        assert!(display_name_for_rename("x.JPG", &long).is_err());
        assert!(display_name_for_rename("x.JPG", &long[..MAX_DISPLAY_NAME_CHARS - 4]).is_ok());
    }

    #[test]
    fn rename_survives_multibyte_text_before_the_extension() {
        // The extension check cuts at a byte offset: "éabc" is 5 bytes, so the
        // cut for a 4-byte ".JPG" lands inside the "é" and must not panic
        assert_eq!(display_name_for_rename("x.JPG", "éabc").unwrap(), "éabc.JPG");
        assert_eq!(display_name_for_rename("x.JPG", "éé").unwrap(), "éé.JPG");
        assert_eq!(display_name_for_rename("x.JPG", "ééé.jpg").unwrap(), "ééé.JPG");
    }
}
