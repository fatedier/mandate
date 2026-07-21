import { expect, test } from "bun:test";
import { buildUiNavigateTool, type UiNavigateDeps } from "../src/server/modules/ui-context/tools/ui-navigate.js";
import { freshStoresEnv, seedProject, seedFeature } from "./helpers/fixtures.js";

function stubDeps(emit: (action: string, payload: any) => void = () => {}): UiNavigateDeps {
  return {
    projectsStore: { listActive: () => [] } as any,
    featuresStore: { listActiveByProject: () => [] } as any,
    emit
  };
}

test("buildUiNavigateTool: emits navigate action for static route /activity", async () => {
  const calls: any[] = [];
  const tool = buildUiNavigateTool(stubDeps((action, payload) => calls.push({ action, payload })));
  const r = await tool.handler({ path: "/activity" }, {} as any);
  expect(r).toEqual({ ok: true });
  expect(calls.length).toBe(1);
  expect(calls[0].action).toBe("navigate");
  expect(calls[0].payload.path).toBe("/activity");
});

test("buildUiNavigateTool: zod rejects path not starting with /", async () => {
  const tool = buildUiNavigateTool(stubDeps());
  const parsed = tool.parameters.safeParse({ path: "https://evil.com" });
  expect(parsed.success).toBe(false);
});

test("buildUiNavigateTool: zod accepts /-rooted path with allowed chars", async () => {
  const tool = buildUiNavigateTool(stubDeps());
  const parsed = tool.parameters.safeParse({ path: "/projects/abc/features/xyz/pane/%25197" });
  expect(parsed.success).toBe(true);
});

test("buildUiNavigateTool: zod accepts structured route", async () => {
  const tool = buildUiNavigateTool(stubDeps());
  const parsed = tool.parameters.safeParse({ route: "activity" });
  expect(parsed.success).toBe(true);
});

test("buildUiNavigateTool: canvas documents remain navigable", async () => {
  const calls: any[] = [];
  const tool = buildUiNavigateTool(stubDeps((action, payload) => calls.push({ action, payload })));
  const r = await tool.handler({ path: "/canvas/cnv_123" }, {} as any);
  expect(r).toEqual({ ok: true });
  expect(calls[0].payload.path).toBe("/canvas/cnv_123");
});

test("buildUiNavigateTool: the removed canvas gallery is not a destination", async () => {
  const calls: any[] = [];
  const tool = buildUiNavigateTool(stubDeps((action, payload) => calls.push({ action, payload })));
  expect(tool.parameters.safeParse({ route: "canvas" }).success).toBe(false);
  expect(await tool.handler({ path: "/canvas" }, {} as any)).toEqual({ error: expect.stringContaining("doesn't match any Mandate route") });
  expect(calls).toHaveLength(0);
});

test("buildUiNavigateTool: tool name and approval", () => {
  const tool = buildUiNavigateTool(stubDeps());
  expect(tool.name).toBe("ui_navigate");
  expect(tool.approval).toBe("never");
});

test("buildUiNavigateTool: unknown path returns error and does NOT emit", async () => {
  const calls: any[] = [];
  const tool = buildUiNavigateTool(stubDeps((action, payload) => calls.push({ action, payload })));
  const r = await tool.handler({ path: "/random-page" }, {} as any);
  expect(r).toEqual({ error: expect.stringContaining("doesn't match any Mandate route") });
  expect(calls.length).toBe(0);
});

test("buildUiNavigateTool: nonexistent project slug returns error pointing to slug field", async () => {
  const env = freshStoresEnv();
  try {
    seedProject(env.projects, { tmuxSessionName: "real-proj" });
    const calls: any[] = [];
    const tool = buildUiNavigateTool({
      projectsStore: env.projects,
      featuresStore: env.features,
      emit: (action, payload) => calls.push({ action, payload })
    });
    const r = await tool.handler({ path: "/projects/wrong/features/anything" }, {} as any);
    expect(r).toEqual({ error: expect.stringContaining("'slug' field from list_projects") });
    expect((r as { error: string }).error).toContain("real-proj");
    expect(calls.length).toBe(0);
  } finally { env.cleanup(); }
});

test("buildUiNavigateTool: nonexistent feature slug returns error pointing to slug field", async () => {
  const env = freshStoresEnv();
  try {
    const projectId = seedProject(env.projects, { tmuxSessionName: "proj" });
    seedFeature(env.features, projectId, { tmuxWindowName: "real-feat" });
    const calls: any[] = [];
    const tool = buildUiNavigateTool({
      projectsStore: env.projects,
      featuresStore: env.features,
      emit: (action, payload) => calls.push({ action, payload })
    });
    const r = await tool.handler({ path: "/projects/proj/features/wrong" }, {} as any);
    expect(r).toEqual({ error: expect.stringContaining("'slug' field from list_features") });
    expect((r as { error: string }).error).toContain("real-feat");
    expect(calls.length).toBe(0);
  } finally { env.cleanup(); }
});

