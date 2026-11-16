// Site icons for the browser's tabs: one small copy per site - a 32 px PNG as a
// data URL, a few hundred bytes - kept in this app's own storage and shared by
// every tab of that site (one YouTube icon, however many YouTube tabs). They come
// from WebView2 itself as a page loads, so nothing is fetched twice.

const KEY = "leo:favicons";
const MAX = 400; // sites; the least recently seen go first
let map = null;

const load = () => {
  if (map) return map;
  try { map = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { map = {}; }
  return map;
};
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {} };

export const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** The site's icon as a data URL, or null. */
export function faviconOf(url) {
  const e = load()[siteOf(url)];
  return e ? e.d : null;
}

/** Keep a site's icon (PNG bytes as base64), made small. Resolves true when it changed. */
export function keepFavicon(url, pngB64) {
  const site = siteOf(url);
  if (!site || !pngB64) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        c.getContext("2d").drawImage(img, 0, 0, 32, 32);
        const d = c.toDataURL("image/png");
        const m = load();
        const same = m[site] && m[site].d === d;
        m[site] = { d, at: Date.now() };
        const sites = Object.keys(m);
        if (sites.length > MAX) for (const s of sites.sort((a, b) => m[a].at - m[b].at).slice(0, sites.length - MAX)) delete m[s];
        save();
        resolve(!same);
      } catch { resolve(false); }
    };
    img.onerror = () => resolve(false);
    img.src = "data:image/png;base64," + pngB64;
  });
}
