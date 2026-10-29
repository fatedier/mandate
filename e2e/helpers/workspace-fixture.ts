import path from "node:path";
import { API_PATHS, API_ROUTES, CANVAS_ID, DEFAULT_SSE_HEARTBEAT_MS, SSE_EVENTS, SSE_HEARTBEAT_EVENT } from "../../src/shared/api-contracts";
import type { AgentClientMessageDto, ManagerThreadDto, ProjectStateDto, WorkItemDto, CanvasDocumentDto, DesignSnapshot } from "../../src/shared/api-contracts";
import { emptyPlan, type FeaturePlanDto, type FeatureRecordDto } from "../../src/shared/api/plans";
import { planForPage } from "../../src/shared/plan-rounds";
import { CANVAS_TITLE_MAX_CHARS } from "../../src/shared/canvas-page";
import { staticCacheControl } from "../../src/server/app/http-app";
import { sseFrame } from "../../tests/helpers/sse";
import type { ThreadStatusSnapshotDto } from "../../src/shared/api/thread-status";

const now = "2026-09-13T00:00:00.000Z";
export const WORKER_PATH = "/projects/zoom-project/features/zoom-worker";
/** The manager thread that owns zoom-worker. */
export const THREAD_ID = "thr_a";
// Typed, so a field the page comes to read is not left out here unnoticed.
const managerThread: ManagerThreadDto = {
  id: THREAD_ID, title: "project-1 3.21 release", named: true, createdAt: now, lastActivityAt: now,
  lastVisibleSeq: 0, seenSeq: 0, running: false, failed: false, stopReason: null, questions: [], archivedAt: null
};
const project: ProjectStateDto = {
  id: "zoom-project", name: "Zoom project", workingDir: "/tmp/zoom-fixture",
  isGit: true, gitRemote: null, tmuxSessionName: "zoom-project", ownership: "app",
  sortOrder: 0, createdAt: now, updatedAt: now, archivedAt: null,
  tmuxAlive: true, tmuxStatus: "alive",
  features: ["zoom-worker", "other-worker"].map((id) => ({
    id, projectId: "zoom-project", name: id, mode: "shared-cwd", branch: "main",
    baseRef: "main", worktreePath: null, tmuxWindowName: id, ownership: "app",
    pinnedAt: null, createdAt: now, updatedAt: now, archivedAt: null,
    ownerThreadId: id === "zoom-worker" ? THREAD_ID : null,
    tmuxAlive: true, tmuxStatus: "alive"
  }))
};
const item: WorkItemDto = {
  id: "zoom-item", featureId: "zoom-worker", projectId: project.id,
  title: "Worker pane zoom",
  lastActivityAt: now, createdAt: now, updatedAt: now,
  failedAt: null, failedMessage: null, failedKind: null
};
const canvas: CanvasDocumentDto = {
  id: "zoom-canvas", title: "Workspace canvas", kind: "report", scope: "worker", scopeId: "zoom-worker",
  projectId: project.id, projectName: project.name, projectSlug: project.tmuxSessionName,
  featureId: "zoom-worker", featureName: "zoom-worker", featureSlug: "zoom-worker", threadId: "zoom-thread",
  createdAt: now, updatedAt: now, contentRevision: 0,
  // Text reflows to a much shorter document at full width, exposing lost
  // scroll restoration. A fixed-height spacer would hide that regression.
  html: `<style>body{font:16px/1.8 system-ui;padding:24px;color:#aaa}section{padding:20px;border-bottom:1px solid #555}</style><h1>Workspace canvas</h1>${Array.from({ length: 18 }, (_, i) => `<section>Section ${i + 1}: ${"Keep the current work in view. ".repeat(16)}</section>`).join("")}`
};

/** Built client + deterministic API/SSE fixtures. Does not start an agent,
 *  access the user's data, or use a tmux server. Also usable for MCP checks. */
