# Third-party notices

Leonote includes the following open-source components. Each is used under
its own licence. The complete list - every JavaScript package the bundle takes
in, every Rust crate of the desktop build and the PDF viewer's fonts and data,
each with its licence text - is
generated at every build (`web/notices.mjs`, into `licenses.txt`) and ships
inside the app: Settings › About › Open-source licences.

Dual-licensed components are used under their permissive option (JSZip: MIT;
self_cell: Apache-2.0). Five MPL-2.0 crates come with Tauri (cssparser,
cssparser-macros, dtoa-short, selectors, option-ext); they are used unmodified,
and their source is available from crates.io.

## Frontend

| Component | Licence |
|---|---|
| CodeMirror 6 (`@codemirror/*`, `@lezer/*`) | MIT |
| `@codemirror/language-data` and the language packages it loads | MIT |
| JSZip | MIT (dual-licensed MIT or GPL-3.0; used under MIT) |
| ExcelJS | MIT |
| rough.js (hand-drawn shapes in sketches), Copyright (c) 2019 Preet Shihn | MIT |
| perfect-freehand (pen strokes in sketches), Copyright (c) 2021 Stephen Ruiz Ltd | MIT |
| pdf.js (`pdfjs-dist`, PDF rendering; the worker, cmaps and standard fonts are shipped in `dist/`), Copyright Mozilla Foundation | Apache-2.0 |
| Foxit fonts (stand-ins for the standard PDF fonts a file does not embed, in pdf.js's `standard_fonts`), Copyright 2014 PDFium Authors | BSD-3-Clause |
| Liberation Sans (the same use, in pdf.js's `standard_fonts`), Copyright 2007-2011 Red Hat, Inc. | GPL-2.0 with font exceptions, under Red Hat's agreement. This is version 1.07.4; its source is at https://packages.debian.org/source/bookworm/fonts-liberation (`fonts-liberation_1.07.4.orig.tar.gz`), or write to the address in LICENSE for a copy |
| Adobe CMap resources (character tables for East Asian PDFs, in pdf.js's `cmaps`), Copyright 1990-2009 Adobe Systems Incorporated | BSD-3-Clause |
| JBIG2 and OpenJPEG image decoders in pdf.js (scanned pages; shipped with their licence texts in `dist/pdfdecoders/`), Copyright The PDFium Authors, and the OpenJPEG authors | BSD |
| pdf-lib (writing PDFs: page order, annotations, form filling), Copyright (c) 2019 Andrew Dillon | MIT |
| Excalidraw (file format, arrow binding, text layout and dark-mode colour maths ported into `web/sketchmodel.js` and `web/sketchrender.js`, pen settings in `web/sketchbrush.js`; sketches are saved as Excalidraw-compatible files), Copyright (c) 2020 Excalidraw | MIT |
| Feather icons (some of the interface's icons are drawn after Feather's, in `web/icons.js`), Copyright (c) 2013-2023 Cole Bemis, https://feathericons.com | MIT |
| Inter (`@fontsource-variable/inter`) | SIL Open Font License 1.1 |
| JetBrains Mono (`@fontsource-variable/jetbrains-mono`) | SIL Open Font License 1.1 |
| esbuild (build tool, not shipped) | MIT |

## Desktop shell (Rust)

| Component | Licence |
|---|---|
| Tauri and its official plugins | MIT or Apache-2.0 |
| wry, tao, webview2-com, windows-rs | MIT or Apache-2.0 |
| serde, serde_json, indexmap, chrono | MIT or Apache-2.0 |
| notify | CC0-1.0 / MIT / Apache-2.0 |
| filetime | MIT or Apache-2.0 |
| age (backup encryption), zip | MIT or Apache-2.0 / MIT |

## Other assets

| Asset | Status |
|---|---|
| Sounds in `web/sounds/` | From Pixabay, under the Pixabay Content License (free use, commercial included; no attribution required; not to be sold or handed out on their own). The ticks (`clockticksound1-16.wav`) are cut from "Ticking clock" (https://pixabay.com/sound-effects/household-ticking-clock-1-27477/); the work and break signals (`workstart.wav`, `breakstart.wav`) from "Level up" (https://pixabay.com/sound-effects/film-special-effects-level-up-523624/) and "Bell ringing" (https://pixabay.com/sound-effects/film-special-effects-bell-ringing-43862/). |
| Spoken lines in `web/voice/` | Made for Leonote with ElevenLabs ("Leonote Friend", a voice designed for Leonote, generated on a paid Creator plan, which allows commercial use), recorded once and kept as small Opus files. |
| Leo, the mascot | Original Leonote artwork. |
| App icon | Original Leonote artwork. |

Microsoft Edge WebView2 Runtime is provided by Microsoft under its own terms
and is not redistributed by Leonote.

## Excalidraw (MIT)

MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Feather (MIT)

The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
