/**
 * ThermalViewer — renders the selected thermal asset.
 *
 * - Radiometric images: temperature matrix rendered through a palette LUT on
 *   a canvas, with cursor temperature readout, min/max markers, isotherm
 *   highlighting and anomaly bounding boxes.
 * - Plain images: original file preview.
 * - Videos: playable element with a "capture frame" helper.
 *
 * An SVG annotation layer sits on top for drawing arrows, text, freehand,
 * circles and rectangles in image-pixel coordinates.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { formatTemp, renderTempsToImageData } from '@/lib/thermalPalettes';
import { NetworkLayer, hitTestConductor, hitTestNode } from './NetworkLayer';
import type { Annotation, NetNode, ThermalAsset } from '@/types/thermal';

interface Props {
  asset: ThermalAsset;
  /** Ref that exposes the composed (thermal+annotations) image exporter. */
  exportRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
  onCaptureFrame?: (blob: Blob) => void;
}

interface DraftAnnotation {
  annotation: Annotation;
}

let annotationCounter = 0;
function nextAnnotationId(): string {
  annotationCounter += 1;
  return `ann_${Date.now().toString(36)}_${annotationCounter}`;
}

export function ThermalViewer({ asset, exportRef, onCaptureFrame }: Props) {
  const {
    matrix,
    analysis,
    paletteKey,
    spanLow,
    spanHigh,
    isothermEnabled,
    isothermLow,
    isothermHigh,
    isothermMode,
    anomalies,
    assetUrl,
    annotations,
    annotationTool,
    annotationColor,
    annotationStrokeWidth,
    setAnnotations,
    setAnnotationTool,
    network,
    networkResult,
    selectedNetElement,
    setNetwork,
    addNetNode,
    addNetConductor,
    selectNetElement,
    removeNetElement,
  } = useThermalStore();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [cursorInfo, setCursorInfo] = useState<{ x: number; y: number; temp: number } | null>(null);
  const [fitted, setFitted] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const [conductorDraft, setConductorDraft] = useState<{
    fromId: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const dragRef = useRef<{
    mode: 'draw' | 'move' | 'conductor' | 'moveNode';
    startX: number;
    startY: number;
    annId?: string;
    orig?: Annotation;
    nodeId?: string;
    nodeOrig?: { x: number; y: number };
    /** Set once a moveNode drag actually displaces the node. */
    moved?: boolean;
  } | null>(null);

  const isRadiometric = asset.isRadiometric && matrix != null;
  const isVideo = asset.assetType === 'video';

  // Reset the measured natural size when switching assets so stale dims never
  // drive the overlay/export geometry of the new asset.
  useEffect(() => {
    setImgNatural(null);
  }, [asset.id]);

  // Selections are mutually exclusive; panel-originated network selections
  // must also drop any annotation selection.
  useEffect(() => {
    if (selectedNetElement) setSelectedAnnId(null);
  }, [selectedNetElement]);

  // Native pixel dimensions of the display surface
  const dims = useMemo(() => {
    if (isRadiometric && matrix) return { w: matrix.width, h: matrix.height };
    if (imgNatural) return { w: imgNatural.w, h: imgNatural.h };
    return { w: 640, h: 512 };
  }, [isRadiometric, matrix, imgNatural]);

  // Fit the display surface into the container preserving aspect ratio
  // (object-contain math done in JS so the SVG overlay maps 1:1).
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

  // Render the temperature matrix to canvas whenever inputs change
  useEffect(() => {
    if (!isRadiometric || !matrix || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = matrix.width;
    canvas.height = matrix.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = renderTempsToImageData(matrix.temps, matrix.width, matrix.height, {
      paletteKey,
      spanLow: spanLow ?? undefined,
      spanHigh: spanHigh ?? undefined,
      isotherm: isothermEnabled
        ? { low: isothermLow, high: isothermHigh, mode: isothermMode }
        : null,
    });
    ctx.putImageData(img, 0, 0);
  }, [isRadiometric, matrix, paletteKey, spanLow, spanHigh, isothermEnabled, isothermLow, isothermHigh, isothermMode]);

  // Convert a pointer event to image-pixel coordinates
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

  // ---- Annotation drag handling (declared before handleMouseMove which calls it) ----
  const handleDragMove = useCallback(
    (pt: { x: number; y: number }) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === 'draw') {
        setDraft((d) => {
          if (!d) return d;
          const a = d.annotation;
          switch (a.type) {
            case 'arrow':
              return { annotation: { ...a, x2: pt.x, y2: pt.y } };
            case 'freehand':
              return { annotation: { ...a, points: [...a.points, pt.x, pt.y] } };
            case 'circle':
              return {
                annotation: {
                  ...a,
                  cx: (drag.startX + pt.x) / 2,
                  cy: (drag.startY + pt.y) / 2,
                  rx: Math.abs(pt.x - drag.startX) / 2 || 1,
                  ry: Math.abs(pt.y - drag.startY) / 2 || 1,
                },
              };
            case 'rect':
              return {
                annotation: {
                  ...a,
                  x: Math.min(drag.startX, pt.x),
                  y: Math.min(drag.startY, pt.y),
                  w: Math.abs(pt.x - drag.startX) || 1,
                  h: Math.abs(pt.y - drag.startY) || 1,
                },
              };
            default:
              return d;
          }
        });
      } else if (drag.mode === 'move' && drag.annId && drag.orig) {
        const dx = pt.x - drag.startX;
        const dy = pt.y - drag.startY;
        const moved = translateAnnotation(drag.orig, dx, dy);
        // Read the live list from the store — the closure copy can be stale
        // when this handler is invoked via a memoized handleMouseMove.
        const current = useThermalStore.getState().annotations;
        setAnnotations(
          current.map((a) => (a.id === drag.annId ? moved : a)),
          false,
        );
      } else if (drag.mode === 'conductor') {
        setConductorDraft((d) => (d ? { ...d, x2: pt.x, y2: pt.y } : d));
      } else if (drag.mode === 'moveNode' && drag.nodeId && drag.nodeOrig) {
        const dx = pt.x - drag.startX;
        const dy = pt.y - drag.startY;
        // A plain selection click must not touch the network (it would clear
        // the solve result and rewrite the DB) — wait for real displacement.
        if (!drag.moved && Math.hypot(dx, dy) < 1) return;
        drag.moved = true;
        const net = useThermalStore.getState().network;
        setNetwork(
          {
            ...net,
            nodes: net.nodes.map((n) =>
              n.id === drag.nodeId
                ? { ...n, x: drag.nodeOrig!.x + dx, y: drag.nodeOrig!.y + dy }
                : n,
            ),
          },
          false,
        );
      }
    },
    [setAnnotations, setNetwork],
  );

  // ---- Cursor temperature readout ----
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const pt = eventToImage(e);
      if (!pt) return;

      if (dragRef.current) {
        handleDragMove(pt);
        return;
      }

      if (isRadiometric && matrix) {
        const px = Math.min(matrix.width - 1, Math.floor(pt.x));
        const py = Math.min(matrix.height - 1, Math.floor(pt.y));
        setCursorInfo({ x: px, y: py, temp: matrix.temps[py * matrix.width + px] });
      }
    },
    [eventToImage, isRadiometric, matrix, handleDragMove],
  );

  // ---- Annotation drawing ----
  const beginDraw = useCallback(
    (pt: { x: number; y: number }) => {
      const base = {
        id: nextAnnotationId(),
        color: annotationColor,
        strokeWidth: annotationStrokeWidth,
      };
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
      setDraft({ annotation });
    },
    [annotationTool, annotationColor, annotationStrokeWidth],
  );

  const handlePointerDown = useCallback(
    (e: React.MouseEvent) => {
      const pt = eventToImage(e);
      if (!pt) return;

      if (annotationTool === 'text') {
        setTextInput({ x: pt.x, y: pt.y, value: '' });
        return;
      }
      if (annotationTool === 'node') {
        // Place a heat-flow node, sampling the measured temperature when available
        const net = useThermalStore.getState().network;
        let idx = 1;
        while (net.nodes.some((n) => n.id === `N${idx}`)) idx++;
        let t0 = 20;
        if (isRadiometric && matrix) {
          const px = Math.min(matrix.width - 1, Math.floor(pt.x));
          const py = Math.min(matrix.height - 1, Math.floor(pt.y));
          t0 = Math.round(matrix.temps[py * matrix.width + px] * 10) / 10;
        }
        const node: NetNode = {
          id: `N${idx}`,
          label: '',
          x: pt.x,
          y: pt.y,
          kind: 'diffusion',
          initialTempC: t0,
          mcp: { mode: 'constant', value: 100 },
          source: null,
          boundaryTempC: null,
        };
        addNetNode(node);
        return;
      }
      if (annotationTool === 'conductor') {
        const hit = hitTestNode(network, pt, dims.w);
        if (hit) {
          dragRef.current = { mode: 'conductor', startX: pt.x, startY: pt.y };
          setConductorDraft({ fromId: hit.id, x1: hit.x, y1: hit.y, x2: pt.x, y2: pt.y });
        }
        return;
      }
      if (annotationTool === 'select') {
        // Network nodes take precedence, then conductors, then annotations
        const nodeHit = hitTestNode(network, pt, dims.w);
        if (nodeHit) {
          selectNetElement({ type: 'node', id: nodeHit.id });
          setSelectedAnnId(null);
          dragRef.current = {
            mode: 'moveNode',
            startX: pt.x,
            startY: pt.y,
            nodeId: nodeHit.id,
            nodeOrig: { x: nodeHit.x, y: nodeHit.y },
          };
          return;
        }
        const condHit = hitTestConductor(network, pt, dims.w);
        if (condHit) {
          selectNetElement({ type: 'conductor', id: condHit.id });
          setSelectedAnnId(null);
          return;
        }
        selectNetElement(null);
        // Hit-test annotations (topmost first)
        const hit = [...annotations].reverse().find((a) => hitTest(a, pt, dims.w / 60));
        setSelectedAnnId(hit?.id ?? null);
        if (hit) {
          dragRef.current = {
            mode: 'move',
            startX: pt.x,
            startY: pt.y,
            annId: hit.id,
            orig: hit,
          };
        }
        return;
      }
      beginDraw(pt);
    },
    [annotationTool, annotations, beginDraw, dims, eventToImage, isRadiometric, matrix, network, addNetNode, selectNetElement],
  );

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === 'draw' && draft) {
      // Discard degenerate shapes (tiny click without drag)
      const a = draft.annotation;
      const tooSmall =
        (a.type === 'arrow' && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3) ||
        (a.type === 'freehand' && a.points.length < 6) ||
        (a.type === 'circle' && a.rx < 2 && a.ry < 2) ||
        (a.type === 'rect' && a.w < 3 && a.h < 3);
      if (!tooSmall) {
        setAnnotations([...useThermalStore.getState().annotations, a]);
      }
      setDraft(null);
    } else if (drag.mode === 'move') {
      // Persist the moved annotation (read the live list, not the closure copy)
      setAnnotations(useThermalStore.getState().annotations, true);
    } else if (drag.mode === 'conductor') {
      const cd = conductorDraft;
      setConductorDraft(null);
      if (cd) {
        const net = useThermalStore.getState().network;
        const target = hitTestNode(net, { x: cd.x2, y: cd.y2 }, dims.w);
        // Parallel conductors between the same pair are legitimate
        // (e.g. conduction + radiation), so only self-links are rejected.
        if (target && target.id !== cd.fromId) {
          let idx = 1;
          while (net.conductors.some((c) => c.id === `G${idx}`)) idx++;
          addNetConductor({
            id: `G${idx}`,
            label: '',
            from: cd.fromId,
            to: target.id,
            kind: 'linear',
            value: { mode: 'constant', value: 1 },
          });
        }
      }
    } else if (drag.mode === 'moveNode') {
      // Persist the final node position — only if it actually moved
      if (drag.moved) {
        setNetwork(useThermalStore.getState().network, true);
      }
    }
  }, [draft, setAnnotations, conductorDraft, dims.w, addNetConductor, setNetwork]);

  // Delete key removes the selected network element or annotation
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
      if (selectedNetElement) {
        removeNetElement(selectedNetElement.type, selectedNetElement.id);
        return;
      }
      if (selectedAnnId) {
        setAnnotations(annotations.filter((a) => a.id !== selectedAnnId));
        setSelectedAnnId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [annotations, selectedAnnId, setAnnotations, selectedNetElement, removeNetElement]);

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

  // ---- Export composed image (thermal render + annotations baked in) ----
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = async () => {
      const out = document.createElement('canvas');
      out.width = dims.w;
      out.height = dims.h;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      if (isRadiometric && canvasRef.current) {
        ctx.drawImage(canvasRef.current, 0, 0);
      } else if (imgRef.current) {
        ctx.drawImage(imgRef.current, 0, 0, dims.w, dims.h);
      } else if (videoRef.current) {
        ctx.drawImage(videoRef.current, 0, 0, dims.w, dims.h);
      } else {
        return null;
      }
      drawAnnotationsToCanvas(ctx, annotations);
      return out.toDataURL('image/png');
    };
    return () => {
      if (exportRef) exportRef.current = null;
    };
  }, [exportRef, dims, isRadiometric, annotations]);

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

  const stats = analysis?.stats;
  const showCrosshairs = isRadiometric && stats;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Viewer surface */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 flex items-center justify-center bg-black/40 relative overflow-hidden"
      >
        <div
          className="relative"
          style={{ width: fitted.w || undefined, height: fitted.h || undefined }}
        >
          <div className="absolute inset-0">
            {isRadiometric ? (
              <canvas
                ref={canvasRef}
                className="w-full h-full block select-none"
                style={{ imageRendering: dims.w < 400 ? 'pixelated' : 'auto' }}
              />
            ) : isVideo ? (
              <video
                ref={videoRef}
                src={assetUrl ?? undefined}
                controls
                className="w-full h-full block bg-black"
                crossOrigin="anonymous"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (v.videoWidth && v.videoHeight) {
                    setImgNatural({ w: v.videoWidth, h: v.videoHeight });
                  }
                }}
              />
            ) : (
              <img
                ref={imgRef}
                src={assetUrl ?? undefined}
                alt={asset.fileName}
                className="w-full h-full block object-contain select-none"
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  if (el.naturalWidth && el.naturalHeight) {
                    setImgNatural({ w: el.naturalWidth, h: el.naturalHeight });
                  }
                }}
              />
            )}

            {/* Annotation + overlay layer (skip for videos so controls stay clickable
                unless a drawing tool is active) */}
            {(!isVideo || annotationTool !== 'select') && (
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
                        : 'crosshair',
                  touchAction: 'none',
                }}
                onMouseMove={handleMouseMove}
                onMouseDown={handlePointerDown}
                onMouseUp={handlePointerUp}
                onMouseLeave={() => {
                  setCursorInfo(null);
                  handlePointerUp();
                }}
              >
                {/* Min/Max markers */}
                {showCrosshairs && stats && (
                  <>
                    <Marker
                      x={stats.maxPos[0]}
                      y={stats.maxPos[1]}
                      color="#ff453a"
                      label={formatTemp(stats.max)}
                      dims={dims}
                    />
                    <Marker
                      x={stats.minPos[0]}
                      y={stats.minPos[1]}
                      color="#0a84ff"
                      label={formatTemp(stats.min)}
                      dims={dims}
                    />
                  </>
                )}

                {/* Anomaly bounding boxes */}
                {anomalies?.regions.map((r) => (
                  <g key={`anom-${r.id}`}>
                    <rect
                      x={r.bbox[0]}
                      y={r.bbox[1]}
                      width={r.bbox[2]}
                      height={r.bbox[3]}
                      fill="none"
                      stroke={r.kind === 'hot' ? '#ff9f0a' : '#64d2ff'}
                      strokeWidth={Math.max(1.5, dims.w / 400)}
                      strokeDasharray={`${dims.w / 120} ${dims.w / 200}`}
                    />
                    <text
                      x={r.bbox[0]}
                      y={Math.max(12, r.bbox[1] - 4)}
                      fill={r.kind === 'hot' ? '#ff9f0a' : '#64d2ff'}
                      fontSize={Math.max(11, dims.w / 48)}
                      fontWeight={700}
                      paintOrder="stroke"
                      stroke="#000"
                      strokeWidth={Math.max(2, dims.w / 300)}
                    >
                      #{r.id} {r.deltaT > 0 ? '+' : ''}
                      {r.deltaT.toFixed(1)}°
                    </text>
                  </g>
                ))}

                {/* Persisted annotations */}
                {annotations.map((a) => (
                  <AnnotationShape key={a.id} a={a} selected={a.id === selectedAnnId} />
                ))}
                {/* Draft being drawn */}
                {draft && <AnnotationShape a={draft.annotation} selected={false} />}

                {/* Heat-flow network overlay */}
                <NetworkLayer
                  network={network}
                  result={networkResult}
                  selected={selectedNetElement}
                  dims={dims}
                  conductorDraft={conductorDraft}
                />
              </svg>
            )}

            {/* Inline text input for the text tool */}
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

        {/* Cursor readout */}
        {cursorInfo && (
          <div className="absolute bottom-3 left-3 px-2.5 py-1.5 rounded-lg bg-black/70 border border-gray-700 text-xs text-white font-mono pointer-events-none">
            ({cursorInfo.x}, {cursorInfo.y}) · {formatTemp(cursorInfo.temp)}
          </div>
        )}

        {/* Video frame capture */}
        {isVideo && onCaptureFrame && (
          <button
            onClick={captureFrame}
            className="absolute top-3 right-3 px-3 py-1.5 rounded-lg bg-drone-primary/90 hover:bg-drone-primary text-white text-xs font-medium"
            title="Capture the current video frame as a new image asset"
          >
            Capture frame
          </button>
        )}
      </div>
    </div>
  );
}

