# Leonote privacy policy

Last updated: 20 November 2026

This is the whole policy for the Leonote desktop app, the Leonote Android app (a preview) and the leonote.app
website. It replaces the version of 19 November 2026.

## Summary

- The Leonote app has no accounts, no servers that hold your data, no analytics, no telemetry, no crash reports of
  its own and no licence checks. Your notes, tasks and settings stay on your computer. It contacts the developer's
  own sites only for the two small things listed below: leonote.app for the version check, olexify.dev for the
  donation goal (not in the Microsoft Store package or the Google Play app).
- Leonote goes online only for features you use: opening a link or a video, an AI or speech service you add
  your own key for, a Google calendar you connect, a tool, add-on or plugin you install. Each is listed below, with what
  it sends and when.
- The website sets no cookies and runs no analytics or advertising scripts.
- Leonote is free. Donations by card, and paid extras if they are ever offered, go through a payment provider;
  Leonote never sees your card. Donating is links and addresses only: nothing is sent until you click one.

## 1. Who is responsible

Leonote is made and published by Olexify, an independent developer based in Ukraine. Contact:
olexifyyy@gmail.com.

## 2. The Leonote app

### What stays on your computer

Your notes, tasks, drawings, videos, settings, chat threads with AI, the built-in browser's history and your
backups are files on your computer: in your vault folder and in Leonote's data folders (`~/.leonote`, and
WebView2's folder under `%LOCALAPPDATA%` for the built-in browser's cookies). The developer never receives them.
If you keep your vault in a synced folder (OneDrive, Dropbox, Google Drive...), that service's own terms apply
to it. What belongs to this computer alone is never kept in the vault, so it does not travel with it: the
browser's history, the addresses and titles of open browser tabs (a tab opened on one computer does not show on the
other; in the vault it is only a short code), the sites you told it never to remember or never to offer saving a
sign-in for, each site's zoom, your Google sign-in, the AI services you set up, Jev's activity list and the optional
tools Leonote installs. What you keep on purpose in Leonote's settings does
travel with the vault: your bookmarks and your own search engines, the Player's online library, the names of your spaces and
which notes are open in them.

### Online features

Leonote contacts a service only in the cases below. What you send to a service is handled under that service's
own terms and privacy policy; the developer does not receive a copy. Every request also carries your IP address,
as any internet request does.

