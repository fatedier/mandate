import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { createAppContainer } from "./app/container.js";
import { loadConfig } from "./config.js";
import { buildApp } from "./app/http-app.js";
import { formatStartupModelLines, formatStartupOriginLines } from "./app/startup-log.js";
import { removeServerAddress, writeServerAddress } from "./app/server-address-file.js";
import { resolveDataDir } from "./platform/fs/data-dir.js";
import { installProcessErrorHandlers, logError, parseLogLevel, setLogLevel } from "./platform/logger.js";
import { parseParentPid, watchParent } from "./platform/process/parent-watch.js";
import { errorText } from "../shared/error-text.js";

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
  MANDATE_CHECK_ORIGIN  Set to 0 to accept writes and WebSockets from a page of any
                        site (on by default; see checkOrigin in config.json)

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
    const message = errorText(error);
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

exitIfAddressTaken(loadConfig());

const container = await createAppContainer();
const { config } = container;
const { app: honoApp, websocket: honoWebsocket } = buildApp(container.httpDeps());

const server = await listenOrExit();

/** Binds the port, or says why it could not and ends the process with a
 *  failure. A bind that failed used to be logged as an uncaught error and
 *  the process stayed up, kept alive by what had started before it, with
 *  nothing listening: a second `mandate serve` on a port in use never
 *  returned. */
async function listenOrExit() {
  try {
    return Bun.serve({
      port: config.port,
      hostname: config.host,
      fetch: honoApp.fetch,
      websocket: honoWebsocket
    });
  } catch (error) {
    sayCannotListen(config, error);
    try {
      await container.dispose();
    } catch (e) { logError("dispose", e, "dispose failed"); }
    process.exit(1);
  }
}

/** Tries the address before anything of the data directory is opened. The
 *  application is built before the port is bound, and building it runs the
 *  start-up steps: they take every turn recorded as running for one a dead
 *  server left behind. A second server started by mistake on a running one's
 *  data directory would do that to the turns the first is still running. The
 *  address a data directory is configured with stands guard over it: taken,
 *  this process leaves with nothing touched. A port of 0 is the system's to
 *  choose and cannot be taken.
 *
 *  Tried with the listener the server itself binds, let go at once: the
 *  check then asks exactly what the bind will ask. Another kind of listener
 *  reads some addresses differently (a bracketed IPv6 literal) and would
 *  turn away a server that could have started. */
function exitIfAddressTaken(address: { host: string; port: number }): void {
  if (address.port === 0) return;
  try {
    Bun.serve({ port: address.port, hostname: address.host, fetch: () => new Response(null, { status: 503 }) }).stop?.(true);
  } catch (error) {
    sayCannotListen(address, error);
    process.exit(1);
  }
}

/** Where the server could not listen, and why: in the same words whether the
 *  check before start-up or the bind itself found the address taken. */
function sayCannotListen(address: { host: string; port: number }, error: unknown): void {
  const taken = (error as { code?: unknown } | null)?.code === "EADDRINUSE";
  console.error(`mandate: could not listen on http://${address.host}:${address.port}: ${taken ? "the address is already in use" : errorText(error)}`);
}

console.log(`Mandate listening on http://${config.host}:${server.port}`);
// Where it listens, for whatever started it: the port is the system's choice
// when it was started on port 0. A file that cannot be written costs only
// that: the server runs all the same.
const dataDir = resolveDataDir();
try {
  writeServerAddress(dataDir, { pid: process.pid, host: config.host, port: server.port ?? config.port });
} catch (e) { logError("server address", e, "could not write where the server listens"); }
for (const line of formatStartupOriginLines(config)) {
  console.log(line);
}
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
  try {
    removeServerAddress(dataDir, process.pid);
  } catch (e) { logError("server address", e, "could not remove where the server listened"); }
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => void gracefulShutdown(sig));
}
if (parentPid && "pid" in parentPid) {
  watchParent({ pid: parentPid.pid, onGone: () => void gracefulShutdown(`parent ${parentPid.pid} exit`) });
}
