// Selections that come from the picture rather than from a drag: the magic
// wand, "select this colour everywhere", and background removal. All of it
// works on plain byte arrays — RGBA in, an 8-bit coverage mask out — so it is
// pure and runs under `node --test`. The engine turns the masks into canvases.

const LR = 0.2126, LG = 0.7152, LB = 0.0722;

/* ── select by colour ────────────────────────────────────────────────────── */

/**
 * Every pixel within `tolerance` of the one at (sx, sy), wherever it is — the
 * wand with "contiguous" switched off. Soft at the limit: the last quarter of
 * the tolerance fades out, so the edge of a selection is not a staircase.
 */
export function colourSelect(data, width, height, sx, sy, tolerance = 0.15) {
  const mask = new Uint8Array(width * height);
  const box = { x0: width, y0: height, x1: -1, y1: -1, count: 0 };
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return { mask, box };
  const si = (sy * width + sx) * 4;
  const sr = data[si], sg = data[si + 1], sb = data[si + 2], sa = data[si + 3];
  const tol = Math.max(1, tolerance * 255);
  const soft = tol * 0.75;
  for (let y = 0, p = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++, i += 4) {
      const d = Math.max(Math.abs(data[i] - sr), Math.abs(data[i + 1] - sg), Math.abs(data[i + 2] - sb), Math.abs(data[i + 3] - sa));
      if (d > tol) continue;
      mask[p] = d <= soft ? 255 : Math.round(255 * (1 - (d - soft) / (tol - soft)));
      box.count++;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  if (box.x1 < 0) return { mask, box: { x0: 0, y0: 0, x1: -1, y1: -1, count: 0 } };
  return { mask, box };
}

/** The bounding box of everything a mask covers, or null when it is empty. */
export function maskBox(mask, width, height, threshold = 1) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++) {
      if (mask[p] < threshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ── outlines ────────────────────────────────────────────────────────────── */

/**
 * The outline of a mask as closed loops of points along pixel edges, for the
 * marching ants. Filled pixels are always on the right of the direction of
 * travel, so holes come out wound the other way and a single even-odd or
 * non-zero path draws both correctly.
 *
 * `maxEdges` stops a noisy wand selection (a million one-pixel islands) from
 * costing a second: past it the outline is simply left incomplete.
 */
export function traceContours(mask, width, height, threshold = 128, maxEdges = 600000) {
  const vw = width + 1;
  // each vertex has at most two outgoing edges (two only at a saddle)
  const a = new Int32Array(vw * (height + 1)).fill(-1);
  const b = new Int32Array(vw * (height + 1)).fill(-1);
  let edges = 0;
  const add = (from, to) => { if (a[from] < 0) a[from] = to; else b[from] = to; edges++; };
  const on = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] >= threshold;
  outer:
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] < threshold) continue;
      if (!on(x, y - 1)) add(y * vw + x, y * vw + x + 1); // top edge, left to right
      if (!on(x + 1, y)) add(y * vw + x + 1, (y + 1) * vw + x + 1); // right edge, downwards
      if (!on(x, y + 1)) add((y + 1) * vw + x + 1, (y + 1) * vw + x); // bottom edge, right to left
      if (!on(x - 1, y)) add((y + 1) * vw + x, y * vw + x); // left edge, upwards
      if (edges > maxEdges) break outer;
    }
  }
  const loops = [];
  for (let start = 0; start < a.length; start++) {
    while (a[start] >= 0) {
      const pts = [];
      let v = start;
      let pdx = 0, pdy = 0;
      for (let guard = 0; guard <= edges + 4; guard++) {
        let to = a[v];
        if (to < 0) break;
        if (b[v] >= 0) {
          // a saddle (two pixels touching at a corner): turn right, which
          // stays on the pixel we are already walking round, so diagonal
          // neighbours come out as two loops rather than one figure of eight
          const dx1 = (to % vw) - (v % vw);
          const dy1 = Math.floor(to / vw) - Math.floor(v / vw);
          if (pdx * dy1 - pdy * dx1 > 0 || (!pdx && !pdy)) { a[v] = b[v]; b[v] = -1; }
          else { to = b[v]; b[v] = -1; }
        } else {
          a[v] = -1;
        }
        const x = v % vw;
        const y = Math.floor(v / vw);
        const dx = (to % vw) - x;
        const dy = Math.floor(to / vw) - y;
        // only corners go into the path; a straight run is one segment
        if (dx !== pdx || dy !== pdy) pts.push([x, y]);
        pdx = dx;
        pdy = dy;
        v = to;
        if (v === start) break;
      }
      if (pts.length >= 3) loops.push(pts);
    }
  }
  return loops;
}

