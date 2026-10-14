//! Teledyne FLIR radiometric JPEGs (R-JPEG), measured natively.
//!
//! FLIR cameras — and the FLIR Boson / Boson+ modules inside the Skydio X10
//! and Autel EVO II Dual 640R payloads — embed the raw sensor counts and the
//! camera's calibration ("Planck") constants in the JPEG's APP1 segments as an
//! FFF container. No vendor SDK is needed to read them: the container layout
//! follows ExifTool's FLIR module (Phil Harvey) and the raw-to-temperature
//! model follows Thermimage (Glenn Tattersall), the same formulas FLIR's own
//! tools apply.
//!
//! Layout, as found in the field: the FFF header and its record directory are
//! big-endian in JPEGs, while each record's contents carry their own byte
//! order (the record starts with the value 2 read in that order). The raw
//! image is either 16-bit samples or a 16-bit PNG whose samples most cameras
//! write byte-swapped; the camera info's RawValueMedian tells which.

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const MAX_DIM: usize = 4096;

/// Calibration constants and measurement conditions stored in the picture.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlirCameraInfo {
    pub emissivity: f32,
    pub object_distance_m: f32,
    pub reflected_temp_c: f32,
    pub atmospheric_temp_c: f32,
    pub ir_window_temp_c: f32,
    pub ir_window_transmission: f32,
    /// Fraction 0..1.
    pub relative_humidity: f32,
    pub planck_r1: f32,
    pub planck_b: f32,
    pub planck_f: f32,
    pub planck_o: i32,
    pub planck_r2: f32,
    pub atm_alpha1: f32,
    pub atm_alpha2: f32,
    pub atm_beta1: f32,
    pub atm_beta2: f32,
    pub atm_x: f32,
    pub camera_model: String,
    pub camera_part_number: String,
    pub camera_serial: String,
    pub camera_software: String,
    pub lens_model: String,
    pub field_of_view_deg: f32,
    pub range_min_c: f32,
    pub range_max_c: f32,
    pub raw_value_median: u16,
    pub raw_value_range: u16,
}

/// A parsed R-JPEG: raw sensor counts plus the camera info.
pub struct FlirImage {
    pub width: u32,
    pub height: u32,
    /// Row-major raw counts, length = width × height.
    pub raw: Vec<u16>,
    pub info: FlirCameraInfo,
}

/// Measurement conditions the conversion uses: the picture's own, or the
/// user's overrides.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Conditions {
    pub emissivity: f32,
    pub object_distance_m: f32,
    pub reflected_temp_c: f32,
    pub atmospheric_temp_c: f32,
    /// Fraction 0..1.
    pub relative_humidity: f32,
    pub ir_window_temp_c: f32,
    pub ir_window_transmission: f32,
}

/// Optional overrides of the stored conditions (None = keep the picture's value).
#[derive(Clone, Copy, Debug, Default)]
pub struct Overrides {
    pub emissivity: Option<f32>,
    pub object_distance_m: Option<f32>,
    pub reflected_temp_c: Option<f32>,
    pub atmospheric_temp_c: Option<f32>,
    /// Fraction 0..1.
    pub relative_humidity: Option<f32>,
}

impl FlirCameraInfo {
    pub fn conditions(&self) -> Conditions {
        let finite = |v: f32, default: f32| if v.is_finite() { v } else { default };
        Conditions {
            emissivity: finite(self.emissivity, 0.95),
            object_distance_m: finite(self.object_distance_m, 1.0),
            reflected_temp_c: finite(self.reflected_temp_c, 20.0),
            atmospheric_temp_c: finite(self.atmospheric_temp_c, 20.0),
            relative_humidity: finite(self.relative_humidity, 0.5),
            ir_window_temp_c: finite(self.ir_window_temp_c, 20.0),
            ir_window_transmission: finite(self.ir_window_transmission, 1.0),
        }
    }
}

impl Conditions {
    pub fn with_overrides(mut self, o: &Overrides) -> Self {
        if let Some(v) = o.emissivity {
            self.emissivity = v;
        }
        if let Some(v) = o.object_distance_m {
            self.object_distance_m = v;
        }
        if let Some(v) = o.reflected_temp_c {
            self.reflected_temp_c = v;
        }
        if let Some(v) = o.atmospheric_temp_c {
            self.atmospheric_temp_c = v;
        }
        if let Some(v) = o.relative_humidity {
            self.relative_humidity = v;
        }
        self
    }
}

// ---------------------------------------------------------------------------
// JPEG → FFF container
// ---------------------------------------------------------------------------

