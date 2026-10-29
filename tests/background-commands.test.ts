import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { type ShellProcess, type ShellProcessExit } from "../src/server/platform/process/shell-command-runner.js";
import { createBackgroundCommandService, type BackgroundCommandDeps } from "../src/server/runtime/background-commands.js";
import { COMMAND_LIMIT_REACHED, CommandLimitReached } from "../src/shared/command-messages.js";
import { onCleanup } from "./helpers/cleanup.js";
import { freshStoresEnv, withTempDataDir } from "./helpers/fixtures.js";
import { testShellRunner } from "./helpers/shell-runner.js";

// A command bash runs in the background: real processes through an isolated
// runner, its end recorded, told and woken for as a subagent's is.

const home = mkdtempSync(path.join(os.tmpdir(), "bgcmd-home-"));
const runner = testShellRunner(home);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scene(options: Partial<Pick<BackgroundCommandDeps, "limits" | "bootTimeMs" | "retryDelaysMs" | "wake" | "runner" | "isRetired" | "killGroup">> & {
  db?: (db: Database) => Database;
  tasks?: (tasks: BackgroundTaskStore) => BackgroundTaskStore;
  onEvent?: (event: string, payload: unknown) => void;
} = {}) {
  const env = freshStoresEnv("md-bgcmd-");
  const data = withTempDataDir();
  onCleanup(() => { data.restore(); env.cleanup(); });
  const store = new BackgroundTaskStore(env.store.db);
  const tasks = store;
  const woken: Array<[string, string]> = [];
  const events: Array<{ event: string; data: { lastLine?: string; task?: { id: string; status: string } } }> = [];
  const service = createBackgroundCommandService({
    db: options.db ? options.db(env.store.db) : env.store.db, tasks: options.tasks ? options.tasks(store) : store,
    agentStore: env.agentStore, runner: options.runner ?? runner, dataDir: data.dataDir,
    sse: { emit: (event: string, payload: unknown) => { events.push({ event, data: payload as never }); options.onEvent?.(event, payload); } },
    wake: options.wake ?? ((threadId, reason) => { woken.push([threadId, reason]); return "wake_x"; }),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.bootTimeMs ? { bootTimeMs: options.bootTimeMs } : {}),
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.isRetired ? { isRetired: options.isRetired } : {}),
    ...(options.killGroup ? { killGroup: options.killGroup } : {})
  });
  // Kills what still runs: no process outlives its test.
  onCleanup(() => service.dispose());
  const parent = env.agentStore.createManagerThread("Release");
  const start = (command: string, title = command) => service.start({ parentThreadId: parent.id, command, title, cwd: "/tmp", owner: { kind: "global" } });
  const ended = async (id: string) => {
    for (let i = 0; i < 300 && tasks.get(id)!.status === "running"; i++) await pause(20);
    return tasks.get(id)!;
  };
  const mail = () => (env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'command-result' order by rowid").all(parent.id) as Array<{ content: string }>)
    .map((r) => JSON.parse(r.content) as { text: string; metadata: Record<string, unknown> });
  return { env, data, tasks, service, woken, events, parent, start, ended, mail };
}

test("a command runs in the background: its output goes to its file; at its end the task records the exit and the conversation is told and woken", async () => {
  const s = scene();
  const task = await s.start("printf 'one\\ntwo\\n'; exit 2", "Two lines then fail");
  expect(task).toMatchObject({ kind: "command", status: "running", command: "printf 'one\\ntwo\\n'; exit 2", childThreadId: null });
  const done = await s.ended(task.id);
  expect([done.status, done.exitCode, done.error]).toEqual(["failed", 2, "exit 2"]);
  expect(readFileSync(task.outputPath!, "utf8")).toBe("one\ntwo\n");
  expect(s.mail()[0]!.text).toBe(`[Background command] “Two lines then fail”: exited 2 after 0s.\n\nIts 2 lines (the whole output is in ${task.outputPath}):\none\ntwo`);
  expect(s.mail()[0]!.metadata).toEqual({ taskId: task.id, title: "Two lines then fail", outcome: "exited", exitCode: 2, signal: null, durationMs: expect.any(Number), outputLines: 2 });
  expect(s.woken).toStrictEqual([[s.parent.id, "command-result"]]);
  expect(s.events.filter((e) => e.event === "backgroundTaskChanged").map((e) => e.data.task!.status)).toStrictEqual(["running", "failed"]);
});

test("exit 0 is finished, and says it printed nothing; the task file lives under the thread's tool-output folder", async () => {
  const s = scene();
  const task = await s.start("true");
  expect(path.basename(path.dirname(task.outputPath!))).toBe(s.parent.id);
  expect(path.basename(path.dirname(path.dirname(task.outputPath!)))).toBe("tool-output");
  expect((await s.ended(task.id))).toMatchObject({ status: "finished", exitCode: 0, error: null });
  expect(s.mail()[0]!.text).toBe("[Background command] “true”: exited 0 after 0s.\n\nIt printed nothing.");
});

