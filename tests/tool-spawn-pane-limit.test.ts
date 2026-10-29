import { expect, test } from "bun:test";
import { MAX_FEATURE_PANES, spawnPaneTool } from "../src/server/modules/panes/tools/spawn-pane.js";
import type { FeatureRow } from "../src/server/modules/features/features-store.js";
import type { ProjectRow } from "../src/server/modules/projects/projects-store.js";
import type { Pane } from "../src/server/runtime/pane-runtime.js";
import type { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import type { PaneMetadataStore } from "../src/server/modules/panes/pane-metadata-store.js";
import type { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import { stub, toolContext } from "./helpers/typed.js";

// A worker that opens a pane for every task, closing none, fills its window.
// Past six panes — more than most workers ever use — a new one is refused,
// and the refusal lists the panes so one can be reused or closed.

function harness(count: number, opts: { names?: Record<string, string>; status?: Record<string, string>; dead?: string[] } = {}) {
  const spawned: string[] = [];
  const panes = Array.from({ length: count }, (_, i) => stub<Pane>({
    id: `%${i + 1}`, command: ["zsh"], cwd: "/tmp", spawnedAt: "2026-10-27T08:00:00.000Z",
    status: opts.dead?.includes(`%${i + 1}`) ? "dead" : "running"
  }));
  const ctx = toolContext({
    threadId: "t1",
    wakeId: "w1",
    scope: { kind: "worker", feature: { workingDir: "/tmp" }, project: { workingDir: "/tmp" } },
    feature: stub<FeatureRow>({ id: "f", projectId: "p", worktreePath: "/tmp", tmuxWindowName: "w" }),
    project: stub<ProjectRow>({ id: "p", workingDir: "/tmp", tmuxSessionName: "s" }),
    paneRuntime: stub<TmuxRuntime>({
      listPanes: async () => panes,
      spawnPane: async () => { spawned.push("new"); return stub<Pane>({ id: "%99" }); }
    }),
    paneMetadata: stub<PaneMetadataStore>({
      get: (id: string) => (opts.names?.[id] ? stub<ReturnType<PaneMetadataStore["get"]> & object>({ name: opts.names[id] }) : null),
      upsert: () => stub<ReturnType<PaneMetadataStore["upsert"]>>({})
    }),
    analyzer: stub<Analyzer>({
      getCachedAnalysis: (id: string) => (opts.status?.[id] ? stub<NonNullable<ReturnType<Analyzer["getCachedAnalysis"]>>>({ status: opts.status[id] as never }) : null)
    })
  });
  return { ctx, spawned };
}

test("the limit is six panes", () => {
  expect(MAX_FEATURE_PANES).toBe(6);
});

test("with six panes a new one is refused, and the refusal names each pane and what it is doing", async () => {
  const { ctx, spawned } = harness(6, {
    names: { "%1": "Review", "%2": "Dev server" },
    status: { "%1": "done", "%2": "running_service", "%3": "idle_shell" },
    dead: ["%6"]
  });
  const result = await spawnPaneTool.handler({ name: "Another review" }, ctx);
  expect(spawned).toEqual([]);
  expect(result.paneId).toBeUndefined();
  expect(result.error).toContain("already has 6 panes");
  expect(result.error).toContain("kill_pane");
  for (const line of ["%1 Review: done", "%2 Dev server: running_service", "%3 zsh: idle_shell", "%4 zsh: running", "%6 zsh: dead"]) {
    expect(result.error).toContain(line);
  }
});

test("under six panes one is made", async () => {
  const { ctx, spawned } = harness(5);
  const result = await spawnPaneTool.handler({}, ctx);
  expect(spawned).toEqual(["new"]);
  expect(result).toEqual({ paneId: "%99" });
});