/// The FFF container assembled from the JPEG's APP1 "FLIR\0" chunks, or None
/// when the file carries none (a plain JPEG, or a DJI R-JPEG).
pub fn extract_fff(jpeg: &[u8]) -> Option<Vec<u8>> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return None;
    }
    let mut pos = 2usize;
    let mut chunks: Vec<(u8, &[u8])> = Vec::new();
    let mut total: Option<usize> = None;
    while pos + 4 <= jpeg.len() {
        if jpeg[pos] != 0xFF {
            break;
        }
        let marker = jpeg[pos + 1];
        if marker == 0xFF {
            pos += 1; // fill byte
            continue;
        }
        // Standalone markers carry no length
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            pos += 2;
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            break; // image data / end of image: the metadata is before it
        }
        let len = u16::from_be_bytes([jpeg[pos + 2], jpeg[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > jpeg.len() {
            break;
        }
        let seg = &jpeg[pos + 4..pos + 2 + len];
        if marker == 0xE1 && seg.len() >= 8 && &seg[..5] == b"FLIR\0" {
            // Byte 6 = chunk number, byte 7 = chunk count − 1 (ExifTool's "+ 1" note)
            let index = seg[6];
            let count = seg[7] as usize + 1;
            match total {
                None => total = Some(count),
                Some(t) if t != count => return None, // inconsistent counts: not trustworthy
                _ => {}
            }
            chunks.push((index, &seg[8..]));
        }
        pos += 2 + len;
    }
    let total = total?;
    if chunks.len() != total {
        return None;
    }
    chunks.sort_by_key(|c| c.0);
    if chunks.iter().enumerate().any(|(i, c)| c.0 as usize != i) {
        return None;
    }
    let mut out = Vec::with_capacity(chunks.iter().map(|c| c.1.len()).sum());
    for (_, payload) in chunks {
        out.extend_from_slice(payload);
    }
    Some(out)
}

/// Quick check: does this JPEG carry a FLIR FFF container? (The importer
/// and the measurement path call `extract_fff` directly, so the container is
/// assembled once; this is the tests' shorthand.)
#[cfg(test)]
pub fn is_flir_rjpeg(jpeg: &[u8]) -> bool {
    extract_fff(jpeg).map_or(false, |fff| fff.starts_with(b"FFF\0") || fff.starts_with(b"AFF\0"))
}

// ---------------------------------------------------------------------------
// FFF container
// ---------------------------------------------------------------------------

struct Reader<'a> {
    data: &'a [u8],
    be: bool,
}

impl<'a> Reader<'a> {
    fn bytes<const N: usize>(&self, off: usize) -> Option<[u8; N]> {
        let end = off.checked_add(N)?;
        self.data.get(off..end)?.try_into().ok()
    }
    fn u16(&self, off: usize) -> Option<u16> {
        let b = self.bytes::<2>(off)?;
        Some(if self.be { u16::from_be_bytes(b) } else { u16::from_le_bytes(b) })
    }
    fn u32(&self, off: usize) -> Option<u32> {
        let b = self.bytes::<4>(off)?;
        Some(if self.be { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) })
    }
    fn i32(&self, off: usize) -> Option<i32> {
        self.u32(off).map(|v| v as i32)
    }
    fn f32(&self, off: usize) -> Option<f32> {
        self.u32(off).map(f32::from_bits)
    }
    fn string(&self, off: usize, len: usize) -> String {
        let end = off.saturating_add(len).min(self.data.len());
        let slice = self.data.get(off..end).unwrap_or(&[]);
        let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
        String::from_utf8_lossy(&slice[..end]).trim().to_string()
    }
}

/// A record's own byte order: its first u16 reads 2 in the right one. Seen
/// in the header's order, a wrong-order value is ≥ 0x100 (ExifTool's rule).
fn record_reader(rec: &[u8], header_be: bool) -> Reader<'_> {
    let probe = Reader { data: rec, be: header_be };
    let flip = probe.u16(0).map_or(false, |v| v >= 0x100);
    Reader { data: rec, be: header_be != flip }
}

