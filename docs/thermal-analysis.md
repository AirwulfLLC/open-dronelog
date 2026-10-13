# Thermal Studio — DJI Thermal Analysis

Open DroneLog's **Thermal Studio** analyzes radiometric JPEGs (R-JPEG) captured
by DJI thermal cameras — Zenmuse H20T/H20N, H30T, M30T, M3T/M3TD, M2EA, M4T,
XT S and similar — using the official **DJI Thermal SDK** (`libdirp`).

> Thermal Studio is an **add-on** (see [add-ons.md](add-ons.md)): install the
> Thermal add-on and its tab appears in the sidebar. It is desktop-only
> (Windows x64 / Linux x64); the web/Docker build and the Android app have no
> add-ons.

## Installing (users)

Run `OpenDroneLog-Thermal-Addon_<version>_x64-setup.exe`, then open
**Add-ons** next to Settings and press **Refresh**. The add-on brings the DJI
Thermal SDK runtime with it — nothing else to set up. The Thermal Studio top
bar shows a green "DJI Thermal SDK ready" badge when the SDK is loaded, or the
load error if not.

## SDK setup (developers)

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
2. the Thermal add-on's runtime: `<app data dir>/addons/thermal/tsdk/`
   (what the add-on installer installs)
3. a `tsdk/` folder next to the app executable (all-in-one bundles built with
   `src-tauri/tauri.thermal-sdk.conf.json`)
4. the app executable's own folder
5. `deps/dji_thermal_sdk/tsdk-core/lib/<platform>/release_x64/` in the repo
   (development builds)

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

**AI narrative (optional):** the analysis panel can generate a written
inspection narrative: the image plus the measured statistics, detected
anomalies, and any heat-flow network results are sent to an AI provider,
which returns a summary, per-anomaly interpretation, and prioritized
recommendations. In Settings — the "AI Thermal Analysis" section directly
below the DJI API key — pick a provider from the dropdown and save its API
key:

| Provider | Model used | Key from |
|---|---|---|
| Claude (Anthropic) | `claude-opus-5` | platform.claude.com |
| OpenAI (GPT) | `gpt-5` | platform.openai.com/api-keys |
| Google Gemini | `gemini-2.5-pro` | aistudio.google.com/apikey |

Keys are stored per profile in the local database (one per provider, so
switching providers keeps each key) and are only ever sent to the selected
provider's API. Without a key, the feature simply shows a hint and everything
else works fully offline.

### Heat flow network (radiation exchange)

A lumped-parameter thermal network solver (SINDA-style) is built into the
analysis panel for computing radiation exchange between surfaces and
representing heat flow paths between computation points:

- **Nodes** — place with the **Node** tool; each samples the measured image
  temperature as its starting value. Three kinds:
  - *Diffusion*: has thermal mass m·cp (J/K) — implements transient heat
    diffusion `m·cp·dT/dt = Σq + Q` (the lumped form of
    `ρcp ∂T/∂t = ∇·(k∇T) + q‴`);
  - *Arithmetic*: massless, instantaneous heat balance;
  - *Boundary*: prescribed temperature (ambient is the typical boundary).
- **Conductors** — drag with the **Link** tool between two nodes:
  - *Linear*: `q = G·(T₁−T₂)` (Fourier conduction `kA/L`, or convection `hA`);
  - *Radiative*: `q = σ·εFA·(T₁⁴−T₂⁴)` (radiation exchange; εFA in m²).
- **Sources** — heater power, electrical dissipation, solar/environmental
  backloading (W) applied to any non-boundary node.
- m·cp, conductances, sources and boundary temperatures may be **constant,
  vary with time, or vary with temperature** (piecewise-linear tables) — i.e.
  arbitrarily user modified.
- **Solvers** — steady state (Newton with exact radiative Jacobian) and
  transient (backward Euler, unconditionally stable). Solutions are validated
  against analytical cases in the unit tests (RC decay, radiative
  equilibrium, temperature-dependent conductance).
