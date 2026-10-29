import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendLine, artifactDir, callerLabel, flush, tail, writeJson } from "./diagnostics.js";
import { MandateStore } from "../../src/server/app/store.js";
import { readServerAddress } from "../../src/server/app/server-address-file.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { featureMessageReplyMetadata, type FeatureReplyOutcome } from "../../src/shared/feature-message.js";
import type { Page } from "playwright";

/**
 * Boots the compiled binary and talks to it over a real socket.
 *
 * The unit tier reaches the app through `buildApp().request()`, which hands a
 * Request straight to the Hono handler. That covers routing and never covers
 * the rest: no port is bound, no headers are negotiated, no compression runs,
 * and — the reason this exists — the binary serves its client from a path map
 * baked in at compile time, while a source run falls back to serveStatic on
 * disk. They are different branches, and only one of them ships.
 */

export interface RunningServer {
  baseUrl: string;
  dataDir: string;
  cleanup: () => void;
  /** Stops the server and waits for it to exit, keeping its data directory,
   *  so a second startServer({ dataDir }) can boot on it: a restart. */
  stop: () => Promise<void>;
  /** Where this server's stdout, stderr and metadata were written. */
  logFile: string;
}

const BINARY = path.join(process.cwd(), "bin", "mandate");
const READY_TIMEOUT_MS = 30_000;

/**
 * A config that gets the app past first-run.
 *
 * The key is a placeholder and stays one. Readiness is decided by the shape of
 * the config — a provider exists, the referenced models resolve — and never by
 * calling anyone, so nothing here has to be real. Which is the point: an e2e
 * image is the last place a working credential should live.
 */
const SEED_CONFIG = {
  pollIntervalMs: 2000,
  captureLines: 120,
  logging: { level: "error" },
  models: {
    default: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
    // No price data is downloaded under test: a test that needs prices
    // writes the saved copy itself.
    prices: { autoUpdate: false },
    providers: {
      openai: {
        type: "openai",
        apiKey: "not-a-real-key",
        models: [{ id: "gpt-5.5", input: ["text"], supportsReasoning: true }]
      }
    }
  },
  agent: {
    managerModel: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
    managerModelFallbacks: [],
    workerModel: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
    workerModelFallbacks: [],
    compressionThresholdTokens: 170000
  }
};

/** A named global agent with voice set up, for a page that starts voice. The
 *  realtime endpoint is a closed local port: a session fails at once, inside
 *  the container, and the page goes on as voice does then (reconnecting). */
export function seedNamedAgentWithVoice(config: { agent: Record<string, unknown>; voice?: Record<string, unknown> }): void {
  config.agent.globalAgentName = "Jarvis";
  config.voice = { ...config.voice, apiKey: "not-a-real-key", baseURL: "ws://127.0.0.1:9/v1/realtime" };
}

/** Voice's socket answered by the test with `first`: `{ type: "ready" }` is
 *  a session that is up and quiet. The seeded voice service is a closed
 *  port, which stops voice as soon as it is turned on. With `silentMic`, the
 *  mic is a silent stream, for a browser launched without a fake device. */
export async function fakeVoiceSocket(page: Page, first: Record<string, unknown>, options: { silentMic?: boolean } = {}): Promise<void> {
  if (options.silentMic) {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
    });
  }
  await page.routeWebSocket(/\/api\/voice\/ws/, (ws) => { ws.send(JSON.stringify(first)); });
}

interface StartServerOptions {
  /** Names this server's artifact directory. Defaults to the calling test
   *  file, which is what the reporter prints beside a failure. */
  label?: string;
  /** Write SEED_CONFIG before boot, so the app opens on the product instead
   *  of the setup wizard. */
  configured?: boolean;
  /** Runs against the data directory while the server is still down. Anything
   *  written to the database has to land here: once the binary is up it holds
   *  the store, and a client that already fetched will not go back for rows
   *  that appeared afterwards. */
  seed?: (dataDir: string) => void;
  /** Boot on this existing data directory instead of a fresh one. The last
   *  server started on it owns it: its cleanup() removes it. */
  dataDir?: string;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  if (!fs.existsSync(BINARY)) {
    throw new Error(
      `${BINARY} is missing. The e2e image builds it; if you are running this ` +
      `on a host, run \`bun run build:binary\` first.`
    );
  }