function Marker({
  x,
  y,
  color,
  label,
  dims,
}: {
  x: number;
  y: number;
  color: string;
  label: string;
  dims: { w: number; h: number };
}) {
  const s = Math.max(5, dims.w / 90);
  const fs = Math.max(11, dims.w / 50);
  const labelX = Math.min(x + s + 2, dims.w - fs * 4);
  const labelY = y < fs * 1.5 ? y + fs + s : y - s;
  return (
    <g pointerEvents="none">
      <line x1={x - s} y1={y} x2={x + s} y2={y} stroke={color} strokeWidth={s / 3} />
      <line x1={x} y1={y - s} x2={x} y2={y + s} stroke={color} strokeWidth={s / 3} />
      <text
        x={labelX}
        y={labelY}
        fill={color}
        fontSize={fs}
        fontWeight={700}
        paintOrder="stroke"
        stroke="#000"
        strokeWidth={fs / 5}
      >
        {label}
      </text>
    </g>
  );
}

function AnnotationShape({ a, selected }: { a: Annotation; selected: boolean }) {
  const highlight = selected
    ? { filter: 'drop-shadow(0 0 3px rgba(56, 189, 248, 0.9))' }
    : undefined;
  switch (a.type) {
    case 'arrow': {
      const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      const headLen = Math.max(8, a.strokeWidth * 4);
      const h1x = a.x2 - headLen * Math.cos(angle - Math.PI / 7);
      const h1y = a.y2 - headLen * Math.sin(angle - Math.PI / 7);
      const h2x = a.x2 - headLen * Math.cos(angle + Math.PI / 7);
      const h2y = a.y2 - headLen * Math.sin(angle + Math.PI / 7);
      return (
        <g style={highlight}>
          <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={a.color} strokeWidth={a.strokeWidth} strokeLinecap="round" />
          <polygon points={`${a.x2},${a.y2} ${h1x},${h1y} ${h2x},${h2y}`} fill={a.color} />
        </g>
      );
    }
    case 'text':
      return (
        <text
          x={a.x}
          y={a.y}
          fill={a.color}
          fontSize={a.fontSize}
          fontWeight={700}
          paintOrder="stroke"
          stroke="#000"
          strokeWidth={a.fontSize / 8}
          style={highlight}
        >
          {a.text}
        </text>
      );
    case 'freehand': {
      let d = '';
      for (let i = 0; i < a.points.length; i += 2) {
        d += `${i === 0 ? 'M' : 'L'}${a.points[i]},${a.points[i + 1]} `;
      }
      return (
        <path
          d={d}
          fill="none"
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={highlight}
        />
      );
    }
    case 'circle':
      return (
        <ellipse
          cx={a.cx}
          cy={a.cy}
          rx={a.rx}
          ry={a.ry}
          fill="none"
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          style={highlight}
        />
      );
    case 'rect':
      return (
        <rect
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          fill="none"
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          style={highlight}
        />
      );
    default:
      return null;
  }
}

