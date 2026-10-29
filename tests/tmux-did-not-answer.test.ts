import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  tmuxHasSession,
  tmuxHasWindow,
  tmuxListSessions,
  tmuxListSessionsWithWindows,
  tmuxKillSession,
  tmuxKillWindow,
  tmuxListWindows,
  tmuxNewSession,
  tmuxNewWindow,
  type TmuxClient
} from "../src/server/platform/tmux/tmux.js";
import { CommandDidNotAnswerError } from "../src/server/platform/process/command-runner.js";
import { reconcileFeature } from "../src/server/modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../src/server/modules/projects/tmux-reconcile-adapter.js";
import { buildPaneRuntimes } from "../src/server/runtime/pane-runtime-registry.js";
import { BroadcastCenter } from "../src/server/runtime/broadcast-center.js";
import { onHttpError } from "../src/server/app/http-app.js";
import { startFakeTmuxServer, stallingTmux } from "./helpers/fake-tmux.js";
import { freshProjectEnv } from "./helpers/fixtures.js";
import { buildFeaturesTestApp, buildProjectsTestApp, deleteJson, postJson } from "./helpers/test-app.js";
import { tempDir } from "./helpers/temp.js";
import { seedProject } from "./helpers/fixtures.js";
import type { GitClient } from "../src/server/platform/git/git.js";
import type { LifecycleEvent } from "../src/server/runtime/events.js";

/**
 * A tmux that does not answer in time is not a tmux that says no. Read as
 * "no", it made Mandate open a second window beside the feature's own, split
 * an extra pane, register a project with none of its workers, and show every
 * project as gone. Bun 1.4.2's spawnSync can stall every call this way
 * (oven-sh/bun#34069); an ordinary timeout does it one call at a time.
 */

const missingTmux: TmuxClient = {
  socketArgs: [],
  runner: {
    run: () => ({
      status: null, signal: null, stdout: "", stderr: "",
      error: Object.assign(new Error("spawnSync tmux ENOENT"), { code: "ENOENT" })
    })
  }
};

test("the probes throw when tmux does not answer, answer no when it says no, and treat no tmux at all as no", () => {
  const fake = startFakeTmuxServer();
  try {
    tmuxNewSession("md", "/tmp", fake.client);
    const stalled = stallingTmux(fake.client, () => true);
    const probes: Array<[string, () => unknown]> = [
      ["has-session", () => tmuxHasSession("md", stalled)],
      ["list-sessions", () => tmuxListSessions(stalled)],
      ["list-windows", () => tmuxListWindows("md", stalled)],
      ["has-window", () => tmuxHasWindow("md", "sh", stalled)],
      ["list-windows -a", () => tmuxListSessionsWithWindows(stalled)]
    ];
    for (const [name, probe] of probes) {
      expect([name, (() => { try { probe(); return "answered"; } catch (err) { return err instanceof CommandDidNotAnswerError ? "did not answer" : String(err); } })()]).toEqual([name, "did not answer"]);
    }
    expect(tmuxHasSession("gone", fake.client)).toBe(false);
    expect(tmuxListWindows("gone", fake.client)).toEqual([]);
    expect(tmuxHasSession("md", missingTmux)).toBe(false);
    expect(tmuxListSessions(missingTmux)).toEqual([]);
    expect(tmuxListSessionsWithWindows(missingTmux)).toEqual([]);
  } finally {
    fake.cleanup();
  }
});

test("a window check that does not answer opens no second window", () => {
  const fake = startFakeTmuxServer();
  try {
    tmuxNewSession("md-p", "/tmp", fake.client);
    tmuxNewWindow("md-p", "feat", "/tmp", fake.client);
    const before = fake.calls.filter((c) => c[0] === "new-window").length;
    const stalled = stallingTmux(fake.client, (args) => args.includes("list-windows"));
    const project = { id: "p1", name: "P", workingDir: "/tmp", tmuxSessionName: "md-p", ownership: "app", isGit: false, gitRemote: null, archivedAt: null };
    const feature = { id: "f1", projectId: "p1", name: "feat", tmuxWindowName: "feat", worktreePath: null, ownership: "app", archivedAt: null };
    expect(() => reconcileFeature(feature as never, project as never, tmuxReconcileAdapter(stalled))).toThrow(CommandDidNotAnswerError);
    expect(fake.calls.filter((c) => c[0] === "new-window").length).toBe(before);
    expect(tmuxListWindows("md-p", fake.client)).toEqual(["sh", "feat"]);
  } finally {
    fake.cleanup();
  }
});

