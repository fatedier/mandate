import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

// Each run is a process of its own, so the tests run side by side. Every
// run here ends by itself in well under a second; one that started serving
// instead (a regression) is ended, never left listening.
const RUN_LIMIT_MS = 4_000;

/** A data dir holding `config` as its config.json, for one run; removed by
 *  the test itself (these tests run side by side, and the shared cleanup
 *  after each would remove another's while it runs). */
async function withConfig<T>(config: string, run: (dir: string, file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "md-cli-config-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, config);
  try {
    return await run(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runCli(args: string[]) {
  const child = Bun.spawn([process.execPath, "src/server/server.ts", ...args], {
    cwd: repoRoot,
    // The file's scratch data dir (tests/setup.ts), never one in the checkout.
    env: {
      ...process.env,
      MANDATE_DATA_DIR: process.env.MANDATE_DATA_DIR,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const limit = setTimeout(() => child.kill(), RUN_LIMIT_MS);
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { status, stdout, stderr };
  } finally {
    clearTimeout(limit);
  }
}

test.concurrent("cli: root help lists serve command", async () => {
  const result = await runCli(["--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage: mandate <command> [options]");
  expect(result.stdout).toContain("serve");
  expect(result.stdout).not.toContain("worker");
});

test.concurrent("cli: serve help lists server options", async () => {
  const result = await runCli(["serve", "--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage: mandate serve [options]");
  expect(result.stdout).toContain("--host <addr>");
  expect(result.stdout).toContain("--data-dir <path>");
  expect(result.stdout).toContain("--log-level <lvl>");
  // Settings live in config.json and the flags; no environment section.
  expect(result.stdout).not.toContain("Environment:");
  expect(result.stdout).not.toMatch(/PORT|MANDATE_(?!DATA_DIR)/);
  expect(result.stdout).toContain("env MANDATE_DATA_DIR");
});

// The flags reach the config the server starts from, and beat the file's
// values: a taken port is named as the one the flag gave, on the flag's
// host. No server starts (the flag's port is taken, and the file's host is a
// documentation address no machine binds), so the run ends at once.
test.concurrent("cli: --port and --host beat config.json", async () => {
  const taken = [0, 1].map(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) }));
  try {
    const result = await withConfig(JSON.stringify({ server: { port: taken[0]!.port, host: "192.0.2.1" } }), (dir) =>
      runCli(["serve", "--data-dir", dir, "--host", "127.0.0.1", "--port", String(taken[1]!.port)]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`mandate: could not listen on http://127.0.0.1:${taken[1]!.port}: the address is already in use`);
  } finally {
    for (const server of taken) server.stop(true);
  }
});

// What was removed stays removed: the remote worker command, and server
// options given without a command.
test.concurrent.each([
  { what: "worker is no longer a recognized command", args: ["worker", "--help"] },
  { what: "old bare server options are rejected", args: ["--host", "127.0.0.1"] }
])("cli: $what", async ({ args }) => {
  const result = await runCli([...args]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`mandate: unknown command "${args[0]}"`);
  expect(result.stderr).toContain("Usage: mandate <command> [options]");
});

test.concurrent("cli: root version still works", async () => {
  const result = await runCli(["--version"]);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test.concurrent("cli: bare mandate is not a serve alias", async () => {
  const result = await runCli([]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("mandate: missing command");
  expect(result.stderr).toContain("Usage: mandate <command> [options]");
});

test.concurrent.each(["abc", "70000", "-1", "41.5", ""])("cli: --port %p is refused before anything starts", async (port) => {
  const result = await runCli(["serve", `--port=${port}`]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("mandate: port must be a whole number from 0 to 65535");
  expect(result.stderr).toContain("Usage: mandate serve [options]");
});

// A config.json the server cannot use stops it before it listens, saying
// which file and what is wrong. Every file here fails, so nothing serves;
// were one taken by mistake, `--port 0` keeps it off a fixed port.
test.concurrent("cli: a config.json value it cannot use stops the start with each problem", async () => {
  const { file, result } = await withConfig(JSON.stringify({ server: { port: "4777" }, logging: { level: "verbose" } }), async (dir, file) =>
    ({ file, result: await runCli(["serve", "--data-dir", dir, "--port", "0"]) }));

  expect(result.status).toBe(1);
  expect(result.stderr).toBe([
    `mandate: ${file} has 2 errors:`,
    '  server.port: must be a whole number from 0 to 65535 (it is "4777")',
    '  logging.level: must be one of silent, error, warn, info, debug (it is "verbose")',
    ""
  ].join("\n"));
});

test.concurrent("cli: a config.json that is not JSON stops the start with the parser's reason", async () => {
  const { file, result } = await withConfig('{ "port": 4777, }', async (dir, file) =>
    ({ file, result: await runCli(["serve", "--data-dir", dir, "--port", "0"]) }));

  expect(result.status).toBe(1);
  expect(result.stderr).toStartWith(`mandate: ${file} is not valid JSON: `);
  expect(result.stderr.split("\n").filter(Boolean)).toHaveLength(1);
});

test.concurrent("cli: invalid log level is rejected", async () => {
  const result = await runCli(["serve", "--log-level", "verbose"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("mandate: log level must be one of");
  expect(result.stderr).toContain("Usage: mandate serve [options]");
});
