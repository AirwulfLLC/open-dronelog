/**
 * Offscreen composition of Photogrammetry Imagery report figures: each queued
 * photo (or video frame) is rendered with its annotations burned in and
 * downscaled, so the report never depends on what the viewer currently shows.
 */

import * as thermalApi from '@/lib/thermalApi';
import { drawAnnotationsToCanvas } from '@/components/thermal/annotationUtils';
import { previewMimeType } from '@/types/thermal';
import type { Annotation, PhotogrammetryEntry, ThermalAsset } from '@/types/thermal';

export interface PhotogrammetryFigure {
  entryId: string;
  /** The pictured asset (null when it is no longer in the library). */
  assetId: number | null;
  /** JPEG data URL, or null when the asset is missing or could not be decoded. */
  dataUrl: string | null;
  caption: string;
  /** Source line: file name, capture time, position, video frame time. */
  details: string;
  /** The picture's note (ThermalAsset.notes) at preparation time. */
  note: string | null;
  /** height / width of the figure. */
  aspect: number;
}

/** Longest edge of an exported figure (px). 20 MP photos would otherwise
 *  make a ten-figure PDF hundreds of MB. */
const MAX_EXPORT_EDGE = 2000;
const JPEG_QUALITY = 0.88;
const VIDEO_DECODE_TIMEOUT_MS = 20000;

export function fmtFrameTime(seconds: number | undefined): string {
  const s = seconds ?? 0;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** One-line provenance for a figure. */
export function figureDetails(asset: ThermalAsset, entry: PhotogrammetryEntry): string {
  return [
    asset.fileName,
    asset.assetType === 'video' ? `frame at ${fmtFrameTime(entry.frameTimeS)}` : null,
    asset.capturedAt,
    asset.cameraModel,
    asset.gpsLat != null && asset.gpsLon != null
      ? `${asset.gpsLat.toFixed(6)}, ${asset.gpsLon.toFixed(6)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = url;
  });
}

/** Decode a video offscreen and park it on the requested frame. */
function seekVideoFrame(url: string, timeS: number): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out decoding the video frame'));
    }, VIDEO_DECODE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Video could not be decoded'));
    };
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const target = Math.min(Math.max(0, timeS), Math.max(0, duration - 0.05));
      video.onseeked = () => {
        cleanup();
        resolve(video);
      };
      // A fresh element already sits at 0; seeking to a hair past it
      // guarantees a `seeked` event in every engine.
      video.currentTime = target > 0 ? target : 0.001;
    };
    video.src = url;
    video.load();
  });
}

function drawComposite(
  source: CanvasImageSource,
  w: number,
  h: number,
  annotations: Annotation[],
): { dataUrl: string; aspect: number } | null {
  if (w <= 0 || h <= 0) return null;
  const scale = Math.min(1, MAX_EXPORT_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  // Annotations are stored in source-pixel coordinates
  ctx.save();
  ctx.scale(scale, scale);
  drawAnnotationsToCanvas(ctx, annotations);
  ctx.restore();
  return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), aspect: h / w };
}

/** Render one asset (photo, or the video frame at `frameTimeS`) with its
 *  annotations. Returns null when the media cannot be decoded. */
export async function composeFigure(
  asset: ThermalAsset,
  annotations: Annotation[],
  frameTimeS?: number,
): Promise<{ dataUrl: string; aspect: number } | null> {
  const isVideo = asset.assetType === 'video';
  const bytes = isVideo
    ? await thermalApi.readThermalAssetFile(asset.id)
    : await thermalApi.readThermalAssetPreview(asset.id);
  // Images come from the preview endpoint (GeoTIFFs as PNG), videos as the original file
  const url = URL.createObjectURL(new Blob([bytes], { type: previewMimeType(asset) }));
  try {
    if (isVideo) {
      const video = await seekVideoFrame(url, frameTimeS ?? 0);
      try {
        return drawComposite(video, video.videoWidth, video.videoHeight, annotations);
      } finally {
        // Release the decoder and the Blob now rather than at GC — a queue of
        // several large videos would otherwise pile up during one export.
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    }
    const img = await loadImage(url);
    return drawComposite(img, img.naturalWidth, img.naturalHeight, annotations);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A picture's stored annotations ([] when none or unreadable). */
export async function loadAssetAnnotations(assetId: number): Promise<Annotation[]> {
  try {
    const json = await thermalApi.getThermalAnnotations(assetId);
    if (!json) return [];
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Annotation[]) : [];
  } catch {
    return [];
  }
}

/** Compose every queued entry, in queue order. Entries whose asset is gone or
 *  undecodable still produce a figure (without image) so the report shows the
 *  gap instead of silently renumbering. */
export async function buildPhotogrammetryFigures(
  entries: PhotogrammetryEntry[],
  assets: ThermalAsset[],
): Promise<PhotogrammetryFigure[]> {
  const figures: PhotogrammetryFigure[] = [];
  for (const entry of entries) {
    const asset = assets.find((a) => a.id === entry.assetId);
    if (!asset) {
      figures.push({
        entryId: entry.id,
        assetId: null,
        dataUrl: null,
        caption: entry.caption,
        details: 'Asset is no longer in the library',
        note: null,
        aspect: 0.75,
      });
      continue;
    }
    let composed: { dataUrl: string; aspect: number } | null = null;
    try {
      composed = await composeFigure(asset, await loadAssetAnnotations(asset.id), entry.frameTimeS);
    } catch (e) {
      console.warn(`Photogrammetry figure for "${asset.fileName}" could not be rendered:`, e);
    }
    figures.push({
      entryId: entry.id,
      assetId: asset.id,
      dataUrl: composed?.dataUrl ?? null,
      caption: entry.caption,
      details: figureDetails(asset, entry),
      note: asset.notes,
      aspect: composed?.aspect ?? 0.75,
    });
  }
  return figures;
}
