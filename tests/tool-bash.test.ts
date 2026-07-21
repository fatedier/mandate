import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bashTool, createBashTool } from "../src/server/modules/agent/tools/bash.js";
import { createShellCommandRunner } from "../src/server/platform/process/shell-command-runner.js";

// Never let unit tests route through the module-level singleton runner: it
// captures the developer's real login shell (sourcing their rc files) and
// writes a snapshot into the real data dir. Tests get an isolated runner
// with a scratch HOME and snapshot dir instead.
const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "tool-bash-home-"));
const isolatedTool = createBashTool({
  runner: createShellCommandRunner({
    shell: { path: "/bin/bash", type: "bash" },
    snapshotDir: isolatedHome,
    captureEnv: { HOME: isolatedHome, PATH: "/usr/bin:/bin" }
  })
});

const ctx = {
  threadId: "t",
  wakeId: "w",
  scope: {
    kind: "worker" as const,
    feature: { id: "f", workingDir: "/tmp" } as any,
    project: { workingDir: "/tmp" } as any
  }
};

test("bashTool: captures stdout + zero exit code", async () => {
  const r = await isolatedTool.handler({ command: "echo hi" }, ctx as any);
  expect(r).toContain("stdout:\nhi");
  expect(r).toContain("exitCode: 0");
});

test("bashTool: captures stderr + non-zero exit", async () => {
  const r = await isolatedTool.handler({ command: "ls /no/such/path" }, ctx as any);
  expect(r).toContain("stderr:\n");
  expect(r).toMatch(/exitCode: [1-9]/);
});

test("bashTool: respects cwd", async () => {
  const r = await isolatedTool.handler({ command: "pwd", cwd: "/tmp" }, ctx as any);
  expect(r).toMatch(/stdout:\n\/(private\/)?tmp/);
});

test("bashTool: allows system temp cwd outside project scope", async () => {
  const nonTmpCtx = {
    ...ctx,
    scope: {
      kind: "worker" as const,
      feature: { workingDir: path.resolve(".") },
      project: { workingDir: path.resolve(".") }
    }
  };
  const r = await isolatedTool.handler({ command: "printf ok", cwd: os.tmpdir() }, nonTmpCtx as any);
  expect(r).toContain("stdout:\nok");
  expect(r).toContain("exitCode: 0");
});

test("bashTool: kills on timeout", async () => {
  const r = await isolatedTool.handler({ command: "sleep 5", timeout: 200 }, ctx as any);
  expect(r).toMatch(/stderr:\n.*timed?[ -]?out/is);
  expect(r).toMatch(/exitCode: -?\d+/);
});

test("bashTool: supports an injectable shell command runner", async () => {
  const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  const tool = createBashTool({
    runner: {
      async run(command, options) {
        calls.push({ command, cwd: options.cwd, timeoutMs: options.timeoutMs });
        return { stdout: "runner", stderr: "", exitCode: 0 };
      }
    }
  });

  const r = await tool.handler({ command: "echo ignored", timeout: 123 }, ctx as any);

  expect(r).toContain("stdout:\nrunner");
  expect(calls).toEqual([{ command: "echo ignored", cwd: "/tmp", timeoutMs: 123 }]);
});

test("bashTool: description points feature pane lifecycle to Mandate tools", () => {
  expect(bashTool.description).toMatch(/do not use bash to manage Mandate pane\s+lifecycle/);
  expect(bashTool.description).toMatch(/raw tmux/);
  expect(bashTool.description).toMatch(/spawn_pane/);
  expect(bashTool.description).toMatch(/kill_pane/);
});
