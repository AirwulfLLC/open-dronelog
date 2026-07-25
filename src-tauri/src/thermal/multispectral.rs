//! Multispectral imagery support for Metashape orthomosaics.
//!
//! Multispectral drone cameras (DJI Mavic 3M, P4 Multispectral, MicaSense
//! RedEdge/Altum…) produce N-band GeoTIFFs — per-band reflectance planes
//! (Blue/Green/Red/RedEdge/NIR, sometimes thermal) that the `image` crate
//! cannot decode. This module reads band planes directly with the `tiff`
//! crate, builds RGB composite previews, and computes vegetation index
//! rasters (NDVI and arbitrary user-defined formulas) over mapped bands.

use std::collections::HashMap;
use std::io::Cursor;

/// Per-band planes of a multiband raster, as f32.
pub struct BandStack {
    pub width: u32,
    pub height: u32,
    /// One plane per band, row-major, length = width*height each.
    pub bands: Vec<Vec<f32>>,
    pub bits_per_sample: u8,
}

const MAX_PIXELS: u64 = 268_435_456; // 16384×16384
/// Cap on total samples (pixels × bands): bounds the decode buffer AND the
/// two f32 copies this module makes (~16 bytes/sample worst case ≈ 6 GB peak).
const MAX_TOTAL_SAMPLES: u64 = 402_653_184; // 384M
/// Decoder allocation cap handed to the tiff crate (replaces the dangerous
/// `Limits::unlimited()`, which disabled protection against hostile headers).
const MAX_DECODE_BYTES: usize = 3_758_096_384; // 3.5 GiB

fn bounded_limits() -> tiff::decoder::Limits {
    let mut limits = tiff::decoder::Limits::default();
    limits.decoding_buffer_size = MAX_DECODE_BYTES;
    limits.intermediate_buffer_size = MAX_DECODE_BYTES;
    limits
}

/// Read every band of a TIFF into f32 planes.
pub fn read_bands(bytes: &[u8]) -> Result<BandStack, String> {
    let mut decoder = tiff::decoder::Decoder::new(Cursor::new(bytes))
        .map_err(|e| format!("Could not open TIFF: {e}"))?
        .with_limits(bounded_limits());
    let (width, height) = decoder
        .dimensions()
        .map_err(|e| format!("Could not read TIFF dimensions: {e}"))?;
    if (width as u64) * (height as u64) > MAX_PIXELS {
        return Err(format!(
            "Raster too large ({width}×{height}) — export a smaller region from Metashape"
        ));
    }
    let samples = decoder
        .find_tag(tiff::tags::Tag::SamplesPerPixel)
        .ok()
        .flatten()
        .and_then(|v| v.into_u16().ok())
        .unwrap_or(1) as usize;
    if samples == 0 || samples > 16 {
        return Err(format!("Unsupported band count: {samples}"));
    }
    if (width as u64) * (height as u64) * (samples as u64) > MAX_TOTAL_SAMPLES {
        return Err(format!(
            "Raster too large ({width}×{height}×{samples} bands) — export a smaller \
             region or fewer bands from Metashape"
        ));
    }
    // tiff 0.9's read_image silently decodes only the FIRST band of
    // band-sequential (PlanarConfiguration=2) files — reject them with an
    // actionable message instead of misreporting the file as truncated.
    let planar = decoder
        .find_tag(tiff::tags::Tag::PlanarConfiguration)
        .ok()
        .flatten()
        .and_then(|v| v.into_u16().ok())
        .unwrap_or(1);
    if planar == 2 && samples > 1 {
        return Err(
            "Band-sequential (planar) TIFF layout is not supported — re-export with \
             pixel interleave (Metashape default, or gdal_translate -co INTERLEAVE=PIXEL)"
                .to_string(),
        );
    }

    let img = decoder
        .read_image()
        .map_err(|e| format!("Could not decode TIFF data: {e}"))?;

    // Interleaved samples → planar f32 bands
    let px = (width as usize) * (height as usize);
    let (interleaved, bits): (Vec<f32>, u8) = match img {
        tiff::decoder::DecodingResult::U8(v) => (v.into_iter().map(|x| x as f32).collect(), 8),
        tiff::decoder::DecodingResult::U16(v) => (v.into_iter().map(|x| x as f32).collect(), 16),
        tiff::decoder::DecodingResult::U32(v) => (v.into_iter().map(|x| x as f32).collect(), 32),
        tiff::decoder::DecodingResult::I8(v) => (v.into_iter().map(|x| x as f32).collect(), 8),
        tiff::decoder::DecodingResult::I16(v) => (v.into_iter().map(|x| x as f32).collect(), 16),
        tiff::decoder::DecodingResult::I32(v) => (v.into_iter().map(|x| x as f32).collect(), 32),
        tiff::decoder::DecodingResult::F32(v) => (v, 32),
        tiff::decoder::DecodingResult::F64(v) => (v.into_iter().map(|x| x as f32).collect(), 32),
        _ => return Err("Unsupported TIFF sample format".to_string()),
    };
    if interleaved.len() < px * samples {
        return Err(format!(
            "TIFF data truncated: {} samples for {}×{}×{}",
            interleaved.len(),
            width,
            height,
            samples
        ));
    }

    let mut bands: Vec<Vec<f32>> = (0..samples).map(|_| Vec::with_capacity(px)).collect();
    for chunk in interleaved.chunks_exact(samples).take(px) {
        for (b, &v) in chunk.iter().enumerate() {
            bands[b].push(v);
        }
    }

    Ok(BandStack {
        width,
        height,
        bands,
        bits_per_sample: bits,
    })
}

