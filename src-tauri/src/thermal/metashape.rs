//! Agisoft Metashape export handling.
//!
//! Metashape produces several artifact types that inspectors want alongside
//! thermal data: orthomosaics and DEMs (GeoTIFF), processing reports (PDF),
//! camera calibration/reference files (XML/CSV), point clouds (LAS/LAZ/PLY/
//! OBJ), and map overlays (KML/KMZ). This module classifies those files,
//! extracts lightweight metadata for display, and renders PNG previews for
//! GeoTIFFs so they can be viewed and annotated in the studio.

use serde_json::json;

/// Longest edge of generated orthomosaic previews (px).
const PREVIEW_MAX_DIM: u32 = 4096;

/// Classify a Metashape export by extension.
/// Returns (kind, viewer asset_type) or None when the file is not a
/// recognizable Metashape artifact.
pub fn detect_kind(file_name: &str) -> Option<(&'static str, &'static str)> {
    let ext = std::path::Path::new(file_name)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    match ext.as_str() {
        "tif" | "tiff" => Some(("orthomosaic", "image")),
        "pdf" => Some(("processing_report", "document")),
        "xml" => Some(("cameras_xml", "document")),
        "csv" => Some(("reference_csv", "document")),
        "las" | "laz" | "ply" | "obj" => Some(("point_cloud", "document")),
        "kml" | "kmz" => Some(("map_overlay", "document")),
        _ => None,
    }
}

/// Parse lightweight metadata from a Metashape artifact for display.
/// Best-effort — a partial or unrecognized file yields whatever could be read.
pub fn parse_metadata(kind: &str, bytes: &[u8]) -> serde_json::Value {
    let mut meta = json!({ "kind": kind, "sizeBytes": bytes.len() });
    match kind {
        "cameras_xml" => {
            if let Ok(text) = std::str::from_utf8(bytes) {
                let camera_count = text.matches("<camera ").count();
                if camera_count > 0 {
                    meta["cameraCount"] = json!(camera_count);
                }
                let marker_count = text.matches("<marker ").count();
                if marker_count > 0 {
                    meta["markerCount"] = json!(marker_count);
                }
                if let Some(crs) = extract_crs_name(text) {
                    meta["crs"] = json!(crs);
                }
            }
        }
        "reference_csv" => {
            if let Ok(text) = std::str::from_utf8(bytes) {
                let mut lines = text.lines().filter(|l| !l.trim().is_empty());
                // Metashape reference exports start with comment lines (#…)
                let header = lines.clone().find(|l| !l.starts_with('#'));
                let data_rows = lines
                    .by_ref()
                    .filter(|l| !l.starts_with('#'))
                    .count()
                    .saturating_sub(1);
                if let Some(h) = header {
                    let sep = if h.contains('\t') { '\t' } else { ',' };
                    meta["columns"] = json!(h.split(sep).count());
                }
                meta["rowCount"] = json!(data_rows);
            }
        }
        "map_overlay" => {
            if bytes.starts_with(b"PK") {
                meta["format"] = json!("kmz");
            } else {
                meta["format"] = json!("kml");
            }
        }
        _ => {}
    }
    meta
}

/// Extract a human-readable CRS name from Metashape XML (`<reference>` holds
/// a WKT string like `PROJCS["WGS 84 / UTM zone 16N", …]`).
fn extract_crs_name(text: &str) -> Option<String> {
    let start = text.find("<reference>")? + "<reference>".len();
    let end = text[start..].find("</reference>")? + start;
    let wkt = &text[start..end];
    for prefix in ["PROJCS[\"", "GEOGCS[\"", "COMPD_CS[\"", "LOCAL_CS[\""] {
        if let Some(p) = wkt.find(prefix) {
            let name_start = p + prefix.len();
            if let Some(q) = wkt[name_start..].find('"') {
                return Some(wkt[name_start..name_start + q].to_string());
            }
        }
    }
    None
}

