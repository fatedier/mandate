# AGENTS.md

Guidance for coding agents working on Mandate, a local-first dashboard and
runtime for coordinating coding agents, with an optional Tauri desktop shell.

## Project map

- `src/client/`: React and TypeScript UI, built with Vite and Tailwind.
- `src/shared/`: contracts and utilities shared by client and server.
- `src/server/platform/`: low-level SQLite, tmux, Git, filesystem, and process code.
- `src/server/modules/`: domain behavior, routes, stores, tools, and schemas.
- `src/server/runtime/`: agent execution and runtime coordination.
- `src/server/app/`: application wiring and server infrastructure.
- `src-tauri/`: Rust desktop shell and sidecar build scripts.
- `tests/`: Bun tests; `e2e/`: Docker-based tests of the compiled application.
- `scripts/`: build and smoke-test entry points.

## Development entry points

Use Bun and the versions declared in [package.json](package.json). Install with
`bun install --frozen-lockfile`. See [README.md](README.md) for setup and app usage.

- `bun run dev`: local API and web development servers.
- `bun run typecheck`, `bun run typecheck:server`, `bun run typecheck:tests`:
  separate TypeScript checks; the first does not check server or test code.
- `bun run lint`: TypeScript and React lint rules.
- `bun run test`: the full `tests/` suite.
- `bun run test:e2e [files]`: build and run the Docker E2E suite, or the files named.
- `bun run build:binary`: compile the server with its client and built-in skills.
- `bun run tauri:build -- --app`: build the macOS desktop app.

Test selection, focused commands, isolation, and diagnostics are documented in
[Testing](docs/agents/testing.md).

## Code and architecture

- Keep changes focused on the requested behavior. Follow nearby code and keep
  helpers with their owner; extract shared code when there are real consumers.
- `platform/` is the server's bottom layer. It must not import `modules/`,
  `runtime/`, or `app/`, even for types. Pass dependencies in from above. The
  boundary is also recorded in [eslint.config.js](eslint.config.js).
- Extend the owning module and its `module.ts` contributions. Use the existing
  [module registry](src/server/modules/registry.ts) for application integration.
- Update shared contracts and their client/server consumers together. Preserve
  stored data compatibility when changing SQLite schemas or configuration.
- Reuse the existing UI components and styling conventions. Check visible
  changes in relevant layouts and light/dark themes.
- Write code comments and checked-in documentation in English. Explain
  non-obvious constraints rather than restating the code.
- Test observable behavior at the boundary that owns it. Extend relevant tests
  for behavioral changes; avoid tests that merely mirror implementation text.

## Local data and public content

- Use temporary data directories, fixtures, and task-owned processes for tests.
  Preserve the user's running app, tmux sessions, worktrees, and databases.
- `bun run dev` defaults to `~/.mandate-dev`; the standalone binary and desktop
  app default to `~/.mandate`. These are persistent data directories, not test
  fixtures. Use `MANDATE_DATA_DIR` and a free port to isolate manual validation;
  [Testing](docs/agents/testing.md) has the command.
- Never commit credentials, OAuth tokens, local configuration, databases,
  conversation exports, or private working notes. Keep both Git and Docker
  exclusions effective when adding files or changing packaging.
- Use synthetic data and generic paths, usernames, hostnames, and model aliases
  in examples and fixtures. Public provider/model identifiers are fine. Sanitize
  logs and screenshots before including them in shared documentation or reports.
- Keep public guidance self-contained; do not depend on ignored private notes
  or paths outside this repository.

## Workflow and skills

- Development is local. Preserve unrelated edits and the user's staging choices.
- Follow the requested stage: discussion and read-only review stay read-only;
  implementation includes verification; commit, amend, history rewriting, and
  push require a request covering that action. Continue already-authorized
  steps without asking again. PRs, remote synchronization, and CI are not
  prerequisites for completing local development.
- Use [dev-workflow](.agents/skills/dev-workflow/SKILL.md) for implementation and
  local commit work. It delegates verification to
  [preflight](.agents/skills/preflight/SKILL.md).
- After independently completing a feature or refactor, run preflight before
  reporting completion. During discussion or iterative small fixes, run focused
  checks; run full preflight when requested.
- Documentation and agent-instruction changes need command/link validation and
  `git diff --check`. Changes to ignore rules also need exclusion checks. Build,
  Docker, configuration, and executable script changes need relevant behavioral
  validation even if they accompany documentation.
- Repository development skills live in `.agents/skills/`. The matching entries
  in `.claude/skills/` are relative symlinks; edit the canonical files only.
- Product skills live in `src/server/modules/skills/builtins/` and are embedded
  in the binary. Keep development workflows separate from those runtime skills.
- Keep this file focused on stable rules. Update linked guides and skills when
  their commands, paths, or workflows change.
