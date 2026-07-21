import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { chromium, type Browser, type Page } from "playwright";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes";
import type { ProjectStateDto, WorkspaceSnapshot } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState(history.state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, path);
}

async function open(configurePage?: (page: Page) => Promise<void>) {
  let snapshot: WorkspaceSnapshot;
  let projects: ProjectStateDto[];
  const sse = new AgentSseEmitter();
  const app = new Hono();
  const disconnects = new Set<() => void>();
  mountSseRoutes(app, { sse, getSnapshot: () => snapshot, getProjectsState: () => projects, heartbeatMs: 10000 });
  // Production SSE routes over real HTTP, with an explicit connection close
  // for reconnect checks. All other APIs use deterministic workspace fixtures.
  const fixture = startWorkspaceFixture(undefined, async (request) => {
    const response = await app.fetch(request);
    const reader = response.body!.getReader();
    let closed = false;
    let disconnect = () => {};
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        disconnect = () => {
          if (closed) return;
          closed = true;
          controller.close();
          void reader.cancel();
          disconnects.delete(disconnect);
        };
        disconnects.add(disconnect);
        try {
          while (!closed) {
            const chunk = await reader.read();
            if (closed) break;
            if (chunk.done) { disconnect(); break; }
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          if (!closed) controller.error(error);
        } finally { disconnects.delete(disconnect); }
      },
      cancel() { closed = true; disconnects.delete(disconnect); return reader.cancel(); }
    }), { headers: response.headers });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  const state = await (await page.request.get(fixture.baseUrl + "/api/state")).json();
  projects = state.projects;
  snapshot = state.snapshot;
  snapshot.snapshotVersion = { epoch: "browser-fixture", revision: 1 };
  snapshot.generatedAt = "initial";
  snapshot.sessions[0]!.windows[0]!.panes = [{
    paneId: "%0", paneIndex: 0, paneWidth: 80, paneHeight: 24,
    currentPath: "/tmp/fixture", currentCommand: "zsh", paneTitle: "Fixture terminal", preview: "Initial preview"
  }];
  snapshot.sessions[0]!.windows[1]!.panes = [{ paneId: "%1", preview: "Unchanged terminal\n".repeat(3000) }];
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.addInitScript(() => {
    const stats = { full: 0, patch: 0 };
    Object.assign(window, { snapshotFrames: stats });
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("snapshotFull", () => { stats.full++; });
        this.addEventListener("snapshotPatch", () => { stats.patch++; });
      }
    };
  });
  await configurePage?.(page);
  await page.goto(fixture.baseUrl + WORKER_PATH + "?tab=terminal");
  await page.getByText("Initial preview", { exact: true }).waitFor();
  return {
    page, sse, requests, fixture,
    snapshot: () => structuredClone(snapshot),
    publish(next: WorkspaceSnapshot) { snapshot = next; sse.emit("snapshot", next); },
    disconnect() { for (const disconnect of [...disconnects]) disconnect(); },
    async close() {
      await page.close();
      for (const disconnect of [...disconnects]) disconnect();
      fixture.stop();
      expect(errors).toEqual([]);
    }
  };
}

function update(snapshot: WorkspaceSnapshot, text: string, revision: number): WorkspaceSnapshot {
  const next = structuredClone(snapshot);
  next.snapshotVersion = { epoch: "browser-fixture", revision };
  next.sessions[0]!.windows[0]!.panes = [{ paneId: "%0", paneIndex: 0, paneTitle: "Fixture terminal", preview: text }];
  return next;
}

test("window patches update previews and status, including removal and reappearance", async () => {
  const env = await open();
  try {
    const next = update(env.snapshot(), "Live preview", 2);
    next.sessions[0]!.windows[0]!.aggregate = { status: "done" };
    env.publish(next);
    await env.page.getByText("Live preview", { exact: true }).waitFor();
    expect(await env.page.getByRole("button", { name: "Terminal", exact: true }).locator(".bg-live").count()).toBe(0);
    const removed = structuredClone(next);
    removed.sessions[0]!.windows.shift();
    removed.snapshotVersion = { epoch: "browser-fixture", revision: 3 };
    env.publish(removed);
    await env.page.getByText("tmux window is missing", { exact: true }).waitFor();
    next.snapshotVersion = { epoch: "browser-fixture", revision: 4 };
    env.publish(next);
    await env.page.getByText("Live preview", { exact: true }).waitFor();
    await navigate(env.page, "/projects");
    await env.page.getByRole("link").filter({ hasText: "Worker pane zoom" }).first().waitFor();
    await navigate(env.page, WORKER_PATH + "?tab=terminal");
    await env.page.getByText("Live preview", { exact: true }).waitFor();
    expect(env.requests.filter((path) => path === "/api/windows/inspect")).toHaveLength(0);
    expect(await env.page.evaluate(() => (window as unknown as { snapshotFrames: { full: number; patch: number } }).snapshotFrames))
      .toEqual({ full: 1, patch: 3 });
  } finally { await env.close(); }
}, 15000);

