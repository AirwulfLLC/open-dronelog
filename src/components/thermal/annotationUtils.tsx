/**
 * Annotation primitives shared by the thermal and photogrammetry viewers:
 * SVG rendering, hit-testing, translation, and canvas export. Coordinates are
 * image pixels of the annotated surface.
 */

import type { Annotation } from '@/types/thermal';

let annotationCounter = 0;
export function nextAnnotationId(): string {
  annotationCounter += 1;
  return `ann_${Date.now().toString(36)}_${annotationCounter}`;
}

export function AnnotationShape({ a, selected }: { a: Annotation; selected: boolean }) {
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

export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
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

export function hitTest(a: Annotation, pt: { x: number; y: number }, tolerance: number): boolean {
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

/** True for a click-without-drag shape that should be discarded. */
export function isDegenerateAnnotation(a: Annotation): boolean {
  return (
    (a.type === 'arrow' && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3) ||
    (a.type === 'freehand' && a.points.length < 6) ||
    (a.type === 'circle' && a.rx < 2 && a.ry < 2) ||
    (a.type === 'rect' && a.w < 3 && a.h < 3)
  );
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
