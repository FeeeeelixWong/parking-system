// Road-spine + BFS pathfinding for parking lot navigation.
//
// Phase 1: Dijkstra on the user-defined road graph from entrance A to the
//          closest point on the spine to the target spot.
// Phase 2: BFS (10-SVG-unit grid, cardinal only) for the last-mile from
//          that spine exit point into the actual parking spot.

export type PathSpot = {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
};

// ---------------------------------------------------------------------------
// Road spine — user-drawn and snapped
// ---------------------------------------------------------------------------
const ROAD: Record<string, [number, number]> = {
  A: [94,  1207],  // entrance
  B: [94,   982],  // south aisle
  C: [248,  982],  // main junction
  D: [248,  307],  // north-west junction
  E: [713,  709],  // north-east junction
  F: [713,  982],  // south-east
  G: [222,  279],
  H: [125,  279],
  I: [125,   61],
  J: [713,  625],
  K: [661,  625],
  L: [762,  625],
  M: [564,  625],
  N: [125,  170],
  O: [323,  345],
  P: [616,  625],
  Q: [796,  982],
  R: [796,  650],
  S: [661,  650],
  U: [661,  982],
  W: [564,  589],
};

// Undirected edges
const ROAD_EDGES: [string, string][] = [
  ['A', 'B'],
  ['B', 'C'], ['B', 'F'],
  ['C', 'D'],
  ['D', 'E'], ['D', 'O'], ['D', 'G'],
  ['E', 'F'], ['E', 'J'], ['E', 'P'],
  ['G', 'H'], ['G', 'N'],
  ['H', 'N'],
  ['I', 'H'], ['I', 'N'],
  ['J', 'K'], ['J', 'L'],
  ['N', 'I'],
  ['O', 'D'],
  ['P', 'D'], ['P', 'M'],
  ['F', 'U'], ['U', 'K'],
  ['F', 'Q'], ['Q', 'R'],
  ['C', 'U'], ['U', 'Q'], ['U', 'S'],
  ['M', 'W'],
];

