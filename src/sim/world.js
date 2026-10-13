import { toView } from './view.js';

let nextId = 1;

// A rope is a chain of spheres. Positions and velocities are flat xyz arrays.
// A pole is a rope that is rigid: all of its spheres are fixed for good, and
// it cannot be picked, dragged or cut. Hitches are tied around one.
export class Rope {
  constructor(id = nextId++) {
    this.id = id;
    this.pole = false;
    this.pos = [];
    this.vel = [];
    this.fixed = [];
  }

  get count() {
    return this.fixed.length;
  }

  point(i) {
    return [this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]];
  }

  // Insert spheres so that the first one lands at index `at`.
  insert(at, points) {
    const pos = [], vel = [], fixed = [];
    for (const p of points) {
      pos.push(p[0], p[1], p[2]);
      vel.push(0, 0, 0);
      fixed.push(false);
    }
    this.pos.splice(3 * at, 0, ...pos);
    this.vel.splice(3 * at, 0, ...vel);
    this.fixed.splice(at, 0, ...fixed);
  }

  slice(from, to, id) {
    const rope = new Rope(id);
    rope.pole = this.pole;
    rope.pos = this.pos.slice(3 * from, 3 * to);
    rope.vel = this.vel.slice(3 * from, 3 * to);
    rope.fixed = this.fixed.slice(from, to);
    return rope;
  }
}

export class World {
  // Neighbouring spheres sit one radius apart, so they overlap and leave no
  // gap for another rope to slip through.
  constructor({ radius = 0.4 } = {}) {
    this.radius = radius;
    this.spacing = radius;
    this.ropes = [];
  }

  get sphereCount() {
    let n = 0;
    for (const rope of this.ropes) n += rope.count;
    return n;
  }

  ropeById(id) {
    return this.ropes.find((rope) => rope.id === id) ?? null;
  }

  addRope(points) {
    const rope = new Rope();
    rope.insert(0, points);
    this.ropes.push(rope);
    return rope;
  }

  addPole(points) {
    const pole = this.addRope(points);
    pole.pole = true;
    pole.fixed.fill(true);
    return pole;
  }

  clear() {
    this.ropes = [];
  }

  snapshot() {
    return this.ropes.map((rope) => rope.slice(0, rope.count, rope.id));
  }

  restore(snapshot) {
    this.ropes = snapshot.map((rope) => rope.slice(0, rope.count, rope.id));
  }

  toggleFix(id, index) {
    const rope = this.ropeById(id);
    if (!rope) return;
    rope.fixed[index] = !rope.fixed[index];
    rope.vel[3 * index] = rope.vel[3 * index + 1] = rope.vel[3 * index + 2] = 0;
  }

  // Removes the sphere, which opens a visible gap between the two new ends.
  // Returns the selection of one of the new ends.
  cut(id, index) {
    const at = this.ropes.findIndex((rope) => rope.id === id);
    if (at < 0) return null;
    const rope = this.ropes[at];
    const parts = [];
    if (index >= 2) parts.push(rope.slice(0, index, rope.id));
    if (rope.count - index - 1 >= 2) parts.push(rope.slice(index + 1, rope.count, parts.length ? undefined : rope.id));
    this.ropes.splice(at, 1, ...parts);
    if (!parts.length) return null;
    return index >= 2 ? { id: parts[0].id, index: index - 1 } : { id: parts[0].id, index: 0 };
  }

  // The sphere under view-space point (x, y) that is closest to the user.
  pick(view, x, y, tolerance = 0) {
    const reach2 = (this.radius + tolerance) ** 2;
    let best = null, bestZ = -Infinity;
    for (const rope of this.ropes) {
      if (rope.pole) continue;
      for (let i = 0; i < rope.count; i++) {
        const v = toView(view, rope.pos[3 * i], rope.pos[3 * i + 1], rope.pos[3 * i + 2]);
        const d2 = (v[0] - x) ** 2 + (v[1] - y) ** 2;
        if (d2 <= reach2 && v[2] > bestZ) {
          bestZ = v[2];
          best = { id: rope.id, index: i };
        }
      }
    }
    return best;
  }
}
