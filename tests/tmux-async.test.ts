import { expect, test } from "bun:test";
import * as tmuxModule from "../src/server/platform/tmux/tmux.js";
import type { CommandResult, CommandRunner } from "../src/server/platform/process/command-runner.js";
import { BroadcastCenter } from "../src/server/runtime/broadcast-center.js";
import { probeTmux } from "../src/server/modules/setup/module.js";
import { FIELD_SEP } from "../src/server/platform/text/text.js";
import { SSE_EVENTS, type ProjectStateDto } from "../src/shared/api-contracts.js";
import { freshProjectEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import type { FakeTmuxServer } from "./helpers/fake-tmux.js";
import { tempDir } from "./helpers/temp.js";
import { workerToolContext } from "./helpers/typed.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import { spawnPaneTool } from "../src/server/modules/panes/tools/spawn-pane.js";
import { WorkerService } from "../src/server/modules/workers/worker-service.js";
import { buildWorkersTestApp, buildProjectsTestApp, buildSessionsTestApp, deleteJson, postJson } from "./helpers/test-app.js";

// tmux runs while the server goes on, as git does: a project's create, adopt
// and session rebuild, a worker's window, the sessions list, the projects
// state pushed to every page. A tmux call takes a few milliseconds, but
// thousands of them a minute added up to stalls; and two requests may now
// interleave between asking tmux and acting on the answer.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ok = (stdout = ""): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });

/** The fake tmux, answering only without holding the server's thread; each
 *  answer is what tmux said when asked, given when released. */
function heldTmux(fake: FakeTmuxServer) {
  const waiting: Array<{ args: string[]; go: () => void }> = [];
  const runner: CommandRunner = {
    run: async (command, args, options) => {
      const answer = fake.client.runner!.run(command, args, options);
      return new Promise((resolve) => { waiting.push({ args, go: () => resolve(answer) }); });
    }
  };
  const drain = async <T>(done: Promise<T>, which: "oldest" | "newest" = "oldest"): Promise<T> => {
    let finished = false;
    done.then(() => { finished = true; }, () => { finished = true; });
    for (let turns = 0; turns < 400 && !finished; turns++) {
      if (waiting.length > 0) (which === "oldest" ? waiting.shift()! : waiting.pop()!).go();
      await settle();
    }
    return done;
  };
  return { client: { socketArgs: fake.client.socketArgs, runner } satisfies tmuxModule.TmuxClient, waiting, drain };
}

test("every tmux command runs without holding the server", async () => {
  const asked: string[][] = [];
  const answer = (args: string[]): CommandResult => {
    if (args.includes("split-window")) return ok("%9\n");
    if (args.includes("new-window")) return ok("@9\n");
    if (args.includes("list-windows")) return ok(`@1${FIELD_SEP}w\n`);
    return ok("x\n");
  };
  const client: tmuxModule.TmuxClient = {
    socketArgs: [],
    runner: {
      run: async (_command, args) => { asked.push(args); return answer(args); }
    }
  };
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["command", () => tmuxModule.tmuxCommand(client, ["-V"])],
    ["has session", () => tmuxModule.tmuxHasSession("s", client)],
    ["new session", () => tmuxModule.tmuxNewSession("s", "/", client)],
    ["kill session", () => tmuxModule.tmuxKillSession("s", client)],
    ["list sessions", () => tmuxModule.tmuxListSessions(client)],
    ["has window", () => tmuxModule.tmuxHasWindow("s", "w", client)],
    ["list windows", () => tmuxModule.tmuxListWindows("s", client)],
    ["new window", () => tmuxModule.tmuxNewWindow("s", "w", "/", client)],
    ["kill window", () => tmuxModule.tmuxKillWindow("s", "w", client)],
    ["kill window by id", () => tmuxModule.tmuxKillWindowById("@1", client)],
    ["split pane", () => tmuxModule.tmuxSplitPane("%1", "right", client)],
    ["pane window id", () => tmuxModule.tmuxPaneWindowId("%1", client)],
    ["kill pane", () => tmuxModule.tmuxKillPane("%1", client)],
    ["sessions with windows", () => tmuxModule.tmuxListSessionsWithWindows(client)],
    ["setup probe", () => probeTmux(client)]
  ];
  for (const [name, call] of calls) {
    const before = asked.length;
    const answered = call();
    expect([name, answered instanceof Promise]).toEqual([name, true]);
    await answered;
    expect([name, asked.length > before]).toEqual([name, true]);
  }
});