test("one more running command than the limit is refused, before anything starts", async () => {
  const s = scene({ limits: { perThread: 2 } });
  await s.start("sleep 5");
  await s.start("sleep 5");
  await expect(s.start("sleep 5")).rejects.toThrow(COMMAND_LIMIT_REACHED.replace("20", "2"));
  expect(s.tasks.listOpen("command")).toHaveLength(2);
  // Starts in flight hold their slot too.
  const t = scene({ limits: { perThread: 1 } });
  const both = await Promise.allSettled([t.start("sleep 5"), t.start("sleep 5")]);
  expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
});

test("stopped by its own agent: killed, no message; by the user: killed, told and woken; another conversation's stop is refused", async () => {
  const s = scene();
  const a = await s.start("sleep 30");
  expect(s.service.stop(a.id, "agent", s.parent.id)?.id).toBe(a.id);
  expect(await s.ended(a.id)).toMatchObject({ status: "stopped", stoppedBy: "agent", exitCode: null });
  const b = await s.start("sleep 30", "Long wait");
  s.service.stop(b.id, "user");
  expect(await s.ended(b.id)).toMatchObject({ status: "stopped", stoppedBy: "user" });
  expect(s.mail().map((m) => m.text.split("\n")[0])).toEqual(["[Background command] “Long wait”: stopped by the user after 0s."]);
  expect(s.woken).toStrictEqual([[s.parent.id, "command-result"]]);
  const c = await s.start("sleep 30");
  expect(s.service.stop(c.id, "agent", "thr_other")).toBeNull();
  expect(s.tasks.get(c.id)!.status).toBe("running");
});

test("output past the cap kills the command; live lines go out at most once per interval", async () => {
  const s = scene({ limits: { outputMaxBytes: 64 * 1024, liveLineMs: 2000 } });
  // Past the cap, then quiet: a cap that failed to kill leaves a sleeping
  // command, never an endless one filling the disk.
  const task = await s.start("yes line | head -c 1048576; sleep 30", "Endless");
  const done = await s.ended(task.id);
  expect(done).toMatchObject({ status: "stopped", stoppedBy: "output" });
  expect(s.mail()[0]!.text.split("\n")[0]).toMatch(/^\[Background command\] “Endless”: stopped after \d+s: its output passed 1 GB\.$/);
  expect(s.events.filter((e) => e.event === "backgroundTaskOutput").length).toBeLessThanOrEqual(2);
});

test("a killed command's own stop stands: the user's stop after an output kill does not make it the user's", async () => {
  const d = drivenRunner();
  const s = scene({ runner: d.runner, limits: { outputMaxBytes: 1 } });
  const task = await s.start("printf 'xy'; sleep 30");
  const p = d.procs[0]!;
  p.emit("xy");
  expect(p.kills).toBe(1);
  // The user stops it while it is still dying of the output kill.
  s.service.stop(task.id, "user");
  p.exit({ code: null, signal: "SIGTERM" });
  expect(await s.ended(task.id)).toMatchObject({ status: "stopped", stoppedBy: "output" });
});

test("the live line: the last non-blank line, then the unfinished one; one more is sent when the interval ends", async () => {
  const s = scene({ limits: { liveLineMs: 400 } });
  const task = await s.start("printf 'building\\n\\n'; sleep 0.1; printf '50%%'; sleep 2");
  for (let i = 0; i < 100 && s.service.stats(task.id)?.lastLine !== "50%"; i++) await pause(20);
  expect(s.service.stats(task.id)).toEqual({ bytes: 13, lines: 3, lastLine: "50%" });
  await pause(500);
  const lines = s.events.filter((e) => e.event === "backgroundTaskOutput").map((e) => e.data.lastLine);
  expect(lines).toStrictEqual(["building", "50%"]);
});

test("the tail: the last lines, a last line with no newline counted, invalid bytes replaced", async () => {
  const s = scene({ limits: { tailMaxLines: 3 } });
  const task = await s.start("printf '1\\n2\\n3\\n4\\nfive\\xff'");
  await s.ended(task.id);
  expect(s.service.tail(task.id)).toMatchObject({ text: "3\n4\nfive�", shownLines: 3, totalLines: 5, bytes: 13 });
  expect(s.mail()[0]!.text.split("\n").slice(2).join("\n")).toBe(`Last 3 of 5 lines (the whole output is in ${task.outputPath}):\n3\n4\nfive�`);
});

test("the tail within its bytes starts at a whole line; a single line longer than them is its end", async () => {
  const s = scene({ limits: { tailMaxBytes: 8 } });
  const lines = await s.start("printf 'aaaa\\nbbbb\\ncccc\\n'");
  await s.ended(lines.id);
  expect(s.service.tail(lines.id)).toMatchObject({ text: "cccc", shownLines: 1, totalLines: 3 });
  const long = await s.start("printf '0123456789abcdef'");
  await s.ended(long.id);
  expect(s.service.tail(long.id)).toMatchObject({ text: "89abcdef", shownLines: 1, totalLines: 1 });
});

