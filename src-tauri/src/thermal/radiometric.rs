//! Radiometric data from cameras without a public SDK, read from the files
//! their own tools produce:
//!
//! - **Autel EVO II Dual 640T** radiometric TIFFs (the `TIFF+JPG (with irg)`
//!   photo format): 16-bit samples in tenths of a kelvin.
//! - **Float TIFFs** in °C (or kelvin), as exported by thermography software.
//! - **Temperature matrices as CSV**, one row of values per image row, as
//!   exported by FLIR Thermal Studio, the Autel IR tool and most other
//!   thermography tools — the common denominator for every camera.
//!
//! The temperatures are stored as an f32 raster sidecar (like vegetation
//! indices), so the analysis pipeline reads them without any SDK, and a
//! palette-rendered PNG preview stands in for the undisplayable original.
//!
//! Files reach this module two ways. An **explicit** import (the studio's
//! "Radiometric file…" button) says the file holds temperatures, so kelvin
//! is converted and small matrices accepted. An **auto-detected** file (a
//! `.tif`/`.csv` picked with the general importer, which would otherwise be
//! filed as a Metashape export) must look unmistakably like a thermal frame
//! in °C, or it is left to the Metashape path.

use super::multispectral;

/// Per-pixel temperatures decoded from a file.
pub struct TemperatureGrid {
    pub width: u32,
    pub height: u32,
    /// °C, row-major; NaN where a value is missing.
    pub temps: Vec<f32>,
    /// "autel_tiff" | "float_tiff" | "temperature_csv"
    pub format: &'static str,
    /// How the values were interpreted, for the asset's metadata.
    pub note: String,
}

/// Whether the user said the file is radiometric, or the importer is guessing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Explicit,
    AutoDetected,
}

/// The largest frame accepted from these files (a thermal camera, not an orthomosaic).
const MAX_FRAME_EDGE: u32 = 2048;
/// Smallest matrix an explicit import accepts (a tiny sensor crop).
const MIN_EXPLICIT: (usize, usize) = (32, 24);
/// Smallest matrix the auto-detection accepts — above any flight-log or
/// camera-reference table, below the smallest drone thermal frame (80×60).
const MIN_AUTO: (usize, usize) = (64, 48);
/// Autel 640T samples: tenths of a kelvin, so −53..+207 °C in counts.
const AUTEL_TENTHS_K: std::ops::RangeInclusive<f32> = 2_200.0..=4_800.0;
/// Temperatures in °C a thermal frame can plausibly hold.
const CELSIUS_RANGE: std::ops::RangeInclusive<f32> = -100.0..=600.0;
/// GeoTIFF tags: ModelPixelScale, ModelTiepoint, ModelTransformation,
/// GeoKeyDirectory, GeoDoubleParams, GeoAsciiParams.
const GEOTIFF_TAGS: [u16; 6] = [33550, 33922, 34264, 34735, 34736, 34737];

fn tiff_decoder(bytes: &[u8]) -> Result<tiff::decoder::Decoder<std::io::Cursor<&[u8]>>, String> {
    tiff::decoder::Decoder::new(std::io::Cursor::new(bytes)).map_err(|e| format!("Could not open TIFF: {e}"))
}

/// True when the TIFF carries georeferencing (an orthomosaic or DEM export),
/// which a camera frame never does.
pub fn is_georeferenced_tiff(bytes: &[u8]) -> bool {
    let Ok(mut decoder) = tiff_decoder(bytes) else { return false };
    GEOTIFF_TAGS
        .iter()
        .any(|&t| matches!(decoder.find_tag(tiff::tags::Tag::Unknown(t)), Ok(Some(_))))
}

/// Cheap check before decoding: a single-sample raster no larger than a
/// thermal camera frame, without georeferencing.
pub fn looks_like_thermal_frame(bytes: &[u8]) -> bool {
    if is_georeferenced_tiff(bytes) {
        return false;
    }
    let Ok(mut decoder) = tiff_decoder(bytes) else { return false };
    let Ok((w, h)) = decoder.dimensions() else { return false };
    if w == 0 || h == 0 || w.max(h) > MAX_FRAME_EDGE {
        return false;
    }
    let samples = decoder
        .find_tag(tiff::tags::Tag::SamplesPerPixel)
        .ok()
        .flatten()
        .and_then(|v| v.into_u16().ok())
        .unwrap_or(1);
    samples == 1
}