/* ── background removal ──────────────────────────────────────────────────── */

/** A few representative colours of a set of pixels, by k-means. */
export function dominantColours(samples, k = 3, rounds = 8) {
  const n = samples.length / 3;
  if (!n) return [];
  k = Math.min(k, n);
  const cents = [];
  for (let i = 0; i < k; i++) {
    const j = Math.floor(((i + 0.5) * n) / k) * 3;
    cents.push([samples[j], samples[j + 1], samples[j + 2]]);
  }
  const sums = new Float64Array(k * 4);
  for (let r = 0; r < rounds; r++) {
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      const p = i * 3;
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = samples[p] - cents[c][0], dg = samples[p + 1] - cents[c][1], db = samples[p + 2] - cents[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      sums[best * 4] += samples[p]; sums[best * 4 + 1] += samples[p + 1]; sums[best * 4 + 2] += samples[p + 2]; sums[best * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) {
      const w = sums[c * 4 + 3];
      if (w) cents[c] = [sums[c * 4] / w, sums[c * 4 + 1] / w, sums[c * 4 + 2] / w];
    }
  }
  // most common first, and ones nothing landed in dropped
  return cents
    .map((c, i) => ({ c, w: sums[i * 4 + 3] }))
    .filter((x) => x.w > 0)
    .sort((x, y) => y.w - x.w)
    .map((x) => ({ rgb: x.c.map(Math.round), share: x.w / n }));
}

/** The pixels round the rim of a picture, as flat RGB — what the background probably is. */
export function borderSamples(data, width, height, inset = 0) {
  const out = [];
  const take = (x, y) => { const i = (y * width + x) * 4; if (data[i + 3] > 16) out.push(data[i], data[i + 1], data[i + 2]); };
  const stepX = Math.max(1, Math.floor(width / 400));
  const stepY = Math.max(1, Math.floor(height / 400));
  const x1 = width - 1 - inset;
  const y1 = height - 1 - inset;
  for (let x = inset; x <= x1; x += stepX) { take(x, inset); take(x, y1); }
  for (let y = inset; y <= y1; y += stepY) { take(inset, y); take(x1, y); }
  return out;
}

/**
 * Remove a background that is "the colour(s) round the edge".
 *
 * Works outwards-in: the background is whatever can be reached from the rim
 * of the picture through pixels close to one of the background colours, so a
 * white shirt in front of a white wall survives as long as there is an edge
 * between them. `holes` also takes out enclosed pockets of background (the
 * gap inside a handle, between an arm and a body).
 *
 * Returns the SUBJECT's coverage: 255 = keep, 0 = background, soft between.
 * Honest about what it is: it is a colour key with a flood, not a neural
 * network. It is very good at products, logos, line art, screenshots and
 * studio shots, and it will not find a person in front of a busy street.
 */
export function removeBackground(data, width, height, { tolerance = 0.12, softness = 0.06, colours = null, holes = true, k = 3 } = {}) {
  const n = width * height;
  const keep = new Uint8Array(n).fill(255);
  const bg = (colours && colours.length ? colours : dominantColours(borderSamples(data, width, height), k).filter((c) => c.share > 0.04).map((c) => c.rgb));
  if (!bg.length) return { mask: keep, colours: [], removed: 0 };
  const tol = Math.max(2, tolerance * 442); // 442 = the longest distance in RGB
  const soft = Math.max(1, softness * 442);
  const dist = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (data[i + 3] < 8) { dist[p] = 0; continue; } // already transparent is background
    let best = Infinity;
    for (let c = 0; c < bg.length; c++) {
      const dr = data[i] - bg[c][0], dg = data[i + 1] - bg[c][1], db = data[i + 2] - bg[c][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < best) best = d;
    }
    dist[p] = Math.sqrt(best);
  }
  // flood in from the rim
  const gone = new Uint8Array(n);
  const stack = [];
  const seed = (p) => { if (!gone[p] && dist[p] <= tol) { gone[p] = 1; stack.push(p); } };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    if (x > 0) seed(p - 1);
    if (x < width - 1) seed(p + 1);
    if (p >= width) seed(p - width);
    if (p < n - width) seed(p + width);
  }
  let removed = 0;
  for (let p = 0; p < n; p++) {
    if (gone[p] || (holes && dist[p] <= tol * 0.6)) { keep[p] = 0; removed++; }
  }
  // soften: a kept pixel that touches background and is nearly that colour is
  // a blend of the two, so it keeps only part of itself
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++) {
      if (!keep[p] || dist[p] > tol + soft) continue;
      const touches = (x > 0 && !keep[p - 1]) || (x < width - 1 && !keep[p + 1]) || (y > 0 && !keep[p - width]) || (y < height - 1 && !keep[p + width]);
      if (touches) keep[p] = Math.max(24, Math.round(255 * Math.min(1, (dist[p] - tol * 0.6) / (tol * 0.4 + soft))));
    }
  }
  return { mask: keep, colours: bg, removed };
}

