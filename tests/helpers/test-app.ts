import { Hono } from "hono";
import { onHttpError } from "../../src/server/app/http-app.js";
import { mountAgentsRoutes } from "../../src/server/modules/agent/agents-api.js";
import { mountFeaturesRoutes } from "../../src/server/modules/features/feature-routes.js";
import { mountGitRoutes } from "../../src/server/modules/git/git-routes.js";
import { mountProjectsRoutes } from "../../src/server/modules/projects/project-routes.js";
import { mountSessionsRoutes } from "../../src/server/modules/sessions/session-routes.js";
import type { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import type { ScopeRuntime } from "../../src/server/runtime/scope.js";
import type { AgentScope } from "../../src/server/modules/agent/agent-store.js";
import { AgentUserMessageQueue } from "../../src/server/modules/agent/user-message-queue.js";

// Test helpers that mount the production Hono routers with caller-provided
// deps so integration tests can exercise the real request path
// (mount* + Hono's app.request) instead of mocking IncomingMessage /
// ServerResponse around the long-gone handle*Api functions.
//
// Each helper takes the dep shape the matching mount* expects. Use
// `await app.request(url, init)` to fire requests and inspect the
// returned native Response.

type ProjectsDeps = Parameters<typeof mountProjectsRoutes>[1];
type FeaturesDeps = Parameters<typeof mountFeaturesRoutes>[1];
type GitDeps = Parameters<typeof mountGitRoutes>[1];
type SessionsDeps = Parameters<typeof mountSessionsRoutes>[1];
type AgentsDeps = Parameters<typeof mountAgentsRoutes>[1];

export function buildProjectsTestApp(deps: ProjectsDeps): Hono {
  const app = new Hono();
  // As production: the same last word on a thrown error.
  app.onError(onHttpError);
  mountProjectsRoutes(app, deps);
  return app;
}

export function buildFeaturesTestApp(deps: FeaturesDeps): Hono {
  const app = new Hono();
  // As production: the same last word on a thrown error.
  app.onError(onHttpError);
  mountFeaturesRoutes(app, deps);
  return app;
}

export function buildGitTestApp(deps: GitDeps): Hono {
  const app = new Hono();
  // As production: the same last word on a thrown error.
  app.onError(onHttpError);
  mountGitRoutes(app, deps);
  return app;
}

export function buildSessionsTestApp(deps: SessionsDeps): Hono {
  const app = new Hono();
  // As production: the same last word on a thrown error.
  app.onError(onHttpError);
  mountSessionsRoutes(app, deps);
  return app;
}

/** As production, the agents app always has a user message queue: a test
 *  that brings none gets the real one, over its own store and scheduler. */
export function buildAgentsTestApp(deps: Omit<AgentsDeps, "userMessageQueue"> & Partial<Pick<AgentsDeps, "userMessageQueue">>): Hono {
  const app = new Hono();
  // As production: the same last word on a thrown error.
  app.onError(onHttpError);
  mountAgentsRoutes(app, {
    ...deps,
    userMessageQueue: deps.userMessageQueue ?? new AgentUserMessageQueue({
      agentStore: deps.agentStore,
      sse: deps.sse,
      wakeScheduler: deps.wakeScheduler
    })
  });
  return app;
}

/** Minimal ScopeRuntime stubs sufficient for HTTP-route integration tests
 *  that exercise messages POST / thread GET. The dispatcher,
 *  prompt builder, and tool-scope builder are no-ops — those code paths are
 *  covered by unit tests against each scope file directly. */
export function buildTestScopes(featuresStore: FeaturesStore): Record<AgentScope, ScopeRuntime> {
  const noop: Pick<ScopeRuntime, "buildSystemPrompt" | "wrappedDispatcher" | "toolDefinitions"> = {
    buildSystemPrompt: () => "",
    wrappedDispatcher: {
      registry: { tools: {} },
      dispatch: async () => ({ result: null })
    },
    toolDefinitions: []
  };
  return {
    global: {
      ...noop, scope: "global",
      buildToolScope: () => ({ kind: "manager", managerDir: "", projectWorkingDirs: [] }),
      verifyScopeId: (scopeId) => (scopeId === null ? null : "the global scope has no scope id")
    },
    worker: {
      ...noop, scope: "worker",
      buildToolScope: () => ({ kind: "worker", feature: {}, project: { workingDir: "" } }),
      verifyScopeId(scopeId) {
        if (!scopeId) return "worker scope requires a featureId";
        const f = featuresStore.getById(scopeId);
        if (!f || f.archivedAt) return "feature not found or archived";
        return null;
      }
    },
    manager: {
      ...noop, scope: "manager",
      buildToolScope: () => ({ kind: "manager", managerDir: "", projectWorkingDirs: [] }),
      verifyScopeId: (scopeId) => scopeId === null
        ? null : "manager scope is a singleton (scopeId must be null)"
    },
    subagent: {
      ...noop, scope: "subagent",
      buildToolScope: () => ({ kind: "manager", managerDir: "", projectWorkingDirs: [] }),
      verifyScopeId: () => "a subagent's thread is read by its id"
    }
  };
}

/** Convenience: POST a JSON body and parse the JSON response. */
export async function postJson(app: Hono, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const parsed = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

/** Convenience: PATCH a JSON body and parse the JSON response. */
export async function patchJson(app: Hono, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const parsed = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

/** Convenience: GET and parse the JSON response. */
export async function getJson(app: Hono, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  const parsed = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

/** Convenience: DELETE and parse the JSON response. */
export async function deleteJson(app: Hono, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { method: "DELETE" });
  const parsed = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}
