import { Hono } from "hono";
import {
  API_ROUTES,
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
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { isRecord } from "../../../shared/guards.js";
import { ensureOpenOwner } from "./ownership.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";

interface FeaturesApiDeps {
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

    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    const record = isRecord(body) ? body as Partial<CreateFeatureRequest> : {};

    const requestedOwner = typeof record.ownerThreadId === "string" && record.ownerThreadId ? record.ownerThreadId : null;
    const r = await service.create({
      projectId,
      name: String(record.name ?? ""),
      mode: record.mode,
      branch: String(record.branch ?? ""),
      baseRef: String(record.baseRef ?? ""),
      worktreePath: String(record.worktreePath ?? ""),
      ownerThreadId: null
    });
    if (!r.ok) return c.json({ error: r.error }, errorStatus(r.status));

    // Every active worker has an open owner: a given
    // ownerThreadId that is not an open manager thread is ignored, and
    // without a usable one a thread named after the worker is opened.
    let feature = r.feature;
    if (deps.agentStore) {
      ensureOpenOwner({ featuresStore: deps.features, agentStore: deps.agentStore }, feature.id, requestedOwner);
      feature = deps.features.getById(feature.id) ?? feature;
    }
    deps.broadcast({ type: "featureCreated", data: featureRowToDto(feature) });
    return c.json(featureRowToDto(feature));
  });

  app.post(API_ROUTES.featurePanes, async (c) => {
    const id = c.req.param("id");
    // A missing or broken body is an empty one here.
    const body = await readJsonBody(c);
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
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
    const record = isRecord(body) ? body : {};
    if (typeof record.pinned !== "boolean") {
      return c.json({ error: "pinned must be boolean" }, 400);
    }
    deps.features.setPinned(id, record.pinned);
    const updated = deps.features.getById(id)!;
    return c.json({ feature: featureRowToDto(updated) });
  });


  app.delete(API_ROUTES.featureById, async (c) => {
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

    deps.broadcast({ type: "featureArchived", data: { id, projectId: r.feature.projectId } });
    return c.json({ ok: true, cleanupFailures: r.cleanupFailures ?? [] });
  });

  app.get(API_ROUTES.featureArchiveCheck, (c) => {
    const check = service.archiveCheck(c.req.param("id"));
    if (!check) return c.json({ error: "feature not found" }, 404);
    return c.json(check);
  });

  app.post(API_ROUTES.featureRestore, async (c) => {
    const id = c.req.param("id");
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) return c.json({ error: "invalid JSON" }, 400);
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

    // A worker whose thread is gone comes back with a thread of its own.
    let restored = r.feature;
    if (deps.agentStore) {
      ensureOpenOwner({ featuresStore: deps.features, agentStore: deps.agentStore }, restored.id);
      restored = deps.features.getById(restored.id) ?? restored;
    }
    const dto = featureRowToDto(restored);
    deps.broadcast({ type: "featureRestored", data: dto });
    return c.json({ feature: dto });
  });
}

function errorStatus(status: number): 400 | 404 | 409 | 500 {
  return status === 404 ? 404 : status === 409 ? 409 : status === 500 ? 500 : 400;
}

function queryBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true" || value === "1";
}
