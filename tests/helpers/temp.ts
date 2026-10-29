import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onCleanup } from "./cleanup.js";

/** A fresh directory under the system temp dir, removed with everything in
 *  it after the test (tests/helpers/cleanup.ts), however the test ends. For
 *  a directory one test uses; a file-wide one still belongs to its
 *  beforeAll/afterAll. */
export function tempDir(prefix = "md-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
