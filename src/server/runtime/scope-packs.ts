import type { AgentScope } from "../modules/agent/agent-store.js";
import type { ScopeRuntime } from "./scope.js";

export interface ScopePack {
  scope: AgentScope;
  build(): ScopeRuntime;
}

export function scopePack(scope: AgentScope, build: () => ScopeRuntime): ScopePack {
  return { scope, build };
}

export function buildScopesFromPacks(
  packs: readonly ScopePack[],
  expectedScopes: readonly AgentScope[]
): Record<AgentScope, ScopeRuntime> {
  const scopes: Partial<Record<AgentScope, ScopeRuntime>> = {};

  for (const pack of packs) {
    if (scopes[pack.scope]) {
      throw new Error(`duplicate agent scope pack: ${pack.scope}`);
    }
    scopes[pack.scope] = pack.build();
  }

  for (const scope of expectedScopes) {
    if (!scopes[scope]) {
      throw new Error(`missing agent scope pack: ${scope}`);
    }
  }

  return scopes as Record<AgentScope, ScopeRuntime>;
}