function makeApps(stalls: (args: string[]) => boolean, gitClient?: GitClient) {
  const env = freshProjectEnv("md-unanswered-");
  const tmuxClient = stallingTmux(env.tmux.client, stalls);
  const events: LifecycleEvent[] = [];
  const deps = {
    projects: env.projects, features: env.features, agentStore: env.agentStore, tmuxClient, gitClient,
    broadcast: (event: LifecycleEvent) => { events.push(event); },
    paneRuntimes: buildPaneRuntimes({ tmuxClient, projectsStore: env.projects, featuresStore: env.features })
  };
  return { ...env, tmuxClient, events, paneRuntimes: deps.paneRuntimes, projectsApp: buildProjectsTestApp(deps), featuresApp: buildFeaturesTestApp(deps) };
}

test("a project is not created when tmux does not answer its session list", async () => {
  const s = makeApps((args) => args.includes("list-sessions"));
  try {
    const r = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(s.projects.listActive()).toEqual([]);
  } finally {
    s.cleanup();
  }
});

test("adopting a session tmux does not answer about writes nothing", async () => {
  for (const stalledCommand of ["has-session", "list-windows"]) {
    const s = makeApps((args) => args.includes(stalledCommand));
    try {
      tmuxNewSession("real", "/tmp", s.tmux.client);
      tmuxNewWindow("real", "editor", "/tmp", s.tmux.client);
      const r = await postJson(s.projectsApp, "/api/projects/adopt", { sessionName: "real", projectName: "Real", workingDir: tempDir("md-wd-") });
      expect([stalledCommand, r.status >= 500]).toEqual([stalledCommand, true]);
      expect([stalledCommand, s.projects.listActive().length]).toEqual([stalledCommand, 0]);
    } finally {
      s.cleanup();
    }
  }
});

test("archiving goes ahead when tmux does not answer about the window: the window is left, and said so", async () => {
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-windows"));
  try {
    const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    const feat = await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "F", mode: "shared-cwd" });
    expect(feat.status).toBe(200);
    stalled = true;
    const r = await deleteJson(s.featuresApp, `/api/features/${feat.body.id}?confirmed=1`);
    expect(r.status).toBe(200);
    expect(s.features.getById(feat.body.id)!.archivedAt).toBeTruthy();
    expect(r.body.cleanupFailures).toEqual([expect.objectContaining({ kind: "terminal", error: expect.stringContaining("did not answer") })]);
    expect(s.events.find((event) => event.type === "featureTerminalCleanupFailed")?.data)
      .toEqual({ id: feat.body.id, windowName: feat.body.tmuxWindowName, error: expect.stringContaining("did not answer") });
    expect(s.tmux.calls.some((c) => c[0] === "kill-window")).toBe(false);
  } finally {
    s.cleanup();
  }
});

test("a shell pane is not split when tmux does not answer which panes the feature has", async () => {
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-panes") && args.some((a) => a.includes("pane_current_command")));
  try {
    const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    const feat = await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "F", mode: "shared-cwd" });
    const splits = () => s.tmux.calls.filter((c) => c[0] === "split-window").length;
    const before = splits();
    stalled = true;
    const r = await postJson(s.featuresApp, `/api/features/${feat.body.id}/panes`, {});
    expect([r.status, r.body.retryable]).toEqual([503, true]);
    expect(splits()).toBe(before);
  } finally {
    s.cleanup();
  }
});

test("a split does not go ahead when tmux does not answer how big the window's panes are", async () => {
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-panes") && args.some((a) => a.includes("pane_width")));
  try {
    const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    const feat = await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "F", mode: "shared-cwd" });
    const splits = () => s.tmux.calls.filter((c) => c[0] === "split-window").length;
    const before = splits();
    stalled = true;
    const runtime = s.paneRuntimes.forProject(proj.body.id);
    const outcome = await runtime.spawnPane({ featureId: feat.body.id, cwd: "/tmp" }).then(() => "split", (err) => err instanceof CommandDidNotAnswerError ? "did not answer" : String(err));
    expect(outcome).toBe("did not answer");
    expect(splits()).toBe(before);
  } finally {
    s.cleanup();
  }
});

