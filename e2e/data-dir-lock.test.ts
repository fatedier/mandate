import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DATA_DIR_LOCK_FILE, lockDataDir } from "../src/server/platform/fs/data-dir-lock.js";
import { startServer, type RunningServer } from "./helpers/server.js";

const BINARY = path.join(process.cwd(), "bin", "mandate");
let server: RunningServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(() => {
  server?.cleanup();
});

test("a second server on a data directory in use exits at once, saying which server holds it, and the first goes on", async () => {
  const address = JSON.parse(fs.readFileSync(path.join(server.dataDir, "server.json"), "utf8")) as { pid: number; url: string };
  const second = spawnSync(BINARY, ["serve", "--port", "0"], {
    env: { ...process.env, MANDATE_DATA_DIR: server.dataDir },
    encoding: "utf8",
    timeout: 20_000
  });
  expect(second.status).toBe(75);
  expect(second.stderr.trim()).toBe(
    `mandate: another Mandate server is already using ${server.dataDir} (pid ${address.pid}, ${address.url}). Stop it first, or start this one with --data-dir set to another directory.`
  );
  expect((await fetch(`${server.baseUrl}/api/info`)).ok).toBe(true);
}, 30_000);

test("once that server has stopped, the next one starts on the same directory", async () => {
  await server.stop();
  const next = await startServer({ dataDir: server.dataDir });
  try {
    expect((await fetch(`${next.baseUrl}/api/info`)).ok).toBe(true);
  } finally {
    next.cleanup();
  }
}, 60_000);

// Linux's own case of a unit test (tests/data-dir-lock.test.ts): a POSIX
// record lock goes when its process closes any descriptor of the file, so a
// read of the lock file by the server itself (an agent's read tool) must not
// let another server in.
test("the holding process reading its own lock file keeps the directory held against another process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-lock-"));
  const held = await lockDataDir(dir, { waitMs: 0 });
  try {
    fs.readFileSync(path.join(dir, DATA_DIR_LOCK_FILE));
    const probe = Bun.spawn([process.execPath, path.join(process.cwd(), "tests", "helpers", "data-dir-lock-probe.ts"), dir], { stdout: "pipe", stderr: "pipe" });
    expect((await new Response(probe.stdout).text()).trim()).toBe("REFUSED");
    await probe.exited;
  } finally {
    held?.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
