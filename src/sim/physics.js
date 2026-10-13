// Rope simulation after chapter 4.4 of the thesis: spheres joined by stiff
// neighbour springs and weak next-nearest (bending) springs, a repulsive force
// between touching spheres, all integrated with fourth-order Runge-Kutta.
// A relaxation pass then restores segment lengths in a follow-the-leader
// manner and pulls penetrating spheres apart, zeroing their velocity (which
// gives the rope its "sticky" friction). No sphere moves farther than a
// fraction of its radius per step, so ropes cannot pass through each other.
//
// Units: mass 1, time step 1.

export const PARAMS = {
  ks: 0.3, // neighbour spring
  kb: 0.04, // bending spring
  kr: 0.25, // repulsion
  damping: 0.35,
  iterations: 10, // relaxation sweeps per step
  maxMove: 0.5, // per-step displacement limit, in radii
  selfSkip: 4, // spheres closer than this along one rope never collide
  minBend: [1.6, 1.9], // least distance to the 2nd and 3rd neighbour, in spacings
  followSweeps: 2, // relaxation sweeps that start with a follow-the-leader pass
  settle: 6, // closing sweeps in which led spheres yield to the rope
  maxStretch: 0.12, // a step may not stretch a segment beyond this fraction
  maxOverlap: 0.08, // nor press two spheres into each other beyond this one
};

const CELL_OFFSET = 1 << 15;
const CELL_SPAN = 1 << 16;

export class Physics {
  constructor(params = {}) {
    this.params = { ...PARAMS, ...params };
    this.capacity = 0;
    this.pairs = new Int32Array(1024);
    this.pairCount = 0;
    this.spans = [];
  }

  _allocate(n) {
    if (n <= this.capacity) return;
    this.capacity = n * 2;
    const vec = () => new Float64Array(3 * this.capacity);
    this.X = vec(); this.X0 = vec(); this.V = vec(); this.V0 = vec(); this.Xs = vec();
    this.V2 = vec(); this.V3 = vec(); this.V4 = vec();
    this.A1 = vec(); this.A2 = vec(); this.A3 = vec(); this.A4 = vec();
    this.free = new Uint8Array(this.capacity);
    this.wD = new Float64Array(this.capacity);
    this.wC = new Float64Array(this.capacity);
    this.ropeOf = new Int32Array(this.capacity);
    this.hit = new Uint8Array(this.capacity);
  }

  // controls.handles: [{ id, index, target: [x, y, z] }] spheres led toward a target.
  // controls.cylinder: { origin, axis, radius } pushes spheres out of a cylinder.
  // Returns { contacts, held, strain: Map(rope id -> { mean, max }) }.
  step(world, controls = {}) {
    const p = this.params;
    const r = world.radius, d = world.spacing;
    const minDist = 2 * r, maxMove = p.maxMove * r;
    const n = world.sphereCount;
    const stats = { contacts: 0, held: false, strain: new Map() };
    if (!n) return stats;
    this._allocate(n);
    const { X, X0, V, V0, free, wD, wC, ropeOf, hit } = this;

    const spans = this.spans = [];
    let offset = 0;
    world.ropes.forEach((rope, ri) => {
      spans.push([offset, offset + rope.count]);
      for (let i = 0; i < rope.count; i++, offset++) {
        for (let k = 0; k < 3; k++) {
          X0[3 * offset + k] = rope.pos[3 * i + k];
          V0[3 * offset + k] = rope.vel[3 * i + k];
        }
        const mobile = rope.fixed[i] ? 0 : 1;
        free[offset] = mobile; wC[offset] = mobile;
        ropeOf[offset] = ri;
      }
    });

    // A led sphere ignores the springs but can still be pushed back by contact.
    const leaders = [];
    for (const handle of controls.handles ?? []) {
      const ri = world.ropes.findIndex((rope) => rope.id === handle.id);
      if (ri < 0 || handle.index >= world.ropes[ri].count) continue;
      const i = spans[ri][0] + handle.index;
      free[i] = 0; wC[i] = 1;
      V0[3 * i] = V0[3 * i + 1] = V0[3 * i + 2] = 0;
      leaders.push([i, handle.target]);
    }

    X.set(X0.subarray(0, 3 * n));
    this._buildPairs(n, minDist + 2 * maxMove + 0.2 * r);
    const before = this._measure(d, minDist);

    // A step that would stretch the rope or press ropes into each other is
    // taken again more gently: first without the follow-the-leader pass, which
    // drags a rope along its own path instead of pulling it straight, then
    // with a weaker pull, and finally with none. The hand yields to the rope,
    // because a stretched segment would open a gap for another strand.
    for (const [pull, follow] of [[1, true], [1, false], [0.5, false], [0.25, false], [0, false]]) {
      X.set(X0.subarray(0, 3 * n));
      V.set(V0.subarray(0, 3 * n));
      hit.fill(0, 0, n);
      for (let i = 0; i < n; i++) wD[i] = free[i];
      stats.contacts = this._solve(n, d, minDist, maxMove, leaders, pull, follow, pull > 0 ? controls.cylinder : null);
      const after = this._measure(d, minDist);
      const stretched = after.stretch > p.maxStretch && after.stretch > before.stretch + 1e-3;
      const pressed = after.overlap > p.maxOverlap && after.overlap > before.overlap + 1e-3;
      if (!stretched && !pressed) break;
      stats.held = true;
    }
    for (let i = 0; i < n; i++) {
      if (hit[i]) V[3 * i] = V[3 * i + 1] = V[3 * i + 2] = 0;
    }

    world.ropes.forEach((rope, ri) => {
      const [start, end] = spans[ri];
      let sum = 0, max = 0;
      for (let i = start; i < end; i++) {
        for (let k = 0; k < 3; k++) {
          rope.pos[3 * (i - start) + k] = X[3 * i + k];
          rope.vel[3 * (i - start) + k] = V[3 * i + k];
        }
        if (i < end - 1) {
          const len = Math.hypot(X[3 * i + 3] - X[3 * i], X[3 * i + 4] - X[3 * i + 1], X[3 * i + 5] - X[3 * i + 2]);
          const strain = len / d - 1;
          sum += strain;
          if (strain > max) max = strain;
        }
      }
      stats.strain.set(rope.id, { mean: sum / Math.max(1, end - start - 1), max });
    });
    return stats;
  }