test("at a restart a command left running is killed by its process group, ends interrupted, its conversation told and woken", async () => {
  const s = scene();
  const proc = (await runner.spawn("sleep 30", { cwd: "/tmp" }))!;
  onCleanup(() => { try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ } });
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "bgcmd-left-")), "left.log");
  writeFileSync(file, "half\n");
  const left = s.tasks.createCommand({ parentThreadId: s.parent.id, title: "Left over", command: "sleep 30", outputPath: file, pid: proc.pid, startedAt: new Date(Date.now() - 5000).toISOString() });
  s.service.recoverAtStartup();
  expect(s.tasks.get(left.id)).toMatchObject({ status: "interrupted", exitCode: null });
  expect(await proc.exited).toMatchObject({ signal: "SIGKILL" });
  expect(s.mail()[0]!.text).toBe(`[Background command] “Left over”: was stopped when Mandate restarted, after 5s. Run it again if you still need it.\n\nIts 1 lines (the whole output is in ${file}):\nhalf`);
  expect(s.woken).toStrictEqual([[s.parent.id, "command-result"]]);
});

test("at a start after the machine booted, a command recorded before the boot is not killed by its old group id: it ends interrupted", async () => {
  const s = scene({ bootTimeMs: () => Date.now() });
  const proc = (await runner.spawn("sleep 30", { cwd: "/tmp" }))!;
  onCleanup(() => { try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ } });
  const left = s.tasks.createCommand({ parentThreadId: s.parent.id, title: "Before the boot", command: "sleep 30", outputPath: "/nonexistent/left.log", pid: proc.pid, startedAt: new Date(Date.now() - 60_000).toISOString() });
  s.service.recoverAtStartup();
  expect(s.tasks.get(left.id)!.status).toBe("interrupted");
  await pause(100);
  expect(() => process.kill(proc.pid!, 0)).not.toThrow();
  expect(s.mail()[0]!.text).toBe("[Background command] “Before the boot”: was stopped when Mandate restarted, after 1m 00s. Run it again if you still need it.\n\nIt printed nothing.");
});

test("an archive stops every running command of the conversation, without a message", async () => {
  const s = scene();
  const a = await s.start("sleep 30");
  const b = await s.start("sleep 30");
  s.service.stopAllFor(s.parent.id);
  expect([(await s.ended(a.id)).stoppedBy, (await s.ended(b.id)).stoppedBy]).toEqual(["archive", "archive"]);
  expect(s.mail()).toEqual([]);
  expect(s.woken).toStrictEqual([]);
});

test("a command of a conversation archived meanwhile ends with no message", async () => {
  const s = scene();
  const task = await s.start("sleep 0.3; exit 1");
  s.env.agentStore.archiveThread(s.parent.id);
  expect((await s.ended(task.id)).status).toBe("failed");
  expect(s.mail()).toEqual([]);
  expect(s.woken).toStrictEqual([]);
});

test("adopt: a foreground process handed over keeps its output so far at the head of its file", async () => {
  const s = scene();
  let handed: { process: ShellProcess; soFar: Buffer } | null = null;
  await runner.run("printf 'early\\n'; sleep 0.5; printf 'late\\n'", { cwd: "/tmp", timeoutMs: 200, detachAtTimeout: (process, soFar) => { handed = { process, soFar }; } });
  const task = await s.service.adopt({ parentThreadId: s.parent.id, command: "x", title: "Moved", owner: { kind: "global" }, process: handed!.process, soFar: handed!.soFar });
  expect((await s.ended(task.id)).status).toBe("finished");
  expect(readFileSync(task.outputPath!, "utf8")).toBe("early\nlate\n");
  expect(s.mail()[0]!.metadata).toMatchObject({ outputLines: 2 });
});

test("adopt over the limit is refused before anything is recorded, and the process is killed", async () => {
  const s = scene({ limits: { perThread: 1 } });
  await s.start("sleep 5");
  const proc = (await runner.spawn("sleep 5", { cwd: "/tmp" }))!;
  onCleanup(() => proc.kill());
  const refused = s.service.adopt({ parentThreadId: s.parent.id, command: "x", title: "Moved", owner: { kind: "global" }, process: proc, soFar: Buffer.alloc(0) });
  await expect(refused).rejects.toThrow(COMMAND_LIMIT_REACHED.replace("20", "1"));
  // Told apart from any other refusal: bash tells its agent the command was stopped.
  await expect(refused).rejects.toBeInstanceOf(CommandLimitReached);
  expect(s.tasks.listOpen("command")).toHaveLength(1);
  expect((await proc.exited).signal).toBe("SIGTERM");
});

