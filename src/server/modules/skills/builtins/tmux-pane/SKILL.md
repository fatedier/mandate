---
name: tmux-pane
description: How to inspect and control Mandate feature terminal panes. Load before opening coding CLIs, starting long-running processes, or manipulating tmux panes.
scope: [worker]
---

# Mandate Terminal Panes

Feature panes are user-visible terminals. Use them for work the user should
watch or drive: interactive coding agents, dev servers, and other long-running
processes. Ordinary project commands default to the `bash` tool — it executes
in the user's login shell environment (same PATH and env as their terminal)
and returns output directly, without the send-keys/read-pane round trip.

## Choosing Bash Or A Pane

Use a pane via `send_keys` for:

- terminal apps and coding CLIs such as `codex`, `claude`, `aider`, or editors
- local dev servers, watchers, and other long-running processes
- interactive programs that will prompt for input while running
- commands the user explicitly asks to run in the terminal or watch live

Everything else — tests, builds, linters, formatters, package managers, git,
file inspection — runs through `bash` by default. Move a command into a pane
when the user asks to see it or when you expect to interact with it while it
runs.

## First Choose A Pane

1. Inspect current panes before acting when the right pane is not obvious.
   Use `list_panes` for all panes and `read_pane` or
   `pane_status` for the relevant pane.
2. Prefer an existing idle shell in the feature's working directory.
3. If a pane already runs the relevant tool, continue in that pane instead of
   creating another one.
4. Use `spawn_pane` only when the user explicitly asks for a new pane, no
   suitable pane exists.

`spawn_pane` creates a shell pane. It does not accept a command. To run a
command in the new pane, call `send_keys` with the returned `paneId`.
When creating or repurposing a pane, provide or update its `name` and
`description` with `spawn_pane` or `set_pane_metadata`; these labels help the UI,
analysis, and future agent turns understand the pane's purpose.

## Pane Lifecycle

Mandate owns the lifecycle of feature panes. Do not use raw `tmux` commands to
create, identify, resize, or destroy Mandate-managed panes. Use the Mandate pane
tools instead:

- create panes with `spawn_pane`
- label panes with `set_pane_metadata`
- send input with `send_keys`
- inspect panes with `read_pane`, `pane_status`, or
  `list_panes`
- terminate panes with `kill_pane`

Raw `tmux` is only appropriate for read-only diagnostics that Mandate tools
cannot answer. If you do use raw `tmux` for diagnostics, target the exact
pane/window/session explicitly. Never depend on tmux's current client context to
infer which pane belongs to this feature.

## Running Commands In A Pane

`send_keys` maps directly to `tmux send-keys -t <paneId> ...args`.
Mandate supplies the target pane, so do not include `-t` or `--target-pane`
before a `--` terminator.

Use raw tmux `send-keys` arguments:

- literal shell command, preserving spaces:
  `send_keys({ "paneId": "%123", "args": ["-l", "git status"] })`
- submit the typed command:
  `send_keys({ "paneId": "%123", "args": ["Enter"] })`
- interrupt:
  `send_keys({ "paneId": "%123", "args": ["C-c"] })`
- end input:
  `send_keys({ "paneId": "%123", "args": ["C-d"] })`

## Submitting To Interactive Agents

When interacting with terminal agents such as `codex`, `claude`, or `aider`,
distinguish typing from submitting:

- If the user asks you to send a complete instruction, send the literal text in
  one argument and then submit in a second call:
  - `send_keys({ "paneId": "%123", "args": ["-l", "your instruction with spaces"] })`
  - `send_keys({ "paneId": "%123", "args": ["Enter"] })`
- If the user explicitly asks you to only type text without submitting, omit
  the second `Enter` call.
- After submitting, read the pane again before reporting that the agent has
  started or completed the task.

After sending a command that should produce useful output, read the pane again
before reporting success or failure. If the command is still running, say that
you started it and report the latest visible state instead of inventing a
result.

## Safety

Ask before destructive or hard-to-reverse actions, including `rm`, force pushes,
database migrations, dropping data, or commands that overwrite user work. If the
terminal is already running something important, read the pane and explain the
state before interrupting it.
