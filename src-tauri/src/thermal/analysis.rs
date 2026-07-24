//! Statistical analysis of thermal temperature matrices.
//!
//! Provides the "AI analysis" layer: variance statistics, histogram,
//! z-score based hot/cold anomaly detection with connected-component
//! region extraction, severity grading and defect classification.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistogramBin {
    pub temp: f32,
    pub count: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TempStats {
    pub min: f32,
    pub max: f32,
    pub mean: f32,
    pub median: f32,
    pub std_dev: f32,
    /// Pixel coordinates of the coldest / hottest spots.
    pub min_pos: (u32, u32),
    pub max_pos: (u32, u32),
    pub histogram: Vec<HistogramBin>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct AnomalyOptions {
    /// Z-score threshold above/below which a pixel is anomalous (default 2.0).
    pub z_threshold: Option<f32>,
    /// Minimum region size in pixels (default 24).
    pub min_region_px: Option<u32>,
    /// Maximum number of regions to return (default 24).
    pub max_regions: Option<u32>,
    /// Optional user-defined range: only consider pixels within [low, high].
    pub range_low: Option<f32>,
    pub range_high: Option<f32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnomalyRegion {
    /// 1-based sequential id (stable within one analysis run).
    pub id: u32,
    /// "hot" or "cold"
    pub kind: String,
    pub area_px: u32,
    pub bbox: (u32, u32, u32, u32), // x, y, w, h
    pub centroid: (f32, f32),
    pub t_min: f32,
    pub t_max: f32,
    pub t_mean: f32,
    /// Difference between region mean and image baseline (median).
    pub delta_t: f32,
    pub severity: String,       // "low" | "medium" | "high"
    pub classification: String, // heuristic defect class key
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnomalyResult {
    pub baseline: f32,
    pub std_dev: f32,
    pub z_threshold: f32,
    pub regions: Vec<AnomalyRegion>,
}

const HISTOGRAM_BINS: usize = 96;

/// Compute summary statistics + histogram for a temperature matrix.
pub fn compute_stats(temps: &[f32], width: usize) -> TempStats {
    debug_assert!(!temps.is_empty());
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut min_idx = 0usize;
    let mut max_idx = 0usize;
    let mut sum = 0f64;
    for (i, &t) in temps.iter().enumerate() {
        if t < min {
            min = t;
            min_idx = i;
        }
        if t > max {
            max = t;
            max_idx = i;
        }
        sum += t as f64;
    }
    let n = temps.len() as f64;
    let mean = (sum / n) as f32;

    let mut var = 0f64;
    for &t in temps {
        let d = t as f64 - mean as f64;
        var += d * d;
    }
    let std_dev = (var / n).sqrt() as f32;

    // Median via partial sort of a sample (full sort is fine at 327k px, but
    // sampling keeps it fast for larger sensors).
    let stride = (temps.len() / 65_536).max(1);
    let mut sample: Vec<f32> = temps.iter().step_by(stride).copied().collect();
    sample.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sample[sample.len() / 2];

    // Histogram
    let span = (max - min).max(0.1);
    let mut bins = vec![0u32; HISTOGRAM_BINS];
    for &t in temps {
        let idx = (((t - min) / span) * (HISTOGRAM_BINS as f32 - 1.0)) as usize;
        bins[idx.min(HISTOGRAM_BINS - 1)] += 1;
    }
    let histogram = bins
        .into_iter()
        .enumerate()
        .map(|(i, count)| HistogramBin {
            temp: min + span * (i as f32 + 0.5) / HISTOGRAM_BINS as f32,
            count,
        })
        .collect();

    TempStats {
        min,
        max,
        mean,
        median,
        std_dev,
        min_pos: ((min_idx % width) as u32, (min_idx / width) as u32),
        max_pos: ((max_idx % width) as u32, (max_idx / width) as u32),
        histogram,
    }
}

/// Grade severity from the temperature delta between a region and baseline.
fn grade_severity(delta_abs: f32, std_dev: f32) -> &'static str {
    // Relative to scene variance so a low-contrast facade still grades sanely.
    let z = if std_dev > 0.05 { delta_abs / std_dev } else { delta_abs };
    if delta_abs >= 8.0 || z >= 6.0 {
        "high"
    } else if delta_abs >= 4.0 || z >= 3.5 {
        "medium"
    } else {
        "low"
    }
}

/// Heuristic defect classification for building-envelope inspections.
fn classify(kind: &str, delta_abs: f32, area_px: u32, bbox: (u32, u32, u32, u32)) -> &'static str {
    let (_, _, w, h) = bbox;
    let aspect = if h > 0 { w as f32 / h as f32 } else { 1.0 };
    let elongated = aspect > 3.0 || aspect < 0.33;
    match kind {
        "hot" => {
            if delta_abs >= 10.0 && area_px < 900 {
                // Small, very hot spot — typical of electrical faults.
                "electrical_fault"
            } else if elongated {
                // Long thin warm streak — stud lines / thermal bridging.
                "thermal_bridging"
            } else if delta_abs >= 5.0 {
                "hvac_leakage"
            } else {
                "insulation_void"
            }
        }
        _ => {
            if elongated {
                "air_infiltration"
            } else if delta_abs >= 6.0 {
                "moisture_intrusion"
            } else {
                "missing_insulation"
            }
        }
    }
}

/// Detect anomalous hot/cold regions via z-score thresholding + 4-connected
/// component labeling (iterative flood fill — no recursion).
pub fn detect_anomalies(
    temps: &[f32],
    width: usize,
    height: usize,
    opts: AnomalyOptions,
) -> AnomalyResult {
    let stats = compute_stats(temps, width);
    let baseline = stats.median;
    let std_dev = stats.std_dev.max(0.01);
    let z_threshold = opts.z_threshold.unwrap_or(2.0).clamp(0.5, 8.0);
    let min_region_px = opts.min_region_px.unwrap_or(24).max(1);
    let max_regions = opts.max_regions.unwrap_or(24).clamp(1, 200) as usize;

    let in_range = |t: f32| -> bool {
        if let Some(low) = opts.range_low {
            if t < low {
                return false;
            }
        }
        if let Some(high) = opts.range_high {
            if t > high {
                return false;
            }
        }
        true
    };

    // Label: 0 = normal, 1 = hot anomaly, 2 = cold anomaly
    let mut mask = vec![0u8; temps.len()];
    for (i, &t) in temps.iter().enumerate() {
        if !in_range(t) {
            continue;
        }
        let z = (t - baseline) / std_dev;
        if z >= z_threshold {
            mask[i] = 1;
        } else if z <= -z_threshold {
            mask[i] = 2;
        }
    }

    let mut visited = vec![false; temps.len()];
    let mut regions: Vec<AnomalyRegion> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();

    for start in 0..temps.len() {
        if mask[start] == 0 || visited[start] {
            continue;
        }
        let kind_code = mask[start];
        stack.clear();
        stack.push(start);
        visited[start] = true;

        let mut area = 0u32;
        let (mut min_x, mut min_y, mut max_x, mut max_y) =
            (usize::MAX, usize::MAX, 0usize, 0usize);
        let mut sum_x = 0f64;
        let mut sum_y = 0f64;
        let mut t_min = f32::INFINITY;
        let mut t_max = f32::NEG_INFINITY;
        let mut t_sum = 0f64;

        while let Some(idx) = stack.pop() {
            let x = idx % width;
            let y = idx / width;
            area += 1;
            sum_x += x as f64;
            sum_y += y as f64;
            let t = temps[idx];
            t_min = t_min.min(t);
            t_max = t_max.max(t);
            t_sum += t as f64;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);

            // 4-connectivity
            if x > 0 {
                let n = idx - 1;
                if !visited[n] && mask[n] == kind_code {
                    visited[n] = true;
                    stack.push(n);
                }
            }
            if x + 1 < width {
                let n = idx + 1;
                if !visited[n] && mask[n] == kind_code {
                    visited[n] = true;
                    stack.push(n);
                }
            }
            if y > 0 {
                let n = idx - width;
                if !visited[n] && mask[n] == kind_code {
                    visited[n] = true;
                    stack.push(n);
                }
            }
            if y + 1 < height {
                let n = idx + width;
                if !visited[n] && mask[n] == kind_code {
                    visited[n] = true;
                    stack.push(n);
                }
            }
        }

        if area < min_region_px {
            continue;
        }

        let t_mean = (t_sum / area as f64) as f32;
        let delta_t = t_mean - baseline;
        let kind = if kind_code == 1 { "hot" } else { "cold" };
        let bbox = (
            min_x as u32,
            min_y as u32,
            (max_x - min_x + 1) as u32,
            (max_y - min_y + 1) as u32,
        );
        regions.push(AnomalyRegion {
            id: 0, // assigned after sorting
            kind: kind.to_string(),
            area_px: area,
            bbox,
            centroid: ((sum_x / area as f64) as f32, (sum_y / area as f64) as f32),
            t_min,
            t_max,
            t_mean,
            delta_t,
            severity: grade_severity(delta_t.abs(), std_dev).to_string(),
            classification: classify(kind, delta_t.abs(), area, bbox).to_string(),
        });
    }

    // Most significant first: |ΔT| weighted by log(area)
    regions.sort_by(|a, b| {
        let score = |r: &AnomalyRegion| r.delta_t.abs() * (1.0 + (r.area_px as f32).ln());
        score(b).partial_cmp(&score(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    regions.truncate(max_regions);
    for (i, r) in regions.iter_mut().enumerate() {
        r.id = (i + 1) as u32;
    }

    AnomalyResult {
        baseline,
        std_dev,
        z_threshold,
        regions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_hot_region() {
        let (w, h) = (32usize, 32usize);
        let mut temps = vec![20.0f32; w * h];
        // 6x6 hot patch at (10,10), well above any sane threshold
        for y in 10..16 {
            for x in 10..16 {
                temps[y * w + x] = 45.0;
            }
        }
        let res = detect_anomalies(
            &temps,
            w,
            h,
            AnomalyOptions {
                z_threshold: Some(2.0),
                min_region_px: Some(9),
                max_regions: None,
                range_low: None,
                range_high: None,
            },
        );
        assert_eq!(res.regions.len(), 1);
        let r = &res.regions[0];
        assert_eq!(r.kind, "hot");
        assert_eq!(r.area_px, 36);
        assert_eq!(r.bbox, (10, 10, 6, 6));
        assert!(r.t_max >= 44.9);
    }

    #[test]
    fn range_filter_limits_detection() {
        let (w, h) = (16usize, 16usize);
        let mut temps = vec![20.0f32; w * h];
        for i in 0..8 {
            temps[i] = 50.0; // hot row segment
        }
        // Range excludes the hot pixels entirely
        let res = detect_anomalies(
            &temps,
            w,
            h,
            AnomalyOptions {
                z_threshold: Some(1.5),
                min_region_px: Some(1),
                max_regions: None,
                range_low: Some(0.0),
                range_high: Some(30.0),
            },
        );
        assert!(res.regions.is_empty());
    }

    #[test]
    fn stats_basic() {
        let temps = vec![10.0f32, 20.0, 30.0, 40.0];
        let s = compute_stats(&temps, 2);
        assert_eq!(s.min, 10.0);
        assert_eq!(s.max, 40.0);
        assert!((s.mean - 25.0).abs() < 0.001);
        assert_eq!(s.min_pos, (0, 0));
        assert_eq!(s.max_pos, (1, 1));
    }
}
