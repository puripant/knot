# Knot

A web recreation of *An Interactive System for Knot Design* (Puripant Ruchikachorn, master's thesis, The University of Tokyo, 2008): knots are drawn like a knot diagram, and a rope simulation lets them be dragged, loosened and tightened.

## Run

No install and no build. The page uses JavaScript modules, so it has to be served rather than opened as a file:

```bash
npm start
```

Then open http://localhost:8080. The hosted copy is at https://puripant.github.io/knot/. three.js is loaded from a CDN through the import map in `index.html`; it is the only dependency.

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

In the two-rope examples the second rope takes the other rope texture so the two can be told apart. Ropes you draw yourself all share the look chosen under View.

A pole is a rigid rope: every sphere is fixed for good and it cannot be picked, dragged or cut. Poles only come from the examples for now.

## Tutorial

On the first visit a tutorial card walks through tying an overhand knot: trace three guide lines, then press Tighten. A stroke that strays from the guide is taken back. It can be skipped at any time and started again from More → Tutorial. Whether it has been seen is kept in the browser's local storage.

## Export

Under More → Export:

- **Picture (PNG)** is the current view.
- **Step-by-step sheet (PNG)** is one numbered tile per stroke, captioned with what the stroke did (for example "Pass under, then over"), plus the finished knot. Steps are recorded for your own strokes and for the examples; undo removes them again.
- **Video** records the view until stopped, for at most 30 seconds (MP4 or WebM, whichever the browser records).
- **3D model** is the rope meshes as GLB, with colours and textures, or as OBJ, shape only. The GLB exporter is fetched from the CDN the first time it is used.

Each export opens the device's share sheet where the browser can share files, and is saved to the downloads folder otherwise.

For link previews, `index.html` carries Open Graph and Twitter card tags pointing at `media/og-image.png`, and `media/icon.svg` is the page icon. Preview crawlers need absolute URLs, so the `og:url`, `og:image` and canonical tags name the hosted address, https://puripant.github.io/knot/. Change them there if the app moves.

## Layout

- `src/sim/` — the model, with no dependency on three.js or the DOM
  - `world.js` ropes and poles as chains of spheres, cut, fix, picking, undo snapshots
  - `sketch.js` strokes to rope, depth inference for pull-over and pull-under
  - `physics.js` the rope simulation and automatic tightening
  - `examples.js` example knot diagrams, tied with the same strokes a user would draw
- `src/render.js` three.js view: rope textures, ribbon and sphere representations
- `src/export.js` pictures, step sheet, video recording, OBJ and GLB, share or save
- `src/tutorial.js` the first-run tutorial
- `src/app.js` pointer input, toolbar, frame loop
- `media/` link-preview image and page icon
- `legacy/` the 2016–17 draft, kept for reference

## Where the simulation differs from the thesis

The thesis model is all here: neighbour and bending springs, repulsion between touching spheres, fourth-order Runge-Kutta, follow-the-leader rope motion, a per-step movement limit, and zeroed velocity on contact. Three things were added to keep knots from pulling through themselves:

- Segment lengths and contacts are also enforced as position constraints after each integration step.
- A step that would stretch a segment or press spheres into each other is retried with a weaker pull, so a dragged or tightened end gives way instead of tearing the rope.
- The rope has a minimum bend radius, so it cannot fold flat.

Collision candidates come from a uniform grid rather than an all-pairs test.