- **Results** — heat flow paths drawn on the image as directional arrows
  scaled by |q| with wattage labels, per-node surface heat balance
  (`Σq_cond = q_conv + q_rad + q_source` breakdown), and a transient
  temperature chart. Networks persist per asset and are included in backups.

### Annotations

Arrow, straight line, text, freehand, ellipse and rectangle tools, an **eraser** (drag over
annotations: shapes and labels are removed whole, freehand strokes are cut
where the eraser passes and split into the remaining pieces), select/move,
undo, clear, and Delete-key removal. Colors come from preset swatches or a
**custom color** picker (the rainbow swatch opens the system color dialog;
recent custom colors are kept as extra swatches). Annotations persist per
asset in the profile database and are baked into report exports.

**📝 Note** attaches a free-text note to the selected picture (any library).
It is printed under the picture wherever it appears in a report — under a
thermal imaging pair or a survey figure — and can also be edited in the
report preview.

**✏️ Rename** (hover a library item, double-click its name, or use the pencil
next to the name under the viewer) changes a picture's name in either library.
The name is what the reports print — under each thermal imaging pair
("Visual: … · Thermal: …"), in the source line under each survey figure and
in the deliverables list — so `DJI_0417.JPG` can read `North wall – bay 3.JPG`
in the finished report. The extension is kept (it tells the app how to serve
the file) and the stored file is left untouched; renames travel in inspection
bundles. (An anomaly's *Location* text is seeded from the picture's name when
the anomaly is added and then stays as typed — edit it in the report builder.)

### Photogrammetry tab (report imagery)

The **Photogrammetry** dashboard tab assembles the imagery of a photogrammetry
survey report. It has its own library of photos (`.jpg`/`.png`) and videos
(`.mp4`/`.mov`/`.avi`) kept separate from the thermal assets, plus the Agisoft
Metashape deliverables (orthomosaic GeoTIFFs, processing PDFs, camera
XML/CSV, point clouds, KML/KMZ — shared with the Thermal Studio), all imported
by file dialog or drag-and-drop; the same annotation tools as the Thermal
Studio; and a **Report images** queue:

- **Select and add** — check one or more library items (or just select one)
  and press **Add to report**; each becomes a numbered figure. The queue
  order **is** the figure order in the exported report: drag the ⋮⋮ handle
  or use ▲▼ to reorder, and give each figure a caption.
- **Videos** — *Add frame … to report* queues the frame at the current
  playback position (a video can appear several times with different frames;
  *set to current* re-snaps a queued frame). *Capture frame* saves the frame
  as a new photo in the library.
- **Annotations** drawn on a photo or video are stored with it and burned
  into its report figure (video frames are extracted and annotated at export
  time, downscaled to 2000 px on the long edge).
- The queue persists per profile, so a report can be assembled over several
  sessions. **Save** in the report builder snapshots it into the saved
  report; loading a saved report restores it. Queued media and annotations
  travel in exported inspection bundles.

### Agisoft Metashape import

The asset importer also accepts Agisoft Metashape exports, which are stored in
the same per-profile library alongside thermal media:

| File | Handling |
|---|---|
| `.tif` / `.tiff` (orthomosaic, DEM) | A PNG preview (max 4096 px) is generated so the GeoTIFF can be viewed and annotated in the studio; the original is kept untouched. 16-bit and float DEMs are min–max normalized. |
| `.tif` / `.tiff` (multispectral, ≥4 bands) | Detected automatically (DJI Mavic 3M / P4 Multispectral, MicaSense RedEdge/Altum…). An RGB band composite preview is generated, and the per-band planes feed the vegetation-index calculator below. |
| `.pdf` (processing report) | Stored with a metadata card; opens in the system PDF viewer. |
| `.xml` (camera calibration) | Camera/marker counts and the coordinate system are parsed for display. |
| `.csv` (camera reference) | Row/column counts parsed. |
| `.las` / `.laz` / `.ply` / `.obj` (point clouds, models) | Stored; opens in the system default application. |
| `.kml` / `.kmz` (map overlays) | Stored. |