test("an end the database refused is recorded when it is tried again; so is a wake it refused", async () => {
  let refuse = 1;
  let wakes = 0;
  const woken: string[] = [];
  const s = scene({
    retryDelaysMs: [20],
    db: (db) => new Proxy(db, {
      get(target, key) {
        if (key === "transaction" && refuse > 0) {
          refuse--;
          return () => ({ immediate: () => { throw new Error("database is locked"); } });
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }),
    wake: (threadId) => {
      if (wakes++ === 0) throw new Error("database is locked");
      woken.push(threadId);
      return "wake_x";
    }
  });
  const task = await s.start("exit 3");
  expect((await s.ended(task.id)).exitCode).toBe(3);
  expect(s.mail()).toHaveLength(1);
  for (let i = 0; i < 50 && woken.length === 0; i++) await pause(20);
  expect(woken).toStrictEqual([s.parent.id]);
});

test("the server's end kills what still runs; their rows are left for the next start", async () => {
  const s = scene();
  const task = await s.start("sleep 30");
  const pid = s.tasks.pidOf(task.id)!;
  s.service.dispose();
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await pause(20);
  }
  expect(() => process.kill(pid, 0)).toThrow();
  await pause(50);
  expect(s.tasks.get(task.id)!.status).toBe("running");
  // Its group is gone: the next start has nothing to kill, and must not kill whatever takes its id.
  expect(s.tasks.pidOf(task.id)).toBeNull();
});

test("a restart never signals pid 1 or below: such a group id would reach every process of the user", () => {
  const killed: number[] = [];
  const s = scene({ killGroup: (pid) => { killed.push(pid); } });
  const left = [1, 0, -5].map((pid, i) => s.tasks.createCommand({ parentThreadId: s.parent.id, title: `Odd ${i}`, command: "x", outputPath: "/nonexistent/x.log", pid, startedAt: new Date().toISOString() }));
  s.service.recoverAtStartup();
  expect(killed).toStrictEqual([]);
  expect(left.map((t) => s.tasks.get(t.id)!.status)).toEqual(["interrupted", "interrupted", "interrupted"]);
});

test("an ended command's detail reads its count as recorded at its end: the file is not counted again", async () => {
  const s = scene();
  const task = await s.start("printf 'one\\ntwo\\n'");
  await s.ended(task.id);
  expect(s.tasks.outputLinesOf(task.id)).toBe(2);
  // Whatever the file holds now, the count is the one recorded.
  fs.appendFileSync(task.outputPath!, "three\nfour\n");
  expect(s.service.tail(task.id)).toMatchObject({ text: "one\ntwo\nthree\nfour", totalLines: 2 });
});

test("a command killed by a signal Mandate did not send fails, and its conversation reads which", async () => {
  const s = scene();
  const task = await s.start("printf 'about to crash\\n'; kill -TERM $$", "Crashes");
  expect(await s.ended(task.id)).toMatchObject({ status: "failed", exitCode: null, error: "signal SIGTERM" });
  expect(s.mail()[0]!.text.split("\n")[0]).toBe("[Background command] “Crashes”: ended on SIGTERM after 0s.");
  expect(s.mail()[0]!.metadata).toMatchObject({ outcome: "signal", signal: "SIGTERM", exitCode: null });
});

/** A runner whose spawn waits for the test: a start in flight. */
function heldRunner() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const spawned: ShellProcess[] = [];
  return {
    open, spawned,
    runner: { spawn: async (command: string, options: { cwd: string }) => { await gate; const p = (await runner.spawn(command, options))!; spawned.push(p); return p; } }
  };
}

test("a start still spawning when its conversation is archived starts nothing: the command is killed, no row is left", async () => {
  const held = heldRunner();
  const s = scene({ runner: held.runner });
  const starting = s.start("sleep 30");
  s.service.stopAllFor(s.parent.id);
  held.open();
  await expect(starting).rejects.toThrow("Stopped before it started.");
  expect(s.tasks.listOpen("command")).toEqual([]);
  expect((await held.spawned[0]!.exited).signal).not.toBeNull();
});

test("an archive silences a command even when a user's stop of it was already under way", async () => {
  const s = scene();
  // Ignores SIGTERM, so the user's stop is still under way when the archive comes.
  const task = await s.start("trap '' TERM; sleep 30");
  s.service.stop(task.id, "user");
  s.service.stopAllFor(s.parent.id);
  expect(await s.ended(task.id)).toMatchObject({ status: "stopped", stoppedBy: "archive" });
  expect(s.mail()).toEqual([]);
});

