import { expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes";
import { browserForFile } from "./helpers/browser";

const browser = browserForFile();

test("idle SSE survives a heartbeat gap twice the idle timeout without reconnecting, and releases its subscription", async () => {
  const app = new Hono();
  const sse = new AgentSseEmitter();
  let connections = 0;
  app.use("/api/events", async (_c, next) => { connections++; await next(); });
  mountSseRoutes(app, {
    // The gap between heartbeats outlasts the idle timeout below twice over:
    // uSockets counts idle time in 4-second ticks, so a 4s timeout fires at
    // most ~4s after the last write, well inside the 8s gap. One gap is the
    // test; a second only doubled its run time.
    sse, heartbeatMs: 8000,
    getSnapshot: () => ({ sessions: [], clients: [], counts: {} }),
    getProjectsState: () => []
  });
  app.get("/", (c) => c.html("<!doctype html><title>SSE lifecycle</title>"));
  // A quiet ordinary response must still hit Bun's idle timeout. This catches
  // accidentally disabling the timeout globally instead of just for SSE.
  app.get("/idle", () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("started")); }
  })));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 4, fetch: app.fetch });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    const result = await page.evaluate(async () => {
      const events: string[] = [];
      const source = new EventSource("/api/events");
      for (const event of ["open", "error", "snapshotFull", "projectsState", "agentMessageStreams", "_hb"]) {
        source.addEventListener(event, () => events.push(event));
      }
      const control = new AbortController();
      let ordinaryTimedOut = false;
      const ordinary = fetch("/idle", { signal: control.signal })
        .then((response) => response.text())
        .catch(() => { ordinaryTimedOut = !control.signal.aborted; });
      try {
        // The connect heartbeat and the next, 8s later, plus a moment for a
        // reconnect that would follow a dropped stream.
        const deadline = Date.now() + 20000;
        while (events.filter((event) => event === "_hb").length < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { events, ordinaryTimedOut, readyState: source.readyState };
      } finally {
        source.close();
        control.abort();
        await ordinary;
      }
    });
    expect(result.ordinaryTimedOut).toBe(true);
    expect(result.events).toEqual(["open", "snapshotFull", "projectsState", "agentMessageStreams", "_hb", "_hb"]);
    expect(result.readyState).toBe(1);
    expect(connections).toBe(1);
    // Browser close and the server abort callback run on separate tasks.
    for (let i = 0; sse.sinkCount !== 0 && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sse.sinkCount).toBe(0);
  } finally {
    server.stop(true);
  }
}, 30000);