function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.type) {
    case 'arrow':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    case 'text':
      return { ...a, x: a.x + dx, y: a.y + dy };
    case 'freehand': {
      const points = a.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
      return { ...a, points };
    }
    case 'circle':
      return { ...a, cx: a.cx + dx, cy: a.cy + dy };
    case 'rect':
      return { ...a, x: a.x + dx, y: a.y + dy };
    default:
      return a;
  }
}

function hitTest(a: Annotation, pt: { x: number; y: number }, tolerance: number): boolean {
  const tol = Math.max(6, tolerance);
  switch (a.type) {
    case 'arrow':
      return distToSegment(pt, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) < tol;
    case 'text': {
      const w = a.text.length * a.fontSize * 0.6;
      return pt.x >= a.x - tol && pt.x <= a.x + w + tol && pt.y >= a.y - a.fontSize - tol && pt.y <= a.y + tol;
    }
    case 'freehand': {
      for (let i = 0; i + 3 < a.points.length; i += 2) {
        if (
          distToSegment(
            pt,
            { x: a.points[i], y: a.points[i + 1] },
            { x: a.points[i + 2], y: a.points[i + 3] },
          ) < tol
        ) {
          return true;
        }
      }
      return false;
    }
    case 'circle': {
      // Near the ellipse outline
      const nx = (pt.x - a.cx) / (a.rx || 1);
      const ny = (pt.y - a.cy) / (a.ry || 1);
      const d = Math.sqrt(nx * nx + ny * ny);
      const rim = tol / Math.max(a.rx, a.ry, 1);
      return Math.abs(d - 1) < Math.max(0.15, rim);
    }
    case 'rect': {
      const nearX = pt.x >= a.x - tol && pt.x <= a.x + a.w + tol;
      const nearY = pt.y >= a.y - tol && pt.y <= a.y + a.h + tol;
      const onEdgeX = Math.abs(pt.x - a.x) < tol || Math.abs(pt.x - (a.x + a.w)) < tol;
      const onEdgeY = Math.abs(pt.y - a.y) < tol || Math.abs(pt.y - (a.y + a.h)) < tol;
      return (nearX && nearY && (onEdgeX || onEdgeY));
    }
    default:
      return false;
  }
}