/** git as a folder that is no repository answers. */
const NO_REPOSITORY = { runner: { run: async (): Promise<CommandResult> => ({ status: 128, signal: null, stdout: "", stderr: "fatal: not a git repository" }) } };

function workersApp(env: ReturnType<typeof freshProjectEnv>, tmuxClient: tmuxModule.TmuxClient) {
  const deps = {
    projects: env.projects, workers: env.workers, agentStore: env.agentStore, tmuxClient, gitClient: NO_REPOSITORY, broadcast: () => {},
    tmuxRuntime: new TmuxRuntime({ tmuxClient, projectsStore: env.projects, workersStore: env.workers })
  };
  return { deps, app: buildWorkersTestApp(deps), projectsApp: buildProjectsTestApp(deps) };
}

/** tmux as the fake has it, asked directly: not through the code under test. */
const rawTmux = (env: ReturnType<typeof freshProjectEnv>, args: string[]) =>
  env.tmux.answer(args);

const windowsNamed = (env: ReturnType<typeof freshProjectEnv>, session: string, name: string) =>
  rawTmux(env, ["list-windows", "-t", session, "-F", "#{window_name}"]).stdout.split("\n").filter((line) => line.trim() === name).length;

test("two terminals asked for at once for a worker whose window is gone open one window", async () => {
  const env = freshProjectEnv("md-tmux-async-window-");
  const wd = tempDir("md-wd-");
  const projectId = seedProject(env.projects, { workingDir: wd, tmuxSessionName: "md-ta" });
  rawTmux(env, ["new-session", "-d", "-s", "md-ta", "-c", wd]);
  const workerId = seedWorker(env.workers, projectId, { name: "F", tmuxWindowName: "f" });
  const { app } = workersApp(env, env.tmux.client);
  const both = await Promise.all([0, 1].map(() => postJson(app, `/api/workers/${workerId}/panes`, {})));
  expect(both.map((r) => r.status)).toEqual([200, 200]);
  expect(windowsNamed(env, "md-ta", "f")).toBe(1);
});

test("two workers' terminals asked for at once in a project whose session is gone rebuild it once, and both open", async () => {
  const env = freshProjectEnv("md-tmux-async-session-");
  const wd = tempDir("md-wd-");
  const projectId = seedProject(env.projects, { workingDir: wd, tmuxSessionName: "md-tb" });
  const first = seedWorker(env.workers, projectId, { name: "A", tmuxWindowName: "a" });
  const second = seedWorker(env.workers, projectId, { name: "B", tmuxWindowName: "b" });
  const { app } = workersApp(env, env.tmux.client);
  const both = await Promise.all([first, second].map((id) => postJson(app, `/api/workers/${id}/panes`, {})));
  expect(both.map((r) => r.status)).toEqual([200, 200]);
  expect([windowsNamed(env, "md-tb", "a"), windowsNamed(env, "md-tb", "b")]).toEqual([1, 1]);
});

test("two projects made at once whose names make one session name each get a tmux session of their own", async () => {
  const env = freshProjectEnv("md-tmux-async-projects-");
  const { projectsApp } = workersApp(env, env.tmux.client);
  const make = (name: string) => postJson(projectsApp, "/api/projects", { name, workingDir: tempDir("md-wd-") });
  const both = await Promise.all([make("Shop"), make("shop")]);
  expect(both.map((r) => r.status)).toEqual([200, 200]);
  expect(new Set(env.projects.listActive().map((p) => p.tmuxSessionName)).size).toBe(2);
});