/// Parse the FFF container (the APP1 payload, or a .fff file).
pub fn parse_fff(fff: &[u8]) -> Result<FlirImage, String> {
    if fff.len() < 0x40 || !(fff.starts_with(b"FFF\0") || fff.starts_with(b"AFF\0")) {
        return Err("Not a FLIR FFF container".to_string());
    }
    let version_be = u32::from_be_bytes(fff[0x14..0x18].try_into().unwrap());
    let version_le = u32::from_le_bytes(fff[0x14..0x18].try_into().unwrap());
    let header_be = if (100..200).contains(&version_be) {
        true
    } else if (100..200).contains(&version_le) {
        false
    } else {
        return Err(format!("Unrecognized FLIR FFF version ({version_le})"));
    };
    let h = Reader { data: fff, be: header_be };
    let dir_off = h.u32(0x18).ok_or("Truncated FFF header")? as usize;
    let count = h.u32(0x1c).ok_or("Truncated FFF header")? as usize;
    if count == 0 || count > 1024 {
        return Err(format!("Implausible FFF record count ({count})"));
    }

    let mut raw_rec: Option<(u16, usize, usize)> = None;
    let mut info_rec: Option<(usize, usize)> = None;
    for i in 0..count {
        let e = dir_off + i * 0x20;
        let (Some(typ), Some(sub), Some(off), Some(len)) = (h.u16(e), h.u16(e + 2), h.u32(e + 0x0c), h.u32(e + 0x10))
        else {
            break; // directory runs past the data
        };
        let (off, len) = (off as usize, len as usize);
        if typ == 0 || len == 0 || off.checked_add(len).map_or(true, |end| end > fff.len()) {
            continue;
        }
        match typ {
            0x01 if raw_rec.is_none() => raw_rec = Some((sub, off, len)),
            0x20 if info_rec.is_none() => info_rec = Some((off, len)),
            _ => {}
        }
    }
    let (info_off, info_len) = info_rec.ok_or("FLIR data carries no camera info record")?;
    let info = parse_camera_info(&fff[info_off..info_off + info_len], header_be)?;
    let (sub, raw_off, raw_len) = raw_rec.ok_or("FLIR data carries no raw thermal image")?;
    let (width, height, raw) = parse_raw_data(&fff[raw_off..raw_off + raw_len], sub, header_be, &info)?;
    Ok(FlirImage { width, height, raw, info })
}

/// Parse a radiometric JPEG.
pub fn parse(jpeg: &[u8]) -> Result<FlirImage, String> {
    let fff = extract_fff(jpeg).ok_or("Not a FLIR radiometric JPEG")?;
    parse_fff(&fff)
}

fn parse_camera_info(rec: &[u8], header_be: bool) -> Result<FlirCameraInfo, String> {
    if rec.len() < 0x340 {
        return Err("FLIR camera info record is too short".to_string());
    }
    let r = record_reader(rec, header_be);
    let f = |off: usize| r.f32(off).unwrap_or(f32::NAN);
    let kelvin = |off: usize| f(off) - 273.15;
    let humidity = f(0x3c);
    let info = FlirCameraInfo {
        emissivity: f(0x20),
        object_distance_m: f(0x24),
        reflected_temp_c: kelvin(0x28),
        atmospheric_temp_c: kelvin(0x2c),
        ir_window_temp_c: kelvin(0x30),
        ir_window_transmission: f(0x34),
        // Stored as a fraction by most cameras, as a percentage by some
        relative_humidity: if humidity > 2.0 { humidity / 100.0 } else { humidity },
        planck_r1: f(0x58),
        planck_b: f(0x5c),
        planck_f: f(0x60),
        atm_alpha1: f(0x70),
        atm_alpha2: f(0x74),
        atm_beta1: f(0x78),
        atm_beta2: f(0x7c),
        atm_x: f(0x80),
        range_max_c: kelvin(0x90),
        range_min_c: kelvin(0x94),
        camera_model: r.string(0xd4, 32),
        camera_part_number: r.string(0xf4, 16),
        camera_serial: r.string(0x104, 16),
        camera_software: r.string(0x114, 16),
        lens_model: r.string(0x170, 32),
        field_of_view_deg: f(0x1b4),
        planck_o: r.i32(0x308).unwrap_or(0),
        planck_r2: f(0x30c),
        raw_value_median: r.u16(0x338).unwrap_or(0),
        raw_value_range: r.u16(0x33c).unwrap_or(0),
    };
    if !(info.planck_r1.is_finite()
        && info.planck_r1 > 0.0
        && info.planck_b.is_finite()
        && info.planck_b > 0.0
        && info.planck_f.is_finite()
        && info.planck_r2.is_finite()
        && info.planck_r2 != 0.0)
    {
        return Err("FLIR camera info carries no usable calibration constants".to_string());
    }
    Ok(info)
}