/**
 * Take the background's colour out of the pixels at the edge of a cut-out
 * ("despill"), so a subject lifted off a green screen does not keep a green
 * rim. Works in place on straight RGBA; only touches partly covered pixels.
 */
export function decontaminate(data, mask, bgColours) {
  if (!bgColours || !bgColours.length) return data;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const a = mask[p] / 255;
    if (a <= 0.02 || a >= 0.98) continue;
    let best = bgColours[0], bd = Infinity;
    for (const c of bgColours) {
      const d = (data[i] - c[0]) ** 2 + (data[i + 1] - c[1]) ** 2 + (data[i + 2] - c[2]) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    // observed = a·subject + (1 − a)·background  →  solve for the subject
    for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round((data[i + c] - (1 - a) * best[c]) / a)));
  }
  return data;
}

/** Luminance of a hex colour, 0..1 — what painting on a mask with it means. */
export function hexLuma(hex) {
  const s = String(hex || "#000").replace("#", "");
  const n = parseInt(s.length === 3 ? s.replace(/./g, "$&$&") : s.slice(0, 6), 16) || 0;
  // rounded, so white is exactly 1 and not 0.9999999999999999
  return Math.round(((LR * ((n >> 16) & 255) + LG * ((n >> 8) & 255) + LB * (n & 255)) / 255) * 1e6) / 1e6;
}

/* ── picking a drawn piece ───────────────────────────────────────────────── */

/**
 * The piece of a layer under a point: everything with paint on it that is
 * joined to where you clicked. This is what lets a pixel layer be handled a
 * little like objects - click a doodle, move it, delete it.
 *
 * The flood runs over coarse cells rather than pixels (`cell` on a side, a
 * cell counting as painted if any pixel in it is). A pencil or charcoal
 * stroke is speckled with holes and loose grains; pixel by pixel it would
 * come apart into a hundred fragments. Cells bridge gaps smaller than
 * themselves, and the diagonal counts as joined.
 *
 * Returns `{ mask, box }` in the shape floodFill uses (mask: one byte per
 * pixel, 255 inside; box.x1 < box.x0 when nothing was hit).
 */
