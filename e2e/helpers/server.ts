import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendLine, artifactDir, callerLabel, flush, tail, writeJson } from "./diagnostics.js";
import { MandateStore } from "../../src/server/app/store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { featureMessageReplyMetadata } from "../../src/shared/feature-message.js";

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
  /** Where this server's stdout, stderr and metadata were written. */
  logFile: string;
}

const BINARY = path.join(process.cwd(), "bin", "mandate");
const READY_TIMEOUT_MS = 30_000;

/** Ask the OS for a port and immediately give it back. Racy in principle;
 *  in a container running one suite it is the cheap answer, and a collision
 *  surfaces as a boot failure rather than a wrong result. */
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

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
    maxStepsPerWake: 200,
    compressionThresholdTokens: 170000
  }
};

export interface StartServerOptions {
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

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-server-"));
  if (options.configured) {
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(SEED_CONFIG, null, 2));
  }
  options.seed?.(dataDir);
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
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
  spawn("sh", [
    "-c",
    `exec "$MD_BIN" serve >>"$MD_LOG" 2>&1 & echo $! > "$MD_PID"`
  ], {
    env: {
      ...process.env,
      PORT: String(port),
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
    label, port, baseUrl, dataDir, pid, binary: BINARY,
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
    try {
      const res = await fetch(`${baseUrl}/api/settings/config`, {
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok) {
        appendLine(logFile, `ready after ${Date.now() - spawnedAt}ms on ${baseUrl}`);
        writeMeta({ readyMs: Date.now() - spawnedAt });
        return { baseUrl, dataDir, cleanup, logFile };
      }
      appendLine(logFile, `not ready: /api/settings/config answered ${res.status}`);
    } catch { /* not listening yet */ }
    await Bun.sleep(150);
  }

  writeMeta({ failure: "readiness timeout" });
  cleanup();
  throw new Error(
    `server did not answer on ${baseUrl} within ${READY_TIMEOUT_MS}ms; log at ${logFile}\n${tail(logFile)}`
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
export function seedManagerThread(dataDir: string, count = 60): void {
  const store = new MandateStore(dataDir);
  try {
    const agent = new AgentStore(store.db);
    const thread = agent.getOrCreateThread("manager", null);
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
  options: { featureName?: string; paragraphs?: number } = {}
): void {
  const { featureName = "research-chat-tool-timestamps", paragraphs = 12 } = options;
  const store = new MandateStore(dataDir);
  try {
    const agent = new AgentStore(store.db);
    const thread = agent.getOrCreateThread("manager", null);
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
        text: body,
        metadata: featureMessageReplyMetadata({ featureId: "feat-e2e", featureName })
      }
    });
  } finally {
    store.db.close();
  }
}
