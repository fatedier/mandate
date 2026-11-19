import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readServerAddress } from "../src/server/app/server-address-file.js";

// The compiled binary on a config.json it cannot use: it says which file and
// what is wrong, and exits before anything listens (no address file, no
// database).

const BINARY = path.join(process.cwd(), "bin", "mandate");

test("the binary stops at start on a config.json it cannot use, saying which file and what is wrong", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-config-check-"));
  const file = path.join(dataDir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ panes: { pollIntervalMs: 100 }, models: { providers: { gw: { type: "smoke-signals" } } } }));
  const server = Bun.spawn([BINARY, "serve", "--port", "0"], {
    env: { ...process.env, MANDATE_DATA_DIR: dataDir },
    stdout: "pipe", stderr: "pipe"
  });
  try {
    const ended = await Promise.race([server.exited, Bun.sleep(10_000).then(() => "still running after 10s" as const)]);
    expect(ended).toBe(1);
    expect(await new Response(server.stderr).text()).toBe([
      `mandate: ${file} has 2 errors:`,
      "  panes.pollIntervalMs: must be a whole number from 500 to 2147483647 (it is 100)",
      '  models.providers.gw.type: must be one of openai, openai-compatible, kilo, codex, anthropic, google (it is "smoke-signals")',
      ""
    ].join("\n"));
    expect(await new Response(server.stdout).text()).not.toContain("Mandate listening on");
    expect(fs.readdirSync(dataDir)).toEqual(["config.json"]);
  } finally {
    server.kill("SIGKILL");
    await server.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a config.json others could read is its owner's alone once the binary starts", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-config-mode-"));
  const file = path.join(dataDir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ logging: { level: "error" } }));
  fs.chmodSync(file, 0o644);
  const server = Bun.spawn([BINARY, "serve", "--port", "0"], {
    env: { ...process.env, MANDATE_DATA_DIR: dataDir },
    stdout: "pipe", stderr: "pipe"
  });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !readServerAddress(dataDir)) await Bun.sleep(20);
    expect(readServerAddress(dataDir)?.pid).toBe(server.pid);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    server.kill("SIGKILL");
    await server.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
