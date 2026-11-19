# Testing Mandate

Run commands from the repository root unless a block explicitly changes directory.
[package.json](../../package.json) owns the Bun entry points;
[preflight](../../.agents/skills/preflight/SKILL.md) owns check selection.

## Prerequisites and static checks

Use the Bun and Node versions declared in `package.json`. Install dependencies
with `bun install --frozen-lockfile`. Docker E2E requires Docker with Compose.
Desktop checks require macOS, its native build tools, and the Rust toolchain in
[src-tauri/rust-toolchain.toml](../../src-tauri/rust-toolchain.toml).

```sh
bun run typecheck
bun run typecheck:server
bun run typecheck:tests
bun run lint
git diff --check
```

The checks cover client/shared, server/shared, and test code respectively.
`typecheck:tests` also includes application source with test compiler settings;
it does not replace the production checks. `bun run build` and
`bun run build:binary` run only the client/shared type check.

`bun run format` rewrites all of `src/` and `tests/`. Prefer formatting only
task-owned files to avoid unrelated changes.

## Bun tests

```sh
# One existing test file; select the file that owns the changed behavior.
bun test ./tests/module-registry.test.ts

# All tests under tests/.
bun run test
```

[bunfig.toml](../../bunfig.toml) sets the test root to `tests/`, so a bare
`bun test` runs only this tier. E2E files run through Docker, never with
`bun test` on the host.

[bunfig.toml](../../bunfig.toml) preloads
[tests/setup.ts](../../tests/setup.ts), including for focused commands. The setup
assigns a temporary `MANDATE_DATA_DIR` per file, installs the DOM environment,
blocks real fetch calls by default, and runs test cleanup. Preserve that isolation;
do not set `MANDATE_TEST_ALLOW_NETWORK=1` for the unit suite. Use the existing
clock, cleanup, and dependency-injection helpers when testing external effects.

Tests under `tests/` never start external programs: no Git, tmux, shells, or
the bash tool's default runner. Inject a fake or an isolated runner instead.
Behavior that needs a real program belongs in the Docker E2E suite.

Wait for observable state or explicit signals instead of fixed sleeps. Keep
fixtures synthetic and clean up task-owned processes, servers, and files.

A matcher that fails on a DOM node prints the node with its whole document,
which has produced logs of 100 MB and more. Assert a boolean, a count, or a read
instead (`=== null`, `.length`, `?.textContent`); `bun run lint` rejects the direct
forms, such as `expect(el.querySelector(…)).toBeNull()`, under `tests/`.

## Docker E2E

```sh
# Build the image and run the full suite.
bun run test:e2e

# Build and run selected files through the same harness.
bun run test:e2e e2e/server.test.ts
```

[scripts/test-e2e.ts](../../scripts/test-e2e.ts) gives each run a Compose
project of its own and removes that project's container, network, and image
afterwards, so several checkouts or worktrees can run the suite at once.

[e2e/Dockerfile](../../e2e/Dockerfile) installs tmux, Git, and Playwright Chromium,
then builds the binary with its embedded client and product skills. Tests use
real sockets and, where relevant, a browser and tmux. A direct Hono handler test
does not cover those boundaries or the embedded asset path.

[e2e/run.ts](../../e2e/run.ts) accepts file paths and passes options to Bun; write
options with values as `--name=value`. It names its files to Bun as paths
(`./e2e/…`), which Bun accepts from outside the `tests/` root. The Compose service enables network access
for local test servers. Model and voice scenarios use test configuration and
stubs; their results do not establish live provider compatibility. Never copy
real provider credentials into the image or its fixtures.

The runner groups diagnostics under `e2e/.artifacts/<run-id>/`. Passing runs
remove their diagnostics; failed or interrupted runs retain them. Inspect the
failed case's server logs, browser output, and captures before retrying. Sanitize
any evidence shared outside the local run.

Pictures taken only to look at a layout are written when
`MANDATE_E2E_CAPTURE_FRAMES=1` is set for the run, for example
`MANDATE_E2E_CAPTURE_FRAMES=1 bun run test:e2e e2e/panel-tabs.test.ts`. The
Compose service passes the variable through, every page also keeps its frame,
and the run keeps its directory even when it passes. Tests take such pictures
with `look` from [e2e/helpers/page-diagnostics.ts](../../e2e/helpers/page-diagnostics.ts).

If a run is killed before its cleanup, remove its project with the
`docker compose -p <project> -f e2e/docker-compose.yml down --rmi local` command
it printed, or the one for the `mandate-e2e-*` project it left. Clean up only
resources owned by this task; do not prune Docker globally or stop another
checkout's environment. Failure artifacts are ignored by Git and excluded from
the Docker build context.

Timing updates are maintenance commands, not normal validation:
`bun run test:timings` and `bun run test:e2e:timings` change timing metadata.

## Build and desktop checks

```sh
# Client bundle.
bun run build

# Server binary with embedded client and product skills.
bun run build:binary
```

A Docker E2E image build already runs `build:binary`; reuse that evidence for the
same source instead of rebuilding needlessly. Runtime skills come from
`src/server/modules/skills/builtins/`. Development skills under `.agents/skills/`
are not part of that embedded skill registry.

For Rust changes, run checks from `src-tauri/` so its toolchain file applies.
Prepare the sidecar first because the Tauri build references it:

```sh
cd src-tauri
bun scripts/prepare-sidecar.ts
cargo fmt --check
cargo check
cargo test
```

For desktop packaging or sidecar integration, run from the repository root:

```sh
bun run tauri:build -- --app
```

The current sidecar script supports macOS ARM64 and x86_64. A successful build
does not prove window, tray, restart, or other desktop interactions. Exercise
affected behavior on macOS with isolated data, and state any untested platform
or interaction. See [README.md](../../README.md) for other bundle modes.

## Manual validation and reporting

Run manual checks on a fresh data directory and a free port. This serves the
built client and the API on that one port:

```sh
bun run build
MANDATE_DATA_DIR="$(mktemp -d)" bun src/server/server.ts serve --port <free port>
```

`bun run dev` cannot run beside another development session: its web server
uses the fixed port 4173, and its API defaults to port 4174 and `~/.mandate-dev`.
Both `~/.mandate-dev` and `~/.mandate` may contain real user data. Do not restart
the user's app or attach destructive checks to existing sessions.

Report the actual commands, outcomes, and remaining gaps. Distinguish focused
tests, the full unit suite, Docker E2E, desktop builds, and live provider checks.
Keep failures visible; a passing retry without a diagnosed cause is not a fix.
