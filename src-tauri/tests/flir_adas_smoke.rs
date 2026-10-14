//! Smoke test of the thermal add-on's commands over real Teledyne FLIR
//! imagery: the free FLIR ADAS v2 dataset (Tau 2 640×512 frames as 8-bit AGC
//! JPEGs plus 16-bit T-linear TIFFs, with matching RGB frames) and, when one is
//! available, a FLIR R-JPEG.
//!
//! The test is skipped unless `ODL_FLIR_ADAS_DIR` names the extracted dataset
//! folder (the one holding `images_thermal_val`). `ODL_FLIR_SAMPLE` may point at
//! a FLIR R-JPEG; `ODL_SMOKE_OUT` receives the °C files generated from the
//! T-linear frames (ready to drag into the studio) plus a Markdown results
//! table. PowerShell:
//!
//! ```text
//! $env:ODL_FLIR_ADAS_DIR = "D:\Thermal_Photos\FLIR_DATASET"
//! $env:ODL_SMOKE_OUT = "D:\Thermal_Photos\smoke_samples"
//! cargo test --test flir_adas_smoke -- --nocapture
//! ```
//!
//! Every command the Thermal Studio invokes runs through the real command
//! functions against a throwaway profile. Two are out of reach: the raw-body
//! import (`thermal_import_asset_raw` only unwraps the IPC body before the
//! shared import) and the AI generation calls, which need a vendor key and the
//! network — those are checked to refuse cleanly without a key.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeResponseBody, IpcResponse};
use tauri::{Manager, State};

use drone_logbook_lib::thermal::analysis::AnomalyOptions;
use drone_logbook_lib::thermal::bundle::{thermal_export_bundle, thermal_import_bundle};
use drone_logbook_lib::thermal::commands::*;
use drone_logbook_lib::thermal::multispectral;
use drone_logbook_lib::thermal::network::{
    Conductor, ConductorKind, NetworkNode, NodeKind, PropValue, SolveOptions, ThermalNetwork,
};
use drone_logbook_lib::thermal::sdk::MeasureOverrides;
use drone_logbook_lib::thermal::ThermalAsset;
use drone_logbook_lib::{AppState, Database};

/// FLIR Tau 2 in T-linear mode, high gain: 14-bit counts in units of 0.04 K.
const TLINEAR_K_PER_COUNT: f32 = 0.04;

// ---------------------------------------------------------------- results log

struct Row {
    function: String,
    input: String,
    pass: bool,
    outcome: String,
}

#[derive(Default)]
struct Log {
    rows: Vec<Row>,
}

impl Log {
    fn record(&mut self, function: &str, input: &str, pass: bool, outcome: impl Into<String>) {
        let outcome = outcome.into();
        println!("{} {function} [{input}] {outcome}", if pass { "PASS" } else { "FAIL" });
        self.rows.push(Row { function: function.into(), input: input.into(), pass, outcome });
    }

    fn check(&mut self, function: &str, input: &str, pass: bool, outcome: impl Into<String>) -> bool {
        self.record(function, input, pass, outcome);
        pass
    }

    /// Expect success; the value is described in the log and returned.
    fn ok<T, E: std::fmt::Display>(
        &mut self,
        function: &str,
        input: &str,
        result: Result<T, E>,
        describe: impl FnOnce(&T) -> String,
    ) -> Option<T> {
        match result {
            Ok(v) => {
                let d = describe(&v);
                self.record(function, input, true, d);
                Some(v)
            }
            Err(e) => {
                self.record(function, input, false, format!("unexpected error: {e}"));
                None
            }
        }
    }

    /// Expect a refusal whose message mentions `needle`.
    fn err<T, E: std::fmt::Display>(&mut self, function: &str, input: &str, result: Result<T, E>, needle: &str) {
        match result {
            Ok(_) => self.record(
                function,
                input,
                false,
                format!("accepted, but a refusal mentioning “{needle}” was expected"),
            ),
            Err(e) => {
                let msg = e.to_string();
                let hit = msg.to_lowercase().contains(&needle.to_lowercase());
                self.record(function, input, hit, format!("refused: {msg}"));
            }
        }
    }

    fn failures(&self) -> usize {
        self.rows.iter().filter(|r| !r.pass).count()
    }

    fn markdown(&self, preamble: &[String]) -> String {
        let esc = |s: &str| s.replace('|', "\\|").replace('\n', " ");
        let mut md = String::from("# Thermal add-on smoke test — FLIR ADAS v2\n\n");
        for line in preamble {
            md.push_str(line);
            md.push('\n');
        }
        md.push_str(&format!(
            "\n**{} checks, {} failed.**\n\n| # | Command / function | Input | Result | Outcome |\n|---|---|---|---|---|\n",
            self.rows.len(),
            self.failures()
        ));
        for (i, r) in self.rows.iter().enumerate() {
            md.push_str(&format!(
                "| {} | `{}` | {} | {} | {} |\n",
                i + 1,
                esc(&r.function),
                esc(&r.input),
                if r.pass { "✅ pass" } else { "❌ FAIL" },
                esc(&r.outcome)
            ));
        }
        md
    }
}

// ------------------------------------------------------------------- harness

/// A throwaway profile behind the real `AppState`, driven through Tauri's mock
/// runtime so the command functions take their usual `State` argument.
struct Harness {
    dir: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp data dir");
        let db = Database::new(dir.path().to_path_buf(), "default").expect("open DuckDB");
        let app = tauri::test::mock_app();
        app.manage(AppState::new_unlocked(db, dir.path().to_path_buf()));
        Harness { dir, app }
    }

    fn state(&self) -> State<'_, AppState> {
        self.app.state::<AppState>()
    }
}

// ------------------------------------------------------------------- helpers

fn sorted_files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case(ext))
                .unwrap_or(false)
        })
        .collect();
    v.sort();
    v
}

fn pick(dir: &Path, ext: &str, n: usize) -> PathBuf {
    sorted_files(dir, ext)
        .get(n)
        .cloned()
        .unwrap_or_else(|| panic!("no .{ext} file #{n} in {}", dir.display()))
}

fn file_name(p: &Path) -> String {
    p.file_name().and_then(|s| s.to_str()).unwrap_or("?").to_string()
}

fn stem(p: &Path) -> String {
    p.file_stem().and_then(|s| s.to_str()).unwrap_or("frame").to_string()
}