test("the projects broadcast keeps what it last sent when tmux does not answer", async () => {
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-windows"));
  try {
    await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    const sent: unknown[] = [];
    const center = new BroadcastCenter({
      sse: { emit: (_event: string, data: unknown) => sent.push(data) },
      projectsStore: s.projects, featuresStore: s.features, tmuxClient: s.tmuxClient
    } as unknown as ConstructorParameters<typeof BroadcastCenter>[0]);
    center.projectsState();
    expect(sent).toHaveLength(1);
    stalled = true;
    expect(() => center.projectsState()).not.toThrow();
    expect(sent).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

test("over HTTP, a command that did not answer is a 503 the user can retry", async () => {
  const app = new Hono();
  app.onError(onHttpError);
  app.get("/x", () => { throw new CommandDidNotAnswerError("tmux list-sessions"); });
  const res = await app.request("/x");
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ error: "tmux list-sessions did not answer in time. Try again.", retryable: true });
});

test("a project whose new session tmux does not answer about is not left active, and the user is told to retry", async () => {
  const s = makeApps((args) => args.includes("has-session"));
  try {
    const r = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    expect([r.status, r.body.retryable]).toEqual([503, true]);
    expect(s.projects.listActive()).toEqual([]);
  } finally {
    s.cleanup();
  }
});

test("a new worker whose window check does not answer leaves no branch behind, so it can be created again", async () => {
  const gitCalls: string[][] = [];
  const git: GitClient = {
    runner: {
      run(_command, args) {
        gitCalls.push(args);
        if (args.includes("show-ref")) return { status: 1, signal: null, stdout: "", stderr: "" }; // the branch is new
        if (args.includes("rev-parse")) return { status: 0, signal: null, stdout: "abc123\n", stderr: "" };
        return { status: 0, signal: null, stdout: "", stderr: "" }; // worktree add / remove, branch -D
      }
    }
  };
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-windows"), git);
  try {
    const wd = tempDir("md-wd-");
    const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-g" });
    tmuxNewSession("md-g", wd, s.tmux.client);
    stalled = true;
    const r = await postJson(s.featuresApp, `/api/projects/${projectId}/features`, { name: "F", mode: "new-branch-new-worktree", branch: "feat-x", baseRef: "main" });
    expect([r.status, r.body.retryable]).toEqual([503, true]);
    expect(gitCalls.some((a) => a.includes("worktree") && a.includes("add"))).toBe(true);
    expect(gitCalls.some((a) => a.includes("branch") && a.includes("-D") && a.includes("feat-x"))).toBe(true);
    expect(s.features.listActiveByProject(projectId)).toEqual([]);
  } finally {
    s.cleanup();
  }
});

test("a restore whose window check does not answer puts the worker back exactly as it was", async () => {
  let listWindows = 0;
  let stallFrom = Infinity;
  const s = makeApps((args) => args.includes("list-windows") && ++listWindows >= stallFrom);
  try {
    const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    const feat = await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "F", mode: "shared-cwd" });
    const id = feat.body.id as string;
    const owner = s.agentStore.createManagerThread("Owner");
    s.features.setOwner(id, owner.id);
    s.agentStore.getOrCreateThread("worker", id);
    await deleteJson(s.featuresApp, `/api/features/${id}?confirmed=1`);
    const workerThread = s.agentStore.getThreadByScope("worker", id);
    if (workerThread) s.agentStore.archiveThread(workerThread.id);
    // Archived well before: a rollback that stamps a new archive time shows.
    s.store.db.prepare("update features set archived_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", id);
    const before = s.features.getById(id)!;
    expect(before.archivedAt).toBeTruthy();
    // The conflict check answers (no such window); the reconcile after the rewrite does not.
    stallFrom = listWindows + 2;
    const r = await postJson(s.featuresApp, `/api/features/${id}/restore`, { tmuxWindowName: "renamed" });
    expect([r.status, r.body.retryable]).toEqual([503, true]);
    const after = s.features.getById(id)!;
    const shape = (f: typeof before) => ({ archivedAt: f.archivedAt, tmuxWindowName: f.tmuxWindowName, mode: f.mode, branch: f.branch, worktreePath: f.worktreePath, ownerThreadId: f.ownerThreadId });
    expect(shape(after)).toEqual(shape(before));
    expect(s.agentStore.getThreadByScope("worker", id)).toBe(null);
  } finally {
    s.cleanup();
  }
});

test("a restore that rebuilt the session and then could not finish closes the window it opened, so the same restore can be retried", async () => {
  let listWindows = 0;
  let stallAt = -1;
  const s = makeApps((args) => args.includes("list-windows") && ++listWindows === stallAt);
  try {
    const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    const feat = await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "F", mode: "shared-cwd" });
    const id = feat.body.id as string;
    await deleteJson(s.featuresApp, `/api/features/${id}?confirmed=1`);
    const session = s.projects.getById(proj.body.id)!.tmuxSessionName;
    const windowName = s.features.getById(id)!.tmuxWindowName;
    tmuxKillSession(session, s.tmux.client);
    // 1: the conflict check (no session, no window). 2: the rebuild opens the window. 3: the last check stalls.
    stallAt = listWindows + 3;
    const failed = await postJson(s.featuresApp, `/api/features/${id}/restore`, {});
    expect([failed.status, failed.body.retryable]).toEqual([503, true]);
    expect(tmuxListWindows(session, s.tmux.client).includes(windowName)).toBe(false);
    const retried = await postJson(s.featuresApp, `/api/features/${id}/restore`, {});
    expect(retried.status).toBe(200);
  } finally {
    s.cleanup();
  }
});

