import { World } from './sim/world.js';
import { Physics, Tightener } from './sim/physics.js';
import { applyStroke, pathLength } from './sim/sketch.js';
import { toView, toWorld } from './sim/view.js';
import { EXAMPLES, buildExample, strokesFor, tieExample } from './sim/examples.js';
import { Renderer } from './render.js';
import { Recorder, canvasBlob, picture, share, stepSheet, toGLB, toOBJ } from './export.js';
import { Tutorial } from './tutorial.js';

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
const steps = []; // how the ropes were laid, stroke by stroke: [{ ropes, label }]
const recorder = new Recorder();
const tutorial = new Tutorial({ card: $('coach'), step: $('coach-step'), text: $('coach-text'), close: $('coach-close') });
let notice = null; // a passing message shown in place of the hint

// ---- state changes -------------------------------------------------------

function checkpoint() {
  undoStack.push({ ropes: world.snapshot(), selection, steps: steps.length });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  $('undo').disabled = false;
}

function undo() {
  const state = undoStack.pop();
  if (!state) return;
  world.restore(state.ropes);
  selection = state.selection;
  steps.length = Math.min(steps.length, state.steps);
  stopTightening();
  gesture = null;
  $('undo').disabled = undoStack.length === 0;
  tutorial.undone(world);
}

function flash(text, seconds = 4) {
  notice = { text, until: performance.now() + seconds * 1000 };
}

// Records a stroke as a step of the tying instructions.
function recordStep(did) {
  const passes = did.under && did.over ? 'under, then over' : did.under ? 'under' : did.over ? 'over' : '';
  const label = did.kind === 'new' ? `Lay a rope${passes && `, passing ${passes}`}`
    : did.kind === 'middle' ? `Pull out a bight${passes && `, passing ${passes}`}`
      : passes ? `Pass ${passes}` : 'Extend the rope';
  steps.push({ ropes: world.snapshot(), label });
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
  steps.length = 0;
  if (tutorial.active) tutorial.end();
}

function showExample(id) {
  const example = EXAMPLES.find((entry) => entry.id === id);
  if (!example) return;
  checkpoint();
  stopTightening();
  if (tutorial.active) tutorial.end();
  world.clear();
  steps.length = 0;
  const built = buildExample(example, world.radius);
  renderer.frame(built.width, built.height);
  const end = tieExample(world, renderer.view, built, recordStep);
  // With several ropes nothing is selected, so that Tighten pulls them all.
  selection = world.ropes.filter((rope) => !rope.pole).length === 1 ? { id: end.id, index: end.index } : null;
}

// The tutorial ties the overhand example, with its strokes as guide lines.
function startTutorial() {
  checkpoint();
  stopTightening();
  world.clear();
  selection = null;
  steps.length = 0;
  setTool('sketch');
  const built = buildExample(EXAMPLES[0], world.radius);
  renderer.frame(built.width * 1.1, built.height * 1.5);
  tutorial.begin(strokesFor(built.ropes[0].path, [], world.radius, true));
}

// ---- export and sharing --------------------------------------------------

// Every export goes to the share sheet where the device has one, and to the
// downloads folder otherwise.
async function deliver(blob, name) {
  const outcome = await share(blob, name, 'A knot I tied');
  if (outcome === 'saved') flash(`Saved ${name} to your downloads.`);
}

async function exportAs(kind) {
  if (!world.ropes.length) return flash('There is nothing to export yet.');
  try {
    if (kind === 'png') {
      await deliver(await canvasBlob(picture(renderer, world)), 'knot.png');
    } else if (kind === 'steps') {
      const sheet = stepSheet(renderer, world, [...steps, { ropes: world.snapshot(), label: 'Finished' }]);
      await deliver(await canvasBlob(sheet), 'knot-steps.png');
    } else if (kind === 'obj') {
      await deliver(toOBJ(renderer.exportGroup()), 'knot.obj');
    } else if (kind === 'glb') {
      await deliver(await toGLB(renderer.exportGroup()), 'knot.glb');
    }
  } catch (error) {
    console.error(error);
    flash('The export failed.');
  }
}