test("the server answers other requests while the sessions list waits on tmux", async () => {
  const env = freshProjectEnv("md-tmux-async-sessions-");
  rawTmux(env, ["new-session", "-d", "-s", "md-tc", "-c", "/"]);
  const tmux = heldTmux(env.tmux);
  const app = buildSessionsTestApp({ projects: env.projects, tmuxClient: tmux.client, getRawState: () => null });
  app.get("/ping", (c) => c.text("pong"));
  const listed = app.request("/api/tmux/sessions");
  while (tmux.waiting.length === 0) await settle();
  expect(await (await app.request("/ping")).text()).toBe("pong");
  const response = await tmux.drain(Promise.resolve(listed));
  expect(response.status).toBe(200);
});

test("the projects state pushed to pages is never an older tmux answer over a newer one", async () => {
  const env = freshProjectEnv("md-tmux-async-state-");
  const wd = tempDir("md-wd-");
  seedProject(env.projects, { workingDir: wd, tmuxSessionName: "md-td" });
  // Another session keeps tmux's server up while the project's is not there.
  rawTmux(env, ["new-session", "-d", "-s", "md-other", "-c", wd]);
  const tmux = heldTmux(env.tmux);
  const pushed: ProjectStateDto[][] = [];
  const center = new BroadcastCenter({
    sse: { emit: (type: string, data: unknown) => { if (type === SSE_EVENTS.projectsState) pushed.push(data as ProjectStateDto[]); } } as never,
    projectsStore: env.projects, workersStore: env.workers, tmuxClient: tmux.client
  });
  // Asked while the project's session is gone, and again once it is there.
  const older = center.projectsState();
  rawTmux(env, ["new-session", "-d", "-s", "md-td", "-c", wd]);
  const newer = center.projectsState();
  // tmux answers the newer one first.
  await tmux.drain(Promise.all([older, newer]), "newest");
  expect(pushed.at(-1)?.[0]?.tmuxStatus).toBe("alive");
});

test("two panes an agent asks for at once for its worker whose window is gone open one window", async () => {
  const env = freshProjectEnv("md-tmux-async-spawn-");
  const wd = tempDir("md-wd-");
  const projectId = seedProject(env.projects, { workingDir: wd, tmuxSessionName: "md-te" });
  rawTmux(env, ["new-session", "-d", "-s", "md-te", "-c", wd]);
  const workerId = seedWorker(env.workers, projectId, { name: "F", tmuxWindowName: "f" });
  const paneRuntime = new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers });
  const ctx = workerToolContext(wd, {
    threadId: "t", wakeId: "w",
    worker: env.workers.getById(workerId)!, project: env.projects.getById(projectId)!,
    tmuxClient: env.tmux.client, analyzer: new Analyzer(), paneRuntime
  });
  const both = await Promise.all([spawnPaneTool.handler({}, ctx), spawnPaneTool.handler({}, ctx)]);
  expect(both.map((r) => "paneId" in r)).toEqual([true, true]);
  expect(windowsNamed(env, "md-te", "f")).toBe(1);
});

