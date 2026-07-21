import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, ["src/server/server.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MANDATE_DATA_DIR: path.join(repoRoot, ".tmp-cli-test"),
      MANDATE_DB_DIR: path.join(repoRoot, ".tmp-cli-test"),
    },
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("cli: root help lists serve command", () => {
  const result = runCli(["--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage: mandate <command> [options]");
  expect(result.stdout).toContain("serve");
  expect(result.stdout).not.toContain("worker");
});

test("cli: serve help lists server options", () => {
  const result = runCli(["serve", "--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage: mandate serve [options]");
  expect(result.stdout).toContain("--host <addr>");
  expect(result.stdout).toContain("--data-dir <path>");
  expect(result.stdout).toContain("--log-level <lvl>");
  expect(result.stdout).toContain("MANDATE_LOG_LEVEL");
});

test("cli: worker is no longer a recognized command", () => {
  const result = runCli(["worker", "--help"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('mandate: unknown command "worker"');
  expect(result.stderr).toContain("Usage: mandate <command> [options]");
});

test("cli: root version still works", () => {
  const result = runCli(["--version"]);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("cli: bare mandate is not a serve alias", () => {
  const result = runCli([]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("mandate: missing command");
  expect(result.stderr).toContain("Usage: mandate <command> [options]");
});

test("cli: old bare server options are rejected", () => {
  const result = runCli(["--host", "127.0.0.1"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('mandate: unknown command "--host"');
  expect(result.stderr).toContain("Usage: mandate <command> [options]");
});

test("cli: invalid log level is rejected", () => {
  const result = runCli(["serve", "--log-level", "verbose"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("mandate: log level must be one of");
  expect(result.stderr).toContain("Usage: mandate serve [options]");
});
