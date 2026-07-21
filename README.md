# Mandate

A local-first dashboard and runtime for coordinating coding agents — manage multiple workers per project, watch their tmux panes, talk to them by voice, and inspect delegated feature work. Optional Tauri desktop wrapper.

## Project layout

```text
src/client/   React 19 + TypeScript dashboard UI (Vite, Tailwind v4, shadcn primitives)
src/server/   Bun + Hono HTTP API, tmux runtime, window analysis, SQLite storage
src-tauri/    Rust shell that spawns the server as a sidecar
tests/        Bun test files
assets/       Brand assets served at /
```

## Quick start

Requires [Bun](https://bun.com) 1.3 or later, Node.js 22.22 or later for development tools, and tmux for terminal panes.

### Dev (web)

```sh
bun install
bun run dev
```

Open `http://localhost:4173`. Vite serves the UI on `4173` and proxies API calls to the local server on `4174`.
Development uses `~/.mandate-dev` as its data directory by default. Set `MANDATE_DATA_DIR` to use another directory.

Type checks use TypeScript 7 via the `@typescript/native` package alias. The
`typescript` alias provides the TypeScript 6 compatibility API required by ESLint,
following [Microsoft's side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).
The scripts run the compiler, Vite, and Tauri CLI with Bun so their native packages match the
architecture used by `bun install`, including when Node runs under Rosetta.

### Single binary

```sh
bun run build:binary
./bin/mandate serve
```

Embeds the static client + built-in skills via Bun's `--compile`. The resulting binary works from any directory.
The build defaults to the current OS and architecture. Use `--target` and `--out` to cross-compile, for example:

```sh
bun scripts/build-binary.ts --target bun-linux-x64 --out bin/mandate-linux-x64
```

Add `--skip-client` to reuse an existing `dist/client` build.

### Desktop app (Tauri)

```sh
bun run tauri:dev      # dev mode
bun run tauri:build    # production macOS .dmg
bun run tauri:build -- --app  # .app bundle for local testing
bun run tauri:build -- --zip  # .app bundle plus zip for sharing
```

The Tauri shell spawns the bundled Mandate binary as a sidecar on a random local port and injects the base URL into the client. No external server needed.

On macOS, the default production build creates
`src-tauri/target/<target-triple>/release/bundle/dmg/Mandate_*.dmg`.
Use `--app` or `--zip` when you specifically need the raw `.app` bundle or a zip archive.

### CLI options (`mandate serve`)

```text
-p, --port <n>        HTTP port (default: 4173, env PORT)
    --host <addr>     Listen address (default: 127.0.0.1, env MANDATE_HOST).
                      Use 0.0.0.0 for LAN access. Mandate has no auth, so
                      only do this on a trusted network.
    --data-dir <path> Data directory (default: ~/.mandate, env MANDATE_DATA_DIR)
```

## AI providers

The dashboard works without AI, but status quality and the agent's usefulness depend on a model.

**Recommended:** open the Settings page in the UI (`/settings`) and configure providers there — it handles secrets, saves `config.json` in the active data directory, and walks you through Codex OAuth.

Default data directories:

| Run mode | Data directory |
| --- | --- |
| `bun run dev` | `~/.mandate-dev` |
| `./bin/mandate serve` or the desktop app | `~/.mandate` |

`MANDATE_DATA_DIR` overrides these defaults. Configuration, OAuth tokens, the database, and user skills all live in the active data directory.

**Manual:** create or edit `config.json` in that directory. To bootstrap development from the example:

```sh
mkdir -p ~/.mandate-dev
cp config.example.json ~/.mandate-dev/config.json
```

For the standalone binary or desktop app, use `~/.mandate` in both commands instead.

Config shape (excerpt):

```json
{
  "models": {
    "default": {
      "model": "openai/gpt-5.5"
    },
    "providers": {
      "openai": { "type": "openai", "apiKey": "sk-..." },
      "codex": { "type": "codex" }
    }
  },
  "logging": { "level": "info" },
  "agent": { "managerModel": "openai/gpt-5.5", "workerModel": "openai/gpt-5.5" }
}
```

Model references use `provider-name/model-id`. Provider names are user-defined keys under `models.providers`.

Supported provider `type` values:

- `openai` — OpenAI API.
- `openai-compatible` — any OpenAI-compatible endpoint.
- `openrouter` — OpenRouter.
- `kilo` — Kilo Gateway. Set `organizationId` when your Kilo account requires `X-KiloCode-OrganizationId`.
- `codex` — OpenAI Codex (ChatGPT) OAuth. Add the provider, save settings, then sign in from Settings. Tokens are stored in `auth.json` in the active data directory, not in `config.json`.
- `anthropic` — Anthropic Messages API.
- `google` — Google Generative AI.

`agent.logRequests` controls low-level agent LLM call persistence in `mandate.db`:

- `metadata` — provider/model, scope, timing, usage, errors, request metadata. No prompts/responses.
- `full` — also store redacted request, response, and structured output JSON.
- `off` — disable logging.

`logging.level` controls runtime service logs. Supported values are `silent`, `error`, `warn`, `info`, and `debug`; the default is `info`.

## License

Mandate is licensed under the Apache License 2.0. See [LICENSE](LICENSE).

### Environment overrides

Most config can come from environment variables (overriding `config.json`):

| Variable                                                                                                                                                        | Maps to                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `PORT` / `MANDATE_HOST`                                                                                                                                         | `port` / `host`                       |
| `MANDATE_DATA_DIR`                                                                                                                                              | data directory (`~/.mandate-dev` for `bun run dev`; otherwise `~/.mandate`) |
| `MANDATE_LOG_LEVEL`, `MANDATE_DEBUG=1`                                                                                                                          | runtime service log level             |
| `MANDATE_SKIP_MIGRATIONS`                                                                                                                                       | comma-separated migration ids to skip |
| `MANDATE_POLL_INTERVAL_MS`, `MANDATE_CAPTURE_LINES`                                                                                                             | tmux poller                           |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`                                                                                           | provider-default keys                 |

`MANDATE_SKIP_MIGRATIONS` is the escape hatch for a database migration that fails at startup: the error names the id, and listing it here starts the server without it. A skipped migration is deliberately not recorded as applied, so dropping the variable retries it.

## Voice mode

Mandate supports a real-time voice session that drives the manager. Provider in `voice` block (OpenAI Realtime today, with optional Codex realtime if your provider supports it). Open the chat drawer, tap the mic, talk; barge-in (interrupt the model mid-response by speaking) is supported. Mobile renders the active session as a draggable pill so it doesn't occupy half the screen.

Configure provider, voice, model, language, and idle/max session timeouts under Settings → Voice or in the `voice` block of `config.json`.

## Custom skills

Mandate ships with a handful of built-in skills (focused references the agents load on demand). You can add your own at `skills/<skill-name>/SKILL.md` under the active data directory. The format matches Anthropic's Skills format:

```text
<data-dir>/skills/
  my-skill/
    SKILL.md            # required (YAML frontmatter + body)
    references/         # optional supporting docs
    scripts/            # optional (display-only — Mandate does not execute)
```

`SKILL.md` frontmatter:

```yaml
---
name: my-skill
description: One-line description that the agent sees.
scope: [manager, worker] # optional; defaults to both (legacy values overview/feature still accepted)
---
```

User skills override built-ins of the same name. Restart the server to pick up changes (or use `MANDATE_SKILLS_DIR` to point at additional dirs).

## Runtimes

Mandate spawns and observes panes inside a tmux session per project. Pros: long-running processes survive a Mandate restart, you can `tmux attach` from another terminal, and pane state stays visible through the local analysis pipeline.
