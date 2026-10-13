// Getting a knot out of the app: pictures, a step-by-step sheet, 3-D model
// files, a video clip, and handing any of them to the system share sheet.

import * as THREE from 'three';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Draws the WebGL canvas into a box of a 2-D canvas, whole and centred, on the
// page background. The WebGL canvas is transparent, so the two join seamlessly.
function paint(context, source, x, y, width, height) {
  context.fillStyle = css('--paper');
  context.fillRect(x, y, width, height);
  const scale = Math.min(width / source.width, height / source.height);
  const w = source.width * scale, h = source.height * scale;
  context.drawImage(source, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

function blank(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// The current view, without selection markers.
export function picture(renderer, world, { width = 1600, height = 1200 } = {}) {
  const canvas = blank(width, height);
  renderer.draw(world, null);
  paint(canvas.getContext('2d'), renderer.canvas, 0, 0, width, height);
  return canvas;
}

// One numbered tile per step, each showing the world as it was after that
// step, all from the current view. `steps` is [{ ropes: snapshot, label }].
export function stepSheet(renderer, world, steps) {
  const tile = { width: 520, height: 400, caption: 56, gap: 16 };
  const columns = steps.length <= 4 ? Math.min(2, steps.length) : 3;
  const rows = Math.ceil(steps.length / columns);
  const canvas = blank(columns * (tile.width + tile.gap) + tile.gap, rows * (tile.height + tile.caption + tile.gap) + tile.gap);
  const context = canvas.getContext('2d');
  context.fillStyle = css('--paper');
  context.fillRect(0, 0, canvas.width, canvas.height);

  const now = world.snapshot();
  steps.forEach((step, i) => {
    const x = tile.gap + (i % columns) * (tile.width + tile.gap);
    const y = tile.gap + Math.floor(i / columns) * (tile.height + tile.caption + tile.gap);
    world.restore(step.ropes);
    renderer.draw(world, null);
    paint(context, renderer.canvas, x, y, tile.width, tile.height);
    context.strokeStyle = css('--line');
    context.strokeRect(x + 0.5, y + 0.5, tile.width - 1, tile.height - 1);
    context.textBaseline = 'middle';
    context.font = '600 22px system-ui, sans-serif';
    context.fillStyle = css('--ink');
    context.fillText(`${i + 1}.`, x + 4, y + tile.height + tile.caption / 2);
    context.font = '20px system-ui, sans-serif';
    context.fillText(step.label, x + 40, y + tile.height + tile.caption / 2, tile.width - 44);
  });
  world.restore(now);
  renderer.draw(world, null);
  return canvas;
}

export function canvasBlob(canvas, type = 'image/png') {
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}

// Wavefront OBJ: positions, normals and triangles, one object per rope.
export function toOBJ(group) {
  const lines = ['# Knot'];
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4(), turn = new THREE.Matrix3();
  let base = 1;
  for (const mesh of group.children) {
    const { position, normal } = mesh.geometry.attributes, index = mesh.geometry.index;
    lines.push(`o ${mesh.name}`);
    for (let copy = 0; copy < (mesh.isInstancedMesh ? mesh.count : 1); copy++) {
      if (mesh.isInstancedMesh) mesh.getMatrixAt(copy, matrix); else matrix.identity();
      turn.getNormalMatrix(matrix);
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(matrix);
        lines.push(`v ${point.x.toFixed(5)} ${point.y.toFixed(5)} ${point.z.toFixed(5)}`);
      }
      for (let i = 0; i < normal.count; i++) {
        point.fromBufferAttribute(normal, i).applyMatrix3(turn).normalize();
        lines.push(`vn ${point.x.toFixed(4)} ${point.y.toFixed(4)} ${point.z.toFixed(4)}`);
      }
      for (let i = 0; i < index.count; i += 3) {
        const [a, b, c] = [index.getX(i) + base, index.getX(i + 1) + base, index.getX(i + 2) + base];
        lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
      }
      base += position.count;
    }
  }
  return new Blob([lines.join('\n'), '\n'], { type: 'model/obj' });
}

// Binary glTF, which keeps the rope colours and textures. The exporter is only
// fetched when it is first needed.
export async function toGLB(group) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const buffer = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(group, resolve, reject, { binary: true });
  });
  return new Blob([buffer], { type: 'model/gltf-binary' });
}

export function save(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

// Offers the file to the system share sheet where there is one, and saves it
// otherwise. Resolves to 'shared', 'cancelled' or 'saved'.
export async function share(blob, name, text) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Knot', text });
      return 'shared';
    } catch (error) {
      if (error.name === 'AbortError') return 'cancelled';
    }
  }
  save(blob, name);
  return 'saved';
}

// Records the view as a video clip. Call capture() once per frame while
// recording; stop() resolves to the clip.
export class Recorder {
  static get supported() {
    return typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  }

  constructor({ width = 1280, height = 720, seconds = 30 } = {}) {
    this.canvas = blank(width, height);
    this.context = this.canvas.getContext('2d');
    this.limit = seconds * 1000;
    this.media = null;
  }

  get recording() {
    return this.media !== null;
  }

  // True once the clip has reached its longest allowed length.
  get full() {
    return this.recording && performance.now() - this.started > this.limit;
  }

  start() {
    const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    this.chunks = [];
    this.media = new MediaRecorder(this.canvas.captureStream(30), type ? { mimeType: type } : undefined);
    this.media.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
    this.media.start();
    this.started = performance.now();
  }

  capture(renderer) {
    if (this.recording) paint(this.context, renderer.canvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  stop() {
    const media = this.media;
    this.media = null;
    return new Promise((resolve) => {
      media.onstop = () => resolve(new Blob(this.chunks, { type: media.mimeType.split(';')[0] }));
      media.stop();
    });
  }
}
