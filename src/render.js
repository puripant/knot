import * as THREE from 'three';

const VIEW_HEIGHT = 24; // world units visible vertically at zoom 1
const CAMERA_DISTANCE = 500;
const LIGHT_SLANT = 260; // how far the light sits off the view axis; with the distance, about 27 degrees
const RADIAL = 12; // tube sides
const CAP = [30, 60, 90].map((deg) => (deg * Math.PI) / 180);

// Marker colours: a fixed part, the selected part, and a part that is both.
const FIXED = 0xe5484d, SELECTED = 0x2f6feb, SELECTED_FIXED = 0x9b4fd6;

const STRANDS = 3; // strands of the laid rope
const LAY = 2.6; // rope length, in radii, over which a strand moves on by one

// Rope textures are drawn into canvases. Along u a texture repeats once per
// lay; v runs once around the rope. `shade(u, v)` returns [r, g, b] in 0..1.
function texture(shade, colour) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rgb = shade(x / size, y / size).map((value) => 255 * Math.max(0, Math.min(1, value)));
      image.data.set([...rgb, 255], 4 * (y * size + x));
    }
  }
  context.putImageData(image, 0, 0);
  const result = new THREE.CanvasTexture(canvas);
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.anisotropy = 4;
  if (colour) result.colorSpace = THREE.SRGBColorSpace;
  return result;
}

const grey = (value) => [value, value, value];
const fract = (value) => value - Math.floor(value);

// Three strands twisted together.
function twistedMaps() {
  const crown = (u, v) => Math.sin(Math.PI * fract(u + STRANDS * v)) ** 0.7; // 0 in the groove between strands
  const yarn = (u, v) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (10 * u - 3 * STRANDS * v)); // fibres within a strand
  return {
    map: texture((u, v) => grey((0.45 + 0.55 * crown(u, v)) * (0.92 + 0.08 * yarn(u, v)) + (Math.random() - 0.5) * 0.06), true),
    bumpMap: texture((u, v) => grey(0.92 * crown(u, v) + 0.08 * yarn(u, v))),
  };
}

// A braided sheath: two sets of strands running opposite ways around the
// rope, each passing over and under the other, every other strand lighter.
function braidedMaps() {
  const strand = (u, v) => {
    const a = 2 * u + 6 * v, b = 2 * u - 6 * v;
    const top = (Math.floor(a) + Math.floor(b)) % 2 === 0 ? a : b; // which set is on top here
    return { crown: Math.sin(Math.PI * fract(top)) ** 0.6, light: Math.abs(Math.floor(top)) % 2 === 1 && top === a };
  };
  return {
    map: texture((u, v) => {
      const { crown, light } = strand(u, v);
      const tone = 0.5 + 0.5 * crown + (Math.random() - 0.5) * 0.05;
      return (light ? [0.93, 0.9, 0.82] : [0.2, 0.42, 0.6]).map((channel) => channel * tone);
    }, true),
    bumpMap: texture((u, v) => grey(strand(u, v).crown)),
  };
}

// A satin ribbon: smooth along its length, with a slightly darker selvage on
// each side.
function ribbonMaps() {
  return { map: texture((u, v) => grey(v < 0.06 || v > 0.94 ? 0.82 : 1), true) };
}

// How each view draws a rope: its shape, colour and textures.
const STYLES = {
  twisted: { shape: 'tube', color: '#e6cda3', maps: twistedMaps, bumpScale: 2.5 },
  braided: { shape: 'tube', color: '#ffffff', maps: braidedMaps, bumpScale: 1.5 },
  plain: { shape: 'tube', color: '#e9e2d0', roughness: 0.6 },
  ribbon: { shape: 'ribbon', color: '#c9594b', maps: ribbonMaps, roughness: 0.45 },
  spheres: { shape: 'spheres', color: '#e6cda3', roughness: 0.6 },
  pole: { shape: 'tube', color: '#7d6652', roughness: 0.5 },
};
const mapCache = new Map();
function styleMaterial(mode) {
  const style = STYLES[mode];
  if (style.maps && !mapCache.has(mode)) mapCache.set(mode, style.maps());
  return new THREE.MeshStandardMaterial({
    color: style.color, roughness: style.roughness ?? 0.85, metalness: 0, side: THREE.DoubleSide,
    ...(style.maps ? { ...mapCache.get(mode), bumpScale: style.bumpScale ?? 1 } : {}),
  });
}

// The centre line of a rope: its spheres plus one Catmull-Rom point between each pair.
function centreLine(rope) {
  const n = rope.count, p = rope.pos;
  const out = new Float32Array(3 * (2 * n - 1));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) out[6 * i + k] = p[3 * i + k];
    if (i === n - 1) break;
    const a = Math.max(0, i - 1), d = Math.min(n - 1, i + 2);
    for (let k = 0; k < 3; k++) {
      out[6 * i + 3 + k] = (-p[3 * a + k] + 9 * p[3 * i + k] + 9 * p[3 * i + 3 + k] - p[3 * d + k]) / 16;
    }
  }
  return out;
}

