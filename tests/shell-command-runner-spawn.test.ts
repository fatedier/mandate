import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ShellProcess } from "../src/server/platform/process/shell-command-runner.js";
import { onCleanup } from "./helpers/cleanup.js";
import { testShellRunner } from "./helpers/shell-runner.js";

// The runner's long-lived handle: a process handed over to whoever keeps it
// (a background command), started by spawn or moved at a foreground call's
// timeout.

const home = mkdtempSync(path.join(os.tmpdir(), "runner-spawn-home-"));
const runner = testShellRunner(home);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("spawn hands over a running process: its output as it comes, its exit code, its pid", async () => {
  const proc = (await runner.spawn("printf 'a\\n'; sleep 0.2; printf 'b'; exit 3", { cwd: "/tmp" }))!;
  const chunks: string[] = [];
  proc.onOutput((c) => chunks.push(c.toString()));
  expect(typeof proc.pid).toBe("number");
  expect(await proc.exited).toEqual({ code: 3, signal: null });
  expect(chunks.join("")).toBe("a\nb");
});

test("output that came before anyone listened is held for the first listener", async () => {
  const proc = (await runner.spawn("printf 'early'", { cwd: "/tmp" }))!;
  await proc.exited;
  let out = "";
  proc.onOutput((c) => { out += c.toString(); });
  expect(out).toBe("early");
});

test("kill takes the whole group down, a child that ignores SIGTERM too", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runner-spawn-kill-"));
  const pidFile = path.join(dir, "child.pid");
  const proc = (await runner.spawn(`/bin/bash -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 30' >/dev/null 2>&1 & wait`, { cwd: "/tmp" }))!;
  for (let i = 0; i < 100 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()); i++) await pause(20);
  const child = Number(readFileSync(pidFile, "utf8").trim());
  onCleanup(() => { if (alive(child)) process.kill(child, "SIGKILL"); });
  proc.kill();
  expect((await proc.exited).signal).toBe("SIGTERM");
  for (let i = 0; i < 200 && alive(child); i++) await pause(20);
  expect(alive(child)).toBe(false);
});

test("detachAtTimeout: at the timeout the process is handed over with its output so far, and run resolves detached", async () => {
  let handed: { proc: ShellProcess; soFar: string } | null = null;
  const result = await runner.run("printf 'early\\n'; sleep 1; printf 'late\\n'", {
    cwd: "/tmp", timeoutMs: 300, detachAtTimeout: (proc, soFar) => { handed = { proc, soFar: soFar.toString() }; }
  });
  expect(result).toMatchObject({ detached: true, timedOut: false, stdout: "early\n" });
  expect(handed!.soFar).toBe("early\n");
  let rest = "";
  handed!.proc.onOutput((c) => { rest += c.toString(); });
  expect(await handed!.proc.exited).toEqual({ code: 0, signal: null });
  expect(rest).toBe("late\n");
});

test("a moved command's output so far is both streams in the order they came, its first and last half MiB when it printed more", async () => {
  let soFar: Buffer = Buffer.alloc(0);
  await runner.run("printf 'out1\\n'; sleep 0.05; printf 'err1\\n' >&2; sleep 0.05; printf 'out2\\n'; sleep 1", {
    cwd: "/tmp", timeoutMs: 400, detachAtTimeout: (proc, bytes) => { soFar = bytes; proc.kill(); }
  });
  expect(soFar.toString()).toBe("out1\nerr1\nout2\n");
  let big: Buffer = Buffer.alloc(0);
  await runner.run("head -c 3000000 /dev/zero | tr '\\0' a; printf END; sleep 2", {
    cwd: "/tmp", timeoutMs: 1000, detachAtTimeout: (proc, bytes) => { big = bytes; proc.kill(); }
  });
  const text = big.toString();
  expect(text).toMatch(/^a{524288}\n\.\.\. \d+ bytes omitted \.\.\.\n/);
  expect(text.endsWith("END")).toBe(true);
  expect(big.length).toBeLessThan(1024 * 1024 + 100);
});

test("without detachAtTimeout a command at its timeout is still killed", async () => {
  const result = await runner.run("sleep 5", { cwd: "/tmp", timeoutMs: 200 });
  expect(result).toMatchObject({ timedOut: true, exitCode: -1 });
  expect(result.detached).toBeUndefined();
});

test("a moved command is no longer the call's to stop: an abort after the move kills nothing", async () => {
  const stop = new AbortController();
  let handed: ShellProcess | null = null;
  await runner.run("sleep 0.6; exit 4", { cwd: "/tmp", timeoutMs: 200, signal: stop.signal, detachAtTimeout: (proc) => { handed = proc; } });
  stop.abort();
  expect(await handed!.exited).toEqual({ code: 4, signal: null });
});

test("spawn with an aborted signal starts nothing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runner-spawn-abort-"));
  const marker = path.join(dir, "ran");
  const stop = new AbortController();
  stop.abort();
  expect(await runner.spawn(`touch ${marker}`, { cwd: "/tmp", signal: stop.signal })).toBeNull();
  expect(existsSync(marker)).toBe(false);
});

test("bytes come as they are: no newline at the end, invalid UTF-8 included", async () => {
  const proc = (await runner.spawn("printf 'ok\\n\\xff\\xfe tail'", { cwd: "/tmp" }))!;
  const chunks: Buffer[] = [];
  proc.onOutput((c) => chunks.push(c));
  await proc.exited;
  expect(Buffer.concat(chunks)).toEqual(Buffer.from([0x6f, 0x6b, 0x0a, 0xff, 0xfe, 0x20, 0x74, 0x61, 0x69, 0x6c]));
});

