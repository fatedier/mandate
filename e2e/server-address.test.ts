import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "./helpers/server.js";
import { readServerAddress, serverAddressPath, writeServerAddress, type ServerAddress } from "../src/server/app/server-address-file.js";

// Whatever started a server chose its port for it: this suite asked the
// system for a free port, gave it back, and passed it on, and two files
// starting at once could be handed the same one. The loser's server could not
// bind, and its tests ran against the winner's. A server now says where it
// listens in a file in its data directory, so it can be started on port 0 and
// asked. Only the compiled binary, as a process of its own, shows the file
// appearing with the bound port and going when the process ends.

const BINARY = path.join(process.cwd(), "bin", "mandate");

async function addressIn(dataDir: string, alive: () => boolean): Promise<ServerAddress> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && alive()) {
    const address = readServerAddress(dataDir);
    if (address) return address;
    await Bun.sleep(20);
  }
  throw new Error(`no address in ${dataDir}`);
}

test("started on port 0, a server says where it listens, under its own process id, and takes that away when it stops", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-address-"));
  const server = Bun.spawn([BINARY, "serve"], {
    env: { ...process.env, PORT: "0", MANDATE_DATA_DIR: dataDir },
    stdout: "pipe", stderr: "pipe"
  });
  let ended = false;
  void server.exited.then(() => { ended = true; });
  try {
    const address = await addressIn(dataDir, () => !ended);
    expect(address.pid).toBe(server.pid);
    // The port the system chose, not the 0 it was asked for.
    expect([address.host, address.port > 0, address.url]).toEqual(["127.0.0.1", true, `http://127.0.0.1:${address.port}`]);
    // It is written once the server listens there.
    expect((await fetch(`${address.url}/api/settings/config`)).status).toBe(200);

    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
    expect(fs.existsSync(serverAddressPath(dataDir))).toBe(false);
  } finally {
    server.kill("SIGKILL");
    await server.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("the suite's own servers are started that way: each is found by its process id, whatever a dead server left in the directory", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-address-stale-"));
  // A server that died without taking its file away: a process that is gone,
  // and a port nothing listens on.
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  writeServerAddress(dataDir, { pid: gone.pid, host: "127.0.0.1", port: 9 });
  const server = await startServer({ dataDir, label: "server-address-stale" });
  try {
    const address = readServerAddress(dataDir)!;
    expect([address.pid === gone.pid, address.port === 9]).toEqual([false, false]);
    expect(server.baseUrl).toBe(address.url);
    expect((await fetch(`${server.baseUrl}/api/settings/config`)).status).toBe(200);
    // A restart on the same directory finds the new server, on its own port.
    await server.stop();
    expect(fs.existsSync(serverAddressPath(dataDir))).toBe(false);
    const again = await startServer({ dataDir, label: "server-address-restart" });
    try {
      expect(again.baseUrl).toBe(readServerAddress(dataDir)!.url);
      expect((await fetch(`${again.baseUrl}/api/settings/config`)).status).toBe(200);
    } finally {
      again.cleanup();
    }
  } finally {
    server.cleanup();
  }
}, 90_000);