/// Median of a sample of the values (every 97th), for the byte-order check.
fn sampled_median(values: &[u16]) -> u16 {
    let mut sample: Vec<u16> = values.iter().copied().step_by(97).collect();
    if sample.is_empty() {
        return 0;
    }
    sample.sort_unstable();
    sample[sample.len() / 2]
}

/// Of the two byte orders of 16-bit samples, the one whose median lies
/// closest to the camera's RawValueMedian; `prefer_swapped` decides when the
/// camera info gives no reference.
fn choose_byte_order(raw: Vec<u16>, info: &FlirCameraInfo, prefer_swapped: bool) -> Vec<u16> {
    let swapped: Vec<u16> = raw.iter().map(|v| v.swap_bytes()).collect();
    if info.raw_value_median == 0 {
        return if prefer_swapped { swapped } else { raw };
    }
    let reference = info.raw_value_median as i64;
    let distance = |v: &[u16]| (sampled_median(v) as i64 - reference).abs();
    if distance(&swapped) < distance(&raw) {
        swapped
    } else {
        raw
    }
}

fn parse_raw_data(
    rec: &[u8],
    subtype: u16,
    header_be: bool,
    info: &FlirCameraInfo,
) -> Result<(u32, u32, Vec<u16>), String> {
    if rec.len() < 0x20 {
        return Err("FLIR raw data record is too short".to_string());
    }
    let r = record_reader(rec, header_be);
    let width = r.u16(2).unwrap_or(0) as usize;
    let height = r.u16(4).unwrap_or(0) as usize;
    if width == 0 || height == 0 || width > MAX_DIM || height > MAX_DIM {
        return Err(format!("Implausible thermal image size {width}×{height}"));
    }
    let img = &rec[0x20..];
    if img.starts_with(PNG_SIGNATURE) {
        // The IHDR dimensions come first: a crafted header must not reserve a
        // huge decode buffer before the size check
        if img.len() >= 24 {
            let w = u32::from_be_bytes([img[16], img[17], img[18], img[19]]) as usize;
            let h = u32::from_be_bytes([img[20], img[21], img[22], img[23]]) as usize;
            if w != width || h != height {
                return Err(format!("FLIR raw PNG is {w}×{h}, the record says {width}×{height}"));
            }
        }
        let decoded = image::load_from_memory_with_format(img, image::ImageFormat::Png)
            .map_err(|e| format!("Could not decode the FLIR raw PNG: {e}"))?;
        let (w, h) = (decoded.width() as usize, decoded.height() as usize);
        if w != width || h != height {
            return Err(format!("FLIR raw PNG is {w}×{h}, the record says {width}×{height}"));
        }
        // Counts are 16-bit greyscale; any other depth would be rescaled by a
        // conversion and read as nonsense temperatures
        if decoded.color() != image::ColorType::L16 {
            return Err(format!("FLIR raw PNG is {:?}, not 16-bit greyscale counts", decoded.color()));
        }
        let samples = decoded.to_luma16().into_raw();
        // Most PNG-writing FLIR cameras store the samples in the wrong byte order
        let raw = choose_byte_order(samples, info, true);
        return Ok((width as u32, height as u32, raw));
    }
    if img.len() < width * height * 2 {
        return Err(format!(
            "Unrecognized FLIR raw image format ({} bytes for {width}×{height}, subtype {subtype})",
            img.len()
        ));
    }
    // The samples are in the record's own byte order (ExifTool reads them
    // that way; the subtype is not reliable); the median check settles doubts
    let be = r.be;
    let raw: Vec<u16> = img[..width * height * 2]
        .chunks_exact(2)
        .map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
        .collect();
    Ok((width as u32, height as u32, choose_byte_order(raw, info, false)))
}

// ---------------------------------------------------------------------------
// Raw counts → temperature
// ---------------------------------------------------------------------------

/// Raw-count to temperature conversion for one picture under given
/// conditions (Thermimage's raw2temp: emissivity, reflected radiation,
/// atmospheric transmission from humidity/distance, external IR window).
pub struct RawToTemp {
    r1: f64,
    b: f64,
    f: f64,
    o: f64,
    r2: f64,
    /// Divisor of the measured signal (emissivity × transmissions).
    denominator: f64,
    /// Radiation terms subtracted from the measured signal.
    attenuation: f64,
}