  _solve(n, d, minDist, maxMove, leaders, pull, follow, cylinder) {
    const p = this.params;
    const { X, wD, ropeOf, spans } = this;
    this._integrate(n, d, minDist, maxMove);

    for (const [i, target] of leaders) {
      const dx = target[0] - X[3 * i], dy = target[1] - X[3 * i + 1], dz = target[2] - X[3 * i + 2];
      const len = Math.hypot(dx, dy, dz);
      const s = pull * (len > maxMove ? maxMove / len : 1);
      X[3 * i] += dx * s; X[3 * i + 1] += dy * s; X[3 * i + 2] += dz * s;
      wD[i] = 0;
    }
    const leads = leaders.map(([i]) => this._leadRange(i, spans[ropeOf[i]]));

    let contacts = 0;
    for (let iter = 0; iter < p.iterations; iter++) {
      // Follow the leader spreads a pull along slack rope at once. On a taut
      // rope it would shove the whole rope back and forth, so it only opens
      // the relaxation.
      if (follow && iter < p.followSweeps) {
        for (const [leader, from, to] of leads) {
          for (let i = leader - 1; i >= from; i--) this._follow(i, i + 1, d);
          for (let i = leader + 1; i <= to; i++) this._follow(i, i - 1, d);
          // Then back from whatever holds the far side of the stretch.
          if (from > spans[ropeOf[leader]][0]) for (let i = from; i < leader; i++) this._follow(i, i - 1, d);
          if (to < spans[ropeOf[leader]][1] - 1) for (let i = to; i > leader; i--) this._follow(i, i + 1, d);
        }
      }
      this._restoreRopes(iter, d);
      if (cylinder) this._pushOutOfCylinder(n, cylinder);
      // Contacts must only ever see positions close to the last valid state,
      // or a sphere could be separated toward the wrong side of another rope.
      this._limitMove(n, maxMove);
      contacts = this._separate(minDist);
    }
    // Closing sweeps in which the led spheres give way as well.
    for (const [i] of leaders) wD[i] = 1;
    for (let pass = 0; pass < p.settle; pass++) {
      this._restoreRopes(pass, d);
      this._separate(minDist);
    }
    return contacts;
  }

  // Worst segment stretch and worst overlap between spheres, as fractions.
  _measure(d, minDist) {
    const { X, pairs } = this;
    let stretch = 0, overlap = 0;
    for (const [start, end] of this.spans) {
      for (let i = start; i < end - 1; i++) {
        const len = Math.hypot(X[3 * i + 3] - X[3 * i], X[3 * i + 4] - X[3 * i + 1], X[3 * i + 5] - X[3 * i + 2]);
        stretch = Math.max(stretch, len / d - 1);
      }
    }
    for (let q = 0; q < this.pairCount; q++) {
      const i = pairs[2 * q], j = pairs[2 * q + 1];
      const len = Math.hypot(X[3 * j] - X[3 * i], X[3 * j + 1] - X[3 * i + 1], X[3 * j + 2] - X[3 * i + 2]);
      overlap = Math.max(overlap, 1 - len / minDist);
    }
    return { stretch, overlap };
  }

