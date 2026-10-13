import { World } from './sim/world.js';
import { Physics, Tightener } from './sim/physics.js';
import { applyStroke, pathLength } from './sim/sketch.js';
import { toView, toWorld } from './sim/view.js';
import { EXAMPLES, buildExample, tieExample } from './sim/examples.js';
import { Renderer } from './render.js';

const STEPS_PER_FRAME = 4;
const DOUBLE_TAP_MS = 350;
const UNDO_LIMIT = 60;
const WEDGE_GROWTH = 0.04; // loosening cylinder growth per frame, in world units
const WEDGE_MAX = 6;

const $ = (id) => document.getElementById(id);
const stage = $('stage');

const world = new World();
const physics = new Physics();
const renderer = new Renderer(stage, world.radius, $('underlay'));

let tool = 'sketch';
let selection = null;
const coarse = window.matchMedia('(pointer: coarse)').matches;
let tightener = null;
let gesture = null; // what the active pointer is doing
let lastTap = null;
const pointers = new Map();
const undoStack = [];

// ---- state changes -------------------------------------------------------

function checkpoint() {
  undoStack.push({ ropes: world.snapshot(), selection });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  $('undo').disabled = false;
}

function undo() {
  const state = undoStack.pop();
  if (!state) return;
  world.restore(state.ropes);
  selection = state.selection;
  stopTightening();
  gesture = null;
  $('undo').disabled = undoStack.length === 0;
}

// One button starts tightening and, while it runs, pauses it again.
function showTightening() {
  $('tighten').setAttribute('aria-pressed', String(Boolean(tightener)));
  $('tighten').textContent = tightener ? 'Pause' : 'Tighten';
}

function stopTightening() {
  tightener = null;
  showTightening();
}

function toggleTightening() {
  if (tightener) return stopTightening();
  const ropes = world.ropes.filter((rope) => !rope.pole);
  if (!ropes.length) return;
  checkpoint();
  tightener = new Tightener(selection ? [selection.id] : ropes.map((rope) => rope.id));
  showTightening();
}

function setTool(next) {
  tool = next;
  $('tool').value = tool;
  stage.style.cursor = { sketch: 'crosshair', cut: 'pointer', loosen: 'cell', rotate: 'grab' }[tool];
}

function setMode(mode) {
  renderer.setMode(mode);
  for (const option of $('more').querySelectorAll('option[value^="mode:"]')) {
    option.textContent = `${option.value === `mode:${mode}` ? '✓ ' : ''}${option.dataset.label}`;
  }
}

function cut(hit) {
  checkpoint();
  selection = world.cut(hit.id, hit.index);
}

function clearAll() {
  if (!world.ropes.length) return;
  checkpoint();
  stopTightening();
  world.clear();
  selection = null;
}

function showExample(id) {
  const example = EXAMPLES.find((entry) => entry.id === id);
  if (!example) return;
  checkpoint();
  stopTightening();
  world.clear();
  const built = buildExample(example, world.radius);
  renderer.frame(built.width, built.height);
  const end = tieExample(world, renderer.view, built);
  // With several ropes nothing is selected, so that Tighten pulls them all.
  selection = world.ropes.filter((rope) => !rope.pole).length === 1 ? end : null;
}

// ---- pointer input -------------------------------------------------------

