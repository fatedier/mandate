import path from "node:path";
import { API_PATHS, API_ROUTES, SSE_EVENTS } from "../../src/shared/api-contracts";
import type { ProjectStateDto, WorkItemDto, CanvasDocumentDto } from "../../src/shared/api-contracts";
import { staticCacheControl } from "../../src/server/app/http-app";

const now = "2026-09-13T00:00:00.000Z";
export const WORKER_PATH = "/projects/zoom-project/features/zoom-worker";
const project: ProjectStateDto = {
  id: "zoom-project", name: "Zoom project", workingDir: "/tmp/zoom-fixture",
  isGit: true, gitRemote: null, tmuxSessionName: "zoom-project", ownership: "app",
  sortOrder: 0, createdAt: now, updatedAt: now, archivedAt: null,
  tmuxAlive: true, tmuxStatus: "alive",
  features: ["zoom-worker", "other-worker"].map((id) => ({
    id, projectId: "zoom-project", name: id, mode: "shared-cwd", branch: "main",
    baseRef: "main", worktreePath: null, tmuxWindowName: id, ownership: "app",
    pinnedAt: null, createdAt: now, updatedAt: now, archivedAt: null,
    tmuxAlive: true, tmuxStatus: "alive"
  }))
};
const item: WorkItemDto = {
  id: "zoom-item", featureId: "zoom-worker", projectId: project.id,
  title: "Worker pane zoom", summary: "Keep the split, reading position and chat draft when restoring.",
  phase: "working", phaseDetail: "Layout verification", needsUser: null, canvasId: "zoom-canvas",
  summaryUpdatedAt: now, summaryUpdatedBy: "worker", lastActivityAt: now, createdAt: now, updatedAt: now
};
const canvas: CanvasDocumentDto = {
  id: "zoom-canvas", title: "Workspace canvas", kind: "html", scope: "worker", scopeId: "zoom-worker",
  projectId: project.id, projectName: project.name, projectSlug: project.tmuxSessionName,
  featureId: "zoom-worker", featureName: "zoom-worker", featureSlug: "zoom-worker", threadId: "zoom-thread",
  createdAt: now, updatedAt: now, contentRevision: 0,
  // Text reflows to a much shorter document at full width, exposing lost
  // scroll restoration. A fixed-height spacer would hide that regression.
  html: `<!-- @tailwind: standalone fixture styles, no CDN needed --><style>body{font:16px/1.8 system-ui;padding:24px;color:#aaa}section{padding:20px;border-bottom:1px solid #555}</style><h1>Workspace canvas</h1>${Array.from({ length: 18 }, (_, i) => `<section>Section ${i + 1}: ${"Keep the current work in view. ".repeat(16)}</section>`).join("")}`
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
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const emit = (event: string, payload: unknown) => {
    const data = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const client of clients) client.enqueue(data);
  };
  const messages = Array.from({ length: 35 }, (_, index) => ({
    id: `zoom-msg-${index}`, threadId: "zoom-thread", seq: index + 1,
    role: index % 2 ? "assistant" : "user", source: "user", createdAt: now,
    content: { type: index % 2 ? "assistant" : "text", text: `Message ${index + 1}. ${"Keep the chat reading position. ".repeat(9)}` }
  }));
  const appendMessage = (text: string, wakeId?: string) => {
    const message = {
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
            controller.enqueue(new TextEncoder().encode(
              `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\nevent: projectsState\ndata: ${JSON.stringify([fixtureProject])}\n\n`
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
      if (canvasRoutes && route.startsWith("/api/canvas/")) return canvasRoutes(request);
      for (const document of canvasDocuments.values()) {
        if (route === API_PATHS.canvasById(document.id)) return Response.json({ canvas: document });
      }
      if (route.endsWith("/canvases")) return Response.json({ canvases: [canvasDocument] });
      if (route.endsWith("/changes")) return Response.json({ compare: "head", baseRef: "HEAD", mergeBase: "main", head: "main", files: [], totalAdditions: 0, totalDeletions: 0 });
      if (route.endsWith("/thread")) return Response.json({ thread: { id: "zoom-thread" }, messages, hasMore: false, contextUsage: null });
      if (route.endsWith("/messages")) return Response.json({ messages: [], hasMore: false });
      if (route === API_ROUTES.agentActiveWakes) return Response.json({ wakes: [] });
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
      const acknowledgementRoutes: string[] = [API_ROUTES.info, API_ROUTES.windowInspect, API_ROUTES.uiLocation, API_ROUTES.uiPageSummary];
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
    disconnectEvents: () => {
      for (const client of clients) client.close();
      clients.clear();
    },
    addWorkerCanvas: (featureId: string, html: string) => {
      const feature = { ...fixtureProject.features[0]!, id: featureId, name: featureId, tmuxWindowName: featureId };
      const index = fixtureProject.features.length;
      fixtureProject.features.push(feature);
      snapshot.sessions[0]!.windows.push({
        windowId: `@${index}`, windowIndex: index, windowName: featureId, windowActive: true,
        panes: [], aggregate: { status: "working" }
      });
      snapshot.counts.totalWindows++;
      const canvasId = `${featureId}-canvas`;
      workItems.set(`${featureId}-item`, { ...item, id: `${featureId}-item`, featureId, canvasId });
      canvasDocuments.set(canvasId, {
        ...canvas, id: canvasId, featureId, scopeId: featureId, featureName: featureId,
        featureSlug: featureId, title: `${featureId} canvas`, html
      });
      return canvasId;
    },
    removeWorker: (featureId: string) => {
      fixtureProject.features = fixtureProject.features.filter((feature) => feature.id !== featureId);
      snapshot.sessions[0]!.windows = snapshot.sessions[0]!.windows.filter((window) => window.windowName !== featureId);
      snapshot.counts.totalWindows = snapshot.sessions[0]!.windows.length;
      emit(SSE_EVENTS.projectsState, [fixtureProject]);
      emit(SSE_EVENTS.snapshot, snapshot);
    },
    bindCanvas: (featureId: string, canvasId: string | null) => {
      const item = [...workItems.values()].find((item) => item.featureId === featureId)!;
      item.canvasId = canvasId;
      item.updatedAt = new Date().toISOString();
      emit(SSE_EVENTS.workItemUpdated, { item });
    },
    setCanvasHtml: (html: string, canvasId = canvas.id) => { canvasDocuments.get(canvasId)!.html = html; },
    publishCanvasRevision: (canvasId = canvas.id) => {
      const document = canvasDocuments.get(canvasId)!;
      document.contentRevision = (document.contentRevision ?? 0) + 1;
      document.updatedAt = new Date().toISOString();
    },
    renameCanvas: (title: string, canvasId = canvas.id) => {
      const document = canvasDocuments.get(canvasId)!;
      document.title = title;
      document.updatedAt = new Date().toISOString();
    },
    setTerminalPane: (enabled: boolean) => { snapshot.sessions[0]!.windows[0]!.panes = enabled ? [terminalPane] : []; }
  };
}