function showRecording() {
  $('record-option').textContent = recorder.recording ? 'Stop recording' : 'Video';
}

async function toggleRecording() {
  if (!Recorder.supported) return flash('This browser cannot record video.');
  if (!recorder.recording) {
    recorder.start();
    showRecording();
    return;
  }
  const pending = recorder.stop();
  showRecording();
  const clip = await pending;
  await deliver(clip, `knot.${clip.type.includes('mp4') ? 'mp4' : 'webm'}`);
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
    if (!result) return void undoStack.pop();
    selection = { id: result.id, index: result.index };
    if (tutorial.accept(stroke, world)) recordStep(result);
    else undo();
  }
}

// The tutorial card sits on the canvas but is not part of it.
$('coach').addEventListener('pointerdown', (event) => event.stopPropagation());
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
  else if (action.startsWith('export:')) exportAs(action.slice(7));
  else if (action === 'record') toggleRecording();
  else if (action === 'clear') clearAll();
  else if (action === 'tutorial') startTutorial();
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
  if (notice && performance.now() < notice.until) return notice.text;
  if (recorder.recording) return 'Recording… choose More, then Stop recording, when you are done.';
  if (tutorial.active) return '';
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

// The tutorial's guide. The line to draw is solid and lies over the ropes, as
// the stroke will; the gap from the selected end to its start is dotted and
// behind them, as the pull-under connector is.
function drawGuide(width, rope) {
  const guide = tutorial.guide;
  $('guide-layer').style.display = guide ? '' : 'none';
  $('guide-under').style.display = guide && rope ? '' : 'none';
  if (!guide) return;
  const points = guide.map((p) => renderer.viewToScreen(p[0], p[1]));
  $('guide').setAttribute('points', points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '));
  $('guide').style.strokeWidth = width * 0.5;
  const [sx, sy] = points[0], [ex, ey] = points[points.length - 1], [px, py] = points[points.length - 4];
  for (const [name, value] of Object.entries({ cx: sx, cy: sy, r: width })) $('guide-start').setAttribute(name, value);
  const length = Math.hypot(ex - px, ey - py) || 1, ux = (ex - px) / length, uy = (ey - py) / length, head = width * 1.6;
  $('guide-arrow').setAttribute('points', [
    [ex + ux * head, ey + uy * head], [ex - uy * head * 0.7, ey + ux * head * 0.7], [ex + uy * head * 0.7, ey - ux * head * 0.7],
  ].map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '));
  if (!rope) return;
  const anchor = toView(renderer.view, ...rope.point(selection.index));
  const [x1, y1] = renderer.viewToScreen(anchor[0], anchor[1]);
  for (const [name, value] of Object.entries({ x1, y1, x2: sx, y2: sy })) $('guide-under').setAttribute(name, value);
  $('guide-under').style.strokeWidth = width * 0.5;
  $('guide-under').style.strokeDasharray = `${width * 0.1} ${width}`;
}

function drawOverlay() {
  const stroke = $('stroke'), connector = $('connector'), wedge = $('wedge');
  const width = Math.max(6, 1.2 * world.radius * renderer.pixelsPerUnit);
  const rope = selection && world.ropeById(selection.id);
  drawGuide(width, rope);
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
      if (tightener.done) {
        stopTightening();
        tutorial.tightened();
      }
    }
  }
  renderer.draw(world, selection);
  recorder.capture(renderer);
  if (recorder.full) toggleRecording();
  drawOverlay();
  $('hint').textContent = hintText();
  $('count').textContent = renderer.mode === 'spheres' && world.sphereCount ? `${world.sphereCount} spheres` : '';
  requestAnimationFrame(frame);
}

// For tests and tinkering from the console.
window.knot = { world, physics, renderer, steps, tutorial };

frame();
if (!Tutorial.seen) startTutorial();
