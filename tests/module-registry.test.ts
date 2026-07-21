import { expect, test } from "bun:test";
import {
  buildAgentScopePacks,
  buildCommonToolPacks,
  buildWorkerToolPacks,
  buildManagerToolPacks,
  getMandateModules
} from "../src/server/modules/registry.js";

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

test("module registry contributes database schema initializers", () => {
  const modulesWithSchema = getMandateModules()
    .filter((module) => module.schema?.length)
    .map((module) => module.id);

  expect(modulesWithSchema).toEqual([
    "projects",
    "features",
    "agents",
    "activity",
    "canvas",
    "memory",
    "panes"
  ]);
  const initializerCount = getMandateModules()
    .reduce((count, module) => count + (module.schema?.length ?? 0), 0);
  expect(initializerCount).toBe(8);
});

test("module registry contributes agent scope packs", () => {
  const packs = buildAgentScopePacks({
    worker: {} as any,
    manager: {} as any
  });

  expect(packs.map((pack) => pack.scope)).toEqual(["worker", "manager"]);
});

test("module registry contributes tool packs from modules", () => {
  const common = buildCommonToolPacks({
    scope: "worker",
    skillRegistry: {} as any,
    watchManager: {} as any,
    memory: null
  }).map((pack) => pack.id);
  const worker = buildWorkerToolPacks({ watchManager: {} as any }).map((pack) => pack.id);
  const manager = buildManagerToolPacks({} as any).map((pack) => pack.id);

  expect(common).toContain("agent.files");
  expect(common).toContain("agent.watch");
  expect(common).toContain("skills.core");
  expect(buildCommonToolPacks({
    scope: "worker",
    store: { db: {} } as any,
    skillRegistry: {} as any,
    watchManager: {} as any,
    memory: null
  }).map((pack) => pack.id)).toContain("agent.chat-history");
  expect(worker).toContain("panes.feature");
  expect(manager).toContain("projects.catalog");
  expect(manager).toContain("features.lifecycle");
  expect(manager).not.toContain("agent.feature-sessions");
});
