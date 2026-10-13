import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/sim/world.js';
import { Physics, Tightener } from '../src/sim/physics.js';
import { makeView, toView } from '../src/sim/view.js';
import { applyStroke, assignDepth } from '../src/sim/sketch.js';
import { EXAMPLES, buildExample, crossings, strokesFor, tieExample } from '../src/sim/examples.js';

const view = makeView();
const line = (from, to, n = 40) => Array.from({ length: n + 1 }, (_, i) => [
  from[0] + ((to[0] - from[0]) * i) / n,
  from[1] + ((to[1] - from[1]) * i) / n,
]);

function minSeparation(world, selfSkip = 4) {
  let min = Infinity;
  world.ropes.forEach((a, ai) => world.ropes.forEach((b, bi) => {
    if (bi < ai) return;
    for (let i = 0; i < a.count; i++) {
      for (let j = a === b ? i + selfSkip : 0; j < b.count; j++) {
        min = Math.min(min, Math.hypot(...a.point(i).map((v, k) => v - b.point(j)[k])));
      }
    }
  }));
  return min;
}

function endToEnd(rope, spacing = 0.3) {
  const a = rope.point(0), b = rope.point(rope.count - 1);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / ((rope.count - 1) * spacing);
}

function tighten(world, physics, maxSteps = 20000) {
  const tightener = new Tightener(world.ropes.filter((rope) => !rope.pole).map((rope) => rope.id));
  let steps = 0, contacts = 0, closest = Infinity;
  while (!tightener.done && steps++ < maxSteps) {
    const stats = physics.step(world, { handles: tightener.handles(world) });
    tightener.update(world);
    contacts = stats.contacts;
    if (steps % 20 === 0) closest = Math.min(closest, minSeparation(world));
  }
  for (let i = 0; i < 200; i++) contacts = physics.step(world).contacts;
  return { steps, contacts, closest };
}

test('a stroke becomes an evenly spaced rope in the view plane', () => {
  const world = new World({ radius: 0.3 });
  const selection = applyStroke(world, view, line([-6, 0], [6, 0]), null);
  const rope = world.ropes[0];
  assert.equal(world.ropes.length, 1);
  assert.deepEqual(selection, { id: rope.id, index: rope.count - 1 });
  assert.ok(Math.abs(rope.count - 41) <= 1);
  for (let i = 0; i < rope.count; i++) assert.equal(rope.point(i)[2], 0);
});

test('a stroke is pulled over the ropes it crosses', () => {
  const world = new World({ radius: 0.3 });
  applyStroke(world, view, line([-6, 0], [6, 0]), null);
  applyStroke(world, view, line([0, -6], [0, 6]), null);
  const z = [];
  const over = world.ropes[1];
  for (let i = 0; i < over.count; i++) z.push(over.point(i)[2]);
  assert.ok(Math.max(...z) >= 2 * world.radius);
  assert.ok(Math.abs(z[0]) < 1e-9 && Math.abs(z.at(-1)) < 1e-9);
  assert.ok(minSeparation(world) >= 2 * world.radius - 1e-6);
});

test('the connector from a selected end is pulled under', () => {
  const world = new World({ radius: 0.3 });
  applyStroke(world, view, line([-6, 0], [6, 0]), null);
  const end = applyStroke(world, view, line([0, -8], [0, -3]), null);
  const result = applyStroke(world, view, line([0, 3], [0, 8]), end);
  const rope = world.ropeById(end.id);
  assert.equal(result.index, rope.count - 1);
  let lowest = 0;
  for (let i = 0; i < rope.count; i++) lowest = Math.min(lowest, rope.point(i)[2]);
  assert.ok(lowest <= -2 * world.radius);
  assert.ok(minSeparation(world) >= 2 * world.radius - 1e-6);
});

test('extending from the head keeps the rope continuous', () => {
  const world = new World({ radius: 0.3 });
  const rope = world.addRope(line([0, 0], [6, 0], 20).map(([x, y]) => [x, y, 0]));
  const selection = applyStroke(world, view, line([-2, 1], [-6, 3]), { id: rope.id, index: 0 });
  assert.equal(selection.index, 0);
  for (let i = 1; i < rope.count; i++) {
    const gap = Math.hypot(...rope.point(i).map((v, k) => v - rope.point(i - 1)[k]));
    assert.ok(gap < 1.3 * world.spacing, `gap ${gap} at ${i}`);
  }
});

test('a stroke from the middle of a rope pulls out a bight', () => {
  const world = new World({ radius: 0.3 });
  const rope = world.addRope(line([-6, 0], [6, 0], 40).map(([x, y]) => [x, y, 0]));
  const before = rope.count;
  const selection = applyStroke(world, view, line([0, 1], [0, 7]), { id: rope.id, index: 20 });
  assert.ok(rope.count > before + 30);
  const tip = toView(view, ...rope.point(selection.index));
  assert.ok(tip[1] > 6);
  for (let i = 1; i < rope.count; i++) {
    const gap = Math.hypot(...rope.point(i).map((v, k) => v - rope.point(i - 1)[k]));
    assert.ok(gap < 1.3 * world.spacing, `gap ${gap} at ${i}`);
  }
});

