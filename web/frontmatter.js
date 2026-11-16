// A note's front matter (the --- block at its top) as plain values: small enough for anything to import
// without pulling in the data view (dataview.js) at startup.

export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || "");
  if (!m) return {};
  const out = {};
  let list = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) { out[list].push(scalar(item[1])); continue; }
    const kv = /^([\w\- ]+?):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const v = kv[2].trim();
    list = null;
    if (!v) { out[key] = []; list = key; }
    else if (/^\[.*\]$/.test(v)) out[key] = v.slice(1, -1).split(",").map((x) => scalar(x.trim())).filter((x) => x !== "");
    else out[key] = scalar(v);
  }
  return out;
}
export function scalar(v) {
  const s = String(v).replace(/^["']|["']$/g, "");
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  return s;
}