fn tiff_bits(path: &Path) -> Option<u16> {
    let bytes = std::fs::read(path).ok()?;
    let mut d = tiff::decoder::Decoder::new(std::io::Cursor::new(bytes.as_slice())).ok()?;
    d.find_tag(tiff::tags::Tag::BitsPerSample).ok().flatten().and_then(|v| v.into_u16().ok())
}

/// The dataset's video split mixes 8- and 16-bit TIFFs; find one with `bits`.
fn find_tiff_with_bits(dir: &Path, bits: u16, limit: usize) -> Option<PathBuf> {
    sorted_files(dir, "tiff").into_iter().take(limit).find(|p| tiff_bits(p) == Some(bits))
}

/// Decode a T-linear frame to °C (through the app's own TIFF reader).
fn tlinear_celsius(bytes: &[u8]) -> Result<(u32, u32, Vec<f32>), String> {
    let stack = multispectral::read_bands(bytes)?;
    if stack.bands.len() != 1 {
        return Err(format!("expected one band, found {}", stack.bands.len()));
    }
    let temps = stack.bands[0].iter().map(|&c| c * TLINEAR_K_PER_COUNT - 273.15).collect();
    Ok((stack.width, stack.height, temps))
}

fn float_tiff(w: u32, h: u32, values: &[f32]) -> Vec<u8> {
    let mut cur = std::io::Cursor::new(Vec::new());
    {
        let mut enc = tiff::encoder::TiffEncoder::new(&mut cur).expect("tiff encoder");
        enc.write_image::<tiff::encoder::colortype::Gray32Float>(w, h, values).expect("write float tiff");
    }
    cur.into_inner()
}

fn csv_text(w: u32, values: &[f32], sep: char) -> String {
    let mut s = String::with_capacity(values.len() * 7);
    for row in values.chunks(w as usize) {
        let cells: Vec<String> = row.iter().map(|v| format!("{v:.2}")).collect();
        s.push_str(&cells.join(&sep.to_string()));
        s.push('\n');
    }
    s
}

fn min_max_mean(v: &[f32]) -> (f32, f32, f32) {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut sum = 0f64;
    for &x in v {
        min = min.min(x);
        max = max.max(x);
        sum += x as f64;
    }
    (min, max, (sum / v.len().max(1) as f64) as f32)
}