### Vegetation indices (NDVI and user-defined)

Selecting a multispectral asset shows a **Vegetation Index** section in the
analysis panel:

- **Band mapping** — assign each band its spectral role (Blue, Green, Red,
  RedEdge, NIR, Thermal). Sensible defaults are pre-filled by band count
  (4-band → Mavic 3M layout, 5-band → P4M/RedEdge, 6-band → Altum).
- **Presets** — NDVI, GNDVI, NDRE, SAVI, VARI — or a **user-defined formula**
  over the mapped band variables with `+ − × ÷`, parentheses, and constants
  (e.g. `(NIR - R) / (NIR + R)`). Division by zero becomes nodata.
- **Compute** renders the index with the classic red→yellow→green ramp and
  stores it as a **new asset**: a colormapped PNG plus the raw index raster.
  Index assets get the *full analysis pipeline* — value statistics and
  histogram, cursor readout, **range isolation** (e.g. isolate stressed
  vegetation below NDVI 0.3), anomaly-region detection, annotations, report
  embedding, and bundle export. Values display unitless with 3-decimal
  precision, and the viewer defaults to the Vegetation palette.

### Linked DJI flights and inspection bundles

The report builder has a **Flight Data** section for linking the DJI flights
that produced the inspection imagery — a snapshot of each flight's operations
data (date, drone, duration, distance, altitude, home position) is embedded
in the report, and a **Orthomosaic (Agisoft Metashape)** section for
embedding an imported orthomosaic in the exported document.

**Export Bundle** saves the complete inspection as a single portable
`.odlbundle` file (gzipped tar): the report, every referenced asset
(thermal media and all Metashape files, with previews), annotations,
heat-flow networks, and the linked flights' full telemetry. **Report ▸
Import inspection bundle…** restores one on any machine or profile — assets
are deduplicated by content hash and the report is recreated with its
references intact.

### Reports (Report ▸ Open report builder…)

There are two report workflows, one per studio. Each has its own builder,
section list and export layout, and each lists only its own saved reports
(saved documents carry a `kind`). Both share the modal shell, the PDF/RTF
writers and the sections they have in common (header data, linked DJI
flights, embedded orthomosaic, imagery figures), so a new section can be
added to either report independently: a field on the report type, a section
component (`src/components/reports/sections/`), and its renderer in that
kind's module under `src/lib/reports/`.

**Thermal Inspection Report** (Thermal Studio) — follows the structure of a
professional thermography report (administrative data, conditions, imagery
pairs, executive summary and findings, recommendations and follow-up,
limitations):

