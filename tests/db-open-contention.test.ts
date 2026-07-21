import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MandateStore } from "../src/server/app/store.js";

const HOLD_MS = 400;
const HELPER = path.join(import.meta.dirname, "helpers", "hold-db-lock.ts");

/** Resolves once the child has printed the line saying it holds the lock. */
async function waitForLock(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("locked")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`lock helper exited without locking: ${seen}`);
    seen += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
}

test("opening a store waits out a lock another connection is holding", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-open-contention-"));
  const child = Bun.spawn([process.execPath, HELPER, path.join(dir, "mandate.db"), String(HOLD_MS)], {
    stdout: "pipe",
    stderr: "inherit"
  });

  try {
    await waitForLock(child.stdout);

    // `pragma journal_mode = wal` takes a brief exclusive lock. Set after it,
    // busy_timeout cannot cover it, and this call fails in about a millisecond
    // with "database is locked" — which is the e2e flake, in miniature.
    const started = Date.now();
    const store = new MandateStore(dir);
    const elapsed = Date.now() - started;
    store.db.close();

    // Having waited is the whole assertion: returning immediately would mean
    // the lock was never held, and the test would be proving nothing.
    expect(elapsed).toBeGreaterThan(HOLD_MS / 2);
  } finally {
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
