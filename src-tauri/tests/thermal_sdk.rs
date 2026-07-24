//! Integration tests for the DJI Thermal SDK bindings.
//!
//! These run against the real libdirp library and the sample dataset in
//! `deps/dji_thermal_sdk/`. When the SDK is not present (e.g. CI without the
//! proprietary blob), the tests skip themselves instead of failing.

use std::path::PathBuf;

use drone_logbook_lib::thermal::{analysis, extract_exif, sdk};

fn sample_image() -> Option<Vec<u8>> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("deps")
        .join("dji_thermal_sdk")
        .join("dataset");
    for cam in ["H20T", "M3T"] {
        for n in 1..=5 {
            let p = base.join(cam).join(format!("DJI_{n:04}_R.JPG"));
            if p.exists() {
                return std::fs::read(p).ok();
            }
        }
    }
    None
}

fn sdk_ready() -> bool {
    let (available, _, err) = sdk::sdk_status();
    if !available {
        eprintln!("SKIP: DJI Thermal SDK not available: {err:?}");
    }
    available
}

#[test]
fn measures_sample_rjpeg() {
    if !sdk_ready() {
        return;
    }
    let Some(bytes) = sample_image() else {
        eprintln!("SKIP: no sample dataset found");
        return;
    };

    assert!(sdk::is_radiometric(&bytes), "sample should be radiometric");

    let m = sdk::measure(&bytes, sdk::MeasureOverrides::default())
        .expect("measure should succeed on DJI sample");
    assert!(m.width >= 160 && m.width <= 1280, "width {}", m.width);
    assert!(m.height >= 120 && m.height <= 1024, "height {}", m.height);
    assert_eq!(m.temps.len(), m.width * m.height);

    // Plausible temperature range for a real scene
    let stats = analysis::compute_stats(&m.temps, m.width);
    assert!(stats.min > -60.0 && stats.min < 200.0, "min {}", stats.min);
    assert!(stats.max > stats.min && stats.max < 600.0, "max {}", stats.max);
    assert!(stats.mean > stats.min && stats.mean < stats.max);

    eprintln!(
        "OK: {}x{} temps [{:.1}..{:.1}] mean {:.1} °C",
        m.width, m.height, stats.min, stats.max, stats.mean
    );
}

#[test]
fn measurement_overrides_change_results() {
    if !sdk_ready() {
        return;
    }
    let Some(bytes) = sample_image() else {
        eprintln!("SKIP: no sample dataset found");
        return;
    };

    let base = sdk::measure(&bytes, sdk::MeasureOverrides::default()).unwrap();
    let tweaked = sdk::measure(
        &bytes,
        sdk::MeasureOverrides {
            emissivity: Some(0.5),
            ..Default::default()
        },
    )
    .unwrap();
    // Halving emissivity must shift measured temperatures.
    let a = analysis::compute_stats(&base.temps, base.width);
    let b = analysis::compute_stats(&tweaked.temps, tweaked.width);
    assert!(
        (a.mean - b.mean).abs() > 0.05,
        "expected emissivity to change mean temp ({} vs {})",
        a.mean,
        b.mean
    );
}

#[test]
fn detects_anomalies_on_sample() {
    if !sdk_ready() {
        return;
    }
    let Some(bytes) = sample_image() else {
        eprintln!("SKIP: no sample dataset found");
        return;
    };
    let m = sdk::measure(&bytes, sdk::MeasureOverrides::default()).unwrap();
    let result = analysis::detect_anomalies(
        &m.temps,
        m.width,
        m.height,
        analysis::AnomalyOptions {
            z_threshold: Some(2.0),
            min_region_px: Some(16),
            max_regions: Some(24),
            range_low: None,
            range_high: None,
        },
    );
    // Real scenes essentially always contain some statistical outlier regions.
    eprintln!(
        "OK: baseline {:.1} °C, σ {:.2}, {} regions",
        result.baseline,
        result.std_dev,
        result.regions.len()
    );
    for r in &result.regions {
        assert!(r.area_px >= 16);
        assert!(r.t_max >= r.t_min);
        assert!(["low", "medium", "high"].contains(&r.severity.as_str()));
    }
}

#[test]
fn extracts_exif_from_sample() {
    let Some(bytes) = sample_image() else {
        eprintln!("SKIP: no sample dataset found");
        return;
    };
    let meta = extract_exif(&bytes);
    // DJI samples carry at least a camera model; GPS may or may not be set.
    eprintln!(
        "EXIF: model={:?} captured={:?} gps=({:?},{:?})",
        meta.camera_model, meta.captured_at, meta.gps_lat, meta.gps_lon
    );
}