  // Candidate collision pairs within `range`, found through a uniform grid.
  _buildPairs(n, range) {
    const { X, ropeOf } = this;
    const selfSkip = this.params.selfSkip;
    const inv = 1 / range, range2 = range * range;
    const grid = new Map();
    const cells = new Int32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const cx = cells[3 * i] = Math.floor(X[3 * i] * inv) + CELL_OFFSET;
      const cy = cells[3 * i + 1] = Math.floor(X[3 * i + 1] * inv) + CELL_OFFSET;
      const cz = cells[3 * i + 2] = Math.floor(X[3 * i + 2] * inv) + CELL_OFFSET;
      const key = (cx * CELL_SPAN + cy) * CELL_SPAN + cz;
      const bucket = grid.get(key);
      if (bucket) bucket.push(i); else grid.set(key, [i]);
    }
    let count = 0;
    for (let i = 0; i < n; i++) {
      for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) for (let az = -1; az <= 1; az++) {
        const bucket = grid.get(((cells[3 * i] + ax) * CELL_SPAN + cells[3 * i + 1] + ay) * CELL_SPAN + cells[3 * i + 2] + az);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i || (ropeOf[i] === ropeOf[j] && j - i < selfSkip)) continue;
          const dx = X[3 * j] - X[3 * i], dy = X[3 * j + 1] - X[3 * i + 1], dz = X[3 * j + 2] - X[3 * i + 2];
          if (dx * dx + dy * dy + dz * dz > range2) continue;
          if (2 * count + 2 > this.pairs.length) {
            const grown = new Int32Array(this.pairs.length * 2);
            grown.set(this.pairs);
            this.pairs = grown;
          }
          this.pairs[2 * count] = i;
          this.pairs[2 * count + 1] = j;
          count++;
        }
      }
    }
    this.pairCount = count;
  }

  _acceleration(X, V, out, n, d, minDist) {
    const { ks, kb, kr, damping } = this.params;
    const { free, pairs } = this;
    out.fill(0, 0, 3 * n);
    const spring = (i, j, rest, k) => {
      const dx = X[3 * j] - X[3 * i], dy = X[3 * j + 1] - X[3 * i + 1], dz = X[3 * j + 2] - X[3 * i + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-9) return;
      const f = k * (len - rest) / len;
      out[3 * i] += dx * f; out[3 * i + 1] += dy * f; out[3 * i + 2] += dz * f;
      out[3 * j] -= dx * f; out[3 * j + 1] -= dy * f; out[3 * j + 2] -= dz * f;
    };
    for (const [start, end] of this.spans) {
      for (let i = start; i < end - 1; i++) {
        spring(i, i + 1, d, ks);
        if (i + 2 < end) spring(i, i + 2, 2 * d, kb);
      }
    }
    for (let q = 0; q < this.pairCount; q++) {
      const i = pairs[2 * q], j = pairs[2 * q + 1];
      const dx = X[3 * j] - X[3 * i], dy = X[3 * j + 1] - X[3 * i + 1], dz = X[3 * j + 2] - X[3 * i + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len >= minDist || len < 1e-9) continue;
      const f = kr * Math.min(1, minDist / len - 1) / len;
      out[3 * i] -= dx * f; out[3 * i + 1] -= dy * f; out[3 * i + 2] -= dz * f;
      out[3 * j] += dx * f; out[3 * j + 1] += dy * f; out[3 * j + 2] += dz * f;
    }
    for (let i = 0; i < n; i++) {
      for (let k = 3 * i; k < 3 * i + 3; k++) out[k] = free[i] ? out[k] - damping * V[k] : 0;
    }
  }

  _integrate(n, d, minDist, maxMove) {
    const { X, V, Xs, V2, V3, V4, A1, A2, A3, A4, free } = this;
    const m = 3 * n;
    this._acceleration(X, V, A1, n, d, minDist);
    for (let k = 0; k < m; k++) { Xs[k] = X[k] + 0.5 * V[k]; V2[k] = V[k] + 0.5 * A1[k]; }
    this._acceleration(Xs, V2, A2, n, d, minDist);
    for (let k = 0; k < m; k++) { Xs[k] = X[k] + 0.5 * V2[k]; V3[k] = V[k] + 0.5 * A2[k]; }
    this._acceleration(Xs, V3, A3, n, d, minDist);
    for (let k = 0; k < m; k++) { Xs[k] = X[k] + V3[k]; V4[k] = V[k] + A3[k]; }
    this._acceleration(Xs, V4, A4, n, d, minDist);
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      const a = 3 * i;
      let dx = (V[a] + 2 * V2[a] + 2 * V3[a] + V4[a]) / 6;
      let dy = (V[a + 1] + 2 * V2[a + 1] + 2 * V3[a + 1] + V4[a + 1]) / 6;
      let dz = (V[a + 2] + 2 * V2[a + 2] + 2 * V3[a + 2] + V4[a + 2]) / 6;
      for (let k = a; k < a + 3; k++) V[k] += (A1[k] + 2 * A2[k] + 2 * A3[k] + A4[k]) / 6;
      const len = Math.hypot(dx, dy, dz);
      if (len > maxMove) {
        const s = maxMove / len;
        dx *= s; dy *= s; dz *= s;
        V[a] *= s; V[a + 1] *= s; V[a + 2] *= s;
      }
      X[a] += dx; X[a + 1] += dy; X[a + 2] += dz;
    }
  }

  // The stretch of rope that follows a led sphere: up to the next sphere that
  // is fixed or led itself. Alternating passes from two leaders converge on a
  // rope that reaches both.
  _leadRange(leader, [start, end]) {
    const { wD } = this;
    let from = leader, to = leader;
    while (from > start && wD[from - 1] !== 0) from--;
    while (to < end - 1 && wD[to + 1] !== 0) to++;
    return [leader, from, to];
  }

  // Follow the leader: a stretched segment is restored by moving only the follower.
  _follow(i, toward, rest) {
    const { X } = this;
    const dx = X[3 * toward] - X[3 * i], dy = X[3 * toward + 1] - X[3 * i + 1], dz = X[3 * toward + 2] - X[3 * i + 2];
    const len = Math.hypot(dx, dy, dz);
    if (len <= rest) return;
    const f = (len - rest) / len;
    X[3 * i] += dx * f; X[3 * i + 1] += dy * f; X[3 * i + 2] += dz * f;
  }

  _restoreRopes(sweep, d) {
    const [bend2, bend3] = this.params.minBend;
    for (const [start, end] of this.spans) {
      if (sweep % 2 === 0) for (let i = start; i < end - 1; i++) this._restoreLength(i, d);
      else for (let i = end - 2; i >= start; i--) this._restoreLength(i, d);
      for (let i = start; i < end - 2; i++) {
        this._keepApart(i, i + 2, bend2 * d);
        if (i + 3 < end) this._keepApart(i, i + 3, bend3 * d);
      }
    }
  }

  // Minimum bend radius: the rope cannot fold flat onto itself.
  _keepApart(i, j, min) {
    const { X, wC } = this;
    const w = wC[i] + wC[j];
    if (w === 0) return;
    const dx = X[3 * j] - X[3 * i], dy = X[3 * j + 1] - X[3 * i + 1], dz = X[3 * j + 2] - X[3 * i + 2];
    const len = Math.hypot(dx, dy, dz);
    if (len >= min || len < 1e-9) return;
    const f = (min - len) / len / w;
    const fi = f * wC[i], fj = f * wC[j];
    X[3 * i] -= dx * fi; X[3 * i + 1] -= dy * fi; X[3 * i + 2] -= dz * fi;
    X[3 * j] += dx * fj; X[3 * j + 1] += dy * fj; X[3 * j + 2] += dz * fj;
  }

  _limitMove(n, maxMove) {
    const { X, X0, wC } = this;
    for (let i = 0; i < n; i++) {
      if (wC[i] === 0) continue;
      const dx = X[3 * i] - X0[3 * i], dy = X[3 * i + 1] - X0[3 * i + 1], dz = X[3 * i + 2] - X0[3 * i + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len <= maxMove) continue;
      const s = maxMove / len;
      X[3 * i] = X0[3 * i] + dx * s; X[3 * i + 1] = X0[3 * i + 1] + dy * s; X[3 * i + 2] = X0[3 * i + 2] + dz * s;
    }
  }

  _restoreLength(i, rest) {
    const { X, wD } = this;
    const j = i + 1, w = wD[i] + wD[j];
    if (w === 0) return;
    const dx = X[3 * j] - X[3 * i], dy = X[3 * j + 1] - X[3 * i + 1], dz = X[3 * j + 2] - X[3 * i + 2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return;
    const f = (len - rest) / len / w;
    const fi = f * wD[i], fj = f * wD[j];
    X[3 * i] += dx * fi; X[3 * i + 1] += dy * fi; X[3 * i + 2] += dz * fi;
    X[3 * j] -= dx * fj; X[3 * j + 1] -= dy * fj; X[3 * j + 2] -= dz * fj;
  }

  _separate(minDist) {
    const { X, wC, pairs, hit } = this;
    let contacts = 0;
    for (let q = 0; q < this.pairCount; q++) {
      const i = pairs[2 * q], j = pairs[2 * q + 1];
      const w = wC[i] + wC[j];
      const dx = X[3 * j] - X[3 * i], dy = X[3 * j + 1] - X[3 * i + 1], dz = X[3 * j + 2] - X[3 * i + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len >= minDist || len < 1e-9) continue;
      contacts++;
      hit[i] = hit[j] = 1;
      if (w === 0) continue;
      const f = (minDist - len) / len / w;
      const fi = f * wC[i], fj = f * wC[j];
      X[3 * i] -= dx * fi; X[3 * i + 1] -= dy * fi; X[3 * i + 2] -= dz * fi;
      X[3 * j] += dx * fj; X[3 * j + 1] += dy * fj; X[3 * j + 2] += dz * fj;
    }
    return contacts;
  }

  _pushOutOfCylinder(n, { origin, axis, radius }) {
    const { X, wC } = this;
    for (let i = 0; i < n; i++) {
      if (wC[i] === 0) continue;
      const dx = X[3 * i] - origin[0], dy = X[3 * i + 1] - origin[1], dz = X[3 * i + 2] - origin[2];
      const along = dx * axis[0] + dy * axis[1] + dz * axis[2];
      const rx = dx - along * axis[0], ry = dy - along * axis[1], rz = dz - along * axis[2];
      const len = Math.hypot(rx, ry, rz);
      if (len >= radius || len < 1e-9) continue;
      const f = (radius - len) / len;
      X[3 * i] += rx * f; X[3 * i + 1] += ry * f; X[3 * i + 2] += rz * f;
    }
  }
}

