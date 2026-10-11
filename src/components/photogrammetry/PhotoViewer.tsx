/**
 * PhotoViewer — shows a photogrammetry photo or video with an SVG annotation
 * layer (arrow, text, freehand, ellipse, rectangle; select/move, Delete to
 * remove) in image-pixel coordinates, so annotations line up with the report
 * export regardless of the on-screen size.
 *
 * Videos keep their native controls: the overlay stays mounted (annotations
 * remain visible) but in Select mode only the drawn shapes take the pointer,
 * so clicks on empty areas reach the player. The current frame can be queued
 * for the report or captured as a new photo.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePhotogrammetryStore } from '@/stores/photogrammetryStore';
import {
  AnnotationShape,
  eraseAt,
  eraserRadiusFor,
  hitTest,
  isDegenerateAnnotation,
  nextAnnotationId,
  translateAnnotation,
} from '@/components/thermal/annotationUtils';
import { fmtFrameTime } from '@/lib/photogrammetryExport';
import type { Annotation, ThermalAsset } from '@/types/thermal';

interface Props {
  asset: ThermalAsset;
  assetUrl: string | null;
  /** Receives a PNG of the current video frame (imported as a new photo). */
  onCaptureFrame?: (blob: Blob) => void;
  /** Receives the playback time to queue that frame for the report. */
  onAddFrame?: (timeS: number) => void;
  /** Playback position updates, for snapping queue entries to a frame. */
  onVideoTime?: (timeS: number) => void;
}

