// Which pane's copy of a note gets written.
//
// A note can be open in the main pane and the split at the same time, and each
// pane keeps its own CodeMirror state. When the save timer fires, exactly one
// of them is the truth and the other is about to be overwritten with it - so
// getting this wrong does not produce a merge conflict, it silently throws
// away whatever was just typed.
//
// Its own file because it is the one decision in the save path that is pure,
// and therefore the one that can be pinned down by a test.

/**
 * @param {Array} editors  panes that hold `path` at all (editor.has(path))
 * @param {string} path
 * @param {object|undefined} typed  the pane that last changed THIS note
 * @returns the pane whose text should be written, or undefined if none holds it
 *
 * Last-typed wins, ahead of focus. Focus is where the caret is now, which says
 * nothing about where the newest text is: type in the split, click into the
 * main pane, and the focused pane's older copy would be saved and then pushed
 * back over the split - the edit gone from both the file and the screen.
 */
export function pickWriter(editors, path, typed) {
  const eds = editors.filter(Boolean);
  if (typed && eds.includes(typed)) return typed;
  return eds.find((x) => x.path === path && x.hasFocus()) || eds[0];
}
