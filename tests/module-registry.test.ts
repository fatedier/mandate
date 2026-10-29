import { expect, test } from "bun:test";
import {
  buildAgentScopePacks,
  buildCommonToolPacks,
  buildWorkerToolPacks,
  buildManagerToolPacks,
  getMandateModules
} from "../src/server/modules/registry.js";
import type { Database } from "bun:sqlite";
import type { MandateStore } from "../src/server/app/store.js";
import type { ManagerToolPackContext } from "../src/server/modules/module.js";
import type { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import type { WindowWatchManager } from "../src/server/modules/agent/window-watch-manager.js";
import type { WorkerScopeDeps } from "../src/server/runtime/scopes/worker-scope.js";
import type { ManagerScopeDeps } from "../src/server/runtime/scopes/manager-scope.js";
import type { GlobalScopeDeps } from "../src/server/modules/global/global-scope.js";
import { stub } from "./helpers/typed.js";
import type { SubagentScopeDeps } from "../src/server/runtime/scopes/subagent-scope.js";

test("module registry exposes unique module ids", () => {
  const ids = getMandateModules().map((module) => module.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("module registry includes route-owning modules", () => {
  const ids = getMandateModules().map((module) => module.id);
  expect(ids).toContain("projects");
  expect(ids).toContain("features");
  expect(ids).toContain("agents");
  expect(ids).toContain("analysis");
  expect(ids).toContain("activity");
  expect(ids).toContain("state");
  expect(ids).toContain("canvas");
  expect(ids).toContain("panes");
  expect(ids).toContain("voice");
  expect(ids).toContain("settings");
});

test("module registry contributes agent scope packs", () => {
  const packs = buildAgentScopePacks({
    worker: stub<WorkerScopeDeps>(),
    manager: stub<ManagerScopeDeps>(),
    global: stub<GlobalScopeDeps>(),
    subagent: stub<SubagentScopeDeps>()
  });

  expect(packs.map((pack) => pack.scope)).toEqual(["worker", "manager", "subagent", "global"]);
});

test("module registry contributes tool packs from modules", () => {
  const common = buildCommonToolPacks({
    scope: "worker",
    skillRegistry: stub<SkillRegistry>(),
    watchManager: stub<WindowWatchManager>(),
    memory: null
  }).map((pack) => pack.id);
  const worker = buildWorkerToolPacks({ watchManager: stub<WindowWatchManager>() }).map((pack) => pack.id);
  const manager = buildManagerToolPacks(stub<ManagerToolPackContext>()).map((pack) => pack.id);

  expect(common).toContain("agent.files");
  expect(common).toContain("agent.monitor");
  for (const scope of ["worker", "manager"] as const) {
    const names = buildCommonToolPacks({
      scope,
      skillRegistry: stub<SkillRegistry>(),
      watchManager: stub<WindowWatchManager>(),
      memory: null
    }).flatMap((pack) => pack.tools.map((t) => t.name));
    expect([scope, names.filter((n) => /monitor|watch/.test(n)).sort()])
      .toEqual([scope, ["cancel_monitor", "list_my_monitors", "monitor"]]);
  }
  expect(common).toContain("skills.core");
  expect(buildCommonToolPacks({
    scope: "worker",
    store: stub<MandateStore>({ db: stub<Database>() }),
    skillRegistry: stub<SkillRegistry>(),
    watchManager: stub<WindowWatchManager>(),
    memory: null
  }).map((pack) => pack.id)).toContain("agent.chat-history");
  expect(worker).toContain("panes.feature");
  expect(manager).toContain("projects.catalog");
  expect(manager).toContain("features.lifecycle");
  expect(manager).not.toContain("agent.feature-sessions");
});
