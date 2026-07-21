import { expect, test } from "bun:test";
import type { ScopeRuntime } from "../src/server/runtime/scope.js";
import { buildScopesFromPacks, scopePack } from "../src/server/runtime/scope-packs.js";

function fakeScope(scope: "manager" | "worker"): ScopeRuntime {
  return {
    scope,
    verifyScopeId: () => null,
    buildSystemPrompt: () => "",
    buildToolScope: () => ({ kind: scope } as any),
    wrappedDispatcher: {
      registry: { tools: {} },
      dispatch: async () => ({ result: {} })
    },
    toolDefinitions: []
  };
}

test("buildScopesFromPacks builds scope map", () => {
  const scopes = buildScopesFromPacks([
    scopePack("worker", () => fakeScope("worker")),
    scopePack("manager", () => fakeScope("manager"))
  ], ["worker", "manager"]);

  expect(scopes.worker.scope).toBe("worker");
  expect(scopes.manager.scope).toBe("manager");
});

test("buildScopesFromPacks rejects duplicate scope packs", () => {
  expect(() => buildScopesFromPacks([
    scopePack("worker", () => fakeScope("worker")),
    scopePack("worker", () => fakeScope("worker"))
  ], ["worker"])).toThrow(/duplicate agent scope pack: worker/);
});

test("buildScopesFromPacks rejects missing required scope", () => {
  expect(() => buildScopesFromPacks([
    scopePack("worker", () => fakeScope("worker"))
  ], ["worker", "manager"])).toThrow(/missing agent scope pack: manager/);
});
