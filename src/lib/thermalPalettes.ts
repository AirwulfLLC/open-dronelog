/**
 * Thermal pseudo-color palettes and canvas rendering helpers.
 *
 * Palettes are defined as gradient stops and expanded to 256-entry LUTs.
 * Rendering maps each temperature to a LUT index over a configurable
 * [low, high] span, with optional isotherm highlighting for a user range.
 */

export interface PaletteDef {
  key: string;
  label: string;
  /** Gradient stops: [position 0..1, r, g, b] */
  stops: Array<[number, number, number, number]>;
}

export const PALETTES: PaletteDef[] = [
  {
    key: 'iron',
    label: 'Iron Red',
    stops: [
      [0.0, 0, 0, 20],
      [0.15, 32, 0, 100],
      [0.35, 130, 10, 120],
      [0.55, 200, 60, 50],
      [0.75, 245, 145, 20],
      [0.9, 255, 220, 60],
      [1.0, 255, 255, 230],
    ],
  },
  {
    key: 'white_hot',
    label: 'White Hot',
    stops: [
      [0.0, 0, 0, 0],
      [1.0, 255, 255, 255],
    ],
  },
  {
    key: 'black_hot',
    label: 'Black Hot',
    stops: [
      [0.0, 255, 255, 255],
      [1.0, 0, 0, 0],
    ],
  },
  {
    key: 'rainbow',
    label: 'Rainbow',
    stops: [
      [0.0, 10, 0, 80],
      [0.2, 0, 60, 220],
      [0.4, 0, 190, 190],
      [0.6, 60, 210, 40],
      [0.8, 250, 210, 0],
      [1.0, 250, 30, 20],
    ],
  },
  {
    key: 'arctic',
    label: 'Arctic',
    stops: [
      [0.0, 10, 20, 60],
      [0.35, 30, 90, 180],
      [0.6, 90, 190, 220],
      [0.8, 230, 240, 245],
      [1.0, 255, 140, 60],
    ],
  },
  {
    key: 'medical',
    label: 'Medical',
    stops: [
      [0.0, 20, 0, 40],
      [0.25, 0, 80, 160],
      [0.5, 0, 180, 120],
      [0.7, 240, 220, 0],
      [0.85, 250, 120, 0],
      [1.0, 255, 0, 60],
    ],
  },
];

const lutCache = new Map<string, Uint8ClampedArray>();

/** Expand a palette to a 256*3 LUT (cached). */
export function paletteLut(key: string): Uint8ClampedArray {
  const cached = lutCache.get(key);
  if (cached) return cached;
  const def = PALETTES.find((p) => p.key === key) ?? PALETTES[0];
  const lut = new Uint8ClampedArray(256 * 3);
  const stops = def.stops;
  for (let i = 0; i < 256; i++) {
    const pos = i / 255;
    // Find surrounding stops
    let s0 = stops[0];
    let s1 = stops[stops.length - 1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (pos >= stops[j][0] && pos <= stops[j + 1][0]) {
        s0 = stops[j];
        s1 = stops[j + 1];
        break;
      }
    }
    const span = s1[0] - s0[0] || 1;
    const f = (pos - s0[0]) / span;
    lut[i * 3] = s0[1] + (s1[1] - s0[1]) * f;
    lut[i * 3 + 1] = s0[2] + (s1[2] - s0[2]) * f;
    lut[i * 3 + 2] = s0[3] + (s1[3] - s0[3]) * f;
  }
  lutCache.set(key, lut);
  return lut;
}

export interface RenderOptions {
  paletteKey: string;
  /** Temperature span mapped to the palette; defaults to matrix min/max. */
  spanLow?: number;
  spanHigh?: number;
  /** Isotherm: when set, pixels inside [low, high] are highlighted and the
   *  rest is rendered dimmed/grayscale. */
  isotherm?: { low: number; high: number; mode: 'highlight' | 'solo' } | null;
}

/**
 * Render a temperature matrix into an ImageData buffer.
 */
export function renderTempsToImageData(
  temps: Float32Array,
  width: number,
  height: number,
  opts: RenderOptions,
): ImageData {
  const lut = paletteLut(opts.paletteKey);
  let lo = opts.spanLow ?? Infinity;
  let hi = opts.spanHigh ?? -Infinity;
  if (!isFinite(lo) || !isFinite(hi)) {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < temps.length; i++) {
      const t = temps[i];
      if (t < mn) mn = t;
      if (t > mx) mx = t;
    }
    if (!isFinite(opts.spanLow ?? NaN)) lo = mn;
    if (!isFinite(opts.spanHigh ?? NaN)) hi = mx;
  }
  const span = hi - lo || 0.1;
  const iso = opts.isotherm ?? null;

  const img = new ImageData(width, height);
  const data = img.data;
  for (let i = 0; i < temps.length; i++) {
    const t = temps[i];
    let idx = Math.round(((t - lo) / span) * 255);
    idx = idx < 0 ? 0 : idx > 255 ? 255 : idx;
    const o = i * 4;
    const inRange = iso ? t >= iso.low && t <= iso.high : true;
    if (!iso || inRange) {
      data[o] = lut[idx * 3];
      data[o + 1] = lut[idx * 3 + 1];
      data[o + 2] = lut[idx * 3 + 2];
      data[o + 3] = 255;
    } else if (iso.mode === 'highlight') {
      // Out-of-range: dim grayscale so highlighted range pops
      const g = Math.round(30 + (idx / 255) * 120);
      data[o] = g;
      data[o + 1] = g;
      data[o + 2] = g;
      data[o + 3] = 255;
    } else {
      // solo mode: out-of-range fully dark
      data[o] = 12;
      data[o + 1] = 14;
      data[o + 2] = 18;
      data[o + 3] = 255;
    }
  }
  return img;
}

/** Compute stats for the pixels inside a temperature range (for isotherm panel). */
export function rangeStats(
  temps: Float32Array,
  low: number,
  high: number,
): { count: number; pct: number; min: number; max: number; mean: number } {
  let count = 0;
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  for (let i = 0; i < temps.length; i++) {
    const t = temps[i];
    if (t >= low && t <= high) {
      count++;
      if (t < mn) mn = t;
      if (t > mx) mx = t;
      sum += t;
    }
  }
  return {
    count,
    pct: temps.length ? (count / temps.length) * 100 : 0,
    min: count ? mn : NaN,
    max: count ? mx : NaN,
    mean: count ? sum / count : NaN,
  };
}

/** Render a horizontal color-bar gradient for a palette into a canvas. */
export function drawColorBar(canvas: HTMLCanvasElement, paletteKey: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  const lut = paletteLut(paletteKey);
  const img = ctx.createImageData(width, height);
  for (let x = 0; x < width; x++) {
    const idx = Math.round((x / (width - 1 || 1)) * 255);
    for (let y = 0; y < height; y++) {
      const o = (y * width + x) * 4;
      img.data[o] = lut[idx * 3];
      img.data[o + 1] = lut[idx * 3 + 1];
      img.data[o + 2] = lut[idx * 3 + 2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function formatTemp(t: number | null | undefined, unit: 'C' | 'F' = 'C'): string {
  if (t == null || Number.isNaN(t)) return '—';
  const v = unit === 'F' ? t * 1.8 + 32 : t;
  return `${v.toFixed(1)}°${unit}`;
}
