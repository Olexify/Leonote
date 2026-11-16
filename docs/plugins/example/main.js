// A plugin for Leonote: a panel with the words in your notes, and a Ctrl+P command that opens it.
// `leonote` is all a plugin gets. See docs/plugins/PLUGINS.md.
const out = document.createElement("div");
out.style.padding = "12px";
document.body.append(out);

async function count() {
  out.textContent = "Counting…";
  const notes = await leonote.notes.list();
  let words = 0;
  for (const n of notes) words += (await leonote.notes.read(n.path)).split(/\s+/).filter(Boolean).length;
  out.textContent = `${words} words in ${notes.length} notes (private ones not counted).`;
}

leonote.commands.add("show", "Show word count", () => {
  leonote.panel.show();
  count();
});
