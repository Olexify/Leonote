# Writing a plugin for Leonote

A plugin is a folder with a `plugin.json` and one script. It runs in a sandboxed frame of its own: no same origin, no
`fetch`, no access to Leonote's page. It reaches Leonote only through the small `leonote` object below, and each call
is checked against what the user allowed. Look at `example/`, a word count panel with a command.

The frame is not a hard wall to the internet: the engine still lets a page look up names and open connections, so a
plugin may be able to send out what it can read even without a `net:` permission. Every install dialog says so, and
tells the user to install only what they trust. `net:` is the supported way to talk to a server - checked, and named
in the dialog - not the only one a determined plugin could find.

## plugin.json

```json
{
  "id": "word-count",
  "name": "Word count",
  "version": "1.0.0",
  "author": "Your name",
  "description": "What it does, in one or two plain sentences.",
  "main": "main.js",
  "permissions": ["commands", "panel", "notes.read"]
}
```

- `id`: lower case letters, digits, `-` and `.`.
- `version`: numbers with dots.
- `main`: a `.js` file in the folder. Leonote loads this one script, so bundle your code into it.
- `permissions`: ask only for what you use. Asking for more later makes Leonote ask the user again.

| Permission | The user reads | Calls |
|---|---|---|
| `commands` | Add commands to the Ctrl+P list | `leonote.commands.add(id, name, run)` |
| `panel` | Show a side panel. What you type in it, after clicking on it, goes to the plugin | `leonote.panel.show()`, `leonote.panel.hide()` |
| `notes.read` | Read your notes, except private ones, and it may be able to send out what it reads | `leonote.notes.list()`, `leonote.notes.read(path)` |
| `notes.write` | Change your notes, except private ones | `leonote.notes.write(path, text, why)`, `leonote.notes.append(path, text, why)` |
| `net:api.example.com` | Connect to api.example.com over the internet, and send it anything the plugin can read | `leonote.net.fetch(url)` |

Nothing else exists: no other files, no programs, no passwords, no settings, no tasks. Messages from other frames
never reach your script: plugins get no way to message each other (the frames are not sealed against every side
channel, so a review still looks at what two plugins of one author could do together). `document.open`, `write` and
`writeln` throw: they would remove that guard.

## The API

Every call returns a promise, and rejects with a plain message if it is refused.

- `commands.add(id, name, run)`: adds a row to Ctrl+P, shown with your plugin's name. At most 20.
- `panel.show()`, `panel.hide()`: your frame's page is the panel. Build it with ordinary DOM calls. The first click
  wakes the panel, and the next ones reach your page; a click anywhere else puts it back to sleep. Until then it gets
  no clicks, scrolling or keys. Do not call `focus()` or use `autofocus` while asleep: a plugin that takes the keyboard
  without a click, with its panel shown or not, is stopped and turned off. Listen for the `focus` event on `window` and focus your input then.
- `notes.list()`: `[{ path, mtime }]`, without private notes.
- `notes.read(path)`: the note's text. A private note answers "No such note".
- `notes.write(path, text, why)`, `notes.append(path, text, why)`: `why` is one line for the user. They answer
  `"written"` or `"proposed"`. A note follows its AI access, as agents do: review makes a proposal the user accepts or
  rejects (do not repeat it), open is written at once. A plugin goes by the folders' settings even when the user gave
  their AI full access: full access is for AI, not for plugins. A change that adds a web address is always a proposal. A private
  note takes nothing and answers as a note that is not there would, so a plugin cannot find out what is private.
- `net.fetch(url)`: a GET, `{ status, text }`, up to 2 MB. https only, on a host you listed, redirects included.
  Leonote makes the request itself and refuses this computer and the home network. List exact host names; no
  wildcards, addresses or ports.

Pictures in your page must be `data:` or `blob:` addresses. Colours: `var(--text-normal)`, `var(--text-muted)`,
`var(--text-accent)`, `var(--background-primary)`, `var(--background-modifier-border)`.

## Limits

- 30 note writes and 60 fetches a minute (4 fetches at once), 20 MB written a minute, 20 proposals an hour. Past a
  limit the call fails with a message; it does not wait.
- Your code is fingerprinted when it is installed. If its files change outside Leonote, the plugin is turned off
  until the user turns it on again. An update keeps a plugin that was off, off, and names any new permission.
- Removing a plugin drops the edits it proposed that the user has not reviewed yet.

## Trying it

Settings › Plugins › Install from a folder. Leonote copies the folder to `~/.leonote/plugins/<id>`; a change means
installing it again. A plugin may not be placed there by hand: it will not run.

## Publishing it

Plugins for the list are free and live on GitHub. See `LIST-RULES.md`. To say what your plugin is for, you may write
"a plugin for Leonote". LICENSE section 2B says what else you may and may not do.