export function startWorkspaceFixture(
  clientDir = process.env.MANDATE_E2E_CLIENT_DIR ?? path.resolve("dist/client"),
  events?: (request: Request) => Response | Promise<Response>,
  canvasRoutes?: (request: Request) => Response | Promise<Response>
) {
  const fixtureProject = structuredClone(project);
  const canvasDocument = { ...canvas };
  const canvasDocuments = new Map([[canvas.id, canvasDocument]]);
  const workItems = new Map([[item.id, { ...item }]]);
  // What the server works out of its threads; the thread rests until a test says otherwise.
  let threadStatus: ThreadStatusSnapshotDto = { threads: [{ threadId: THREAD_ID, state: "idle" }], waiting: [] };
  const plans = new Map<string, FeaturePlanDto>();
  const records = new Map<string, FeatureRecordDto>();
  const terminalPane = {
    paneId: "%0", paneIndex: 0, paneWidth: 80, paneHeight: 24,
    currentCommand: "zsh", currentPath: "/tmp/zoom-fixture", paneTitle: "Fixture terminal"
  };
  const snapshot = {
    sessions: [{ sessionName: fixtureProject.tmuxSessionName, windows: fixtureProject.features.map((feature, i) => ({
      windowId: `@${i}`, windowIndex: i, windowName: feature.tmuxWindowName,
      windowActive: true, panes: [] as Array<typeof terminalPane>, aggregate: { status: "working" }
    })) }], counts: { totalWindows: 2 }
  };
  // What a live read of the pane finds in its foreground (GET /api/panes/:id),
  // which can run ahead of the snapshot: a program just started.
  let liveForeground: string[] | null = null;
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const emit = (event: string, payload: unknown) => {
    const data = new TextEncoder().encode(sseFrame({ event, data: payload }));
    for (const client of clients) client.enqueue(data);
  };
  const messages = Array.from({ length: 35 }, (_, index): AgentClientMessageDto => {
    const text = `Message ${index + 1}. ${"Keep the chat reading position. ".repeat(9)}`;
    return {
      id: `zoom-msg-${index}`, threadId: "zoom-thread", seq: index + 1,
      role: index % 2 ? "assistant" : "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: now,
      content: index % 2 ? { type: "assistant", text } : { type: "text", text }
    };
  });
  const appendMessage = (text: string, wakeId?: string): AgentClientMessageDto => {
    const message: AgentClientMessageDto = {
      ...messages[1]!, id: `zoom-msg-${messages.length}`, seq: messages.length + 1,
      content: { type: "assistant", text }, ...(wakeId ? { wakeId } : {})
    };
    messages.push(message);
    emit(SSE_EVENTS.agentMessageAppended, { threadId: "zoom-thread", message });
    return message;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const route = url.pathname;
      if (route === API_ROUTES.events) {
        if (events) return events(request);
        let client: ReadableStreamDefaultController<Uint8Array>;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            client = controller;
            clients.add(controller);
            // As the server does: the plans before the projects they belong to,
            // and the first heartbeat after the whole initial state.
            controller.enqueue(new TextEncoder().encode(
              sseFrame({ event: "snapshot", data: snapshot }) +
              sseFrame({ event: SSE_EVENTS.featurePlans, data: { plans: [...plans.values()].map(planForPage) } }) +
              sseFrame({ event: "projectsState", data: [fixtureProject] }) +
              sseFrame({ event: SSE_EVENTS.managerThreads, data: { threads: [managerThread] } }) +
              // Last, as the server sends it: its rows name what came above.
              sseFrame({ event: SSE_EVENTS.threadStatus, data: threadStatus }) +
              sseFrame({ event: SSE_HEARTBEAT_EVENT, data: { intervalMs: DEFAULT_SSE_HEARTBEAT_MS } })
            ));
          },
          cancel() { clients.delete(client); }
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
      if (route === API_ROUTES.state) return Response.json({
        projects: [fixtureProject], snapshot
      });
      if (route === API_ROUTES.workItems) return Response.json({
        items: [...workItems.values()].filter((item) => !url.searchParams.has("featureId") || item.featureId === url.searchParams.get("featureId")),
        nextCursor: null
      });
      const paneOf = /^\/api\/panes\/([^/]+)$/.exec(route);
      if (paneOf && request.method === "GET") {
        const shown = snapshot.sessions[0]!.windows[0]!.panes[0];
        if (!shown || shown.paneId !== decodeURIComponent(paneOf[1]!)) return Response.json({ error: "pane not found" }, { status: 404 });
        return Response.json({
          paneId: shown.paneId, sessionName: fixtureProject.tmuxSessionName, windowName: "w", windowId: "@0", windowIndex: 0,
          paneIndex: 0, active: true, currentCommand: shown.currentCommand, currentPath: shown.currentPath,
          paneWidth: shown.paneWidth, paneHeight: shown.paneHeight, projectId: fixtureProject.id,
          foregroundProcesses: (liveForeground ?? [shown.currentCommand]).map((command) => ({ command }))
        });
      }
      // As the server: a worker's task record, or none.
      const recordOf = /^\/api\/features\/([^/]+)\/record$/.exec(route);
      if (recordOf) return Response.json({ record: records.get(decodeURIComponent(recordOf[1]!)) ?? null });
      const planOf = /^\/api\/features\/([^/]+)\/plan$/.exec(route);
      if (planOf) {
        const featureId = decodeURIComponent(planOf[1]!);
        const plan = plans.get(featureId) ?? emptyPlan(featureId);
        // As the server: the page's plan, the whole one with ?history=1.
        return Response.json({ plan: url.searchParams.get("history") === "1" ? plan : planForPage(plan) });
      }
      // As the server: the titles of the canvases asked for that are there.
      if (route === API_ROUTES.canvasTitles) {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter((id) => CANVAS_ID.test(id));
        return Response.json({ canvases: ids.flatMap((id) => {
          const document = canvasDocuments.get(id);
          return document ? [{ id: document.id, title: document.title, kind: document.kind }] : [];
        }) });
      }
      if (canvasRoutes && route.startsWith("/api/canvas/")) return canvasRoutes(request);
      for (const document of canvasDocuments.values()) {
        if (route === API_PATHS.canvasById(document.id)) return Response.json({ canvas: document });
      }
      if (route.endsWith("/canvases")) return Response.json({ canvases: [canvasDocument] });
      if (route.endsWith("/changes")) return Response.json({ compare: "head", baseRef: "HEAD", mergeBase: "main", head: "main", files: [], totalAdditions: 0, totalDeletions: 0 });
      if (route.endsWith("/thread")) return Response.json({ thread: { id: "zoom-thread" }, messages, hasMore: false, contextUsage: null });
      if (request.method === "GET" && route === API_PATHS.agentThread(THREAD_ID)) {
        // Measured: a header with nothing measured shows no meter at all.
        return Response.json({
          thread: { id: THREAD_ID }, messages: [], hasMore: false,
          contextUsage: { inputTokens: 34_000, budgetTokens: 100_000, updatedAt: now, source: "compression_budget" }
        });
      }
      // A manager thread by id: the same conversation.
      if (request.method === "GET" && route === API_PATHS.agentThread("zoom-thread")) {
        return Response.json({ thread: { id: "zoom-thread" }, messages, hasMore: false, contextUsage: null });
      }
      if (route.endsWith("/messages")) return Response.json({ messages: [], hasMore: false });
      // Every composer asks what commands its conversation has: none here.
      if (request.method === "GET" && route.endsWith("/commands")) return Response.json({ commands: [] });
      // And its strip what background tasks it has: none here.
      if (request.method === "GET" && /^\/api\/agents\/threads\/[^/]+\/tasks$/.test(route)) return Response.json({ tasks: [] });
      // The composer's model: the route's, nothing picked, one provider's.
      if (request.method === "GET" && /^\/api\/agents\/threads\/[^/]+\/model$/.test(route)) {
        const model = { ref: "openai/gpt-5.5", providerName: "openai", model: "gpt-5.5" };
        return Response.json({ model: { default: model, override: null, choices: [{ providerName: "openai", models: [model] }] } });
      }
      if (route === API_ROUTES.agentActiveWakes) return Response.json({ wakes: [] });
      // Read on every stream open: no archived threads here.
      if (request.method === "GET" && route === API_ROUTES.agentManagerThreads && url.searchParams.get("archived") === "1") return Response.json({ archived: [] });
      if (route === API_ROUTES.agentPendingMonitors) return Response.json({ threads: [], revision: { boot: 1, seq: 0 } });
      if (route === API_ROUTES.setupStatus) return Response.json({
        ok: true, firstRun: false, ready: true,
        models: { providerCount: 1, defaultModel: "fixture/model", defaultModelReady: true, managerModelReady: true, workerModelReady: true, ready: true },
        terminal: { tmuxAvailable: true, error: null, ready: true },
        projects: { count: 1, ready: true }, agent: { preferencesReady: true }
      });
      if (route === API_ROUTES.settingsConfig) return Response.json({
        ok: true, models: { default: { model: "fixture/model" }, providers: {} },
        agent: { preferences: "Fixture preferences" }
      });
      if (route === "/__test/message" && request.method === "POST") {
        appendMessage(await request.text());
        return Response.json({ ok: true });
      }
      const acknowledgementRoutes: string[] = [API_ROUTES.info, API_ROUTES.windowInspect];
      if (acknowledgementRoutes.includes(route)) return Response.json({ ok: true });
      if (route.startsWith("/api/")) return Response.json({ error: `Unhandled fixture route: ${route}` }, { status: 404 });
      const filename = path.resolve(clientDir, `.${decodeURIComponent(route)}`);
      if (!filename.startsWith(path.resolve(clientDir) + path.sep) && filename !== path.resolve(clientDir)) return new Response(null, { status: 403 });
      const file = Bun.file(filename);
      const found = await file.exists() && !route.endsWith("/");
      return new Response(found ? file : Bun.file(path.join(clientDir, "index.html")), {
        headers: { "Cache-Control": staticCacheControl(found ? route : "/index.html") }
      });
    }
  });
  return {
    baseUrl: server.url.origin, appendMessage, emit, stop: () => server.stop(true),
    /** Replaces the worker's conversation, before a page reads it. */
    setMessages: (next: AgentClientMessageDto[]) => { messages.splice(0, messages.length, ...next); },
    disconnectEvents: () => {
      for (const client of clients) client.close();
      clients.clear();
    },
    /** Another canvas like the workspace's, under this id. */
    addCanvas: (canvasId: string, title = canvas.title) => { canvasDocuments.set(canvasId, { ...canvas, id: canvasId, title }); },
    setCanvasHtml: (html: string, canvasId = canvas.id) => { canvasDocuments.get(canvasId)!.html = html; },
    /** A design as the server sends it after a publish: its title from the
     *  index, a new content revision. */
    setCanvasDesign: (design: DesignSnapshot, canvasId = canvas.id) => {
      const document = canvasDocuments.get(canvasId)!;
      document.kind = "design";
      document.html = "";
      document.design = design;
      if (design.index.title) document.title = [...design.index.title].slice(0, CANVAS_TITLE_MAX_CHARS).join("");
      document.contentRevision = (document.contentRevision ?? 0) + 1;
      document.updatedAt = new Date().toISOString();
    },
    publishCanvasRevision: (canvasId = canvas.id) => {
      const document = canvasDocuments.get(canvasId)!;
      document.contentRevision = (document.contentRevision ?? 0) + 1;
      document.updatedAt = new Date().toISOString();
    },
    /** The plan the server holds for its feature (push one with `emit`). */
    setPlan: (plan: FeaturePlanDto) => { plans.set(plan.featureId, plan); },
    /** The task record the server holds for a worker; null for none. */
    setRecord: (featureId: string, record: FeatureRecordDto | null) => {
      if (record) records.set(featureId, record); else records.delete(featureId);
    },
    /** Shows the fixture's one terminal pane, running `currentCommand`. */
    setTerminalPane: (enabled: boolean, currentCommand = "zsh") => {
      snapshot.sessions[0]!.windows[0]!.panes = enabled ? [{ ...terminalPane, currentCommand }] : [];
      liveForeground = null;
    },
    /** What a live read of the pane finds, ahead of the snapshot. */
    setLiveForeground: (commands: string[] | null) => { liveForeground = commands; },
    /** Changes a worker before a page opens (the projects go out on connect):
     *  e.g. a worktree of its own, for the archive dialog's cleanup boxes. */
    setFeature: (id: string, fields: Partial<ProjectStateDto["features"][number]>) => {
      Object.assign(fixtureProject.features.find((feature) => feature.id === id)!, fields);
    },
    /** Renames the project before a page opens (the projects go out on connect). */
    setProjectName: (name: string) => { fixtureProject.name = name; },
    /** The thread status the server sends on connect (push a change with `emit`). */
    setThreadStatus: (next: ThreadStatusSnapshotDto) => { threadStatus = next; },
    /** Adds a worker of the thread like zoom-worker, before a page opens. */
    addWorker: (id: string) => {
      fixtureProject.features.push({ ...fixtureProject.features[0]!, id, name: id, tmuxWindowName: id, ownerThreadId: THREAD_ID });
    }
  };
}
