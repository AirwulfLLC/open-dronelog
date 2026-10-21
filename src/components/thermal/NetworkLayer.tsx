/**
 * NetworkLayer — SVG rendering of the heat-flow network over the thermal image:
 * nodes (shape by kind), conductors, and — after a solve — heat flow paths as
 * directional arrows scaled by |q| with wattage labels.
 */

import type {
  NetConductor,
  NetNode,
  NetworkSolveResult,
  NodeDotSize,
  ThermalNetworkModel,
} from '@/types/thermal';
import { NODE_DOT_SCALE } from '@/types/thermal';

type Point = { x: number; y: number };

/** Radius of a node's dot in image pixels for a surface `dimsW` pixels wide,
 *  at the chosen dot size (Large is the reference; Normal and Small are half
 *  and a quarter of it). Hit testing and erasing use the Large radius so a
 *  small dot stays as easy to pick. */
export function nodeRadius(dimsW: number, size: NodeDotSize = 'large'): number {
  return Math.max(5, dimsW / 79) * NODE_DOT_SCALE[size];
}

/** Pointer tolerance around a dot — wider than the dot so it stays easy to pick. */
function nodeHitRadius(dimsW: number): number {
  return nodeRadius(dimsW) * 2.3;
}

/** Pointer tolerance around a conductor's line. */
function conductorHitTolerance(dimsW: number): number {
  return Math.max(5, dimsW / 80);
}