1. **Header Data & Administrative Information** — property address,
   inspection date and time, inspector/thermographer with credentials and
   contact details, camera make, model and serial number (*Fill camera from
   imagery* reads them from the pictures' EXIF data), asset IDs/tags covered,
   and the executive summary. The thermographer's details and camera of the
   last saved or exported report are remembered per profile and prefilled
   into the next new report.
2. **Environmental & System Conditions** — weather (sun exposure, wind),
   ambient temperature, relative humidity, system/electrical load during the
   survey, and the calibration used for the measurements: emissivity,
   reflected (background) temperature and distance (*Use analysis parameters*
   copies them from the selected picture's radiometric analysis).
3. **Flight Data (DJI)** — linked flights (operations snapshot embedded).
4. **Orthomosaic (Agisoft Metashape)** — embedded orthomosaic + map link.
5. **Thermal Imaging Log / Comparative Matrix** — side-by-side Visual
   (Zoom/Wide) and Thermal (Infrared) images with captions and LRF (laser
   rangefinder) data per pair. Each pair carries the **palette and
   temperature scale** its thermal picture is rendered with (seeded from the
   studio when the pair is added; blank scale = the picture's min/max) and
   prints them under the pair, together with the picture names, capture data
   and the anomalies logged on that picture with their ΔT. Every radiometric
   picture renders through that palette with its annotations — not only the
   one open in the studio. *Pairs for anomalies* adds a pair for every
   picture that has anomalies; the visual twin is matched by DJI's file
   naming (`…_T`/`…_R` ↔ `…_W`/`…_V`/`…_Z`).
6. **Anomalies & Findings** — unique IDs, location + geotag, T_max/T_min,
   reference baseline, ΔT, severity grade and defect classification.
   Detected anomalies can be imported automatically.
7. **Asset Inventory & Exception List** — every inspected asset or area with
   a status: *Normal*, *Exception* (one row per anomaly with *Exceptions from
   anomalies*) or *Not inspected / inaccessible* with the reason. The report
   prints the table, the counts, and the list of uninspected assets.
8. **Action Plan & Repair Prioritization** — work orders by severity (the
   priority summary derived from the severity grades prints under the
   executive summary).
9. **Follow-Up & Re-inspection** — post-repair verification scans, periodic
   re-inspection or temperature-trending interval, and what later scans
   should reproduce to be comparable.
10. **Limitations, Definitions & Disclaimer** — prefilled with a standard
    text on what thermography can and cannot show (no view inside solid
    materials, no confirmation of moisture or mould without physical
    testing…), definitions of T max/T min, baseline, ΔT, emissivity,
    reflected temperature and the severity grades, and a disclaimer; edit
    freely or restore the standard text.

**Photogrammetry Survey Report** (Photogrammetry tab):

1. **Header Data** — project name, site address, survey date, weather,
   pilot/operator, summary.
2. **Survey Scope** — objective, area of interest, accuracy, deliverables.
3. **Flight Data (DJI)** — as above.
4. **Photogrammetry Outputs (Agisoft Metashape)** — embedded orthomosaic +
   link, and a checklist of the imported Metashape deliverables to list in
   the report (the library is shared with the Thermal Studio, so only ticked
   files appear and travel in the report's bundle).
5. **Processing Notes** — software, alignment, GSD, control points, CRS.
6. **Survey Imagery** — the Photogrammetry tab's queued figures in queue
   order, each with annotations, caption and provenance line (file, capture
   time, camera, position; video frame time).
7. **Findings & Observations** — numbered findings with category
   (structural defect, surface deterioration, vegetation, erosion/drainage,
   obstruction, survey note), severity, location, linked figure, observation
   and recommendation; plus **observations** (`+ Add observation`) — neutral,
   ungraded notes on what the imagery showed, with location and linked
   figure, listed after the findings.
8. **Conclusions & Recommendations** — narrative plus the severity summary.

**✨ AI draft** — sections whose text can be composed from the data entered
(Executive Summary, Anomalies & Findings, Action Plan and Follow-Up &
Re-inspection for thermal reports; Summary,
Survey Scope, Processing Notes, Findings & Observations and Conclusions for
photogrammetry reports) carry an *AI draft* tick in their heading. Ticking it
sends only the facts entered in the report — never images — to the AI
provider configured in Settings and fills the section with the reply (for
findings and observations, each entry's text by id); untick to restore your
own text, ↻ to regenerate. The tick is greyed out until an API key for the
selected provider is configured in Settings (AI Thermal Analysis).

Reports are saved per profile and export as **PDF** (A4, paginated, with
embedded images and tables), **Word (.docx)** or **RTF** — all three come
from one renderer per report kind, so they carry the same content. **Preview
& edit** opens the report as it will export: the *Edit* tab is an editable
rendition where any report text (header fields, summaries, captions, LRF
data, findings, recommendations, action plan, picture notes…) can be changed
in place and flows straight back into the report; the *PDF* tab shows the
actual PDF of the current state. Exports can be started from the preview.
**Export Bundle** works for both kinds.

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
