import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { createAppContainer } from "./app/container.js";
import { buildApp } from "./app/http-app.js";
import { formatStartupModelLines } from "./app/startup-log.js";
import { installProcessErrorHandlers, logError, parseLogLevel, setLogLevel } from "./platform/logger.js";
import { parseParentPid, watchParent } from "./platform/process/parent-watch.js";

type ServeCli = {
  help?: boolean;
  port?: string;
  host?: string;
  "data-dir"?: string;
  "log-level"?: string;
  "parent-pid"?: string;
};

installProcessErrorHandlers();

function rootHelp() {
  return `mandate v${pkg.version} - tmux-aware coding agent

Usage: mandate <command> [options]

Commands:
  serve                 Start the Mandate HTTP server

Options:
  -h, --help            Show this help and exit
  -v, --version         Print version and exit

Run "mandate <command> --help" for command-specific options.
`;
}

function serveHelp() {
  return `mandate v${pkg.version} - tmux-aware coding agent

Usage: mandate serve [options]

Options:
  -h, --help            Show this help and exit
  -p, --port <n>        HTTP port (default: 4173, env PORT)
      --host <addr>     Listen address (default: 127.0.0.1, env MANDATE_HOST).
                        Use 0.0.0.0 for LAN access. Mandate has no auth,
                        so only do this on a trusted network.
      --data-dir <path> Data directory (default: ~/.mandate, env MANDATE_DATA_DIR)
      --log-level <lvl> Runtime log level: silent, error, warn, info, debug
      --parent-pid <n>  Exit when this process is gone (the desktop shell
                        passes its own pid, so a crashed shell leaves no server)

Environment:
  PORT                  Listen port (overridden by --port)
  MANDATE_HOST          Listen address (overridden by --host)
  MANDATE_DATA_DIR      Data directory (overridden by --data-dir)
  MANDATE_LOG_LEVEL     Runtime log level (overridden by --log-level)
  MANDATE_DEBUG         Set to 1/true to enable debug logs when no log level is set

Agent provider + API key live in <data-dir>/config.json.
`;
}

function exitWithError(message: string, help: string): never {
  console.error(`mandate: ${message}`);
  console.error("");
  console.error(help);
  process.exit(1);
}

function parseServeCli(args: string[]): ServeCli {
  try {
    return parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        port: { type: "string", short: "p" },
        host: { type: "string" },
        "data-dir": { type: "string" },
        "log-level": { type: "string" },
        "parent-pid": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values as ServeCli;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithError(message, serveHelp());
  }
}

function applyCliLogLevel(value: string | undefined, help: string) {
  if (!value) return;
  const level = parseLogLevel(value);
  if (!level) {
    exitWithError("log level must be one of: silent, error, warn, info, debug", help);
  }
  process.env.MANDATE_LOG_LEVEL = level;
  setLogLevel(level);
}

const rootArgs = process.argv.slice(2);
const command = rootArgs[0];

if (!command) {
  exitWithError("missing command", rootHelp());
}
if (command === "-h" || command === "--help") {
  console.log(rootHelp());
  process.exit(0);
}
if (command === "-v" || command === "--version") {
  console.log(pkg.version);
  process.exit(0);
}
if (command !== "serve") {
  exitWithError(`unknown command "${command}"`, rootHelp());
}

// CLI args take precedence over env vars. We override process.env so the rest
// of the codebase (loadConfig, resolveDataDir) can stay env-driven.
const cli = parseServeCli(rootArgs.slice(1));

if (cli.help) {
  console.log(serveHelp());
  process.exit(0);
}
applyCliLogLevel(cli["log-level"], serveHelp());
if (cli.port) process.env.PORT = cli.port;
if (cli.host) process.env.MANDATE_HOST = cli.host;
if (cli["data-dir"]) process.env.MANDATE_DATA_DIR = cli["data-dir"];
const parentPid = parseParentPid(cli["parent-pid"]);
if (parentPid && "error" in parentPid) exitWithError(parentPid.error, serveHelp());

const container = await createAppContainer();
const { config } = container;
const { app: honoApp, websocket: honoWebsocket } = buildApp(container.httpDeps());

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: honoApp.fetch,
  websocket: honoWebsocket
});

console.log(`Mandate listening on http://${config.host}:${server.port}`);
for (const line of formatStartupModelLines(config)) {
  console.log(line);
}

container.startBackgroundJobs();

// Graceful shutdown: restore tmux fit leases before exit.
// Tmux's dispose is also called here for symmetry, but it's a noop (tmux
// outlives us). Order matters: dispose() is fire-and-forget under signal
// constraints, so we only have ~100ms before exit().
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mandate] received ${signal}, shutting down`);
  try {
    await container.dispose();
  } catch (e) { logError("dispose", e, "dispose failed"); }
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => void gracefulShutdown(sig));
}
if (parentPid && "pid" in parentPid) {
  watchParent({ pid: parentPid.pid, onGone: () => void gracefulShutdown(`parent ${parentPid.pid} exit`) });
}
