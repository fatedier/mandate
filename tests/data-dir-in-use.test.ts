import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DATA_DIR_IN_USE_EXIT_CODE, dataDirInUseMessage, dataDirUnguardedMessage, runningHolder } from "../src/server/app/data-dir-in-use.js";
import { writeServerAddress } from "../src/server/app/server-address-file.js";
import { onCleanup } from "./helpers/cleanup.js";

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-data-dir-in-use-"));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the refusal names the server that holds the directory, by its pid and address", () => {
  const dir = freshDir();
  writeServerAddress(dir, { pid: 4242, host: "127.0.0.1", port: 4175 });
  const holder = runningHolder(dir, { exists: (pid) => pid === 4242, self: 1 });
  expect(dataDirInUseMessage(dir, holder)).toBe(
    `mandate: another Mandate server is already using ${dir} (pid 4242, http://127.0.0.1:4175). Stop it first, or start this one with --data-dir set to another directory.`
  );
});

test("with no live server named in the directory (none, a dead one, this one), the refusal says only the directory", () => {
  const plain = (dir: string) =>
    `mandate: another Mandate server is already using ${dir}. Stop it first, or start this one with --data-dir set to another directory.`;
  const none = freshDir();
  expect(dataDirInUseMessage(none, runningHolder(none, { exists: () => true, self: 1 }))).toBe(plain(none));
  const dead = freshDir();
  writeServerAddress(dead, { pid: 4242, host: "127.0.0.1", port: 4175 });
  expect(dataDirInUseMessage(dead, runningHolder(dead, { exists: () => false, self: 1 }))).toBe(plain(dead));
  const own = freshDir();
  writeServerAddress(own, { pid: 4242, host: "127.0.0.1", port: 4175 });
  expect(dataDirInUseMessage(own, runningHolder(own, { exists: () => true, self: 4242 }))).toBe(plain(own));
});

test("the exit code is one of its own, so the desktop shell does not restart into the same refusal", () => {
  expect(DATA_DIR_IN_USE_EXIT_CODE).toBe(75);
  // The shell reads the same number (src-tauri/src/lib.rs).
  const shell = fs.readFileSync(path.join(import.meta.dir, "..", "src-tauri", "src", "lib.rs"), "utf8");
  expect(shell.includes(`const DATA_DIR_IN_USE_EXIT: i32 = ${DATA_DIR_IN_USE_EXIT_CODE};`)).toBe(true);
});

test("where the directory cannot be locked, the server says so and why, and runs", () => {
  expect(dataDirUnguardedMessage("/data/mandate", "flock failed with errno 37")).toBe(
    "mandate: could not lock /data/mandate (flock failed with errno 37), so another server started on it would not be stopped."
  );
});
