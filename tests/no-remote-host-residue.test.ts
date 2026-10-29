import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "bun:test";
import { sourceFiles } from "./helpers/source-files.js";

const SRC = path.join(import.meta.dir, "..", "src");
// Deliberately NOT included: getHost, listHosts, resolveHost, parseHost —
// those are exactly the names a legitimate HTTP listen-address parser would
// carry, and `--host` / `MANDATE_HOST` (the `mandate serve` listen address)
// are staying. Adding them would trade a real guard for a latent false
// positive against code that's supposed to stay. Do not "complete" this list.
const FORBIDDEN = /hostId|host_id|HostsStore|hostsStore|HostRegistry|hostRegistry|hostsModule|remoteWorker|RemoteWorker|buildWorkerApp|probeSshWorkerHost|HostDto|HostCapabilities|localHostDto|hostDtoFromRow|normalizeHostId|RawHostRow|ensureWorkerConnection|waitForWorkerReady|buildWorkerServerApp|MANDATE_WORKER_/;

test("no remote-host identifiers survive in src/", () => {
  const files = sourceFiles(SRC, /\.(ts|tsx)$/);
  // Without this the walk could pass by looking at nothing at all — a wrong
  // SRC path, a changed extension — and read exactly like a clean result.
  expect(files.length).toBeGreaterThan(300);

  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(SRC, file);
    const text = fs.readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      if (FORBIDDEN.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  expect(offenders).toStrictEqual([]);
});
