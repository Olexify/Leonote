// Leopaint's starting points: a few boards worth not drawing from nothing.
// Each builds plain elements with two helpers from the editor - `el(type, props)`
// (a shape in the current style) and `text(words, cx, cy, size)` (measured,
// centred there) - and may ask for a background pattern. They land through the
// same path as a paste, so one undo takes a template away again.

const range = (n) => [...Array(n).keys()];

/** A box with a label in its middle. */
const box = (k, type, x, y, w, hh, label, size = 20, props = {}) => [k.el(type, { x, y, width: w, height: hh, ...props }), ...(label ? [k.text(label, x + w / 2, y + hh / 2, size)] : [])];
const arrow = (k, x1, y1, x2, y2) => k.el("arrow", { x: x1, y: y1, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), points: [[0, 0], [x2 - x1, y2 - y1]] });
const frame = (k, x, y, w, hh, name) => k.el("frame", { x, y, width: w, height: hh, name });
const placeholder = (k, x, y, w, hh) => [
  k.el("rectangle", { x, y, width: w, height: hh, strokeStyle: "dashed", backgroundColor: "transparent" }),
  k.el("line", { x, y, width: w, height: hh, points: [[0, 0], [w, hh]], strokeStyle: "dashed", opacity: 40 }),
  k.el("line", { x: x + w, y, width: w, height: hh, points: [[0, 0], [-w, hh]], strokeStyle: "dashed", opacity: 40 }),
];

export const TEMPLATES = [
  { id: "dots", name: "Dot grid", note: "an empty board on dots", icon: "grid", pattern: "dots", build: () => [] },
  {
    id: "mindmap", name: "Mind map", note: "an idea in the middle, six around it", icon: "brain",
    build: (k) => {
      const out = box(k, "ellipse", -130, -50, 260, 100, "Main idea", 26);
      for (const i of range(6)) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const cx = Math.cos(a) * 380, cy = Math.sin(a) * 250;
        out.push(...box(k, "rectangle", cx - 90, cy - 35, 180, 70, `Idea ${i + 1}`));
        out.push(arrow(k, Math.cos(a) * 140, Math.sin(a) * 60, cx - Math.cos(a) * 95, cy - Math.sin(a) * 40));
      }
      return out;
    },
  },
  {
    id: "flow", name: "Flowchart", note: "start, steps, a decision, an end", icon: "graph",
    build: (k) => [
      ...box(k, "ellipse", -90, 0, 180, 70, "Start"),
      arrow(k, 0, 70, 0, 120),
      ...box(k, "rectangle", -110, 120, 220, 80, "Do something"),
      arrow(k, 0, 200, 0, 250),
      ...box(k, "diamond", -120, 250, 240, 140, "Did it work?", 18),
      arrow(k, 0, 390, 0, 450), k.text("Yes", 26, 420, 16),
      ...box(k, "ellipse", -90, 450, 180, 70, "End"),
      arrow(k, 120, 320, 260, 320), k.text("No", 190, 300, 16),
      ...box(k, "rectangle", 260, 280, 200, 80, "Fix it"),
      arrow(k, 360, 280, 110, 160),
    ],
  },
  {
    id: "kanban", name: "Kanban", note: "to do, doing, done", icon: "columns",
    build: (k) => ["To do", "Doing", "Done"].flatMap((name, i) => [
      frame(k, i * 340, 0, 310, 620, name),
      ...(i === 0 ? range(3).flatMap((j) => box(k, "rectangle", 20, 30 + j * 100, 270, 80, `Task ${j + 1}`, 18)) : []),
    ]),
  },
  {
    id: "storyboard", name: "Storyboard", note: "six 16:9 shots with notes", icon: "film",
    build: (k) => range(6).flatMap((i) => {
      const x = (i % 3) * 520, y = Math.floor(i / 3) * 400;
      return [frame(k, x, y, 480, 270, `Shot ${i + 1}`), k.text("Action · dialogue · sound", x + 240, y + 300, 16)];
    }),
  },
  {
    id: "phone", name: "Phone screen", note: "a wireframe to sketch an app on", icon: "phone",
    build: (k) => [
      frame(k, 0, 0, 390, 844, "Phone"),
      ...box(k, "rectangle", 0, 0, 390, 90, "Title", 22),
      ...placeholder(k, 20, 110, 350, 200),
      ...range(4).flatMap((i) => box(k, "rectangle", 20, 330 + i * 90, 350, 74, `Row ${i + 1}`, 16)),
      ...range(4).flatMap((i) => box(k, "ellipse", 38 + i * 92, 774, 40, 40, "")),
    ],
  },
  {
    id: "desktop", name: "Web page", note: "a desktop wireframe", icon: "monitor",
    build: (k) => [
      frame(k, 0, 0, 1440, 900, "Desktop"),
      ...box(k, "rectangle", 0, 0, 1440, 80, "Logo · Menu · Sign in", 20),
      ...placeholder(k, 60, 120, 1320, 360),
      k.text("A headline that says what this is", 720, 300, 36),
      ...range(3).flatMap((i) => box(k, "rectangle", 60 + i * 450, 530, 420, 300, `Card ${i + 1}`)),
    ],
  },
  {
    id: "week", name: "Week plan", note: "a column for each day", icon: "calendar",
    build: (k) => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d, i) => frame(k, i * 250, 0, 230, 560, d)),
  },
  {
    id: "proscons", name: "Pros and cons", note: "two sides and a verdict", icon: "columns",
    build: (k) => [frame(k, 0, 0, 420, 520, "Pros"), frame(k, 460, 0, 420, 520, "Cons"), ...box(k, "rectangle", 0, 560, 880, 90, "So:", 20)],
  },
  {
    id: "moodboard", name: "Moodboard", note: "places for pictures - drop them in", icon: "image",
    build: (k) => [frame(k, 0, 0, 1040, 700, "Moodboard"), ...range(6).flatMap((i) => placeholder(k, 30 + (i % 3) * 340, 40 + Math.floor(i / 3) * 330, 300, 300))],
  },
];

export const TEMPLATE_BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));