test("buildUiNavigateTool: existing project + feature emits navigate", async () => {
  const env = freshStoresEnv();
  try {
    const projectId = seedProject(env.projects, { tmuxSessionName: "proj" });
    seedFeature(env.features, projectId, { tmuxWindowName: "feat" });
    const calls: any[] = [];
    const tool = buildUiNavigateTool({
      projectsStore: env.projects,
      featuresStore: env.features,
      emit: (action, payload) => calls.push({ action, payload })
    });
    const r = await tool.handler({ path: "/projects/proj/features/feat" }, {} as any);
    expect(r).toEqual({ ok: true });
    expect(calls.length).toBe(1);
    expect(calls[0].payload.path).toBe("/projects/proj/features/feat");
  } finally { env.cleanup(); }
});

test("buildUiNavigateTool: structured feature route resolves by feature name", async () => {
  const env = freshStoresEnv();
  try {
    const projectId = seedProject(env.projects, { name: "Agent Pilot", tmuxSessionName: "agent-pilot" });
    const featureId = seedFeature(env.features, projectId, { name: "Chat Compression Visibility", tmuxWindowName: "chat-compression-visibility" });
    const calls: any[] = [];
    const tool = buildUiNavigateTool({
      projectsStore: env.projects,
      featuresStore: env.features,
      emit: (action, payload) => calls.push({ action, payload })
    });
    const r = await tool.handler({ route: "feature", featureName: "chat compression visibility" }, {} as any);
    expect(r).toEqual({ ok: true });
    expect(calls[0].payload.path).toBe("/projects/agent-pilot/features/chat-compression-visibility");

    const pane = await tool.handler({ route: "feature_pane", featureId, paneId: "%27" }, {} as any);
    expect(pane).toEqual({ ok: true });
    expect(calls[1].payload.path).toBe("/projects/agent-pilot/features/chat-compression-visibility/pane/%2527");
  } finally { env.cleanup(); }
});

test("buildUiNavigateTool: structured feature route rejects wrong project selector", async () => {
  const env = freshStoresEnv();
  try {
    const projectId = seedProject(env.projects, { name: "Agent Pilot", tmuxSessionName: "agent-pilot" });
    seedFeature(env.features, projectId, { name: "Main", tmuxWindowName: "main" });
    const calls: any[] = [];
    const tool = buildUiNavigateTool({
      projectsStore: env.projects,
      featuresStore: env.features,
      emit: (action, payload) => calls.push({ action, payload })
    });
    const r = await tool.handler(
      { route: "feature", projectName: "other project", featureName: "main" },
      {} as any
    );
    expect(r).toEqual({ error: expect.stringContaining("Project 'other project' not found") });
    expect(calls).toHaveLength(0);
  } finally { env.cleanup(); }
});

test("buildUiNavigateTool: structured feature route without project selector can use unique feature", async () => {
  const env = freshStoresEnv();
  try {
    const projectId = seedProject(env.projects, { name: "Agent Pilot", tmuxSessionName: "agent-pilot" });
    seedFeature(env.features, projectId, { name: "Main", tmuxWindowName: "main" });
    const calls: any[] = [];
    const tool = buildUiNavigateTool({
      projectsStore: env.projects,
      featuresStore: env.features,
      emit: (action, payload) => calls.push({ action, payload })
    });
    const r = await tool.handler({ route: "feature", featureName: "main" }, {} as any);
    expect(r).toEqual({ ok: true });
    expect(calls[0].payload.path).toBe("/projects/agent-pilot/features/main");
  } finally { env.cleanup(); }
});

test("buildUiNavigateTool: project pane path encodes literal tmux pane id", async () => {
  const env = freshStoresEnv();
  try {
    const projectId = seedProject(env.projects, { tmuxSessionName: "proj" });
    seedFeature(env.features, projectId, { tmuxWindowName: "feat" });
    const calls: any[] = [];
    const tool = buildUiNavigateTool({
      projectsStore: env.projects,
      featuresStore: env.features,
      emit: (action, payload) => calls.push({ action, payload })
    });
    const r = await tool.handler({ path: "/projects/proj/features/feat/pane/%27" }, {} as any);
    expect(r).toEqual({ ok: true });
    expect(calls[0].payload.path).toBe("/projects/proj/features/feat/pane/%2527");
  } finally { env.cleanup(); }
});

