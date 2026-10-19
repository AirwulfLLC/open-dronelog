/**
 * useZoomPan — zoom and pan for an image surface inside an overflow-hidden
 * container (the Thermal Studio viewer).
 *
 * The surface keeps its fit size as 1× and is rendered at `fitted × zoom`,
 * translated by an offset in container pixels: resizing + translating (rather
 * than a CSS `scale()`) keeps SVG strokes crisp and `image-rendering:
 * pixelated` honest at every zoom. The offset is clamped so the surface is
 * centred while it fits the container and its edges never leave the container
 * once it is larger — at 1× that reproduces plain centring.
 *
 * Interactions the hook provides: zoom about a point (mouse wheel, native
 * non-passive listener so the page never scrolls), zoom about the centre
 * (buttons), a pan drag with window-level listeners (so leaving the element
 * or the window cannot strand it) that doubles as a click-to-zoom when the
 * pointer does not travel, and a reset to fit.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 10;
/** Zoom factor of one Zoom-tool click or +/− button (Shift+click divides by it). */
export const CLICK_ZOOM_STEP = 1.5;
/** Pointer travel (CSS px) beyond which a Zoom-tool press is a pan, not a click. */
const DRAG_THRESHOLD_PX = 3;
/** Wheel sensitivity: one mouse notch (100 px) ≈ ×1.22. */
const WHEEL_SENSITIVITY = 0.002;

export interface Size {
  w: number;
  h: number;
}

/** Where the surface sits: zoom level, top-left offset and sizes in container px. */
export interface ZoomGeometry {
  zoom: number;
  ox: number;
  oy: number;
  /** Surface size at this zoom (fitted × zoom). */
  W: number;
  H: number;
  /** Container client size. */
  cw: number;
  ch: number;
}

/** Offset that keeps a surface of `size` inside a box of `box`: centred when
 *  it fits, edges pinned to the box edges when it does not. */
export function clampAxis(offset: number, size: number, box: number): number {
  if (size <= box) return (box - size) / 2;
  return Math.min(0, Math.max(box - size, offset));
}

/** Geometry after zooming by `factor` about the container point (px, py): the
 *  image point under that position stays where it is. Unchanged (same object)
 *  when the zoom is already at its limit or the surface has no size yet. */
export function zoomAtPoint(g: ZoomGeometry, px: number, py: number, factor: number): ZoomGeometry {
  let zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.zoom * factor));
  // Repeated ×1.5 / ÷1.5 steps must land exactly on the limits (1× is "Fit")
  if (Math.abs(zoom - MIN_ZOOM) < 1e-9) zoom = MIN_ZOOM;
  if (Math.abs(zoom - MAX_ZOOM) < 1e-9) zoom = MAX_ZOOM;
  if (zoom === g.zoom || g.W <= 0 || g.H <= 0) return g;
  const k = zoom / g.zoom;
  const W = g.W * k;
  const H = g.H * k;
  return {
    ...g,
    zoom,
    W,
    H,
    ox: clampAxis(px - (px - g.ox) * k, W, g.cw),
    oy: clampAxis(py - (py - g.oy) * k, H, g.ch),
  };
}

interface View {
  zoom: number;
  /** Desired top-left offset; clamped at render time. */
  x: number;
  y: number;
}

interface Pan {
  /** Mouse button that started the press; only its release ends the pan. */
  button: number;
  startX: number;
  startY: number;
  ox0: number;
  oy0: number;
  moved: boolean;
  /** Zoom direction a click (no travel) applies; null for a plain pan (middle button). */
  clickZoom: 'in' | 'out' | null;
  cleanup: () => void;
}