  const label = options.label ?? callerLabel("server");
  const dir = artifactDir(label);
  const logFile = path.join(dir, "server.log");
  const metaFile = path.join(dir, "server.json");

  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-server-"));
  if (options.configured) {
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(SEED_CONFIG, null, 2));
  }
  options.seed?.(dataDir);
  const spawnedAt = Date.now();

  // Started through a shell that exits immediately, so the server is orphaned
  // on purpose and reparented to the container's init.
  //
  // The test runner reaps subprocesses of its own that are still alive at a
  // test boundary — "killed 1 dangling process" — and this server is
  // deliberately longer-lived than the test that starts it: one per file, held
  // across every test in it. When the reaper took it, the log recorded
  // "received SIGTERM, shutting down" mid-file and every later test in that
  // file timed out against a dead port. That is what the suite's intermittent
  // whole-file failures were.
  //
  // Two narrower fixes were tried and measured, and neither worked: `detached:
  // true` gives the child its own process group and it was killed anyway, and
  // spawning through node:child_process instead of Bun.spawn changed nothing.
  // The reaper finds children, so the fix is to not be one. The shell redirects
  // the server's output to the log directly, which is also why nothing here
  // pumps a pipe any more — a pipe held by this process is another tie to it.
  const pidFile = path.join(dataDir, "server.pid");
  // A restart boots on a directory whose pid file names the previous server.
  fs.rmSync(pidFile, { force: true });
  spawn("sh", [
    "-c",
    `exec "$MD_BIN" serve >>"$MD_LOG" 2>&1 & echo $! > "$MD_PID"`
  ], {
    env: {
      ...process.env,
      // The system chooses the port when the server binds, and the server
      // says which (below). This suite used to ask for a free port, give it
      // back and pass it on: two files starting at once could be handed the
      // same one, the loser's server could not bind, and its tests ran
      // against the winner's.
      PORT: "0",
      MANDATE_DATA_DIR: dataDir,
      MD_BIN: BINARY,
      MD_LOG: logFile,
      MD_PID: pidFile
    },
    stdio: "ignore",
    detached: true
  }).unref();

  const pid = await readPid(pidFile);
  let killed = false;
  let died = false;

  // Accumulated, never rebuilt: a later write that reconstructed this object
  // from scratch would erase what an earlier one had established. The first
  // version of this file did exactly that, and the exit handler wiped the
  // readiness time — the one field that said whether the server ever answered.
  const meta: Record<string, unknown> = {
    label, dataDir, pid, binary: BINARY,
    spawnedAt: new Date(spawnedAt).toISOString()
  };
  const writeMeta = (extra: Record<string, unknown> = {}) => {
    Object.assign(meta, { killed, died }, extra);
    writeJson(metaFile, meta);
  };

  // An orphan reports its exit to init, not to us, so liveness is polled
  // instead. A death nobody asked for is the most useful single fact about a
  // failing run and the one the reporter cannot show: the tests carry on
  // against a dead port and fail on whatever they ask for next. Unref'd, so
  // this is never the reason the runner stays open.
  const liveness = setInterval(() => {
    if (killed || died || alive(pid)) return;
    died = true;
    appendLine(logFile, `!! server is gone at ${Date.now() - spawnedAt}ms and we did not kill it`);
    flush(logFile);
    writeMeta({ exitedAt: new Date().toISOString(), aliveMs: Date.now() - spawnedAt });
  }, 250);
  liveness.unref();

  const cleanup = () => {
    killed = true;
    clearInterval(liveness);
    flush(logFile);
    writeMeta();
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  const stop = async () => {
    killed = true;
    clearInterval(liveness);
    flush(logFile);
    writeMeta();
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    // The container's init reaps it, so a dead server stops answering kill(0).
    const until = Date.now() + 10_000;
    while (alive(pid) && Date.now() < until) await Bun.sleep(50);
    if (alive(pid)) throw new Error(`server ${pid} did not exit within 10s of SIGTERM; log at ${logFile}`);
  };

  // Where this server listens, as it says itself: the address file of the
  // process started here. A file naming another process is one a server that
  // died on this directory left behind.
  let baseUrl: string | null = null;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      died = true;
      clearInterval(liveness);
      flush(logFile);
      writeMeta({ failure: "exited during startup" });
      fs.rmSync(dataDir, { recursive: true, force: true });
      throw new Error(
        `server exited during startup; log at ${logFile}\n${tail(logFile)}`
      );
    }
    if (baseUrl === null) {
      const address = readServerAddress(dataDir);
      if (address?.pid === pid) {
        baseUrl = address.url;
        writeMeta({ port: address.port, baseUrl });
      }
    }
    if (baseUrl !== null) {
      try {
        const res = await fetch(`${baseUrl}/api/settings/config`, {
          signal: AbortSignal.timeout(1000)
        });
        if (res.ok) {
          appendLine(logFile, `ready after ${Date.now() - spawnedAt}ms on ${baseUrl}`);
          writeMeta({ readyMs: Date.now() - spawnedAt });
          return { baseUrl, dataDir, cleanup, stop, logFile };
        }
        appendLine(logFile, `not ready: /api/settings/config answered ${res.status}`);
      } catch { /* not answering yet */ }
    }
    await Bun.sleep(baseUrl === null ? 25 : 150);
  }

  writeMeta({ failure: "readiness timeout" });
  cleanup();
  throw new Error(
    `server ${baseUrl === null ? "did not say where it listens" : `did not answer on ${baseUrl}`} within ${READY_TIMEOUT_MS}ms; log at ${logFile}\n${tail(logFile)}`
  );
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The launcher writes the server's pid and exits; this waits for the file it
 *  left behind rather than assuming a fixed delay. */
