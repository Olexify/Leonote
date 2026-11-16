# Leonote — agent contract

You are reading this because you want to read or change someone's notes or
tasks. This file is the whole contract. It is deliberately short.

## Or use the tools

If you speak the Model Context Protocol, you do not have to touch the files
yourself: start `leonote-rs.exe --mcp` (stdio, no window) and you get
`list_notes`, `search_notes`, `read_note`, `write_note`, `append_to_note`,
`list_tasks`, `add_task` and `complete_task` - and `jev_ask`, fast typed
decisions from TypeSafe's Jev through the user's own key (set in Settings › Jev),
or from Laya on the user's own computer if they chose it - and `video_overview`,
`video_edit` and `video_check` for a video project (`.leovideo`): what is said in it
word by word, each word with an id, and edits anchored on those ids (cut, shorten a
pause, captions, lay a file over, set, remove) that Leonote lands in measured pauses.
They follow every rule below for
you - whole-file writes by rename, the previous text of a replaced note kept in
`.trash`, tasks appended to their own log (`mcp.jsonl`; `mcp-2.jsonl` for a second session running at once), the snapshot never
written. The Assistant view in the app shows the exact command to copy.

## What you may touch

Each note has an AI access: an `ai: private | review | open` line in its front
matter, else its folder's (the user sets it in the tree), else the default
(review). The MCP tools follow it for you: private notes are not listed,
searched, read or written; in review, `write_note` and `append_to_note` make a
proposal the user accepts or rejects in the app - the answer starts with
"Proposed", and repeating it only makes a second proposal. If you write files
directly instead, leave private notes alone and do not read them: the user has
asked for that.

With `"full": true` in `~/.leonote/ai-access.json` the user has given AI full
access: every note is open (written at once, no proposals) whatever its folder
says - except a note whose own front matter says `ai: private`.

## Skills

A skill is a note with `type: skill` in its front matter (`name`,
`description`, `trigger: manual | daily HH:MM | new note in <folder>`,
`inputs: a, b`, `mode: review`) and numbered steps, one action each:
`note.read|append|write|create|tag|move`, `tasks.add|list`, `search`,
`jev.choice|yes`, `set`, `notify`, `open`, `stop` - `key=value` arguments,
`{{today}}`, `{{input.x}}`, `{{name}}` filled in, `→ name` keeps the output,
`if="{{x}} == yes"` makes a step conditional. `Skills/` holds them; a new one
from Leonote (Ctrl+P › New skill) lists every action. The app runs them, and
their writes follow the notes' AI access like yours do. A skill with a `daily` or
`new note` trigger runs on its own only after the user allows it once on each computer (and again after
any change to it). You may write skills
for the user; they are notes, so in review they arrive as proposals.

## Workspaces

A workspace is a folder with one brief note in it: `type: workspace` (or the
older `type: project`) in its front matter, with `goal`, `due`, `status` and
`tags: [a, b]`. Everything under the folder belongs to it, and so does any note
elsewhere tagged `#a` (or `#a/...`). A task is the workspace's when its text
carries the tag or links one of its notes. Read the brief first when asked about
a workspace; the app's Workspace room (Alt+R) shows the whole of it. A brief
with `outside: <absolute path>` also covers that folder outside the vault; its
files are the user's, so leave them alone unless asked.

## Notes

Notes are plain Markdown files in the vault, `~/LeoNote` by default (the path
is `vault` in `~/.leonote/app.json` if the user moved it). Read and write them
like any file; the app picks up every change within milliseconds and shows it
live, highlighting what changed.

- Write whole files. Prefer write-to-temp-then-rename so the app never reads a
  half-written note.
- `[[Note name]]` links to `Note name.md` anywhere in the vault;
  `[[Folder/Note]]` is explicit. `#tag` tags. `- [ ]` / `- [x]` checkboxes.
- Daily notes: by default one note a year, `Diary/YYYY.md`, with a
  `# DD.MM.YYYY` heading for each day; the user can switch to one note a day
  (`Diary/YYYY-MM-DD.md`) in Settings. Look in the vault to see which.
- Deleting a file deletes the note. The app moves what is deleted to
  `<vault>/.trash/` as `YYYY-MM-DD HHMMSS <name>` (hard-deleting only when the
  user explicitly asks it to). Do the same unless the user asked otherwise.
  The trash is not an archive: the app deletes entries older than the time set
  in Settings › Trash (30 days by default), going by the stamp in the name.
- Paths starting with `.` (`.trash`, `.git`, `.leonote`) are ignored.

## Tasks

### Yours and the user's

A task with `"owner": "ai"` was given to AI; anything else is the user's own.
When `~/.leonote/ai-access.json` has `"tasks": "split"`, the user keeps their
own tasks apart: read and change only tasks with `owner: "ai"`, and leave every
other task alone - do not even list them back to the user. A task you add
carries `"owner": "ai"` either way (the MCP tools do all of this for you).
A task with `"ai_from"` (milliseconds since 1970) later than now has been
given to AI but not handed over yet - the user can still take it back; treat
it as the user's until that moment.

### Working through AI's tasks

Over MCP: `next_task` hands you the most pressing one (high priority, then
nearest due) and marks it taken; finish with `complete_task` and a short
`result` (what you did, where it is), or `give_back_task` with `why` when it
needs the user. By hand, the same in your log: take it with
`"ai_status":"working","ai_started":<ms>,"ai_by":"<you>"` (a claim older than
two hours is stale and may be taken again); finish with `"done":true,
"ai_status":"done","ai_result":"..."`; give it back with `"owner":"human",
"ai_status":"returned","ai_result":"<why>"`. The user sees all three on the task.

