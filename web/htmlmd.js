// Rich text from the clipboard, as Markdown: tables, headings, lists, links,
// code, bold and italic. Anything else is its text.
// ponytail: no nesting inside table cells, no nested lists past two levels; a real converter (turndown) if that ever matters.
const esc = (s) => s.replace(/\s+/g, " ");

function inline(node) {
  if (node.nodeType === 3) return esc(node.textContent);
  if (node.nodeType !== 1) return "";
  const t = node.tagName.toLowerCase();
  const kids = () => [...node.childNodes].map(inline).join("");
  if (t === "br") return " ";
  if (t === "code" || t === "kbd") return "`" + node.textContent.replace(/\s+/g, " ").trim() + "`";
  // Google Docs wraps what is copied in <b style="font-weight:normal">: that is not bold
  if (t === "strong" || t === "b") return /font-weight:\s*(normal|400)\b/i.test(node.getAttribute("style") || "") ? kids() : "**" + kids().trim() + "**";
  if (t === "em" || t === "i") return "*" + kids().trim() + "*";
  if (t === "s" || t === "del") return "~~" + kids().trim() + "~~";
  if (t === "a" && node.getAttribute("href")) { const label = kids().trim(); const href = node.getAttribute("href"); return label === href ? href : `[${label}](${href})`; }
  if (t === "img") return node.getAttribute("src") ? `![${node.getAttribute("alt") || ""}](${node.getAttribute("src")})` : "";
  return kids();
}

function block(node, depth = 0) {
  if (node.nodeType === 3) return esc(node.textContent);
  if (node.nodeType !== 1) return "";
  const t = node.tagName.toLowerCase();
  const kids = () => [...node.childNodes].map((n) => block(n, depth)).join("");
  if (/^h[1-6]$/.test(t)) return `\n${"#".repeat(+t[1])} ${inline(node).trim()}\n\n`;
  if (t === "p" || t === "div" || t === "section" || t === "article") return "\n" + kids().trim() + "\n";
  if (t === "pre") return "\n```\n" + node.textContent.replace(/\n$/, "") + "\n```\n\n";
  if (t === "blockquote") return "\n" + kids().trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
  if (t === "hr") return "\n---\n\n";
  if (t === "ul" || t === "ol") {
    let i = 0;
    return "\n" + [...node.children].filter((c) => c.tagName.toLowerCase() === "li").map((li) => {
      const mark = t === "ol" ? `${++i}. ` : "- ";
      const own = [...li.childNodes].filter((n) => !/^(ul|ol)$/i.test(n.tagName || "")).map(inline).join("").trim();
      const sub = [...li.children].filter((c) => /^(ul|ol)$/i.test(c.tagName)).map((c) => block(c, depth + 1)).join("");
      return "  ".repeat(depth) + mark + own + (sub ? "\n" + sub.replace(/^\n|\n+$/g, "") : "");
    }).join("\n") + (depth ? "\n" : "\n\n");
  }
  if (t === "table") {
    const rows = [...node.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r) => "| " + Array.from({ length: w }, (_, i) => r[i] || "").join(" | ") + " |";
    return "\n" + [line(rows[0]), "|" + " --- |".repeat(w), ...rows.slice(1).map(line)].join("\n") + "\n\n";
  }
  if (t === "script" || t === "style") return "";
  if (t === "br") return "\n";
  // inline marks, unless they wrap whole blocks (Google Docs puts everything in one <b>: kept as its headings,
  // lists and paragraphs, not one bold line)
  if (["strong", "b", "em", "i", "a", "code", "kbd", "s", "del", "img", "span"].includes(t) && !node.querySelector("p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,table,pre,blockquote")) return inline(node);
  return kids();
}

/** Code from a code editor (VS Code, JetBrains, a terminal): a <pre> or text in a fixed-width font, and nothing
    of a document's structure - its plain text keeps the lines the HTML loses. */
export const isCode = (html) => /<pre[\s>]|white-space:\s*pre|font-family:[^;"]*(mono|consolas|courier|menlo)/i.test(html || "") && !/<(table|h[1-6]|ul|ol|blockquote|p)[\s>]/i.test(html || ""); // (paragraphs with a bit of inline code: text)

/** A code block's language, guessed from the code itself ("" when it says nothing clear). */
export function guessLang(code) {
  const s = code.trim();
  if (/^[[{]/.test(s)) { try { JSON.parse(s); return "json"; } catch { /* not JSON */ } }
  if (/^<(!doctype|html|div|span|p|head|body|template|svg)\b/i.test(s)) return "html";
  if (/^(select|insert|update|delete|create|alter|with)\s/i.test(s)) return "sql";
  if (/^(#!.*\b(ba)?sh|\$ |(sudo|npm|npx|git|cd|echo|curl|pip|cargo) )/m.test(s)) return "bash";
  if (/\bfn \w+\s*[(<]|\blet mut\b|\bimpl\b|\bpub (fn|struct|enum)\b|::\w+/.test(s)) return "rust";
  if (/^\s*(def |class \w+.*:\s*$|from \w[\w.]* import |import \w+$|if __name__)/m.test(s)) return "python";
  if (/^\s*(package |public (class|static)|import java\.)/m.test(s)) return "java";
  if (/^\s*(interface |type \w+ =|export (type|interface) )|: (string|number|boolean)\b/m.test(s)) return "ts";
  if (/^\s*(const|let|var|function|import|export|async) |=>/m.test(s)) return "js";
  if (/^[.#@]?[\w-][\w\s.#:>,-]*\{[^}]*:[^}]*;/m.test(s)) return "css";
  const lines = s.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l));
  if (lines.length && lines.filter((l) => /^\s*(- )?[\w.-]+:(\s|$)|^\s*- /.test(l)).length / lines.length > 0.7) return "yaml";
  return "";
}

/** True when the HTML carries structure worth keeping over its plain text. */
export const isRich = (html) => /<(table|h[1-6]|ul|ol|pre|blockquote|a\s|strong|b>|em>|code)/i.test(html || "");

/** HTML → Markdown. */
export function htmlToMd(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return block(doc.body).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
