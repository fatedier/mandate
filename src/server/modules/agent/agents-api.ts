import { Hono, type Context } from "hono";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import {
  AgentHttpService,
  type AgentHttpResult,
  type AgentsApiDeps
} from "./agent-http-service.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";

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
  app.post(API_ROUTES.agentManagerThreadLabels, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.addThreadLabel(c.req.param("threadId"), body));
  });
  app.delete(API_ROUTES.agentManagerThreadLabel, (c) =>
    respond(c, service.removeThreadLabel(c.req.param("threadId"), c.req.param("name"))));
  mountWorkerRoutes(app, service);

  // Wakes are scope-agnostic — one route serves both.
  app.get(API_ROUTES.agentActiveWakes, (c) => {
    return respond(c, service.listActiveWakes());
  });

  app.get(API_ROUTES.agentPendingMonitors, (c) => {
    return respond(c, service.listPendingMonitors());
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

  app.delete(API_ROUTES.agentThreadMessage, (c) => respond(c, service.deleteThreadMessage(c.req.param("threadId"), c.req.param("messageId"))));

  app.delete(API_ROUTES.agentThreadQueuedMessage, (c) => {
    return respond(c, service.deleteThreadQueuedMessage(
      c.req.param("threadId"),
      c.req.param("clientRequestId")
    ));
  });


}


/** A worker's conversation, addressed by its worker: its messages, its
 *  composer's commands, a queued message taken back, and the thread. */
function mountWorkerRoutes(app: Hono, service: AgentHttpService): void {
  const prefix = API_ROUTES.agentWorker;
  const workerId = (c: Context) => c.req.param("workerId") ?? null;

  app.post(`${prefix}/messages`, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.postWorkerMessage({ workerId: workerId(c), body }));
  });

  app.get(`${prefix}/commands`, (c) => respond(c, service.listWorkerCommands(workerId(c))));

  // A draft whose first word is a command.
  app.post(`${prefix}/commands`, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    return respond(c, service.runWorkerCommand({ workerId: workerId(c), body }));
  });

  // A message still waiting in the busy-thread queue, taken back.
  app.delete(`${prefix}/queued-messages/:clientRequestId`, (c) => {
    return respond(c, service.deleteWorkerQueuedMessage({
      workerId: workerId(c),
      clientRequestId: c.req.param("clientRequestId")
    }));
  });

  app.get(`${prefix}/thread`, (c) => {
    return respond(c, service.getWorkerThread({
      workerId: workerId(c),
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