fn finite_stats(values: &[f32]) -> Option<(f32, f32, f32)> {
    let mut v: Vec<f32> = values.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some((v[0], v[v.len() / 2], v[v.len() - 1]))
}

/// Interpret float values as °C or kelvin. Kelvin is only assumed on an
/// explicit import, for values that all sit in 150..500 K around a room-ish
/// median; an auto-detected file must already read as °C.
fn celsius_from_floats(values: Vec<f32>, origin: Origin, what: &str) -> Result<(Vec<f32>, bool), String> {
    let (min, med, max) = finite_stats(&values).ok_or_else(|| format!("The {what} has no finite values"))?;
    let kelvin = origin == Origin::Explicit && min > 150.0 && max < 500.0 && med > 250.0;
    if kelvin {
        return Ok((values.into_iter().map(|v| v - 273.15).collect(), true));
    }
    let plausible = CELSIUS_RANGE.contains(&min) && CELSIUS_RANGE.contains(&max) && med < 150.0;
    if !plausible {
        return Err(format!(
            "The {what}'s values ({min:.1}..{max:.1}, median {med:.1}) do not read as temperatures in °C{}",
            if origin == Origin::Explicit { " or kelvin" } else { "" }
        ));
    }
    Ok((values, false))
}

/// Decode a radiometric TIFF into °C.
pub fn read_radiometric_tiff(bytes: &[u8], origin: Origin) -> Result<TemperatureGrid, String> {
    let stack = multispectral::read_bands(bytes)?;
    if stack.bands.len() != 1 {
        return Err(format!(
            "A radiometric TIFF has one band of temperatures; this file has {}",
            stack.bands.len()
        ));
    }
    if stack.width.max(stack.height) > MAX_FRAME_EDGE {
        return Err(format!(
            "{}×{} is larger than a thermal camera frame — radiometric TIFFs are single frames",
            stack.width, stack.height
        ));
    }
    let values = stack.bands.into_iter().next().unwrap();
    let (temps, format, note): (Vec<f32>, &'static str, String) = match stack.bits_per_sample {
        32 => {
            let (temps, kelvin) = celsius_from_floats(values, origin, "TIFF")?;
            (
                temps,
                "float_tiff",
                if kelvin { "32-bit float samples in kelvin, converted to °C".into() } else { "32-bit float samples in °C".into() },
            )
        }
        bits => {
            // Autel 640T: integer samples in tenths of a kelvin (2960 → 22.9 °C).
            // Raw sensor counts (FLIR Vue/Boson TIFF mode sits near 7000–9000)
            // fall outside the window and are refused.
            let (_, med, _) = finite_stats(&values).ok_or("The TIFF has no finite values")?;
            if !AUTEL_TENTHS_K.contains(&med) {
                return Err(format!(
                    "The TIFF's values (median {med:.0}) are not temperatures in tenths of a kelvin \
                     (Autel radiometric TIFF) — export a radiometric TIFF or a temperature CSV from the \
                     camera's analysis tool"
                ));
            }
            (
                values.iter().map(|v| v * 0.1 - 273.15).collect(),
                "autel_tiff",
                format!("{bits}-bit samples in tenths of a kelvin (value × 0.1 − 273.15)"),
            )
        }
    };
    Ok(TemperatureGrid { width: stack.width, height: stack.height, temps, format, note })
}

/// Rows that are a column index (0,1,2… or 1,2,3…) are headers, never data.
fn is_index_row(row: &[f32]) -> bool {
    row.len() >= 2
        && (row.iter().enumerate().all(|(i, &v)| v == i as f32)
            || row.iter().enumerate().all(|(i, &v)| v == (i + 1) as f32))
}

/// The delimiter most lines of numbers use.
fn detect_delimiter(text: &str) -> char {
    let numeric_cells = |line: &str, d: char| {
        line.split(d)
            .filter(|c| c.trim().trim_matches('"').replace(',', ".").parse::<f32>().is_ok())
            .count()
    };
    let mut best = (',', 0usize);
    for d in [';', '\t', ','] {
        let lines = text.lines().filter(|l| numeric_cells(l, d) >= 4).count();
        if lines > best.1 {
            best = (d, lines);
        }
    }
    best.0
}