test("a project whose session could not be made is archived before a worker asked for in it meanwhile gets its turn", async () => {
  const env = freshProjectEnv("md-tmux-async-failed-session-");
  let failSession: (() => void) | null = null;
  let heldOnce = false;
  const tmuxClient: tmuxModule.TmuxClient = {
    socketArgs: env.tmux.client.socketArgs,
    runner: {
      run: async (command, args, options) => {
        // The first session fails, once it is let go; any later one is made.
        if (args.includes("new-session") && !heldOnce) {
          heldOnce = true;
          await new Promise<void>((resolve) => { failSession = resolve; });
          return { status: 1, signal: null, stdout: "", stderr: "server exited unexpectedly" };
        }
        return env.tmux.client.runner!.run(command, args, options);
      }
    }
  };
  const { projectsApp, app } = workersApp(env, tmuxClient);
  const made = postJson(projectsApp, "/api/projects", { name: "Shop", workingDir: tempDir("md-wd-") });
  while (!failSession) await settle();
  const projectId = env.projects.listActive()[0]!.id;
  const worker = postJson(app, `/api/projects/${projectId}/workers`, { name: "F", mode: "shared-cwd" });
  await settle();
  (failSession as () => void)();
  expect((await made).status).toBe(500);
  expect((await worker).status).toBe(404);
  expect(env.workers.listActiveByProject(projectId)).toEqual([]);
});

test("a pane an agent asks for after its worker was archived is refused, and opens no window", async () => {
  const env = freshProjectEnv("md-tmux-async-archived-spawn-");
  const wd = tempDir("md-wd-");
  const projectId = seedProject(env.projects, { workingDir: wd, tmuxSessionName: "md-tf" });
  rawTmux(env, ["new-session", "-d", "-s", "md-tf", "-c", wd]);
  const workerId = seedWorker(env.workers, projectId, { name: "F", tmuxWindowName: "f" });
  const paneRuntime = new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers });
  const ctx = workerToolContext(wd, {
    threadId: "t", wakeId: "w",
    worker: env.workers.getById(workerId)!, project: env.projects.getById(projectId)!,
    tmuxClient: env.tmux.client, analyzer: new Analyzer(), paneRuntime
  });
  // Archived while the agent's turn still had the worker it started with.
  env.workers.archive(workerId);
  const answer = await spawnPaneTool.handler({}, ctx);
  expect("error" in answer).toBe(true);
  expect(windowsNamed(env, "md-tf", "f")).toBe(0);
});

/** The fake tmux, with new-window held until let go. */
function windowsHeld(env: ReturnType<typeof freshProjectEnv>) {
  let release: (() => void) | null = null;
  const client: tmuxModule.TmuxClient = {
    socketArgs: env.tmux.client.socketArgs,
    runner: {
      run: async (command, args, options) => {
        if (args.includes("new-window")) await new Promise<void>((resolve) => { release = resolve; });
        return env.tmux.client.runner!.run(command, args, options);
      }
    }
  };
  return { client, held: () => release !== null, release: () => (release as unknown as () => void)() };
}

test("a worker being made or restored is not active until its window is open: nothing can start work in it before", async () => {
  const env = freshProjectEnv("md-tmux-async-records-last-");
  const wd = tempDir("md-wd-");
  const projectId = seedProject(env.projects, { workingDir: wd, tmuxSessionName: "md-ti" });
  rawTmux(env, ["new-session", "-d", "-s", "md-ti", "-c", wd]);
  const tmux = windowsHeld(env);
  const { app } = workersApp(env, tmux.client);
  const made = postJson(app, `/api/projects/${projectId}/workers`, { name: "New", mode: "shared-cwd" });
  while (!tmux.held()) await settle();
  expect(env.workers.listActiveByProject(projectId)).toEqual([]);
  tmux.release();
  expect((await made).status).toBe(200);

  const archivedId = seedWorker(env.workers, projectId, { name: "Old", tmuxWindowName: "old" });
  env.workers.archive(archivedId);
  const again = windowsHeld(env);
  const restored = new WorkerService(workersApp(env, again.client).deps).restore({ id: archivedId });
  while (!again.held()) await settle();
  expect(env.workers.getById(archivedId)!.archivedAt).not.toBeNull();
  again.release();
  expect((await restored).ok).toBe(true);
  expect(env.workers.getById(archivedId)!.archivedAt).toBeNull();
});