test("a create that rebuilt the session and then could not finish closes the window it opened", async () => {
  let listWindows = 0;
  let stallAt = -1;
  const s = makeApps((args) => args.includes("list-windows") && ++listWindows === stallAt);
  try {
    const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    const other = await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "G", mode: "shared-cwd" });
    const otherWindow = s.features.getById(other.body.id)!.tmuxWindowName;
    const session = s.projects.getById(proj.body.id)!.tmuxSessionName;
    tmuxKillSession(session, s.tmux.client);
    // The rebuild checks (and opens) G's window, then F's; the last check, F's again, stalls.
    stallAt = listWindows + 3;
    const r = await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "F", mode: "shared-cwd" });
    expect([r.status, r.body.retryable]).toEqual([503, true]);
    const windows = tmuxListWindows(session, s.tmux.client);
    expect(windows).toContain(otherWindow);
    expect(windows.filter((w) => w.toLowerCase() === "f")).toEqual([]);
  } finally {
    s.cleanup();
  }
});

test("a worker's context says its panes could not be read, not that it has none, when tmux does not answer", async () => {
  const { buildWorkerRuntimeContext } = await import("../src/server/modules/agent/system-prompt.js");
  const unknown = buildWorkerRuntimeContext({ panes: null });
  expect(unknown).toContain("Active panes: unknown (tmux did not answer)");
  expect(unknown).not.toContain("Active panes: 0");
  expect(buildWorkerRuntimeContext({ panes: [] })).toContain("Active panes: 0");
});

test("a worker wake whose pane read does not answer gets that context, not an empty pane list", async () => {
  const { paneContextFor } = await import("../src/server/runtime/scopes/worker-scope.js");
  const runtime = { listPanes: async () => { throw new CommandDidNotAnswerError("tmux list-panes"); } };
  const other = { listPanes: async () => { throw new Error("feature gone"); } };
  const base = { project: {} as never, feature: { id: "f1" } as never, analyzer: { getCachedAnalysis: () => null } as never };
  expect(await paneContextFor({ ...base, paneRuntime: runtime as never })).toBe(null);
  expect(await paneContextFor({ ...base, paneRuntime: other as never })).toEqual([]);
});

test("the fake reads a numeric window target as an index first, as tmux 3.7c does", () => {
  const fake = startFakeTmuxServer();
  try {
    tmuxNewSession("s", "/tmp", fake.client);
    tmuxNewWindow("s", "other", "/tmp", fake.client);
    tmuxNewWindow("s", "1", "/tmp", fake.client);
    fake.client.runner!.run("tmux", ["kill-window", "-t", "s:1"]);
    expect(tmuxListWindows("s", fake.client)).toEqual(["sh", "1"]);
  } finally {
    fake.cleanup();
  }
});

test("closing a worker's window by name closes that window, even when its name is another window's index", () => {
  const fake = startFakeTmuxServer();
  try {
    tmuxNewSession("s", "/tmp", fake.client);
    tmuxNewWindow("s", "other", "/tmp", fake.client);
    const id = tmuxNewWindow("s", "1", "/tmp", fake.client);
    expect(id).toMatch(/^@/);
    tmuxKillWindow("s", "1", fake.client);
    expect(tmuxListWindows("s", fake.client)).toEqual(["sh", "other"]);
  } finally {
    fake.cleanup();
  }
});

test("a failed create for a worker named 1 closes its own window, not the worker at index 1", async () => {
  let listWindows = 0;
  let stallAt = -1;
  const s = makeApps((args) => args.includes("list-windows") && ++listWindows === stallAt);
  try {
    const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "A", mode: "shared-cwd" });
    const session = s.projects.getById(proj.body.id)!.tmuxSessionName;
    tmuxKillSession(session, s.tmux.client);
    // The rebuild opens "sh", then A (index 1), then "1" (index 2); the last check stalls.
    stallAt = listWindows + 3;
    const r = await postJson(s.featuresApp, `/api/projects/${proj.body.id}/features`, { name: "1", mode: "shared-cwd" });
    expect(r.status).toBe(503);
    expect(tmuxListWindows(session, s.tmux.client)).toEqual(["sh", "a"]);
  } finally {
    s.cleanup();
  }
});
