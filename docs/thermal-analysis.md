# Thermal Studio — DJI Thermal Analysis

Open DroneLog's **Thermal Studio** (third tab in the sidebar view toggle) analyzes
radiometric JPEGs (R-JPEG) captured by DJI thermal cameras — Zenmuse H20T/H20N,
H30T, M30T, M3T/M3TD, M2EA, M4T, XT S and similar — using the official
**DJI Thermal SDK** (`libdirp`).

> Thermal Studio is a **desktop-only** feature (Windows x64 / Linux x64).
> The DJI Thermal SDK is a native library, so the web/Docker build and the
> Android app show the thermal tab in a disabled state.

## SDK setup

The DJI Thermal SDK is proprietary and is **not** committed to this repository.

1. Download the SDK zip (`dji_thermal_sdk_v1.8_*.zip` or newer) from
   [DJI's developer downloads](https://www.dji.com/downloads/softwares/dji-thermal-sdk)
   and place it in the repository root.
2. Run the setup script:
   - Windows: `./scripts/setup-thermal-sdk.ps1`
   - Linux/macOS: `./scripts/setup-thermal-sdk.sh`

   This extracts the needed files into `deps/dji_thermal_sdk/` (gitignored):
   C API headers, x64 runtime libraries, DJI's CLI utilities, and a small
   sample dataset for testing.

### How the app finds the SDK

At runtime the app searches for `libdirp.dll` / `libdirp.so` in this order:

1. `DJI_TSDK_DIR` environment variable
2. a `tsdk/` folder next to the app executable (recommended for packaged builds)
3. the app executable's own folder
4. `deps/dji_thermal_sdk/tsdk-core/lib/<platform>/release_x64/` in the repo
   (development builds)

For packaged/release builds, copy the contents of
`deps/dji_thermal_sdk/tsdk-core/lib/windows/release_x64/` (all DLLs) into a
`tsdk` folder next to `open-dronelog.exe` (or the Linux equivalent from
`lib/linux/release_x64/`). The Thermal Studio top bar shows a green
"DJI Thermal SDK ready" badge when the SDK is loaded, or the load error if not.

## Features

### Import

- Drag & drop or use **Import photos / videos** — accepts `.jpg/.jpeg/.png`
  images and `.mp4/.mov/.avi` videos.
- R-JPEGs are detected automatically (radiometric badge in the asset list);
  EXIF GPS position, capture time and camera model are extracted.
- Files are copied into the active profile's data folder and deduplicated by
  SHA-256 hash.
- Videos are playable in the viewer; use **Capture frame** to turn the current
  frame into an image asset for annotation and reporting. (DJI thermal video
  files do not carry radiometric data, so per-pixel temperatures are only
  available for R-JPEG stills.)

### Analysis

- Per-pixel temperature matrix via `dirp_measure_ex` (°C, float precision).
- Statistics: min/max (with in-image markers), mean, median, standard
  deviation, ΔT and a histogram.
- Six palettes (Iron Red, White Hot, Black Hot, Rainbow, Arctic, Medical) with
  auto or manual temperature scale.
- Cursor spot-temperature readout.
- Measurement parameters (emissivity, distance) can be overridden and
  re-measured — the same physics the DJI Thermal Analysis Tool exposes.

### Temperature-range isolation (isotherm)

Enable **Range Isolation** to isolate a user-defined temperature band:
out-of-range pixels are dimmed (Highlight mode) or blacked out (Solo mode),
the histogram highlights the band, and in-range pixel statistics (coverage %,
min/mean/max) are computed live.

### AI variance analysis

**Detect anomalies** runs a statistical analysis of temperature variances:

- z-score thresholding against the scene baseline (median) with configurable
  sensitivity and minimum region size;
- connected-component extraction of hot and cold regions;
- per-region metrics: area, bounding box, centroid, T_min/T_max/T_mean, ΔT
  versus baseline;
- severity grading (**Low** — minor air leak, **Medium** — insulation void,
  **High** — active moisture intrusion / electrical fault);
- heuristic defect classification: thermal bridging, missing insulation, air
  infiltration, HVAC leakage, insulation void, moisture intrusion, electrical
  fault.

When range isolation is active, detection is restricted to the isolated band.
Findings are drawn on the image and listed in the panel, and can be imported
into a report with one click.

### Annotations

Arrow, text, freehand, ellipse and rectangle tools with color selection,
select/move, undo, clear, and Delete-key removal. Annotations persist per
asset in the profile database and are baked into report exports.

### Inspection reports (Report ▸ Open report builder…)

Report sections follow a standard building-envelope inspection structure:

1. **Header Data** — property address, inspection date, weather conditions,
   inspector name.
2. **Summary** — scope and methodology.
3. **Thermal Imaging Log / Comparative Matrix** — side-by-side Visual
   (Zoom/Wide) and Thermal (Infrared) images with captions and LRF
   (laser rangefinder) data per pair. The currently selected asset exports
   with its palette rendering and annotations.
4. **Thermal Anomaly Log** — unique IDs, location + geotag
   (latitude/longitude), T_max/T_min, reference baseline, ΔT, severity grade
   and defect classification. Detected anomalies can be imported
   automatically.
5. **Action Plan & Repair Prioritization** — free-form plan plus an automatic
   priority summary derived from severity grades.
6. **Orthomosaic Map Link** — link to a stitched thermal map (e.g. DJI Terra).

Reports are saved per profile and export as **PDF** (A4, paginated, with
embedded images and a severity table) or **RTF** (opens in Word/LibreOffice,
images embedded).

## Testing with DJI sample data

The SDK zip ships with sample R-JPEGs. After running the setup script they are
in `deps/dji_thermal_sdk/dataset/` (H20T and M3T). Import any `DJI_*_R.JPG`
from there to exercise the full pipeline without a drone.

## Architecture notes

- `src-tauri/src/thermal/sdk.rs` — runtime FFI bindings (`libloading`) to
  `libdirp`; no compile-time link against the proprietary SDK, so all other
  platforms build unchanged.
- `src-tauri/src/thermal/analysis.rs` — statistics + anomaly detection
  (unit-tested pure Rust).
- `src-tauri/src/thermal/commands.rs` — Tauri commands; the temperature matrix
  crosses IPC as a compact binary payload (u32 w, u32 h, f32[] °C).
- `src/components/thermal/` — Thermal Studio UI (viewer, analysis panel,
  annotation layer, report builder).
- `src/lib/thermalPalettes.ts` — palette LUTs and canvas rendering.
- `src/lib/thermalReport.ts` — PDF (jsPDF) and RTF generators.
- Tables `thermal_assets`, `thermal_annotations`, `thermal_reports` live in
  the per-profile DuckDB database.