/// Number of bands in a TIFF without decoding pixel data.
pub fn probe_band_count(bytes: &[u8]) -> Option<usize> {
    let mut decoder = tiff::decoder::Decoder::new(Cursor::new(bytes)).ok()?;
    decoder
        .find_tag(tiff::tags::Tag::SamplesPerPixel)
        .ok()
        .flatten()
        .and_then(|v| v.into_u16().ok())
        .map(|s| s as usize)
}

/// True when the TIFF declares extra (alpha) samples — distinguishes a
/// 4-band RGBA photo from a 4-band multispectral raster.
pub fn probe_has_alpha(bytes: &[u8]) -> bool {
    let Ok(mut decoder) = tiff::decoder::Decoder::new(Cursor::new(bytes)) else {
        return false;
    };
    match decoder.find_tag(tiff::tags::Tag::ExtraSamples) {
        Ok(Some(v)) => match v.into_u16_vec() {
            Ok(list) => !list.is_empty(),
            Err(_) => true, // tag present but odd shape — assume alpha
        },
        _ => false,
    }
}

fn normalize_plane(plane: &[f32]) -> Vec<u8> {
    let (mut min, mut max) = (f32::INFINITY, f32::NEG_INFINITY);
    for &v in plane {
        if v.is_finite() {
            min = min.min(v);
            max = max.max(v);
        }
    }
    let span = (max - min).max(1e-6);
    plane
        .iter()
        .map(|&v| {
            if v.is_finite() {
                (((v - min) / span) * 255.0).clamp(0.0, 255.0) as u8
            } else {
                0
            }
        })
        .collect()
}

