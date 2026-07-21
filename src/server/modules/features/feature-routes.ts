import { Hono } from "hono";
import {
  API_ROUTES,
  SSE_EVENTS,
  type CreateFeatureRequest,
  type RestoreFeatureRequest
} from "../../../shared/api-contracts.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { FeaturesStore } from "./features-store.js";
import {
  FeatureService,
  featureRowToDto
} from "./feature-service.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { PaneRuntimeRegistry } from "../../runtime/pane-runtime-registry.js";
import type { PaneMetadataStore } from "../panes/pane-metadata-store.js";
import { type TmuxClient, tmuxPaneWindowId } from "../../platform/tmux/tmux.js";
import type { GitClient } from "../../platform/git/git.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import { toWorkItemDto } from "../agent/work-item-dto.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";

export interface FeaturesApiDeps {
  projects: ProjectsStore;
  features: FeaturesStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  paneRuntimes: PaneRuntimeRegistry;
  paneMetadata?: PaneMetadataStore;
  broadcast: LifecyclePublisher;
  refreshWindows?: (windowIds: string[]) => void;
  refreshTmux?: () => void;
  agentStore?: AgentStore;
  workItems?: WorkItemStore;
  sse?: AgentSseEmitter;
  beforeFeatureArchive?: (featureId: string) => void;
}

export function mountFeaturesRoutes(app: Hono, deps: FeaturesApiDeps): void {
  const service = new FeatureService(deps);

  app.post(API_ROUTES.projectFeatures, async (c) => {
    const projectId = c.req.param("projectId");

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON" }, 400); }
    const record = isRecord(body) ? body as Partial<CreateFeatureRequest> : {};

    const r = await service.create({
      projectId,
      name: String(record.name ?? ""),
      mode: record.mode,
      branch: String(record.branch ?? ""),
      baseRef: String(record.baseRef ?? ""),
      worktreePath: String(record.worktreePath ?? "")
    });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    deps.broadcast({ type: "featureCreated", data: featureRowToDto(r.feature) });
    return c.json(featureRowToDto(r.feature));
  });

  app.post(API_ROUTES.featurePanes, async (c) => {
    const id = c.req.param("id");
    let body: unknown = {};
    try { body = await c.req.json(); } catch { /* empty body ok */ }
    const record = isRecord(body) ? body : {};
    const r = await service.createShellPane({
      featureId: id,
      name: typeof record.name === "string" ? record.name : undefined,
      description: typeof record.description === "string" ? record.description : undefined
    });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    const windowId = tmuxPaneWindowId(r.pane.id, deps.tmuxClient);
    if (windowId) deps.refreshWindows?.([windowId]);
    deps.broadcast({
      type: "paneCreated",
      data: { featureId: id, paneId: r.pane.id }
    });
    return c.json({ ok: true, paneId: r.pane.id });
  });

  app.post(API_ROUTES.featurePin, async (c) => {
    const id = c.req.param("id");
    const feature = deps.features.getById(id);
    if (!feature) return c.json({ error: "not_found" }, 404);
    if (feature.archivedAt) return c.json({ error: "feature_archived" }, 400);
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON" }, 400); }
    const record = isRecord(body) ? body : {};
    if (typeof record.pinned !== "boolean") {
      return c.json({ error: "pinned must be boolean" }, 400);
    }
    deps.features.setPinned(id, record.pinned);
    const updated = deps.features.getById(id)!;
    return c.json({ feature: featureRowToDto(updated) });
  });

  app.post(API_ROUTES.featureCanvasBind, async (c) => {
    const id = c.req.param("id");
    const feature = deps.features.getById(id);
    if (!feature) return c.json({ error: "not_found" }, 404);
    if (feature.archivedAt) return c.json({ error: "feature_archived" }, 400);
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON" }, 400); }
    const record = isRecord(body) ? body : {};
    const canvasId = record.canvasId;
    if (canvasId !== null && typeof canvasId !== "string") {
      return c.json({ error: "canvasId must be string or null" }, 400);
    }
    const ok = deps.workItems?.setCanvasIdForFeature(id, canvasId ?? null);
    if (ok === false) return c.json({ error: "work_item_not_found" }, 400);
    const item = deps.workItems?.getByFeature(id) ?? null;
    if (item && deps.sse) {
      deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(item) });
    }
    return c.json({ workItem: item ? toWorkItemDto(item) : null });
  });

  app.delete(API_ROUTES.featureById, async (c) => {
    const id = c.req.param("id");
    const killWorktree = queryBool(c.req.query("killWorktree"));

    const r = await service.archive({
      id,
      killWorktree,
      cleanup: {
        removeWorktree: queryBool(c.req.query("removeWorktree")),
        forceRemoveWorktree: queryBool(c.req.query("forceRemoveWorktree")),
        deleteBranch: queryBool(c.req.query("deleteBranch")),
        forceDeleteBranch: queryBool(c.req.query("forceDeleteBranch"))
      }
    });
    if (!r.ok) return c.json({ error: r.error, cleanupFailures: r.cleanupFailures }, errorStatus(r.status));

    deps.broadcast({ type: "featureArchived", data: { id, projectId: r.feature.projectId } });
    return c.json({ ok: true, cleanupFailures: r.cleanupFailures ?? [] });
  });

  app.post(API_ROUTES.featureRestore, async (c) => {
    const id = c.req.param("id");
    let body: unknown = {};
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON" }, 400); }
    const record = isRecord(body) ? body as Partial<RestoreFeatureRequest> : {};
    const r = await service.restore({
      id,
      mode: record.mode,
      branch: record.branch,
      baseRef: record.baseRef,
      worktreePath: record.worktreePath,
      tmuxWindowName: record.tmuxWindowName
    });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    const dto = featureRowToDto(r.feature);
    deps.broadcast({ type: "featureRestored", data: dto });
    return c.json({ feature: dto });
  });
}

function errorStatus(status: number): 400 | 404 | 409 | 500 {
  return status === 404 ? 404 : status === 409 ? 409 : status === 500 ? 500 : 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function queryBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true" || value === "1";
}