/// Parse a per-pixel temperature matrix exported as CSV. Header lines, a
/// row label, a leading row-index column and a column-index row are
/// dropped, decimal commas are accepted with `;` or tab delimiters, cells
/// that are not numbers become NaN, and (on an explicit import) kelvin is
/// converted to °C.
pub fn parse_temperature_csv(text: &str, origin: Origin) -> Result<TemperatureGrid, String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let delimiter = detect_delimiter(text);
    let decimal_comma = delimiter != ',';
    let parse_cell = |c: &str| {
        let c = c.trim().trim_matches('"');
        let c = if decimal_comma { c.replace(',', ".") } else { c.to_string() };
        c.parse::<f32>().ok()
    };

    let mut rows: Vec<Vec<f32>> = Vec::new();
    for line in text.lines() {
        let cells: Vec<Option<f32>> = line.split(delimiter).map(parse_cell).collect();
        // Everything before the first number is a label ("Row 12", or an
        // empty corner cell); from there on a non-number is a missing value
        let Some(start) = cells.iter().position(|c| c.is_some()) else { continue };
        let row: Vec<f32> = cells[start..].iter().map(|c| c.unwrap_or(f32::NAN)).collect();
        if row.len() >= 2 && !is_index_row(&row) {
            rows.push(row);
        }
    }
    if rows.len() < 2 {
        return Err("No temperature rows found — the CSV should hold one row of values per image row".to_string());
    }

    // The image width is the common row length; short footer lines (totals,
    // statistics) are dropped, slightly short rows are padded with NaN
    let mut counts = std::collections::HashMap::new();
    for r in &rows {
        *counts.entry(r.len()).or_insert(0usize) += 1;
    }
    let width = counts.into_iter().max_by_key(|(len, n)| (*n, *len)).map(|(len, _)| len).unwrap();
    rows.retain(|r| r.len() * 2 >= width);
    for r in &mut rows {
        r.resize(width, f32::NAN);
    }
    // A trailing delimiter on every line leaves an all-NaN last column
    let mut width = width;
    while width > 1 && rows.iter().all(|r| r[width - 1].is_nan()) {
        width -= 1;
        for r in &mut rows {
            r.truncate(width);
        }
    }
    // A leading index column counts the rows from 0 or 1
    let indexed = width > 2 && rows.iter().enumerate().all(|(i, r)| r[0] == i as f32 || r[0] == (i + 1) as f32);
    let width = if indexed { width - 1 } else { width };

    let (min_w, min_h) = if origin == Origin::Explicit { MIN_EXPLICIT } else { MIN_AUTO };
    if width < min_w || rows.len() < min_h || width > MAX_FRAME_EDGE as usize || rows.len() > MAX_FRAME_EDGE as usize {
        return Err(format!(
            "A {}×{} matrix is not a thermal frame (expected at least {min_w}×{min_h} and at most {MAX_FRAME_EDGE}×{MAX_FRAME_EDGE} values)",
            width,
            rows.len()
        ));
    }
    let mut temps: Vec<f32> = Vec::with_capacity(width * rows.len());
    for r in &rows {
        temps.extend_from_slice(if indexed { &r[1..] } else { &r[..] });
    }
    let (temps, kelvin) = celsius_from_floats(temps, origin, "matrix")?;
    let note = format!(
        "{width}×{} values{}{}",
        rows.len(),
        if indexed { ", leading row-index column dropped" } else { "" },
        if kelvin { ", kelvin converted to °C" } else { "" }
    );
    Ok(TemperatureGrid { width: width as u32, height: rows.len() as u32, temps, format: "temperature_csv", note })
}

/// The Iron Red ramp (the studio's default palette) for the preview.
fn iron(t: f32) -> [u8; 3] {
    const STOPS: [(f32, [f32; 3]); 7] = [
        (0.0, [0.0, 0.0, 20.0]),
        (0.15, [32.0, 0.0, 100.0]),
        (0.35, [130.0, 10.0, 120.0]),
        (0.55, [200.0, 60.0, 50.0]),
        (0.75, [245.0, 145.0, 20.0]),
        (0.9, [255.0, 220.0, 60.0]),
        (1.0, [255.0, 255.0, 230.0]),
    ];
    let t = t.clamp(0.0, 1.0);
    let mut lo = STOPS[0];
    let mut hi = STOPS[STOPS.len() - 1];
    for w in STOPS.windows(2) {
        if t >= w[0].0 && t <= w[1].0 {
            lo = w[0];
            hi = w[1];
            break;
        }
    }
    let f = if hi.0 > lo.0 { (t - lo.0) / (hi.0 - lo.0) } else { 0.0 };
    let mix = |i: usize| (lo.1[i] + (hi.1[i] - lo.1[i]) * f).round() as u8;
    [mix(0), mix(1), mix(2)]
}