impl RawToTemp {
    pub fn new(info: &FlirCameraInfo, c: &Conditions) -> Self {
        let r1 = info.planck_r1 as f64;
        let b = info.planck_b as f64;
        let f = info.planck_f as f64;
        let o = info.planck_o as f64;
        let r2 = info.planck_r2 as f64;
        // Raw signal of a blackbody at t °C
        let blackbody = |t_c: f64| r1 / (r2 * ((b / (t_c + 273.15)).exp() - f)) - o;

        let e = (c.emissivity as f64).clamp(0.01, 1.0);
        let irt = (c.ir_window_transmission as f64).clamp(0.01, 1.0);
        let rh = (c.relative_humidity as f64).clamp(0.0, 1.0);
        let ta = c.atmospheric_temp_c as f64;
        let od = (c.object_distance_m as f64).max(0.0);
        // Water vapour pressure and the atmospheric transmission over the path
        let h2o = rh * (1.5587 + 0.06939 * ta - 0.00027816 * ta * ta + 0.00000068455 * ta * ta * ta).exp();
        let s = (od / 2.0).sqrt();
        let finite = |v: f32, default: f64| if v.is_finite() { v as f64 } else { default };
        let (a1, a2, b1, b2, x) = (
            finite(info.atm_alpha1, 0.006569),
            finite(info.atm_alpha2, 0.01262),
            finite(info.atm_beta1, -0.002276),
            finite(info.atm_beta2, -0.00667),
            finite(info.atm_x, 1.9),
        );
        let tau = (x * (-s * (a1 + b1 * h2o.sqrt())).exp() + (1.0 - x) * (-s * (a2 + b2 * h2o.sqrt())).exp()).clamp(0.01, 1.0);

        let raw_refl = blackbody(c.reflected_temp_c as f64) * (1.0 - e) / e;
        let raw_atm1 = blackbody(ta) * (1.0 - tau) / (e * tau);
        let raw_wind = blackbody(c.ir_window_temp_c as f64) * (1.0 - irt) / (e * tau * irt);
        let raw_atm2 = blackbody(ta) * (1.0 - tau) / (e * tau * irt * tau);
        Self {
            r1,
            b,
            f,
            o,
            r2,
            denominator: e * tau * irt * tau,
            attenuation: raw_refl + raw_atm1 + raw_wind + raw_atm2,
        }
    }

    /// Temperature in °C of a raw count (NaN when the count is outside the
    /// calibration's domain).
    pub fn temp_c(&self, raw: u16) -> f32 {
        let obj = raw as f64 / self.denominator - self.attenuation;
        let x = self.r1 / (self.r2 * (obj + self.o)) + self.f;
        if !(x > 1.0) {
            return f32::NAN;
        }
        (self.b / x.ln() - 273.15) as f32
    }
}

/// A measured picture: temperatures plus the conditions they were computed with.
pub struct Measurement {
    pub width: u32,
    pub height: u32,
    /// °C, row-major.
    pub temps: Vec<f32>,
    pub conditions: Conditions,
}

/// Refuse overrides outside the ranges the model is meaningful for (the
/// same ranges the DJI SDK enforces), instead of clamping them silently.
pub fn validate_overrides(o: &Overrides) -> Result<(), String> {
    let check = |name: &str, v: Option<f32>, lo: f32, hi: f32| match v {
        Some(x) if !(x.is_finite() && (lo..=hi).contains(&x)) => {
            Err(format!("{name} must be between {lo} and {hi} (got {x})"))
        }
        _ => Ok(()),
    };
    check("Emissivity", o.emissivity, 0.1, 1.0)?;
    check("Distance (m)", o.object_distance_m, 0.0, 10_000.0)?;
    check("Relative humidity (%)", o.relative_humidity.map(|h| h * 100.0), 0.0, 100.0)?;
    check("Reflected temperature (°C)", o.reflected_temp_c, -50.0, 500.0)?;
    check("Atmospheric temperature (°C)", o.atmospheric_temp_c, -50.0, 500.0)?;
    Ok(())
}

/// Measure an FFF container under its stored conditions, with overrides applied.
pub fn measure_fff(fff: &[u8], overrides: &Overrides) -> Result<Measurement, String> {
    validate_overrides(overrides)?;
    let img = parse_fff(fff)?;
    let conditions = img.info.conditions().with_overrides(overrides);
    let conv = RawToTemp::new(&img.info, &conditions);
    let temps: Vec<f32> = img.raw.iter().map(|&r| conv.temp_c(r)).collect();
    Ok(Measurement { width: img.width, height: img.height, temps, conditions })
}