export function PhotoViewer({ asset, assetUrl, onCaptureFrame, onAddFrame, onVideoTime }: Props) {
  const {
    annotations,
    annotationTool,
    annotationColor,
    annotationStrokeWidth,
    setAnnotations,
    setAnnotationTool,
    isLoadingAsset,
  } = usePhotogrammetryStore();

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [fitted, setFitted] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  // Mirrors dragRef for rendering: while a drag is live the whole overlay must
  // take the pointer, even in the pass-through (video + Select) mode.
  const [dragActive, setDragActive] = useState(false);
  /** Pointer position while the eraser tool is active (drives its cursor ring). */
  const [eraserPt, setEraserPt] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    mode: 'draw' | 'move' | 'erase';
    startX: number;
    startY: number;
    annId?: string;
    orig?: Annotation;
    /** Set once an erase drag actually removed something. */
    erased?: boolean;
  } | null>(null);

  const isVideo = asset.assetType === 'video';

  // Switching assets must not carry over geometry or edit state
  useEffect(() => {
    setNatural(null);
    setDraft(null);
    setSelectedAnnId(null);
    setTextInput(null);
    setVideoTime(0);
    dragRef.current = null;
    setDragActive(false);
  }, [asset.id]);

  // Native pixel dimensions of the display surface (fallback until measured)
  const dims = useMemo(() => natural ?? { w: 1280, h: 720 }, [natural]);

  // Fit into the container preserving aspect ratio so the SVG maps 1:1
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const cw = el.clientWidth - 16;
      const ch = el.clientHeight - 16;
      if (cw <= 0 || ch <= 0) return;
      const ratio = dims.w / dims.h;
      let w = cw;
      let h = w / ratio;
      if (h > ch) {
        h = ch;
        w = h * ratio;
      }
      setFitted({ w: Math.round(w), h: Math.round(h) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dims]);

  const eventToImage = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const el = svgRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = ((e.clientX - rect.left) / rect.width) * dims.w;
      const y = ((e.clientY - rect.top) / rect.height) * dims.h;
      return { x: Math.max(0, Math.min(dims.w, x)), y: Math.max(0, Math.min(dims.h, y)) };
    },
    [dims],
  );

  const handleDragMove = useCallback(
    (pt: { x: number; y: number }) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === 'draw') {
        setDraft((a) => {
          if (!a) return a;
          switch (a.type) {
            case 'arrow':
              return { ...a, x2: pt.x, y2: pt.y };
            case 'freehand':
              return { ...a, points: [...a.points, pt.x, pt.y] };
            case 'circle':
              return {
                ...a,
                cx: (drag.startX + pt.x) / 2,
                cy: (drag.startY + pt.y) / 2,
                rx: Math.abs(pt.x - drag.startX) / 2 || 1,
                ry: Math.abs(pt.y - drag.startY) / 2 || 1,
              };
            case 'rect':
              return {
                ...a,
                x: Math.min(drag.startX, pt.x),
                y: Math.min(drag.startY, pt.y),
                w: Math.abs(pt.x - drag.startX) || 1,
                h: Math.abs(pt.y - drag.startY) || 1,
              };
            default:
              return a;
          }
        });
      } else if (drag.mode === 'move' && drag.annId && drag.orig) {
        const moved = translateAnnotation(drag.orig, pt.x - drag.startX, pt.y - drag.startY);
        // Read the live list — the closure copy can be stale mid-drag
        const current = usePhotogrammetryStore.getState().annotations;
        setAnnotations(current.map((a) => (a.id === drag.annId ? moved : a)), false);
      } else if (drag.mode === 'erase') {
        const current = usePhotogrammetryStore.getState().annotations;
        const next = eraseAt(current, pt, eraserRadiusFor(dims.w));
        if (next !== current) {
          drag.erased = true;
          setAnnotations(next, false); // persisted once on pointer up
        }
      }
    },
    [setAnnotations, dims.w],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const pt = eventToImage(e);
      if (!pt) return;
      if (annotationTool === 'eraser') setEraserPt(pt);
      if (dragRef.current) handleDragMove(pt);
    },
    [eventToImage, handleDragMove, annotationTool],
  );

  const commitTextInput = useCallback(() => {
    if (textInput && textInput.value.trim()) {
      setAnnotations([
        ...annotations,
        {
          id: nextAnnotationId(),
          type: 'text',
          color: annotationColor,
          strokeWidth: annotationStrokeWidth,
          x: textInput.x,
          y: textInput.y,
          text: textInput.value.trim(),
          fontSize: Math.max(14, Math.round(dims.w / 36)),
        },
      ]);
      setAnnotationTool('select');
    }
    setTextInput(null);
  }, [annotations, annotationColor, annotationStrokeWidth, dims.w, setAnnotations, setAnnotationTool, textInput]);

  const beginDraw = useCallback(
    (pt: { x: number; y: number }) => {
      const base = { id: nextAnnotationId(), color: annotationColor, strokeWidth: annotationStrokeWidth };
      let annotation: Annotation | null = null;
      switch (annotationTool) {
        case 'arrow':
          annotation = { ...base, type: 'arrow', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
          break;
        case 'freehand':
          annotation = { ...base, type: 'freehand', points: [pt.x, pt.y] };
          break;
        case 'circle':
          annotation = { ...base, type: 'circle', cx: pt.x, cy: pt.y, rx: 1, ry: 1 };
          break;
        case 'rect':
          annotation = { ...base, type: 'rect', x: pt.x, y: pt.y, w: 1, h: 1 };
          break;
        default:
          return;
      }
      dragRef.current = { mode: 'draw', startX: pt.x, startY: pt.y };
      setDragActive(true);
      setDraft(annotation);
    },
    [annotationTool, annotationColor, annotationStrokeWidth],
  );

  const handlePointerDown = useCallback(
    (e: React.MouseEvent) => {
      // The default mousedown action moves focus to the (unfocusable) SVG,
      // which would blur — and thereby dismiss — the text input created
      // below in the same event. It also starts no text selection/drag.
      e.preventDefault();
      const pt = eventToImage(e);
      if (!pt) return;
      // A click anywhere while a label is being typed commits that label
      if (textInput) {
        commitTextInput();
        return;
      }
      if (annotationTool === 'text') {
        setTextInput({ x: pt.x, y: pt.y, value: '' });
        return;
      }
      if (annotationTool === 'eraser') {
        dragRef.current = { mode: 'erase', startX: pt.x, startY: pt.y };
        setDragActive(true);
        handleDragMove(pt);
        return;
      }
      if (annotationTool === 'select') {
        // Topmost annotation wins
        const hit = [...annotations].reverse().find((a) => hitTest(a, pt, dims.w / 60));
        setSelectedAnnId(hit?.id ?? null);
        if (hit) {
          dragRef.current = { mode: 'move', startX: pt.x, startY: pt.y, annId: hit.id, orig: hit };
          setDragActive(true);
        }
        return;
      }
      beginDraw(pt);
    },
    [annotationTool, annotations, beginDraw, dims.w, eventToImage, textInput, commitTextInput, handleDragMove],
  );

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragActive(false);
    if (!drag) return;
    if (drag.mode === 'draw') {
      if (draft && !isDegenerateAnnotation(draft)) {
        setAnnotations([...usePhotogrammetryStore.getState().annotations, draft]);
      }
      setDraft(null);
    } else if (drag.mode === 'move') {
      // Persist the final position (the live list, not the closure copy)
      setAnnotations(usePhotogrammetryStore.getState().annotations, true);
    } else if (drag.mode === 'erase') {
      // One write for the whole erase stroke
      if (drag.erased) {
        setAnnotations(usePhotogrammetryStore.getState().annotations, true);
      }
    }
  }, [draft, setAnnotations]);

  // Delete/Backspace removes the selected annotation (outside text fields)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (selectedAnnId) {
        setAnnotations(annotations.filter((a) => a.id !== selectedAnnId));
        setSelectedAnnId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [annotations, selectedAnnId, setAnnotations]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || !onCaptureFrame) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 720;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    c.toBlob((blob) => {
      if (blob) onCaptureFrame(blob);
    }, 'image/png');
  }, [onCaptureFrame]);

  const reportTime = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const t = e.currentTarget.currentTime;
      setVideoTime(t);
      onVideoTime?.(t);
    },
    [onVideoTime],
  );

  // Video + Select: let empty areas fall through to the player's controls while
  // the drawn shapes themselves stay clickable (select / move / Delete).
  const passThrough = isVideo && annotationTool === 'select' && !dragActive;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 flex items-center justify-center bg-black/40 relative overflow-hidden"
      >
        {!assetUrl ? (
          isLoadingAsset ? (
            <span className="text-xs text-gray-400 animate-pulse">Loading media…</span>
          ) : (
            <span className="text-xs text-gray-500">
              This file could not be loaded — see the message above.
            </span>
          )
        ) : (
          <div
            className="relative"
            style={{ width: fitted.w || undefined, height: fitted.h || undefined }}
          >
            <div className="absolute inset-0">
              {isVideo ? (
                <video
                  ref={videoRef}
                  src={assetUrl}
                  controls
                  className="w-full h-full block bg-black"
                  crossOrigin="anonymous"
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) {
                      setNatural({ w: v.videoWidth, h: v.videoHeight });
                    }
                    // A freshly loaded player sits at 0 — report it so stale
                    // positions from a previous video are never reused.
                    reportTime(e);
                  }}
                  onTimeUpdate={reportTime}
                  onSeeked={reportTime}
                />
              ) : (
                <img
                  ref={imgRef}
                  src={assetUrl}
                  alt={asset.fileName}
                  className="w-full h-full block object-contain select-none"
                  draggable={false}
                  onLoad={(e) => {
                    const el = e.currentTarget;
                    if (el.naturalWidth && el.naturalHeight) {
                      setNatural({ w: el.naturalWidth, h: el.naturalHeight });
                    }
                  }}
                />
              )}

              {/* Annotation layer (always mounted so annotations stay visible) */}
              <svg
                ref={svgRef}
                viewBox={`0 0 ${dims.w} ${dims.h}`}
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full"
                style={{
                  cursor:
                    annotationTool === 'select'
                      ? 'default'
                      : annotationTool === 'text'
                        ? 'text'
                        : annotationTool === 'eraser'
                          ? 'none' // the eraser ring below is the cursor
                          : 'crosshair',
                  touchAction: 'none',
                  pointerEvents: passThrough ? 'none' : 'auto',
                }}
                onMouseMove={handleMouseMove}
                onMouseDown={handlePointerDown}
                onMouseUp={handlePointerUp}
                onMouseLeave={() => {
                  setEraserPt(null);
                  handlePointerUp();
                }}
              >
                {/* In pass-through mode the painted shapes re-enable hit
                    testing, so they can still be selected over the video */}
                <g style={passThrough ? { pointerEvents: 'visiblePainted' } : undefined}>
                  {annotations.map((a) => (
                    <AnnotationShape key={a.id} a={a} selected={a.id === selectedAnnId} />
                  ))}
                </g>
                {draft && <AnnotationShape a={draft} selected={false} />}
                {/* Eraser cursor ring */}
                {annotationTool === 'eraser' && eraserPt && (
                  <circle
                    cx={eraserPt.x}
                    cy={eraserPt.y}
                    r={eraserRadiusFor(dims.w)}
                    fill="rgba(255,255,255,0.15)"
                    stroke="#fff"
                    strokeWidth={Math.max(1, dims.w / 500)}
                    strokeDasharray={`${dims.w / 150} ${dims.w / 250}`}
                    pointerEvents="none"
                  />
                )}
              </svg>

              {textInput && (
                <input
                  autoFocus
                  value={textInput.value}
                  onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTextInput();
                    if (e.key === 'Escape') setTextInput(null);
                  }}
                  onBlur={commitTextInput}
                  placeholder="Type, then Enter"
                  className="absolute z-20 px-2 py-1 text-sm bg-gray-900/90 border border-drone-primary rounded text-white outline-none"
                  style={{
                    left: `${(textInput.x / dims.w) * 100}%`,
                    top: `${(textInput.y / dims.h) * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* Video frame actions */}
        {isVideo && assetUrl && (onAddFrame || onCaptureFrame) && (
          <div className="absolute top-3 right-3 flex gap-1.5">
            {onAddFrame && (
              <button
                onClick={() => onAddFrame(videoRef.current?.currentTime ?? videoTime)}
                className="px-3 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs font-medium"
                title="Queue the frame at the current playback position for the report"
              >
                + Add frame {fmtFrameTime(videoTime)} to report
              </button>
            )}
            {onCaptureFrame && (
              <button
                onClick={captureFrame}
                className="px-3 py-1.5 rounded-lg bg-drone-primary/90 hover:bg-drone-primary text-white text-xs font-medium"
                title="Save the current video frame as a new photo in the library"
              >
                Capture frame
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
