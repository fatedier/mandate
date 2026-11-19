---
name: agent-page
description: The rules of your page beside the conversation. Read before you edit the page yourself.
scope: [personal]
---

# The page

The page is the site/ folder in the page folder (page/site/ in the personal agent's working directory): index.html is its first page, and each other .html file in it is a page of its own. Mandate shows it beside the personal agent's conversation with the user, in a sandboxed frame from about 400 to 1000px wide, in the user's light or dark theme.

## Colors and fonts
Mandate gives the page its colors and fonts as CSS variables, following the user's light or dark theme as it changes, and sets the page's background, text and font with them. Take color and type from them so the page sits with the rest of the app; the layout is yours.
- Ground and text: `--mandate-bg`, `--mandate-panel`, `--mandate-fg`, `--mandate-muted`, `--mandate-faint`, `--mandate-border`, `--mandate-code-bg`.
- Accents, for links and state: `--mandate-link`, `--mandate-blue`, `--mandate-green`, `--mandate-amber`, `--mandate-red`, `--mandate-violet`.
- Type: `--mandate-font`, `--mandate-mono`; sizes `--mandate-size-small` (12px), `--mandate-size-body` (14px), `--mandate-size-title` (16px).

## What the frame allows
- A page loads its own stylesheets, scripts and images from site/ by relative path (`style.css`, `img/logo.png`); nothing outside site/ loads. Keep the scripts your sources run, and whatever else is not for the page, outside site/.
- Beyond site/, scripts load only from cdnjs.cloudflare.com (preferred), cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com and code.jquery.com, pinned to an exact version; fonts from Google Fonts. Nothing else loads: fetch() and submitting forms are blocked, and there are no iframes, alert() or print.
- A relative link to another page in site/ (`<a href="mr.html">`) shows that page in the frame. Mandate adds no tabs or back button: the pages carry their own way between them. window.mandate and the colors are there on every page.
- Draw charts with a library from those hosts.
- Give every form field an id: what the user is typing survives an update by it.

## Draw from data
Let the page show from data whatever data can tell: render threads, workers, what waits on the user and canvases from the built-in sources, so a new thread, a new report or a new question appears without anyone rewriting the page. Write by hand only what needs judgment.

## window.mandate
- mandate.data(name) resolves to { value, at, error } for a source: its latest value, when it was read, and the last error (null when the last read worked).
- mandate.onData(name, fn) calls fn with that object now and each time it changes.
- mandate.submit(value) sends a JSON value of up to 8 KB to the personal agent, as a note it reads on its next turn; it resolves once Mandate has kept it.
- mandate.open(path) opens a page of Mandate's in the app: /threads/<id>, a worker's /threads/<id>?worker=<id>, /canvas/<id>, /home. Links to those paths do the same; other links open in a new tab.

## Quoting
Mark each thing the user may want to ask you about, such as a card, a row or an item of a list, with a data-quote attribute. The user can pick a marked element with Quote in the page's bar, and it goes into the chat with their message as one line: the attribute's text, or the element's own text when the attribute is empty, up to 500 characters. Write the attribute as a sentence that stands on its own and says enough to find the thing again, since that line is all you read of it.

## Built-in sources
- threads: [{ id, title, state, lastActivityAt, link }]; state is working, watching, needs_you, decision, result, failed or idle.
- workers: [{ id, name, threadId, state, line, link }]; line is the worker's own one-line status.
- waiting: [{ waiting, title, text, link }], what waits on the user, most urgent first; waiting is failed, stopped, input, decision or result.
- usage: { days: [{ day, inputTokens, outputTokens, cacheReadTokens, calls }] } for the last 14 days.
- canvases: [{ id, title, kind, updatedAt, link }], newest first.
- questions: [{ id, question, askedAt }], what the personal agent asked the user and they have not answered.
- answers: [{ id, value, at, read }], what the user gave on this page, newest first; read once it reached the personal agent.
- on_duty: [{ id, name, threadId, threadTitle, link, status, cronText, nextDueAt, lastOutcome, runs7d, wakes7d }], each schedule with its duty thread, status, when it is next due, its last outcome, and its runs and wakes over the last 7 days.
- tasks: [{ id, title, status, dueDate, dueTime, marks: { needsYou, failed, quiet }, threads: [{ title, dot }], labels, lastComment, result, link }]; open tasks only; status is todo, in progress or in review; labels are names, automatic ones included.

## Your own sources
sources.json in the page folder lists them: [{ "name": "…", "run": "<shell command>", "every": "5m", "cwd": "<directory, optional>" }]. Mandate runs each command on its interval in the user's shell environment, from every 1m to every 24h, for up to 60 seconds. Its output is the value, parsed as JSON when it is JSON and kept as text otherwise, and refused over 64 KB. A failing run keeps the last value and sets error. When a source has not read once in 30 minutes, with 3 runs failed in a row, Mandate starts a page subagent to look into it, at most once a day for each source. Names use letters, digits, - and _; at most 20 sources. The user can pause or remove a source; a removed one is taken out of sources.json. Try a command with bash before you list it.

## Updates on a schedule
updates.json in the page folder lists them: [{ "name": "…", "when": "<cron>", "task": "…" }]. At each time `when` names (a 5-field cron in this machine's time zone, at most once an hour), Mandate starts a page subagent with `task` as its task. When nothing the page draws from, and nothing in your notes, has changed since that update last ran, the time is skipped. Use them for what the page says by hand and should keep current; what data shows changes by itself. Names use letters, digits, - and _; at most 10 updates, a task at most 2000 characters. The user can pause or remove an update; a removed one is taken out of updates.json.

## When it is published
Mandate publishes site/ when a file in it changed, and applies sources.json and updates.json, when whoever edited them ends: a page subagent when it finishes, the personal agent when its turn ends. site/ holds at most 200 files and 16 MB, and needs an index.html; files whose names begin with a dot are left out.