/// Write a palette-rendered PNG preview of the grid next to the asset.
/// Returns the preview file name; nothing is left behind on failure.
pub fn write_preview(grid: &TemperatureGrid, dest_dir: &std::path::Path, base_name: &str) -> Result<String, String> {
    let (mut mn, mut mx) = (f32::INFINITY, f32::NEG_INFINITY);
    for &t in &grid.temps {
        if t.is_finite() {
            mn = mn.min(t);
            mx = mx.max(t);
        }
    }
    if !mn.is_finite() {
        return Err("The temperature grid has no finite values".to_string());
    }
    let span = (mx - mn).max(0.1);
    let mut buf = Vec::with_capacity(grid.temps.len() * 4);
    for &t in &grid.temps {
        if t.is_finite() {
            let [r, g, b] = iron((t - mn) / span);
            buf.extend_from_slice(&[r, g, b, 255]);
        } else {
            buf.extend_from_slice(&[0, 0, 0, 0]);
        }
    }
    let img = image::RgbaImage::from_raw(grid.width, grid.height, buf).ok_or("Preview buffer size mismatch")?;
    let name = format!("{base_name}_preview.png");
    let path = dest_dir.join(&name);
    if let Err(e) = img.save_with_format(&path, image::ImageFormat::Png) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("Could not write the preview PNG: {e}"));
    }
    Ok(name)
}

/// The f32 raster sidecar the analysis pipeline reads (little-endian).
pub fn raster_bytes(grid: &TemperatureGrid) -> Vec<u8> {
    let mut raw = Vec::with_capacity(grid.temps.len() * 4);
    for t in &grid.temps {
        raw.extend_from_slice(&t.to_le_bytes());
    }
    raw
}

#[cfg(test)]
mod tests {
    use super::*;