// Automatic tightening: the two ends of a rope are pulled apart at constant
// speed. When several ropes are tightened together, as in a bend, or when
// there is a pole to pull against, as in a hitch, each rope's ends are instead
// pulled away from the ends of the other ropes and poles, so both parts of a
// rope are drawn the same way. A rope stops once its ends no longer make
// progress because the knot has jammed.
export class Tightener {
  constructor(ids, { speed = 0.3, window = 30, minProgress = 0.1 } = {}) {
    this.ids = new Set(ids);
    this.options = { speed, window, minProgress };
    this.marks = new Map();
    this.ticks = 0;
  }

  get done() {
    return this.ids.size === 0;
  }

  // The ends being tightened, each with the point it is pulled away from.
  _ends(world) {
    const ends = [];
    for (const id of [...this.ids]) {
      const rope = world.ropeById(id);
      const last = rope ? rope.count - 1 : 0;
      if (!rope || last < 1 || (rope.fixed[0] && rope.fixed[last])) { this.ids.delete(id); continue; }
      for (const index of [0, last]) ends.push({ id, index, fixed: rope.fixed[index], at: rope.point(index) });
    }
    const middleOf = (group) => [0, 1, 2].map((k) => group.reduce((sum, end) => sum + end.at[k], 0) / group.length);
    const poles = world.ropes.filter((rope) => rope.pole)
      .flatMap((pole) => [{ at: pole.point(0) }, { at: pole.point(pole.count - 1) }]);
    for (const end of ends) {
      const others = [...ends.filter((other) => other.id !== end.id), ...poles];
      end.from = middleOf(others.length ? others : ends);
    }
    return ends;
  }

  handles(world) {
    const handles = [];
    for (const { id, index, fixed, at, from } of this._ends(world)) {
      if (fixed) continue;
      const out = at.map((v, k) => v - from[k]);
      const step = (this.options.speed * world.radius) / (Math.hypot(...out) || 1);
      handles.push({ id, index, target: at.map((v, k) => v + out[k] * step) });
    }
    return handles;
  }

  // Call after every simulation step.
  update(world) {
    const { speed, window, minProgress } = this.options;
    const check = ++this.ticks % window === 0;
    const ends = this._ends(world);
    for (const id of [...this.ids]) {
      const own = ends.filter((end) => end.id === id);
      const reach = own.reduce((sum, end) => sum + Math.hypot(...end.at.map((v, k) => v - end.from[k])), 0);
      if (!this.marks.has(id)) { this.marks.set(id, reach); continue; }
      if (!check) continue;
      const pulled = own.filter((end) => !end.fixed).length;
      if (reach - this.marks.get(id) < minProgress * pulled * speed * world.radius * window) this.ids.delete(id);
      this.marks.set(id, reach);
    }
  }
}
