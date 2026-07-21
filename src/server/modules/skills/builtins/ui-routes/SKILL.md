---
name: ui-routes
description: Catalog of Mandate UI pages and URL patterns. Load before calling ui_navigate.
scope: [manager]
---

# Mandate UI Routes

Prefer `ui_navigate` with a structured `route` whenever possible. This is
especially important in voice sessions, where transcribed words can be
slightly wrong. Structured navigation lets Mandate resolve names/slugs and
return an error instead of sending the user to a nonexistent page.

Structured destinations:

| route | Required fields | What it shows |
|-------|-----------------|---------------|
| `home` | none | Home/projects page |
| `projects` | none | List all projects |
| `sessions` | none | All tmux sessions on the host |
| `activity` | none | Activity feed |
| `settings` | none | Preferences |
| `feature` | `featureId`, or `featureSlug`/`featureName` plus optional project fields | A feature's window |
| `feature_pane` | same as `feature`, plus `paneId` | Interactive terminal for a managed pane |
| `session` | `sessionName` | One tmux session |
| `window` | `sessionName`, `windowName` | One tmux window's panes |
| `window_pane` | `sessionName`, `windowName`, `paneId` | Interactive terminal for a tmux pane |

Examples:

```json
{ "route": "activity" }
```

```json
{ "route": "feature", "featureId": "..." }
```

```json
{ "route": "feature_pane", "featureId": "...", "paneId": "%123" }
```

```json
{ "route": "window_pane", "sessionName": "tt", "windowName": "nova", "paneId": "%53" }
```

Raw `path` is still accepted as a fallback. If you use `path`, it must match
one of these patterns:

| Path | What it shows |
|------|---------------|
| `/` | Home/projects page |
| `/projects` | List all projects |
| `/projects/:projectSlug/features/:featureSlug` | A feature's window: chat with its agent + tmux pane layout previews |
| `/projects/:projectSlug/features/:featureSlug/pane/:paneId` | Interactive xterm terminal for a managed pane |
| `/canvas/:canvasId` | One canvas document |
| `/sessions` | All tmux sessions on the host (managed + unmanaged) |
| `/sessions/:sessionName` | Drill into one session's windows |
| `/sessions/:sessionName/windows/:windowName` | Drill into one window's panes (tmux layout preview) |
| `/sessions/:sessionName/windows/:windowName/pane/:paneId` | Interactive xterm terminal for an unmanaged tmux pane |
| `/activity` | Activity feed (LLM calls, agent wakes, recent events) |
| `/settings` | Preferences (theme, layout, AI provider) |

## Where slugs / IDs come from

- **`projectSlug`** — pass the `slug` field from `list_projects`, OR the `projectSlug` field from `list_features` / `get_feature_status` / `create_project` / `create_feature`. Do NOT pass `id` or `name` — those won't resolve and `ui_navigate` returns an error.
- **`featureSlug`** — pass the `slug` field from `list_features` / `get_feature_status`, or the `featureSlug` field from `create_feature`. Same caveat: not `id`, not `name`.
- **`paneId`** — looks like `%123`. Sources:
  - `get_feature_status` → `panes[].paneId` field
  - tmux/session page pane lists → `paneId`
  - Pass the literal `%123` form. The tool will encode it for the browser, where it appears as `%25123`; see `references/url-encoding.md`.
- **`sessionName` / `windowName`** — straight from tmux; the user's own tmux session and window names.

### Constructing pane URL in one tool call

To navigate to a managed feature pane, `get_feature_status({ featureId })` returns everything you need:
- `feature.projectSlug` → projectSlug
- `feature.slug` → featureSlug
- `panes[i].paneId` → paneId

Then call `ui_navigate({ path: "/projects/<projectSlug>/features/<featureSlug>/pane/<paneId>" })`.

To navigate to an unmanaged tmux pane, use the full context path:
`/sessions/<sessionName>/windows/<windowName>/pane/<paneId>`. Do not use a
pane-only shortcut; a pane id by itself is not enough UI context.

## When to use

Use `ui_navigate` when the user asks to be taken somewhere, or when drawing
attention to a specific feature / pane / page is the right next step (for
example, after `feature_task_send` you might navigate to the feature's window
so the user can watch).

Don't navigate without a clear reason — pulling the user away from what they
were looking at without explanation is jarring.

## Errors

`ui_navigate` validates the path before navigating and returns
`{ error: "..." }` (NOT `{ ok: true }`) when:
- The path doesn't match any known route pattern.
- The project slug doesn't exist — the error tells you the right field
  (`tmuxSessionName`) and lists known project slugs.
- The feature slug doesn't exist within the named project — same shape,
  with `tmuxWindowName` as the right field.

Treat an error result as authoritative: do NOT pretend the navigation
succeeded. Instead, re-fetch via `list_projects` / `list_features`,
extract the correct slug field, and retry — or tell the user what's
missing if no match exists.
