import { Hono, type Context } from "hono";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { AgentScope } from "./agent-store.js";
import {
  AgentHttpService,
  type AgentHttpResult,
  type AgentsApiDeps
} from "./agent-http-service.js";

export type { AgentsApiDeps } from "./agent-http-service.js";

interface RouteSpec {
  /** AgentScope key — also used to resolve the ScopeRuntime. */
  scope: AgentScope;
  /** URL prefix the three routes mount under. */
  prefix: string;
  /** Extract the scope-id from the request — returns featureId for feature
   *  routes, null for the overview singleton. */
  scopeIdFromRequest: (c: Context) => string | null;
}

const ROUTES: RouteSpec[] = [
  {
    scope: "worker",
    prefix: API_ROUTES.agentWorker,
    scopeIdFromRequest: (c) => c.req.param("featureId") ?? null
  },
  {
    scope: "manager",
    prefix: API_ROUTES.agentManager,
    scopeIdFromRequest: () => null
  }
];

export function mountAgentsRoutes(app: Hono, deps: AgentsApiDeps): void {
  const service = new AgentHttpService(deps);
  for (const route of ROUTES) {
    mountScopeRoutes(app, route, service);
  }

  // Wakes are scope-agnostic — one route serves both.
  app.get(API_ROUTES.agentActiveWakes, (c) => {
    return respond(c, service.listActiveWakes());
  });

  app.get(API_ROUTES.agentWake, (c) => {
    return respond(c, service.getWake(c.req.param("wakeId")));
  });

  app.post(API_ROUTES.agentWakeCancel, (c) => {
    return respond(c, service.cancelWake(c.req.param("wakeId")));
  });

  app.post(API_ROUTES.agentThreadForks, (c) => {
    return respond(c, service.createSideThread(c.req.param("threadId")));
  });

  app.get(API_ROUTES.agentThread, (c) => {
    return respond(c, service.getThreadById({
      threadId: c.req.param("threadId"),
      since: c.req.query("since"),
      limit: c.req.query("limit"),
      before: c.req.query("before")
    }));
  });

  app.post(API_ROUTES.agentThreadMessages, async (c) => {
    const body = await readJson(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.postThreadMessage({ threadId: c.req.param("threadId"), body }));
  });

  app.delete(API_ROUTES.agentThreadQueuedMessage, (c) => {
    return respond(c, service.deleteThreadQueuedMessage(
      c.req.param("threadId"),
      c.req.param("clientRequestId")
    ));
  });

  app.post(API_ROUTES.agentThreadSummaryDraft, async (c) => {
    return respond(c, await service.getSideSummaryDraft(c.req.param("threadId")));
  });

  app.post(API_ROUTES.agentThreadTransfers, async (c) => {
    const body = await readJson(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.createSideTransfer({ threadId: c.req.param("threadId"), body }));
  });

  app.post(API_ROUTES.agentSideTransferRetarget, async (c) => {
    const body = await readJson(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.retargetSideTransfer({
      transferId: c.req.param("transferId"),
      body
    }));
  });

  app.delete(API_ROUTES.agentThread, (c) => {
    return respond(c, service.closeSideThread(c.req.param("threadId")));
  });

}

const INVALID_JSON = Symbol("invalid-json");

async function readJson(c: Context): Promise<unknown | typeof INVALID_JSON> {
  try {
    return await c.req.json();
  } catch {
    return INVALID_JSON;
  }
}

function mountScopeRoutes(app: Hono, route: RouteSpec, service: AgentHttpService): void {
  // POST <prefix>/messages — append a user message and wake the agent.
  app.post(`${route.prefix}/messages`, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    return respond(c, service.postMessage({
      scope: route.scope,
      scopeId: route.scopeIdFromRequest(c),
      body
    }));
  });

  // DELETE <prefix>/queued-messages/:clientRequestId — cancel a user message
  // that is still waiting in the in-memory busy-thread queue.
  app.delete(`${route.prefix}/queued-messages/:clientRequestId`, (c) => {
    return respond(c, service.deleteQueuedMessage({
      scope: route.scope,
      scopeId: route.scopeIdFromRequest(c),
      clientRequestId: c.req.param("clientRequestId")
    }));
  });

  // GET <prefix>/thread — fetch the thread + page of messages.
  app.get(`${route.prefix}/thread`, (c) => {
    return respond(c, service.getThread({
      scope: route.scope,
      scopeId: route.scopeIdFromRequest(c),
      since: c.req.query("since"),
      limit: c.req.query("limit"),
      before: c.req.query("before")
    }));
  });

  // POST <prefix>/new-chat — archive the active thread + create a fresh one.
  app.post(`${route.prefix}/new-chat`, async (c) => {
    return respond(c, await service.startNewChat({
      scope: route.scope,
      scopeId: route.scopeIdFromRequest(c)
    }));
  });
}

function respond(c: Context, result: AgentHttpResult) {
  if (result.status === 200) return c.json(result.body);
  return c.json(result.body, result.status);
}