/// Build an RGB composite preview PNG from the first three bands
/// (grayscale for single-band stacks) and save it next to the original.
/// Returns the preview file name.
pub fn generate_composite_preview(
    stack: &BandStack,
    dest_dir: &std::path::Path,
    base_name: &str,
) -> Result<String, String> {
    let (w, h) = (stack.width, stack.height);
    let img = if stack.bands.len() >= 3 {
        // Multispectral exports are commonly band-ordered B,G,R,… — use
        // bands (2,1,0) as R,G,B for a natural-ish composite.
        let r = normalize_plane(&stack.bands[2]);
        let g = normalize_plane(&stack.bands[1]);
        let b = normalize_plane(&stack.bands[0]);
        let mut buf = Vec::with_capacity((w * h * 3) as usize);
        for i in 0..(w * h) as usize {
            buf.extend_from_slice(&[r[i], g[i], b[i]]);
        }
        image::DynamicImage::ImageRgb8(
            image::RgbImage::from_raw(w, h, buf).ok_or("Composite buffer size mismatch")?,
        )
    } else {
        let gray = normalize_plane(&stack.bands[0]);
        image::DynamicImage::ImageLuma8(
            image::GrayImage::from_raw(w, h, gray).ok_or("Gray buffer size mismatch")?,
        )
    };

    let img = if w.max(h) > 4096 {
        img.resize(4096, 4096, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let preview_name = format!("{base_name}_preview.png");
    img.save_with_format(dest_dir.join(&preview_name), image::ImageFormat::Png)
        .map_err(|e| format!("Could not write composite preview: {e}"))?;
    Ok(preview_name)
}

// ============================================================================
// Vegetation index formulas — tiny arithmetic expression evaluator
// ============================================================================

#[derive(Debug, Clone)]
pub enum Expr {
    Num(f32),
    /// Band plane index (resolved from the variable name at parse time).
    Band(usize),
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    Div(Box<Expr>, Box<Expr>),
    Neg(Box<Expr>),
}

impl Expr {
    /// Evaluate at one pixel; `px[b]` is band b's value.
    pub fn eval(&self, px: &[f32]) -> f32 {
        match self {
            Expr::Num(n) => *n,
            Expr::Band(b) => px.get(*b).copied().unwrap_or(f32::NAN),
            Expr::Add(a, b) => a.eval(px) + b.eval(px),
            Expr::Sub(a, b) => a.eval(px) - b.eval(px),
            Expr::Mul(a, b) => a.eval(px) * b.eval(px),
            Expr::Div(a, b) => {
                let d = b.eval(px);
                if d.abs() < 1e-9 {
                    f32::NAN
                } else {
                    a.eval(px) / d
                }
            }
            Expr::Neg(a) => -a.eval(px),
        }
    }
}

const MAX_FORMULA_LEN: usize = 512;
const MAX_FORMULA_DEPTH: usize = 64;

struct Parser<'a> {
    tokens: Vec<Token>,
    pos: usize,
    depth: usize,
    vars: &'a HashMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f32),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    LParen,
    RParen,
}

fn tokenize(formula: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = formula.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\r' | '\n' => i += 1,
            '+' => {
                tokens.push(Token::Plus);
                i += 1;
            }
            '-' | '−' => {
                tokens.push(Token::Minus);
                i += 1;
            }
            '*' | '×' => {
                tokens.push(Token::Star);
                i += 1;
            }
            '/' | '÷' => {
                tokens.push(Token::Slash);
                i += 1;
            }
            '(' => {
                tokens.push(Token::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(Token::RParen);
                i += 1;
            }
            '0'..='9' | '.' => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                let s: String = chars[start..i].iter().collect();
                tokens.push(Token::Num(
                    s.parse().map_err(|_| format!("Invalid number '{s}'"))?,
                ));
            }
            c if c.is_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                tokens.push(Token::Ident(chars[start..i].iter().collect()));
            }
            other => return Err(format!("Unexpected character '{other}' in formula")),
        }
    }
    Ok(tokens)
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }
    fn next(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    // expr := term (('+' | '-') term)*
    fn expr(&mut self) -> Result<Expr, String> {
        let mut left = self.term()?;
        while let Some(op) = self.peek().cloned() {
            match op {
                Token::Plus => {
                    self.next();
                    left = Expr::Add(Box::new(left), Box::new(self.term()?));
                }
                Token::Minus => {
                    self.next();
                    left = Expr::Sub(Box::new(left), Box::new(self.term()?));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    // term := factor (('*' | '/') factor)*
    fn term(&mut self) -> Result<Expr, String> {
        let mut left = self.factor()?;
        while let Some(op) = self.peek().cloned() {
            match op {
                Token::Star => {
                    self.next();
                    left = Expr::Mul(Box::new(left), Box::new(self.factor()?));
                }
                Token::Slash => {
                    self.next();
                    left = Expr::Div(Box::new(left), Box::new(self.factor()?));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    // factor := NUM | IDENT | '(' expr ')' | '-' factor
    fn factor(&mut self) -> Result<Expr, String> {
        // Bound recursion so a pathological formula (e.g. thousands of nested
        // parens or unary minuses) errors instead of overflowing the stack.
        self.depth += 1;
        if self.depth > MAX_FORMULA_DEPTH {
            return Err(format!("Formula too deeply nested (limit {MAX_FORMULA_DEPTH})"));
        }
        let result = self.factor_inner();
        self.depth -= 1;
        result
    }

    fn factor_inner(&mut self) -> Result<Expr, String> {
        match self.next() {
            Some(Token::Num(n)) => Ok(Expr::Num(n)),
            Some(Token::Ident(name)) => {
                let key = name.to_ascii_uppercase();
                self.vars
                    .get(&key)
                    .map(|&b| Expr::Band(b))
                    .ok_or_else(|| {
                        let mut known: Vec<&String> = self.vars.keys().collect();
                        known.sort();
                        format!(
                            "Unknown band '{name}' — mapped bands: {}",
                            known.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                        )
                    })
            }
            Some(Token::LParen) => {
                let e = self.expr()?;
                match self.next() {
                    Some(Token::RParen) => Ok(e),
                    _ => Err("Missing closing parenthesis".to_string()),
                }
            }
            Some(Token::Minus) => Ok(Expr::Neg(Box::new(self.factor()?))),
            other => Err(format!("Unexpected token in formula: {other:?}")),
        }
    }
}

/// Parse a formula like "(NIR - R) / (NIR + R)" against a band mapping
/// (uppercase variable name → band index).
pub fn parse_formula(formula: &str, vars: &HashMap<String, usize>) -> Result<Expr, String> {
    if formula.len() > MAX_FORMULA_LEN {
        return Err(format!("Formula too long (limit {MAX_FORMULA_LEN} characters)"));
    }
    let tokens = tokenize(formula)?;
    if tokens.is_empty() {
        return Err("Formula is empty".to_string());
    }
    let mut parser = Parser { tokens, pos: 0, depth: 0, vars };
    let expr = parser.expr()?;
    if parser.pos != parser.tokens.len() {
        return Err("Unexpected trailing input in formula".to_string());
    }
    Ok(expr)
}

/// Compute an index raster over the band stack. NaN marks nodata.
pub fn compute_index(stack: &BandStack, expr: &Expr) -> Vec<f32> {
    let px_count = (stack.width as usize) * (stack.height as usize);
    let n_bands = stack.bands.len();
    let mut out = Vec::with_capacity(px_count);
    let mut px = vec![0f32; n_bands];
    for i in 0..px_count {
        for b in 0..n_bands {
            px[b] = stack.bands[b][i];
        }
        out.push(expr.eval(&px));
    }
    out
}

/// Classic red→yellow→green vegetation-index color ramp.
fn ramp_color(t: f32) -> [u8; 3] {
    // t in [0,1]; 0 = red (#a50026), 0.5 = yellow (#ffffbf), 1 = green (#006837)
    let t = t.clamp(0.0, 1.0);
    let lerp = |a: f32, b: f32, f: f32| (a + (b - a) * f) as u8;
    if t < 0.5 {
        let f = t * 2.0;
        [lerp(165.0, 255.0, f), lerp(0.0, 255.0, f), lerp(38.0, 191.0, f)]
    } else {
        let f = (t - 0.5) * 2.0;
        [lerp(255.0, 0.0, f), lerp(255.0, 104.0, f), lerp(191.0, 55.0, f)]
    }
}

pub struct IndexRender {
    pub png: image::DynamicImage,
    pub min: f32,
    pub max: f32,
    pub mean: f32,
    /// Display range used for the color ramp.
    pub range: (f32, f32),
}

/// Render an index raster to a colormapped RGBA image (NaN → transparent).
/// Normalized-difference indices use the fixed [-1, 1] range; anything wider
/// falls back to min–max.
pub fn render_index(raster: &[f32], width: u32, height: u32) -> Result<IndexRender, String> {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut sum = 0f64;
    let mut n = 0usize;
    for &v in raster {
        if v.is_finite() {
            min = min.min(v);
            max = max.max(v);
            sum += v as f64;
            n += 1;
        }
    }
    if n == 0 {
        return Err("Index has no valid pixels (all nodata)".to_string());
    }
    let mean = (sum / n as f64) as f32;
    let range = if min >= -1.2 && max <= 1.2 {
        (-1.0f32, 1.0f32)
    } else {
        (min, max)
    };
    let span = (range.1 - range.0).max(1e-6);

    let mut buf = Vec::with_capacity(raster.len() * 4);
    for &v in raster {
        if v.is_finite() {
            let [r, g, b] = ramp_color((v - range.0) / span);
            buf.extend_from_slice(&[r, g, b, 255]);
        } else {
            buf.extend_from_slice(&[0, 0, 0, 0]);
        }
    }
    let img = image::RgbaImage::from_raw(width, height, buf)
        .ok_or("Index render buffer size mismatch")?;
    Ok(IndexRender {
        png: image::DynamicImage::ImageRgba8(img),
        min,
        max,
        mean,
        range,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> HashMap<String, usize> {
        HashMap::from([("R".to_string(), 0), ("NIR".to_string(), 1)])
    }

    #[test]
    fn parses_and_evaluates_ndvi() {
        let expr = parse_formula("(NIR - R) / (NIR + R)", &vars()).unwrap();
        // R = 0.2, NIR = 0.6 → NDVI = 0.4/0.8 = 0.5
        let v = expr.eval(&[0.2, 0.6]);
        assert!((v - 0.5).abs() < 1e-6, "{v}");
    }

    #[test]
    fn handles_constants_unary_and_case() {
        let expr = parse_formula("1.5 * (nir - r) / (NIR + R + 0.5)", &vars()).unwrap();
        let v = expr.eval(&[0.2, 0.6]); // SAVI: 1.5*0.4/1.3
        assert!((v - 1.5 * 0.4 / 1.3).abs() < 1e-6, "{v}");
        let neg = parse_formula("-R", &vars()).unwrap();
        assert!((neg.eval(&[0.25, 0.0]) + 0.25).abs() < 1e-6);
    }

    #[test]
    fn division_by_zero_is_nodata() {
        let expr = parse_formula("(NIR - R) / (NIR + R)", &vars()).unwrap();
        assert!(expr.eval(&[0.0, 0.0]).is_nan());
    }

    #[test]
    fn rejects_bad_formulas() {
        assert!(parse_formula("", &vars()).is_err());
        assert!(parse_formula("(NIR - R", &vars()).is_err());
        assert!(parse_formula("NIR + BOGUS", &vars()).is_err());
        assert!(parse_formula("NIR R", &vars()).is_err());
        assert!(parse_formula("2..5 + R", &vars()).is_err());
    }

    #[test]
    fn rejects_pathological_formulas() {
        // Deep nesting and giant inputs must error, not overflow the stack
        let deep = format!("{}R{}", "(".repeat(100), ")".repeat(100));
        assert!(parse_formula(&deep, &vars()).is_err());
        let minuses = format!("{}R", "-".repeat(100));
        assert!(parse_formula(&minuses, &vars()).is_err());
        let long = format!("{}R", "R+".repeat(400));
        assert!(parse_formula(&long, &vars()).is_err());
        // Sane nesting still parses
        let ok = parse_formula("-(((NIR - R) / (NIR + R)))", &vars()).unwrap();
        assert!((ok.eval(&[0.2, 0.6]) + 0.5).abs() < 1e-6);
    }

    #[test]
    fn multiband_roundtrip_and_index() {
        // Build a 3-band (R, NIR, extra) u16 TIFF via the tiff encoder…
        // the image crate can't write >4-band TIFFs, so exercise our reader
        // against an RGB16 image treated as bands.
        let (w, h) = (8u32, 4u32);
        let mut rgb = image::ImageBuffer::<image::Rgb<u16>, Vec<u16>>::new(w, h);
        for (x, _y, p) in rgb.enumerate_pixels_mut() {
            *p = image::Rgb([(x * 1000) as u16, 20000, 40000]);
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb16(rgb)
            .write_to(&mut buf, image::ImageFormat::Tiff)
            .unwrap();

        let stack = read_bands(buf.get_ref()).unwrap();
        assert_eq!(stack.bands.len(), 3);
        assert_eq!((stack.width, stack.height), (w, h));
        assert_eq!(stack.bands[1][0], 20000.0);

        // NDVI with R=band0, NIR=band2
        let vars = HashMap::from([("R".to_string(), 0), ("NIR".to_string(), 2)]);
        let expr = parse_formula("(NIR-R)/(NIR+R)", &vars).unwrap();
        let raster = compute_index(&stack, &expr);
        assert_eq!(raster.len(), (w * h) as usize);
        // x=0: R=0, NIR=40000 → 1.0
        assert!((raster[0] - 1.0).abs() < 1e-6);

        let render = render_index(&raster, w, h).unwrap();
        assert!(render.max <= 1.0 + 1e-6);
        assert_eq!(render.range, (-1.0, 1.0));
    }
}
