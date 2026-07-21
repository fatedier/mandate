import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { SSE_EVENTS, type CanvasListItemDto } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

function artifact(id: string, title: string, featureId = "zoom-worker"): CanvasListItemDto {
  return {
    id, title, kind: "html", scope: "worker", scopeId: featureId, featureId,
    projectId: "zoom-project", projectName: "Zoom project", projectSlug: "zoom-project",
    featureName: featureId, featureSlug: featureId, threadId: "zoom-thread",
    createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z"
  };
}

async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState(history.state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, path);
}

async function open() {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  const lists = new Map([
    ["zoom-worker", [artifact("zoom-canvas", "Original artifact")]],
    ["other-worker", [artifact("other-canvas", "Other artifact", "other-worker")]]
  ]);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const defaultHandler = async (route: Route, featureId: string) => {
    await route.fulfill({ json: { canvases: lists.get(featureId) ?? [] } });
  };
  let handler = defaultHandler;
  await page.route("**/api/features/*/canvases", (route) => {
    const featureId = new URL(route.request().url()).pathname.split("/")[3]!;
    requests.push(featureId);
    return handler(route, featureId);
  });
  const button = (title: string) => page.getByRole("button", { name: `Open canvas: ${title}`, exact: true });
  try {
    await page.goto(fixture.baseUrl + WORKER_PATH + "?tab=artifacts");
    await button("Original artifact").waitFor();
    return {
      fixture, page, lists, requests, errors, button, defaultHandler,
      setHandler: (next: typeof handler) => { handler = next; },
      updated: (canvasId = "zoom-canvas", featureId: string | null = "zoom-worker") => {
        fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId, featureId });
      },
      close: async () => { await page.close(); fixture.stop(); }
    };
  } catch (error) { await page.close(); fixture.stop(); throw error; }
}

test("Artifacts ignores other or missing owners and coalesces updates for a previously unknown Canvas", async () => {
  const env = await open();
  try {
    for (let i = 0; i < 20; i++) {
      env.updated(`other-${i}`, "other-worker");
      env.updated(`manager-${i}`, null);
    }
    await env.page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: "missing-owner" } }));
    });
    await env.page.waitForTimeout(300);
    expect(env.requests).toEqual(["zoom-worker"]);
    env.lists.set("zoom-worker", [artifact("new-canvas", "New artifact")]);
    for (let i = 0; i < 20; i++) env.updated("new-canvas");
    await env.button("New artifact").waitFor();
    await env.page.waitForTimeout(150);
    expect(env.requests).toEqual(["zoom-worker", "zoom-worker"]);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);

test("Updates during a request share one follow-up while completed responses still make progress", async () => {
  const env = await open();
  try {
    let received: ((route: Route) => void) | undefined;
    const nextRequest = () => new Promise<Route>((resolve) => { received = resolve; });
    env.setHandler(async (route) => { received?.(route); received = undefined; });
    const firstPending = nextRequest();
    env.updated();
    const first = await firstPending;
    for (let i = 0; i < 20; i++) env.updated("new-canvas");
    await env.page.waitForTimeout(250);
    expect(env.requests).toHaveLength(2);
    const secondPending = nextRequest();
    await first.fulfill({ json: { canvases: [artifact("interim", "Interim artifact")] } });
    await env.button("Interim artifact").waitFor();
    const second = await secondPending;
    expect(env.requests).toHaveLength(3);
    await second.fulfill({ json: { canvases: [artifact("latest", "Latest artifact")] } });
    await env.button("Latest artifact").waitFor();
    await env.page.waitForTimeout(150);
    expect(env.requests).toHaveLength(3);
    expect(await env.button("Interim artifact").count()).toBe(0);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);

test("Reconnects recover missed list updates", async () => {
  const env = await open();
  try {
    env.lists.set("zoom-worker", [artifact("reconnected", "Recovered artifact")]);
    env.fixture.disconnectEvents();
    await env.button("Recovered artifact").waitFor({ timeout: 10000 });
    expect(env.requests).toHaveLength(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Leaving Artifacts cancels pending requests and a previous Worker's response cannot replace the current list", async () => {
  const env = await open();
  try {
    let hold: (route: Route) => void;
    const pending = new Promise<Route>((resolve) => { hold = resolve; });
    env.setHandler(async (route, featureId) => {
      if (featureId === "zoom-worker") hold(route);
      else await env.defaultHandler(route, featureId);
    });
    env.updated();
    const route = await pending;
    const canceled = env.page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).pathname === "/api/features/zoom-worker/canvases"
    });
    await navigate(env.page, "/projects/zoom-project/features/other-worker?tab=artifacts");
    await env.button("Other artifact").waitFor();
    await canceled;
    await route.fulfill({ json: { canvases: [artifact("stale", "Stale artifact")] } });
    env.updated();
    await env.page.waitForTimeout(200);
    expect(env.requests).toEqual(["zoom-worker", "zoom-worker", "other-worker"]);
    expect(await env.button("Other artifact").isVisible()).toBe(true);
    expect(await env.button("Stale artifact").count()).toBe(0);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);

test("A failed list request does not block subsequent refreshes", async () => {
  const env = await open();
  try {
    env.setHandler(async (route) => { await route.fulfill({ status: 503, json: { error: "Artifacts temporarily unavailable" } }); });
    env.updated();
    await env.page.getByText("Artifacts temporarily unavailable", { exact: true }).waitFor();
    env.setHandler(env.defaultHandler);
    env.updated();
    await env.button("Original artifact").waitFor();
    expect(env.requests).toHaveLength(3);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);

test("Leaving before a coalesced refresh starts clears its timer", async () => {
  const env = await open();
  try {
    await env.page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: "zoom-canvas", featureId: "zoom-worker" } }));
      history.pushState(history.state, "", "/projects");
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await env.button("Original artifact").waitFor({ state: "detached" });
    await env.page.waitForTimeout(250);
    expect(env.requests).toEqual(["zoom-worker"]);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);