test("a delayed manual refresh cannot undo SSE updates in another window", async () => {
  const env = await open();
  try {
    const stale = env.snapshot();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await env.page.route("**/api/windows/inspect", async (route) => {
      await waiting;
      await route.fulfill({ json: { ok: true, snapshot: stale } });
    });
    await env.page.getByRole("button", { name: "Refresh panes", exact: true }).click();
    const latest = update(stale, "Newer SSE preview", 2);
    env.publish(latest);
    await env.page.getByText("Newer SSE preview", { exact: true }).waitFor();
    release();
    await env.page.getByRole("button", { name: "Refresh panes", exact: true }).waitFor();
    const later = structuredClone(latest);
    later.snapshotVersion = { epoch: "browser-fixture", revision: 3 };
    later.sessions[0]!.windows[1]!.windowIndex = 5;
    env.publish(later);
    await env.page.waitForFunction(() => (window as unknown as { snapshotFrames: { patch: number } }).snapshotFrames.patch === 2);
    await env.page.waitForTimeout(100);
    expect(await env.page.getByText("Newer SSE preview", { exact: true }).count()).toBe(1);
    expect(env.requests.filter((path) => path === "/api/windows/inspect")).toHaveLength(1);
  } finally { await env.close(); }
}, 15000);

test("HTTP ahead of SSE remains visible while queued patches catch up", async () => {
  const env = await open();
  try {
    const second = update(env.snapshot(), "Queued older preview", 2);
    const third = update(second, "Manual latest preview", 3);
    await env.page.route("**/api/windows/inspect", (route) => route.fulfill({ json: { ok: true, snapshot: third } }));
    await env.page.getByRole("button", { name: "Refresh panes", exact: true }).click();
    await env.page.getByText("Manual latest preview", { exact: true }).waitFor();
    env.publish(second);
    await env.page.waitForFunction(() => (window as unknown as { snapshotFrames: { patch: number } }).snapshotFrames.patch === 1);
    await env.page.waitForTimeout(100);
    expect(await env.page.getByText("Manual latest preview", { exact: true }).count()).toBe(1);
    env.publish(third);
    const fourth = update(third, "Later live preview", 4);
    env.publish(fourth);
    await env.page.getByText("Later live preview", { exact: true }).waitFor();
  } finally { await env.close(); }
}, 15000);

test("native reconnect and invalid revision recovery both start with a fresh full snapshot", async () => {
  const env = await open();
  try {
    env.publish(update(env.snapshot(), "Before reconnect", 2));
    await env.page.getByText("Before reconnect", { exact: true }).waitFor();
    env.disconnect();
    await env.page.waitForFunction(() => (window as unknown as { snapshotFrames: { full: number } }).snapshotFrames.full === 2);
    env.publish(update(env.snapshot(), "After reconnect", 3));
    await env.page.getByText("After reconnect", { exact: true }).waitFor();
    env.sse.emit("snapshotPatch", { baseRevision: 100, revision: 101 });
    await env.page.waitForFunction(() => (window as unknown as { snapshotFrames: { full: number } }).snapshotFrames.full === 3);
    env.publish(update(env.snapshot(), "After resync", 4));
    await env.page.getByText("After resync", { exact: true }).waitFor();
    expect(env.sse.sinkCount).toBe(1);
  } finally { await env.close(); }
}, 15000);

