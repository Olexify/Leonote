// The open-source notices that travel with the app: every package the bundle really took in (from esbuild's
// own list of inputs) and every Rust crate of the desktop build (from `cargo metadata`), each with its licence
// and its licence text, after the hand-written notes in THIRD-PARTY-NOTICES.md (fonts, sounds, ported code).
// A build stops rather than ship without the Rust list.
// Written to dist/licenses.txt at each production build; Settings › About shows it.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const LICENSE_FILE = /^(licen[sc]e|copying|notice)([-._].*)?$/i;

/** The licence and notice files in a package's folder, read once each. */
function texts(dir, only = LICENSE_FILE) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => only.test(n)).sort(); } catch { return []; }
  return names.map((n) => { try { return readFileSync(path.join(dir, n), "utf8").trim(); } catch { return ""; } }).filter(Boolean);
}

/** The npm packages an esbuild metafile drew from: name, version, licence, folder. */
function jsPackages(metafile, repo) {
  const seen = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
    if (!m) continue;
    const name = m[1].replace(/\\/g, "/");
    if (seen.has(name)) continue;
    const dir = path.join(repo, "node_modules", name);
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")); } catch { /* no package.json */ }
    seen.set(name, { name, version: pkg.version || "", license: typeof pkg.license === "string" ? pkg.license : (pkg.license && pkg.license.type) || "see its licence", dir });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What build.mjs copies out of pdf.js beside the bundle: each has a licence of its own, in a folder of its own. */
function pdfjsData(repo) {
  const dir = path.join(repo, "node_modules", "pdfjs-dist");
  const { version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  return [
    ["Foxit fonts", "BSD-3-Clause", "standard_fonts", /^LICENSE_FOXIT$/],
    ["Liberation Sans", "GPL-2.0 with font exceptions", "standard_fonts", /^LICENSE_LIBERATION$/],
    ["Adobe CMap resources", "BSD-3-Clause", "cmaps", /^LICENSE$/],
    ["JBIG2 decoder", "BSD-3-Clause", "wasm", /^LICENSE_JBIG2$/],
    ["OpenJPEG decoder", "BSD-2-Clause", "wasm", /^LICENSE_OPENJPEG$/],
  ].map(([name, license, sub, only]) => ({ name, version: `(pdf.js ${version})`, license, dir: path.join(dir, sub), only }));
}

/** The crates the Windows build is made of (the app's own crate left out). */
function rustCrates(tauriDir) {
  const out = execFileSync("cargo", ["metadata", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc", "--locked"], { cwd: tauriDir, maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const meta = JSON.parse(out);
  const inBuild = new Set((meta.resolve && meta.resolve.nodes || []).map((n) => n.id));
  const own = new Set(meta.workspace_members || []);
  return meta.packages.filter((p) => inBuild.has(p.id) && !own.has(p.id))
    .map((p) => ({ name: p.name, version: p.version, license: p.license || (p.license_file ? "see its licence file" : "unstated"), dir: path.dirname(p.manifest_path), authors: p.authors || [], repo: p.repository || "" }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The SPDX ids a licence expression offers ("MIT OR Apache-2.0", "Apache-2.0/MIT"); null when it needs more than one (AND, WITH). */
const spdxIds = (expr) => (/\b(AND|WITH)\b/.test(expr) ? null : String(expr).replace(/[()]/g, "").split(/\s+OR\s+|\//).map((x) => x.trim()).filter(Boolean));
const COPYRIGHT_LINE = /^\s*(copyright\s*(\(c\)|©|\d{4})|\(c\)\s*\d{4}|©)/i;
/**
 * The standard text of each SPDX id, taken from the crates of this very build that carry it alone (no download):
 * the text most of them ship, its copyright lines taken out, since those name other people.
 */
export function standardTexts(crates, read = (p) => texts(p.dir, p.only)) {
  const votes = new Map();
  for (const p of crates) {
    const ids = spdxIds(p.license), t = read(p);
    if (!ids || ids.length !== 1 || t.length !== 1) continue;
    const body = t[0].split(/\r?\n/).filter((l) => !COPYRIGHT_LINE.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const key = ids[0] + "\0" + body.replace(/\s+/g, " ");
    const v = votes.get(key) || { id: ids[0], body, n: 0 };
    v.n++; votes.set(key, v);
  }
  const best = new Map();
  for (const v of votes.values()) if (!best.has(v.id) || v.n > best.get(v.id).n) best.set(v.id, v);
  return new Map([...best].map(([id, v]) => [id, v.body]));
}

export function writeNotices({ metafile, repo, dist }) {
  const crates = rustCrates(path.join(repo, "src-tauri")); // cargo's error, if any, ends the build with its reason
  if (!crates.length) throw new Error("The list of Rust crates came out empty, so the open-source notices would be incomplete.");
  const lines = [];
  const head = path.join(repo, "THIRD-PARTY-NOTICES.md");
  if (existsSync(head)) lines.push(readFileSync(head, "utf8").trim(), "");
  // the same licence text is written once, and named by every package that uses it
  const bodies = new Map();
  // a crate that ships no licence file: its authors (cargo's list, else where its source lives) and the standard text
  // of its licence; a crate with neither stops the build, rather than ship it without its notice
  const std = standardTexts(crates);
  const section = (title, list, rust = false) => {
    lines.push("", "=".repeat(78), title, "=".repeat(78), "");
    for (const p of list) {
      let t = texts(p.dir, p.only), who = "";
      if (!t.length && rust) {
        const id = (spdxIds(p.license) || []).find((x) => std.has(x));
        if (!id) throw new Error(`${p.name} ${p.version} (${p.license}) ships no licence file and no standard text was found for it, so the open-source notices would be incomplete.`);
        t = [std.get(id)];
        who = `  Copyright the ${p.name} authors: ${p.authors.length ? p.authors.join(", ") : p.repo || "see crates.io"} (no licence file in the crate; standard ${id} text)`;
      }
      const keys = t.map((x) => { if (!bodies.has(x)) bodies.set(x, { n: bodies.size + 1, by: [] }); const b = bodies.get(x); b.by.push(`${p.name} ${p.version}`); return `[text ${b.n}]`; });
      lines.push(`${p.name} ${p.version} - ${p.license}${keys.length ? "  " + keys.join(" ") : ""}${who}`);
    }
  };
  section("JavaScript packages in the app", jsPackages(metafile, repo));
  section("Fonts and data of the PDF viewer", pdfjsData(repo));
  section("Rust crates in the desktop app", crates, true);
  lines.push("", "=".repeat(78), "Licence texts", "=".repeat(78));
  for (const [body, b] of bodies) lines.push("", `[text ${b.n}] - used by ${b.by.join(", ")}`, "-".repeat(78), body);
  writeFileSync(path.join(dist, "licenses.txt"), lines.join("\n") + "\n");
  // the licence, the privacy policy (Settings › About) and the agents' rules (Settings › AI agents) travel with the app too, copied from their one source
  for (const [from, to] of [["LICENSE", "licence.txt"], ["docs/store/privacy-policy.md", "privacy.txt"], ["AGENTS.md", "agents.txt"]]) {
    const src = path.join(repo, from);
    if (existsSync(src)) writeFileSync(path.join(dist, to), readFileSync(src, "utf8"));
  }
  return { js: jsPackages(metafile, repo).length, rust: crates.length, texts: bodies.size };
}