test("a row the database refused to write is written when tried again; the command runs on meanwhile", async () => {
  let refuse = 1;
  const s = scene({
    retryDelaysMs: [20],
    tasks: (store) => new Proxy(store, {
      get(target, key) {
        if (key === "createCommand" && refuse > 0) { refuse--; return () => { throw new Error("database is locked"); }; }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    })
  });
  const task = await s.start("printf 'kept\\n'");
  expect((await s.ended(task.id)).status).toBe("finished");
  expect(readFileSync(task.outputPath!, "utf8")).toBe("kept\n");
});

test("a row the database keeps refusing: the command is killed and the start fails with the database's error", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bgcmd-refused-"));
  const marker = path.join(dir, "ran-on");
  const s = scene({
    retryDelaysMs: [10],
    tasks: (store) => new Proxy(store, {
      get(target, key) {
        if (key === "createCommand") return () => { throw new Error("database is locked"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    })
  });
  await expect(s.start(`sleep 0.5; touch ${marker}`)).rejects.toThrow("database is locked");
  await pause(800);
  expect(fs.existsSync(marker)).toBe(false);
  // Its output file goes with it: nothing names it.
  expect(fs.readdirSync(path.join(s.data.dataDir, "resources", "global", "tool-output", s.parent.id))).toEqual([]);
});

test("a short write to the output file writes the rest: no byte is lost", async () => {
  const write = fs.writeSync;
  const spy = spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Buffer, offset?: number, length?: number) =>
    write(fd, buffer, offset ?? 0, Math.min(length ?? buffer.length - (offset ?? 0), 3))) as typeof fs.writeSync);
  onCleanup(() => spy.mockRestore());
  const s = scene();
  const task = await s.start("printf 'hello world'");
  expect((await s.ended(task.id)).status).toBe("finished");
  spy.mockRestore();
  expect(readFileSync(task.outputPath!, "utf8")).toBe("hello world");
});

test("an end whose output cannot be read is still recorded, and its conversation still told, with the lines it counted", async () => {
  const s = scene();
  const task = await s.start("printf 'one\\ntwo\\n'; sleep 0.3");
  for (let i = 0; i < 100 && s.service.stats(task.id)?.lines !== 2; i++) await pause(20);
  const spy = spyOn(fs, "fstatSync").mockImplementation((() => { throw new Error("EIO: i/o error"); }) as unknown as typeof fs.fstatSync);
  onCleanup(() => spy.mockRestore());
  const done = await s.ended(task.id);
  spy.mockRestore();
  expect(done.status).toBe("finished");
  expect(s.mail()[0]!.text).toBe(`[Background command] “printf 'one\\ntwo\\n'; sleep 0.3”: exited 0 after 0s.\n\nLast 0 of 2 lines (the whole output is in ${task.outputPath}):\n`);
  expect(s.mail()[0]!.metadata).toMatchObject({ outputLines: 2 });
});