export function alphaIsland(data, width, height, sx, sy, { threshold = 10, cell = 0 } = {}) {
  const mask = new Uint8Array(width * height);
  const box = { x0: width, y0: height, x1: -1, y1: -1, count: 0 };
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return { mask, box };
  const c = Math.max(1, Math.round(cell || Math.min(8, Math.max(2, Math.max(width, height) / 512))));
  const cw = Math.ceil(width / c);
  const ch = Math.ceil(height / c);
  const solid = new Uint8Array(cw * ch);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / c) * cw;
    let i = y * width * 4 + 3;
    for (let x = 0; x < width; x++, i += 4) if (data[i] > threshold) solid[row + Math.floor(x / c)] = 1;
  }
  // the click itself may land in a grain-sized hole: look one cell around it
  let start = -1;
  const scx = Math.floor(sx / c);
  const scy = Math.floor(sy / c);
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const x = scx + dx;
    const y = scy + dy;
    if (x >= 0 && y >= 0 && x < cw && y < ch && solid[y * cw + x]) { start = y * cw + x; break; }
  }
  if (start < 0) return { mask, box };
  const seen = new Uint8Array(cw * ch);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const at = stack.pop();
    const x = at % cw;
    const y = (at - x) / cw;
    // every painted pixel in the cell, plus a pixel of margin so soft edges come along
    const px0 = Math.max(0, x * c - 1), px1 = Math.min(width - 1, (x + 1) * c);
    const py0 = Math.max(0, y * c - 1), py1 = Math.min(height - 1, (y + 1) * c);
    for (let py = py0; py <= py1; py++) {
      const o = py * width;
      for (let px = px0; px <= px1; px++) {
        if (mask[o + px] || data[(o + px) * 4 + 3] === 0) continue;
        mask[o + px] = 255;
        box.count++;
        if (px < box.x0) box.x0 = px;
        if (px > box.x1) box.x1 = px;
        if (py < box.y0) box.y0 = py;
        if (py > box.y1) box.y1 = py;
      }
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const n = ny * cw + nx;
        if (seen[n] || !solid[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return { mask, box };
}

/**
 * Every piece of paint a rectangle touches, whole: the box only has to reach a stroke for all of the
 * stroke to be picked. One pass over the layer (coarse cells, as alphaIsland), whatever the number
 * of pieces. Returns { mask (255 per pixel picked, as selections hold), count }.
 */
export function islandsTouching(data, width, height, rect, { threshold = 10, cell = 0 } = {}) {
  const mask = new Uint8Array(width * height);
  const c = Math.max(1, Math.round(cell || Math.min(8, Math.max(2, Math.max(width, height) / 512))));
  const cw = Math.ceil(width / c), ch = Math.ceil(height / c);
  const solid = new Uint8Array(cw * ch);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / c) * cw;
    let i = y * width * 4 + 3;
    for (let x = 0; x < width; x++, i += 4) if (data[i] > threshold) solid[row + Math.floor(x / c)] = 1;
  }
  const pick = new Uint8Array(cw * ch);
  const stack = [];
  const x0 = Math.max(0, Math.floor(rect.x / c)), y0 = Math.max(0, Math.floor(rect.y / c));
  const x1 = Math.min(cw - 1, Math.floor((rect.x + rect.w) / c)), y1 = Math.min(ch - 1, Math.floor((rect.y + rect.h) / c));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const s = y * cw + x;
    if (!solid[s] || pick[s]) continue;
    pick[s] = 1; stack.push(s);
    while (stack.length) {
      const k = stack.pop(), kx = k % cw, ky = (k - kx) / cw;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = kx + dx, ny = ky + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const n = ny * cw + nx;
        if (solid[n] && !pick[n]) { pick[n] = 1; stack.push(n); }
      }
    }
  }
  let count = 0;
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / c) * cw;
    let i = y * width * 4 + 3;
    for (let x = 0; x < width; x++, i += 4) if (pick[row + Math.floor(x / c)] && data[i] > threshold) { mask[y * width + x] = 255; count++; }
  }
  return { mask, count };
}

/**
 * The subject of a picture, by its background: the colours along the picture's edges are taken as the
 * background, and whatever of them can be reached from the edges (a small step of colour at a time, never
 * far from a background colour) is background; the rest - the person, the object - is the subject. Holes
 * inside it stay in it. A guess for plain backgrounds, not magic: a busy one needs the wand or the lasso.
 * Returns { mask (255 subject), count }.
 */
export function subjectMask(data, width, height, { tolerance = 38 } = {}) {
  const n = width * height;
  const bg = new Uint8Array(n);
  const at = (i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
  // the background's colours: the edge pixels, in a few groups
  const edge = [];
  for (let x = 0; x < width; x += 2) { edge.push(at(x)); edge.push(at((height - 1) * width + x)); }
  for (let y = 0; y < height; y += 2) { edge.push(at(y * width)); edge.push(at(y * width + width - 1)); }
  const groups = [];
  for (const c of edge) {
    const g = groups.find((q) => Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]) + Math.abs(q[2] - c[2]) < tolerance * 1.5);
    if (g) { g[3]++; } else if (groups.length < 12) groups.push([c[0], c[1], c[2], 1]);
  }
  const near = (i) => {
    if (data[i * 4 + 3] < 16) return true; // see-through: background
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    for (const q of groups) if (q[3] > 2 && Math.abs(q[0] - r) + Math.abs(q[1] - g) + Math.abs(q[2] - b) < tolerance * 2) return true;
    return false;
  };
  const stack = [];
  const seed = (i) => { if (!bg[i] && near(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % width, y = (i - x) / width;
    const step = (j) => {
      if (bg[j]) return;
      // a small step from its neighbour, and still near a background colour
      const d = Math.abs(data[j * 4] - data[i * 4]) + Math.abs(data[j * 4 + 1] - data[i * 4 + 1]) + Math.abs(data[j * 4 + 2] - data[i * 4 + 2]);
      if (d < tolerance && near(j)) { bg[j] = 1; stack.push(j); }
    };
    if (x > 0) step(i - 1);
    if (x < width - 1) step(i + 1);
    if (y > 0) step(i - width);
    if (y < height - 1) step(i + width);
  }
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if (!bg[i]) { mask[i] = 255; count++; }
  return { mask, count };
}