/// Measure a FLIR R-JPEG under its stored conditions, with overrides applied
/// (the tests' shorthand for `extract_fff` + `measure_fff`).
#[cfg(test)]
pub fn measure(jpeg: &[u8], overrides: &Overrides) -> Result<Measurement, String> {
    let fff = extract_fff(jpeg).ok_or("Not a FLIR radiometric JPEG")?;
    measure_fff(&fff, overrides)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The FLIR SC660 sample image's constants (Thermimage's IR_2412.jpg).
    fn sc660() -> FlirCameraInfo {
        FlirCameraInfo {
            emissivity: 0.95,
            object_distance_m: 1.0,
            reflected_temp_c: 20.0,
            atmospheric_temp_c: 20.0,
            ir_window_temp_c: 20.0,
            ir_window_transmission: 1.0,
            relative_humidity: 0.5,
            planck_r1: 21106.77,
            planck_b: 1501.0,
            planck_f: 1.0,
            planck_o: -7340,
            planck_r2: 0.012545258,
            atm_alpha1: 0.006569,
            atm_alpha2: 0.01262,
            atm_beta1: -0.002276,
            atm_beta2: -0.00667,
            atm_x: 1.9,
            camera_model: "FLIR SC660".into(),
            camera_part_number: "40402-3502".into(),
            camera_serial: "404003980".into(),
            camera_software: "15.0.14".into(),
            lens_model: "FOL38".into(),
            field_of_view_deg: 23.8,
            range_min_c: -40.0,
            range_max_c: 120.0,
            raw_value_median: 18604,
            raw_value_range: 1304,
        }
    }

    fn put_f32(rec: &mut [u8], off: usize, v: f32) {
        rec[off..off + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put_str(rec: &mut [u8], off: usize, s: &str) {
        rec[off..off + s.len()].copy_from_slice(s.as_bytes());
    }

    /// A camera info record in little-endian order, as the cameras write it.
    fn camera_info_record(info: &FlirCameraInfo) -> Vec<u8> {
        let mut rec = vec![0u8; 0x400];
        rec[0..2].copy_from_slice(&2u16.to_le_bytes());
        put_f32(&mut rec, 0x20, info.emissivity);
        put_f32(&mut rec, 0x24, info.object_distance_m);
        put_f32(&mut rec, 0x28, info.reflected_temp_c + 273.15);
        put_f32(&mut rec, 0x2c, info.atmospheric_temp_c + 273.15);
        put_f32(&mut rec, 0x30, info.ir_window_temp_c + 273.15);
        put_f32(&mut rec, 0x34, info.ir_window_transmission);
        put_f32(&mut rec, 0x3c, info.relative_humidity);
        put_f32(&mut rec, 0x58, info.planck_r1);
        put_f32(&mut rec, 0x5c, info.planck_b);
        put_f32(&mut rec, 0x60, info.planck_f);
        put_f32(&mut rec, 0x70, info.atm_alpha1);
        put_f32(&mut rec, 0x74, info.atm_alpha2);
        put_f32(&mut rec, 0x78, info.atm_beta1);
        put_f32(&mut rec, 0x7c, info.atm_beta2);
        put_f32(&mut rec, 0x80, info.atm_x);
        put_f32(&mut rec, 0x90, info.range_max_c + 273.15);
        put_f32(&mut rec, 0x94, info.range_min_c + 273.15);
        put_str(&mut rec, 0xd4, &info.camera_model);
        put_str(&mut rec, 0xf4, &info.camera_part_number);
        put_str(&mut rec, 0x104, &info.camera_serial);
        put_str(&mut rec, 0x114, &info.camera_software);
        put_str(&mut rec, 0x170, &info.lens_model);
        put_f32(&mut rec, 0x1b4, info.field_of_view_deg);
        rec[0x308..0x30c].copy_from_slice(&info.planck_o.to_le_bytes());
        put_f32(&mut rec, 0x30c, info.planck_r2);
        rec[0x338..0x33a].copy_from_slice(&info.raw_value_median.to_le_bytes());
        rec[0x33c..0x33e].copy_from_slice(&info.raw_value_range.to_le_bytes());
        rec
    }

    /// A raw data record: 0x20-byte header then samples (LE) or a PNG.
    fn raw_data_record(width: u16, height: u16, body: &[u8]) -> Vec<u8> {
        let mut rec = vec![0u8; 0x20];
        rec[0..2].copy_from_slice(&2u16.to_le_bytes());
        rec[2..4].copy_from_slice(&width.to_le_bytes());
        rec[4..6].copy_from_slice(&height.to_le_bytes());
        rec.extend_from_slice(body);
        rec
    }

    /// An FFF container with a big-endian header/directory and little-endian records.
    fn fff_container(info: &[u8], raw: &[u8], raw_subtype: u16) -> Vec<u8> {
        let mut fff = vec![0u8; 0x40];
        fff[0..4].copy_from_slice(b"FFF\0");
        fff[0x14..0x18].copy_from_slice(&100u32.to_be_bytes());
        fff[0x18..0x1c].copy_from_slice(&0x40u32.to_be_bytes());
        fff[0x1c..0x20].copy_from_slice(&2u32.to_be_bytes());
        let info_off = 0x40 + 2 * 0x20;
        let raw_off = info_off + info.len();
        let entry = |typ: u16, sub: u16, off: usize, len: usize| {
            let mut e = vec![0u8; 0x20];
            e[0..2].copy_from_slice(&typ.to_be_bytes());
            e[2..4].copy_from_slice(&sub.to_be_bytes());
            e[0x0c..0x10].copy_from_slice(&(off as u32).to_be_bytes());
            e[0x10..0x14].copy_from_slice(&(len as u32).to_be_bytes());
            e
        };
        fff.extend(entry(0x20, 1, info_off, info.len()));
        fff.extend(entry(0x01, raw_subtype, raw_off, raw.len()));
        fff.extend_from_slice(info);
        fff.extend_from_slice(raw);
        fff
    }

    /// Wrap an FFF container into a JPEG's APP1 "FLIR\0" chunks.
    fn jpeg_with_fff(fff: &[u8]) -> Vec<u8> {
        let chunks: Vec<&[u8]> = fff.chunks(65_000).collect();
        let mut jpeg = vec![0xFF, 0xD8];
        for (i, chunk) in chunks.iter().enumerate() {
            let payload_len = 2 + 8 + chunk.len();
            jpeg.extend_from_slice(&[0xFF, 0xE1]);
            jpeg.extend_from_slice(&(payload_len as u16).to_be_bytes());
            jpeg.extend_from_slice(b"FLIR\0\x01");
            jpeg.push(i as u8);
            jpeg.push((chunks.len() - 1) as u8);
            jpeg.extend_from_slice(chunk);
        }
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        jpeg
    }

    fn ramp(width: usize, height: usize) -> Vec<u16> {
        (0..width * height).map(|i| 17_900 + (i % 2300) as u16).collect()
    }

    #[test]
    fn parses_raw16_container_split_over_chunks() {
        let (w, h) = (320usize, 240usize);
        let raw = ramp(w, h);
        let body: Vec<u8> = raw.iter().flat_map(|v| v.to_le_bytes()).collect();
        let fff = fff_container(&camera_info_record(&sc660()), &raw_data_record(w as u16, h as u16, &body), 2);
        let jpeg = jpeg_with_fff(&fff);
        assert!(jpeg.len() > 65_000, "the test must span several APP1 chunks");
        assert!(is_flir_rjpeg(&jpeg));
        let img = parse(&jpeg).unwrap();
        assert_eq!((img.width, img.height), (320, 240));
        assert_eq!(img.raw, raw);
        let info = img.info;
        assert_eq!(info.camera_model, "FLIR SC660");
        assert_eq!(info.camera_serial, "404003980");
        assert!((info.planck_r1 - 21106.77).abs() < 0.01);
        assert_eq!(info.planck_o, -7340);
        assert!((info.planck_r2 - 0.012545258).abs() < 1e-9);
        assert!((info.reflected_temp_c - 20.0).abs() < 0.01);
        assert!((info.relative_humidity - 0.5).abs() < 1e-6);
    }

    #[test]
    fn png_samples_in_the_wrong_byte_order_are_corrected() {
        let (w, h) = (64u32, 48u32);
        let raw = ramp(w as usize, h as usize);
        // Cameras write the 16-bit PNG samples byte-swapped
        let swapped: Vec<u16> = raw.iter().map(|v| v.swap_bytes()).collect();
        let buf = image::ImageBuffer::<image::Luma<u16>, Vec<u16>>::from_raw(w, h, swapped).unwrap();
        let mut png = Vec::new();
        image::DynamicImage::ImageLuma16(buf)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let fff = fff_container(&camera_info_record(&sc660()), &raw_data_record(w as u16, h as u16, &png), 3);
        let img = parse_fff(&fff).unwrap();
        assert_eq!(img.raw, raw);
    }

    #[test]
    fn plain_and_dji_jpegs_are_not_flir() {
        assert!(!is_flir_rjpeg(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9]));
        assert!(!is_flir_rjpeg(b"not a jpeg"));
        assert!(parse(&[0xFF, 0xD8, 0xFF, 0xD9]).is_err());
    }

    #[test]
    fn blackbody_temperatures_round_trip_through_the_planck_model() {
        let info = sc660();
        // A perfect emitter through a clear window at zero distance: the
        // measured signal is the blackbody signal, so the inversion is exact
        let c = Conditions {
            emissivity: 1.0,
            object_distance_m: 0.0,
            ..info.conditions()
        };
        let conv = RawToTemp::new(&info, &c);
        for t in [-20.0f64, 0.0, 20.0, 37.0, 80.0, 120.0] {
            let r1 = info.planck_r1 as f64;
            let raw = r1 / (info.planck_r2 as f64 * ((info.planck_b as f64 / (t + 273.15)).exp() - info.planck_f as f64))
                - info.planck_o as f64;
            let back = conv.temp_c(raw.round() as u16) as f64;
            assert!((back - t).abs() < 0.05, "{t} °C came back as {back}");
        }
        // Lower emissivity reads warmer for the same count above the reflected temperature
        let realistic = RawToTemp::new(&info, &info.conditions());
        assert!(realistic.temp_c(18_426) > conv.temp_c(18_426));
        assert!(RawToTemp::new(&info, &info.conditions()).temp_c(0).is_nan());
    }

    #[test]
    fn out_of_range_overrides_are_refused_not_clamped() {
        assert!(validate_overrides(&Overrides { emissivity: Some(0.0), ..Default::default() }).is_err());
        assert!(validate_overrides(&Overrides { emissivity: Some(1.5), ..Default::default() }).is_err());
        assert!(validate_overrides(&Overrides { relative_humidity: Some(1.2), ..Default::default() }).is_err());
        assert!(validate_overrides(&Overrides { object_distance_m: Some(-1.0), ..Default::default() }).is_err());
        assert!(validate_overrides(&Overrides { emissivity: Some(0.9), relative_humidity: Some(0.7), ..Default::default() }).is_ok());
    }

    #[test]
    fn raw_samples_follow_the_record_byte_order_whatever_the_subtype() {
        let (w, h) = (64usize, 48usize);
        let raw = ramp(w, h);
        let body: Vec<u8> = raw.iter().flat_map(|v| v.to_le_bytes()).collect();
        // Subtype 1 claims big-endian; the record is little-endian and the
        // camera info gives no median to check against
        let mut info = sc660();
        info.raw_value_median = 0;
        let fff = fff_container(&camera_info_record(&info), &raw_data_record(w as u16, h as u16, &body), 1);
        assert_eq!(parse_fff(&fff).unwrap().raw, raw);
    }

    #[test]
    fn png_counts_must_be_16_bit_greyscale() {
        let (w, h) = (16u32, 16u32);
        let buf = image::ImageBuffer::<image::Luma<u8>, Vec<u8>>::from_raw(w, h, vec![7u8; 256]).unwrap();
        let mut png = Vec::new();
        image::DynamicImage::ImageLuma8(buf)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let fff = fff_container(&camera_info_record(&sc660()), &raw_data_record(w as u16, h as u16, &png), 3);
        assert!(parse_fff(&fff).is_err());
    }

    /// Validates the parser against a real camera file when one is at hand
    /// (`ODL_FLIR_SAMPLE` = path to Thermimage's IR_2412.jpg, a FLIR SC660).
    #[test]
    fn real_sc660_sample_when_available() {
        let Ok(path) = std::env::var("ODL_FLIR_SAMPLE") else { return };
        let jpeg = std::fs::read(&path).expect("sample readable");
        let img = parse(&jpeg).unwrap();
        assert_eq!((img.width, img.height), (640, 480));
        assert_eq!(img.info.camera_model, "FLIR SC660");
        assert!((img.info.planck_r1 - 21106.77).abs() < 0.01);
        assert_eq!(img.info.planck_o, -7340);
        let m = measure(&jpeg, &Overrides::default()).unwrap();
        assert_eq!((m.width, m.height), (640, 480));
        let finite: Vec<f32> = m.temps.iter().copied().filter(|t| t.is_finite()).collect();
        assert_eq!(finite.len(), m.temps.len());
        let (mn, mx) = finite.iter().fold((f32::MAX, f32::MIN), |(a, b), &t| (a.min(t), b.max(t)));
        // An indoor scene on a 640×480 SC660: room temperature to warm objects
        assert!(mn > -10.0 && mx < 60.0 && mx > mn + 3.0, "range {mn}..{mx}");
    }
}