test("while its row is tried again, a command's output is taken and its cap kept", async () => {
  let refuse = 2;
  const dir = mkdtempSync(path.join(os.tmpdir(), "bgcmd-capped-"));
  const marker = path.join(dir, "ran-on");
  const s = scene({
    retryDelaysMs: [150],
    limits: { outputMaxBytes: 1024 },
    tasks: (store) => new Proxy(store, {
      get(target, key) {
        if (key === "createCommand" && refuse > 0) { refuse--; return () => { throw new Error("database is locked"); }; }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    })
  });
  const task = await s.start(`yes line | head -c 131072; sleep 0.4; touch ${marker}`);
  expect(await s.ended(task.id)).toMatchObject({ status: "stopped", stoppedBy: "output" });
  expect(fs.existsSync(marker)).toBe(false);
});

test("an end whose write is still being tried is silenced by an archive meanwhile", async () => {
  let refuse = 1;
  const s = scene({
    retryDelaysMs: [300],
    db: (db) => new Proxy(db, {
      get(target, key) {
        if (key === "transaction" && refuse > 0) { refuse--; return () => ({ immediate: () => { throw new Error("database is locked"); } }); }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    })
  });
  const task = await s.start("sleep 30");
  s.service.stop(task.id, "user");
  for (let i = 0; i < 100 && s.service.stats(task.id) !== null; i++) await pause(20);
  expect(s.tasks.get(task.id)!.status).toBe("running");
  s.service.stopAllFor(s.parent.id);
  expect(await s.ended(task.id)).toMatchObject({ status: "stopped", stoppedBy: "user" });
  expect(s.mail()).toEqual([]);
});

test("the last line does not depend on how the output was cut: an unfinished line after a finished one in one chunk is the last", async () => {
  const s = scene();
  const task = await s.start("printf 'building\\n50%%'; sleep 2");
  for (let i = 0; i < 100 && (s.service.stats(task.id)?.bytes ?? 0) < 12; i++) await pause(20);
  expect(s.service.stats(task.id)!.lastLine).toBe("50%");
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the server's end kills what a stop left dying: a member that ignores SIGTERM does not wait for the SIGKILL", async () => {
  const s = scene();
  const dir = mkdtempSync(path.join(os.tmpdir(), "bgcmd-dying-"));
  const pidFile = path.join(dir, "member.pid");
  const task = await s.start(`/bin/bash -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 30' >/dev/null 2>&1 & sleep 30`);
  for (let i = 0; i < 100 && !(fs.existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()); i++) await pause(20);
  const member = Number(readFileSync(pidFile, "utf8").trim());
  onCleanup(() => { if (alive(member)) process.kill(member, "SIGKILL"); });
  s.service.stop(task.id, "agent");
  await s.ended(task.id);
  expect(alive(member)).toBe(true);
  s.service.dispose();
  for (let i = 0; i < 20 && alive(member); i++) await pause(20);
  expect(alive(member)).toBe(false);
});

test("a start still spawning when the server stops starts nothing: its child is killed at once, a command ignoring SIGTERM included", async () => {
  const held = heldRunner();
  const s = scene({ runner: held.runner });
  const starting = s.start("trap '' TERM; sleep 30");
  s.service.dispose();
  held.open();
  await expect(starting).rejects.toThrow("Stopped before it started.");
  expect(s.tasks.listOpen("command")).toEqual([]);
  const exit = await Promise.race([held.spawned[0]!.exited, pause(1000).then(() => null)]);
  expect(exit?.signal).toBe("SIGKILL");
});

test("a start's slot is let go once its row is written: a start right then is not refused", async () => {
  let again: Promise<unknown> | null = null;
  const s = scene({
    limits: { perThread: 2 },
    onEvent: (event, payload) => {
      if (event === "backgroundTaskChanged" && !again && (payload as { task: { status: string } }).task.status === "running") again = s.start("sleep 5");
    }
  });
  await s.start("sleep 5");
  await expect(again!).resolves.toMatchObject({ status: "running" });
});

test("an end is recorded even when closing its output after the tail read fails", async () => {
  const s = scene();
  const task = await s.start("printf 'x\\n'; sleep 0.3");
  const close = fs.closeSync;
  const spy = spyOn(fs, "closeSync").mockImplementation(((fd: number) => { close(fd); throw new Error("EIO: i/o error"); }) as typeof fs.closeSync);
  onCleanup(() => spy.mockRestore());
  const done = await s.ended(task.id);
  spy.mockRestore();
  expect(done.status).toBe("finished");
  expect(s.mail()).toHaveLength(1);
});

test("a restart records every command left running, though one's output cannot be read", async () => {
  const s = scene({ bootTimeMs: () => 0 });
  const dir = mkdtempSync(path.join(os.tmpdir(), "bgcmd-left-two-"));
  const files = ["a.log", "b.log"].map((name) => { const f = path.join(dir, name); writeFileSync(f, "half\n"); return f; });
  const left = files.map((file, i) => s.tasks.createCommand({ parentThreadId: s.parent.id, title: `Left ${i}`, command: "sleep 30", outputPath: file, pid: null, startedAt: new Date().toISOString() }));
  const close = fs.closeSync;
  let failures = 1;
  const spy = spyOn(fs, "closeSync").mockImplementation(((fd: number) => { close(fd); if (failures-- > 0) throw new Error("EIO: i/o error"); }) as typeof fs.closeSync);
  onCleanup(() => spy.mockRestore());
  s.service.recoverAtStartup();
  spy.mockRestore();
  expect(left.map((t) => s.tasks.get(t.id)!.status)).toEqual(["interrupted", "interrupted"]);
});

test("a restart that cannot put one command right still puts right the others", async () => {
  let failing = "";
  const s = scene({
    tasks: (store) => new Proxy(store, {
      get(target, key) {
        if (key === "pidOf") return (id: string) => { if (id === failing) throw new Error("database is locked"); return target.pidOf(id); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    })
  });
  const left = ["Left a", "Left b"].map((title) => s.tasks.createCommand({ parentThreadId: s.parent.id, title, command: "sleep 30", outputPath: "/nonexistent/x.log", pid: null, startedAt: new Date().toISOString() }));
  failing = left[0]!.id;
  s.service.recoverAtStartup();
  expect(left.map((t) => s.tasks.get(t.id)!.status)).toEqual(["running", "interrupted"]);
});

test("a conversation archived or retired (its feature archived) starts nothing and takes no moved command over", async () => {
  let retired = false;
  const s = scene({ isRetired: () => retired });
  const dir = mkdtempSync(path.join(os.tmpdir(), "bgcmd-retired-"));
  const marker = path.join(dir, "ran");
  retired = true;
  await expect(s.start(`touch ${marker}`)).rejects.toThrow("Stopped before it started.");
  const proc = (await runner.spawn("sleep 30", { cwd: "/tmp" }))!;
  onCleanup(() => proc.kill());
  await expect(s.service.adopt({ parentThreadId: s.parent.id, command: "x", title: "Moved", owner: { kind: "global" }, process: proc, soFar: Buffer.alloc(0) })).rejects.toThrow("Stopped before it started.");
  expect((await proc.exited).signal).not.toBeNull();
  retired = false;
  s.env.agentStore.archiveThread(s.parent.id);
  await expect(s.start(`touch ${marker}`)).rejects.toThrow("Stopped before it started.");
  await pause(200);
  expect(fs.existsSync(marker)).toBe(false);
  expect(s.tasks.listOpen("command")).toEqual([]);
});

test("a move handed over after the server's end is refused and killed at once, one ignoring SIGTERM included", async () => {
  const s = scene({ limits: { perThread: 1 } });
  await s.start("sleep 5");
  s.service.dispose();
  const proc = (await runner.spawn("trap '' TERM; sleep 30", { cwd: "/tmp" }))!;
  onCleanup(() => { try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ } });
  await expect(s.service.adopt({ parentThreadId: s.parent.id, command: "x", title: "Moved", owner: { kind: "global" }, process: proc, soFar: Buffer.alloc(0) })).rejects.toThrow();
  const exit = await Promise.race([proc.exited, pause(1000).then(() => null)]);
  expect(exit?.signal).toBe("SIGKILL");
});

test("short reads of the output file read on: the tail is the bytes there are", async () => {
  const s = scene();
  const task = await s.start("printf 'hello\\nworld\\n'");
  await s.ended(task.id);
  const read = fs.readSync;
  const spy = spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) =>
    read(fd, buffer, offset, Math.min(length, 3), position)) as typeof fs.readSync);
  onCleanup(() => spy.mockRestore());
  const tail = s.service.tail(task.id);
  spy.mockRestore();
  expect(tail).toMatchObject({ text: "hello\nworld", shownLines: 2, totalLines: 2, bytes: 12 });
});