// Tangent, normal and binormal at every centre-line point. The normal faces
// `hint` as far as the tangent allows, which keeps a ribbon lying flat in the
// drawing plane; where the rope runs along the hint the last normal is kept.
function frames(line, hint) {
  const m = line.length / 3;
  const T = new Float32Array(3 * m), N = new Float32Array(3 * m), B = new Float32Array(3 * m);
  let px = 1, py = 0, pz = 0;
  for (let i = 0; i < m; i++) {
    const a = 3 * Math.max(0, i - 1), b = 3 * Math.min(m - 1, i + 1);
    let tx = line[b] - line[a], ty = line[b + 1] - line[a + 1], tz = line[b + 2] - line[a + 2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    let nx = 0, ny = 0, nz = 0, nl = 0;
    for (const [hx, hy, hz] of [hint, [px, py, pz], [1, 0, 0], [0, 1, 0]]) {
      const dot = hx * tx + hy * ty + hz * tz;
      nx = hx - dot * tx; ny = hy - dot * ty; nz = hz - dot * tz;
      nl = Math.hypot(nx, ny, nz);
      if (nl > 0.3) break;
    }
    px = nx /= nl; py = ny /= nl; pz = nz /= nl;
    T.set([tx, ty, tz], 3 * i);
    N.set([nx, ny, nz], 3 * i);
    B.set([ty * nz - tz * ny, tz * nx - tx * nz, tx * ny - ty * nx], 3 * i);
  }
  return { T, N, B };
}

class RopeVisual {
  constructor(scene, mode, radius) {
    this.scene = scene;
    this.shape = STYLES[mode].shape;
    this.radius = radius;
    this.count = 0;
    this.material = styleMaterial(mode);
    this.mesh = null;
  }

  dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }

  update(rope, hint) {
    if (rope.count !== this.count) {
      this.dispose();
      this.count = rope.count;
      this.mesh = this.shape === 'spheres' ? this._buildSpheres() : new THREE.Mesh(this._buildGeometry(), this.material);
      this.mesh.frustumCulled = false;
      // A strand casts its shadow on the strands beneath it.
      this.mesh.castShadow = this.mesh.receiveShadow = true;
      this.scene.add(this.mesh);
    }
    if (this.shape === 'spheres') this._updateSpheres(rope);
    else if (this.shape === 'ribbon') this._updateRibbon(rope, hint);
    else this._updateTube(rope, hint);
  }

  _buildSpheres() {
    return new THREE.InstancedMesh(new THREE.SphereGeometry(this.radius, 20, 14), this.material, this.count);
  }

  _updateSpheres(rope) {
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < rope.count; i++) {
      matrix.setPosition(rope.pos[3 * i], rope.pos[3 * i + 1], rope.pos[3 * i + 2]);
      this.mesh.setMatrixAt(i, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  _buildGeometry() {
    const m = 2 * this.count - 1;
    const rings = this.shape === 'ribbon' ? m : m + 2 * CAP.length;
    // The tube repeats its first vertex at the end of every ring so the
    // texture can close around it.
    const around = this.shape === 'ribbon' ? 2 : RADIAL + 1;
    const geometry = new THREE.BufferGeometry();
    for (const [name, width] of [['position', 3], ['normal', 3], ['uv', 2]]) {
      geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(width * rings * around), width));
    }
    const index = [];
    for (let ring = 0; ring < rings - 1; ring++) {
      for (let s = 0; s < around - 1; s++) {
        const a = ring * around + s, b = a + 1;
        index.push(a, b, a + around, b, b + around, a + around);
      }
    }
    geometry.setIndex(index);
    return geometry;
  }

  // Texture u at every centre-line point: the length of rope up to it.
  _lengths(line) {
    const m = line.length / 3, scale = 1 / (LAY * this.radius);
    const u = new Float32Array(m);
    for (let i = 1; i < m; i++) {
      u[i] = u[i - 1] + Math.hypot(line[3 * i] - line[3 * i - 3], line[3 * i + 1] - line[3 * i - 2], line[3 * i + 2] - line[3 * i - 1]) * scale;
    }
    return u;
  }

  _updateTube(rope, hint) {
    const line = centreLine(rope);
    const { T, N, B } = frames(line, hint);
    const along = this._lengths(line);
    const m = line.length / 3, r = this.radius;
    const { position, normal, uv } = this.mesh.geometry.attributes;
    let v = 0;
    // One ring of the tube: centre c, frame taken from line point i, ring
    // radius `scale`, and normals tilted along the tangent by `tilt` on caps.
    const ring = (i, cx, cy, cz, scale, tilt, u) => {
      for (let s = 0; s <= RADIAL; s++, v++) {
        const angle = (s / RADIAL) * 2 * Math.PI, cos = Math.cos(angle), sin = Math.sin(angle);
        const ox = cos * N[3 * i] + sin * B[3 * i], oy = cos * N[3 * i + 1] + sin * B[3 * i + 1], oz = cos * N[3 * i + 2] + sin * B[3 * i + 2];
        position.setXYZ(v, cx + ox * r * scale, cy + oy * r * scale, cz + oz * r * scale);
        normal.setXYZ(v, ox * scale + T[3 * i] * tilt, oy * scale + T[3 * i + 1] * tilt, oz * scale + T[3 * i + 2] * tilt);
        uv.setXY(v, u, s / RADIAL);
      }
    };
    const cap = (i, direction, angle) => {
      const ahead = Math.sin(angle) * r * direction;
      ring(i, line[3 * i] + T[3 * i] * ahead, line[3 * i + 1] + T[3 * i + 1] * ahead, line[3 * i + 2] + T[3 * i + 2] * ahead,
        Math.cos(angle), Math.sin(angle) * direction, along[i] + (Math.sin(angle) * direction) / LAY);
    };
    for (let k = CAP.length - 1; k >= 0; k--) cap(0, -1, CAP[k]);
    for (let i = 0; i < m; i++) ring(i, line[3 * i], line[3 * i + 1], line[3 * i + 2], 1, 0, along[i]);
    for (let k = 0; k < CAP.length; k++) cap(m - 1, 1, CAP[k]);
    position.needsUpdate = normal.needsUpdate = uv.needsUpdate = true;
  }

  _updateRibbon(rope, hint) {
    const line = centreLine(rope);
    const { N, B } = frames(line, hint);
    const along = this._lengths(line);
    const m = line.length / 3, half = this.radius * 1.5;
    const { position, normal, uv } = this.mesh.geometry.attributes;
    for (let i = 0; i < m; i++) {
      for (let side = 0; side < 2; side++) {
        const w = side ? half : -half;
        position.setXYZ(2 * i + side, line[3 * i] + B[3 * i] * w, line[3 * i + 1] + B[3 * i + 1] * w, line[3 * i + 2] + B[3 * i + 2] * w);
        normal.setXYZ(2 * i + side, N[3 * i], N[3 * i + 1], N[3 * i + 2]);
        uv.setXY(2 * i + side, along[i], side);
      }
    }
    position.needsUpdate = normal.needsUpdate = uv.needsUpdate = true;
  }
}

