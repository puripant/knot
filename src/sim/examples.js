// Example knots, laid out the way they look when tied loosely by hand, and
// tied by issuing the same strokes a user would: the pen is lifted before each
// crossing that must go under and put down again on the far side, which makes
// the connector a pull-under.
//
// Diagrams are written in units of four rope radii. A control point is
// [x, y] or [x, y, height]; where two strands cross, the higher one is over.
// Crossings should be at least 1.75 units apart along the rope.

import { applyStroke, resample, subPath } from './sketch.js';
import { toView, toWorld } from './view.js';

const UNIT = 4; // rope radii per diagram unit
const CLEARANCE = 3.5; // rope radii between a lifted pen and the crossing
const MIN_STROKE = 4; // rope radii; shorter pieces between two unders are skipped

// A smooth path through the control points: { points: [[x, y]], z: [height], s: [arc length] }.
function spline(controls, scale, samples = 16) {
  const points = [], z = [];
  const at = (i) => controls[Math.min(controls.length - 1, Math.max(0, i))];
  for (let i = 0; i < controls.length - 1; i++) {
    const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 0; k < samples + (i === controls.length - 2 ? 1 : 0); k++) {
      const t = k / samples;
      const blend = (n) => 0.5 * (2 * (b[n] ?? 0) + (-(a[n] ?? 0) + (c[n] ?? 0)) * t
        + (2 * (a[n] ?? 0) - 5 * (b[n] ?? 0) + 4 * (c[n] ?? 0) - (d[n] ?? 0)) * t * t
        + (-(a[n] ?? 0) + 3 * (b[n] ?? 0) - 3 * (c[n] ?? 0) + (d[n] ?? 0)) * t * t * t);
      points.push([blend(0) * scale, blend(1) * scale]);
      z.push((b[2] ?? 0) + ((c[2] ?? 0) - (b[2] ?? 0)) * t);
    }
  }
  const s = [0];
  for (let i = 1; i < points.length; i++) {
    s.push(s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return { points, z, s };
}

// Where path `a` crosses path `b` (or itself): [{ sa, sb, za, zb }], with sa < sb on one path.
export function crossings(a, b = a) {
  const found = [];
  for (let i = 0; i < a.points.length - 1; i++) {
    for (let j = a === b ? i + 2 : 0; j < b.points.length - 1; j++) {
      const [ax, ay] = a.points[i], [bx, by] = a.points[i + 1], [cx, cy] = b.points[j], [dx, dy] = b.points[j + 1];
      const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (Math.abs(denom) < 1e-12) continue;
      const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
      const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      found.push({
        sa: a.s[i] + t * (a.s[i + 1] - a.s[i]), sb: b.s[j] + u * (b.s[j + 1] - b.s[j]),
        za: a.z[i] + t * (a.z[i + 1] - a.z[i]), zb: b.z[j] + u * (b.z[j + 1] - b.z[j]),
      });
    }
  }
  return found;
}

// The strokes that draw `path` over the ropes in `drawn`. A stroke passes over
// everything, so the path is split wherever it has to go under: at crossings
// with its own earlier part or with an earlier rope where it is the lower one.
// With `alternate`, self-crossings simply alternate over and under.
export function strokesFor(path, drawn, radius, alternate = false) {
  const unders = [];
  const own = crossings(path);
  if (alternate) {
    const visits = own.flatMap((c) => [{ s: c.sa }, { s: c.sb, second: true }]).sort((p, q) => p.s - q.s);
    visits.forEach((visit, order) => { if (visit.second && order % 2 === 1) unders.push(visit.s); });
  } else {
    for (const c of own) if (c.zb < c.za) unders.push(c.sb);
  }
  for (const other of drawn) for (const c of crossings(path, other)) if (c.za < c.zb) unders.push(c.sa);
  unders.sort((p, q) => p - q);

  const strokes = [];
  const total = path.s[path.s.length - 1];
  let from = 0;
  for (const s of [...unders, Infinity]) {
    const to = Math.min(total, s - CLEARANCE * radius);
    // A piece too short to be a rope is left to the pull-under connector.
    if (to - from >= MIN_STROKE * radius) strokes.push(subPath(path.points, from, to, radius / 2));
    from = s + CLEARANCE * radius;
  }
  return strokes;
}

// Lays out an example for a rope radius, centred on the origin.
export function buildExample(example, radius) {
  const ropes = example.ropes.map((rope) => ({ ...rope, path: spline(rope.controls, UNIT * radius) }));
  const all = ropes.flatMap((rope) => rope.path.points);
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const rope of ropes) {
    rope.path.points = rope.path.points.map(([x, y]) => [x - cx, y - cy]);
    rope.fix = (rope.fix ?? []).map(([x, y]) => [x * UNIT * radius - cx, y * UNIT * radius - cy]);
  }
  return { ropes, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// Ties a built example into the world, rope by rope and stroke by stroke.
// `onStroke` is told what each stroke did, as applyStroke reports it.
export function tieExample(world, view, built, onStroke) {
  const drawn = [];
  let selection = null;
  for (const spec of built.ropes) {
    if (spec.pole) {
      world.addPole(resample(spec.path.points, world.spacing).map(([x, y]) => toWorld(view, x, y, 0)));
      drawn.push(spec.path);
      continue;
    }
    selection = null;
    for (const stroke of strokesFor(spec.path, drawn, world.radius, spec.alternate)) {
      selection = applyStroke(world, view, stroke, selection);
      onStroke?.(selection);
    }
    drawn.push(spec.path);
    const rope = world.ropeById(selection.id);
    rope.look = spec.look ?? null;
    for (const [x, y] of spec.fix) {
      let nearest = 0, best = Infinity;
      for (let i = 0; i < rope.count; i++) {
        const v = toView(view, ...rope.point(i)), d = Math.hypot(v[0] - x, v[1] - y);
        if (d < best) { best = d; nearest = i; }
      }
      rope.fixed[nearest] = true;
    }
  }
  return selection;
}

// ---- diagrams -------------------------------------------------------------

// An overhand knot with `turns` crossings: a loop whose two sides are twisted
// around each other, as it looks after the end has gone through the loop one
// or more times.
function twisted(turns) {
  const pitch = 2.2, swing = 0.9, tail = 5;
  const left = -pitch / 2, right = (turns - 0.5) * pitch;
  const wave = (sign) => {
    const out = [];
    for (let x = left; x <= right + 1e-9; x += pitch / 6) out.push([x, sign * swing * Math.sin((Math.PI * x) / pitch)]);
    return out;
  };
  return [
    [left - tail, -swing], [left - tail / 2, -swing],
    ...wave(1),
    [right + 1.6, swing + 0.4], [right + 2.2, swing + 1.8], [right + 1.2, swing + 3.2],
    [(left + right) / 2, swing + 3.6],
    [left - 1.2, swing + 3.2], [left - 2.2, swing + 1.8], [left - 1.6, swing + 0.4],
    ...wave(-1),
    [right + tail / 2, -swing], [right + tail, -swing],
  ];
}

// Standing part from the top; the end crosses in front of it, goes around
// behind it and comes down through the first loop.
const FIGURE_EIGHT = [
  [0, 8], [0, 6], [0, 4], [0, 1], [0.5, -0.8], [1.8, -1.5], [3, -0.6], [3.1, 1.4], [1.9, 3], [0, 4.1],
  [-1.6, 4.7], [-2.1, 5.6], [-1.3, 6.4], [0, 6.3], [1.6, 5.9], [2.3, 4.9], [2, 3.6], [1.5, 1.5],
  [1.4, -0.2], [1.5, -3], [1.9, -6],
];

// Standing part from the top, a small loop laid on top of it (the "hole"),
// the big loop below, then the end: up through the hole, around behind the
// standing part and back down the hole.
const BOWLINE = [
  [0, 11, 0], [0, 8, 0], [0, 5, 0], [0, 3.6, 0], [0, 2.4, 0], [0.5, 1.2, 0], [1.6, 0.7, 0], [2.7, 1.3, 0],
  [2.9, 2.6, 0.3], [2, 3.6, 0.6], [1, 3.75, 0.8], [0, 3.65, 1],
  [-1.3, 3.2, 0.5], [-2.6, 1.5, 0], [-3.3, -2, 0], [-2.8, -5.5, 0], [-0.8, -7.5, 0], [1.6, -7.3, 0],
  [3.4, -5.5, 0], [4, -2.5, 0], [3.6, -0.8, 0],
  [2.9, 0, -1], [2.2, 0.75, -1.5], [1.9, 2, 0.5], [1.9, 3, 2], [1.85, 3.63, 2],
  [1.8, 5, 1.5], [1.2, 6.4, 0], [0, 6.9, -1.5], [-1, 6.5, -1], [-1.3, 5.6, 0.5], [-0.8, 5, 1.5], [0, 4.8, 2],
  [0.6, 4.6, 2], [0.9, 4.1, 2], [0.95, 3.7, 2], [0.9, 2.2, 0.5], [0.9, 1.3, -1], [0.9, 1, -1.5],
  [0.9, 0.2, -1.5], [1, -1, 0], [1.1, -2.5, 0],
];

// Two interlocked bights, each tied as two half knots: the lower three
// crossings and the upper three. In a reef knot the second half knot mirrors
// the first, so both parts of each rope leave the other rope's bight on the
// same side. In a granny knot it repeats the first, they leave on opposite
// sides, and the knot slips.
const BIGHT_LEFT = [
  [-8, 1], [-4.7, 1], [-1, 1], [1, 2], [3, 2], [4.4, 1.4], [5, 0], [4.4, -1.4], [3, -2], [1, -2], [-1, -1], [-3, -1], [-4.7, -1], [-8, -1],
];
// The left rope is over at its bight and at the other rope's bight, and under
// where the two ropes cross in the middle.
const REEF_LEFT_HEIGHT = [1, 1, -1, -1, 1, 1, 1, 1, 1, -1, -1, 1, 1, 1];
const BIGHT_RIGHT = [
  [8, 1], [4.7, 1], [1, 1], [-1, 2], [-3, 2], [-4.4, 1.4], [-5, 0], [-4.4, -1.4], [-3, -2], [-1, -2], [1, -1], [4.7, -1], [8, -1],
];
const GRANNY_RIGHT = [
  [8, 1, 1], [4.7, 1, 1], [1, 1, -1], [-1, 2, -1], [-3, 2, 1], [-4.4, 1.4, 1], [-5, 0, 0], [-4.4, -1.4, -1],
  [-3, -2, -1], [-1, -2, 1], [1, -1, 1], [3, -1, 0], [4.7, -1, -1], [8, -1, -1],
];

// A bight in one rope; the other comes up through it, goes around behind
// both of its parts and is tucked under itself.
const SHEET_BIGHT = [
  [-8, 2], [-2, 2], [2, 2], [4, 2], [5.3, 1.3], [5.8, 0], [5.3, -1.3], [4, -2], [2, -2], [-2, -2], [-8, -2],
];
const SHEET_END = [
  [11, 0.3, -1.5], [8, 0.3, -1.5], [6.6, 0.3, -1.5], [4.6, 0.3, 1.5], [2.4, 0.4, 1.5], [1.4, 1, 1.5], [1.1, 2, 1.5],
  [0.9, 3.2, 1], [0, 3.8, 0], [-0.9, 3.2, -1], [-1.1, 2, -1.5], [-1.1, 0, -1.5], [-1.1, -2, -1.5],
  [-0.9, -3.2, -1], [0, -3.8, 0], [1.2, -3.2, 1], [2.1, -2, 1.5], [2.5, -0.8, 0.7], [2.9, 0.33, 0],
  [3.2, 1.2, 0.8], [3.4, 2, 1.5], [3.8, 3.2, 1], [4.2, 4.4, 0],
];

// Hitches are tied around a pole lying across the diagram at height 0.
const POLE = [[-7, 0], [7, 0]];

// From below: in front of the pole and down behind it, diagonally across the
// standing part, around the pole again, and out under the diagonal.
const CLOVE_HITCH = [
  [0, -8, 0], [0, -3, 0.3], [0, 0, 1], [0, 1.5, 1], [-0.7, 2.6, 0], [-1.8, 2.8, -0.5], [-2.8, 2, -1], [-3, 0, -1],
  [-3, -1.5, -1], [-2.4, -2.7, 0], [-1.2, -3, 1.5], [0, -2.7, 1.5], [1.2, -2.2, 1.5], [2, -1.2, 1.5], [2.3, 0, 1.5],
  [2.3, 1.5, 1.5], [3, 2.6, 0], [4, 2.8, -0.5], [5, 2, -1], [5.2, 0, -1], [5.2, -1.5, -1], [4.6, -2.8, 0],
  [3.6, -3.1, 0.5], [2.4, -2.7, 0.5], [1.6, -1.7, 0.5], [1.2, -1.2, 0.7], [0.9, 0, 0.7], [0.7, 1.5, 0.5], [0.6, 4, 0], [0.6, 8, 0],
];

// A bight around the pole with both parts passing down through it.
const COW_HITCH = [
  [-0.8, -8, 0], [-0.8, -4, 0.3], [-0.8, 0, 1], [-0.8, 1.4, 1], [-1.2, 2.4, 0], [-1.9, 2.6, -0.5], [-2.4, 1.8, -1],
  [-2.4, 0, -1], [-2.4, -1.4, -1], [-2, -2.3, 0], [-1.2, -2.6, 1.5], [0, -2.6, 1.5], [1.2, -2.6, 1.5], [2, -2.3, 0],
  [2.4, -1.4, -1], [2.4, 0, -1], [2.4, 1.8, -1], [1.9, 2.6, -0.5], [1.2, 2.4, 0], [0.8, 1.4, 1], [0.8, 0, 1],
  [0.8, -2.6, 0], [0.8, -4, 0], [0.8, -8, 0],
];

// Chain-link fence: zigzag wires, each hooked through its neighbours at every
// bend. A wire is a flattened spiral, so its height swings with its zigzag.
function fenceWires(wires = 5, periods = 2) {
  const swing = 1.2, apart = 1.68, half = 4, tail = 1.5;
  return Array.from({ length: wires }, (_, k) => {
    const side = k % 2 ? -1 : 1, x = k * apart, top = 2 * periods * half;
    const controls = [[x, -tail, side]];
    for (let turn = 0; turn <= 24 * periods; turn++) {
      const angle = (turn * Math.PI) / 12;
      controls.push([x + side * swing * Math.sin(angle), (turn * half) / 12, side * Math.cos(angle)]);
    }
    controls.push([x, top + tail, side]);
    return { controls, fix: [[x, -tail], [x, top + tail]] };
  });
}

// `crossings` is how many the finished diagram has; the tests check it.
// `fix` lists points whose nearest sphere starts out fixed; `pole` marks a
// rigid pole instead of a rope; `look: 'contrast'` sets a rope apart from the
// others.
export const EXAMPLES = [
  { id: 'overhand', name: 'Overhand knot', crossings: 3, ropes: [{ controls: twisted(3), alternate: true }] },
  { id: 'figure-eight', name: 'Figure-eight knot', crossings: 4, ropes: [{ controls: FIGURE_EIGHT, alternate: true }] },
  { id: 'double-overhand', name: 'Double overhand knot', crossings: 5, ropes: [{ controls: twisted(5), alternate: true }] },
  { id: 'threefold-overhand', name: 'Threefold overhand knot', crossings: 7, ropes: [{ controls: twisted(7), alternate: true }] },
  { id: 'bowline', name: 'Bowline', crossings: 7, ropes: [{ controls: BOWLINE, fix: [[0.4, -7.5], [1.1, -2.5]] }] },
  {
    id: 'reef', name: 'Reef (square) knot', crossings: 6,
    ropes: [{ controls: BIGHT_LEFT.map(([x, y], i) => [x, y, REEF_LEFT_HEIGHT[i]]) }, { controls: BIGHT_RIGHT, look: 'contrast' }],
  },
  { id: 'granny', name: 'Granny knot', crossings: 6, ropes: [{ controls: BIGHT_LEFT }, { controls: GRANNY_RIGHT, look: 'contrast' }] },
  { id: 'sheet-bend', name: 'Sheet bend', crossings: 7, ropes: [{ controls: SHEET_BIGHT }, { controls: SHEET_END, look: 'contrast' }] },
  { id: 'clove-hitch', name: 'Clove hitch', crossings: 7, ropes: [{ controls: POLE, pole: true }, { controls: CLOVE_HITCH }] },
  { id: 'cow-hitch', name: 'Cow hitch', crossings: 6, ropes: [{ controls: POLE, pole: true }, { controls: COW_HITCH }] },
  { id: 'chain-link-fence', name: 'Chain-link fence', crossings: 16, ropes: fenceWires() },
];