// ---------------------------------------------------------------------------
// Road graph helpers
// ---------------------------------------------------------------------------
function dist2d(a: [number, number], b: [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Dijkstra on the road graph — returns ordered [x,y] waypoints. */
function roadDijkstra(fromId: string, toId: string): [number, number][] {
  if (fromId === toId) return [ROAD[fromId]];

  const adj: Record<string, { id: string; d: number }[]> = {};
  for (const k of Object.keys(ROAD)) adj[k] = [];
  for (const [a, b] of ROAD_EDGES) {
    const d = dist2d(ROAD[a], ROAD[b]);
    adj[a].push({ id: b, d });
    adj[b].push({ id: a, d });
  }

  const dist: Record<string, number> = {};
  const prev: Record<string, string | null> = {};
  const unvisited = new Set(Object.keys(ROAD));
  for (const k of unvisited) { dist[k] = Infinity; prev[k] = null; }
  dist[fromId] = 0;

  while (unvisited.size > 0) {
    let u = '';
    let minD = Infinity;
    for (const k of unvisited) if (dist[k] < minD) { minD = dist[k]; u = k; }
    if (!u || u === toId) break;
    unvisited.delete(u);
    for (const { id: v, d } of adj[u]) {
      if (!unvisited.has(v)) continue;
      const alt = dist[u] + d;
      if (alt < dist[v]) { dist[v] = alt; prev[v] = u; }
    }
  }

  const path: string[] = [];
  let cur: string | null = toId;
  while (cur !== null) { path.unshift(cur); cur = prev[cur] ?? null; }
  return path.map(k => ROAD[k]);
}

/** Closest point on segment [a,b] to point p. */
function closestOnSeg(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): { pt: [number, number]; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { pt: a, t: 0 };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { pt: [a[0] + t * dx, a[1] + t * dy], t };
}

/** Dijkstra from 'A' — returns distance map to all nodes. */
function roadDistsFromA(): Record<string, number> {
  const adj: Record<string, { id: string; d: number }[]> = {};
  for (const k of Object.keys(ROAD)) adj[k] = [];
  for (const [a, b] of ROAD_EDGES) {
    const d = dist2d(ROAD[a], ROAD[b]);
    adj[a].push({ id: b, d });
    adj[b].push({ id: a, d });
  }
  const dist: Record<string, number> = {};
  const unvisited = new Set(Object.keys(ROAD));
  for (const k of unvisited) dist[k] = Infinity;
  dist['A'] = 0;
  while (unvisited.size > 0) {
    let u = '', minD = Infinity;
    for (const k of unvisited) if (dist[k] < minD) { minD = dist[k]; u = k; }
    if (!u) break;
    unvisited.delete(u);
    for (const { id: v, d } of adj[u]) {
      if (!unvisited.has(v)) continue;
      const alt = dist[u] + d;
      if (alt < dist[v]) dist[v] = alt;
    }
  }
  return dist;
}

/**
 * Build the optimal road waypoints from A to the best exit point on the spine.
 *
 * For each road edge, computes total trip cost:
 *   min(roadDist(A→eA) + t·edgeLen, roadDist(A→eB) + (1-t)·edgeLen) + dist(exitPt, target)
 *
 * This prevents picking a geometrically close edge that requires a huge detour
 * to reach (e.g. T43-T46 near the C-D aisle but also near the long D-E diagonal).
 */
function roadSpinePath(target: [number, number]): [number, number][] {
  const dFromA = roadDistsFromA();

  let bestTotalCost = Infinity;
  let bestPt: [number, number] = ROAD['C'];
  let bestEdge: [string, string] = ['A', 'B'];
  let bestT = 0;
  let bestViaA = true;

  for (const [a, b] of ROAD_EDGES) {
    const { pt, t } = closestOnSeg(target, ROAD[a], ROAD[b]);
    const edgeLen = dist2d(ROAD[a], ROAD[b]);
    const distToTarget = dist2d(pt, target);

    const costViaA = dFromA[a] + t * edgeLen + distToTarget;
    const costViaB = dFromA[b] + (1 - t) * edgeLen + distToTarget;
    const cost = Math.min(costViaA, costViaB);

    if (cost < bestTotalCost) {
      bestTotalCost = cost;
      bestPt        = pt;
      bestEdge      = [a, b];
      bestT         = t;
      bestViaA      = costViaA <= costViaB;
    }
  }

  const snapped: [number, number] = [Math.round(bestPt[0]), Math.round(bestPt[1])];
  const exitNode = bestViaA ? bestEdge[0] : bestEdge[1];
  const road = roadDijkstra('A', exitNode);

  const atNode = bestViaA ? bestT <= 0.001 : bestT >= 0.999;
  if (!atNode) road.push(snapped);
  return road;
}

// ---------------------------------------------------------------------------
// BFS grid constants
// ---------------------------------------------------------------------------
const CELL     = 10;
const ORIGIN_X = -200;
const ORIGIN_Y = -80;
const GRID_W   = 150;
const GRID_H   = 135;
const MARGIN   = 4;   // SVG units of padding around each spot obstacle

// ---------------------------------------------------------------------------
// Lot boundary polygon (fence)
// ---------------------------------------------------------------------------
const LOT_POLYGON: [number, number][] = [
  [-5,  1210],
  [1005, 1210],
  [1005,  638],
  [780,  522],
  [640,  522],
  [390,  302],
  [390,  218],
  [321,  189],
  [265,  146],
  [195,   92],
  [-5,    -5],
];

function insideLot(x: number, y: number): boolean {
  const n = LOT_POLYGON.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = LOT_POLYGON[i];
    const [xj, yj] = LOT_POLYGON[j];
    const cross =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (cross) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------
function toCell(x: number, y: number): [number, number] {
  return [
    Math.floor((x - ORIGIN_X) / CELL),
    Math.floor((y - ORIGIN_Y) / CELL),
  ];
}

function cellCenter(gx: number, gy: number): [number, number] {
  return [
    ORIGIN_X + gx * CELL + CELL / 2,
    ORIGIN_Y + gy * CELL + CELL / 2,
  ];
}

function spotAABB(s: PathSpot) {
  const { cx, cy, w, h, rot } = s;
  if (!rot) {
    return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
  }
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pts = [
    [-w / 2, -h / 2],
    [ w / 2, -h / 2],
    [ w / 2,  h / 2],
    [-w / 2,  h / 2],
  ].map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
  return {
    x1: Math.min(...pts.map(p => p[0])),
    y1: Math.min(...pts.map(p => p[1])),
    x2: Math.max(...pts.map(p => p[0])),
    y2: Math.max(...pts.map(p => p[1])),
  };
}

// ---------------------------------------------------------------------------
// Build obstacle grid:
//   1. outside lot polygon → blocked
//   2. each spot AABB + MARGIN → blocked
// ---------------------------------------------------------------------------
function buildGrid(spots: PathSpot[], excludeId: string): boolean[][] {
  const g: boolean[][] = Array.from({ length: GRID_H }, (_, gy) =>
    Array.from({ length: GRID_W }, (_, gx) => {
      const [cx, cy] = cellCenter(gx, gy);
      return !insideLot(cx, cy);
    }),
  );

  for (const s of spots) {
    if (s.id === excludeId) continue;
    const { x1, y1, x2, y2 } = spotAABB(s);
    const gx1 = Math.max(0,        Math.floor((x1 - MARGIN - ORIGIN_X) / CELL));
    const gy1 = Math.max(0,        Math.floor((y1 - MARGIN - ORIGIN_Y) / CELL));
    const gx2 = Math.min(GRID_W-1, Math.ceil( (x2 + MARGIN - ORIGIN_X) / CELL));
    const gy2 = Math.min(GRID_H-1, Math.ceil( (y2 + MARGIN - ORIGIN_Y) / CELL));
    for (let gy = gy1; gy <= gy2; gy++)
      for (let gx = gx1; gx <= gx2; gx++)
        g[gy][gx] = true;
  }
  return g;
}

function clearRegion(
  g: boolean[][],
  gx1: number, gy1: number,
  gx2: number, gy2: number,
) {
  for (let gy = Math.max(0, gy1); gy <= Math.min(GRID_H - 1, gy2); gy++)
    for (let gx = Math.max(0, gx1); gx <= Math.min(GRID_W - 1, gx2); gx++)
      g[gy][gx] = false;
}

// ---------------------------------------------------------------------------
// Simplify: keep only direction-change (corner) waypoints
// ---------------------------------------------------------------------------
function simplify(cells: [number, number][]): [number, number][] {
  if (cells.length <= 2) return cells;
  const out: [number, number][] = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const [px, py] = cells[i - 1];
    const [cx, cy] = cells[i];
    const [nx, ny] = cells[i + 1];
    if (cx - px !== nx - cx || cy - py !== ny - cy) out.push(cells[i]);
  }
  out.push(cells[cells.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const ENTRANCE: [number, number] = [94, 1207];

export function computePath(
  spots: PathSpot[],
  targetId: string,
): [number, number][] | null {
  const target = spots.find(s => s.id === targetId);
  if (!target) return null;

  // Phase 1: road spine path from entrance to nearest spine point
  const roadWpts = roadSpinePath([target.cx, target.cy]);
  const spineExit = roadWpts[roadWpts.length - 1];

  // Phase 2: BFS from spine exit to actual spot
  const grid = buildGrid(spots, targetId);

  // Force-clear the target AABB + 1-cell border so BFS can always dock in
  // (tightly packed rows have overlapping MARGIN zones that wall off neighbors)
  const tbb = spotAABB(target);
  clearRegion(
    grid,
    Math.floor((tbb.x1 - ORIGIN_X) / CELL) - 1,
    Math.floor((tbb.y1 - ORIGIN_Y) / CELL) - 1,
    Math.ceil( (tbb.x2 - ORIGIN_X) / CELL) + 1,
    Math.ceil( (tbb.y2 - ORIGIN_Y) / CELL) + 1,
  );

  // Force-clear 3×3 zone around the spine exit so BFS can always start
  const [esx, esy] = toCell(spineExit[0], spineExit[1]);
  clearRegion(grid, esx - 1, esy - 1, esx + 1, esy + 1);

  const [sx, sy] = toCell(spineExit[0], spineExit[1]);
  const [ex, ey] = toCell(target.cx, target.cy);

  if (sx === ex && sy === ey) {
    return [...roadWpts, [target.cx, target.cy]];
  }

  const key = (x: number, y: number) => `${x},${y}`;
  const parent = new Map<string, string | null>();
  parent.set(key(sx, sy), null);
  const queue: [number, number][] = [[sx, sy]];
  const DIRS: [number, number][] = [
    [0, -1], [0, 1], [-1, 0], [1, 0],
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ];

  while (queue.length > 0) {
    const [gx, gy] = queue.shift()!;

    if (gx === ex && gy === ey) {
      const cells: [number, number][] = [];
      let k: string | null = key(gx, gy);
      while (k !== null) {
        const [a, b] = k.split(',').map(Number) as [number, number];
        cells.unshift([a, b]);
        k = parent.get(k) ?? null;
      }
      const simplified = simplify(cells);
      const bfsPts = simplified.map(([a, b]) => cellCenter(a, b)) as [number, number][];
      bfsPts[bfsPts.length - 1] = [target.cx, target.cy];

      // Stitch road + BFS: skip the BFS start if it duplicates the spine exit
      const combined: [number, number][] = [...roadWpts];
      const firstBfs = bfsPts[0];
      const lastRoad = roadWpts[roadWpts.length - 1];
      if (Math.abs(firstBfs[0] - lastRoad[0]) > 5 || Math.abs(firstBfs[1] - lastRoad[1]) > 5) {
        combined.push(...bfsPts);
      } else {
        combined.push(...bfsPts.slice(1));
      }
      return combined;
    }

    for (const [dx, dy] of DIRS) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      const nk = key(nx, ny);
      if (parent.has(nk) || grid[ny]?.[nx]) continue;
      parent.set(nk, key(gx, gy));
      queue.push([nx, ny]);
    }
  }

  // BFS found no path — return road spine only (spot still pulses)
  return null;
}

export function pathD(points: [number, number][]): string {
  if (!points.length) return '';
  return points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
}

export function pathTotalLength(points: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}