/// Decode a (Geo)TIFF and write a PNG preview next to the original.
/// Returns (full_width, full_height, preview_file_name).
pub fn generate_tiff_preview(
    bytes: &[u8],
    dest_dir: &std::path::Path,
    base_name: &str,
) -> Result<(u32, u32, String), String> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Tiff)
        .map_err(|e| format!("Could not decode TIFF: {e}"))?;
    let (w, h) = (img.width(), img.height());

    let preview = if w.max(h) > PREVIEW_MAX_DIM {
        img.resize(PREVIEW_MAX_DIM, PREVIEW_MAX_DIM, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    // DEMs are single-channel 16-bit or float rasters whose values occupy a
    // narrow band of the sample range (elevations in meters) — a naive 8-bit
    // conversion renders them black or clipped. Min–max normalize those;
    // photographic 16-bit orthos convert directly.
    let preview = match &preview {
        image::DynamicImage::ImageLuma16(_)
        | image::DynamicImage::ImageLumaA16(_)
        | image::DynamicImage::ImageRgb32F(_)
        | image::DynamicImage::ImageRgba32F(_) => normalize_to_gray8(&preview),
        _ => image::DynamicImage::ImageRgba8(preview.to_rgba8()),
    };

    let preview_name = format!("{base_name}_preview.png");
    let preview_path = dest_dir.join(&preview_name);
    preview
        .save_with_format(&preview_path, image::ImageFormat::Png)
        .map_err(|e| format!("Could not write preview PNG: {e}"))?;
    Ok((w, h, preview_name))
}

/// Min–max normalize any raster to an 8-bit grayscale image (for DEMs).
fn normalize_to_gray8(img: &image::DynamicImage) -> image::DynamicImage {
    let gray = img.to_luma32f();
    let (mut min, mut max) = (f32::INFINITY, f32::NEG_INFINITY);
    for p in gray.pixels() {
        let v = p.0[0];
        if v.is_finite() {
            min = min.min(v);
            max = max.max(v);
        }
    }
    if !min.is_finite() || !max.is_finite() {
        return image::DynamicImage::ImageRgba8(img.to_rgba8());
    }
    let span = (max - min).max(1e-6);
    let out = image::GrayImage::from_fn(gray.width(), gray.height(), |x, y| {
        let v = gray.get_pixel(x, y).0[0];
        let n = if v.is_finite() { (v - min) / span * 255.0 } else { 0.0 };
        image::Luma([n.clamp(0.0, 255.0) as u8])
    });
    image::DynamicImage::ImageLuma8(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_kinds() {
        assert_eq!(detect_kind("ortho.TIF"), Some(("orthomosaic", "image")));
        assert_eq!(detect_kind("report.pdf"), Some(("processing_report", "document")));
        assert_eq!(detect_kind("cameras.xml"), Some(("cameras_xml", "document")));
        assert_eq!(detect_kind("ref.csv"), Some(("reference_csv", "document")));
        assert_eq!(detect_kind("cloud.las"), Some(("point_cloud", "document")));
        assert_eq!(detect_kind("overlay.kmz"), Some(("map_overlay", "document")));
        assert_eq!(detect_kind("photo.jpg"), None);
    }

    #[test]
    fn parses_cameras_xml() {
        let xml = r#"<document><chunk><sensors/><cameras>
            <camera id="0" label="DJI_0001"/><camera id="1" label="DJI_0002"/>
            </cameras><reference>PROJCS["WGS 84 / UTM zone 16N",GEOGCS["WGS 84"]]</reference>
            </chunk></document>"#;
        let meta = parse_metadata("cameras_xml", xml.as_bytes());
        assert_eq!(meta["cameraCount"], 2);
        assert_eq!(meta["crs"], "WGS 84 / UTM zone 16N");
    }

    #[test]
    fn parses_reference_csv() {
        let csv = "#Cameras (2)\nLabel,X,Y,Z\nDJI_0001,1,2,3\nDJI_0002,4,5,6\n";
        let meta = parse_metadata("reference_csv", csv.as_bytes());
        assert_eq!(meta["rowCount"], 2);
        assert_eq!(meta["columns"], 4);
    }

    #[test]
    fn dem_luma16_preview_is_normalized_not_black() {
        // Narrow-band 16-bit "elevation" raster (values 1000..1063 of 65535):
        // naive u16→u8 truncation renders ~0 everywhere. Normalization must
        // spread it across the 8-bit range.
        let dem = image::DynamicImage::ImageLuma16(image::ImageBuffer::from_fn(64, 32, |x, _| {
            image::Luma([1000u16 + x as u16])
        }));
        let mut buf = std::io::Cursor::new(Vec::new());
        dem.write_to(&mut buf, image::ImageFormat::Tiff).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let (_, _, name) = generate_tiff_preview(buf.get_ref(), dir.path(), "dem").unwrap();
        let preview = image::open(dir.path().join(&name)).unwrap().to_luma8();
        let max = preview.pixels().map(|p| p.0[0]).max().unwrap();
        let min = preview.pixels().map(|p| p.0[0]).min().unwrap();
        assert!(max > 200, "normalized max should reach near 255, got {max}");
        assert!(min < 50, "normalized min should reach near 0, got {min}");
    }

    #[test]
    fn tiff_preview_roundtrip() {
        // Build a tiny RGB TIFF in memory via the image crate, then preview it
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(64, 32, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 8) as u8, 128])
        }));
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Tiff).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let (w, h, name) = generate_tiff_preview(buf.get_ref(), dir.path(), "test").unwrap();
        assert_eq!((w, h), (64, 32));
        assert!(dir.path().join(&name).exists());
        let reread = image::open(dir.path().join(&name)).unwrap();
        assert_eq!((reread.width(), reread.height()), (64, 32));
    }
}