test("a sweep stops the commands of a conversation archived or retired by any path, telling nobody", async () => {
  let retired = false;
  const s = scene({ isRetired: () => retired });
  const a = await s.start("sleep 30");
  s.service.sweep();
  expect(s.tasks.get(a.id)!.status).toBe("running");
  retired = true;
  s.service.sweep();
  expect(await s.ended(a.id)).toMatchObject({ status: "stopped", stoppedBy: "archive" });
  retired = false;
  const b = await s.start("sleep 30");
  // As an agent's own write would leave it: archived, nothing released.
  s.env.store.db.prepare("update agent_threads set archived_at = ? where id = ?").run(new Date().toISOString(), s.parent.id);
  s.service.sweep();
  expect(await s.ended(b.id)).toMatchObject({ status: "stopped", stoppedBy: "archive" });
  expect(s.mail()).toEqual([]);
});

test("the last line is the same however a character is cut between chunks", async () => {
  const s = scene();
  // An ideographic space (E3 80 80) cut after its first byte, on a line of its own.
  const task = await s.start("printf 'ready\\n\\xe3'; sleep 0.4; printf '\\x80\\x80\\n'; sleep 2");
  for (let i = 0; i < 100 && (s.service.stats(task.id)?.bytes ?? 0) < 7; i++) await pause(10);
  // While the character is still cut, it is left out.
  expect(s.service.stats(task.id)).toMatchObject({ bytes: 7, lastLine: "ready" });
  for (let i = 0; i < 100 && (s.service.stats(task.id)?.bytes ?? 0) < 10; i++) await pause(20);
  expect(s.service.stats(task.id)!.lastLine).toBe("ready");
});

