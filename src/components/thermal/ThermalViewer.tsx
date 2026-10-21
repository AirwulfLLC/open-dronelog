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
 * circles and rectangles in image-pixel coordinates. The whole surface can be
 * zoomed and panned (see `useZoomPan`); pointer positions map through the
 * overlay's on-screen box, so every tool works at any zoom.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { formatTemp, renderTempsToImageData } from '@/lib/thermalPalettes';
import { CLICK_ZOOM_STEP, useZoomPan } from '@/hooks/useZoomPan';
import {
  NetworkLayer,
  eraseNetworkAt,
  hitTestConductor,
  hitTestNode,
  linkConductor,
  nextConductorId,
  nextNodeId,
} from './NetworkLayer';
import {
  AnnotationShape,
  eraseAt,
  eraserRadiusFor,
  hitTest,
  nextAnnotationId,
  translateAnnotation,
} from './annotationUtils';
import type { Annotation, NetNode, ThermalAsset } from '@/types/thermal';

interface Props {
  asset: ThermalAsset;
  onCaptureFrame?: (blob: Blob) => void;
}

interface DraftAnnotation {
  annotation: Annotation;
}

export function ThermalViewer({ asset, onCaptureFrame }: Props) {
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
    selectNetElement,
    removeNetElement,
    valueSuffix,
    nodeDotSize,
  } = useThermalStore();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [cursorInfo, setCursorInfo] = useState<{ x: number; y: number; temp: number } | null>(null);
  const [fitted, setFitted] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** Container client size — the zoomed surface is kept inside it. */
  const [cbox, setCbox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  /** Pointer position while the eraser tool is active (drives its cursor ring). */
  const [eraserPt, setEraserPt] = useState<{ x: number; y: number } | null>(null);
  // Mirrors dragRef for rendering: while a drag is live the whole overlay must
  // take the pointer, even in the pass-through (video + Select) mode.
  const [dragActive, setDragActive] = useState(false);
  const [conductorDraft, setConductorDraft] = useState<{
    fromId: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const dragRef = useRef<{
    mode: 'draw' | 'move' | 'conductor' | 'moveNode' | 'erase';
    startX: number;
    startY: number;
    annId?: string;
    orig?: Annotation;
    nodeId?: string;
    nodeOrig?: { x: number; y: number };
    /** Set once a moveNode drag actually displaces the node. */
    moved?: boolean;
    /** Set once an erase drag actually removed an annotation. */
    erased?: boolean;
    /** Set once an erase drag actually removed a node or conductor. */
    erasedNet?: boolean;
  } | null>(null);

  // Zoom & pan of the display surface (local: the component is keyed by
  // asset id, so a new asset always opens at fit)
  const zp = useZoomPan(containerRef, fitted, cbox);

  const isRadiometric = asset.isRadiometric && matrix != null;
  const isVideo = asset.assetType === 'video';

  // Reset the measured natural size when switching assets so stale dims never
  // drive the overlay/export geometry of the new asset.
  useEffect(() => {
    setImgNatural(null);
    setEraserPt(null);
    setDragActive(false);
    dragRef.current = null;
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
      setCbox({ w: el.clientWidth, h: el.clientHeight });
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
            case 'line':
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
      } else if (drag.mode === 'erase') {
        const radius = eraserRadiusFor(dims.w);
        const current = useThermalStore.getState().annotations;
        const next = eraseAt(current, pt, radius);
        if (next !== current) {
          drag.erased = true;
          setAnnotations(next, false); // persisted once on pointer up
        }
        // Heat-flow nodes go with their conductors; a conductor alone goes too
        const net = useThermalStore.getState().network;
        const nextNet = eraseNetworkAt(net, pt, radius, dims.w);
        if (nextNet !== net) {
          drag.erasedNet = true;
          setNetwork(nextNet, false); // persisted once on pointer up
          const sel = useThermalStore.getState().selectedNetElement;
          const stillThere =
            sel == null ||
            (sel.type === 'node'
              ? nextNet.nodes.some((n) => n.id === sel.id)
              : nextNet.conductors.some((c) => c.id === sel.id));
          if (!stillThere) selectNetElement(null);
        }
      }
    },
    [setAnnotations, setNetwork, selectNetElement, dims.w],
  );

  // ---- Cursor temperature readout ----
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const pt = eventToImage(e);
      if (!pt) return;

      if (annotationTool === 'eraser') setEraserPt(pt);

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
    [eventToImage, isRadiometric, matrix, handleDragMove, annotationTool],
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
        case 'line':
          annotation = { ...base, type: 'line', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
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
      setDraft({ annotation });
    },
    [annotationTool, annotationColor, annotationStrokeWidth],
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
      // Middle/right buttons and the Zoom tool belong to the viewer surface
      // (pan / zoom click, see handleViewMouseDown), not to the tools
      if (e.button !== 0 || annotationTool === 'zoom') return;
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
      if (annotationTool === 'node') {
        // An existing dot is selected (and can be dragged), never covered by
        // a new one
        const existing = hitTestNode(network, pt, dims.w);
        if (existing) {
          selectNetElement({ type: 'node', id: existing.id });
          setSelectedAnnId(null);
          dragRef.current = {
            mode: 'moveNode',
            startX: pt.x,
            startY: pt.y,
            nodeId: existing.id,
            nodeOrig: { x: existing.x, y: existing.y },
          };
          setDragActive(true);
          return;
        }
        // Place a heat-flow node, sampling the measured temperature when
        // available. Vegetation-index values are NOT temperatures — nodes on
        // index assets seed with a neutral default instead.
        const net = useThermalStore.getState().network;
        let t0 = 20;
        if (isRadiometric && matrix && valueSuffix !== '') {
          const px = Math.min(matrix.width - 1, Math.floor(pt.x));
          const py = Math.min(matrix.height - 1, Math.floor(pt.y));
          const sampled = matrix.temps[py * matrix.width + px];
          if (Number.isFinite(sampled)) {
            t0 = Math.round(sampled * 10) / 10;
          }
        }
        const node: NetNode = {
          id: nextNodeId(net),
          label: '',
          x: pt.x,
          y: pt.y,
          kind: 'diffusion',
          initialTempC: t0,
          mcp: { mode: 'constant', value: 100 },
          source: null,
          boundaryTempC: null,
        };
        // Successive dots form a chain: the new node is linked to the one
        // placed before it. Shift places an unlinked node (a new chain).
        const prev = net.nodes[net.nodes.length - 1];
        const conductors =
          prev && !e.shiftKey
            ? [...net.conductors, linkConductor(nextConductorId(net), prev.id, node.id)]
            : net.conductors;
        setNetwork({ nodes: [...net.nodes, node], conductors });
        selectNetElement({ type: 'node', id: node.id });
        setSelectedAnnId(null);
        return;
      }
      if (annotationTool === 'conductor') {
        const hit = hitTestNode(network, pt, dims.w);
        if (hit) {
          dragRef.current = { mode: 'conductor', startX: pt.x, startY: pt.y };
          setDragActive(true);
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
          setDragActive(true);
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
          setDragActive(true);
        }
        return;
      }
      beginDraw(pt);
    },
    [annotationTool, annotations, beginDraw, dims, eventToImage, isRadiometric, matrix, network, setNetwork, selectNetElement, valueSuffix, textInput, commitTextInput, handleDragMove],
  );

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragActive(false);
    if (!drag) return;
    if (drag.mode === 'draw' && draft) {
      // Discard degenerate shapes (tiny click without drag)
      const a = draft.annotation;
      const tooSmall =
        ((a.type === 'arrow' || a.type === 'line') && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3) ||
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
          const id = nextConductorId(net);
          setNetwork({ ...net, conductors: [...net.conductors, linkConductor(id, cd.fromId, target.id)] });
          selectNetElement({ type: 'conductor', id });
        }
      }
    } else if (drag.mode === 'moveNode') {
      // Persist the final node position — only if it actually moved
      if (drag.moved) {
        setNetwork(useThermalStore.getState().network, true);
      }
    } else if (drag.mode === 'erase') {
      // One write per store for the whole erase stroke
      if (drag.erased) {
        setAnnotations(useThermalStore.getState().annotations, true);
      }
      if (drag.erasedNet) {
        setNetwork(useThermalStore.getState().network, true);
      }
    }
  }, [draft, setAnnotations, conductorDraft, dims.w, setNetwork, selectNetElement]);

  // The Zoom tool and the middle button act on the whole viewer surface (the
  // overlay hands these presses up): a Zoom-tool press pans, or zooms about
  // the point when it does not travel (Shift zooms out); a middle-button press
  // pans with any tool — also over a video in pass-through mode.
  const { beginPan } = zp;
  const handleViewMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (dragRef.current) return;
      // A press while a label is being typed only commits the label (the
      // overlay's handler), never a zoom click as well
      if (textInput) return;
      // Presses on the controls over the surface (zoom strip, Capture frame,
      // the text input) are theirs — neither a pan nor a zoom click
      if ((e.target as Element).closest('button, input, select, textarea, a')) return;
      const middle = e.button === 1;
      const zoomTool = annotationTool === 'zoom' && e.button === 0;
      if (!middle && !zoomTool) return;
      // No Windows middle-click autoscroll, text selection or focus move
      e.preventDefault();
      beginPan(e.clientX, e.clientY, zoomTool ? (e.shiftKey ? 'out' : 'in') : null, e.button);
    },
    [annotationTool, beginPan, textInput],
  );

  // Shift held with the Zoom tool means "zoom out": show it in the cursor
  const [shiftHeld, setShiftHeld] = useState(false);
  useEffect(() => {
    if (annotationTool !== 'zoom') {
      setShiftHeld(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
    const onBlur = () => setShiftHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [annotationTool]);

  // Delete key removes the selected network element or annotation; Escape
  // deselects (the only way to deselect over a video, where empty areas pass
  // the pointer through to the player)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      if (e.key === 'Escape') {
        setSelectedAnnId(null);
        if (selectedNetElement) selectNetElement(null);
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
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
  }, [annotations, selectedAnnId, setAnnotations, selectedNetElement, removeNetElement, selectNetElement]);

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

  // Video + Select: let empty areas fall through to the player's controls while
  // drawn shapes and network nodes stay clickable (select / move / Delete).
  const passThrough = isVideo && annotationTool === 'select' && !dragActive;
  const hitOnlyPainted = passThrough ? { pointerEvents: 'visiblePainted' as const } : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Viewer surface */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-black/40 relative overflow-hidden"
        style={{ touchAction: 'none', cursor: zp.panning ? 'grabbing' : undefined }}
        onMouseDown={handleViewMouseDown}
      >
        {/* The surface at fitted × zoom, kept inside the container by the clamp
            (centred at 1×, edges pinned once larger than the container) */}
        <div
          className="absolute left-0 top-0"
          style={{
            width: zp.W || undefined,
            height: zp.H || undefined,
            transform: `translate3d(${zp.ox}px, ${zp.oy}px, 0)`,
          }}
        >
          <div className="absolute inset-0">
            {isRadiometric ? (
              <canvas
                ref={canvasRef}
                className="w-full h-full block select-none"
                // Crisp pixels for small matrices, and for any matrix once it is
                // magnified to 3+ screen pixels per thermal pixel
                style={{ imageRendering: dims.w < 400 || zp.W / dims.w >= 3 ? 'pixelated' : 'auto' }}
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

            {/* Annotation + overlay layer — always mounted so annotations stay
                visible on videos; in Select mode only painted shapes take the
                pointer there, so the native controls remain clickable */}
            {(
              <svg
                ref={svgRef}
                viewBox={`0 0 ${dims.w} ${dims.h}`}
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full"
                style={{
                  cursor: zp.panning
                    ? 'grabbing'
                    : annotationTool === 'zoom'
                      ? shiftHeld
                        ? 'zoom-out'
                        : 'zoom-in'
                      : annotationTool === 'select'
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
                  setCursorInfo(null);
                  setEraserPt(null);
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
                      label={formatTemp(stats.max, valueSuffix)}
                      dims={dims}
                    />
                    <Marker
                      x={stats.minPos[0]}
                      y={stats.minPos[1]}
                      color="#0a84ff"
                      label={formatTemp(stats.min, valueSuffix)}
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
                      {r.deltaT.toFixed(valueSuffix === '' ? 3 : 1)}
                      {valueSuffix === '' ? '' : '°'}
                    </text>
                  </g>
                ))}

                {/* Persisted annotations */}
                <g style={hitOnlyPainted}>
                  {annotations.map((a) => (
                    <AnnotationShape key={a.id} a={a} selected={a.id === selectedAnnId} />
                  ))}
                </g>
                {/* Draft being drawn */}
                {draft && <AnnotationShape a={draft.annotation} selected={false} />}

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

                {/* Heat-flow network overlay */}
                <g style={hitOnlyPainted}>
                  <NetworkLayer
                    network={network}
                    result={networkResult}
                    selected={selectedNetElement}
                    dims={dims}
                    conductorDraft={conductorDraft}
                    dotSize={nodeDotSize}
                  />
                </g>
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

        {/* Zoom controls — the wheel and the Zoom tool do the same. The strip
            lets strokes pass while one is being drawn under it, so a stroke
            crossing it is not cut short by the overlay's mouseleave */}
        <div
          className={`absolute top-3 left-3 flex items-center rounded-lg bg-black/70 border border-gray-700 text-xs text-white ${
            dragActive || zp.panning ? 'pointer-events-none' : ''
          }`}
        >
          <button
            onClick={() => zp.zoomBy(1 / CLICK_ZOOM_STEP)}
            disabled={!zp.canZoomOut}
            className="px-2 py-1 hover:text-drone-primary disabled:opacity-40 disabled:hover:text-white"
            title="Zoom out"
          >
            −
          </button>
          <button
            onClick={zp.reset}
            className="px-1.5 py-1 font-mono tabular-nums min-w-[3.5rem] hover:text-drone-primary"
            title="Fit to window"
          >
            {Math.round(zp.zoom * 100)}%
          </button>
          <button
            onClick={() => zp.zoomBy(CLICK_ZOOM_STEP)}
            disabled={!zp.canZoomIn}
            className="px-2 py-1 hover:text-drone-primary disabled:opacity-40 disabled:hover:text-white"
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={zp.reset}
            disabled={!zp.canZoomOut}
            className="px-2 py-1 border-l border-gray-700 hover:text-drone-primary disabled:opacity-40 disabled:hover:text-white"
            title="Fit to window (100%)"
          >
            Fit
          </button>
        </div>

        {/* Cursor readout */}
        {cursorInfo && (
          <div className="absolute bottom-3 left-3 px-2.5 py-1.5 rounded-lg bg-black/70 border border-gray-700 text-xs text-white font-mono pointer-events-none">
            ({cursorInfo.x}, {cursorInfo.y}) · {formatTemp(cursorInfo.temp, valueSuffix)}
          </div>
        )}

        {/* Video frame capture — lets strokes pass while one is being drawn,
            like the zoom strip */}
        {isVideo && onCaptureFrame && (
          <button
            onClick={captureFrame}
            className={`absolute top-3 right-3 px-3 py-1.5 rounded-lg bg-drone-primary/90 hover:bg-drone-primary text-white text-xs font-medium ${
              dragActive || zp.panning ? 'pointer-events-none' : ''
            }`}
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

