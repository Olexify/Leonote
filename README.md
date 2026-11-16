# Leonote <a href="https://leonote.app"><img align="right" width="140" src="https://leogifcounter.vercel.app/api/counter" alt="visitor counter" /></a>

**Instant, local-first notes and tasks.** Your notes are plain Markdown files on your own computer; tasks, habits,
a focus timer and an AI assistant of your choosing sit right next to them. Rust + Tauri, a CodeMirror 6 live
preview editor, no framework, no loading screens.

[![leonote.app](https://img.shields.io/badge/leonote.app-0F172A?style=flat-square&logo=firefoxbrowser&logoColor=white)](https://leonote.app)
[![Download](https://img.shields.io/badge/Download-0F172A?style=flat-square&logo=github&logoColor=white)](https://github.com/Olexify/Leonote/releases/latest)
[![Discord](https://img.shields.io/badge/Discord-0F172A?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/UpmNHxT7PF)
[![Patreon](https://img.shields.io/badge/Patreon-0F172A?style=flat-square&logo=patreon&logoColor=white)](https://www.patreon.com/c/Olexifyyy)

## Download

From [Releases](https://github.com/Olexify/Leonote/releases/latest):

| System | File |
| --- | --- |
| Windows 10 / 11 | `Leonote-<version>-windows-setup.exe` (installer) or `Leonote-<version>-windows-portable.exe` (one file, no install) |
| Linux (x86-64) | `Leonote-<version>-linux-amd64.deb` (Debian, Ubuntu, Mint) or `Leonote-<version>-linux-x86_64.AppImage` (most others) |

Each file has a `.sha256` next to it. The Windows builds are not code-signed yet, so Windows may show "Windows
protected your PC" the first time: **More info › Run anyway**. The Linux build is new: a few features that lean on
Windows (the phone link, Windows speech, some file previews) are missing or limited there. Problems go to
[Issues](https://github.com/Olexify/Leonote/issues).

**Versions** are named like `Leonote 1.0 · First Roar`: the number says how far along it is (`1.0.1` is a fix for
`1.0`), and each new `1.x` gets its own name.

> **Source-available, all rights reserved.** Leonote is free to use, but it is not open source: the code is here to
> read, not to reuse, build for others or redistribute - see [LICENSE](LICENSE) (section 2A) and
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Issues are welcome; pull requests are not accepted.

## What it does

- **Notes are Markdown files** in a folder you own (`~/LeoNote`). Git them, sync
  them, open them in Obsidian. They are not locked inside the app.
- **Live preview editing** - Markdown renders in place, syntax appears only
  where the caret is. `[[wikilinks]]` with autocomplete, `#tags`, checkboxes,
  callouts, code blocks, tables, `/` slash menu.
- **Backlinks, unlinked mentions, outline, graph.** Renaming a note rewrites
  every link to it.
- **Tasks** with priorities, due and start dates, steps, quick-add syntax
  (`call bank !h @tomorrow ^fri`), fully keyboard driven.
- **Habits** with streaks and a 20-week heatmap. **Daily notes** on `Alt+D`.
- **Recurring tasks and reminders** ("water the plants every Tuesday"),
  with catch-up, snooze, skip and cadence-aware streaks.
- **Focus timer** with sounds, 14-day focus history, **XP and levels**.
- **Outposts**: hook up folders outside the vault (a music drive, a videos
  folder) and browse, search and manage them from the sidebar. They stay where
  they are, and backups leave them out.
- Lives in the **tray**: Alt+F4 or closing from the taskbar hides it, so reopening is instant (the X quits).
- **An assistant of your choosing.** Claude, GPT, Gemini, Grok, Perplexity,
  OpenRouter with your own key, or a model on your own computer through Ollama
  or LM Studio. Keys are sealed by Windows outside the vault; no note or question is sent
  until you press Send (Choose… asks the provider for its model list, with your key), and what goes along is shown before it goes (a service's or local model's own lookups appear as it answers; a program such as Claude Code shows only its answer).
- **An MCP server.** `leonote-rs.exe --mcp` lets Claude Desktop, Claude Code,
  Cursor or a local agent search, read and write the vault and the task list.
- **Built for AI agents.** Agents edit note files directly and append task
  changes to their own log in `~/.leonote/log/`. The app folds every change
  in within milliseconds, highlights what changed and says who changed it.
  The contract is [AGENTS.md](AGENTS.md).
- **Plugins**, free and fenced off, from a folder or the list in Settings › Plugins: [docs/plugins/PLUGINS.md](docs/plugins/PLUGINS.md).
- **Tabs, command palette, quick switcher, full-text search**, back/forward
  history, focus mode, light/dark themes and accents, session restore, global
  quick capture (`Ctrl+Alt+N`).

## More than one computer

Notes are files, so any folder sync (Syncthing, OneDrive, Dropbox, a git
remote) on the vault carries them; Leonote sees a synced change within
milliseconds like any other. Tasks, habits and the timer's history live in
`~/.leonote` on each computer (Settings › Files › Leonote data can move them into the vault,
where they sync as files too - keep one computer at a time editing tasks then,
as each writes the same log).

## Keys

| Keys | Does |
| --- | --- |
| `Ctrl O` | Quick switcher (type `>` for commands) |
| `Ctrl P` | Command palette |
| `Ctrl Shift F` | Search every note (`#tag`, `path:`, `"phrase"`, `-word`) |
| `Ctrl N` / `Alt D` | New note / today's note |
| `Ctrl Shift Space` | Quick capture (task or daily note) |
| `Ctrl T` `Ctrl W` `Ctrl Tab` | Tabs |
| `Alt ←` `Alt →` | Back / forward |
| `Alt 1-4` | Home, Tasks, Habits, Graph |
| `Ctrl Enter` | Toggle checkbox |
| `Ctrl Shift Enter` | Focus mode |

Shortcuts use physical key positions, so they work on any keyboard layout.

## The source

The code is here to read: `web/` is the frontend (plain JavaScript, bundled with esbuild),
`src-tauri/src/` the Rust backend - `store.rs` (append-only task logs and their fold), `vault.rs` (notes on
disk), `watch.rs` (live file watching), `mcp.rs` (the tools for AI agents). Building it is allowed only to
review it or to research its security, and such a build may not be passed on - see LICENSE, section 2A.
Official builds come from this repository's [Releases](https://github.com/Olexify/Leonote/releases) and
leonote.app.
