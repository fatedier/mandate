import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { monitorRunnerFrom } from "../src/server/modules/agent/command-monitor-manager.js";
import { normalizeMonitorOutput } from "../src/server/modules/agent/monitor-output.js";
import { testShellRunner } from "./helpers/shell-runner.js";

// An isolated runner, never the module default: that one captures the
// developer's real login shell and writes into the real data dir.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "md-cmon-real-home-"));
const runner = monitorRunnerFrom(testShellRunner(home));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

test("the monitor runner runs in the given directory and reports exit codes and timeouts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-cmon-real-"));
  try {
    fs.writeFileSync(path.join(dir, "state.txt"), "pending\n");
    expect(await runner.run("cat state.txt", { cwd: dir, timeoutMs: 10_000 })).toMatchObject({ stdout: "pending\n", exitCode: 0, timedOut: false });
    expect((await runner.run("sleep 5", { cwd: dir, timeoutMs: 300 })).timedOut).toBe(true);
    expect(await runner.run("exit 3", { cwd: dir, timeoutMs: 10_000 })).toMatchObject({ exitCode: 3, timedOut: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Three real shells: on a busy machine they took past the default 5 s.
}, 20_000);

test("output past maxOutputBytes is dropped while the command runs: its head kept, or with keepTail its head and tail", async () => {
  const shell = testShellRunner(home);
  const command = "printf HEAD; head -c 2000000 /dev/zero | tr '\\0' 'y'; printf TAIL";
  const head = await shell.run(command, { cwd: "/tmp", timeoutMs: 20_000, maxOutputBytes: 1000 });
  expect(head.stdout).toBe(`HEAD${"y".repeat(996)}`);
  const both = await shell.run(command, { cwd: "/tmp", timeoutMs: 20_000, maxOutputBytes: 1000, keepTail: true });
  // The first half and the last half of what it printed, the rest counted between.
  expect(both.stdout).toBe(`HEAD${"y".repeat(496)}\n... ${2_000_008 - 1000} bytes omitted ...\n${"y".repeat(496)}TAIL`);
  expect(both.exitCode).toBe(0);
});

test("a shell that cannot start says so, however small the output cap", async () => {
  const missing = testShellRunner(home, { shell: { path: "/no/such/bash", type: "bash" } });
  const result = await missing.run("true", { cwd: "/tmp", timeoutMs: 5000, maxOutputBytes: 0, keepTail: true });
  expect(result.exitCode).toBe(-1);
  expect(result.stderr).toContain("/no/such/bash");
});

// A monitor compares the head of what it read: no tail, and no count of what was dropped.
test("the monitor runner asks the shell for the first 256KB of output", async () => {
  const seen: unknown[] = [];
  const adapter = monitorRunnerFrom({ run: async (_command, options) => { seen.push(options); return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; }, spawn: async () => null });
  await adapter.run("true", { cwd: "/tmp", timeoutMs: 1000 });
  expect(seen).toStrictEqual([{ cwd: "/tmp", timeoutMs: 1000, maxOutputBytes: 262_144 }]);
});

test("a monitor's output past its cap reads the same however much more was dropped", async () => {
  const run = (spaces: number) => runner.run(`printf 'ready\\n'; head -c ${spaces} /dev/zero | tr '\\0' ' '`, { cwd: "/tmp", timeoutMs: 20_000 });
  const [a, b] = await Promise.all([run(600_000), run(600_001)]);
  expect(normalizeMonitorOutput(a.stdout)).toBe("ready");
  expect(normalizeMonitorOutput(b.stdout)).toBe(normalizeMonitorOutput(a.stdout));
});

// The case that hid for 45 minutes: a check whose tool rejects a flag. Its
// error is on stderr, and a pipe into grep -q makes the pipeline's status
// grep's: exit 1, nothing on stdout, as "not yet" would be.
test("a real shell keeps a piped check's error on stderr, apart from its empty stdout", async () => {
  const result = await runner.run("sh -c 'echo \"Unknown flag: --jq\" >&2; exit 1' | grep -q success", { cwd: "/tmp", timeoutMs: 10_000 });
  expect([result.exitCode, result.stdout, result.stderr.trim()]).toEqual([1, "", "Unknown flag: --jq"]);
});
