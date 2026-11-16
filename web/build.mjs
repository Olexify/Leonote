// Frontend build. One esbuild pass, ~50 ms, no framework runtime.
//
//   node web/build.mjs            production bundle into dist/
//   node web/build.mjs --serve    rebuild on change + static server with the
//                                 in-browser mock backend (no Tauri needed)
// LEONOTE_DIST: another folder than dist/ (the tests).

import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeNotices } from "./notices.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.LEONOTE_DIST || path.join(root, "..", "dist");
const serve = process.argv.includes("--serve");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(path.join(root, "index.html"), path.join(dist, "index.html"));
cpSync(path.join(root, "mini.html"), path.join(dist, "mini.html")); // the always-on-top mini player's own window
cpSync(path.join(root, "mini.js"), path.join(dist, "mini.js"));
cpSync(path.join(root, "ytmini.html"), path.join(dist, "ytmini.html"));
cpSync(path.join(root, "breakpop.html"), path.join(dist, "breakpop.html")); // a break on the desktop while Leonote is out of sight
cpSync(path.join(root, "breakpop.js"), path.join(dist, "breakpop.js")); // an online video's own window while Leonote is out of sight
cpSync(path.join(root, "viewer.html"), path.join(dist, "viewer.html")); // the picture and video viewer's own window
cpSync(path.join(root, "viewer.js"), path.join(dist, "viewer.js"));
cpSync(path.join(root, "script.html"), path.join(dist, "script.html")); // the script window: a note to read while recording
cpSync(path.join(root, "script.js"), path.join(dist, "script.js"));
cpSync(path.join(root, "scriptmap.js"), path.join(dist, "scriptmap.js"));
cpSync(path.join(root, "dvframe.js"), path.join(dist, "dvframe.js")); // what a Dataview block's sandboxed frame runs
cpSync(path.join(root, "pluginframe.js"), path.join(dist, "pluginframe.js")); // what a plugin's sandboxed frame runs
cpSync(path.join(root, "sounds"), path.join(dist, "sounds"), { recursive: true });
cpSync(path.join(root, "voice"), path.join(dist, "voice"), { recursive: true }); // the breaks' spoken lines (ElevenLabs, "Leonote Friend"), ~130 KB
cpSync(path.join(root, "pay"), path.join(dist, "pay"), { recursive: true }); // the QR codes of the donation picker

// pdf.js parses in a worker, which has to be its own file rather than part of
// the bundle. The shipped build is already self-contained ESM, so it is copied
// straight across; `cmaps` and `standard_fonts` are the data it asks for when
// a PDF leans on CJK encodings or the base-14 fonts it does not embed.
const pdfjs = path.join(root, "..", "node_modules", "pdfjs-dist");
cpSync(path.join(pdfjs, "build", "pdf.worker.min.mjs"), path.join(dist, "pdf.worker.mjs"));
cpSync(path.join(pdfjs, "cmaps"), path.join(dist, "cmaps"), { recursive: true });
cpSync(path.join(pdfjs, "standard_fonts"), path.join(dist, "standard_fonts"), { recursive: true });
// scanned pages (JBIG2, JPEG 2000) are decoded by these two: the plain-script versions, because the app's CSP has no WebAssembly
mkdirSync(path.join(dist, "pdfdecoders"), { recursive: true });
for (const f of ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js", "LICENSE_JBIG2", "LICENSE_OPENJPEG"]) cpSync(path.join(pdfjs, "wasm", f), path.join(dist, "pdfdecoders", f));

const options = {
  entryPoints: {
    app: path.join(root, "main.js"),
    style: path.join(root, "styles", "app.css"),
    mock: path.join(root, "mock.js"),
    ytmini: path.join(root, "ytmini.js"), // the online video's own small window
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  // heavy editors (Excel, Word, code languages) load only when first needed
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  target: ["chrome110"],
  minify: !serve,
  sourcemap: serve ? "inline" : false,
  legalComments: "none",
  loader: { ".woff2": "file", ".woff": "file" },
  assetNames: "fonts/[name]-[hash]",
  logLevel: "info",
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: 5178 });
  console.log(`serving http://localhost:${port}`);
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  // the open-source notices travel with the app (Settings › About › Open-source licences)
  const n = writeNotices({ metafile: result.metafile, repo: path.join(root, ".."), dist });
  console.log(`licenses.txt: ${n.js} JavaScript packages, ${n.rust} Rust crates, ${n.texts} licence texts`);
}
