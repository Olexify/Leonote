// Imported YouTube playlists kept up with YouTube. New videos come in on
// Refresh, or by themselves once a day for a playlist told to (off by default:
// a playlist trimmed here is yours). A video that left the list on YouTube
// leaves here only when that playlist is told to (off by default) - and never
// one YouTube lost: a video its maker deleted drops out of the list too, and
// Leonote keeps it (its name and picture) as gone rather than following.
// What you took out here is not brought back by the next read.
import { mergeYtList, ytKey, isYt, ytIdOf } from "./playqueue.js";
import { ytTitle } from "./youtube.js";
import { readYtList } from "./sources.js";

const DAY = 86400000;

/** One playlist brought up to date: { added, dropped, kept, skipped }. */
export async function syncYtList(app, M, pl) {
  const r = await readYtList(app, pl.ytList);
  const got = (r.items || []).filter((x) => x && x.id);
  if (!got.length) throw new Error("YouTube listed no videos for it");
  const fresh = M.playlists.all().find((p) => p.id === pl.id) || pl;
  const listed = new Set(got.map((x) => ytKey(x.id)));
  // what was added here is not YouTube's to take away
  const mine = new Set(fresh.ytMine || []);
  const missing = fresh.items.filter((k) => isYt(k) && !listed.has(k) && !mine.has(k));
  const drop = new Set();
  let skipped = false;
  if (fresh.ytPrune && missing.length) {
    // a list read short (a page that failed, YouTube changing shape) must not empty the playlist
    if (r.truncated || missing.length > Math.max(25, fresh.items.length * 0.2)) skipped = true;
    else for (const k of missing) {
      const t = await ytTitle(ytIdOf(k));
      if (!t) continue; // no answer: kept, asked again next time
      if (t.gone) M.online.mark(k, { gone: true, checkedAt: Date.now() });
      // a video made private and one that plays only on YouTube look alike: kept, not taken out
      else if (t.webOnly) continue;
      else drop.add(k); // still on YouTube, only not in the list: taken out there
    }
  }
  const skip = new Set(fresh.ytSkip || []);
  M.online.addMany(got.filter((x) => !skip.has(ytKey(x.id))).map((x) => ({ id: x.id, title: x.title, secs: x.secs })));
  const m = mergeYtList(fresh.items, got.map((x) => ytKey(x.id)), drop, skip);
  // new videos at the top (unless the playlist is told to follow YouTube's places): the newest first -
  // a YouTube playlist grows at its end, so the last listed is the latest added
  if (m.added.length && fresh.ytNewTop !== false) {
    const nw = new Set(m.added);
    m.items = [...[...m.added].reverse(), ...m.items.filter((k) => !nw.has(k))];
  }
  const stillMine = [...mine].filter((k) => !listed.has(k));
  // nothing new, nothing gone: the videos already here are left as they are, only the time of the read is kept
  if (!m.added.length && !drop.size && stillMine.length === mine.size) M.playlists.patch(pl.id, { ytFetched: Date.now() });
  else M.playlists.set(pl.id, m.items, { ytFetched: Date.now(), ytMine: stillMine }, true);
  // a copy of each new one, for the playlists told to keep them
  // a playlist backed up keeps its own folder, format and quality
  // a video that came only with this playlist goes with it
  if (drop.size) {
    const others = new Set(M.playlists.all().filter((p) => p.id !== pl.id).flatMap((p) => p.items));
    const own = [...drop].filter((k) => !others.has(k) && !(M.online.entry(k) || {}).loose);
    if (own.length) M.online.remove(own);
  }
  return { added: m.added.length, dropped: drop.size, kept: missing.length - drop.size, skipped };
}

/** What one read did, in a line. */
export function syncSaid(name, s, loud = false) {
  const parts = [];
  if (s.added) parts.push(`${s.added} new from YouTube`);
  if (s.dropped) parts.push(`${s.dropped} taken out, as on YouTube`);
  // said plainly and without guessing why (deleted, made private, taken out of the list): gone from the online list, still here
  if (loud && s.kept) parts.push(`${s.kept} ${s.kept === 1 ? "video was" : "videos were"} removed from the online playlist - still here`);
  if (loud && s.skipped) parts.push("none taken out: YouTube listed it much shorter than before, which looks like a failed read");
  return parts.length ? `“${name}”: ${parts.join(" · ")}` : `“${name}” is up to date`;
}

/** The daily round: two minutes after start, then every three hours, each playlist that keeps up and was not read today. */
export function startYtSync(app, M) {
  let busy = false;
  const round = async () => {
    if (busy) return;
    busy = true;
    // what the whole round did, said once at its end - in the app and as a Windows notification
    const said = [];
    let added = 0, dropped = 0;
    try {
      await (M.batch || ((f) => f()))(async () => { for (const pl of M.playlists.all()) {
        if (!pl.ytList || pl.ytSync !== true || Date.now() - (pl.ytFetched || 0) < DAY) continue;
        try {
          const s = await syncYtList(app, M, pl);
          if (pl.ytSyncError) M.playlists.patch(pl.id, { ytSyncError: "", ytSyncFailing: 0, ytSyncSaid: 0 });
          if (s.added || s.dropped) { said.push(syncSaid(pl.name, s)); added += s.added; dropped += s.dropped; }
        } catch (e) {
          // tried again next round - and remembered on the playlist, said once a day's worth of rounds has failed
          // (a sign-in ended, the allowance used up, a playlist gone private: it stopped updating with nobody told)
          const msg = String((e && e.message) || e).slice(0, 200);
          const since = pl.ytSyncFailing || Date.now();
          M.playlists.patch(pl.id, { ytSyncError: msg, ytSyncFailing: since });
          if (!pl.ytSyncSaid && Date.now() - since > 20 * 3600000) { said.push(`${pl.name}: not updated since ${new Date(since).toLocaleDateString()} - ${msg}`); M.playlists.patch(pl.id, { ytSyncSaid: 1 }); }
        }
      } });
    } finally { busy = false; }
    if (!said.length) return;
    app.toast(said.join("\n"), { ms: 8000 });
    const head = [added ? `${added} new video${added === 1 ? "" : "s"}` : "", dropped ? `${dropped} taken out` : ""].filter(Boolean).join(" · ");
    if (app.host.osNotify && app.settings.ytNotify !== false) app.host.osNotify(`YouTube playlists: ${head}`, said.join("\n").replace(/[“”]/g, "")).catch(() => {});
  };
  setTimeout(round, 120000);
  setInterval(round, 3 * 3600000);
}