## Where things live

```
~/.leonote_tasks.json     THE SNAPSHOT. A JSON array of task objects.
                          Read this to see current state. DO NOT WRITE IT.
~/.leonote/log/<you>.jsonl   YOUR log. Append here. One file per writer.
~/.leonote/quarantine.jsonl  lines nobody could parse, kept verbatim
```

Current state = the snapshot, with every log applied on top.

**Pick your own log filename and use only that one.** `hermes.jsonl`,
`claude-w3.jsonl`, `codex.jsonl`. One writer per file is what makes concurrent
edits safe: a half-written line can only ever damage your own tail, never
somebody else's already-committed work. If you append to a file another process
is also appending to, you have thrown that guarantee away.

## Reading

1. Parse `~/.leonote_tasks.json` — a JSON array of objects.
2. For each `~/.leonote/log/*.jsonl`, in filename order, read every complete
   line (ignore anything after the last `\n` — it may be mid-write).
3. Sort all log events by `t`, then filename, then line number.
4. Apply each event onto the task with the same `id`, field by field.

If you only need to *read*, parsing the snapshot alone is usually enough — but
it will be missing anything written since the last compaction. Fold the logs if
you need to be exactly right.

## Writing

Append one line per change. Never rewrite the snapshot. Never truncate a log.

```jsonl
{"id":"9f1c2a44-...","done":true,"t":"2026-09-07T18:10:00.418","by":"hermes"}
```

A line is one compact JSON **object**, UTF-8, terminated by `\n`.

| key | required | meaning |
|---|---|---|
| `id` | **yes** | the task's uuid, exactly as it appears in the snapshot |
| `t` | **yes** | local-naive time, `YYYY-MM-DDTHH:MM:SS.mmm`. NOT UTC. |
| `by` | yes, please | who you are — this is the attribution the UI shows |
| `op` | no | `set` (default), `snapshot`, or `header` |

Every **other** key is task data and is written literally onto the task.

### Rules that will bite you if you skip them

- **`t` is local time, not UTC.** The app and its 24-hour done/archive split
  read these as the same wall clock. A UTC stamp is silently 2–3 hours wrong.
- **`null` means the value null. It does NOT delete a key.** To remove a key:
  `{"id":"...","$unset":["due_date"],"t":"..."}`
- **Arrays replace wholesale.** `subtasks` is never merged element-by-element.
  To tick one subtask, send the entire `subtasks` array with your change in it.
- **A `set` on an id that does not exist creates the task.** There is no
  separate create op. Include at least `text`.
- **Completing is not deleting.** Set `done:true` (and `completed_at`). To
  trash something set `deleted:true`. Nothing is ever removed from the file.
- **Do not reorder the snapshot.** Position is real state. To move a task, set
  its `ord` (a float): smaller sorts earlier, and the midpoint of two
  neighbours drops it between them.
- **One line per change, always newline-terminated.** Do not pretty-print.

### Editing a line you already wrote

Allowed. The reader folds whatever bytes are currently on disk and never
assumes the log is immutable history, so correcting your own line in place
works. Appending a newer line is still preferred — it keeps the history.

## Common operations

```jsonl
# complete a task
{"id":"abc","done":true,"completed_at":"2026-09-07T18:10:00","t":"2026-09-07T18:10:00.418","by":"hermes"}

# reopen it
{"id":"abc","done":false,"$unset":["completed_at"],"t":"2026-09-07T18:11:00.000","by":"hermes"}

# add a new task
{"id":"11111111-2222-3333-4444-555555555555","text":"ship the thing","done":false,"priority":"high","t":"2026-09-07T18:12:00.000","by":"hermes"}

# file a task under a life focus area (ids are in ~/.leonote_priorities.json)
{"id":"abc","focus_id":"0f5c2e61-1b7a-4c3e-9d2a-5e8f4b6a7c10","t":"2026-09-07T18:12:30.000","by":"hermes"}

# retitle
{"id":"abc","text":"a better title","t":"2026-09-07T18:13:00.000","by":"hermes"}

# tick ONE subtask - resend the whole array
{"id":"abc","subtasks":[{"id":"s1","text":"first","done":true},{"id":"s2","text":"second","done":false}],"t":"2026-09-07T18:14:00.000","by":"hermes"}

# move to trash
{"id":"abc","deleted":true,"deleted_at":"2026-09-07T18:15:00","t":"2026-09-07T18:15:00.000","by":"hermes"}
```

## If something looks wrong

- **A line you wrote had no effect.** Check it parses as one line of JSON, has
  a string `id`, and ends with `\n`. Unparseable lines are copied to
  `~/.leonote/quarantine.jsonl` with the reason — look there first.
- **Your change appears then disappears.** Another writer set the same field
  with a later `t`. Last write wins per field.
- **`<<<<<<<` in a log.** A git merge left conflict markers. The app refuses to
  fold that file at all rather than silently dropping one side. Resolve it by
  hand; `*.jsonl merge=union` in `.gitattributes` prevents a recurrence.
- **Do not delete a log file to "clean up".** The app truncates logs during
  compaction and expects the inode to survive.

## What you must never do

- Write `~/.leonote_tasks.json` yourself.
- Append to a log another process owns.
- Remove or reorder entries in the snapshot.
- Write `~/.leonote_config.json` — it holds XP, streaks and
  pomodoro history, and it is written non-atomically by another program.
