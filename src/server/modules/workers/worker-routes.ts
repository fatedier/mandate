import { Hono } from "hono";
import {
  API_ROUTES,
  type CreateWorkerRequest
} from "../../../shared/api-contracts.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { WorkersStore } from "./workers-store.js";
import {
  WorkerService,
  workerRowToDto
} from "./worker-service.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { TmuxRuntime } from "../../runtime/runtimes/tmux-runtime.js";
import { type TmuxClient, tmuxPaneWindowId } from "../../platform/tmux/tmux.js";
import type { GitClient } from "../../platform/git/git.js";
import { isRecord } from "../../../shared/guards.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";

interface WorkersApiDeps {
  projects: ProjectsStore;
  workers: WorkersStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  tmuxRuntime: TmuxRuntime;
  broadcast: LifecyclePublisher;
  refreshWindows?: (windowIds: string[]) => void;
  refreshTmux?: () => void;
  agentStore?: AgentStore;
  beforeWorkerArchive?: (workerId: string) => void;
}

export function mountWorkersRoutes(app: Hono, deps: WorkersApiDeps): void {
  const service = new WorkerService(deps);

  app.post(API_ROUTES.projectWorkers, async (c) => {
    const projectId = c.req.param("projectId");

    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    const record = isRecord(body) ? body as Partial<CreateWorkerRequest> : {};

    const requestedOwner = typeof record.ownerThreadId === "string" && record.ownerThreadId ? record.ownerThreadId : null;
    const r = await service.create({
      projectId,
      name: String(record.name ?? ""),
      mode: record.mode,
      branch: String(record.branch ?? ""),
      baseRef: String(record.baseRef ?? ""),
      worktreePath: String(record.worktreePath ?? ""),
      ownerThreadId: null,
      // Every active worker has an open owner: a given ownerThreadId that is
      // not an open manager thread is ignored, and without a usable one a
      // thread named after the worker is opened.
      openOwner: { preferred: requestedOwner }
    });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));
    const worker = r.worker;
    deps.broadcast({ type: "workerCreated", data: workerRowToDto(worker) });
    return c.json(workerRowToDto(worker));
  });

  app.post(API_ROUTES.workerPanes, async (c) => {
    const id = c.req.param("id");
    const r = await service.createShellPane({ workerId: id });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    const windowId = await tmuxPaneWindowId(r.pane.id, deps.tmuxClient);
    if (windowId) deps.refreshWindows?.([windowId]);
    deps.broadcast({
      type: "paneCreated",
      data: { workerId: id, paneId: r.pane.id }
    });
    return c.json({ ok: true, paneId: r.pane.id });
  });

  app.post(API_ROUTES.workerPin, async (c) => {
    const id = c.req.param("id");
    const worker = deps.workers.getById(id);
    if (!worker) return c.json({ error: "not_found" }, 404);
    if (worker.archivedAt) return c.json({ error: "worker_archived" }, 400);
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    const record = isRecord(body) ? body : {};
    if (typeof record.pinned !== "boolean") {
      return c.json({ error: "pinned must be boolean" }, 400);
    }
    deps.workers.setPinned(id, record.pinned);
    const updated = deps.workers.getById(id)!;
    return c.json({ worker: workerRowToDto(updated) });
  });


  app.delete(API_ROUTES.workerById, async (c) => {
    const id = c.req.param("id");

    const r = await service.archive({
      id,
      cleanup: {
        removeWorktree: queryBool(c.req.query("removeWorktree")),
        forceRemoveWorktree: queryBool(c.req.query("forceRemoveWorktree")),
        deleteBranch: queryBool(c.req.query("deleteBranch")),
        forceDeleteBranch: queryBool(c.req.query("forceDeleteBranch"))
      },
      confirmed: queryBool(c.req.query("confirmed"))
    });
    if (!r.ok) {
      return c.json({ error: r.error, cleanupFailures: r.cleanupFailures, ...(r.check ? { check: r.check } : {}) }, errorStatus(r.status));
    }

    deps.broadcast({ type: "workerArchived", data: { id, projectId: r.worker.projectId } });
    return c.json({ ok: true, cleanupFailures: r.cleanupFailures ?? [] });
  });

  app.get(API_ROUTES.workerArchiveCheck, async (c) => {
    const check = await service.archiveCheck(c.req.param("id"));
    if (!check) return c.json({ error: "worker not found" }, 404);
    return c.json(check);
  });

}

function errorStatus(status: number): 400 | 404 | 409 | 500 {
  return status === 404 ? 404 : status === 409 ? 409 : status === 500 ? 500 : 400;
}

function queryBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true" || value === "1";
}