fn meta_of(a: &ThermalAsset) -> serde_json::Value {
    a.meta_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn body_bytes(r: tauri::ipc::Response) -> Vec<u8> {
    match r.body().expect("ipc body") {
        InvokeResponseBody::Raw(b) => b,
        InvokeResponseBody::Json(s) => s.into_bytes(),
    }
}

fn describe_asset(a: &ThermalAsset) -> String {
    let m = meta_of(a);
    let rad = m.get("radiometric").map(|r| r.to_string()).unwrap_or_default();
    let kind = m.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    format!(
        "id {} · {}/{} · radiometric={} · {}×{}{}{}{}",
        a.id,
        a.source,
        a.asset_type,
        a.is_radiometric,
        a.width,
        a.height,
        if kind.is_empty() { String::new() } else { format!(" · kind={kind}") },
        if rad.is_empty() { String::new() } else { format!(" · {rad}") },
        if m.get("previewFile").is_some() { " · preview" } else { "" }
    )
}

fn radiometric_format(a: &ThermalAsset) -> String {
    meta_of(a)["radiometric"]["format"].as_str().unwrap_or("").to_string()
}

/// A sidecar named in the asset's metadata (`previewFile`, `rasterFile`), next to the stored file.
fn sidecar_path(key: &str, a: &ThermalAsset) -> Option<PathBuf> {
    let meta = meta_of(a);
    let file = meta[key].as_str()?;
    Some(Path::new(&a.stored_path).parent()?.join(file))
}

fn sidecars_exist(a: &ThermalAsset) -> (bool, bool) {
    (
        sidecar_path("rasterFile", a).map(|p| p.exists()).unwrap_or(false),
        sidecar_path("previewFile", a).map(|p| p.exists()).unwrap_or(false),
    )
}

fn near(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol
}

fn node(id: &str, kind: NodeKind, t: f64) -> NetworkNode {
    NetworkNode {
        id: id.into(),
        label: String::new(),
        x: 0.0,
        y: 0.0,
        kind,
        initial_temp_c: t,
        mcp: None,
        source: None,
        boundary_temp_c: None,
    }
}

fn conductor(id: &str, from: &str, to: &str, g: f64) -> Conductor {
    Conductor {
        id: id.into(),
        label: String::new(),
        from: from.into(),
        to: to.into(),
        kind: ConductorKind::Linear,
        value: PropValue::Constant { value: g },
    }
}

/// A radiometric asset under test, with the °C values its file was made from.
struct Sample {
    label: &'static str,
    asset: ThermalAsset,
    bytes: Vec<u8>,
    expected: Vec<f32>,
    /// Tolerance on min/max against the source values (CSV cells carry 2 decimals).
    tol: f32,
}

// -------------------------------------------------------------------- the test

#[tokio::test]
async fn flir_adas_smoke() {
    let Some(root) = std::env::var_os("ODL_FLIR_ADAS_DIR").map(PathBuf::from) else {
        println!("flir_adas_smoke skipped: set ODL_FLIR_ADAS_DIR to the extracted FLIR ADAS v2 folder");
        return;
    };
    let out = std::env::var_os("ODL_SMOKE_OUT").map(PathBuf::from);
    if let Some(o) = &out {
        std::fs::create_dir_all(o).expect("create ODL_SMOKE_OUT");
    }
    let save = |name: &str, bytes: &[u8]| {
        if let Some(o) = &out {
            std::fs::write(o.join(name), bytes).expect("write sample file");
        }
    };

    let mut log = Log::default();
    let h = Harness::new();

    // ---- inputs from the dataset
    let thermal_dir = root.join("images_thermal_val").join("data");
    let raw_dir = root.join("images_thermal_val").join("analyticsData");
    let rgb_dir = root.join("images_rgb_val").join("data");
    let video_raw_dir = root.join("video_thermal_test").join("analyticsData");

    let thermal_jpg = pick(&thermal_dir, "jpg", 0);
    let thermal_jpg2 = pick(&thermal_dir, "jpg", 1);
    let rgb_jpg = pick(&rgb_dir, "jpg", 0);
    let rgb_jpg2 = pick(&rgb_dir, "jpg", 1);
    let raw = [pick(&raw_dir, "tiff", 0), pick(&raw_dir, "tiff", 1), pick(&raw_dir, "tiff", 2), pick(&raw_dir, "tiff", 3)];
    let tiff8 = find_tiff_with_bits(&video_raw_dir, 8, 3000);
    for (p, label) in [
        (&thermal_jpg, "thermal_8bit"),
        (&rgb_jpg, "rgb"),
        (&raw[0], "tlinear_raw"),
    ] {
        save(&format!("source_{label}_{}", file_name(p)), &std::fs::read(p).unwrap());
    }

    // ---- 1. SDK status
    let sdk = thermal_sdk_status().await.unwrap();
    log.record(
        "thermal_sdk_status",
        "—",
        true,
        format!(
            "DJI SDK available={} dir={:?} error={:?} (not needed for FLIR/TIFF/CSV)",
            sdk.available, sdk.sdk_dir, sdk.error
        ),
    );

    // ---- 2. 8-bit AGC thermal JPEG: a plain picture, not radiometric
    let jpg_asset = log.ok(
        "thermal_import_asset",
        &format!("ADAS 8-bit thermal JPEG {}", file_name(&thermal_jpg)),
        thermal_import_asset(thermal_jpg.to_string_lossy().into(), None, h.state()).await,
        describe_asset,
    );
    if let Some(a) = &jpg_asset {
        log.check(
            "thermal_import_asset",
            "8-bit JPEG classification",
            a.source == "thermal" && a.asset_type == "image" && !a.is_radiometric,
            format!("source={} type={} radiometric={}", a.source, a.asset_type, a.is_radiometric),
        );
        log.err("thermal_analyze", "8-bit JPEG (no radiometric data)", thermal_analyze(a.id, None, h.state()).await, "");
        log.err(
            "thermal_detect_anomalies",
            "8-bit JPEG (no radiometric data)",
            thermal_detect_anomalies(a.id, None, None, h.state()).await,
            "",
        );
        let preview = thermal_read_asset_preview(a.id, h.state()).await.map(body_bytes);
        log.ok("thermal_read_asset_preview", "8-bit JPEG", preview, |b| {
            format!("{} bytes, JPEG={}", b.len(), b.starts_with(&[0xFF, 0xD8]))
        });
    }
    // An R-JPEG probe on a JPEG without radiometric data imports it as a plain picture
    let plain_explicit = thermal_import_asset(thermal_jpg2.to_string_lossy().into(), Some("radiometric".into()), h.state()).await;
    log.ok("thermal_import_asset", "8-bit JPEG with source=radiometric", plain_explicit, |a| {
        format!("{} — note: no warning that the JPEG carries no temperatures", describe_asset(a))
    });

    // ---- 3. RGB frames: visual pictures, dedupe, photogrammetry library, bad source
    let rgb_bytes = std::fs::read(&rgb_jpg).unwrap();
    log.ok(
        "thermal_import_asset_bytes",
        &format!("ADAS RGB JPEG {}", file_name(&rgb_jpg)),
        thermal_import_asset_bytes(file_name(&rgb_jpg), rgb_bytes.clone(), None, h.state()).await,
        describe_asset,
    );
    log.err(
        "thermal_import_asset_bytes",
        "same RGB JPEG again",
        thermal_import_asset_bytes(file_name(&rgb_jpg), rgb_bytes.clone(), None, h.state()).await,
        "already imported",
    );
    let rgb2_bytes = std::fs::read(&rgb_jpg2).unwrap();
    log.ok(
        "thermal_import_asset_bytes",
        "RGB JPEG with source=photogrammetry",
        thermal_import_asset_bytes(file_name(&rgb_jpg2), rgb2_bytes.clone(), Some("photogrammetry".into()), h.state()).await,
        |a| format!("{} (expected source photogrammetry: {})", describe_asset(a), a.source == "photogrammetry"),
    );
    log.err(
        "thermal_import_asset_bytes",
        "source=bogus",
        thermal_import_asset_bytes("x.jpg".into(), rgb2_bytes.clone(), Some("bogus".into()), h.state()).await,
        "Unknown asset source",
    );
    log.err(
        "thermal_import_asset_bytes",
        "unsupported extension .xyz",
        thermal_import_asset_bytes("frame.xyz".into(), rgb2_bytes.clone(), None, h.state()).await,
        "Unsupported file type",
    );
    log.err(
        "thermal_import_asset",
        "missing path",
        thermal_import_asset(root.join("does-not-exist.jpg").to_string_lossy().into(), None, h.state()).await,
        "File not found",
    );

    // ---- 4. Raw 16-bit T-linear TIFFs: counts, not temperatures
    let raw_bytes: Vec<Vec<u8>> = raw.iter().map(|p| std::fs::read(p).unwrap()).collect();
    let raw_asset = log.ok(
        "thermal_import_asset",
        &format!("16-bit T-linear TIFF {} (general import)", file_name(&raw[0])),
        thermal_import_asset(raw[0].to_string_lossy().into(), None, h.state()).await,
        describe_asset,
    );
    if let Some(a) = &raw_asset {
        let m = meta_of(a);
        let (_, preview) = sidecars_exist(a);
        log.check(
            "thermal_import_asset",
            "raw TIFF filed as Metashape export, not as temperatures",
            a.source == "metashape" && !a.is_radiometric,
            format!(
                "source={} kind={} preview={} previewError={}",
                a.source,
                m["kind"].as_str().unwrap_or("?"),
                preview,
                m["previewError"].as_str().unwrap_or("none")
            ),
        );
    }
    log.err(
        "thermal_import_asset_bytes",
        &format!("16-bit T-linear TIFF {} with source=radiometric", file_name(&raw[1])),
        thermal_import_asset_bytes(file_name(&raw[1]), raw_bytes[1].clone(), Some("radiometric".into()), h.state()).await,
        "tenths of a kelvin",
    );
    if let Some(p8) = &tiff8 {
        let b8 = std::fs::read(p8).unwrap();
        log.ok(
            "thermal_import_asset_bytes",
            &format!("8-bit AGC TIFF {} (general import)", file_name(p8)),
            thermal_import_asset_bytes(file_name(p8), b8.clone(), None, h.state()).await,
            |a| format!("{} (expected not radiometric: {})", describe_asset(a), !a.is_radiometric),
        );
        let mut b8x = b8.clone();
        b8x.extend_from_slice(b"\0"); // distinct hash for the explicit attempt
        log.err(
            "thermal_import_asset_bytes",
            "8-bit AGC TIFF with source=radiometric",
            thermal_import_asset_bytes(format!("x_{}", file_name(p8)), b8x, Some("radiometric".into()), h.state()).await,
            "tenths of a kelvin",
        );
    } else {
        log.record("thermal_import_asset_bytes", "8-bit AGC TIFF", true, "no 8-bit TIFF found in video_thermal_test — skipped");
    }

    // ---- 5. °C files generated from the T-linear frames
    let mut samples: Vec<Sample> = Vec::new();
    let mut celsius: Vec<(u32, u32, Vec<f32>)> = Vec::new();
    for (i, b) in raw_bytes.iter().enumerate() {
        match tlinear_celsius(b) {
            Ok(c) => {
                let (mn, mx, mean) = min_max_mean(&c.2);
                log.record(
                    "multispectral::read_bands",
                    &format!("decode {} (LZW, predictor)", file_name(&raw[i])),
                    true,
                    format!("{}×{} → T-linear °C: min {mn:.1} max {mx:.1} mean {mean:.1}", c.0, c.1),
                );
                celsius.push(c);
            }
            Err(e) => {
                log.record("multispectral::read_bands", &file_name(&raw[i]), false, format!("decode failed: {e}"));
                celsius.push((0, 0, Vec::new()));
            }
        }
    }
    let frames_ok = celsius.iter().all(|c| !c.2.is_empty());
    if frames_ok {
        let (w, hgt, _) = celsius[0];
        // (a) float TIFF °C through the general importer (auto-detect)
        let name_a = format!("celsius_{}.tif", stem(&raw[2]));
        let tif_a = float_tiff(w, hgt, &celsius[2].2);
        save(&name_a, &tif_a);
        if let Some(a) = log.ok(
            "thermal_import_asset_bytes",
            &format!("{name_a} (32-bit float °C, general import)"),
            thermal_import_asset_bytes(name_a.clone(), tif_a.clone(), None, h.state()).await,
            describe_asset,
        ) {
            samples.push(Sample { label: "float TIFF °C (auto-detected)", asset: a, bytes: tif_a, expected: celsius[2].2.clone(), tol: 1e-3 });
        }
        // (b) float TIFF °C through the explicit radiometric import
        let name_b = format!("celsius_explicit_{}.tif", stem(&raw[3]));
        let tif_b = float_tiff(w, hgt, &celsius[3].2);
        save(&name_b, &tif_b);
        if let Some(a) = log.ok(
            "thermal_import_asset_bytes",
            &format!("{name_b} (32-bit float °C, source=radiometric)"),
            thermal_import_asset_bytes(name_b.clone(), tif_b.clone(), Some("radiometric".into()), h.state()).await,
            describe_asset,
        ) {
            samples.push(Sample { label: "float TIFF °C (explicit)", asset: a, bytes: tif_b, expected: celsius[3].2.clone(), tol: 1e-3 });
        }
        // (c) float TIFF in kelvin: explicit import converts, auto-detect must not take it
        let kelvin: Vec<f32> = celsius[2].2.iter().map(|t| t + 273.15).collect();
        let name_k = format!("kelvin_{}.tif", stem(&raw[2]));
        let tif_k = float_tiff(w, hgt, &kelvin);
        save(&name_k, &tif_k);
        if let Some(a) = log.ok(
            "thermal_import_asset_bytes",
            &format!("{name_k} (32-bit float kelvin, source=radiometric)"),
            thermal_import_asset_bytes(name_k.clone(), tif_k.clone(), Some("radiometric".into()), h.state()).await,
            |a| format!("{} note={}", describe_asset(a), meta_of(a)["radiometric"]["note"]),
        ) {
            samples.push(Sample { label: "float TIFF kelvin (explicit)", asset: a, bytes: tif_k, expected: celsius[2].2.clone(), tol: 1e-3 });
        }
        let mut tif_k2 = float_tiff(w, hgt, &kelvin);
        tif_k2.push(0); // distinct hash
        log.ok(
            "thermal_import_asset_bytes",
            "kelvin float TIFF, general import",
            thermal_import_asset_bytes(format!("k2_{name_k}"), tif_k2, None, h.state()).await,
            |a| format!("{} (expected Metashape fallback, not temperatures: {})", describe_asset(a), a.source == "metashape"),
        );
        // (d) temperature CSV through the general importer (auto-detect)
        let name_c = format!("celsius_{}.csv", stem(&raw[0]));
        let csv_c = csv_text(w, &celsius[0].2, ',').into_bytes();
        save(&name_c, &csv_c);
        if let Some(a) = log.ok(
            "thermal_import_asset_bytes",
            &format!("{name_c} (comma CSV °C, general import)"),
            thermal_import_asset_bytes(name_c.clone(), csv_c.clone(), None, h.state()).await,
            describe_asset,
        ) {
            samples.push(Sample { label: "CSV °C (auto-detected)", asset: a, bytes: csv_c, expected: celsius[0].2.clone(), tol: 0.006 });
        }
        // (e) semicolon-delimited .txt matrix through the explicit import
        let name_t = format!("celsius_{}.txt", stem(&raw[1]));
        let txt = csv_text(w, &celsius[1].2, ';').into_bytes();
        save(&name_t, &txt);
        if let Some(a) = log.ok(
            "thermal_import_asset_bytes",
            &format!("{name_t} (semicolon matrix °C, source=radiometric)"),
            thermal_import_asset_bytes(name_t.clone(), txt.clone(), Some("radiometric".into()), h.state()).await,
            describe_asset,
        ) {
            samples.push(Sample { label: "TXT °C (explicit)", asset: a, bytes: txt, expected: celsius[1].2.clone(), tol: 0.006 });
        }
    }

    // ---- 6. FLIR R-JPEG (Teledyne FLIR camera file), when a sample is available
    let mut flir_asset: Option<ThermalAsset> = None;
    if let Some(p) = std::env::var_os("ODL_FLIR_SAMPLE").map(PathBuf::from).filter(|p| p.exists()) {
        if let Some(a) = log.ok(
            "thermal_import_asset",
            &format!("FLIR R-JPEG {}", file_name(&p)),
            thermal_import_asset(p.to_string_lossy().into(), None, h.state()).await,
            describe_asset,
        ) {
            log.check(
                "thermal_import_asset",
                "R-JPEG recognised as FLIR format",
                a.is_radiometric && radiometric_format(&a) == "flir",
                format!("format={} camera={}", radiometric_format(&a), meta_of(&a)["radiometric"]["camera"]),
            );
            let base = log.ok("thermal_analyze", "R-JPEG, camera parameters", thermal_analyze(a.id, None, h.state()).await, |r| {
                format!(
                    "{}×{} min {:.1} max {:.1} mean {:.1} °C · E={} dist={} RH={}% refl={} amb={}",
                    r.width, r.height, r.stats.min, r.stats.max, r.stats.mean, r.params.emissivity, r.params.distance,
                    r.params.humidity, r.params.reflection, r.params.ambient_temp
                )
            });
            let over = MeasureOverrides {
                distance: Some(2.0),
                humidity: Some(60.0),
                emissivity: Some(0.90),
                reflection: Some(25.0),
                ambient_temp: Some(22.0),
            };
            if let Some(r) = log.ok(
                "thermal_analyze",
                "R-JPEG, overrides E=0.90 d=2 m RH=60% refl=25 amb=22",
                thermal_analyze(a.id, Some(over), h.state()).await,
                |r| {
                    format!(
                        "min {:.1} max {:.1} mean {:.1} °C · echoed E={} dist={} RH={} refl={} amb={}",
                        r.stats.min, r.stats.max, r.stats.mean, r.params.emissivity, r.params.distance, r.params.humidity,
                        r.params.reflection, r.params.ambient_temp
                    )
                },
            ) {
                let echoed = near(r.params.emissivity, 0.90, 1e-4)
                    && near(r.params.distance, 2.0, 1e-4)
                    && near(r.params.humidity, 60.0, 1e-3)
                    && near(r.params.reflection, 25.0, 1e-4)
                    && near(r.params.ambient_temp, 22.0, 1e-4);
                let changed = base.as_ref().map(|b| (b.stats.mean - r.stats.mean).abs() > 0.05).unwrap_or(false);
                log.check(
                    "thermal_analyze",
                    "overrides applied",
                    echoed && changed,
                    format!("parameters echoed={echoed}, temperatures changed={changed}"),
                );
            }
            log.err(
                "thermal_analyze",
                "R-JPEG, emissivity 5.0",
                thermal_analyze(a.id, Some(MeasureOverrides { emissivity: Some(5.0), ..Default::default() }), h.state()).await,
                "emissivity",
            );
            let matrix = thermal_get_temp_matrix(a.id, None, h.state()).await.map(body_bytes);
            log.ok("thermal_get_temp_matrix", "R-JPEG", matrix, |b| {
                let w = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                let hh = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
                format!("{w}×{hh}, {} bytes (expected {})", b.len(), 8 + (w * hh * 4) as usize)
            });
            log.ok("thermal_detect_anomalies", "R-JPEG, defaults", thermal_detect_anomalies(a.id, None, None, h.state()).await, |r| {
                format!("{} regions, baseline {:.1} °C, z {}", r.regions.len(), r.baseline, r.z_threshold)
            });
            let preview = thermal_read_asset_preview(a.id, h.state()).await.map(body_bytes);
            log.ok("thermal_read_asset_preview", "R-JPEG (no sidecar → original JPEG)", preview, |b| {
                format!("{} bytes, JPEG={}", b.len(), b.starts_with(&[0xFF, 0xD8]))
            });
            flir_asset = Some(a);
        }
    } else {
        log.record("thermal_import_asset", "FLIR R-JPEG", true, "ODL_FLIR_SAMPLE not set — skipped");
    }

    // ---- 7. Analysis pipeline over every radiometric sample
    for s in &samples {
        let a = &s.asset;
        let (raster, preview) = sidecars_exist(a);
        // The palette-rendered preview the studio shows for a TIFF/CSV import,
        // kept with the samples (and used by the report-writer smoke test)
        if let (Some(o), Some(p)) = (&out, sidecar_path("previewFile", a)) {
            let _ = std::fs::copy(&p, o.join(format!("preview_{}.png", stem(Path::new(&a.file_name)))));
        }
        let fmt = radiometric_format(a);
        log.check(
            "thermal_import_asset_bytes",
            &format!("{}: metadata + sidecars", s.label),
            a.is_radiometric && raster && preview && a.width == 640 && a.height == 512 && !fmt.is_empty(),
            format!("format={fmt} raster={raster} preview={preview} {}×{}", a.width, a.height),
        );
        let (emn, emx, emean) = min_max_mean(&s.expected);
        if let Some(r) = log.ok("thermal_analyze", s.label, thermal_analyze(a.id, None, h.state()).await, |r| {
            format!(
                "min {:.2} max {:.2} mean {:.2} median {:.2} σ {:.2} °C, hottest at {:?}, {} histogram bins",
                r.stats.min, r.stats.max, r.stats.mean, r.stats.median, r.stats.std_dev, r.stats.max_pos, r.stats.histogram.len()
            )
        }) {
            log.check(
                "thermal_analyze",
                &format!("{}: values match the source", s.label),
                near(r.stats.min, emn, s.tol) && near(r.stats.max, emx, s.tol) && near(r.stats.mean, emean, 0.01),
                format!("expected min {emn:.2} max {emx:.2} mean {emean:.2}; got {:.2}/{:.2}/{:.2}", r.stats.min, r.stats.max, r.stats.mean),
            );
        }
        let matrix = thermal_get_temp_matrix(a.id, None, h.state()).await.map(body_bytes);
        if let Some(b) = log.ok("thermal_get_temp_matrix", s.label, matrix, |b| format!("{} bytes", b.len())) {
            let w = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
            let hh = u32::from_le_bytes([b[4], b[5], b[6], b[7]]) as usize;
            let values: Vec<f32> = b[8..].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            let worst = values
                .iter()
                .zip(&s.expected)
                .map(|(v, e)| (v - e).abs())
                .fold(0f32, f32::max);
            log.check(
                "thermal_get_temp_matrix",
                &format!("{}: matrix equals the source", s.label),
                w == 640 && hh == 512 && values.len() == s.expected.len() && worst <= s.tol,
                format!("{w}×{hh}, {} values, largest difference {worst:.4} °C", values.len()),
            );
        }
        log.ok("thermal_detect_anomalies", &format!("{}: defaults", s.label), thermal_detect_anomalies(a.id, None, None, h.state()).await, |r| {
            let hot = r.regions.iter().filter(|g| g.kind == "hot").count();
            let top = r.regions.first().map(|g| format!("; largest: {} {:.1} °C ΔT {:+.1} {} {}", g.kind, g.t_mean, g.delta_t, g.severity, g.classification)).unwrap_or_default();
            format!("{} regions ({hot} hot), baseline {:.1} °C, σ {:.2}{top}", r.regions.len(), r.baseline, r.std_dev)
        });
        let opts = AnomalyOptions {
            z_threshold: Some(2.5),
            min_region_px: Some(50),
            max_regions: Some(5),
            range_low: Some(-30.0),
            range_high: Some(200.0),
        };
        if let Some(r) = log.ok(
            "thermal_detect_anomalies",
            &format!("{}: z 2.5, ≥50 px, max 5, −30..200 °C", s.label),
            thermal_detect_anomalies(a.id, Some(opts), None, h.state()).await,
            |r| format!("{} regions, z {}", r.regions.len(), r.z_threshold),
        ) {
            log.check(
                "thermal_detect_anomalies",
                &format!("{}: options honoured", s.label),
                r.regions.len() <= 5 && near(r.z_threshold, 2.5, 1e-6) && r.regions.iter().all(|g| g.area_px >= 50),
                format!("{} regions, smallest {} px", r.regions.len(), r.regions.iter().map(|g| g.area_px).min().unwrap_or(0)),
            );
        }
        let preview = thermal_read_asset_preview(a.id, h.state()).await.map(body_bytes);
        log.ok("thermal_read_asset_preview", s.label, preview, |b| {
            format!("{} bytes, PNG={}", b.len(), b.starts_with(&[0x89, b'P', b'N', b'G']))
        });
        let original = thermal_read_asset_file(a.id, h.state()).await.map(body_bytes);
        log.ok("thermal_read_asset_file", s.label, original, |b| {
            format!("{} bytes, identical to the import={}", b.len(), *b == s.bytes)
        });
    }

    // ---- 8. Library bookkeeping on the first sample
    if let Some(s) = samples.first() {
        let a = &s.asset;
        log.ok(
            "thermal_update_asset_notes",
            s.label,
            thermal_update_asset_notes(a.id, Some("Smoke test note".into()), h.state()).await,
            |_| "stored".into(),
        );
        let listed = thermal_list_assets(h.state()).await.unwrap();
        log.check(
            "thermal_list_assets",
            "note persisted",
            listed.iter().any(|x| x.id == a.id && x.notes.as_deref() == Some("Smoke test note")),
            format!("{} assets listed", listed.len()),
        );
        let ext = Path::new(&a.file_name).extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
        if let Some(r) = log.ok(
            "thermal_rename_asset",
            "“Roof east – frame 1” (no extension typed)",
            thermal_rename_asset(a.id, "Roof east – frame 1".into(), h.state()).await,
            |r| format!("display name now “{}”", r.file_name),
        ) {
            log.check(
                "thermal_rename_asset",
                "extension kept",
                r.file_name == format!("Roof east – frame 1.{ext}"),
                format!("“{}” (expected .{ext})", r.file_name),
            );
        }
        log.err("thermal_rename_asset", "“../escape”", thermal_rename_asset(a.id, "../escape".into(), h.state()).await, "");
        log.err("thermal_rename_asset", "empty name", thermal_rename_asset(a.id, "   ".into(), h.state()).await, "");
        let ann = r#"[{"type":"spot","x":120,"y":80,"label":"S1"},{"type":"rect","x":10,"y":10,"w":100,"h":60,"label":"Area 1"}]"#;
        log.ok("thermal_set_annotations", s.label, thermal_set_annotations(a.id, ann.into(), h.state()).await, |_| "stored".into());
        log.ok("thermal_get_annotations", s.label, thermal_get_annotations(a.id, h.state()).await, |r| {
            format!("round trip intact={}", r.as_deref() == Some(ann))
        });
        let net_json = serde_json::to_string(&ThermalNetwork {
            nodes: vec![node("amb", NodeKind::Boundary, 15.0), node("panel", NodeKind::Arithmetic, 40.0)],
            conductors: vec![conductor("h", "panel", "amb", 4.0)],
        })
        .unwrap();
        log.ok("thermal_set_network", s.label, thermal_set_network(a.id, net_json.clone(), h.state()).await, |_| "stored".into());
        log.ok("thermal_get_network", s.label, thermal_get_network(a.id, h.state()).await, |r| {
            format!("round trip intact={}", r.as_deref() == Some(net_json.as_str()))
        });
    }

    // ---- 9. Heat-flow network solver (steady and transient)
    let net = ThermalNetwork {
        nodes: vec![
            node("a", NodeKind::Boundary, 0.0),
            node("x", NodeKind::Arithmetic, 50.0),
            node("b", NodeKind::Boundary, 100.0),
        ],
        conductors: vec![conductor("g1", "a", "x", 1.0), conductor("g2", "x", "b", 3.0)],
    };
    if let Some(r) = log.ok(
        "thermal_solve_network",
        "0 °C —1 W/K— x —3 W/K— 100 °C, steady",
        thermal_solve_network(net.clone(), SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).await,
        |r| format!("converged={} iterations={} nodes={:?}", r.converged, r.iterations, r.node_ids),
    ) {
        let tx = r.balances.iter().find(|b| b.id == "x").map(|b| b.temp_c).unwrap_or(f64::NAN);
        log.check("thermal_solve_network", "x = 75 °C", (tx - 75.0).abs() < 1e-6, format!("x = {tx:.3} °C"));
    }
    let mut hot = node("hot", NodeKind::Diffusion, 100.0);
    hot.mcp = Some(PropValue::Constant { value: 100.0 });
    let rc = ThermalNetwork { nodes: vec![hot, node("amb", NodeKind::Boundary, 0.0)], conductors: vec![conductor("g", "hot", "amb", 10.0)] };
    log.ok(
        "thermal_solve_network",
        "RC decay τ = 10 s, transient 30 s",
        thermal_solve_network(rc, SolveOptions { mode: "transient".into(), duration_s: Some(30.0), time_step_s: Some(0.01) }).await,
        |r| format!("converged={} T(30 s) = {:.2} °C (analytic 4.98), {} samples", r.converged, r.temps[0].last().copied().unwrap_or(f64::NAN), r.times.len()),
    );
    log.err(
        "thermal_solve_network",
        "mode=sideways",
        thermal_solve_network(net.clone(), SolveOptions { mode: "sideways".into(), duration_s: None, time_step_s: None }).await,
        "",
    );

    // ---- 10. Band-math index on the raw T-linear TIFF: counts → °C as a new asset
    if let (Some(raw_a), true) = (&raw_asset, frames_ok) {
        let mut mapping = HashMap::new();
        mapping.insert("RAW".to_string(), 0usize);
        if let Some(idx) = log.ok(
            "thermal_compute_index",
            "RAW * 0.04 - 273.15 over the 16-bit TIFF",
            thermal_compute_index(raw_a.id, "tlinear".into(), "RAW * 0.04 - 273.15".into(), mapping.clone(), h.state()).await,
            describe_asset,
        ) {
            let (emn, emx, _) = min_max_mean(&celsius[0].2);
            if let Some(r) = log.ok("thermal_analyze", "index asset", thermal_analyze(idx.id, None, h.state()).await, |r| {
                format!("min {:.2} max {:.2} mean {:.2}", r.stats.min, r.stats.max, r.stats.mean)
            }) {
                log.check(
                    "thermal_compute_index",
                    "index equals the T-linear conversion",
                    near(r.stats.min, emn, 0.01) && near(r.stats.max, emx, 0.01),
                    format!("expected min {emn:.2} max {emx:.2}"),
                );
            }
        }
        let mut bad = HashMap::new();
        bad.insert("NIR".to_string(), 1usize);
        log.err(
            "thermal_compute_index",
            "band 2 of a single-band TIFF",
            thermal_compute_index(raw_a.id, "x".into(), "NIR".into(), bad, h.state()).await,
            "does not exist",
        );
        log.err(
            "thermal_compute_index",
            "no bands mapped",
            thermal_compute_index(raw_a.id, "x".into(), "RAW".into(), HashMap::new(), h.state()).await,
            "at least one band",
        );
        log.err(
            "thermal_compute_index",
            "formula syntax error",
            thermal_compute_index(raw_a.id, "x".into(), "RAW * (".into(), mapping, h.state()).await,
            "",
        );
    }

    // ---- 11. AI provider settings (no network: generation must refuse without a key)
    log.ok("thermal_ai_get_config", "fresh profile", thermal_ai_get_config(h.state()).await, |c| {
        format!("provider={} keys: claude={} openai={} gemini={}", c.provider, c.has_claude_key, c.has_openai_key, c.has_gemini_key)
    });
    log.ok("thermal_ai_set_provider", "openai", thermal_ai_set_provider("openai".into(), h.state()).await, |_| "stored".into());
    log.err("thermal_ai_set_provider", "bogus", thermal_ai_set_provider("bogus".into(), h.state()).await, "");
    log.ok("thermal_ai_has_api_key", "openai, none stored", thermal_ai_has_api_key(h.state()).await, |b| format!("has key={b} (expected false: {})", !b));
    log.err("thermal_ai_generate_text", "no key configured", thermal_ai_generate_text(String::new(), "draft something".into(), h.state()).await, "No API key");
    if let Some(a) = &jpg_asset {
        log.err("thermal_ai_generate_findings", "no key configured", thermal_ai_generate_findings(a.id, "{}".into(), h.state()).await, "No API key");
    }
    log.err("thermal_ai_set_api_key", "empty key", thermal_ai_set_api_key("openai".into(), "   ".into(), h.state()).await, "empty");
    log.ok("thermal_ai_set_api_key", "openai, placeholder key", thermal_ai_set_api_key("openai".into(), "smoke-test-placeholder".into(), h.state()).await, |_| "stored".into());
    log.ok("thermal_ai_has_api_key", "openai, key stored", thermal_ai_has_api_key(h.state()).await, |b| format!("has key={b} (expected true: {b})"));
    log.ok("thermal_ai_remove_api_key", "openai", thermal_ai_remove_api_key("openai".into(), h.state()).await, |_| "removed".into());
    log.ok("thermal_ai_get_config", "after removal", thermal_ai_get_config(h.state()).await, |c| {
        format!("provider={} openai key={} (expected none: {})", c.provider, c.has_openai_key, !c.has_openai_key)
    });

    // ---- 12. Saved reports
    let report_json = serde_json::json!({
        "kind": "thermal",
        "headline": "FLIR ADAS smoke test",
        "inspectionDate": "2026-10-14",
        "entries": samples.iter().map(|s| serde_json::json!({ "thermalAssetId": s.asset.id })).collect::<Vec<_>>(),
    })
    .to_string();
    let report_id = log.ok(
        "thermal_save_report",
        "new thermal report",
        thermal_save_report(None, "ADAS smoke".into(), report_json.clone(), h.state()).await,
        |id| format!("id {id}"),
    );
    if let Some(id) = report_id {
        log.ok("thermal_list_reports", "after save", thermal_list_reports(h.state()).await, |l| {
            let hit = l.iter().find(|r| r.id == id);
            format!("{} reports; saved one listed={} kind={}", l.len(), hit.is_some(), hit.map(|r| r.kind.as_str()).unwrap_or("?"))
        });
        log.ok("thermal_get_report", "saved id", thermal_get_report(id, h.state()).await, |j| format!("round trip intact={}", *j == report_json));
        log.ok(
            "thermal_save_report",
            "update in place",
            thermal_save_report(Some(id), "ADAS smoke v2".into(), report_json.clone(), h.state()).await,
            |nid| format!("id {nid} (same id: {})", *nid == id),
        );
        log.ok("thermal_delete_report", "saved id", thermal_delete_report(id, h.state()).await, |_| "deleted".into());
        log.ok("thermal_list_reports", "after delete", thermal_list_reports(h.state()).await, |l| {
            format!("{} reports; deleted one gone={}", l.len(), !l.iter().any(|r| r.id == id))
        });
        log.err("thermal_get_report", "deleted id", thermal_get_report(id, h.state()).await, "");
    }

    // ---- 13. Inspection bundle: export, import into a second profile, re-import dedupes
    let mut bundle_ids: Vec<i64> = samples.iter().map(|s| s.asset.id).collect();
    if let Some(a) = &raw_asset {
        bundle_ids.push(a.id);
    }
    if let Some(a) = &flir_asset {
        bundle_ids.push(a.id);
    }
    // The library state the bundle must carry: renamed, annotated assets
    let current: Vec<ThermalAsset> = thermal_list_assets(h.state()).await.unwrap();
    let dest = h.dir.path().join("adas-smoke.odlbundle");
    if let Some(path) = log.ok(
        "thermal_export_bundle",
        &format!("{} assets + live report JSON", bundle_ids.len()),
        thermal_export_bundle(
            dest.to_string_lossy().into(),
            "ADAS smoke bundle".into(),
            None,
            Some(report_json.clone()),
            bundle_ids.clone(),
            vec![],
            h.state(),
        )
        .await,
        |p| format!("{p} ({} bytes)", std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)),
    ) {
        let h2 = Harness::new();
        if let Some(r) = log.ok("thermal_import_bundle", "into a fresh profile", thermal_import_bundle(path.clone(), h2.state()).await, |r| {
            format!(
                "imported={} skipped={} report_id={:?} report_name={:?} flights={}",
                r.imported_assets, r.skipped_assets, r.report_id, r.report_name, r.archived_flights
            )
        }) {
            log.check(
                "thermal_import_bundle",
                "every asset and the report arrived",
                r.imported_assets == bundle_ids.len() && r.skipped_assets == 0 && r.report_id.is_some(),
                format!("{} of {} assets", r.imported_assets, bundle_ids.len()),
            );
            let listed = thermal_list_assets(h2.state()).await.unwrap();
            for s in &samples {
                let twin = listed.iter().find(|x| x.file_hash == s.asset.file_hash);
                match twin {
                    Some(t) => {
                        let cur = current.iter().find(|x| x.id == s.asset.id);
                        let (raster, preview) = sidecars_exist(t);
                        let (emn, emx, _) = min_max_mean(&s.expected);
                        let analysed = thermal_analyze(t.id, None, h2.state()).await;
                        let same = analysed.as_ref().map(|r| near(r.stats.min, emn, s.tol) && near(r.stats.max, emx, s.tol)).unwrap_or(false);
                        log.check(
                            "thermal_import_bundle",
                            &format!("{}: sidecars restored, analysis identical", s.label),
                            raster && preview && same
                                && cur.map(|c| t.file_name == c.file_name && t.notes == c.notes).unwrap_or(false),
                            format!(
                                "raster={raster} preview={preview} analysis={} name “{}” notes carried={}",
                                analysed.map(|r| format!("min {:.2} max {:.2}", r.stats.min, r.stats.max)).unwrap_or_else(|e| e),
                                t.file_name,
                                t.notes.is_some()
                            ),
                        );
                        if s.asset.id == samples[0].asset.id {
                            let ann = thermal_get_annotations(t.id, h2.state()).await.unwrap_or(None);
                            let net = thermal_get_network(t.id, h2.state()).await.unwrap_or(None);
                            log.check(
                                "thermal_import_bundle",
                                "annotations and network carried over",
                                ann.is_some() && net.is_some(),
                                format!("annotations={} network={}", ann.is_some(), net.is_some()),
                            );
                        }
                    }
                    None => log.record("thermal_import_bundle", s.label, false, "asset missing after import"),
                }
            }
            if let Some(rid) = r.report_id {
                log.ok("thermal_get_report", "imported bundle report", thermal_get_report(rid, h2.state()).await, |j| {
                    let v: serde_json::Value = serde_json::from_str(j).unwrap_or(serde_json::Value::Null);
                    format!("kind={} entries={}", v["kind"], v["entries"].as_array().map(|a| a.len()).unwrap_or(0))
                });
            }
        }
        log.ok("thermal_import_bundle", "same bundle again (dedupe by hash)", thermal_import_bundle(path, h2.state()).await, |r| {
            format!("imported={} skipped={} (expected all skipped: {})", r.imported_assets, r.skipped_assets, r.imported_assets == 0)
        });
    }

    // ---- 14. Delete removes the file and both sidecars
    if let Some(s) = samples.first() {
        let a = &s.asset;
        let stored = PathBuf::from(&a.stored_path);
        let raster = sidecar_path("rasterFile", a);
        let preview = sidecar_path("previewFile", a);
        log.ok("thermal_delete_asset", s.label, thermal_delete_asset(a.id, h.state()).await, |_| "deleted".into());
        let gone = !stored.exists()
            && raster.map(|p| !p.exists()).unwrap_or(true)
            && preview.map(|p| !p.exists()).unwrap_or(true);
        let listed = thermal_list_assets(h.state()).await.unwrap();
        log.check(
            "thermal_delete_asset",
            "file, raster and preview removed; gone from the list",
            gone && !listed.iter().any(|x| x.id == a.id),
            format!("files removed={gone}, {} assets remain", listed.len()),
        );
        log.err("thermal_analyze", "deleted asset", thermal_analyze(a.id, None, h.state()).await, "");
    }

    // ---- report
    let preamble = vec![
        format!("- Dataset: `{}`", root.display()),
        format!(
            "- Inputs: {} · {} · {} · {}",
            file_name(&thermal_jpg),
            file_name(&rgb_jpg),
            raw.iter().map(|p| file_name(p)).collect::<Vec<_>>().join(", "),
            tiff8.as_ref().map(|p| file_name(p)).unwrap_or_else(|| "(no 8-bit TIFF)".into())
        ),
        format!("- T-linear conversion used for the °C samples: `°C = count × {TLINEAR_K_PER_COUNT} − 273.15` (Tau 2 high gain)"),
        format!("- Run on {}", chrono::Local::now().format("%Y-%m-%d %H:%M")),
    ];
    let md = log.markdown(&preamble);
    if let Some(o) = &out {
        std::fs::write(o.join("smoke-report.md"), &md).expect("write smoke report");
        println!("results written to {}", o.join("smoke-report.md").display());
    }
    println!("\n{md}");
    assert_eq!(log.failures(), 0, "{} smoke check(s) failed — see the table above", log.failures());
}