export function useZoomPan(containerRef: RefObject<HTMLElement | null>, fitted: Size, box: Size) {
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  // Whole pixels throughout, so the canvas is never resampled on half pixels
  // and a pinned edge meets the container edge exactly
  const W = Math.round(fitted.w * view.zoom);
  const H = Math.round(fitted.h * view.zoom);
  const ox = Math.round(clampAxis(view.x, W, box.w));
  const oy = Math.round(clampAxis(view.y, H, box.h));

  // Current geometry and sizes for the native listeners, which must not read
  // React state (synced after every commit)
  const geomRef = useRef<ZoomGeometry>({ zoom: 1, ox: 0, oy: 0, W: 0, H: 0, cw: 0, ch: 0 });
  const sizesRef = useRef({ fw: 0, fh: 0, cw: 0, ch: 0 });
  useLayoutEffect(() => {
    geomRef.current = { zoom: view.zoom, ox, oy, W, H, cw: box.w, ch: box.h };
    sizesRef.current = { fw: fitted.w, fh: fitted.h, cw: box.w, ch: box.h };
  });

  const panRef = useRef<Pan | null>(null);

  /** Zoom by `factor` about a viewport (client) position. Functional update:
   *  two wheel events before a commit both take effect. */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const px = clientX - r.left;
      const py = clientY - r.top;
      setView((v) => {
        const { fw, fh, cw, ch } = sizesRef.current;
        const vW = Math.round(fw * v.zoom);
        const vH = Math.round(fh * v.zoom);
        if (vW <= 0 || vH <= 0) return v;
        const g: ZoomGeometry = { zoom: v.zoom, ox: clampAxis(v.x, vW, cw), oy: clampAxis(v.y, vH, ch), W: vW, H: vH, cw, ch };
        const next = zoomAtPoint(g, px, py, factor);
        return next === g ? v : { zoom: next.zoom, x: next.ox, y: next.oy };
      });
    },
    [containerRef],
  );

  /** Zoom by `factor` about the container centre (the +/− buttons). */
  const zoomBy = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    },
    [containerRef, zoomAt],
  );

  const reset = useCallback(() => setView({ zoom: 1, x: 0, y: 0 }), []);

  // Mouse wheel zooms about the cursor in every tool. React's onWheel is a
  // passive listener and cannot cancel the page scroll (or the webview's
  // ctrl+wheel zoom), so this is a native non-passive listener. Ignored while
  // a pan press is held: the pan's reference offset would no longer match.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (panRef.current) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const dy = Math.max(-200, Math.min(200, e.deltaY * unit));
      if (dy === 0) return;
      zoomAt(e.clientX, e.clientY, Math.exp(-dy * WHEEL_SENSITIVITY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [containerRef, zoomAt]);

  /** Start a pan at a viewport position for `button`. With `clickZoom`, a press
   *  that does not travel is a zoom click instead (the Zoom tool); null is a
   *  plain pan (middle button), which shows the grab cursor at once. */
  const beginPan = useCallback(
    (clientX: number, clientY: number, clickZoom: 'in' | 'out' | null, button: number) => {
      if (panRef.current) return;
      const g = geomRef.current;
      // End the press without a zoom click: the button was released where no
      // mouseup reached us (focus lost mid-drag) or the window lost focus
      const abort = () => {
        panRef.current?.cleanup();
        panRef.current = null;
        setPanning(false);
      };
      const onMove = (ev: MouseEvent) => {
        const p = panRef.current;
        if (!p) return;
        if (ev.buttons === 0) {
          abort();
          return;
        }
        const dx = ev.clientX - p.startX;
        const dy = ev.clientY - p.startY;
        if (!p.moved) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          p.moved = true;
          setPanning(true);
        }
        const gg = geomRef.current;
        // Written already clamped, so the surface never rubber-bands past the edges
        setView((v) => ({
          ...v,
          x: clampAxis(p.ox0 + dx, gg.W, gg.cw),
          y: clampAxis(p.oy0 + dy, gg.H, gg.ch),
        }));
      };
      const onUp = (ev: MouseEvent) => {
        const p = panRef.current;
        if (!p || ev.button !== p.button) return; // another button's release
        abort();
        if (!p.moved && p.clickZoom) {
          zoomAt(ev.clientX, ev.clientY, p.clickZoom === 'in' ? CLICK_ZOOM_STEP : 1 / CLICK_ZOOM_STEP);
        }
      };
      const cleanup = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', abort);
      };
      panRef.current = { button, startX: clientX, startY: clientY, ox0: g.ox, oy0: g.oy, moved: false, clickZoom, cleanup };
      if (!clickZoom) setPanning(true);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', abort);
    },
    [zoomAt],
  );

  // A drag in flight when the viewer unmounts (asset switch) must not leave
  // window listeners behind
  useEffect(() => () => panRef.current?.cleanup(), []);

  return {
    zoom: view.zoom,
    ox,
    oy,
    W,
    H,
    panning,
    canZoomIn: view.zoom < MAX_ZOOM,
    canZoomOut: view.zoom > MIN_ZOOM,
    zoomAt,
    zoomBy,
    reset,
    beginPan,
  };
}