test("a project rebuild queued behind its archive rebuilds nothing", async () => {
  const env = freshProjectEnv("md-tmux-async-rebuild-archived-");
  const wd = tempDir("md-wd-");
  rawTmux(env, ["new-session", "-d", "-s", "md-tj", "-c", wd]);
  // The archive is held at its kill-session, still unarchived, while the
  // rebuild is asked for: it has to wait its turn and then find it archived.
  let killSession: (() => void) | null = null;
  const tmuxClient: tmuxModule.TmuxClient = {
    socketArgs: env.tmux.client.socketArgs,
    runner: {
      run: async (command, args, options) => {
        if (args.includes("kill-session")) await new Promise<void>((resolve) => { killSession = resolve; });
        return env.tmux.client.runner!.run(command, args, options);
      }
    }
  };
  const projectId = seedProject(env.projects, { workingDir: wd, tmuxSessionName: "md-tj", ownership: "adopted" });
  const { projectsApp } = workersApp(env, tmuxClient);
  const archived = deleteJson(projectsApp, `/api/projects/${projectId}?killTmux=true`);
  while (!killSession) await settle();
  const rebuilt = postJson(projectsApp, `/api/projects/${projectId}/reconcile`, {});
  for (let i = 0; i < 10; i++) await settle();
  (killSession as () => void)();
  expect((await archived).status).toBe(200);
  expect((await rebuilt).status).toBe(404);
  expect(rawTmux(env, ["has-session", "-t", "md-tj"]).status).not.toBe(0);
});

test("a pane an agent asks for without a folder opens where its worker works when its turn comes", async () => {
  const env = freshProjectEnv("md-tmux-async-pane-cwd-");
  const before = tempDir("md-wd-before-");
  const after = tempDir("md-wd-after-");
  const projectId = seedProject(env.projects, { workingDir: before, tmuxSessionName: "md-tk" });
  rawTmux(env, ["new-session", "-d", "-s", "md-tk", "-c", before]);
  const workerId = seedWorker(env.workers, projectId, { name: "F", tmuxWindowName: "f" });
  rawTmux(env, ["new-window", "-d", "-t", "md-tk", "-n", "f", "-c", before]);
  const paneRuntime = new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers });
  // The agent's turn began with the project in its old folder.
  const ctx = workerToolContext(before, {
    threadId: "t", wakeId: "w",
    worker: env.workers.getById(workerId)!, project: env.projects.getById(projectId)!,
    tmuxClient: env.tmux.client, analyzer: new Analyzer(), paneRuntime
  });
  env.projects.updateWorkingDir(projectId, { workingDir: after, isGit: false, gitRemote: null });
  const answer = await spawnPaneTool.handler({}, ctx);
  expect("paneId" in answer).toBe(true);
  const paths = rawTmux(env, ["list-panes", "-t", "md-tk:f", "-F", "#{pane_current_path}"]).stdout.split("\n").filter(Boolean);
  expect(paths.at(-1)).toBe(after);
});

test("keys sent to one pane at once reach tmux one send at a time, in the order they came", async () => {
  const env = freshProjectEnv("md-tmux-async-keys-");
  const sent: string[] = [];
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  let most = 0;
  const tmuxClient: tmuxModule.TmuxClient = {
    socketArgs: [],
    runner: {
      run: async (_command, args) => {
        if (!args.includes("send-keys")) return ok();
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise<void>((resolve) => { waiting.push(resolve); });
        sent.push(args.at(-1)!);
        inFlight--;
        return ok();
      }
    }
  };
  const runtime = new TmuxRuntime({ tmuxClient, projectsStore: env.projects, workersStore: env.workers });
  const all = Promise.all(["one", "two", "three"].map((word) => runtime.sendKeys("%1", ["-l", word])));
  for (let turns = 0; turns < 50 && sent.length < 3; turns++) {
    waiting.shift()?.();
    await settle();
  }
  await all;
  expect(sent).toEqual(["one", "two", "three"]);
  expect(most).toBe(1);
});
