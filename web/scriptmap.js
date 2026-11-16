// The script window's text and the note it came from: each block on screen (heading, paragraph, list item)
// remembers the note's lines it was read from, so an edit made on screen goes back to exactly those lines -
// the rest of the note (front matter, pictures, code, comments, the other blocks with their markup) as it was.
// A plain script (the script window loads it as is); tests import it and use globalThis.ScriptMap.
globalThis.ScriptMap = (() => {
  const norm = (s) => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  /** Markdown's markup off a line, as it is read aloud: links to their words, pictures and emphasis gone. */
  const clean = (s) => norm(String(s)
    .replace(/!\[\[[^\]]*\]\]/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|==|~~)(.+?)\1/g, "$2").replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1").replace(/\s\^[\w-]+$/, ""));

  /** The blocks to read: [{ tag: h1|h2|h3|p|li, text, start, end, prefix }] - start and end are the note's own
   *  line numbers (lines one after another make one paragraph), prefix what a rewritten block starts with. */
  function blocks(text) {
    const lines = String(text || "").split(/\r?\n/);
    const out = [];
    let i = 0, para = null, fence = false, comment = false;
    // the front matter: not read
    if (/^---\s*$/.test(lines[0] || "")) { const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l)); if (end > 0) i = end + 1; }
    for (; i < lines.length; i++) {
      const raw = lines[i], line = raw.trim();
      if (/^(```|~~~)/.test(line)) { fence = !fence; para = null; continue; }
      if (fence) continue;
      if (comment || line.startsWith("<!--")) { comment = !line.includes("-->"); para = null; continue; }
      if (!line) { para = null; continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const li = /^((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)(.*)$/.exec(line);
      if (h) { para = null; const t = clean(h[2]); if (t) out.push({ tag: h[1].length === 1 ? "h1" : h[1].length === 2 ? "h2" : "h3", text: t, start: i, end: i, prefix: h[1] + " " }); continue; }
      if (li) { para = null; const t = clean(li[2]); if (t) out.push({ tag: "li", text: t, start: i, end: i, prefix: raw.slice(0, raw.indexOf(li[1])) + li[1] }); continue; }
      const quote = /^>\s?/.test(line);
      const t = clean(line.replace(/^>\s?/, ""));
      if (!t) { para = null; continue; }
      if (para) { para.text = para.text + " " + t; para.end = i; }
      else { para = { tag: "p", text: t, start: i, end: i, prefix: quote ? "> " : "" }; out.push(para); }
    }
    return out;
  }

  /**
   * The note with the screen's edits in it. `items`: what is on screen now, in order - { b: the block it was
   * drawn from (or null for one added), text, tag }. A block whose words did not change keeps its lines as
   * they are; a changed one is rewritten (its prefix kept); one gone, or emptied, is taken out; an added one
   * comes after the block before it - a list item as one more item, anything else as a paragraph.
   */
  function apply(text, metas, items) {
    const src = String(text || "");
    const nl = src.includes("\r\n") ? "\r\n" : "\n";
    const lines = src.split(/\r?\n/);
    const now = new Map(), added = new Map();
    let lastB = -1;
    for (const it of items) {
      const t = norm(it.text);
      if (it.b != null && metas[it.b] && !now.has(it.b)) { now.set(it.b, t); lastB = it.b; continue; }
      if (!t) continue;
      if (!added.has(lastB)) added.set(lastB, []);
      added.get(lastB).push({ text: t, tag: it.tag });
    }
    const out = [];
    const put = (b) => {
      for (const a of added.get(b) || []) {
        const m = metas[b];
        if (a.tag === "li" && m && m.tag === "li") { out.push(m.prefix.replace(/\[[ xX]\]\s+$/, "") + a.text); continue; }
        if (out.length && out[out.length - 1].trim() !== "") out.push("");
        out.push(a.text);
      }
    };
    const startOf = new Map(metas.map((m, b) => [m.start, b]));
    for (let i = 0; i < lines.length;) {
      const b = startOf.get(i);
      if (b === undefined) { out.push(lines[i]); i++; continue; }
      if (b === 0) put(-1); // added before the first block: just before it, under the front matter
      const m = metas[b];
      const t = now.get(b);
      if (t === undefined || t === "") { /* gone: its lines go too */ }
      else if (t === norm(m.text)) for (let k = m.start; k <= m.end; k++) out.push(lines[k]);
      else out.push(m.prefix + t);
      i = m.end + 1;
      put(b);
    }
    if (!metas.length) put(-1);
    return out.join(nl);
  }

  return { blocks, apply, clean, norm };
})();