| You use... | Leonote contacts | What it receives | When |
|---|---|---|---|
| **AI assistant** with your own key | The provider you choose: Anthropic, OpenAI, Google (Gemini), xAI, Perplexity, OpenRouter, or a server address you type | Your question and the chat so far; the selected text, or else the note you were in (not if it is marked private); notes, pictures or PDFs you attach yourself. With "can look through the vault" on (the default), the AI may ask for more notes, and for your open tasks, while it answers; those are sent too and shown as steps of the answer - never notes you mark private, and only tasks given to AI when you keep your tasks apart from AI. | Only when you press Send. Nothing until you add a key. "Choose…" next to the model asks the provider for its model list, with your key (no note or question goes). |
| AI on this computer (Ollama, LM Studio) or an AI program (Claude Code, Codex, Gemini CLI...) | Nothing on the internet from Leonote. A program you choose sends the request on under your own account with its maker. | The same as above, handed to that program. With "can look through the vault" on, Claude Code starts in a temporary copy of the notes AI may see (no private ones, none of Leonote's settings), removed when the answer is done; Leonote shows its answer, not what it read. Leonote does not give a program private notes, but it cannot fence one in: a program runs as you and can open any file on this computer, private notes included. | When you press Send |
| **Jev** (TypeSafe) with your own key | TypeSafe (api.typesafe.ai) | For a new task without a priority or area: its text, its due date, today's date and the names and descriptions of your areas. For "suggest a folder and tags": the note's title, folder, first 4,000 characters, your folder names and up to 40 of your tags. With skills: the question a skill step asks Jev, or your request in Skills › Ask with your skills' names and descriptions. | Only what you allow: new tasks are not sent until you choose "Given to AI" or "All" in Settings › Jev, and tasks you keep apart from AI are never sent. Note suggestions only on a click, never for private notes. Laya, the local option, runs on your computer by default; if you set an https address on another computer, Leonote asks first, then sends the same items and Laya's key there. Installing Laya (only when you click) downloads it from PyPI (pypi.org) through Python's pip. |
| **Speech to text** with your own key | Groq, OpenAI or Mistral, as you choose | The recording of what you say (one clip, up to 60 seconds) | Only when you click the microphone. Nothing until you add a key. With Windows' own speech, Windows' online speech recognition and Microsoft's terms apply. |
| **Google Calendar** | Google, through your own Google Cloud app | Reads the events of the calendars you tick. With sending on: the titles, dates, repeats, time zone and done state of your tasks and routines. It also creates an event you add in the Calendar and moves one you drag there. | Only after you connect it; events are read when the calendar is shown. |
| **Online videos and playlists** in the Player and in notes | The video site (for YouTube: youtube.com, youtube-nocookie.com, i.ytimg.com) | The video's address. Playing loads the site's own player, which works under the site's terms. | A video's picture and title load when its tile is shown, and when a note with its link is shown (can be switched off: Settings › "YouTube links show the video"); the player loads when you play. Importing or refreshing a playlist, or finding a song, happens when you click; a playlist you set to keep up with its original (off by default) is read every few hours. This uses the YouTube Data API (next row). While the Player's online list is open, the videos in it are re-checked about once a week (still there? made private? a new name?), a few at a time. |
| **YouTube playlists and finding songs** | YouTube's Data API (googleapis.com), with your own Google sign-in or your own key | The playlist's id or the words you search for, with your key or sign-in | Only once you set one up; when you import, refresh or find, and for a playlist you set to keep up |
| **Sending playlist changes** | YouTube, through your own Google Cloud app | The changes you make to that playlist | Only for playlists you set to send; off by default |
| **Songs from a web address** | The site of that address | A request for the file | When you add or play it |
| **Links in notes** | The site of the link; with link cards, also the site holding the picture that page names for its card, which may be another site | A request for the page, naming itself as Leonote (a YouTube link is asked of YouTube's public oEmbed address instead) | When you paste a bare address (to get its title; can be switched off), when link cards are on (off by default) and the note is shown - with the site's small icon and the card's picture, with no click - or when you add a page as a source |
| **Checking for a newer version** (copies not from an app store) | leonote.app | A request for one small file that names the latest version - nothing about you or your notes | About a minute after Leonote starts, then once a day while it runs, and when you click "Check for updates". A newer version is always shown, with an Install button (installed copies) or its page to open in your browser |
| **Installing a newer version** (the Windows installer copy and the Linux AppImage) | GitHub (github.com and its download servers) | A download request for the list of the newest files and then the new version | With "Update automatically" on (the default; Settings › About), as soon as a newer version is found; it is installed when you quit Leonote, or at once if you click Restart now. With it off, only when you click Install. Either way the download is checked against Leonote's signature before it is installed |
| **Pictures from the web in a note** (`![](https://...)`) | The site the picture is on | A request for the picture, as a browser makes | When you click "Load picture" on it (the default), or when the note is shown with Settings › "Pictures from the web" set to Always |
| **The built-in browser** | The sites you open, and the search engine you pick (Google until you choose another) | What any browser sends to them | When you browse. Leonote adds no advertising and no trackers to the pages; it adds two small scripts of its own - one for Ctrl+wheel zoom, which also tells the Player when a page starts a video and lets the Player pause it or set its volume, and, while "Offer to save sign-ins" is on, one that notices a sign-in so Leonote can offer to keep it in your password vault (nothing is sent anywhere). |
| **Microsoft Defender SmartScreen**, in the built-in browser | Microsoft | The addresses of pages and downloads, checked against known dangerous sites, as in Microsoft Edge | When you browse |
| **Browser add-ons** | Chrome Web Store, Microsoft Edge Add-ons or GitHub | The add-on's id | When you install one, and when you press Check for updates (or once a day, if you switch that on) |
| **Plugin search and plugins** (Settings › Plugins) | GitHub (raw.githubusercontent.com for the list; github.com for a plugin's download) | A download request | The list loads only when you open the search. A plugin downloads only when you click Install or Update. Nothing is checked or updated by itself. |
| **A plugin you allowed to reach the internet** | Only the hosts it names, which you allowed when you installed it | Whatever the plugin puts in its request, which may include anything it may read: notes you allowed it, never private ones, even when AI has full access. That host's own terms apply. Plugins are made by other people, and the developer does not receive any of this. | When the plugin asks. A plugin without that permission may still be able to send what it can read, so install only plugins you trust. |
| **Optional tools** (FFmpeg, whisper.cpp and its model) | winget (Windows) or Homebrew (macOS, Linux) when it is on the computer, else their makers' download sites (GitHub, Hugging Face) | A download request | Only when you click to install one |
| **The donation goal** (Settings › About) | olexify.dev (the developer's site, hosted by Cloudflare) | Your IP address, to read the current donation goal | When you open the About card in Settings, at most every 6 hours; never in the Microsoft Store package or the Google Play app. The Support window sends nothing. |

### Your keys and sign-ins

- **API keys** for AI, Jev and speech are stored on your computer only, encrypted for your Windows account. They
  are sent only to the service that issued them, and are not included in backups.
- **Google sign-ins** are made in your own browser with your own Google Cloud app. The lasting sign-in (refresh
  token) and your Google app's client secret are stored on your computer encrypted for your Windows account; the
  short-lived access token (an hour) is kept only in memory while Leonote runs. Signing out in Settings asks Google to
  revoke the sign-in and removes them from this computer; you can also revoke access at myaccount.google.com.
- **On an Android phone** there is no Windows account to encrypt for. API keys and sign-ins are kept as they are in
  the app's own storage, which Android closes to other apps, and Android's app backup is switched off for Leonote so
  that storage is not copied to a Google account. A phone that is rooted, or unlocked in someone else's hands, does
  not have that protection. Uninstalling the app removes them.

### Passwords you keep in Leonote

Passwords you save in Leonote's password vault are stored only on this computer, in one file encrypted with your
master password. The master password is not stored anywhere, the vault locks after 5 minutes without use, and
nothing in it is sent anywhere or included in backups. When you sign in to a site in the built-in browser,
Leonote can offer to keep that sign-in; the details stay in memory until you answer, and at most 5 minutes.

### Tools for AI agents

`leonote-rs.exe --mcp` lets an AI program on your computer read and write your notes and tasks, following each
note's AI access setting. It talks only to that program on this computer and opens no network port.

### The Microsoft Store version

Microsoft delivers and updates the app. Under your Windows settings, Microsoft may
collect diagnostic data such as crash reports and share summaries of them, and of installs, with the
developer through its Partner Center. Leonote does not add your notes to them; what Windows collects is set by your
Windows settings and Microsoft's privacy statement (privacy.microsoft.com).

### YouTube

Leonote plays YouTube videos with YouTube's own embedded player, reads videos' titles and pictures through
YouTube's public oEmbed address and picture addresses, and uses the YouTube Data API with your own Google Cloud app or
key - for playlists you set to send, and to read playlists and find songs. The embedded player and the Data API are
YouTube API Services: by using them you agree to YouTube's Terms of Service
(https://www.youtube.com/t/terms), and Google's Privacy Policy (https://policies.google.com/privacy) applies to
what YouTube receives. You can withdraw Leonote's access to your Google account at any time at
https://myaccount.google.com/permissions.

### What Leonote keeps, and for how long

- Deleted notes and files go to the vault's `.trash` folder and are removed after the time set in Settings › Trash
  (30 days unless you change it).
- Earlier versions of a note are kept in `~/.leonote/history`, so a change can be undone; you can clear them there.
- The built-in browser's history is kept for a year unless you change that or clear it in the browser's History.
- The pictures of online videos (Settings › Player) are kept in the vault's `.leonote/previews-public` for 30 days at a time,
  and a video found to be gone shows none.
- Copies of the task list are kept at each start and exit (Settings › Backup › Task history copies).
- The last 20 versions of Leonote's settings files are kept beside them, for undoing a bad change: in the vault's
  `.leonote/history/settings` for the settings that travel with it. Copies made by an earlier version may still hold
  what has since moved out of the vault, until newer copies replace them.
- A note that could not be saved (a sync program holding it, a full disk) is kept in `~/.leonote/unsaved` until it is
  saved or you decline it.
- When you compress photos or videos on a phone, the full-size originals go to the Recycle Bin; one the bin refuses
  stays in `~/.leonote/phone-originals` until you delete it.
- All of it stays on your computer (and with your sync service, for what is in a synced vault); deleting those folders removes it.

## 3. The leonote.app website

- Your theme and accent colour choices are kept in your browser's local storage, on your device.
- Cloudflare hosts the site and processes request data (such as your IP address) to deliver and protect it.

## 4. Donations and payments

Leonote is free. The donation buttons are links and addresses only: nothing is sent until you click one. A link
(Patreon, Monobank) opens that site in your browser. A crypto address (USDT, USDC, BTC, ETH, XMR, SOL, LTC) and its
QR code are part of the app, so showing or copying one sends nothing. Please do not donate if you are subject to
sanctions or live in a sanctioned region. A donation buys nothing in Leonote.

The Microsoft Store package offers none of these. Its one button, "Support Leonote", opens olexify.dev in your
browser, and any donation is made there. The Google Play app has no donation buttons, links or addresses at all.

If you donate (Patreon, Monobank) or, later, pay for an optional extra, the platform or payment provider handles
the payment under its own policy. Leonote receives what it needs to deliver, support, refund and keep tax records -
such as your name, e-mail and the amount - never your card details. A crypto donation goes from your own wallet to
the address you chose: the developer sees what that coin's public network shows, and your wallet's and the network's
own rules apply. If you tell the developer about a donation on Discord, Discord's policy applies to that message.

## 5. Contacting the developer

If you write to olexifyyy@gmail.com, your message is used only to answer you and is deleted when it is no longer
needed. Community discussion happens on third-party platforms (such as Discord) under their own policies.

## 6. Sharing

Personal data is not sold. It is shared only with the processors that make the above work (payment, hosting and
email providers), with authorities when the law requires it, and with a successor if the business is
transferred.

## 7. Legal bases and transfers

Where data protection law applies, data is processed to perform a contract (an answer to you, anything you pay for), to
meet legal obligations (tax records) and for legitimate interests (keeping the website safe). Data may be
processed outside your country; where required, under adequacy decisions or standard contractual clauses.

## 8. Your rights

You may ask for access to, correction or deletion of personal data the developer holds about you, ask to restrict
or object to its use, and ask for a copy to take elsewhere. Write to olexifyyy@gmail.com; requests are answered
within one month. You may also complain to your local data protection authority.

## 9. Children

The app and the website are not directed at children under 16.

## 10. Security

Your notes are ordinary files and Leonote does not encrypt them on disk; protect your computer with your Windows
account and disk encryption. The encrypted backup (Settings › Backup) holds your notes, tasks and Leonote data and the vault's
own settings (bookmarks, search engines, spaces, backup plans), never API keys, Google sign-ins or your password
vault. It is encrypted with your backup password, which Leonote never stores or sends; backup plans make plain zip files, readable anywhere - keep them somewhere
only you can open. Passwords you keep in Leonote and your API keys are encrypted as described above.

## 11. Changes

When this policy changes, the date at the top changes with it, and the old versions stay available on request. If
Leonote ever offers a service of its own that holds your data, such as hosted sync or storage, it will be
optional, described here before it starts, and will change nothing for those who do not use it.
