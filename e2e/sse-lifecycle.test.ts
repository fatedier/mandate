import { expect, test } from "bun:test";
import { Hono } from "hono";
import { chromium, type Browser } from "playwright";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes";

test("idle SSE survives two heartbeats without reconnecting and releases its subscription", async () => {
  const app = new Hono();
  const sse = new AgentSseEmitter();
  let connections = 0;
  app.use("/api/events", async (_c, next) => { connections++; await next(); });
  mountSseRoutes(app, {
    sse, heartbeatMs: 15000,
    getSnapshot: () => ({ sessions: [], clients: [], counts: {} }),
    getProjectsState: () => []
  });
  app.get("/", (c) => c.html("<!doctype html><title>SSE lifecycle</title>"));
  // A quiet ordinary response must still hit Bun's idle timeout. This catches
  // accidentally disabling the timeout globally instead of just for SSE.
  app.get("/idle", () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("started")); }
  })));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 10, fetch: app.fetch });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url.href);
    const result = await page.evaluate(async () => {
      const events: string[] = [];
      const source = new EventSource("/api/events?messageFormat=delta");
      for (const event of ["open", "error", "snapshot", "projectsState", "agentMessageStreams", "_hb"]) {
        source.addEventListener(event, () => events.push(event));
      }
      const control = new AbortController();
      let ordinaryTimedOut = false;
      const ordinary = fetch("/idle", { signal: control.signal })
        .then((response) => response.text())
        .catch(() => { ordinaryTimedOut = !control.signal.aborted; });
      try {
        await new Promise((resolve) => setTimeout(resolve, 35000));
        return { events, ordinaryTimedOut, readyState: source.readyState };
      } finally {
        source.close();
        control.abort();
        await ordinary;
      }
    });
    expect(result.ordinaryTimedOut).toBe(true);
    expect(result.events).toEqual(["open", "snapshot", "projectsState", "agentMessageStreams", "_hb", "_hb", "_hb"]);
    expect(result.readyState).toBe(1);
    expect(connections).toBe(1);
    // Browser close and the server abort callback run on separate tasks.
    for (let i = 0; sse.sinkCount !== 0 && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sse.sinkCount).toBe(0);
  } finally {
    await browser?.close();
    server.stop(true);
  }
}, 45000);
