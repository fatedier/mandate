import type { Hono } from "hono";
import {
  API_ROUTES,
  SSE_EVENTS,
  type AdoptProjectRequest,
  type CreateProjectRequest,
  type ProjectsListResponse,
  type ReorderProjectsRequest,
  type ReorderProjectsResponse
} from "../../../shared/api-contracts.js";
import type { ProjectsStore } from "./projects-store.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { GitClient } from "../../platform/git/git.js";
import {
  ProjectService,
  projectRowToDto
} from "./project-service.js";
import type { LifecyclePublisher } from "../../runtime/events.js";

export interface ProjectsApiDeps {
  projects: ProjectsStore;
  features: FeaturesStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  broadcast: LifecyclePublisher;
  sessionDataDir?: string;
}

export function mountProjectsRoutes(app: Hono, deps: ProjectsApiDeps): void {
  const service = new ProjectService(deps);

  app.get(API_ROUTES.projects, async (c) => {
    const projects = deps.projects.listActive().map(projectRowToDto);
    return c.json({ projects } satisfies ProjectsListResponse);
  });

  app.post(API_ROUTES.projects, async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON" }, 400); }
    const record = isRecord(body) ? body as Partial<CreateProjectRequest> : {};

    const r = await service.create({
      name: String(record.name ?? ""),
      workingDir: String(record.workingDir ?? "")
    });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    deps.broadcast({ type: SSE_EVENTS.projectCreated, data: projectRowToDto(r.project) });
    return c.json(projectRowToDto(r.project));
  });

  // Adopt must stay before parameterized project routes so future routers do
  // not interpret the literal "adopt" segment as an id.
  app.post(API_ROUTES.projectAdopt, async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON" }, 400); }
    const record = isRecord(body) ? body as Partial<AdoptProjectRequest> : {};

    const r = service.adopt({
      sessionName: String(record.sessionName ?? ""),
      projectName: String(record.projectName ?? ""),
      workingDir: String(record.workingDir ?? "")
    });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    deps.broadcast({ type: SSE_EVENTS.projectAdopted, data: projectRowToDto(r.project) });
    return c.json(projectRowToDto(r.project));
  });

  app.post(API_ROUTES.projectReorder, async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON" }, 400); }
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
    const r = service.reconcile(id);
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    deps.broadcast({ type: SSE_EVENTS.projectReconciled, data: { id, ...r.result } });
    return c.json(r.result);
  });

  app.delete(API_ROUTES.projectById, async (c) => {
    const id = c.req.param("id");
    const r = await service.archive({ id, killTmux: c.req.query("killTmux") === "true" });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    deps.broadcast({ type: SSE_EVENTS.projectArchived, data: { id } });
    return c.json({ ok: true });
  });
}

function errorStatus(status: number): 400 | 404 | 500 {
  return status === 404 ? 404 : status === 500 ? 500 : 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
