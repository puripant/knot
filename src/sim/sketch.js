// Sketch-based operations (thesis chapters 3.1 and 4.1).
//
// A stroke is drawn in the plane parallel to the screen. The rope laid along
// the stroke is pulled OVER everything it crosses, including earlier parts of
// itself. If part of a rope is selected, a connector from the selection to the
// start of the stroke is added and pulled UNDER everything it crosses.
// Selecting the middle of a rope pulls a bight (a doubled strand) out along
// the stroke instead.

import { toView, toWorld } from './view.js';

const INDEX_GAP = 8; // path points closer than this along the rope are not crossings
const REACH = 2.3; // in radii: 2-D distance below which two spheres count as crossing
const SLOPE = 0.6; // depth change per sphere on the ramps beside a crossing
const BIGHT_OFFSET = 1.2; // in radii: half the distance between the strands of a bight

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(...points[i].map((v, k) => v - points[i - 1][k]));
  return len;
}

// Points at arc-length distances from..to along a polyline of any dimension.
function sampleAlong(points, distances) {
  const out = [];
  let seg = 1, walked = 0;
  let segLen = points.length > 1 ? Math.hypot(...points[1].map((v, k) => v - points[0][k])) : 0;
  for (const target of distances) {
    while (seg < points.length - 1 && walked + segLen < target) {
      walked += segLen;
      seg++;
      segLen = Math.hypot(...points[seg].map((v, k) => v - points[seg - 1][k]));
    }
    const t = segLen > 1e-12 ? Math.min(1, Math.max(0, (target - walked) / segLen)) : 0;
    const a = points[Math.max(0, seg - 1)], b = points[Math.min(seg, points.length - 1)];
    out.push(a.map((v, k) => v + (b[k] - v) * t));
  }
  return out;
}

// Evenly spaced points covering the whole polyline, end points included.
export function resample(points, spacing) {
  const total = pathLength(points);
  const segments = Math.max(1, Math.round(total / spacing));
  const distances = [];
  for (let i = 0; i <= segments; i++) distances.push((total * i) / segments);
  return sampleAlong(points, distances);
}

export function subPath(points, from, to, spacing) {
  const distances = [];
  for (let s = from; s < to; s += spacing) distances.push(s);
  distances.push(to);
  return sampleAlong(points, distances);
}

export function smoothStroke(points, spacing, passes = 2) {
  let out = resample(points, spacing);
  for (let pass = 0; pass < passes; pass++) {
    out = out.map((p, i) => (i === 0 || i === out.length - 1
      ? p
      : p.map((v, k) => (out[i - 1][k] + 2 * v + out[i + 1][k]) / 4)));
  }
  return resample(out, spacing);
}

function lineBetween(a, b, spacing) {
  const len = dist2(a, b);
  const out = [];
  for (let s = spacing; s < len - spacing / 2; s += spacing) {
    out.push([a[0] + ((b[0] - a[0]) * s) / len, a[1] + ((b[1] - a[1]) * s) / len]);
  }
  return out;
}

// Depth inference. `path` is [{ x, y, mode: 'over' | 'under' }] in view space,
// `obstacles` are existing spheres [{ x, y, z, da, db }] where da / db are their
// index distances along the rope from the path's start / end anchor (Infinity
// when unrelated). Returns the view-space depth of every path point.
export function assignDepth(path, obstacles, { radius, za = 0, zb = 0 }) {
  const n = path.length;
  const reach = REACH * radius, reach2 = reach * reach;
  const need = (d2) => Math.sqrt(reach2 - d2);

  const lo = new Float64Array(n).fill(-Infinity);
  const hi = new Float64Array(n).fill(Infinity);
  const earlier = Array.from({ length: n }, () => []);
  for (let j = 0; j < n; j++) {
    const p = path[j];
    for (const o of obstacles) {
      if (o.da + j + 1 < INDEX_GAP || o.db + (n - j) < INDEX_GAP) continue;
      const d2 = (o.x - p.x) ** 2 + (o.y - p.y) ** 2;
      if (d2 >= reach2) continue;
      if (p.mode === 'over') lo[j] = Math.max(lo[j], o.z + need(d2));
      else hi[j] = Math.min(hi[j], o.z - need(d2));
    }
    for (let i = 0; i <= j - INDEX_GAP; i++) {
      const d2 = (path[i].x - p.x) ** 2 + (path[i].y - p.y) ** 2;
      if (d2 < reach2) earlier[j].push([i, need(d2)]);
    }
  }

  const fade = (k) => Math.max(0, 1 - k / 16);
  const base = Float64Array.from({ length: n }, (_, i) => za * fade(i) + zb * fade(n - 1 - i));
  const z = Float64Array.from(base);

  // A later point always yields to an earlier one, so one ordered sweep
  // satisfies every crossing.
  const enforce = () => {
    for (let j = 0; j < n; j++) {
      let low = lo[j], high = hi[j];
      for (const [i, gap] of earlier[j]) {
        if (path[j].mode === 'under') high = Math.min(high, z[i] - gap);
        else low = Math.max(low, z[i] + gap);
      }
      if (z[j] < low) z[j] = low;
      if (z[j] > high) z[j] = high;
    }
  };
  const spread = (excess) => {
    const step = SLOPE * radius;
    for (let i = 1; i < n; i++) excess[i] = Math.max(excess[i], excess[i - 1] - step);
    for (let i = n - 2; i >= 0; i--) excess[i] = Math.max(excess[i], excess[i + 1] - step);
  };
  for (let sweep = 0; sweep < 5; sweep++) {
    enforce();
    const above = z.map((v, i) => Math.max(0, v - base[i]));
    const below = z.map((v, i) => Math.max(0, base[i] - v));
    spread(above);
    spread(below);
    for (let i = 0; i < n; i++) z[i] = base[i] + above[i] - below[i];
  }
  enforce();
  return z;
}

