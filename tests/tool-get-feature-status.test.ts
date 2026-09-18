import { expect, test } from "bun:test";
import { buildGetFeatureStatusTool } from "../src/server/modules/features/tools/get-feature-status.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import type { TmuxSnapshot } from "../src/server/platform/tmux/tmux-types.js";

// The window-key agreement between watch-window.ts and feature-window-store.ts
// is pinned in tests/window-key-contract.test.ts, not here — that test needs
// both stores and a DB-backed FeatureWindowStore, which get_feature_status
// doesn't touch.

function seedAlphaLogin(env: ReturnType<typeof freshStoresEnv>) {
  const pId = seedProject(env.projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
  const fId = seedFeature(env.features, pId, { name: "login", tmuxWindowName: "login" });
  return { pId, fId };
}

test("get_feature_status: returns shape with feature + panes from snapshot", async () => {
  const env = freshStoresEnv("md-gfs-");
  try {
    const { fId } = seedAlphaLogin(env);

    const fakeSnapshot = {
      sessions: [{
        sessionName: "alpha",
        windows: [{
          windowName: "login",
          aggregate: { status: "working", title: "Implementing login" },
          panes: [
            { paneId: "%1", analysis: { status: "working", summary: "running tests" }, currentCommand: "pnpm", changedAt: "2026-05-03T10:00:00Z" }
          ]
        }]
      }]
    };

    const tool = buildGetFeatureStatusTool({
      featuresStore: env.features,
      projectsStore: env.projects,
      getSnapshot: () => fakeSnapshot as unknown as TmuxSnapshot
    });
    const r = await tool.handler({ featureId: fId }, {} as any);
    expect(r.feature).toBeTruthy();
    expect(r.feature?.name).toBe("login");
    expect(r.aggregateStatus).toBe("working");
    expect(r.aggregateTitle).toBe("Implementing login");
    expect(r.panes?.length).toBe(1);
    expect(r.panes?.[0]!.status).toBe("working");
    expect(r.panes?.[0]!.command).toBe("pnpm");
    expect(r.panes?.[0]!.summary).toBe("running tests");
    expect(r.panes?.[0]!.changedAt).toBe("2026-05-03T10:00:00Z");
  } finally { env.cleanup(); }
});

test("get_feature_status: returns error for missing feature", async () => {
  const env = freshStoresEnv("md-gfs-");
  try {
    const tool = buildGetFeatureStatusTool({
      featuresStore: env.features, projectsStore: env.projects,
      getSnapshot: () => ({} as unknown as TmuxSnapshot)
    });
    const r = await tool.handler({ featureId: "nope" }, {} as any);
    expect(String(r.error)).toMatch(/not found/i);
  } finally { env.cleanup(); }
});

test("get_feature_status: handles null snapshot (pre-first-poll)", async () => {
  const env = freshStoresEnv("md-gfs-");
  try {
    const { fId } = seedAlphaLogin(env);
    const tool = buildGetFeatureStatusTool({
      featuresStore: env.features, projectsStore: env.projects,
      getSnapshot: () => null
    });
    const r = await tool.handler({ featureId: fId }, {} as any);
    expect(r.feature).toBeTruthy();
    expect(r.aggregateStatus).toBe("unknown");
    expect(r.panes?.length).toBe(0);
  } finally { env.cleanup(); }
});

test("get_feature_status: handles snapshot with no matching session/window", async () => {
  const env = freshStoresEnv("md-gfs-");
  try {
    const { fId } = seedAlphaLogin(env);
    const tool = buildGetFeatureStatusTool({
      featuresStore: env.features, projectsStore: env.projects,
      getSnapshot: () => ({ sessions: [] } as unknown as TmuxSnapshot)
    });
    const r = await tool.handler({ featureId: fId }, {} as any);
    expect(r.feature).toBeTruthy();
    expect(r.aggregateStatus).toBe("unknown");
    expect(r.panes?.length).toBe(0);
  } finally { env.cleanup(); }
});
