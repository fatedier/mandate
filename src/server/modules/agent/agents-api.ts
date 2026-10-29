import { Hono, type Context } from "hono";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { AgentScope } from "./agent-store.js";
import {
  AgentHttpService,
  type AgentHttpResult,
  type AgentsApiDeps
} from "./agent-http-service.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";

interface RouteSpec {
  /** AgentScope key — also used to resolve the ScopeRuntime. */
  scope: AgentScope;
  /** URL prefix the three routes mount under. */
  prefix: string;
  /** Extract the scope-id from the request: the featureId. */
  scopeIdFromRequest: (c: Context) => string | null;
}

const ROUTES: RouteSpec[] = [
  {
    scope: "worker",
    prefix: API_ROUTES.agentWorker,
    scopeIdFromRequest: (c) => c.req.param("featureId") ?? null
  }
];

export function mountAgentsRoutes(app: Hono, deps: AgentsApiDeps): void {
  const service = new AgentHttpService(deps);
  // Manager threads are addressed by id; there is no manager scope route.
  app.get(API_ROUTES.agentManagerThreads, (c) => respond(c, service.listManagerThreads(c.req.query("archived"))));
  app.delete(API_ROUTES.agentManagerThreads, (c) => respond(c, service.deleteArchivedManagerThreads(c.req.query("archived"))));
  app.delete(API_ROUTES.agentManagerThread, (c) => respond(c, service.deleteManagerThread(c.req.param("threadId"))));
  app.post(API_ROUTES.agentManagerThreads, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.createManagerThread(body));
  });
  app.patch(API_ROUTES.agentManagerThread, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, await service.patchManagerThread(c.req.param("threadId"), body));
  });
  app.get(API_ROUTES.agentManagerThreadWorkers, (c) =>
    respond(c, service.listManagerThreadWorkers(c.req.param("threadId"), c.req.query("archived"))));
  app.post(API_ROUTES.agentManagerThreadSeen, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.markManagerThreadSeen(c.req.param("threadId"), body));
  });
  for (const route of ROUTES) {
    mountScopeRoutes(app, route, service);
  }

  // Wakes are scope-agnostic — one route serves both.
  app.get(API_ROUTES.agentActiveWakes, (c) => {
    return respond(c, service.listActiveWakes());
  });

  app.get(API_ROUTES.agentPendingMonitors, (c) => {
    return respond(c, service.listPendingMonitors());
  });

  app.get(API_ROUTES.agentWake, (c) => {
    return respond(c, service.getWake(c.req.param("wakeId")));
  });

  app.post(API_ROUTES.agentWakeCancel, (c) => {
    return respond(c, service.cancelWake(c.req.param("wakeId")));
  });

  app.post(API_ROUTES.agentWakeRetry, (c) => {
    return respond(c, service.retryWake(c.req.param("wakeId")));
  });

  app.get(API_ROUTES.agentThreadTasks, (c) => respond(c, service.listThreadTasks(c.req.param("threadId"), { before: c.req.query("before") ?? null, since: c.req.query("since") ?? null })));
  app.get(API_ROUTES.agentTask, (c) => respond(c, service.getTask(c.req.param("taskId"))));

  app.post(API_ROUTES.agentTaskStop, (c) => respond(c, service.stopTask(c.req.param("taskId"))));

  app.get(API_ROUTES.agentThread, (c) => {
    return respond(c, service.getThreadById({
      threadId: c.req.param("threadId"),
      since: c.req.query("since"),
      limit: c.req.query("limit"),
      before: c.req.query("before")
    }));
  });

  app.post(API_ROUTES.agentThreadMessages, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.postThreadMessage({ threadId: c.req.param("threadId"), body }));
  });

  app.post(API_ROUTES.agentThreadQuestionSkip, (c) => {
    return respond(c, service.skipThreadQuestion({ threadId: c.req.param("threadId"), questionId: c.req.param("questionId") }));
  });

  app.get(API_ROUTES.agentThreadModel, (c) => respond(c, service.getThreadModel(c.req.param("threadId"))));
  app.put(API_ROUTES.agentThreadModel, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.setThreadModel(c.req.param("threadId"), body));
  });

  app.get(API_ROUTES.agentThreadCommands, (c) => {
    return respond(c, service.listThreadCommands(c.req.param("threadId")));
  });

  app.post(API_ROUTES.agentThreadCommands, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.runThreadCommand({ threadId: c.req.param("threadId"), body }));
  });

  app.delete(API_ROUTES.agentThreadQueuedMessage, (c) => {
    return respond(c, service.deleteThreadQueuedMessage(
      c.req.param("threadId"),
      c.req.param("clientRequestId")
    ));
  });


}


function mountScopeRoutes(app: Hono, route: RouteSpec, service: AgentHttpService): void {
  // POST <prefix>/messages — append a user message and wake the agent.
  app.post(`${route.prefix}/messages`, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);

    return respond(c, service.postMessage({
      scope: route.scope,
      scopeId: route.scopeIdFromRequest(c),
      body
    }));
  });

  // GET <prefix>/commands — the commands this conversation's composer offers.
  app.get(`${route.prefix}/commands`, (c) => {
    return respond(c, service.listCommands({ scope: route.scope, scopeId: route.scopeIdFromRequest(c) }));
  });

  // POST <prefix>/commands — run a draft whose first word is a command.
  app.post(`${route.prefix}/commands`, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.runCommand({ scope: route.scope, scopeId: route.scopeIdFromRequest(c), body }));
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
}

function respond(c: Context, result: AgentHttpResult) {
  if (result.status === 200) return c.json(result.body);
  return c.json(result.body, result.status);
}
