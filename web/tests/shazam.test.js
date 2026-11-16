import test from "node:test";
import assert from "node:assert/strict";
import { shazamTracks } from "../matchtracks.js";
import { parseCsv } from "../officeview.js";

test("Shazam's CSV and a plain list both give each song once", () => {
  const csv = 'Shazam Library\nIndex,TagTime,Title,Artist,URL,TrackKey\n1,2026-10-01,Get Lucky,Daft Punk,https://www.shazam.com/track/1,1\n2,2026-09-30,"Hello, Goodbye",The Beatles,https://www.shazam.com/track/2,2\n3,2026-09-29,Get Lucky,Daft Punk,https://www.shazam.com/track/1,1\n';
  assert.deepEqual(shazamTracks(csv, parseCsv(csv)), [
    { title: "Get Lucky", artists: ["Daft Punk"], url: "https://www.shazam.com/track/1" },
    { title: "Hello, Goodbye", artists: ["The Beatles"], url: "https://www.shazam.com/track/2" },
  ]);
  const list = "1. Daft Punk - Get Lucky\nRadiohead – Creep\nnot a song";
  assert.deepEqual(shazamTracks(list, parseCsv(list)).map((t) => `${t.artists[0]}|${t.title}`), ["Daft Punk|Get Lucky", "Radiohead|Creep"]);
});
