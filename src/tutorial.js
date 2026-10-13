// First-run tutorial: ties an overhand knot along dashed guide lines, then
// tightens it. It only watches what the user does and says what comes next.

const SEEN = 'knot:tutorial-seen';
const TEXT = [
  'Draw along the blue line, from the dot to the arrow. That lays a rope.',
  'The blue end is selected, so the next stroke extends the rope. Start at the dot, on the far side of the rope: the dotted gap is pulled under. Then follow the line across the rope: that part goes over.',
  'Once more. Start at the dot, beyond the rope, and draw to the arrow.',
  'Now press Tighten to pull the two ends apart.',
  'That is an overhand knot. Drag any part of the rope to move it. The Examples menu has more knots, and More has other rope looks, export and sharing.',
];

export class Tutorial {
  // `elements` are the card and the parts of it this fills in.
  constructor({ card, step, text, close }) {
    this.elements = { card, step, text, close };
    this.guides = null;
    this.step = 0;
    this.counts = [];
    this.note = '';
    close.addEventListener('click', () => this.end());
  }

  static get seen() {
    try { return localStorage.getItem(SEEN) !== null; } catch { return true; }
  }

  get active() {
    return this.guides !== null;
  }

  // The line to trace now, as view-space points, or null.
  get guide() {
    return this.active ? this.guides[this.step] ?? null : null;
  }

  // `guides` are the strokes to trace, in order.
  begin(guides) {
    this.guides = guides;
    this.step = 0;
    this.counts = [];
    this.note = '';
    this._show();
  }

  end() {
    this.guides = null;
    try { localStorage.setItem(SEEN, '1'); } catch { /* private browsing: it will show again */ }
    this._show();
  }

  // Judges a stroke that has just been applied. Returns false if it should be
  // taken back because it strays too far from the guide.
  accept(stroke, world) {
    const guide = this.guide;
    if (!guide) return true;
    const reach = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const unit = world.radius;
    if (world.ropes.length !== 1) {
      this.note = 'Pick the end of the rope first, so that it turns blue. ';
    } else if (reach(stroke[0], guide[0]) > 6 * unit || reach(stroke[stroke.length - 1], guide[guide.length - 1]) > 9 * unit
      || reach(stroke[stroke.length >> 1], guide[guide.length >> 1]) > 12 * unit) {
      this.note = 'Not quite. ';
    } else {
      this.note = '';
      this.counts.push(world.sphereCount);
      this.step++;
    }
    this._show();
    return this.note === '';
  }

  // After an undo: go back to the step that matches what is left of the rope.
  undone(world) {
    while (this.active && this.step > 0 && this.step <= this.guides.length && world.sphereCount < this.counts[this.step - 1]) {
      this.step--;
      this.counts.pop();
      this.note = '';
    }
    this._show();
  }

  tightened() {
    if (!this.active || this.step !== this.guides.length) return;
    this.step++;
    this._show();
  }

  _show() {
    const { card, step, text, close } = this.elements;
    card.hidden = !this.active;
    if (!this.active) return;
    const last = this.step >= TEXT.length - 1;
    step.textContent = last ? 'Done' : `Step ${this.step + 1} of ${TEXT.length - 1}`;
    text.textContent = this.note + TEXT[this.step];
    close.textContent = last ? 'Close' : 'Skip tutorial';
  }
}