test("Terminal metadata and geometry follow patches without reconnecting its WebSocket", async () => {
  let connections = 0;
  const inputs: string[] = [];
  let inputReceived!: () => void;
  const input = new Promise<void>((resolve) => { inputReceived = resolve; });
  // Install the WebSocket fixture before loading the page so SPA navigation
  // keeps using the intercepted constructor as well.
  const env = await open(async (page) => {
    await page.routeWebSocket("**/api/terminal?*", (socket) => {
      connections++;
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "input") { inputs.push(message.data); inputReceived(); }
      });
    });
  });
  try {
    await navigate(env.page, WORKER_PATH + "/pane/%250");
    await env.page.locator('[aria-label="connected"]').waitFor();
    await env.page.getByRole("heading", { name: "zsh", exact: true }).waitFor();
    await env.page.waitForFunction(() => document.querySelector(".xterm-rows")?.children.length === 24);
    const next = env.snapshot();
    Object.assign(next.sessions[0]!.windows[0]!.panes![0]!, {
      metadata: { name: "Editor", description: "", updatedAt: "later" },
      currentCommand: "vim", currentPath: "/tmp/updated", paneWidth: 100, paneHeight: 30
    });
    next.sessions[0]!.windows[0]!.windowZoomed = true;
    next.snapshotVersion = { epoch: "browser-fixture", revision: 2 };
    const width = await env.page.locator(".xterm-screen").evaluate((node) => node.getBoundingClientRect().width);
    env.publish(next);
    await env.page.getByRole("heading", { name: "Editor", exact: true }).waitFor();
    await env.page.getByText("/tmp/updated", { exact: true }).waitFor();
    await env.page.getByText("zoomed", { exact: true }).waitFor();
    await env.page.waitForFunction(() => document.querySelector(".xterm-rows")?.children.length === 30);
    const updatedWidth = await env.page.locator(".xterm-screen").evaluate((node) => node.getBoundingClientRect().width);
    // xterm rounds the screen dimensions to whole CSS pixels.
    expect(Math.abs(updatedWidth - width * 1.25)).toBeLessThanOrEqual(1);
    expect(connections).toBe(1);
    await env.page.locator(".xterm-helper-textarea").focus();
    await env.page.keyboard.press("x");
    await input;
    expect(inputs).toEqual(["x"]);
    const removed = structuredClone(next);
    removed.snapshotVersion = { epoch: "browser-fixture", revision: 3 };
    removed.sessions[0]!.windows[0]!.panes = [];
    env.publish(removed);
    await env.page.getByText("Pane no longer exists", { exact: true }).waitFor();
    next.snapshotVersion = { epoch: "browser-fixture", revision: 4 };
    env.publish(next);
    await env.page.getByRole("heading", { name: "Editor", exact: true }).waitFor();
    await env.page.locator('[aria-label="connected"]').waitFor();
    expect(connections).toBe(2);
  } finally { await env.close(); }
}, 15000);

test("Projects dots and managed or standalone Terminal navigation select the current scope", async () => {
  const env = await open(async (page) => { await page.routeWebSocket("**/api/terminal?*", () => {}); });
  try {
    await env.page.route("**/api/panes/%259", (route) => route.fulfill({ json: {
      paneId: "%9", sessionName: "external", windowName: "shell", windowId: "@9",
      projectId: null, currentCommand: "bash", currentPath: "/tmp/external", paneWidth: 90, paneHeight: 25
    } }));
    await navigate(env.page, "/projects");
    await env.page.locator('[aria-label="pane running"]').first().waitFor();
    const next = env.snapshot();
    next.snapshotVersion = { epoch: "browser-fixture", revision: 2 };
    next.sessions[0]!.windows[1]!.aggregate = { status: "done" };
    next.sessions[0]!.windows[1]!.panes = [{
      paneId: "%1", currentCommand: "fish", currentPath: "/tmp/other", paneWidth: 90, paneHeight: 25
    }];
    env.publish(next);
    await env.page.getByRole("link").filter({ hasText: "other-worker" }).locator('[aria-label="pane idle"]').waitFor();
    expect(await env.page.getByRole("link").filter({ hasText: "Worker pane zoom" }).locator(".animate-live").count()).toBe(1);
    await navigate(env.page, WORKER_PATH + "/pane/%250");
    await env.page.getByRole("heading", { name: "zsh", exact: true }).waitFor();
    await navigate(env.page, WORKER_PATH.replace("zoom-worker", "other-worker") + "/pane/%251");
    await env.page.getByRole("heading", { name: "fish", exact: true }).waitFor();
    await navigate(env.page, "/sessions/external/windows/shell/pane/%259");
    await env.page.getByRole("heading", { name: "bash", exact: true }).waitFor();
    await env.page.getByText("/tmp/external", { exact: true }).waitFor();
    next.snapshotVersion = { epoch: "browser-fixture", revision: 3 };
    next.sessions = [];
    env.publish(next);
    await env.page.waitForFunction(() => {
      const frames = (window as unknown as { snapshotFrames: { full: number; patch: number } }).snapshotFrames;
      return frames.full + frames.patch === 3;
    });
    expect(await env.page.getByRole("heading", { name: "bash", exact: true }).count()).toBe(1);
    await navigate(env.page, WORKER_PATH + "/pane/%250");
    await env.page.getByText("Pane no longer exists", { exact: true }).waitFor();
  } finally { await env.close(); }
}, 15000);