test("a receiver that throws leaves no command running: the moved process is killed", async () => {
  let handed: ShellProcess | null = null;
  const result = await runner.run("sleep 30", {
    cwd: "/tmp", timeoutMs: 200, detachAtTimeout: (proc) => { handed = proc; throw new Error("20 background commands are running"); }
  });
  expect(result.detached).toBe(true);
  expect((await handed!.exited).signal).toBe("SIGTERM");
});

test("a moved call lets go of what it collected: the process's output after the move is the handle's alone", async () => {
  let handed: ShellProcess | null = null;
  let running = true;
  // Uncapped, so the call itself keeps every byte until it settles.
  const moved = async () => {
    const result = await runner.run("head -c 33554432 /dev/zero; sleep 8", {
      cwd: "/tmp", timeoutMs: 1500, detachAtTimeout: (proc) => { handed = proc; proc.onOutput(() => {}); void proc.exited.then(() => { running = false; }); }
    });
    return result.detached;
  };
  expect(await moved()).toBe(true);
  onCleanup(() => handed?.kill());
  // The collector goes at a later collection, not at the first.
  let held = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 30 && held >= 16 * 1024 * 1024; i++) {
    await pause(100);
    Bun.gc(true);
    held = process.memoryUsage().external;
  }
  expect(held).toBeLessThan(16 * 1024 * 1024);
  expect(running).toBe(true);
}, 10_000);

test("once the shell has exited, a kill signals its group only, never the pid alone (the pid may be another process's by then); a grandchild in another group holding the pipes does not keep exited from settling, and the command's own exit code is kept", async () => {
  const proc = (await runner.spawn("perl -e 'setpgrp(0,0); sleep 20' & echo $!; exit 0", { cwd: "/tmp" }))!;
  let out = "";
  proc.onOutput((c) => { out += c.toString(); });
  await pause(300);
  const grandchild = Number(out.trim().split("\n")[0]);
  onCleanup(() => { if (alive(grandchild)) process.kill(grandchild, "SIGKILL"); });
  const sent: Array<number> = [];
  const kill = process.kill.bind(process);
  // Only this process's: an earlier test's late SIGKILL to its own group may land meanwhile.
  process.kill = ((pid: number, signal?: string | number) => { if (Math.abs(pid) === proc.pid) sent.push(pid); return kill(pid, signal); }) as typeof process.kill;
  onCleanup(() => { process.kill = kill; });
  proc.kill();
  expect(await proc.exited).toEqual({ code: 0, signal: null });
  process.kill = kill;
  expect(sent.length).toBeGreaterThan(0);
  expect(sent).toStrictEqual(sent.map(() => -proc.pid!));
});

test("a foreground call whose shell has exited signals the group only at its timeout too", async () => {
  // Any signal to a pid alone (others' late SIGKILLs go to their groups).
  const sent: Array<number> = [];
  const kill = process.kill.bind(process);
  onCleanup(() => { process.kill = kill; });
  process.kill = ((pid: number, signal?: string | number) => { if (pid > 0 && signal !== 0) sent.push(pid); return kill(pid, signal); }) as typeof process.kill;
  const result = await runner.run("perl -e 'setpgrp(0,0); sleep 20' & echo $!; exit 0", { cwd: "/tmp", timeoutMs: 400 });
  process.kill = kill;
  const grandchild = Number(result.stdout.trim());
  onCleanup(() => { if (alive(grandchild)) process.kill(grandchild, "SIGKILL"); });
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(sent).toStrictEqual([]);
});

test("a call whose shell has already exited is killed at its timeout, not moved: what it left behind only held its output", async () => {
  let handed = false;
  const result = await runner.run("(sleep 3) & echo started; exit 0", {
    cwd: "/tmp", timeoutMs: 400, detachAtTimeout: (proc) => { handed = true; proc.kill(); }
  });
  expect(handed).toBe(false);
  expect(result.detached).toBeUndefined();
  expect(result.timedOut).toBe(true);
  expect(result.stdout).toBe("started\n");
});

// A stop and the login environment, which is read once, on first use.
test("shell command runner: a stop while the login environment is first read, or before, does not wait for it", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tool-bash-slow-rc-"));
  writeFileSync(path.join(home, ".bashrc"), "sleep 2\n");
  const fresh = () => testShellRunner(home, { snapshotDir: mkdtempSync(path.join(os.tmpdir(), "tool-bash-slow-snap-")) });
  const already = new AbortController();
  already.abort();
  const before = Date.now();
  expect(await fresh().run("true", { cwd: "/tmp", timeoutMs: 5_000, signal: already.signal })).toMatchObject({ stopped: true, exitCode: -1 });
  const stop = new AbortController();
  const running = fresh().run("true", { cwd: "/tmp", timeoutMs: 5_000, signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  expect(await running).toMatchObject({ stopped: true, exitCode: -1 });
  expect(Date.now() - before).toBeLessThan(1_500);
});

test("shell command runner: a call stopped before it began starts no login shell at all", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tool-bash-marker-rc-"));
  const marker = path.join(home, "rc-ran");
  writeFileSync(path.join(home, ".bashrc"), `touch ${marker}\n`);
  const runner = testShellRunner(home, { snapshotDir: mkdtempSync(path.join(os.tmpdir(), "tool-bash-marker-snap-")) });
  const stop = new AbortController();
  stop.abort();
  expect(await runner.run("true", { cwd: "/tmp", timeoutMs: 5_000, signal: stop.signal })).toMatchObject({ stopped: true });
  await new Promise((r) => setTimeout(r, 500));
  expect(existsSync(marker)).toBe(false);
});
