import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "bun:test";

const SRC = path.join(import.meta.dir, "..", "src");
// Deliberately NOT included: getHost, listHosts, resolveHost, parseHost —
// those are exactly the names a legitimate HTTP listen-address parser would
// carry, and `--host` / `MANDATE_HOST` (the `mandate serve` listen address)
// are staying. Adding them would trade a real guard for a latent false
// positive against code that's supposed to stay. Do not "complete" this list.
const FORBIDDEN = /hostId|host_id|HostsStore|hostsStore|HostRegistry|hostRegistry|hostsModule|remoteWorker|RemoteWorker|buildWorkerApp|probeSshWorkerHost|HostDto|HostCapabilities|localHostDto|hostDtoFromRow|normalizeHostId|RawHostRow|ensureWorkerConnection|waitForWorkerReady|buildWorkerServerApp|MANDATE_WORKER_/;

// These two migrations drop the `host_id` column(s) that the remote-host
// feature left behind, so they necessarily name the identifier they're
// removing. Exempted by exact relative path (not a `**/migrations.ts`
// pattern) so a future migrations.ts elsewhere in the tree is still caught.
//
// The exemption is narrow: only the literal `host_id` text is excused in
// these two files (see `isOffendingLine` below). Every other identifier on
// the forbidden list — HostsStore, RemoteWorker, etc. — is still live here,
// so a reintroduction that happened to land in one of these two files is
// still caught.
const EXEMPT = new Set([
  "server/modules/projects/migrations.ts",
  "server/modules/panes/migrations.ts",
]);

function isOffendingLine(line: string, isExempt: boolean): boolean {
  if (!isExempt) return FORBIDDEN.test(line);
  // Test the line with `host_id` removed from consideration, rather than
  // testing whether the line contains `host_id`. That way a line carrying
  // both `host_id` (legitimate here) and something else forbidden (e.g.
  // `HostsStore`) still gets caught for the something-else.
  return FORBIDDEN.test(line.replace(/host_id/g, ""));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("exempted migration files still exist", () => {
  // If either file is renamed or deleted, the exemption below would
  // silently widen to cover nothing while this test kept passing. Pin
  // their existence explicitly so that drift is caught here instead.
  for (const rel of EXEMPT) {
    const full = path.join(SRC, rel);
    expect(fs.existsSync(full)).toBe(true);
  }
});

test("no remote-host identifiers survive in src/", () => {
  const files = sourceFiles(SRC);
  // Without this the walk could pass by looking at nothing at all — a wrong
  // SRC path, a changed extension — and read exactly like a clean result.
  expect(files.length).toBeGreaterThan(300);

  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(SRC, file);
    const isExempt = EXEMPT.has(rel);
    const text = fs.readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      if (isOffendingLine(line, isExempt)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});