function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Draw annotations onto a 2D canvas context (for export). */
export function drawAnnotationsToCanvas(ctx: CanvasRenderingContext2D, annotations: Annotation[]): void {
  for (const a of annotations) {
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = a.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (a.type) {
      case 'arrow': {
        ctx.beginPath();
        ctx.moveTo(a.x1, a.y1);
        ctx.lineTo(a.x2, a.y2);
        ctx.stroke();
        const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const headLen = Math.max(8, a.strokeWidth * 4);
        ctx.beginPath();
        ctx.moveTo(a.x2, a.y2);
        ctx.lineTo(
          a.x2 - headLen * Math.cos(angle - Math.PI / 7),
          a.y2 - headLen * Math.sin(angle - Math.PI / 7),
        );
        ctx.lineTo(
          a.x2 - headLen * Math.cos(angle + Math.PI / 7),
          a.y2 - headLen * Math.sin(angle + Math.PI / 7),
        );
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'text': {
        ctx.font = `700 ${a.fontSize}px sans-serif`;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = a.fontSize / 8;
        ctx.strokeText(a.text, a.x, a.y);
        ctx.fillText(a.text, a.x, a.y);
        break;
      }
      case 'freehand': {
        ctx.beginPath();
        for (let i = 0; i < a.points.length; i += 2) {
          if (i === 0) ctx.moveTo(a.points[i], a.points[i + 1]);
          else ctx.lineTo(a.points[i], a.points[i + 1]);
        }
        ctx.stroke();
        break;
      }
      case 'circle': {
        ctx.beginPath();
        ctx.ellipse(a.cx, a.cy, a.rx, a.ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'rect': {
        ctx.strokeRect(a.x, a.y, a.w, a.h);
        break;
      }
    }
  }
}
