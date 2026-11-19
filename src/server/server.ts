import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { installProcessErrorHandlers, logError, parseLogLevel, setLogLevel, type LogLevel } from "./platform/logger.js";
import { setStartOverrides } from "./config/start-overrides.js";
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
  -p, --port <n>        HTTP port (default: 4173; 0 takes any free one)
      --host <addr>     Listen address (default: 127.0.0.1).
                        Use 0.0.0.0 for LAN access. Mandate has no auth,
                        so only do this on a trusted network.
      --data-dir <path> Data directory (default: ~/.mandate, env MANDATE_DATA_DIR)
      --log-level <lvl> Runtime log level: silent, error, warn, info, debug
      --parent-pid <n>  Exit when this process is gone (the desktop shell
                        passes its own pid, so a crashed shell leaves no server)

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

function cliLogLevel(value: string | undefined, help: string): LogLevel | undefined {
  if (!value) return undefined;
  const level = parseLogLevel(value);
  if (!level) {
    exitWithError("log level must be one of: silent, error, warn, info, debug", help);
  }
  // From here on, before the config is first read.
  setLogLevel(level);
  return level;
}

/** 0 asks the system for a free port. */
function cliPort(value: string | undefined, help: string): number | undefined {
  if (value === undefined) return undefined;
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!(port <= 65_535)) exitWithError("port must be a whole number from 0 to 65535", help);
  return port;
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

// The flags win over config.json on every read of it; the data dir goes on
// as MANDATE_DATA_DIR, which says where config.json is.
const cli = parseServeCli(rootArgs.slice(1));

if (cli.help) {
  console.log(serveHelp());
  process.exit(0);
}
const logLevel = cliLogLevel(cli["log-level"], serveHelp());
const port = cliPort(cli.port, serveHelp());
setStartOverrides({
  ...(port !== undefined ? { port } : {}),
  ...(cli.host ? { host: cli.host } : {}),
  ...(logLevel ? { logLevel } : {})
});
if (cli["data-dir"]) process.env.MANDATE_DATA_DIR = cli["data-dir"];
const parentPid = parseParentPid(cli["parent-pid"]);
if (parentPid && "error" in parentPid) exitWithError(parentPid.error, serveHelp());


// The server's own modules load once the arguments say it serves: help, the
// version and a wrong argument answer without them.
const [{ loadConfig }, { ConfigFileError }] = await Promise.all([import("./config.js"), import("./config/file-check.js")]);
const startConfig = configOrExit();
// One server per data directory: a second one would share its database and
// run its schedules, dreams and notices again. Taken once config.json has
// been read (a file it cannot use leaves the directory as it was) and before
// anything else of the directory is opened; held until the process ends.
const [{ lockDataDir }, { resolveDataDir: dataDirInEffect }, dataDirInUse] = await Promise.all([
  import("./platform/fs/data-dir-lock.js"),
  import("./platform/fs/data-dir.js"),
  import("./app/data-dir-in-use.js")
]);
const dataDirLock = await lockDataDir(dataDirInEffect());
if (!dataDirLock) {
  const dir = dataDirInEffect();
  console.error(dataDirInUse.dataDirInUseMessage(dir, dataDirInUse.runningHolder(dir)));
  process.exit(dataDirInUse.DATA_DIR_IN_USE_EXIT_CODE);
}
if (!dataDirLock.guarded) console.error(dataDirInUse.dataDirUnguardedMessage(dataDirInEffect(), dataDirLock.reason ?? "unknown"));
exitIfAddressTaken(startConfig);

/** The config the server starts on, or the file's problems and an exit
 *  before anything listens. */
function configOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigFileError)) throw error;
    console.error(`mandate: ${error.message}`);
    process.exit(1);
  }
}
const [
  { createAppContainer },
  { buildApp },
  { formatStartupModelLines, formatStartupOriginLines },
  { removeServerAddress, writeServerAddress },
  { resolveDataDir },
  { stallWatch },
  { createConfigStore },
  { runtimeConfigLines }
] = await Promise.all([
  import("./app/container.js"),
  import("./app/http-app.js"),
  import("./app/startup-log.js"),
  import("./app/server-address-file.js"),
  import("./platform/fs/data-dir.js"),
  import("./platform/diagnostics/stall-watch.js"),
  import("./config/config-store.js"),
  import("./config/runtime-config.js")
]);

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
// The background jobs' pacing the config file changed, as written there.
for (const line of runtimeConfigLines(createConfigStore(dataDir).read().runtime)) {
  console.log(line);
}

container.startBackgroundJobs();
// A stall of the server's one thread is logged with what ran in it.
stallWatch.start();
console.log("[mandate] stall watch: a stall of 100 ms or more is logged with what ran in it");

// Graceful shutdown: the container stops its jobs and lets the tmux runtime
// give back fit leases and take its pipes down (tmux itself outlives us),
// waiting at most half a second for that, before the process exits.
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  stallWatch.stop();
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
