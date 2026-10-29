---
name: agent-page
description: The rules of your page beside the conversation. Read before you edit the page yourself.
scope: [global]
---

# The page

The page is index.html in the page folder (page/ in Your agent's working directory). Mandate shows it beside Your agent's conversation with the user, in a sandboxed frame from about 400 to 1000px wide, in the user's light or dark theme.

## Colors and fonts
Mandate gives the page its colors and fonts as CSS variables, following the user's light or dark theme as it changes, and sets the page's background, text and font with them. Take color and type from them so the page sits with the rest of the app; the layout is yours.
- Ground and text: `--mandate-bg`, `--mandate-panel`, `--mandate-fg`, `--mandate-muted`, `--mandate-faint`, `--mandate-border`, `--mandate-code-bg`.
- Accents, for links and state: `--mandate-link`, `--mandate-blue`, `--mandate-green`, `--mandate-amber`, `--mandate-red`, `--mandate-violet`.
- Type: `--mandate-font`, `--mandate-mono`; sizes `--mandate-size-small` (12px), `--mandate-size-body` (14px), `--mandate-size-title` (16px).

## What the frame allows
- One self-contained HTML document: CSS and JS inline. Scripts load only from cdnjs.cloudflare.com (preferred), cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com and code.jquery.com, pinned to an exact version; fonts from Google Fonts. Nothing else loads: fetch() and submitting forms are blocked, and there are no iframes, alert() or print.
- Draw charts with a library from those hosts.
- Give every form field an id: what the user is typing survives an update by it.

## Draw from data
Let the page show from data whatever data can tell: render threads, workers, what waits on the user and canvases from the built-in sources, so a new thread, a new report or a new question appears without anyone rewriting the page. Write by hand only what needs judgment.

## window.mandate
- mandate.data(name) resolves to { value, at, error } for a source: its latest value, when it was read, and the last error (null when the last read worked).
- mandate.onData(name, fn) calls fn with that object now and each time it changes.
- mandate.submit(value) sends a JSON value of up to 8 KB to Your agent, as a note it reads on its next turn; it resolves once Mandate has kept it.
- mandate.open(path) opens a page of Mandate's in the app: /threads/<id>, a worker's /threads/<id>?worker=<id>, /canvas/<id>, /home. Links to those paths do the same; other links open in a new tab.

## Built-in sources
- threads: [{ id, title, state, lastActivityAt, link }]; state is working, watching, needs_you, decision, result, failed or idle.
- workers: [{ id, name, threadId, state, line, link }]; line is the worker's own one-line status.
- waiting: [{ waiting, title, text, link }], what waits on the user, most urgent first; waiting is failed, stopped, input, decision or result.
- usage: { days: [{ day, inputTokens, outputTokens, cacheReadTokens, calls }] } for the last 14 days.
- canvases: [{ id, title, kind, updatedAt, link }], newest first.
- questions: [{ id, question, askedAt }], what Your agent asked the user and they have not answered.
- answers: [{ id, value, at, read }], what the user gave on this page, newest first; read once it reached Your agent.

## Your own sources
sources.json in the page folder lists them: [{ "name": "…", "run": "<shell command>", "every": "5m", "cwd": "<directory, optional>" }]. Mandate runs each command on its interval in the user's shell environment, from every 1m to every 24h, for up to 60 seconds. Its output is the value, parsed as JSON when it is JSON and kept as text otherwise, and refused over 64 KB. A failing run keeps the last value and sets error. Names use letters, digits, - and _; at most 20 sources. The user can pause or remove a source; a removed one is taken out of sources.json. Try a command with bash before you list it.

## When it is published
Mandate publishes index.html when it changed, and applies sources.json, when whoever edited them ends: a page subagent when it finishes, Your agent when its turn ends.