/** A store that refuses the first `times` command rows. */
const refusingRows = (times: number) => (store: BackgroundTaskStore) => {
  let refuse = times;
  return new Proxy(store, {
    get(target, key) {
      if (key === "createCommand" && refuse > 0) { refuse--; return () => { throw new Error("database is locked"); }; }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};

test("a sweep also stops a start whose row is still being tried: its command is killed at once", async () => {
  const s = scene({ retryDelaysMs: [1000], tasks: refusingRows(1) });
  const dir = mkdtempSync(path.join(os.tmpdir(), "bgcmd-swept-start-"));
  const pidFile = path.join(dir, "pid");
  const starting = s.start(`echo $$ > ${pidFile}; sleep 30`);
  for (let i = 0; i < 100 && !(fs.existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()); i++) await pause(10);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  s.env.store.db.prepare("update agent_threads set archived_at = ? where id = ?").run(new Date().toISOString(), s.parent.id);
  s.service.sweep();
  for (let i = 0; i < 30 && alive(pid); i++) await pause(10);
  expect(alive(pid)).toBe(false);
  await expect(starting).rejects.toThrow("Stopped before it started.");
  expect(s.tasks.listOpen("command")).toEqual([]);
});

test("a start whose conversation went away while its row was tried again does not start", async () => {
  const s = scene({ retryDelaysMs: [100], tasks: refusingRows(1) });
  const starting = s.start("sleep 30");
  await pause(30);
  s.env.store.db.prepare("update agent_threads set archived_at = ? where id = ?").run(new Date().toISOString(), s.parent.id);
  await expect(starting).rejects.toThrow("Stopped before it started.");
  expect(s.tasks.listOpen("command")).toEqual([]);
});

test("an end in a conversation retired meanwhile tells nobody", async () => {
  let retired = false;
  const s = scene({ isRetired: () => retired });
  const task = await s.start("sleep 0.3; exit 1");
  retired = true;
  expect((await s.ended(task.id)).status).toBe("failed");
  expect(s.mail()).toEqual([]);
  expect(s.woken).toStrictEqual([]);
});

test("a moved command's clock starts when it did, not at the move", async () => {
  const s = scene();
  const proc = (await runner.spawn("exit 0", { cwd: "/tmp" }))!;
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const task = await s.service.adopt({ parentThreadId: s.parent.id, command: "make e2e", title: "Moved late", owner: { kind: "global" }, process: proc, soFar: Buffer.alloc(0), startedAt });
  expect(task.startedAt).toBe(startedAt);
  await s.ended(task.id);
  expect(s.mail()[0]!.text.split("\n")[0]).toBe("[Background command] “Moved late”: exited 0 after 1m 05s.");
});

test("the server's end sends every signal before it writes anything: a write can wait out the busy timeout", async () => {
  const order: string[] = [];
  const s = scene({
    killGroup: (pid) => { order.push(`kill ${pid}`); },
    tasks: (store) => new Proxy(store, {
      get(target, key) {
        if (key === "clearPid") return (id: string) => { order.push("clear"); target.clearPid(id); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    })
  });
  const running = await s.start("sleep 30");
  const stopped = await s.start("trap '' TERM; sleep 30");
  const pids = [s.tasks.pidOf(running.id)!, s.tasks.pidOf(stopped.id)!];
  onCleanup(() => { for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } } });
  s.service.stop(stopped.id, "agent");
  s.service.dispose();
  expect([...new Set(order.filter((step) => step.startsWith("kill")))].sort()).toEqual(pids.map((pid) => `kill ${pid}`).sort());
  expect(order.indexOf("clear")).toBeGreaterThan(Math.max(...pids.map((pid) => order.lastIndexOf(`kill ${pid}`))));
});

/** A runner whose processes the test drives: each chunk of output, and the
 *  end, when the test says. */
function drivenRunner() {
  const procs: Array<{ emit(chunk: string | Buffer): void; exit(exit?: ShellProcessExit): void; kills: number }> = [];
  return {
    procs,
    runner: {
      spawn: async () => {
        let listener: ((chunk: Buffer) => void) | null = null;
        const held: Buffer[] = [];
        let settle!: (exit: ShellProcessExit) => void;
        const exited = new Promise<ShellProcessExit>((resolve) => { settle = resolve; });
        const driven = {
          kills: 0,
          emit: (chunk: string | Buffer) => { const bytes = Buffer.from(chunk); if (listener) listener(bytes); else held.push(bytes); },
          exit: (exit: ShellProcessExit = { code: 0, signal: null }) => settle(exit)
        };
        procs.push(driven);
        const process: ShellProcess = {
          pid: null,
          onOutput: (l) => { listener = l; for (const chunk of held.splice(0)) l(chunk); },
          exited,
          kill: () => { driven.kills++; }
        };
        return process;
      }
    }
  };
}

test("output past the cap is not written on while its command dies: the file ends with the chunk that passed it", async () => {
  const d = drivenRunner();
  const s = scene({ runner: d.runner, limits: { outputMaxBytes: 100 } });
  const task = await s.start("flood", "Flood");
  const p = d.procs[0]!;
  p.emit(`${"a".repeat(79)}\n`);
  p.emit(`${"b".repeat(79)}\n`);
  expect(p.kills).toBe(1);
  // What it prints in the seconds before its SIGKILL is not kept.
  p.emit("c".repeat(500));
  p.exit({ code: null, signal: "SIGTERM" });
  expect(await s.ended(task.id)).toMatchObject({ status: "stopped", stoppedBy: "output" });
  expect(fs.statSync(task.outputPath!).size).toBe(160);
});

test("output after a command's end sends no live line: a grandchild still holding its pipe is not heard", async () => {
  const d = drivenRunner();
  const s = scene({ runner: d.runner, limits: { liveLineMs: 0 } });
  const task = await s.start("server &", "Starts a server");
  const p = d.procs[0]!;
  p.emit("listening\n");
  p.exit();
  await s.ended(task.id);
  const sent = () => s.events.filter((e) => e.event === "backgroundTaskOutput").length;
  const before = sent();
  p.emit("GET /\n");
  await pause(20);
  expect(sent()).toBe(before);
});

test("a flood of blank lines is read about as fast as it comes: the server is not kept busy, and the last line holds", async () => {
  const d = drivenRunner();
  const s = scene({ runner: d.runner, limits: { liveLineMs: 60_000 } });
  const task = await s.start("yes ''", "Blank lines");
  const p = d.procs[0]!;
  // An unfinished line, finished by the flood's first newline: the last line it shows.
  p.emit("head  ");
  const blanks = Buffer.alloc(64 * 1024, 10);
  // Spaces, tabs and returns are blank too.
  blanks.write(" \t\r", 100);
  const started = performance.now();
  for (let i = 0; i < 1600; i++) p.emit(blanks);
  const took = performance.now() - started;
  expect(s.service.stats(task.id)!.lastLine).toBe("head");
  p.emit("done\n");
  p.emit(blanks);
  expect(s.service.stats(task.id)!.lastLine).toBe("done");
  // About 100 MB of blank lines: read line by line they took ~7.5 s here; now well under one.
  expect(took).toBeLessThan(3000);
  p.exit();
  await s.ended(task.id);
});