// The doubled path of a bight: out along one side of the stroke, around its
// end, and back along the other side.
function bightPath(stroke, a, b, radius, spacing) {
  const offset = BIGHT_OFFSET * radius;
  const left = [], right = [];
  let tangent = [1, 0];
  stroke.forEach((p, i) => {
    const prev = stroke[Math.max(0, i - 1)], next = stroke[Math.min(stroke.length - 1, i + 1)];
    const len = dist2(prev, next);
    if (len > 1e-9) tangent = [(next[0] - prev[0]) / len, (next[1] - prev[1]) / len];
    left.push([p[0] - tangent[1] * offset, p[1] + tangent[0] * offset]);
    right.push([p[0] + tangent[1] * offset, p[1] - tangent[0] * offset]);
  });
  const tip = stroke[stroke.length - 1];
  const capOf = (sign) => [1, 2, 3, 4, 5].map((k) => {
    const angle = (k * Math.PI) / 6;
    const side = Math.cos(angle) * offset * sign, ahead = Math.sin(angle) * offset;
    return [tip[0] - tangent[1] * side + tangent[0] * ahead, tip[1] + tangent[0] * side + tangent[1] * ahead];
  });
  // Pair the two cut ends with the two sides so that the strands do not cross.
  const straight = dist2(a, left[0]) + dist2(b, right[0]) <= dist2(a, right[0]) + dist2(b, left[0]);
  const [out, back, cap] = straight ? [left, right, capOf(1)] : [right, left, capOf(-1)];
  const tag = (points, mode) => points.map(([x, y]) => ({ x, y, mode }));
  return [
    ...tag(lineBetween(a, out[0], spacing), 'under'),
    ...tag(out, 'over'),
    ...tag(cap, 'over'),
    ...tag([...back].reverse(), 'over'),
    ...tag(lineBetween(back[0], b, spacing), 'under'),
  ];
}

// Lays a rope along `rawStroke` (view-space [x, y] points). With a selection
// { id, index } the selected rope is extended; otherwise a new rope is made.
// Returns the new selection, or null if the stroke is too short to be a rope.
export function applyStroke(world, view, rawStroke, selection) {
  const radius = world.radius, spacing = world.spacing;
  if (rawStroke.length < 2 || pathLength(rawStroke) < 3 * spacing) return null;
  const rope = selection ? world.ropeById(selection.id) : null;
  const last = rope ? rope.count - 1 : -1;
  const kind = !rope ? 'new' : selection.index === last ? 'tail' : selection.index === 0 ? 'head' : 'middle';
  const stroke = smoothStroke(rawStroke, spacing, kind === 'middle' ? 4 : 2);

  const obstacles = [];
  for (const other of world.ropes) {
    for (let i = 0; i < other.count; i++) {
      const [x, y, z] = toView(view, other.pos[3 * i], other.pos[3 * i + 1], other.pos[3 * i + 2]);
      let da = Infinity, db = Infinity;
      if (other === rope) {
        if (kind === 'tail') da = last - i;
        else if (kind === 'head') da = i;
        else if (i <= selection.index) da = selection.index - i;
        else db = i - selection.index - 1;
      }
      obstacles.push({ x, y, z, da, db });
    }
  }

  const tag = (points, mode) => points.map(([x, y]) => ({ x, y, mode }));
  let path, start = null, end = null;
  if (kind === 'new') {
    path = tag(stroke, 'over');
  } else if (kind === 'middle') {
    start = toView(view, ...rope.point(selection.index));
    end = toView(view, ...rope.point(selection.index + 1));
    path = bightPath(stroke, start, end, radius, spacing);
  } else {
    start = toView(view, ...rope.point(selection.index));
    path = [...tag(lineBetween(start, stroke[0], spacing), 'under'), ...tag(stroke, 'over')];
  }

  const z = assignDepth(path, obstacles, { radius, za: start ? start[2] : 0, zb: end ? end[2] : 0 });
  const points = path.map((p, i) => [p.x, p.y, z[i]]);

  // Space the spheres evenly along the 3-D path, leaving out the anchors.
  const full = [...(start ? [start] : []), ...points, ...(end ? [end] : [])];
  const even = resample(full, spacing).slice(start ? 1 : 0, end ? -1 : undefined);
  if (even.length < (rope ? 1 : 2)) return null;
  const added = even.map((p) => toWorld(view, p[0], p[1], p[2]));

  if (kind === 'new') {
    const created = world.addRope(added);
    return { id: created.id, index: created.count - 1 };
  }
  if (kind === 'tail') {
    rope.insert(rope.count, added);
    return { id: rope.id, index: rope.count - 1 };
  }
  if (kind === 'head') {
    rope.insert(0, added.reverse());
    return { id: rope.id, index: 0 };
  }
  rope.insert(selection.index + 1, added);
  return { id: rope.id, index: selection.index + 1 + (added.length >> 1) };
}
