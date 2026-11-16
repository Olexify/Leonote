// What a Dataview block's frame runs (dataview.js makes the frame): a small Dataview over the pages it is
// sent, then the block's code. A plain script, not a module, loaded by the sandboxed frame from the app.
(() => {
  // nothing of the host may be reached from the block's code
  for (const k of Object.keys(window)) if (/^__TAURI|^__tauri|ipc/i.test(k)) try { delete window[k]; } catch {}
  const root = document.getElementById("dv");
  const post = (m) => parent.postMessage(m, "*");
  new ResizeObserver(() => post({ type: "dv-size", h: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);
  document.addEventListener("click", (e) => { const a = e.target.closest("a[data-href]"); if (a) { e.preventDefault(); post({ type: "dv-open", path: a.dataset.href }); } });

  class DvDate extends Date {
    toISODate() { return isNaN(this) ? null : this.getFullYear() + "-" + String(this.getMonth() + 1).padStart(2, "0") + "-" + String(this.getDate()).padStart(2, "0"); }
    toFormat(f) { const p = (n, k = 2) => String(n).padStart(k, "0"); const M = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      return String(f).replace(/yyyy|MMMM|MMM|MM|dd|HH|mm|ss|M|d/g, (t) => ({ yyyy: this.getFullYear(), MMMM: M[this.getMonth()], MMM: M[this.getMonth()].slice(0, 3), MM: p(this.getMonth() + 1), dd: p(this.getDate()), HH: p(this.getHours()), mm: p(this.getMinutes()), ss: p(this.getSeconds()), M: this.getMonth() + 1, d: this.getDate() })[t]); }
    get ts() { return this.getTime(); }
    get year() { return this.getFullYear(); }
    get month() { return this.getMonth() + 1; }
    get day() { return this.getDate(); }
    get weekday() { return this.getDay() || 7; }
    plus(o) { const d = new DvDate(this); if (o.days) d.setDate(d.getDate() + o.days); if (o.months) d.setMonth(d.getMonth() + o.months); if (o.years) d.setFullYear(d.getFullYear() + o.years); return d; }
    minus(o) { return this.plus(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, -v]))); }
    startOf(u) { const d = new DvDate(this); d.setHours(0, 0, 0, 0); if (u === "month") d.setDate(1); if (u === "year") { d.setMonth(0); d.setDate(1); } return d; }
    toString() { return this.toISODate(); }
  }
  const asDate = (v) => (v == null || v === "" ? null : v instanceof Date ? new DvDate(v) : new DvDate(String(v).length === 10 ? v + "T00:00:00" : v));
  // moment(), for the scripts written for Obsidian's own
  function moment(v) { if (!(this instanceof moment)) return new moment(v); this._d = v == null ? new Date() : new Date(v instanceof moment ? v._d : v); }
  moment.prototype.toDate = function () { return new Date(this._d); };
  moment.prototype.valueOf = function () { return this._d.getTime(); };
  moment.prototype.isValid = function () { return !isNaN(this._d); };
  moment.prototype.format = function (f = "YYYY-MM-DD") { return new DvDate(this._d).toFormat(String(f).replace(/YYYY/g, "yyyy").replace(/DD/g, "dd")); };
  window.moment = moment;

  const SWIZZLE = Symbol("raw");
  function da(arr) {
    const a = Array.from(arr || []);
    const api = {
      where: (f) => da(a.filter(f)), filter: (f) => da(a.filter(f)), map: (f) => da(a.map(f)), flatMap: (f) => da(a.flatMap(f)),
      sort: (key, dir, cmp) => { if (typeof key !== "function") return da([...a].sort()); if (key.length === 2 && dir === undefined) return da([...a].sort(key));
        const k = key; const s = dir === "desc" ? -1 : 1; return da([...a].sort((x, y) => { const p = k(x), q = k(y); const r = cmp ? cmp(p, q) : p < q ? -1 : p > q ? 1 : 0; return r * s; })); },
      groupBy: (f) => { const m = new Map(); for (const x of a) { const k = f(x); const key = k instanceof Date ? k.getTime() : k; if (!m.has(key)) m.set(key, { key: k, rows: [] }); m.get(key).rows.push(x); } return da([...m.values()].map((g) => ({ key: g.key, rows: da(g.rows) }))); },
      limit: (n) => da(a.slice(0, n)), slice: (s, e) => da(a.slice(s, e)), distinct: (f) => { const seen = new Set(); return da(a.filter((x) => { const k = f ? f(x) : x; if (seen.has(k)) return false; seen.add(k); return true; })); },
      first: () => a[0], last: () => a[a.length - 1], array: () => [...a], get values() { return [...a]; }, get length() { return a.length; },
      any: (f) => a.some(f), all: (f) => a.every(f), none: (f) => !a.some(f), some: (f) => a.some(f), every: (f) => a.every(f), find: (f) => a.find(f), findIndex: (f) => a.findIndex(f), includes: (x) => a.includes(x),
      forEach: (f) => a.forEach(f), reduce: (...r) => a.reduce(...r), join: (s) => a.join(s), indexOf: (x) => a.indexOf(x), concat: (...o) => da(a.concat(...o.map((x) => (x && x[SWIZZLE]) || x))),
      sum: () => a.reduce((s, x) => s + (Number(x) || 0), 0), avg: () => (a.length ? a.reduce((s, x) => s + (Number(x) || 0), 0) / a.length : 0), min: () => Math.min(...a), max: () => Math.max(...a),
      mutate: (f) => { a.forEach(f); return da(a); }, [Symbol.iterator]: () => a[Symbol.iterator](), [SWIZZLE]: a,
    };
    return new Proxy(api, { get(t, p) {
      if (p in t) return t[p];
      if (typeof p === "string" && /^\d+$/.test(p)) return a[+p];
      if (typeof p === "symbol") return undefined;
      // dv.pages().file.name: the field of every row, lists flattened
      return da(a.flatMap((x) => { const v = x == null ? undefined : x[p]; return v && v[SWIZZLE] ? v[SWIZZLE] : v === undefined ? [] : [v]; }));
    } });
  }
  const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(s);
  function livePage(p) {
    const f = p.file;
    const tasks = da((f.tasks || []).map((t) => { const o = { ...t }; for (const k of ["completion", "due", "scheduled", "start", "created"]) if (o[k]) o[k] = asDate(o[k]); return o; }));
    const file = { ...f, tasks, lists: tasks, ctime: asDate(f.ctime), mtime: asDate(f.mtime), cday: asDate(f.cday), mday: asDate(f.mday), day: asDate(f.day), tags: da(f.tags), etags: da(f.etags), outlinks: da(f.outlinks), link: link(f.path, f.name) };
    const out = { file };
    for (const [k, v] of Object.entries(p)) if (k !== "file") out[k] = isDate(v) ? asDate(v) : Array.isArray(v) ? da(v) : v;
    return out;
  }
  function link(path, display) { return { path, display: display || path.split("/").pop().replace(/\.md$/i, ""), type: "file", toString() { return "[[" + this.path + "|" + this.display + "]]"; } }; }

  function source(src, pages) {
    const s = String(src || "").trim();
    if (!s) return pages;
    // "folder", #tag, -"folder", -#tag, joined by or / and
    const parts = s.split(/\s+(or|and)\s+/i);
    let res = null, op = "or";
    for (const part of parts) {
      if (/^(or|and)$/i.test(part)) { op = part.toLowerCase(); continue; }
      const neg = part.startsWith("-");
      const t = part.replace(/^-/, "").trim();
      let test;
      if (t.startsWith("#")) { const tag = t.toLowerCase(); test = (p) => p.file.tags.some((x) => { const y = x.toLowerCase(); return y === tag || y.startsWith(tag + "/"); }); }
      else { const f = t.replace(/^["']|["']$/g, "").replace(/\/+$/, ""); test = (p) => !f || p.file.path === f || p.file.path === f + ".md" || p.file.path.startsWith(f + "/"); }
      const m = pages.filter((p) => (neg ? !test(p) : test(p)));
      res = res == null ? m : op === "and" ? res.filter((p) => m.includes(p)) : [...new Set([...res, ...m])];
    }
    return res || [];
  }

  // a query's frame shows strings as text, never as HTML: a query is run without asking, and a <link> in its result would reach out
  let asText = false;
  function render(v) {
    if (v == null) return document.createTextNode("");
    if (v instanceof Node) return v;
    if (v[SWIZZLE]) v = v[SWIZZLE];
    if (typeof v.path === "string" && v.display !== undefined) { const a = document.createElement("a"); a.className = "internal-link"; a.dataset.href = v.path; a.textContent = v.display; return a; }
    if (v instanceof Date) return document.createTextNode(new DvDate(v).toISODate());
    if (Array.isArray(v)) { const s = document.createElement("span"); v.forEach((x, i) => { if (i) s.append(", "); s.append(render(x)); }); return s; }
    if (typeof v === "object") return document.createTextNode(v.toString !== Object.prototype.toString ? String(v) : JSON.stringify(v));
    const s = String(v);
    if (!asText && /<[a-z][\s\S]*>/i.test(s)) { const t = document.createElement("span"); t.innerHTML = s; return t; }
    const t = document.createElement("span");
    t.innerHTML = s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, p, d) => '<a class="internal-link" data-href="' + p + '">' + (d || p) + "</a>");
    return t;
  }

  /* ── what Obsidian adds to the page, which scripts written there lean on ── */
  const EP = HTMLElement.prototype;
  const setOpts = (el, o) => {
    if (o == null) return el;
    if (typeof o === "string") { el.className = o; return el; }
    if (o.cls) el.className = [].concat(o.cls).join(" ");
    if (o.text != null) el.textContent = String(o.text);
    if (o.attr) for (const k in o.attr) if (o.attr[k] != null && o.attr[k] !== false) el.setAttribute(k, o.attr[k] === true ? "" : o.attr[k]);
    for (const k of ["title", "href", "type", "value", "placeholder"]) if (o[k] != null) el[k] = o[k];
    if (o.parent) o.parent.append(el);
    return el;
  };
  const mk = (tag, o, cb) => { const el = setOpts(document.createElement(tag), o); if (cb) cb(el); return el; };
  EP.createEl = function (tag, o, cb) { const el = mk(tag, o, cb); if (o && o.prepend) this.prepend(el); else this.append(el); return el; };
  EP.createDiv = function (o, cb) { return this.createEl("div", o, cb); };
  EP.createSpan = function (o, cb) { return this.createEl("span", o, cb); };
  EP.empty = function () { this.replaceChildren(); };
  EP.addClass = function (...c) { this.classList.add(...c.flatMap((x) => String(x).split(/\s+/)).filter(Boolean)); };
  EP.addClasses = function (c) { this.addClass(...c); };
  EP.removeClass = function (...c) { this.classList.remove(...c.flatMap((x) => String(x).split(/\s+/)).filter(Boolean)); };
  EP.toggleClass = function (c, on) { this.classList.toggle(c, on); };
  EP.hasClass = function (c) { return this.classList.contains(c); };
  EP.setText = function (t) { this.textContent = String(t ?? ""); };
  EP.appendText = function (t) { this.append(String(t ?? "")); };
  EP.setAttr = function (k, v) { if (v == null || v === false) this.removeAttribute(k); else this.setAttribute(k, v === true ? "" : v); };
  EP.setAttrs = function (o) { for (const k in o) this.setAttr(k, o[k]); };
  EP.getText = function () { return this.textContent; };
  EP.detach = function () { this.remove(); };
  EP.find = function (s) { return this.querySelector(s); };
  EP.findAll = function (s) { return [...this.querySelectorAll(s)]; };
  EP.show = function () { this.style.display = ""; };
  EP.hide = function () { this.style.display = "none"; };
  EP.toggle = function (on) { this.style.display = on ? "" : "none"; };
  EP.onClickEvent = function (f) { this.addEventListener("click", f); };
  window.createEl = mk;
  window.createDiv = (o, cb) => mk("div", o, cb);
  window.createSpan = (o, cb) => mk("span", o, cb);

  /* ── a note's whole text, asked of the app (only notes in the vault) ── */
  const loads = new Map();
  let loadSeq = 0;
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.type !== "dv-loaded" || e.source !== parent || !loads.has(m.id)) return;
    loads.get(m.id)(m.text == null ? undefined : m.text);
    loads.delete(m.id);
  });
  const loadNote = (path) => new Promise((res) => {
    const id = ++loadSeq;
    loads.set(id, res);
    post({ type: "dv-load", id, path: String(path && path.path ? path.path : path) });
    setTimeout(() => { if (loads.has(id)) { loads.delete(id); res(undefined); } }, 10000);
  });

  /* ── the Charts plugin's renderChart, drawn as a plain picture: line, bar, pie, doughnut ── */
  const SVGNS = "http://www.w3.org/2000/svg";
  const PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
  function renderChart(cfg, box) {
    const type = String((cfg && cfg.type) || "bar");
    const data = (cfg && cfg.data) || {};
    const o = (cfg && cfg.options) || {};
    const labels = (data.labels || []).map((l) => (Array.isArray(l) ? l.join(" ") : String(l ?? "")));
    const sets = data.datasets || [];
    const W = Math.max(320, box.clientWidth || 640);
    const H = Math.max(200, box.clientHeight || parseInt(box.style.height, 10) || 320);
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.display = "block";
    const add = (t, a, parent) => { const x = document.createElementNS(SVGNS, t); for (const k in a) x.setAttribute(k, a[k]); (parent || svg).append(x); return x; };
    const tip = (node, text) => { const t = document.createElementNS(SVGNS, "title"); t.textContent = text; node.append(t); };
    const pick = (c, i) => (Array.isArray(c) ? c[i % c.length] : c);
    const val = (d) => (d != null && typeof d === "object" ? Number(d.y) : Number(d));
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#999";
    const legend = !(o.plugins && o.plugins.legend && o.plugins.legend.display === false);
    const click = (ev, i, si) => { if (typeof o.onClick === "function") try { o.onClick(ev, [{ index: i, datasetIndex: si }]); } catch (err) { console.error(err); } };
    if (/^(pie|doughnut|polarArea)$/.test(type)) {
      const ds = sets[0] || { data: [] };
      const vals = ds.data.map(val);
      const total = vals.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
      const lw = legend ? Math.min(W * 0.45, 380) : 0;
      const r = Math.max(20, Math.min((W - lw) / 2, H / 2) - 14), cx = (W - lw) / 2, cy = H / 2;
      const inner = type === "doughnut" ? r * 0.58 : 0;
      const on = vals.map((v, i) => [v, i]).filter(([v]) => v > 0);
      const at = (a, rr) => (cx + rr * Math.cos(a)).toFixed(2) + " " + (cy + rr * Math.sin(a)).toFixed(2);
      let a0 = -Math.PI / 2;
      for (const [v, i] of on) {
        const fill = pick(ds.backgroundColor, i) || PALETTE[i % 8];
        let s;
        if (on.length === 1) { s = add("circle", { cx, cy, r, fill }); }
        else {
          const a1 = a0 + (v / total) * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
          s = add("path", { d: "M " + at(a0, r) + " A " + r + " " + r + " 0 " + big + " 1 " + at(a1, r) + (inner ? " L " + at(a1, inner) + " A " + inner + " " + inner + " 0 " + big + " 0 " + at(a0, inner) + " Z" : " L " + cx + " " + cy + " Z"), fill, stroke: "rgba(0,0,0,.25)", "stroke-width": 1 });
          a0 = a1;
        }
        tip(s, labels[i] + ": " + v + " (" + ((v / total) * 100).toFixed(1) + "%)");
        s.addEventListener("click", (ev) => click(ev, i, 0));
      }
      if (inner && on.length === 1) add("circle", { cx, cy, r: inner, fill: "var(--background-primary)" });
      if (legend) labels.forEach((l, i) => {
        const y = 24 + i * 22;
        if (y > H - 8) return;
        add("rect", { x: W - lw + 10, y: y - 11, width: 12, height: 12, rx: 3, fill: pick(ds.backgroundColor, i) || PALETTE[i % 8] });
        const t = add("text", { x: W - lw + 30, y, fill: ink, "font-size": 13 });
        t.textContent = l + ": " + (vals[i] || 0) + " (" + (((vals[i] || 0) / total) * 100).toFixed(1) + "%)";
      });
    } else {
      const all = sets.flatMap((s) => (s.data || []).map(val)).filter(Number.isFinite);
      const ys = (o.scales && o.scales.y) || {};
      let lo = ys.min != null ? Number(ys.min) : Math.min(0, ...all);
      let hi = ys.max != null ? Number(ys.max) : Math.max(1, ...all);
      if (ys.suggestedMax != null) hi = Math.max(hi, ys.suggestedMax);
      if (ys.suggestedMin != null) lo = Math.min(lo, ys.suggestedMin);
      if (hi === lo) hi = lo + 1;
      const L = 60, R = 16, T = legend && sets.length ? 32 : 12, B = 34;
      const pw = W - L - R, ph = H - T - B;
      const n = Math.max(labels.length, ...sets.map((s) => (s.data || []).length), 1);
      const bar = type === "bar";
      const X = (i) => L + (bar ? ((i + 0.5) * pw) / n : n === 1 ? pw / 2 : (i * pw) / (n - 1));
      const Y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
      const cb = ys.ticks && typeof ys.ticks.callback === "function" ? ys.ticks.callback : null;
      for (let k = 0; k <= 5; k++) {
        const v = lo + ((hi - lo) * k) / 5, y = Y(v);
        add("line", { x1: L, x2: W - R, y1: y, y2: y, stroke: "var(--background-modifier-border)", "stroke-width": 1 });
        let lab = Math.round(v * 10) / 10;
        if (cb) try { lab = cb(lab, k, []); } catch {}
        const t = add("text", { x: L - 8, y: y + 4, fill: ink, "font-size": 11, "text-anchor": "end" });
        t.textContent = lab;
      }
      const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 72))));
      labels.forEach((l, i) => { if (i % every) return; const t = add("text", { x: X(i), y: H - 12, fill: ink, "font-size": 11, "text-anchor": "middle" }); t.textContent = l; });
      sets.forEach((s, si) => {
        const c = s.borderColor && !Array.isArray(s.borderColor) ? s.borderColor : PALETTE[si % 8];
        const vs = (s.data || []).map(val);
        const base = Y(Math.max(lo, Math.min(hi, 0)));
        if (bar) {
          const bw = ((pw / n) * 0.8) / sets.length;
          vs.forEach((v, i) => {
            if (!Number.isFinite(v)) return;
            const x = X(i) - (pw / n) * 0.4 + si * bw, y1 = Y(v);
            const r = add("rect", { x, y: Math.min(base, y1), width: Math.max(1, bw - 2), height: Math.max(1, Math.abs(y1 - base)), rx: 3, fill: pick(s.backgroundColor, i) || c });
            tip(r, (labels[i] ?? i) + ": " + v);
            r.addEventListener("click", (ev) => click(ev, i, si));
          });
        } else {
          const pts = vs.map((v, i) => (Number.isFinite(v) ? [X(i), Y(v)] : null)).filter(Boolean);
          if (s.fill && pts.length) add("path", { d: "M " + pts[0][0] + " " + base + pts.map((p) => " L " + p[0] + " " + p[1]).join("") + " L " + pts[pts.length - 1][0] + " " + base + " Z", fill: pick(s.backgroundColor, 0) || c, opacity: 0.35 });
          add("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: c, "stroke-width": Math.min(4, s.borderWidth || 2), "stroke-linejoin": "round" });
          vs.forEach((v, i) => {
            if (!Number.isFinite(v)) return;
            const d = add("circle", { cx: X(i), cy: Y(v), r: Math.max(2, Math.min(6, s.pointRadius ?? 3)), fill: pick(s.pointBackgroundColor, i) || c });
            tip(d, (labels[i] ?? i) + ": " + v);
            if (o.onClick) d.style.cursor = "pointer";
            d.addEventListener("click", (ev) => click(ev, i, si));
          });
        }
      });
      if (legend && sets.length) sets.forEach((s, si) => {
        const x = L + si * 170;
        add("rect", { x, y: 8, width: 12, height: 12, rx: 3, fill: s.borderColor && !Array.isArray(s.borderColor) ? s.borderColor : pick(s.backgroundColor, 0) || PALETTE[si % 8] });
        const t = add("text", { x: x + 18, y: 18, fill: ink, "font-size": 12 });
        t.textContent = s.label || "";
      });
    }
    box.replaceChildren(svg);
    return { destroy() { svg.remove(); }, update() {}, data, options: o, canvas: svg };
  }
  window.renderChart = renderChart;
  window.Chart = { register() {}, unregister() {}, plugins: { getAll: () => [] }, defaults: { font: {}, color: "", plugins: { legend: { labels: {} }, tooltip: {} } } };

  /* ── Dataview's query language: TABLE, LIST, TASK with FROM, WHERE, FLATTEN, GROUP BY, SORT, LIMIT ── */
  const unwrap = (v) => (v && v[SWIZZLE] ? v[SWIZZLE] : v);
  const DUR = { ms: 1, millisecond: 1, s: 1e3, sec: 1e3, second: 1e3, m: 6e4, min: 6e4, minute: 6e4, h: 36e5, hr: 36e5, hour: 36e5, d: 864e5, day: 864e5, w: 6048e5, wk: 6048e5, week: 6048e5, mo: 2592e6, month: 2592e6, y: 31536e6, yr: 31536e6, year: 31536e6 };
  class Dur { constructor(ms) { this.ms = ms; } valueOf() { return this.ms; } toString() { const d = Math.round(this.ms / 864e5); return d + (Math.abs(d) === 1 ? " day" : " days"); } }
  function parseDur(s) {
    let ms = 0, any = false;
    for (const m of String(s).matchAll(/(-?[\d.]+)\s*([a-z]+)/gi)) { const u = m[2].toLowerCase().replace(/s$/, ""); if (DUR[u] != null) { ms += Number(m[1]) * DUR[u]; any = true; } }
    return any ? new Dur(ms) : null;
  }
  function namedDate(s) {
    const t = String(s).trim().toLowerCase();
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (t === "today") return new DvDate(d);
    if (t === "now") return new DvDate();
    if (t === "tomorrow") { d.setDate(d.getDate() + 1); return new DvDate(d); }
    if (t === "yesterday") { d.setDate(d.getDate() - 1); return new DvDate(d); }
    if (t === "sow") { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return new DvDate(d); }
    if (t === "eow") { d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 6); return new DvDate(d); }
    if (t === "som") { d.setDate(1); return new DvDate(d); }
    if (t === "eom") { d.setMonth(d.getMonth() + 1, 0); return new DvDate(d); }
    if (t === "soy") { d.setMonth(0, 1); return new DvDate(d); }
    if (t === "eoy") { d.setMonth(11, 31); return new DvDate(d); }
    return /^\d{4}-\d{2}(-\d{2})?/.test(t) ? asDate(t.length === 7 ? t + "-01" : t) : null;
  }

  // tokens: strings, numbers, names (dotted), [[links]], operators
  function lex(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '"' || c === "'") { let j = i + 1, v = ""; while (j < s.length && s[j] !== c) { if (s[j] === "\\" && j + 1 < s.length) j++; v += s[j++]; } out.push({ t: "str", v }); i = j + 1; continue; }
      if (s.startsWith("[[", i)) { const j = s.indexOf("]]", i); const v = s.slice(i + 2, j < 0 ? s.length : j).split("|")[0]; out.push({ t: "link", v }); i = j < 0 ? s.length : j + 2; continue; }
      const num = /^\d+(\.\d+)?/.exec(s.slice(i));
      if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
      const op = /^(<=|>=|!=|=|<|>|\+|-|\*|\/|%|\(|\)|,|!|\[|\])/.exec(s.slice(i));
      if (op) { out.push({ t: "op", v: op[0] }); i += op[0].length; continue; }
      const name = /^[#\p{L}_][\p{L}\p{N}_\-./]*/u.exec(s.slice(i));
      if (name) {
        const v = name[0];
        // date(today), dur(7 days): what is inside is words, not an expression
        if (/^(date|dur)$/i.test(v) && s[i + v.length] === "(") {
          const close = s.indexOf(")", i + v.length);
          const raw = s.slice(i + v.length + 1, close);
          if (/^(date)$/i.test(v) ? /^\s*(today|now|tomorrow|yesterday|sow|eow|som|eom|soy|eoy|\d{4}-\d{2}(-\d{2})?(T[\d:.]+)?)\s*$/i.test(raw) : /^\s*-?[\d.]+\s*[a-z]/i.test(raw)) {
            out.push({ t: "lit", v: v.toLowerCase() === "date" ? namedDate(raw) : parseDur(raw) });
            i = close + 1;
            continue;
          }
        }
        out.push({ t: "name", v });
        i += v.length;
        continue;
      }
      throw new Error("Cannot read “" + s.slice(i, i + 12) + "”");
    }
    return out;
  }

  function parseExpr(src) {
    const tk = lex(src);
    let k = 0;
    const peek = () => tk[k];
    const isOp = (v) => tk[k] && tk[k].t === "op" && tk[k].v === v;
    const isWord = (v) => tk[k] && tk[k].t === "name" && tk[k].v.toLowerCase() === v;
    const expect = (v) => { if (!isOp(v)) throw new Error("Expected " + v); k++; };
    function primary() {
      const t = tk[k++];
      if (!t) throw new Error("The expression ends too soon");
      if (t.t === "num" || t.t === "str" || t.t === "lit") return { k: "val", v: t.v };
      if (t.t === "link") return { k: "link", v: t.v };
      if (t.t === "op" && t.v === "(") { const e = or(); expect(")"); return e; }
      if (t.t === "op" && t.v === "[") { const items = []; while (!isOp("]")) { items.push(or()); if (isOp(",")) k++; } k++; return { k: "list", items }; }
      if (t.t === "op" && (t.v === "!" || t.v === "-")) return { k: "un", op: t.v, a: unary() };
      if (t.t === "name") {
        const low = t.v.toLowerCase();
        if (low === "true" || low === "false") return { k: "val", v: low === "true" };
        if (low === "null") return { k: "val", v: null };
        if (isOp("(")) { k++; const args = []; while (!isOp(")")) { args.push(or()); if (isOp(",")) k++; else if (!isOp(")")) throw new Error("Expected , or )"); } k++; return { k: "call", f: low, args }; }
        if (t.v.startsWith("#")) return { k: "val", v: t.v };
        return { k: "field", path: t.v.split(".") };
      }
      throw new Error("Unexpected “" + t.v + "”");
    }
    function postfix() { let e = primary(); while (isOp("[")) { k++; const i = or(); expect("]"); e = { k: "index", a: e, i }; } return e; }
    function unary() { if (isOp("!") || isOp("-")) { const op = tk[k++].v; return { k: "un", op, a: unary() }; } return postfix(); }
    function mul() { let a = unary(); while (isOp("*") || isOp("/") || isOp("%")) { const op = tk[k++].v; a = { k: "bin", op, a, b: unary() }; } return a; }
    function add() { let a = mul(); while (isOp("+") || isOp("-")) { const op = tk[k++].v; a = { k: "bin", op, a, b: mul() }; } return a; }
    function cmp() { let a = add(); while (["=", "!=", "<", ">", "<=", ">="].some(isOp)) { const op = tk[k++].v; a = { k: "bin", op, a, b: add() }; } return a; }
    function and() { let a = cmp(); while (isWord("and") || isOp("&")) { k++; a = { k: "and", a, b: cmp() }; } return a; }
    function or() { let a = and(); while (isWord("or") || isOp("|")) { k++; a = { k: "or", a, b: and() }; } return a; }
    const e = or();
    if (k < tk.length) throw new Error("Did not understand “" + (peek().v + "") + "”");
    return e;
  }

  const lower = (v) => (v == null ? "" : String(v).toLowerCase());
  function getField(v, key) {
    v = unwrap(v);
    if (v == null) return null;
    if (Array.isArray(v)) return v.flatMap((x) => { const r = getField(x, key); return Array.isArray(r) ? r : r == null ? [] : [r]; });
    if (typeof v !== "object") return null;
    if (key in v) return unwrap(v[key]);
    // fields are matched without regard to case and spaces, as Dataview does
    const want = key.toLowerCase().replace(/[\s_-]/g, "");
    for (const k of Object.keys(v)) if (k.toLowerCase().replace(/[\s_-]/g, "") === want) return unwrap(v[k]);
    return null;
  }
  const eq = (a, b) => (a instanceof Date || b instanceof Date ? +a === +b : a && a.path && b && b.path ? a.path === b.path : String(a) === String(b) && typeof a === typeof b) || a === b;
  const compare = (a, b) => { a = unwrap(a); b = unwrap(b); if (a == null) return b == null ? 0 : -1; if (b == null) return 1; if (a.path && b.path) { a = a.display; b = b.display; } const x = a instanceof Date || a instanceof Dur ? +a : a, y = b instanceof Date || b instanceof Dur ? +b : b; return x < y ? -1 : x > y ? 1 : 0; };
  const truthy = (v) => { v = unwrap(v); return Array.isArray(v) ? v.length > 0 : !!v; };
  const listOf = (v) => { v = unwrap(v); return v == null ? [] : Array.isArray(v) ? v : [v]; };
  const FN = {
    contains: (a, b) => { a = unwrap(a); if (Array.isArray(a)) return a.some((x) => eq(x, b) || (typeof x === "string" && typeof b === "string" && x === b)); if (a && typeof a === "object" && !(a instanceof Date)) return b in a; return String(a ?? "").includes(String(b)); },
    icontains: (a, b) => { a = unwrap(a); return Array.isArray(a) ? a.some((x) => lower(x).includes(lower(b))) : lower(a).includes(lower(b)); },
    econtains: (a, b) => listOf(a).some((x) => eq(x, b)),
    containsword: (a, b) => new RegExp("\\b" + [...String(b)].map((ch) => (/[\p{L}\p{N}\s]/u.test(ch) ? ch : "\\" + ch)).join("") + "\\b", "iu").test(String(a ?? "")),
    length: (a) => { a = unwrap(a); return a == null ? 0 : Array.isArray(a) || typeof a === "string" ? a.length : Object.keys(a).length; },
    lower: (a) => lower(a), upper: (a) => String(a ?? "").toUpperCase(),
    round: (a, n = 0) => Math.round(Number(a) * 10 ** n) / 10 ** n, trunc: (a) => Math.trunc(a), floor: (a) => Math.floor(a), ceil: (a) => Math.ceil(a),
    default: (a, d) => (a == null || (Array.isArray(a) && !a.length) ? d : a), choice: (c, a, b) => (truthy(c) ? a : b),
    regexmatch: (p, s) => new RegExp("^(?:" + p + ")$").test(String(s ?? "")), regextest: (p, s) => new RegExp(p).test(String(s ?? "")), regexreplace: (s, p, r) => String(s ?? "").replace(new RegExp(p, "g"), r),
    startswith: (s, p) => String(s ?? "").startsWith(p), endswith: (s, p) => String(s ?? "").endsWith(p), replace: (s, a, b) => String(s ?? "").split(a).join(b),
    number: (s) => { const m = /-?[\d.]+/.exec(String(s ?? "")); return m ? Number(m[0]) : null; }, string: (s) => (s == null ? "" : String(s)),
    link: (p, d) => link(String(p), d), date: (s) => (s instanceof Date ? new DvDate(s) : namedDate(s) || asDate(s)), dur: (s) => parseDur(s),
    sum: (l) => listOf(l).reduce((t, x) => t + (Number(x) || 0), 0), average: (l) => { const a = listOf(l); return a.length ? a.reduce((t, x) => t + (Number(x) || 0), 0) / a.length : null; },
    min: (...a) => { const l = a.length === 1 ? listOf(a[0]) : a; return l.length ? l.reduce((x, y) => (compare(x, y) <= 0 ? x : y)) : null; },
    max: (...a) => { const l = a.length === 1 ? listOf(a[0]) : a; return l.length ? l.reduce((x, y) => (compare(x, y) >= 0 ? x : y)) : null; },
    join: (l, sep = ", ") => listOf(l).map((x) => (x && x.display ? x.display : x)).join(sep), split: (s, p) => String(s ?? "").split(new RegExp(p)),
    list: (...a) => a, nonnull: (l) => listOf(l).filter((x) => x != null), flat: (l) => listOf(l).flat(), reverse: (l) => [...listOf(l)].reverse(), sort: (l) => [...listOf(l)].sort(compare), unique: (l) => [...new Set(listOf(l))],
    any: (l) => listOf(l).some(truthy), all: (l) => listOf(l).every(truthy), none: (l) => !listOf(l).some(truthy),
    striptime: (d) => { if (!(d instanceof Date)) return d; const x = new DvDate(d); x.setHours(0, 0, 0, 0); return x; },
    dateformat: (d, f) => (d instanceof Date ? new DvDate(d).toFormat(f) : d), typeof: (v) => (v == null ? "null" : v instanceof Date ? "date" : v instanceof Dur ? "duration" : Array.isArray(unwrap(v)) ? "array" : v.path ? "link" : typeof v),
    meta: (l) => (l && l.path ? { path: l.path, display: l.display, type: "file" } : null), extract: (o, ...ks) => Object.fromEntries(ks.map((k) => [k, getField(o, k)])),
  };
  function ev(e, row) {
    switch (e.k) {
      case "val": return e.v;
      case "link": return link(e.v.endsWith(".md") ? e.v : e.v, e.v.split("/").pop());
      case "list": return e.items.map((x) => ev(x, row));
      case "field": {
        let v = e.path[0] === "this" ? row.__this : getField(row, e.path[0]);
        if (v == null && e.path.length === 1 && row.__group && e.path[0] !== "key" && e.path[0] !== "rows") v = null;
        for (const p of e.path.slice(1)) v = getField(v, p);
        return v;
      }
      case "index": { const a = unwrap(ev(e.a, row)), i = ev(e.i, row); return Array.isArray(a) ? a[i < 0 ? a.length + i : i] : getField(a, i); }
      case "un": { const a = ev(e.a, row); return e.op === "!" ? !truthy(a) : a instanceof Dur ? new Dur(-a.ms) : -a; }
      case "and": return truthy(ev(e.a, row)) && truthy(ev(e.b, row));
      case "or": return truthy(ev(e.a, row)) || truthy(ev(e.b, row));
      case "call": { const f = FN[e.f]; if (!f) throw new Error("No function " + e.f + "()"); return f(...e.args.map((x) => ev(x, row))); }
      case "bin": {
        const a = unwrap(ev(e.a, row)), b = unwrap(ev(e.b, row));
        switch (e.op) {
          case "=": return eq(a, b);
          case "!=": return !eq(a, b);
          case "<": return a != null && b != null && compare(a, b) < 0;
          case ">": return a != null && b != null && compare(a, b) > 0;
          case "<=": return a != null && b != null && compare(a, b) <= 0;
          case ">=": return a != null && b != null && compare(a, b) >= 0;
          case "+": if (a instanceof Date && b instanceof Dur) return new DvDate(+a + b.ms); if (a instanceof Dur && b instanceof Dur) return new Dur(a.ms + b.ms); if (typeof a === "string" || typeof b === "string") return String(a ?? "") + String(b ?? ""); return (a ?? 0) + (b ?? 0);
          case "-": if (a instanceof Date && b instanceof Dur) return new DvDate(+a - b.ms); if (a instanceof Date && b instanceof Date) return new Dur(+a - +b); if (a instanceof Dur && b instanceof Dur) return new Dur(a.ms - b.ms); return (a ?? 0) - (b ?? 0);
          case "*": return a instanceof Dur ? new Dur(a.ms * b) : a * b;
          case "/": return a instanceof Dur && b instanceof Dur ? a.ms / b.ms : a instanceof Dur ? new Dur(a.ms / b) : a / b;
          case "%": return a % b;
        }
      }
    }
    return null;
  }

  // the query, split into its clauses where a keyword starts one (not inside quotes)
  function clauses(q) {
    const KW = /^(FROM|WHERE|SORT|LIMIT|GROUP\s+BY|FLATTEN)\b/i;
    const out = [];
    let cur = { kw: "HEAD", text: "" }, quote = null;
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (quote) { if (c === quote) quote = null; cur.text += c; continue; }
      if (c === '"' || c === "'") { quote = c; cur.text += c; continue; }
      const prev = i ? q[i - 1] : " ";
      if (/\s/.test(prev)) { const m = KW.exec(q.slice(i)); if (m) { out.push(cur); cur = { kw: m[1].toUpperCase().replace(/\s+/g, " "), text: "" }; i += m[0].length - 1; continue; } }
      cur.text += c;
    }
    out.push(cur);
    return out.map((x) => ({ kw: x.kw, text: x.text.trim() }));
  }
  // top-level commas only: TABLE a, contains(b, ","), c
  function splitTop(s) { const out = []; let d = 0, q = null, cur = ""; for (const c of s) { if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === "(" || c === "[") d++; else if (c === ")" || c === "]") d--; else if (c === "," && !d) { out.push(cur); cur = ""; continue; } cur += c; } if (cur.trim()) out.push(cur); return out.map((x) => x.trim()); }
  const asName = (s) => { const m = /^([\s\S]+?)\s+AS\s+("([^"]*)"|'([^']*)'|(\S+))\s*$/i.exec(s); return m ? { expr: m[1].trim(), name: m[3] ?? m[4] ?? m[5] } : { expr: s.trim(), name: s.trim() }; };

  function runDql(q, pages, current, out) {
    const cl = clauses(q.replace(/\r/g, ""));
    const head = /^(TABLE|LIST|TASK|CALENDAR)\b\s*([\s\S]*)$/i.exec(cl[0].text);
    if (!head) throw new Error("A query starts with TABLE, LIST or TASK");
    const type = head[1].toUpperCase();
    let rest = head[2].trim();
    const withoutId = /^WITHOUT\s+ID\b/i.test(rest);
    if (withoutId) rest = rest.replace(/^WITHOUT\s+ID\b/i, "").trim();
    if (type === "CALENDAR") { out.append(render("Calendar views are not drawn here - a TABLE or LIST of the same query works.")); return; }
    const self = current;
    let src = pages;
    let rows;
    const fromC = cl.find((c) => c.kw === "FROM");
    if (fromC) src = source(fromC.text, pages);
    if (type === "TASK") rows = src.flatMap((p) => unwrap(p.file.tasks).map((t) => ({ ...t, file: p.file, __this: self, __page: p })));
    else rows = src.map((p) => ({ ...p, __this: self, __page: p }));
    let grouped = false;
    for (const c of cl.slice(1)) {
      if (c.kw === "FROM") continue;
      if (c.kw === "WHERE") { const e = parseExpr(c.text); rows = rows.filter((r) => truthy(ev(e, r))); }
      else if (c.kw === "FLATTEN") { const { expr, name } = asName(c.text); const e = parseExpr(expr); rows = rows.flatMap((r) => { const v = listOf(ev(e, r)); return (v.length ? v : [null]).map((x) => ({ ...r, [name]: x })); }); }
      else if (c.kw === "SORT") {
        const keys = splitTop(c.text).map((s) => { const m = /^([\s\S]+?)(\s+(ASC|ASCENDING|DESC|DESCENDING))?$/i.exec(s); return { e: parseExpr(m[1]), dir: m[3] && /^desc/i.test(m[3]) ? -1 : 1 }; });
        rows = rows.map((r, i) => ({ r, i })).sort((x, y) => { for (const k of keys) { const c2 = compare(ev(k.e, x.r), ev(k.e, y.r)); if (c2) return c2 * k.dir; } return x.i - y.i; }).map((x) => x.r);
      } else if (c.kw === "GROUP BY") {
        const { expr, name } = asName(c.text);
        const e = parseExpr(expr);
        const m = new Map();
        for (const r of rows) { const k = ev(e, r); const key = k instanceof Date ? "d" + +k : k && k.path ? "l" + k.path : JSON.stringify(k); if (!m.has(key)) m.set(key, { key: k, rows: [] }); m.get(key).rows.push(r); }
        rows = [...m.values()].map((g) => ({ key: g.key, [name]: g.key, rows: g.rows, __group: true, __this: self }));
        grouped = true;
      } else if (c.kw === "LIMIT") rows = rows.slice(0, Math.max(0, Number(c.text) || 0));
    }
    const idOf = (r) => (r.__group ? r.key : r.file ? r.file.link || link(r.file.path, r.file.name) : null);
    if (type === "LIST") {
      const e = rest ? parseExpr(rest) : null;
      const ul = document.createElement("ul");
      ul.className = "dataview list-view-ul";
      for (const r of rows) {
        const li = document.createElement("li");
        if (r.__group && !e) {
          li.append(render(r.key));
          const sub = document.createElement("ul");
          for (const x of r.rows) { const l2 = document.createElement("li"); l2.append(render(idOf(x))); sub.append(l2); }
          li.append(sub);
        } else {
          if (!withoutId) li.append(render(idOf(r)));
          if (e) { if (!withoutId) li.append(": "); li.append(render(ev(e, r))); }
        }
        ul.append(li);
      }
      out.append(ul);
    } else if (type === "TABLE") {
      const cols = rest ? splitTop(rest).map(asName).map((c) => ({ name: c.name, e: parseExpr(c.expr) })) : [];
      const t = document.createElement("table");
      t.className = "dataview table-view-table";
      const tr = document.createElement("tr");
      const heads = [...(withoutId ? [] : [(grouped ? "Group" : "File") + " (" + rows.length + ")"]), ...cols.map((c) => c.name)];
      for (const x of heads) { const th = document.createElement("th"); th.textContent = x; tr.append(th); }
      const thead = document.createElement("thead"); thead.append(tr); t.append(thead);
      const tb = document.createElement("tbody");
      for (const r of rows) {
        const row = document.createElement("tr");
        const cells = [...(withoutId ? [] : [idOf(r)]), ...cols.map((c) => ev(c.e, r))];
        for (const v of cells) { const td = document.createElement("td"); td.append(render(v)); row.append(td); }
        tb.append(row);
      }
      t.append(tb);
      out.append(t);
    } else if (type === "TASK") {
      // as Dataview shows them: under the note they are in
      const byFile = new Map();
      const all = grouped ? rows.flatMap((g) => g.rows) : rows;
      for (const r of all) { const k = r.file.path; if (!byFile.has(k)) byFile.set(k, { file: r.file, tasks: [] }); byFile.get(k).tasks.push(r); }
      for (const { file, tasks } of byFile.values()) {
        const h4 = document.createElement("h4"); h4.append(render(file.link || link(file.path, file.name))); out.append(h4);
        const ul = document.createElement("ul"); ul.className = "contains-task-list";
        for (const tk of tasks) { const li = document.createElement("li"); li.className = "task-list-item" + (tk.completed ? " is-checked" : ""); const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!tk.completed; cb.disabled = true; li.append(cb, " ", render(tk.text)); ul.append(li); }
        out.append(ul);
      }
      if (!byFile.size) out.append(render("No tasks."));
    }
  }

  // the block's code as a script of its own, from a blob: address (no eval: the policy allows none), called as
  // Dataview calls it - an async function of dv, app and moment, with this.container
  const runCode = (code, dv) => new Promise((done, fail) => {
    let failed = null;
    const onErr = (e) => { failed = e.error || new Error(e.message); };
    const url = URL.createObjectURL(new Blob(["window.__dvBlock = async function (dv, app, moment) {\n" + code + "\n};"], { type: "text/javascript" }));
    const s = document.createElement("script");
    const end = () => { removeEventListener("error", onErr); URL.revokeObjectURL(url); s.remove(); };
    window.__dvBlock = null;
    addEventListener("error", onErr);
    s.onload = () => { end(); if (failed || !window.__dvBlock) return fail(failed || new Error("The block could not be read")); Promise.resolve().then(() => window.__dvBlock.call({ container: root }, dv, window.app, moment)).then(done, fail); };
    s.onerror = () => { end(); fail(new Error("The block could not be loaded")); };
    s.src = url;
    document.head.append(s);
  });

  addEventListener("message", async (e) => {
    const m = e.data;
    // from the app only: a card's code could otherwise run itself in a query's frame next to it, where it was never asked about
    if (!m || m.type !== "dv-run" || e.source !== parent) return;
    asText = m.kind === "dql";
    document.body.classList.toggle("theme-dark", !!m.dark);
    document.body.classList.toggle("theme-light", !m.dark);
    const pages = da(m.pages.map(livePage));
    const byPath = new Map(pages.array().map((p) => [p.file.path, p]));
    const el = (tag, text, o = {}) => { const x = document.createElement(tag); if (o.cls) x.className = [].concat(o.cls).join(" "); if (o.attr) for (const [k, v] of Object.entries(o.attr)) x.setAttribute(k, v); if (text != null && text !== "") x.append(render(text)); (o.container || dv.container).append(x); return x; };
    const dv = {
      container: root,
      pages: (s) => da(source(s, pages.array())),
      pagePaths: (s) => da(source(s, pages.array()).map((p) => p.file.path)),
      page: (p) => byPath.get(p) || byPath.get(p + ".md") || pages.array().find((x) => x.file.name === p) || null,
      current: () => byPath.get(m.current) || { file: { path: m.current || "", name: (m.current || "").split("/").pop(), tasks: da([]), tags: da([]) } },
      array: (x) => da(x && x[SWIZZLE] ? x[SWIZZLE] : x), isArray: (x) => Array.isArray(x) || !!(x && x[SWIZZLE]),
      date: (x) => (x === "today" ? new DvDate(new Date().setHours(0, 0, 0, 0)) : x === "now" ? new DvDate() : x === "tomorrow" ? new DvDate(new Date().setHours(24, 0, 0, 0)) : x === "yesterday" ? new DvDate(new Date().setHours(-24, 0, 0, 0)) : asDate(x)),
      fileLink: (p, embed, d) => link(p, d), sectionLink: (p, s, embed, d) => link(p, d || s), blockLink: (p, b, embed, d) => link(p, d),
      el, header: (n, t) => el("h" + Math.min(6, Math.max(1, n)), t), paragraph: (t, o) => el("p", t, o), span: (t, o) => el("span", t, o),
      list: (items) => { const ul = el("ul"); for (const x of (items && items[SWIZZLE]) || items || []) { const li = document.createElement("li"); li.append(render(x)); ul.append(li); } return ul; },
      table: (heads, rows) => { const t = el("table", null, { cls: "dataview table-view-table" }); const tr = document.createElement("tr"); for (const x of heads) { const th = document.createElement("th"); th.append(render(x)); tr.append(th); } const th = document.createElement("thead"); th.append(tr); t.append(th); const tb = document.createElement("tbody"); for (const r of (rows && rows[SWIZZLE]) || rows || []) { const row = document.createElement("tr"); for (const c of (r && r[SWIZZLE]) || r) { const td = document.createElement("td"); td.append(render(c)); row.append(td); } tb.append(row); } t.append(tb); return t; },
      taskList: (tasks, group = true) => { const list = (tasks && tasks[SWIZZLE]) || tasks || []; const ul = el("ul", null, { cls: "contains-task-list" }); for (const t of list) { const li = document.createElement("li"); li.className = "task-list-item" + (t.completed ? " is-checked" : ""); const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!t.completed; cb.disabled = true; li.append(cb, " ", render(t.text)); ul.append(li); } return ul; },
      io: { load: (p) => loadNote(p), csv: async () => { throw new Error("Reading CSV files is not available here"); } },
      execute: () => el("p", "Dataview queries (DQL) are not run here - only dataviewjs.", { cls: "dv-note" }),
      luxon: { DateTime: { now: () => new DvDate(), fromISO: (s) => asDate(s), fromJSDate: (d) => new DvDate(d) } },
      compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0), equal: (a, b) => a === b,
    };
    window.dv = dv;
    const openLink = (text, src) => post({ type: "dv-open", path: String(text || src || "").replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0] });
    window.app = { plugins: { plugins: {}, enabledPlugins: new Set(), getPlugin: () => null }, vault: { getName: () => "vault" }, workspace: { openLinkText: openLink, getActiveFile: () => null }, metadataCache: { getFirstLinkpathDest: () => null } };
    try {
      if (m.kind === "dql") runDql(m.code, pages.array(), dv.current(), root);
      else await runCode(m.code, dv);
    } catch (err) {
      const box = document.createElement("div");
      box.className = "dv-error";
      box.textContent = (m.kind === "dql" ? "Dataview: " : "Evaluation error: ") + (err && err.message ? err.message : err);
      post({ type: "dv-error", text: box.textContent });
      root.append(box);
    }
  });
  post({ type: "dv-ready" });
})();
