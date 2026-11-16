// Undo for Draw mode, with a memory budget you can actually reason about.
//
// The cost model
// --------------
// Every pixel edit is stored as ONE snapshot of the rectangle it touched,
// before the edit, as RGBA bytes: `w × h × 4`. Undo does not "replay" or
// "reverse" anything — it *swaps* the stored rectangle with what is on the
// layer right now, and keeps what it took out. That swap is its own inverse,
// so redo is the same operation again and a step never costs more than the
// one snapshot. A 300 × 300 px stroke costs 360 KB; a full-canvas fill on a
// 4000 × 4000 document costs 61 MB (4000 × 4000 × 4 bytes), so the default
// budget below holds four of those, or hundreds of ordinary strokes.
//
// The stack has a byte budget (default 256 MB). When a step would push it
// over, the oldest steps are dropped until it fits — so a long session on a
// huge canvas loses distant history rather than the tab. A step larger than
// the whole budget is still kept (you always get one undo), and the budget is
// the only thing that decides depth: there is no step count limit, because
// a hundred small sketch strokes cost less than one large fill.
//
// Structural steps (add, delete, reorder, rename, opacity, blend) store a
// small JSON snapshot of the layer list instead, a few hundred bytes each.
//
// Pure: `swap` and `restore` are supplied by the caller, so this file has no
// canvas in it and runs under `node --test`.

export const DEFAULT_BUDGET = 256 * 1024 * 1024;

/** A pixel step: the bytes of one rectangle of one layer, before the edit. */
export function pixelStep(label, layerId, x, y, w, h, data, swap) {
  return {
    kind: "pixels",
    label,
    layerId,
    bytes: (data && data.byteLength) || w * h * 4,
    run() {
      // swap(layerId, rect, data) puts `data` on the layer and hands back what
      // was there; keeping it makes this step its own inverse.
      this.data = swap(layerId, x, y, w, h, this.data);
    },
    data,
  };
}

/** A structural step: two small snapshots of the layer list. */
export function metaStep(label, before, after, restore) {
  const bytes = JSON.stringify(before).length + JSON.stringify(after).length + 64;
  let undone = false;
  return {
    kind: "meta",
    label,
    bytes,
    run() {
      undone = !undone;
      restore(undone ? before : after);
    },
  };
}

/**
 * Several steps that are one thing to the person: adding a mask is a change
 * to the layer list AND pixels on a new surface, and undo must take back both
 * or neither. Undo runs them last-first, redo first-last.
 */
export function groupStep(label, steps) {
  let undone = false;
  return {
    kind: "group",
    label,
    get bytes() { return steps.reduce((n, s) => n + (s.bytes || 0), 0); },
    run() {
      undone = !undone;
      const order = undone ? steps.slice().reverse() : steps;
      for (const s of order) s.run();
    },
    dispose() { for (const s of steps) if (typeof s.dispose === "function") s.dispose(); },
  };
}

/** A step that holds canvases (a crop, a resize) frees them when it is forgotten. */
const drop = (step) => { if (step && typeof step.dispose === "function") { try { step.dispose(); } catch { /* best effort */ } } };

export class History {
  constructor({ budget = DEFAULT_BUDGET, onChange = null } = {}) {
    this.budget = budget;
    this.onChange = onChange;
    this.steps = [];
    this.at = 0; // how many steps are applied; steps[at..] are redoable
    this.bytes = 0;
    this.dropped = 0; // steps thrown away to stay inside the budget
  }

  get canUndo() { return this.at > 0; }
  get canRedo() { return this.at < this.steps.length; }
  get depth() { return this.steps.length; }
  /** What undo would do next, for the tooltip. */
  get undoLabel() { return this.at > 0 ? this.steps[this.at - 1].label : null; }
  get redoLabel() { return this.at < this.steps.length ? this.steps[this.at].label : null; }

  push(step) {
    // anything redoable is now unreachable
    for (let i = this.at; i < this.steps.length; i++) { this.bytes -= this.steps[i].bytes; drop(this.steps[i]); }
    this.steps.length = this.at;
    this.steps.push(step);
    this.bytes += step.bytes;
    this.at++;
    this.trim();
    this.changed();
    return step;
  }

  /** Drop the oldest steps until the stack fits, always keeping the newest one. */
  trim() {
    while (this.bytes > this.budget && this.steps.length > 1) {
      const gone = this.steps.shift();
      this.bytes -= gone.bytes;
      drop(gone);
      this.at = Math.max(0, this.at - 1);
      this.dropped++;
    }
  }

  undo() {
    if (!this.canUndo) return null;
    const s = this.steps[--this.at];
    const before = s.bytes;
    s.run();
    this.bytes += (s.bytes || before) - before;
    this.changed();
    return s;
  }

  redo() {
    if (!this.canRedo) return null;
    const s = this.steps[this.at++];
    const before = s.bytes;
    s.run();
    this.bytes += (s.bytes || before) - before;
    this.changed();
    return s;
  }

  clear() {
    for (const s of this.steps) drop(s);
    this.steps.length = 0;
    this.at = 0;
    this.bytes = 0;
    this.changed();
  }

  changed() { if (this.onChange) this.onChange(this); }

  /** For the status line and the performance report. */
  stats() {
    return { steps: this.steps.length, at: this.at, bytes: this.bytes, budget: this.budget, dropped: this.dropped };
  }
}

/**
 * The rectangle a stroke actually touched, clamped to the canvas and padded
 * for the tip's soft edge. Returns null when nothing was touched — an empty
 * step must never reach the stack, or undo starts doing nothing.
 */
export function dirtyRect(box, width, height, pad = 2) {
  if (!box || box.x1 < box.x0 || box.y1 < box.y0) return null;
  const x = Math.max(0, Math.floor(box.x0 - pad));
  const y = Math.max(0, Math.floor(box.y0 - pad));
  const x1 = Math.min(width, Math.ceil(box.x1 + pad + 1));
  const y1 = Math.min(height, Math.ceil(box.y1 + pad + 1));
  if (x1 <= x || y1 <= y) return null;
  return { x, y, w: x1 - x, h: y1 - y };
}

/** A growable bounding box with no allocation per point. */
export function newBox() {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

export function growBox(box, x, y, r = 0) {
  if (x - r < box.x0) box.x0 = x - r;
  if (y - r < box.y0) box.y0 = y - r;
  if (x + r > box.x1) box.x1 = x + r;
  if (y + r > box.y1) box.y1 = y + r;
  return box;
}

export function resetBox(box) {
  box.x0 = Infinity; box.y0 = Infinity; box.x1 = -Infinity; box.y1 = -Infinity;
  return box;
}

export const boxEmpty = (box) => !(box.x1 >= box.x0 && box.y1 >= box.y0);

/** Human-readable bytes, for "Undo · 12 steps · 48 MB". */
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