export class Renderer {
  // The canvas is transparent and goes in front of `behind`, so that element
  // shows through wherever there is no rope.
  constructor(container, radius, behind) {
    this.container = container;
    this.radius = radius;
    this.mode = 'twisted';
    this.zoom = 1;
    this.target = new THREE.Vector3();
    this.visuals = new Map();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    behind.after(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    this.scene.add(this.camera);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x77777f, 0.75));
    // One light from the upper left of the screen. It turns with the view, so
    // an upper strand always drops its shadow down and to the right, on to
    // whatever passes beneath it.
    this.light = new THREE.DirectionalLight(0xffffff, 2.7);
    this.light.position.set(-LIGHT_SLANT * 0.55, LIGHT_SLANT * 0.85, 0);
    this.light.target.position.set(0, 0, -CAMERA_DISTANCE);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.radius = 4;
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.03;
    this.camera.add(this.light, this.light.target);

    const marker = (color, scale, opacity) => {
      const mesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(radius * scale, 24, 16),
        new THREE.MeshStandardMaterial({ color, roughness: 0.4, transparent: opacity < 1, opacity }),
        256,
      );
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.count = 0;
      this.scene.add(mesh);
      return mesh;
    };
    this.fixedMarkers = marker(FIXED, 1.45, 1);
    this.selectionMarker = marker(SELECTED, 1.7, 0.9);

    this.resize();
  }

  get pixelsPerUnit() {
    return (this.height * this.zoom) / VIEW_HEIGHT;
  }

  // The sketch plane: through the orbit target, parallel to the screen.
  get view() {
    const q = this.camera.quaternion;
    const axis = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(q).toArray();
    return { origin: this.target.toArray(), right: axis(1, 0, 0), up: axis(0, 1, 0), normal: axis(0, 0, 1) };
  }

  screenToView(px, py) {
    return [(px - this.width / 2) / this.pixelsPerUnit, -(py - this.height / 2) / this.pixelsPerUnit];
  }

  viewToScreen(x, y) {
    return [this.width / 2 + x * this.pixelsPerUnit, this.height / 2 - y * this.pixelsPerUnit];
  }

  resize() {
    this.width = this.container.clientWidth || 1;
    this.height = this.container.clientHeight || 1;
    this.renderer.setSize(this.width, this.height);
    this._updateCamera();
  }

  _updateCamera() {
    const halfH = VIEW_HEIGHT / 2 / this.zoom, halfW = (halfH * this.width) / this.height;
    Object.assign(this.camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    this.camera.position.copy(this.target).add(new THREE.Vector3(0, 0, CAMERA_DISTANCE).applyQuaternion(this.camera.quaternion));
    this.camera.updateProjectionMatrix();
    // The shadow map covers what is in view, with room for the light's slant.
    const reach = Math.max(halfW, halfH) * 1.25, shadow = this.light.shadow.camera;
    Object.assign(shadow, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 3 * CAMERA_DISTANCE });
    shadow.updateProjectionMatrix();
  }

  rotate(dxPixels, dyPixels) {
    const speed = 0.008;
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(-dyPixels * speed, -dxPixels * speed, 0));
    this.camera.quaternion.multiply(turn).normalize();
    this._updateCamera();
  }

  pan(dxPixels, dyPixels) {
    const { right, up } = this.view;
    const k = 1 / this.pixelsPerUnit;
    this.target.x += (-dxPixels * right[0] + dyPixels * up[0]) * k;
    this.target.y += (-dxPixels * right[1] + dyPixels * up[1]) * k;
    this.target.z += (-dxPixels * right[2] + dyPixels * up[2]) * k;
    this._updateCamera();
  }

  zoomBy(factor) {
    this.zoom = Math.min(6, Math.max(0.3, this.zoom * factor));
    this._updateCamera();
  }

  resetView() {
    this.zoom = 1;
    this.target.set(0, 0, 0);
    this.camera.quaternion.identity();
    this._updateCamera();
  }

  // Shows the front view of a box of the drawing plane, given by its size.
  frame(width, height) {
    this.resetView();
    const margin = 1.25;
    this.zoom = Math.min(1.2, VIEW_HEIGHT / (height * margin), (VIEW_HEIGHT * this.width) / this.height / (width * margin));
    this._updateCamera();
  }

  setMode(mode) {
    this.mode = mode;
    for (const visual of this.visuals.values()) visual.dispose();
    this.visuals.clear();
  }

  // A pole always looks like a pole. A rope that an example sets apart takes
  // the other rope texture, as long as the view shows ropes at all.
  _styleFor(rope) {
    if (rope.pole) return 'pole';
    if (rope.look === 'contrast' && STYLES[this.mode].shape === 'tube') return this.mode === 'braided' ? 'twisted' : 'braided';
    return this.mode;
  }

  get canvas() {
    return this.renderer.domElement;
  }

  // The rope meshes as last drawn, for exporting as a 3-D model.
  exportGroup() {
    const group = new THREE.Group();
    group.name = 'knot';
    let n = 0;
    for (const visual of this.visuals.values()) {
      if (!visual.mesh) continue;
      const mesh = visual.mesh.clone();
      mesh.name = `rope-${++n}`;
      group.add(mesh);
    }
    return group;
  }

  // Brings the meshes in line with the world and draws a frame.
  draw(world, selection) {
    const hint = [0, 0, 1];
    const seen = new Set();
    const matrix = new THREE.Matrix4();
    let fixed = 0;
    for (const rope of world.ropes) {
      seen.add(rope.id);
      let visual = this.visuals.get(rope.id);
      if (!visual) this.visuals.set(rope.id, visual = new RopeVisual(this.scene, this._styleFor(rope), this.radius));
      visual.update(rope, hint);
      for (let i = 0; i < rope.count && fixed < 256; i++) {
        if (!rope.fixed[i] || rope.pole) continue;
        matrix.setPosition(rope.pos[3 * i], rope.pos[3 * i + 1], rope.pos[3 * i + 2]);
        this.fixedMarkers.setMatrixAt(fixed++, matrix);
      }
    }
    for (const [id, visual] of this.visuals) {
      if (seen.has(id)) continue;
      visual.dispose();
      this.visuals.delete(id);
    }
    this.fixedMarkers.count = fixed;
    this.fixedMarkers.instanceMatrix.needsUpdate = true;

    const selected = selection && world.ropeById(selection.id);
    this.selectionMarker.count = selected ? 1 : 0;
    if (selected) {
      this.selectionMarker.material.color.set(selected.fixed[selection.index] ? SELECTED_FIXED : SELECTED);
      matrix.setPosition(...selected.point(selection.index));
      this.selectionMarker.setMatrixAt(0, matrix);
      this.selectionMarker.instanceMatrix.needsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
