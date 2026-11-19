import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DATA_DIR_LOCK_FILE, lockDataDir } from "../src/server/platform/fs/data-dir-lock.js";
import { onCleanup } from "./helpers/cleanup.js";

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-data-dir-lock-"));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a data directory held by one server is refused to a second, and free again once the first lets go", async () => {
  const dir = freshDir();
  const first = await lockDataDir(dir, { waitMs: 0 });
  expect(first === null).toBe(false);
  expect(await lockDataDir(dir, { waitMs: 0 })).toBeNull();
  first!.release();
  const again = await lockDataDir(dir, { waitMs: 0 });
  expect(again === null).toBe(false);
  again!.release();
});

test("two data directories are held apart, and a missing one is made", async () => {
  const a = await lockDataDir(freshDir(), { waitMs: 0 });
  const missing = path.join(freshDir(), "nested", "data");
  const b = await lockDataDir(missing, { waitMs: 0 });
  expect(a === null || b === null).toBe(false);
  expect(fs.existsSync(missing)).toBe(true);
  a!.release();
  b!.release();
});

test("a second one waits a moment: a server that is still stopping as the next starts gives way", async () => {
  const dir = freshDir();
  const leaving = await lockDataDir(dir, { waitMs: 0 });
  setTimeout(() => leaving!.release(), 150);
  const next = await lockDataDir(dir, { waitMs: 2000, pollMs: 20 });
  expect(next === null).toBe(false);
  next!.release();
});

test("one that keeps it past the wait is still refused", async () => {
  const dir = freshDir();
  const held = await lockDataDir(dir, { waitMs: 0 });
  const started = Date.now();
  expect(await lockDataDir(dir, { waitMs: 200, pollMs: 20 })).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  held!.release();
});

/** Whether another process can take the directory now. */
async function probe(dir: string): Promise<string> {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "helpers", "data-dir-lock-probe.ts"), dir], { stdout: "pipe", stderr: "pipe" });
  const said = (await new Response(child.stdout).text()).trim();
  await child.exited;
  return said;
}

test("another process is refused while one holds the directory, and gets it once that one lets go", async () => {
  const dir = freshDir();
  const held = await lockDataDir(dir, { waitMs: 0 });
  expect(await probe(dir)).toBe("REFUSED");
  held!.release();
  expect(await probe(dir)).toBe("GOT");
}, 20_000);

// A POSIX record lock goes when the process closes any descriptor of the
// file: a read of the lock file by the server itself (an agent's read tool)
// must not let a second server in.
test("the holding process reading the lock file itself keeps the directory held", async () => {
  const dir = freshDir();
  const held = await lockDataDir(dir, { waitMs: 0 });
  fs.closeSync(fs.openSync(path.join(dir, DATA_DIR_LOCK_FILE), "r"));
  fs.readFileSync(path.join(dir, DATA_DIR_LOCK_FILE));
  expect(await probe(dir)).toBe("REFUSED");
  held!.release();
}, 20_000);