async function readPid(pidFile: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch { /* not written yet */ }
    await Bun.sleep(25);
  }
  throw new Error(`launcher never wrote a pid to ${pidFile}`);
}

/** Creates a project through the running server's own API, so the app has
 *  something to render. Returns the project row the server replied with. */
export async function seedProject(
  server: RunningServer,
  name = "E2E Project"
): Promise<{ id: string; name: string }> {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-wd-"));
  const res = await fetch(`${server.baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, workingDir })
  });
  if (!res.ok) throw new Error(`seedProject failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ id: string; name: string }>;
}

/**
 * Writes a conversation of `count` messages into a data directory's store.
 *
 * Long enough to matter: the transcript renders only its last
 * INITIAL_RENDER_WINDOW items on mount and releases the rest two frames later,
 * so a thread has to exceed that window before the release does anything worth
 * asserting on.
 */
/** Seeds a manager thread of `count` messages; returns its id (the page is
 *  `/threads/<id>`). */
export function seedManagerThread(dataDir: string, count = 60): string {
  const store = new MandateStore(dataDir);
  try {
    const agent = new AgentStore(store.db);
    const thread = agent.latestManagerThread("Long thread");
    for (let index = 0; index < count; index += 1) {
      agent.appendMessage({
        threadId: thread.id,
        role: index % 2 === 0 ? "user" : "assistant",
        source: "user",
        content: {
          type: "text",
          // Wide enough to wrap, so the thread is several screens tall and the
          // release moves the viewport by an amount a person would notice.
          text: `MSG-${String(index).padStart(3, "0")} ${"lorem ipsum ".repeat(14)}`
        }
      });
    }
    return thread.id;
  } finally {
    store.db.close();
  }
}

/**
 * Appends one feature reply — the message the relay forwards up when a
 * worker finishes. `paragraphs` decides how tall it renders; the point of the
 * seed is usually that it is taller than the transcript is willing to show.
 */
export function seedFeatureReply(
  dataDir: string,
  options: {
    featureName?: string;
    paragraphs?: number;
    /** A turn that ended with no words: the relay's sentence, and what it stores beside it. */
    ended?: { text: string; outcome: FeatureReplyOutcome; detail?: string };
  } = {}
): string {
  const { featureName = "research-row-timestamps", paragraphs = 12, ended } = options;
  const store = new MandateStore(dataDir);
  try {
    const agent = new AgentStore(store.db);
    const thread = agent.latestManagerThread("Feature replies");
    // paragraphs: 0 seeds the other case worth covering — a reply short enough
    // that the transcript should just show it.
    const body = paragraphs === 0
      ? "Acknowledged."
      : Array.from(
          { length: paragraphs },
          (_unused, index) => `PARA-${String(index).padStart(2, "0")} ${"lorem ipsum ".repeat(18)}`
        ).join("\n\n");
    agent.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "feature-message",
      content: {
        type: "text",
        text: ended?.text ?? body,
        // One worker per name: two names are two workers, as in a real thread.
        metadata: featureMessageReplyMetadata({ featureId: `feat-${featureName}`, featureName, outcome: ended?.outcome, detail: ended?.detail })
      }
    });
    return thread.id;
  } finally {
    store.db.close();
  }
}
