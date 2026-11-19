import type { Hono } from "hono";
import {
  API_ROUTES,
  SSE_EVENTS,
  type ChangeProjectWorkingDirRequest,
  type CreateProjectRequest,
  type ReorderProjectsRequest,
  type ReorderProjectsResponse
} from "../../../shared/api-contracts.js";
import type { ProjectRow, ProjectsStore } from "./projects-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { GitClient } from "../../platform/git/git.js";
import {
  ProjectService,
  projectRowToDto
} from "./project-service.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import { isRecord } from "../../../shared/guards.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";

interface ProjectsApiDeps {
  projects: ProjectsStore;
  workers: WorkersStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  broadcast: LifecyclePublisher;
  sessionDataDir?: string;
  /** A project's working directory changed: whoever works in it is told. */
  onWorkingDirChanged?: (change: { project: ProjectRow; from: string }) => void;
}

export function mountProjectsRoutes(app: Hono, deps: ProjectsApiDeps): void {
  const service = new ProjectService(deps);

  app.post(API_ROUTES.projects, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    const record = isRecord(body) ? body as Partial<CreateProjectRequest> : {};

    const r = await service.create({
      name: String(record.name ?? ""),
      workingDir: String(record.workingDir ?? "")
    });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    deps.broadcast({ type: SSE_EVENTS.projectCreated, data: projectRowToDto(r.project) });
    return c.json(projectRowToDto(r.project));
  });

  app.post(API_ROUTES.projectReorder, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    const record = isRecord(body) ? body as Partial<ReorderProjectsRequest> : {};
    const projectIds = Array.isArray(record.projectIds)
      ? record.projectIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : null;
    if (!projectIds || projectIds.length !== record.projectIds?.length) {
      return c.json({ error: "projectIds must be a string array" }, 400);
    }

    const reordered = deps.projects.reorderActive(projectIds);
    if ("error" in reordered) return c.json({ error: reordered.error }, 400);

    deps.broadcast({ type: SSE_EVENTS.projectReordered, data: { ids: projectIds } });
    return c.json({ projects: reordered.map(projectRowToDto) } satisfies ReorderProjectsResponse);
  });

  app.post(API_ROUTES.projectReconcile, async (c) => {
    const id = c.req.param("id");
    const r = await service.reconcile(id);
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    deps.broadcast({ type: SSE_EVENTS.projectReconciled, data: { id, ...r.result } });
    return c.json(r.result);
  });

  app.patch(API_ROUTES.projectById, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    const record = isRecord(body) ? body as Partial<ChangeProjectWorkingDirRequest> : {};
    const r = await service.changeWorkingDir({ id: c.req.param("id"), workingDir: String(record.workingDir ?? "") });
    if (!r.ok) return c.json({ error: r.error, ...(r.workers ? { workers: r.workers } : {}) }, errorStatus(r.status));
    if (r.changed) {
      deps.broadcast({ type: SSE_EVENTS.projectUpdated, data: projectRowToDto(r.project) });
      deps.onWorkingDirChanged?.({ project: r.project, from: r.from });
    }
    return c.json(projectRowToDto(r.project));
  });

  app.delete(API_ROUTES.projectById, async (c) => {
    const id = c.req.param("id");
    const r = await service.archive({ id, killTmux: c.req.query("killTmux") === "true" });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    deps.broadcast({ type: SSE_EVENTS.projectArchived, data: { id } });
    return c.json({ ok: true });
  });
}

function errorStatus(status: number): 400 | 404 | 409 | 500 {
  return status === 404 || status === 409 || status === 500 ? status : 400;
}