    fn luma16_tiff(width: u32, height: u32, values: Vec<u16>) -> Vec<u8> {
        let buf = image::ImageBuffer::<image::Luma<u16>, Vec<u16>>::from_raw(width, height, values).unwrap();
        let mut out = Vec::new();
        image::DynamicImage::ImageLuma16(buf)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Tiff)
            .unwrap();
        out
    }

    /// A matrix as CSV: `rows` of `cols` values, optional prefix per line.
    fn matrix_csv(rows: usize, cols: usize, value: impl Fn(usize, usize) -> f32, delimiter: &str, prefix: impl Fn(usize) -> String) -> String {
        let mut text = String::new();
        for r in 0..rows {
            let cells: Vec<String> = (0..cols).map(|c| format!("{:.2}", value(r, c))).collect();
            text.push_str(&prefix(r));
            text.push_str(&cells.join(delimiter));
            text.push('\n');
        }
        text
    }

    #[test]
    fn autel_tiff_values_are_tenths_of_a_kelvin() {
        let (w, h) = (32u32, 24u32);
        let values: Vec<u16> = (0..w * h).map(|i| 2_960 + (i % 125) as u16).collect();
        let tiff = luma16_tiff(w, h, values);
        assert!(looks_like_thermal_frame(&tiff));
        assert!(!is_georeferenced_tiff(&tiff));
        let grid = read_radiometric_tiff(&tiff, Origin::AutoDetected).unwrap();
        assert_eq!((grid.width, grid.height), (32, 24));
        assert_eq!(grid.format, "autel_tiff");
        assert!((grid.temps[0] - (296.0 - 273.15)).abs() < 0.01);
        assert!((grid.temps[124] - (308.4 - 273.15)).abs() < 0.01);
    }

    #[test]
    fn raw_counts_and_masks_are_not_autel_temperatures() {
        // FLIR Vue/Boson TIFF mode: 14-bit counts around 8000
        let counts = luma16_tiff(64, 48, (0..64 * 48).map(|i| 7_800 + (i % 400) as u16).collect());
        assert!(read_radiometric_tiff(&counts, Origin::Explicit).is_err());
        // An 8-bit-range mask
        let mask = luma16_tiff(16, 16, vec![200u16; 256]);
        assert!(read_radiometric_tiff(&mask, Origin::AutoDetected).is_err());
    }

    #[test]
    fn csv_matrix_with_header_index_column_and_gaps() {
        let (cols, rows) = (40usize, 30usize);
        let header: Vec<String> = (0..cols).map(|c| c.to_string()).collect();
        let mut text = format!("\u{FEFF}Frame 1 exported from Thermal Studio\n,{}\n", header.join(","));
        for row in 0..rows {
            let cells: Vec<String> = (0..cols)
                .map(|c| if row == 3 && c == 4 { String::new() } else { format!("{:.2}", 20.0 + row as f32 + c as f32 * 0.1) })
                .collect();
            text.push_str(&format!("{row},{}\n", cells.join(",")));
        }
        text.push_str("Average,21.3\n");
        let grid = parse_temperature_csv(&text, Origin::Explicit).unwrap();
        assert_eq!((grid.width, grid.height), (cols as u32, rows as u32));
        assert_eq!(grid.format, "temperature_csv");
        assert!(grid.note.contains("row-index column dropped"));
        assert!((grid.temps[0] - 20.0).abs() < 1e-4);
        assert!(grid.temps[3 * cols + 4].is_nan(), "an empty cell is a missing value, not a shifted row");
        assert!((grid.temps[3 * cols + 5] - 23.5).abs() < 1e-3);
        assert!((grid.temps[cols * (rows - 1) + cols - 1] - (20.0 + 29.0 + 3.9)).abs() < 1e-3);
    }

    #[test]
    fn csv_with_semicolons_decimal_commas_and_kelvin() {
        let text = matrix_csv(40, 40, |r, c| 293.0 + r as f32 + c as f32 * 0.01, ";", |_| String::new()).replace('.', ",");
        let grid = parse_temperature_csv(&text, Origin::Explicit).unwrap();
        assert_eq!((grid.width, grid.height), (40, 40));
        assert!(grid.note.contains("kelvin"));
        assert!((grid.temps[0] - (293.0 - 273.15)).abs() < 1e-3);
        // The same file is not auto-detected as a thermal frame: kelvin needs the user's word
        assert!(parse_temperature_csv(&text, Origin::AutoDetected).is_err());
    }

    #[test]
    fn delimiter_comes_from_the_data_rows_not_a_header() {
        let mut text = String::from("Emissivity: 0.95; Distance: 1.0 m; Reflected: 20.0\n");
        text.push_str(&matrix_csv(50, 64, |r, c| 15.0 + (r + c) as f32 * 0.05, ",", |r| format!("Row {r},")));
        let grid = parse_temperature_csv(&text, Origin::AutoDetected).unwrap();
        assert_eq!((grid.width, grid.height), (64, 50));
        assert!((grid.temps[0] - 15.0).abs() < 1e-4);
    }

    #[test]
    fn tables_that_are_not_frames_are_refused() {
        assert!(parse_temperature_csv("label,x,y\n#Label,Longitude,Latitude\nDJI_0001,-85.2,41.1\n", Origin::Explicit).is_err());
        // A mission/reference table: numeric, but far too narrow for a frame
        let table = matrix_csv(12, 10, |r, c| r as f32 * 10.0 + c as f32, ",", |r| format!("{},", 100 + r));
        assert!(parse_temperature_csv(&table, Origin::AutoDetected).is_err());
        // Explicit imports accept small crops, but not tables below 32×24
        assert!(parse_temperature_csv(&table, Origin::Explicit).is_err());
        let crop = matrix_csv(24, 32, |r, c| 20.0 + (r + c) as f32 * 0.1, ",", |_| String::new());
        assert!(parse_temperature_csv(&crop, Origin::Explicit).is_ok());
    }

    #[test]
    fn preview_and_raster_are_written() {
        let grid = TemperatureGrid {
            width: 4,
            height: 2,
            temps: vec![10.0, 20.0, 30.0, f32::NAN, 15.0, 25.0, 35.0, 40.0],
            format: "temperature_csv",
            note: String::new(),
        };
        let dir = tempfile::tempdir().unwrap();
        let name = write_preview(&grid, dir.path(), "7").unwrap();
        assert_eq!(name, "7_preview.png");
        let png = image::open(dir.path().join(&name)).unwrap().to_rgba8();
        assert_eq!(png.dimensions(), (4, 2));
        assert_eq!(png.get_pixel(3, 0).0[3], 0, "NaN stays transparent");
        assert_eq!(png.get_pixel(3, 1).0, [255, 255, 230, 255], "the maximum is the top of the ramp");
        assert_eq!(raster_bytes(&grid).len(), 32);
    }
}