test("buildUiNavigateTool: already-encoded tmux pane id stays canonical", async () => {
  const env = freshStoresEnv();
  try {
    const projectId = seedProject(env.projects, { tmuxSessionName: "proj" });
    seedFeature(env.features, projectId, { tmuxWindowName: "feat" });
    const calls: any[] = [];
    const tool = buildUiNavigateTool({
      projectsStore: env.projects,
      featuresStore: env.features,
      emit: (action, payload) => calls.push({ action, payload })
    });
    const r = await tool.handler({ path: "/projects/proj/features/feat/pane/%2527" }, {} as any);
    expect(r).toEqual({ ok: true });
    expect(calls[0].payload.path).toBe("/projects/proj/features/feat/pane/%2527");
  } finally { env.cleanup(); }
});

test("buildUiNavigateTool: standalone terminal path is rejected", async () => {
  const calls: any[] = [];
  const tool = buildUiNavigateTool(stubDeps((action, payload) => calls.push({ action, payload })));
  const r = await tool.handler({ path: "/terminal/%27" }, {} as any);
  expect(r).toEqual({ error: expect.stringContaining("doesn't match any Mandate route") });
  expect(calls).toHaveLength(0);
});

test("buildUiNavigateTool: /sessions/<name> is accepted without entity lookup (tmux state is dynamic)", async () => {
  const calls: any[] = [];
  const tool = buildUiNavigateTool(stubDeps((action, payload) => calls.push({ action, payload })));
  const r = await tool.handler({ path: "/sessions/some-session/windows/some-window" }, {} as any);
  expect(r).toEqual({ ok: true });
  expect(calls.length).toBe(1);
});

test("buildUiNavigateTool: /sessions path is rejected when snapshot can prove it does not exist", async () => {
  const calls: any[] = [];
  const tool = buildUiNavigateTool({
    ...stubDeps((action, payload) => calls.push({ action, payload })),
    getSnapshot: () => ({
      generatedAt: "now",
      sessions: [
        { sessionName: "real-session", sessionWindows: 1, sessionAttached: 0, created: "x", activeClient: null, windows: [] }
      ],
      clients: [],
      counts: {} as any,
      analyzer: {}
    })
  });
  const r = await tool.handler({ path: "/sessions/fake-session/windows/fake-window" }, {} as any);
  expect(r).toEqual({ error: expect.stringContaining("Session 'fake-session' not found") });
  expect(calls.length).toBe(0);
});

test("buildUiNavigateTool: structured window route resolves by current snapshot", async () => {
  const calls: any[] = [];
  const window = { windowName: "main", windowIndex: 2, panes: [] };
  const tool = buildUiNavigateTool({
    ...stubDeps((action, payload) => calls.push({ action, payload })),
    getSnapshot: () => ({
      generatedAt: "now",
      sessions: [
        { sessionName: "md-test", sessionWindows: 1, sessionAttached: 0, created: "x", activeClient: null, windows: [window] }
      ],
      clients: [],
      counts: {} as any,
      analyzer: {}
    }) as any
  });
  const r = await tool.handler({ route: "window", sessionName: "md test", windowName: "2" }, {} as any);
  expect(r).toEqual({ ok: true });
  expect(calls[0].payload.path).toBe("/sessions/md-test/windows/main");
});

test("buildUiNavigateTool: full session window pane path encodes literal tmux pane id", async () => {
  const calls: any[] = [];
  const window = { windowName: "main", windowIndex: 2, panes: [] };
  const tool = buildUiNavigateTool({
    ...stubDeps((action, payload) => calls.push({ action, payload })),
    getSnapshot: () => ({
      generatedAt: "now",
      sessions: [
        { sessionName: "md-test", sessionWindows: 1, sessionAttached: 0, created: "x", activeClient: null, windows: [window] }
      ],
      clients: [],
      counts: {} as any,
      analyzer: {}
    }) as any
  });
  const r = await tool.handler({ path: "/sessions/md-test/windows/main/pane/%27" }, {} as any);
  expect(r).toEqual({ ok: true });
  expect(calls[0].payload.path).toBe("/sessions/md-test/windows/main/pane/%2527");
});

test("buildUiNavigateTool: structured window pane route resolves to full path", async () => {
  const calls: any[] = [];
  const window = { windowName: "main", windowIndex: 2, panes: [] };
  const tool = buildUiNavigateTool({
    ...stubDeps((action, payload) => calls.push({ action, payload })),
    getSnapshot: () => ({
      generatedAt: "now",
      sessions: [
        { sessionName: "md-test", sessionWindows: 1, sessionAttached: 0, created: "x", activeClient: null, windows: [window] }
      ],
      clients: [],
      counts: {} as any,
      analyzer: {}
    }) as any
  });
  const r = await tool.handler(
    { route: "window_pane", sessionName: "md test", windowName: "2", paneId: "%27" },
    {} as any
  );
  expect(r).toEqual({ ok: true });
  expect(calls[0].payload.path).toBe("/sessions/md-test/windows/main/pane/%2527");
});