function localPoint(event) {
  const rect = stage.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function pickAt(point, event) {
  const tolerance = (event.pointerType === 'touch' ? 14 : 4) / renderer.pixelsPerUnit;
  return world.pick(renderer.view, ...renderer.screenToView(...point), tolerance);
}

function startLoosening(point) {
  checkpoint();
  const view = renderer.view;
  gesture = { type: 'loosen', point, origin: toWorld(view, ...renderer.screenToView(...point), 0), axis: view.normal, radius: 0 };
}

function onPointerDown(event) {
  try { stage.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
  const point = localPoint(event);
  pointers.set(event.pointerId, point);

  if (pointers.size === 2) {
    // A second finger turns whatever was happening into pan and zoom.
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', span: Math.hypot(a[0] - b[0], a[1] - b[1]), centre: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  if (pointers.size > 2) return;

  if (event.button === 1) return void (gesture = { type: 'pan', last: point });
  // The right button cuts when clicked on a rope and turns the view when dragged.
  if (event.button === 2) {
    return void (gesture = { type: 'context', start: point, hit: pickAt(point, event), turn: event.shiftKey ? 'pan' : 'rotate' });
  }
  if (event.button !== 0) return;
  if (event.altKey || tool === 'rotate') return void (gesture = { type: 'rotate', last: point });

  const hit = pickAt(point, event);
  const double = lastTap && event.timeStamp - lastTap.time < DOUBLE_TAP_MS
    && Math.hypot(point[0] - lastTap.point[0], point[1] - lastTap.point[1]) < 24;

  if (tool === 'loosen') return startLoosening(point);
  if (tool === 'cut') {
    if (hit) cut(hit);
    return;
  }

  if (hit) {
    if (double && lastTap.hit) {
      checkpoint();
      world.toggleFix(hit.id, hit.index);
      lastTap = null;
      return;
    }
    selection = hit;
    const rope = world.ropeById(hit.id);
    gesture = { type: 'drag', hit, start: point, grab: toView(renderer.view, ...rope.point(hit.index)), target: null };
  } else if (double && !lastTap.hit) {
    lastTap = null;
    startLoosening(point);
  } else {
    gesture = { type: 'stroke', points: [point] };
  }
}

function onPointerMove(event) {
  if (!pointers.has(event.pointerId)) return;
  const point = localPoint(event);
  pointers.set(event.pointerId, point);
  if (!gesture) return;

  if (gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const span = Math.hypot(a[0] - b[0], a[1] - b[1]), centre = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (gesture.span > 0) renderer.zoomBy(span / gesture.span);
    renderer.pan(centre[0] - gesture.centre[0], centre[1] - gesture.centre[1]);
    Object.assign(gesture, { span, centre });
  } else if (gesture.type === 'context') {
    if (Math.hypot(point[0] - gesture.start[0], point[1] - gesture.start[1]) >= 4) gesture = { type: gesture.turn, last: point };
  } else if (gesture.type === 'rotate' || gesture.type === 'pan') {
    renderer[gesture.type](point[0] - gesture.last[0], point[1] - gesture.last[1]);
    gesture.last = point;
  } else if (gesture.type === 'stroke') {
    const last = gesture.points[gesture.points.length - 1];
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= 2) gesture.points.push(point);
  } else if (gesture.type === 'drag') {
    if (!gesture.target && Math.hypot(point[0] - gesture.start[0], point[1] - gesture.start[1]) < 4) return;
    if (!gesture.target) checkpoint();
    // The grabbed sphere moves in the plane parallel to the screen.
    const from = renderer.screenToView(...gesture.start), to = renderer.screenToView(...point);
    gesture.target = toWorld(renderer.view, gesture.grab[0] + to[0] - from[0], gesture.grab[1] + to[1] - from[1], gesture.grab[2]);
  }
}

function onPointerUp(event) {
  if (!pointers.delete(event.pointerId)) return;
  const finished = gesture;
  if (finished?.type === 'pinch' && pointers.size > 0) return;
  gesture = null;
  if (!finished) return;

  if (finished.type === 'context') {
    if (finished.hit) cut(finished.hit);
  } else if (finished.type === 'drag' && !finished.target) {
    lastTap = { time: event.timeStamp, point: finished.start, hit: finished.hit };
  } else if (finished.type === 'stroke') {
    const stroke = finished.points.map((p) => renderer.screenToView(...p));
    if (pathLength(stroke) < 3 * world.spacing) {
      // A tap on the empty canvas deselects.
      selection = null;
      lastTap = { time: event.timeStamp, point: finished.points[0], hit: null };
      return;
    }
    checkpoint();
    const result = applyStroke(world, renderer.view, stroke, selection);
    if (result) selection = result;
    else undoStack.pop();
  }
}

stage.addEventListener('pointerdown', onPointerDown);
stage.addEventListener('pointermove', onPointerMove);
stage.addEventListener('pointerup', onPointerUp);
stage.addEventListener('pointercancel', onPointerUp);
stage.addEventListener('contextmenu', (event) => event.preventDefault());
stage.addEventListener('wheel', (event) => {
  event.preventDefault();
  renderer.zoomBy(Math.exp(-event.deltaY * 0.0015));
}, { passive: false });

// ---- toolbar and keyboard ------------------------------------------------

$('tool').addEventListener('change', (event) => setTool(event.target.value));
$('tighten').addEventListener('click', toggleTightening);
$('undo').addEventListener('click', undo);
$('undo').disabled = true;

for (const example of EXAMPLES) $('examples').append(new Option(example.name, example.id));
$('examples').addEventListener('change', (event) => {
  showExample(event.target.value);
  event.target.value = '';
});

$('more').addEventListener('change', (event) => {
  const action = event.target.value;
  event.target.value = '';
  if (action.startsWith('mode:')) setMode(action.slice(5));
  else if (action === 'reset-view') renderer.resetView();
  else if (action === 'clear') clearAll();
  else if (action === 'help') $('help').showModal();
});

window.addEventListener('keydown', (event) => {
  if ($('help').open || event.target instanceof HTMLSelectElement) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); undo(); }
  else if (event.ctrlKey || event.metaKey) return;
  else if (key === 'escape') selection = null;
  else if (key === 't' || key === ' ') { event.preventDefault(); toggleTightening(); }
});