/** Distance from `pt` to the segment a–b. */
function distToSegment(pt: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

/** Find the topmost node within hit radius of a point (image coordinates). */
export function hitTestNode(network: ThermalNetworkModel, pt: Point, dimsW: number): NetNode | null {
  const r = nodeHitRadius(dimsW);
  for (let i = network.nodes.length - 1; i >= 0; i--) {
    const n = network.nodes[i];
    if (Math.hypot(n.x - pt.x, n.y - pt.y) <= r) return n;
  }
  return null;
}

/** Find a conductor whose segment passes near the point. */
export function hitTestConductor(
  network: ThermalNetworkModel,
  pt: Point,
  dimsW: number,
): NetConductor | null {
  const tol = conductorHitTolerance(dimsW);
  const byId = new Map(network.nodes.map((n) => [n.id, n]));
  for (let i = network.conductors.length - 1; i >= 0; i--) {
    const c = network.conductors[i];
    const a = byId.get(c.from);
    const b = byId.get(c.to);
    if (!a || !b) continue;
    if (distToSegment(pt, a, b) < tol) return c;
  }
  return null;
}

/** Next free node id (N1, N2, …). */
export function nextNodeId(network: ThermalNetworkModel): string {
  let idx = 1;
  while (network.nodes.some((n) => n.id === `N${idx}`)) idx++;
  return `N${idx}`;
}

/** Next free conductor id (G1, G2, …). */
export function nextConductorId(network: ThermalNetworkModel): string {
  let idx = 1;
  while (network.conductors.some((c) => c.id === `G${idx}`)) idx++;
  return `G${idx}`;
}

/** The default link between two nodes: a linear conductor of 1 W/K (edited in the panel). */
export function linkConductor(id: string, from: string, to: string): NetConductor {
  return { id, label: '', from, to, kind: 'linear', value: { mode: 'constant', value: 1 } };
}

/**
 * Apply the eraser to the network at `pt` (image coordinates, eraser radius
 * in image pixels): a node whose dot lies within the eraser goes together
 * with its conductors; a conductor whose line passes under the eraser goes
 * alone. Returns the input object when nothing was touched, so callers can
 * skip re-rendering and persisting.
 */
export function eraseNetworkAt(
  network: ThermalNetworkModel,
  pt: Point,
  radius: number,
  dimsW: number,
): ThermalNetworkModel {
  const reach = radius + nodeRadius(dimsW);
  const gone = new Set(
    network.nodes.filter((n) => Math.hypot(n.x - pt.x, n.y - pt.y) <= reach).map((n) => n.id),
  );
  const byId = new Map(network.nodes.map((n) => [n.id, n]));
  const conductors = network.conductors.filter((c) => {
    if (gone.has(c.from) || gone.has(c.to)) return false;
    const a = byId.get(c.from);
    const b = byId.get(c.to);
    if (!a || !b) return true;
    return distToSegment(pt, a, b) > radius;
  });
  if (gone.size === 0 && conductors.length === network.conductors.length) return network;
  return { nodes: network.nodes.filter((n) => !gone.has(n.id)), conductors };
}

export function formatWatts(q: number): string {
  const a = Math.abs(q);
  if (a >= 1000) return `${(q / 1000).toFixed(2)} kW`;
  if (a >= 1) return `${q.toFixed(1)} W`;
  if (a >= 0.001) return `${(q * 1000).toFixed(1)} mW`;
  return `${(q * 1e6).toFixed(0)} µW`;
}

interface Props {
  network: ThermalNetworkModel;
  result: NetworkSolveResult | null;
  selected: { type: 'node' | 'conductor'; id: string } | null;
  dims: { w: number; h: number };
  /** Rubber-band conductor being drawn (image coordinates). */
  conductorDraft: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Size of the node dots (Large / Normal / Small). */
  dotSize: NodeDotSize;
}

export function NetworkLayer({ network, result, selected, dims, conductorDraft, dotSize }: Props) {
  if (network.nodes.length === 0 && !conductorDraft) return null;

  const r = nodeRadius(dims.w, dotSize);
  // Flow arrowheads keep their size; only the node dots were made smaller
  const arrowR = Math.max(7, dims.w / 55);
  const fs = Math.max(10, dims.w / 55);
  const byId = new Map(network.nodes.map((n) => [n.id, n]));

  // Final temperature per node id (last sample) when solved
  const finalTemp = new Map<string, number>();
  if (result) {
    result.nodeIds.forEach((id, i) => {
      const series = result.temps[i];
      if (series && series.length > 0) finalTemp.set(id, series[series.length - 1]);
    });
  }
  const flowById = new Map(result?.flows.map((f) => [f.id, f]) ?? []);
  const maxQ = result ? Math.max(1e-9, ...result.flows.map((f) => Math.abs(f.q))) : 1;

  return (
    <g>
      {/* Conductors */}
      {network.conductors.map((c) => {
        const a = byId.get(c.from);
        const b = byId.get(c.to);
        if (!a || !b) return null;
        const flow = flowById.get(c.id);
        const isSel = selected?.type === 'conductor' && selected.id === c.id;
        const baseColor = c.kind === 'radiative' ? '#c084fc' : '#94a3b8';

        let arrow: React.ReactNode = null;
        let label: React.ReactNode = null;
        let width = Math.max(1, dims.w / 500);
        if (flow && Math.abs(flow.q) > 1e-12) {
          width = Math.max(1.2, (dims.w / 220) * (0.3 + 0.7 * Math.sqrt(Math.abs(flow.q) / maxQ)));
          // Heat flows from → to when q > 0
          const sx = flow.q > 0 ? a : b;
          const tx = flow.q > 0 ? b : a;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const ang = Math.atan2(tx.y - sx.y, tx.x - sx.x);
          const ah = Math.max(6, arrowR * 0.9) + width * 1.5;
          arrow = (
            <polygon
              points={`${mx + ah * Math.cos(ang)},${my + ah * Math.sin(ang)} ${mx + ah * Math.cos(ang + 2.6)},${my + ah * Math.sin(ang + 2.6)} ${mx + ah * Math.cos(ang - 2.6)},${my + ah * Math.sin(ang - 2.6)}`}
              fill="#ff9f0a"
              stroke="#000"
              strokeWidth={0.6}
            />
          );
          label = (
            <text
              x={mx}
              y={my - ah - 2}
              textAnchor="middle"
              fill="#ffd60a"
              fontSize={fs * 0.9}
              fontWeight={700}
              paintOrder="stroke"
              stroke="#000"
              strokeWidth={fs / 6}
            >
              {formatWatts(Math.abs(flow.q))}
            </text>
          );
        }

        return (
          <g key={c.id} style={isSel ? { filter: 'drop-shadow(0 0 4px rgba(56,189,248,0.95))' } : undefined}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={flow ? '#ff9f0a' : baseColor}
              strokeWidth={width}
              strokeDasharray={c.kind === 'radiative' ? `${dims.w / 100} ${dims.w / 160}` : undefined}
              opacity={flow ? 0.95 : 0.75}
            />
            {arrow}
            {label}
          </g>
        );
      })}

      {/* Rubber band while drawing a conductor */}
      {conductorDraft && (
        <line
          x1={conductorDraft.x1}
          y1={conductorDraft.y1}
          x2={conductorDraft.x2}
          y2={conductorDraft.y2}
          stroke="#38bdf8"
          strokeWidth={Math.max(1.2, dims.w / 400)}
          strokeDasharray={`${dims.w / 120} ${dims.w / 200}`}
        />
      )}

      {/* Nodes */}
      {network.nodes.map((n) => {
        const isSel = selected?.type === 'node' && selected.id === n.id;
        const t = finalTemp.get(n.id);
        const fill =
          n.kind === 'boundary' ? '#0a84ff' : n.kind === 'arithmetic' ? '#1f2937' : '#ff453a';
        const shape =
          n.kind === 'boundary' ? (
            <rect
              x={n.x - r}
              y={n.y - r}
              width={r * 2}
              height={r * 2}
              fill={fill}
              stroke={isSel ? '#38bdf8' : '#fff'}
              strokeWidth={isSel ? 2.4 : 1.2}
            />
          ) : (
            <circle
              cx={n.x}
              cy={n.y}
              r={r}
              fill={fill}
              stroke={isSel ? '#38bdf8' : '#fff'}
              strokeWidth={isSel ? 2.4 : 1.2}
            />
          );
        return (
          <g key={n.id}>
            {shape}
            <text
              x={n.x}
              y={n.y - r - 3}
              textAnchor="middle"
              fill="#fff"
              fontSize={fs}
              fontWeight={700}
              paintOrder="stroke"
              stroke="#000"
              strokeWidth={fs / 6}
            >
              {n.label || n.id}
            </text>
            <text
              x={n.x}
              y={n.y + r + fs}
              textAnchor="middle"
              fill="#e5e7eb"
              fontSize={fs * 0.85}
              paintOrder="stroke"
              stroke="#000"
              strokeWidth={fs / 7}
            >
              {(t ?? n.initialTempC).toFixed(1)}°C
            </text>
          </g>
        );
      })}
    </g>
  );
}