test('depth inference orders a self-crossing stroke', () => {
  const path = [...line([-3, 0], [3, 0], 20), ...line([3, 0], [3, 3], 10), ...line([3, 3], [0, 3], 10), ...line([0, 3], [0, -3], 20)]
    .map(([x, y]) => ({ x, y, mode: 'over' }));
  const z = assignDepth(path, [], { radius: 0.3 });
  assert.ok(z[10] === 0);
  assert.ok(z[z.length - 11] >= 0.6);
});

test('cutting removes a sphere and splits the rope', () => {
  const world = new World({ radius: 0.3 });
  const rope = world.addRope(line([0, 0], [3, 0], 10).map(([x, y]) => [x, y, 0]));
  const selection = world.cut(rope.id, 5);
  assert.deepEqual(world.ropes.map((r) => r.count), [5, 5]);
  assert.deepEqual(selection, { id: rope.id, index: 4 });
});

test('fixed spheres stay put while a neighbour is dragged', () => {
  const world = new World({ radius: 0.3 });
  const rope = world.addRope(line([0, 0], [6, 0], 20).map(([x, y]) => [x, y, 0]));
  world.toggleFix(rope.id, 0);
  const physics = new Physics();
  for (let i = 0; i < 300; i++) physics.step(world, { handles: [{ id: rope.id, index: 20, target: [3, 4, 0] }] });
  assert.deepEqual(rope.point(0), [0, 0, 0]);
  const end = rope.point(20);
  assert.ok(Math.hypot(end[0] - 3, end[1] - 4) < 0.05);
  assert.ok(Math.abs(endToEnd(rope) - 5 / 6) < 0.05);
});

test('a pole is rigid and cannot be picked', () => {
  const world = new World({ radius: 0.3 });
  const pole = world.addPole(line([-3, 0], [3, 0], 20).map(([x, y]) => [x, y, 0]));
  assert.ok(pole.fixed.every(Boolean));
  assert.equal(world.pick(view, 0, 0), null);
  world.restore(world.snapshot());
  assert.ok(world.ropes[0].pole);
});

test('undo snapshots restore the world', () => {
  const world = new World({ radius: 0.3 });
  applyStroke(world, view, line([-6, 0], [6, 0]), null);
  const snapshot = world.snapshot();
  const count = world.ropes[0].count;
  world.cut(world.ropes[0].id, 10);
  world.restore(snapshot);
  assert.equal(world.ropes.length, 1);
  assert.equal(world.ropes[0].count, count);
});

test('loosening pushes spheres out of the cylinder', () => {
  const world = new World({ radius: 0.3 });
  const rope = world.addRope(line([-6, 0.1], [6, 0.1], 40).map(([x, y]) => [x, y, 0]));
  const physics = new Physics();
  for (let i = 0; i < 400; i++) {
    physics.step(world, { cylinder: { origin: [0, 0, 0], axis: [0, 0, 1], radius: Math.min(2, i * 0.02) } });
  }
  for (let i = 0; i < rope.count; i++) {
    const p = rope.point(i);
    assert.ok(Math.hypot(p[0], p[1]) > 1.9);
  }
});

function reach(world) {
  // Mean distance of the rope ends from their middle, in rope lengths.
  const ends = world.ropes.flatMap((rope) => [rope.point(0), rope.point(rope.count - 1)]);
  const middle = [0, 1, 2].map((k) => ends.reduce((sum, p) => sum + p[k], 0) / ends.length);
  const spheres = world.ropes.reduce((sum, rope) => sum + rope.count, 0);
  return ends.reduce((sum, p) => sum + Math.hypot(...p.map((v, k) => v - middle[k])), 0) / (spheres * world.spacing);
}

for (const example of EXAMPLES) {
  test(`${example.name}: drawn stroke by stroke, stays knotted when tightened`, () => {
    const world = new World();
    const built = buildExample(example, world.radius);
    const paths = built.ropes.map((rope) => rope.path);
    const count = paths.reduce((sum, path, i) => sum + crossings(path).length
      + paths.slice(0, i).reduce((n, other) => n + crossings(path, other).length, 0), 0);
    assert.equal(count, example.crossings, 'the diagram has the intended crossings');

    tieExample(world, view, built);
    assert.equal(world.ropes.length, example.ropes.length);
    const physics = new Physics();
    for (let i = 0; i < 300; i++) physics.step(world);
    assert.ok(minSeparation(world) > 1.5 * world.radius, `loose separation ${minSeparation(world)}`);

    if (example.id === 'chain-link-fence') return; // every wire is held at both ends
    const result = tighten(world, physics);
    console.log(example.id, result, 'spheres', world.sphereCount, 'reach', reach(world).toFixed(3));
    assert.ok(result.steps < 20000, 'tightening stops by itself');
    assert.ok(result.closest > 1.2 * world.radius, `ropes never pass through each other (${result.closest})`);
    assert.ok(result.contacts > 5, 'the tightened knot has contacts');
  });
}

test('the overhand diagram drawn in one stroke, every crossing over, pulls straight', () => {
  const world = new World();
  const { path } = buildExample(EXAMPLES[0], world.radius).ropes[0];
  assert.equal(strokesFor(path, [], world.radius, true).length, 3);
  applyStroke(world, view, path.points, null);
  const rope = world.ropes[0];
  const physics = new Physics();
  const result = tighten(world, physics);
  assert.ok(result.closest > 1.2 * world.radius, `ropes never pass through each other (${result.closest})`);
  assert.equal(result.contacts, 0);
  assert.ok(endToEnd(rope, world.spacing) > 0.97);
});
