# Knot

A web recreation of *An Interactive System for Knot Design* (Puripant Ruchikachorn, master's thesis, The University of Tokyo, 2008): knots are drawn like a knot diagram, and a rope simulation lets them be dragged, loosened and tightened.

## Run

No install and no build. The page uses JavaScript modules, so it has to be served rather than opened as a file:

```bash
npm start
```

Then open http://localhost:8080. three.js is loaded from a CDN through the import map in `index.html`; it is the only dependency.

```bash
npm test
```

runs the simulation tests on Node's built-in test runner.

## Using it

| Action | How |
|---|---|
| Lay a rope | Draw on the empty canvas. The end stays selected (blue). |
| Pull over | Draw across a rope. |
| Pull under | With a part selected, start the stroke on the far side of a rope. The dotted line shows the part that passes under. |
| Bight | Select the middle of a rope, then draw. |
| Move | Drag any part of a rope. |
| Fix / unfix | Double-click a part (red marker; purple when it is also the selected part). |
| Cut | Right-click the rope, or the Cut tool. |
| Loosen | Double-click and hold in a gap, or the Loosen tool. |
| Tighten | Pulls the ends of the selected rope apart, or with nothing selected the ends of every rope away from the other ropes and poles, until the knot jams. While it runs the same button reads Pause. Fixed parts stay put. |
| New rope | Tap the empty canvas to deselect, then draw. |
| View | Right-drag rotates, Shift-right-drag pans, wheel zooms. Touch: two fingers pan and zoom, the Rotate view tool turns. |

The Cut, Loosen and Rotate view tools in the Tool menu exist for touch screens, which have no right button.

Keys: `T` or `Space` tighten / pause, `Ctrl/Cmd+Z` undo, `Esc` deselect.

More → View switches between twisted rope, braided rope, plain cord, ribbon and the underlying spheres.

The Examples menu ties:

- stopper knots: overhand, figure-eight, double overhand, threefold overhand
- a loop: bowline (its loop and tail start fixed so that Tighten keeps the loop)
- bends: reef knot, granny knot, sheet bend
- hitches around a pole: clove hitch, cow hitch
- a chain-link fence: zigzag wires hooked through their neighbours, held at both ends

Each is laid out in `src/sim/examples.js` the way it looks when tied loosely by hand, as control points with a height that says which strand is over at a crossing; the strokes are worked out from that.

A pole is a rigid rope: every sphere is fixed for good and it cannot be picked, dragged or cut. Poles only come from the examples for now.

## Layout

- `src/sim/` — the model, with no dependency on three.js or the DOM
  - `world.js` ropes and poles as chains of spheres, cut, fix, picking, undo snapshots
  - `sketch.js` strokes to rope, depth inference for pull-over and pull-under
  - `physics.js` the rope simulation and automatic tightening
  - `examples.js` example knot diagrams, tied with the same strokes a user would draw
- `src/render.js` three.js view: rope textures, ribbon and sphere representations
- `src/app.js` pointer input, toolbar, frame loop
- `legacy/` the 2016–17 draft, kept for reference

## Where the simulation differs from the thesis

The thesis model is all here: neighbour and bending springs, repulsion between touching spheres, fourth-order Runge-Kutta, follow-the-leader rope motion, a per-step movement limit, and zeroed velocity on contact. Three things were added to keep knots from pulling through themselves:

- Segment lengths and contacts are also enforced as position constraints after each integration step.
- A step that would stretch a segment or press spheres into each other is retried with a weaker pull, so a dragged or tightened end gives way instead of tearing the rope.
- The rope has a minimum bend radius, so it cannot fold flat.

Collision candidates come from a uniform grid rather than an all-pairs test.
