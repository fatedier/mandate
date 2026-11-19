import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { asyncCommandRunFrom, commandDidNotAnswer } from "../src/server/platform/process/command-runner.js";

const logged: string[] = [];
const realError = console.error;
afterEach(() => { console.error = realError; logged.length = 0; });
function captureLog() {
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
}

// The async run: the command runs while the server goes on, and answers with
// its output, its exit code or signal, or the error that kept it from
// starting. A fake child stands in for the process: tests run no binaries.

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); return true; }
  /** Exits without its streams ending: a descendant still holds them. */
  exitHeld(code: number | null, signal: string | null) { this.emit("exit", code, signal); }
  /** Writes, then ends both streams and closes with `code`/`signal`. */
  async finish(code: number | null, signal: string | null, out = "", err = "") {
    if (out) this.stdout.write(out);
    if (err) this.stderr.write(err);
    this.stdout.end();
    this.stderr.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}
function fakeSpawn(seen: unknown[] = []) {
  const children: FakeChild[] = [];
  const spawnChild = ((command: string, args: string[], options: unknown) => {
    seen.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as never;
  return { spawnChild, children, seen };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the async run answers with the output, an exit code, a signal, a missing binary", async () => {
  captureLog();
  const f = fakeSpawn();
  const run = asyncCommandRunFrom(f.spawnChild);
  const ok = run("git", ["status"]);
  await f.children[0]!.finish(0, null, "ok\n");
  expect(await ok).toStrictEqual({ status: 0, signal: null, stdout: "ok\n", stderr: "" });
  const three = run("git", ["status"]);
  await f.children[1]!.finish(3, null, "out\n", "err\n");
  expect(await three).toStrictEqual({ status: 3, signal: null, stdout: "out\n", stderr: "err\n" });
  const killed = run("git", ["status"]);
  await f.children[2]!.finish(null, "SIGKILL");
  expect(await killed).toStrictEqual({ status: null, signal: "SIGKILL", stdout: "", stderr: "" });
  const missing = Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'git'"), { code: "ENOENT" });
  const notThere = run("git", ["status"]);
  f.children[3]!.emit("error", missing);
  await f.children[3]!.finish(-2, null);
  expect(await notThere).toStrictEqual({ status: null, signal: null, stdout: "", stderr: "", error: missing });
  expect(logged).toStrictEqual([]);
});

test("a timeout signals the child with the caller's signal, keeps what it writes as it stops, and is a timeout however it exits", async () => {
  captureLog();
  const f = fakeSpawn();
  const run = asyncCommandRunFrom(f.spawnChild);
  const stopped = run("git", ["status"], { timeout: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.children[0]!.signals).toStrictEqual(["SIGTERM"]);
  // It cleans up and exits 0: still a timeout, with what it wrote on the way out,
  // and no signal it was not ended by.
  await f.children[0]!.finish(0, null, "cleanup\n");
  const r = await stopped;
  expect(r).toMatchObject({ status: null, signal: null, stdout: "cleanup\n", stderr: "" });
  expect((r.error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
  expect(commandDidNotAnswer(r)).toBe(true);
  expect(logged.some((line) => line.includes("git status") && line.includes("ETIMEDOUT"))).toBe(true);
  const killed = run("tmux", ["has-session"], { timeout: 5, killSignal: "SIGKILL" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.children[1]!.signals).toStrictEqual(["SIGKILL"]);
  await f.children[1]!.finish(null, "SIGKILL");
  expect(await killed).toMatchObject({ status: null, signal: "SIGKILL" });
});

test("output is limited in bytes before it is decoded, in the caller's encoding", async () => {
  const f = fakeSpawn();
  const run = asyncCommandRunFrom(f.spawnChild);
  // 400 KB of bytes that are not UTF-8: under the 1 MiB limit, decoded after.
  const invalid = run("git", ["diff"]);
  f.children[0]!.stdout.write(Buffer.alloc(400_000, 0xff));
  await f.children[0]!.finish(0, null);
  const r = await invalid;
  expect(r.status).toBe(0);
  expect(r.stdout.length).toBe(400_000);
  const latin = run("git", ["show"], { encoding: "latin1" });
  f.children[1]!.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await f.children[1]!.finish(0, null);
  expect((await latin).stdout).toBe("café");
  // Past the limit: the child is stopped with the caller's signal, the read
  // that crossed it is kept whole, and it is ENOBUFS.
  const tooMuch = run("yes", [], { maxBuffer: 10, killSignal: "SIGKILL" });
  f.children[2]!.stdout.write("y\n".repeat(8));
  await tick();
  expect(f.children[2]!.signals).toStrictEqual(["SIGKILL"]);
  await f.children[2]!.finish(null, "SIGKILL");
  const over = await tooMuch;
  expect(over).toMatchObject({ status: null, signal: "SIGKILL", stdout: "y\n".repeat(8) });
  expect((over.error as NodeJS.ErrnoException).code).toBe("ENOBUFS");
  // Each stream has its own limit: 700 KB of output and 400 KB of warnings fit.
  const both = run("git", ["diff"]);
  f.children[3]!.stdout.write(Buffer.alloc(700 * 1024, 0x61));
  f.children[3]!.stderr.write(Buffer.alloc(400 * 1024, 0x62));
  await f.children[3]!.finish(0, null);
  const fitted = await both;
  expect([fitted.status, fitted.stdout.length, fitted.stderr.length]).toStrictEqual([0, 700 * 1024, 400 * 1024]);
});

test("a launch that fails as spawn is called answers as a failed spawn, never a thrown error", async () => {
  const notADirectory = Object.assign(new Error("ENOTDIR: not a directory, posix_spawn 'git'"), { code: "ENOTDIR" });
  const run = asyncCommandRunFrom((() => { throw notADirectory; }) as never);
  expect(await run("git", ["status"], { cwd: "/etc/hosts" })).toStrictEqual({ status: null, signal: null, stdout: "", stderr: "", error: notADirectory });
});

test("a child that exits before its timeout, its output held open, still answers once the timeout has stopped it", async () => {
  const f = fakeSpawn();
  const run = asyncCommandRunFrom(f.spawnChild, { drainMs: 10 });
  const held = run("git", ["fetch"], { timeout: 20 });
  f.children[0]!.stdout.write("fetched\n");
  f.children[0]!.exitHeld(0, null);
  const r = await held;
  expect(r).toMatchObject({ status: null, signal: null, stdout: "fetched\n" });
  expect((r.error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
});

test("a stopped child whose output a descendant holds open answers once a short wait has passed", async () => {
  const f = fakeSpawn();
  const run = asyncCommandRunFrom(f.spawnChild, { drainMs: 10 });
  const stopped = run("git", ["fetch"], { timeout: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.children[0]!.stdout.write("partial\n");
  f.children[0]!.exitHeld(null, "SIGTERM");
  const r = await stopped;
  expect(r).toMatchObject({ status: null, signal: "SIGTERM", stdout: "partial\n" });
  expect((r.error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
  expect(f.children[0]!.stdout.destroyed && f.children[0]!.stderr.destroyed).toBe(true);
});

test("the async run starts the child with the caller's cwd and env and no stdin", async () => {
  const f = fakeSpawn();
  const run = asyncCommandRunFrom(f.spawnChild);
  const done = run("git", ["-C", "/repo", "status"], { cwd: "/repo", env: { HOME: "/h" }, timeout: 1500 });
  await f.children[0]!.finish(0, null);
  await done;
  expect(f.seen).toStrictEqual([{ command: "git", args: ["-C", "/repo", "status"], options: { cwd: "/repo", env: { HOME: "/h" }, stdio: ["ignore", "pipe", "pipe"] } }]);
});

test("a stopped child whose exit is never reported still answers, as a timeout, and is killed outright", async () => {
  // Seen under the full test suite's load: a git child with no exit or close
  // event at all, a second after its timeout. The call must still end: one
  // that never answers holds its request, and the project's turn, forever.
  captureLog();
  const f = fakeSpawn();
  const run = asyncCommandRunFrom(f.spawnChild, { drainMs: 10, exitWaitMs: 30 });
  const stopped = run("git", ["rev-parse", "--git-dir"], { timeout: 5 });
  f.children[0]!.stdout.write("partial\n");
  const r = await stopped;
  expect(r).toMatchObject({ status: null, stdout: "partial\n" });
  expect((r.error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
  expect(commandDidNotAnswer(r)).toBe(true);
  expect(f.children[0]!.signals).toStrictEqual(["SIGTERM", "SIGKILL"]);
  expect(f.children[0]!.stdout.destroyed && f.children[0]!.stderr.destroyed).toBe(true);
});