setMode('twisted');

new ResizeObserver(() => renderer.resize()).observe(stage);

// ---- frame loop ----------------------------------------------------------

function hintText() {
  if (tightener) return 'Tightening… press Pause to stop.';
  if (gesture?.type === 'loosen') return 'Hold to open the gap.';
  if (tool === 'cut') return 'Tap the rope where it should be cut.';
  if (tool === 'loosen') return 'Press and hold in a gap to open it.';
  if (tool === 'rotate') return 'Drag to rotate the view.';
  if (!world.ropes.length) return 'Draw a line to lay a rope, or pick an example.';
  const extras = coarse ? 'Double-tap a rope to fix it.' : 'Double-click fixes, right-click cuts, right-drag rotates.';
  if (!selection) return `Draw to start another rope, or drag a rope. ${extras}`;
  return `Draw across a strand to go over it; start beyond a strand to go under. ${extras}`;
}

function drawOverlay() {
  const stroke = $('stroke'), connector = $('connector'), wedge = $('wedge');
  const width = Math.max(6, 1.2 * world.radius * renderer.pixelsPerUnit);
  const rope = selection && world.ropeById(selection.id);
  if (gesture?.type === 'stroke') {
    stroke.setAttribute('points', gesture.points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '));
    stroke.style.strokeWidth = width;
  } else {
    stroke.setAttribute('points', '');
  }
  // The connector from the selection to the stroke will be pulled under, so
  // it is drawn behind the ropes.
  if (gesture?.type === 'stroke' && rope) {
    const anchor = toView(renderer.view, ...rope.point(selection.index));
    const [x1, y1] = renderer.viewToScreen(anchor[0], anchor[1]), [x2, y2] = gesture.points[0];
    for (const [name, value] of Object.entries({ x1, y1, x2, y2 })) connector.setAttribute(name, value);
    connector.style.strokeWidth = width;
    connector.style.strokeDasharray = `${width * 0.2} ${width * 1.6}`;
    connector.style.display = '';
  } else {
    connector.style.display = 'none';
  }
  if (gesture?.type === 'loosen') {
    wedge.setAttribute('cx', gesture.point[0]);
    wedge.setAttribute('cy', gesture.point[1]);
    wedge.setAttribute('r', gesture.radius * renderer.pixelsPerUnit);
    wedge.style.display = '';
  } else {
    wedge.style.display = 'none';
  }
}

function frame() {
  if (selection) {
    const rope = world.ropeById(selection.id);
    if (!rope || selection.index >= rope.count) selection = null;
  }
  if (gesture?.type === 'loosen') gesture.radius = Math.min(WEDGE_MAX, gesture.radius + WEDGE_GROWTH);
  for (let step = 0; step < STEPS_PER_FRAME; step++) {
    const handles = tightener ? tightener.handles(world) : [];
    if (gesture?.type === 'drag' && gesture.target) handles.push({ ...gesture.hit, target: gesture.target });
    physics.step(world, { handles, cylinder: gesture?.type === 'loosen' ? gesture : null });
    if (tightener) {
      tightener.update(world);
      if (tightener.done) stopTightening();
    }
  }
  renderer.draw(world, selection);
  drawOverlay();
  $('hint').textContent = hintText();
  $('count').textContent = renderer.mode === 'spheres' && world.sphereCount ? `${world.sphereCount} spheres` : '';
  requestAnimationFrame(frame);
}

// For tests and tinkering from the console.
window.knot = { world, physics, renderer };

frame();
