import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

test("browser renders incremental text, reconnects mid-step, and replaces the stream with one final message", async () => {
  const sse = new AgentSseEmitter();
  const app = new Hono();
  mountSseRoutes(app, { sse, getSnapshot: () => null, getProjectsState: () => [], heartbeatMs: 60000 });
  const disconnects = new Set<() => Promise<void>>();
  // Only SSE uses the real server implementation; history/assets come from
  // the isolated fixture. This wrapper lets the test close its own sockets.
  const fixture = startWorkspaceFixture(undefined, async (request) => {
    const response = await app.fetch(request);
    const reader = response.body!.getReader();
    let closed = false;
    let disconnect!: () => Promise<void>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        disconnect = async () => {
          if (closed) return;
          closed = true;
          disconnects.delete(disconnect);
          controller.close();
          await reader.cancel();
        };
        disconnects.add(disconnect);
        controller.enqueue(new TextEncoder().encode("retry: 100\n\n"));
        void (async () => {
          while (!closed) {
            const next = await reader.read();
            if (next.done) break;
            if (!closed) controller.enqueue(next.value);
          }
        })();
      },
      async cancel() { closed = true; disconnects.delete(disconnect); await reader.cancel(); }
    });
    return new Response(body, { headers: response.headers });
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const frames: Array<{ eventName: string; data: string }> = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (frame) => frames.push(frame));
  const delta = (totalText: string) => {
    sse.emit("agentMessageDelta", { threadId: "zoom-thread", wakeId: "stream-wake", deltaText: totalText.slice(-1), totalText });
    sse.flushMessageDelta("zoom-thread", "stream-wake");
  };
  try {
    // Stream exists before either the page or its history is loaded.
    delta("Initial fragment");
    await page.route("**/api/agents/manager/thread?limit=50", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.continue();
    });
    await page.goto(fixture.baseUrl + WORKER_PATH);
    const dock = page.getByRole("complementary", { name: "Assistant dock" });
    await dock.getByText("Initial fragment", { exact: true }).waitFor();
    delta("Initial fragment, continuing");
    await dock.getByText("Initial fragment, continuing", { exact: true }).waitFor();

    // Complete one step and start another within the same wake.
    const first = fixture.appendMessage("Initial fragment, continuing", "stream-wake");
    // Let reconnect history overtake the live completion. Deduplication must
    // remove the streaming bubble even though its message is already loaded.
    const history = page.waitForResponse((response) => response.url().includes("/thread?since="));
    await Promise.all([...disconnects].map((disconnect) => disconnect()));
    await history;
    await dock.getByText("Initial fragment, continuing", { exact: true }).nth(1).waitFor();
    sse.emit("agentMessageAppended", { threadId: "zoom-thread", message: first as never });
    await dock.getByText("Initial fragment, continuing", { exact: true }).nth(1).waitFor({ state: "detached" });
    delta("Second step");
    await dock.getByText("Second step", { exact: true }).waitFor();
    await Promise.all([...disconnects].map((disconnect) => disconnect()));
    delta("Second step, generated while disconnected");
    await dock.getByText("Second step, generated while disconnected", { exact: true }).waitFor();
    delta("Second step, generated while disconnected, resumed");
    await dock.getByText("Second step, generated while disconnected, resumed", { exact: true }).waitFor();

    // Provider fallback replaces the current attempt, without old text left over.
    delta("");
    delta("Final reply after fallback");
    await dock.getByText("Final reply after fallback", { exact: true }).waitFor();
    expect(await dock.getByText("Second step, generated while disconnected, resumed", { exact: true }).count()).toBe(0);
    const final = fixture.appendMessage("Final reply after fallback", "stream-wake");
    sse.emit("agentMessageAppended", { threadId: "zoom-thread", message: final as never });
    sse.emit("agentWakeFinished", { threadId: "zoom-thread", wakeId: "stream-wake", status: "succeeded" });
    await page.waitForTimeout(150);
    expect(await dock.getByText("Final reply after fallback", { exact: true }).count()).toBe(1);
    expect(await dock.locator("span.animate-pulse[aria-hidden]").count()).toBe(0);
    expect(frames.filter((frame) => frame.eventName === "agentMessageStreams").length).toBeGreaterThanOrEqual(2);
    const patches = frames.filter((frame) => frame.eventName === "agentMessagePatch").map((frame) => JSON.parse(frame.data));
    expect(patches.some((patch) => patch.offset > 0 && patch.deltaText === ", continuing")).toBe(true);
    expect(patches.every((patch) => !("totalText" in patch))).toBe(true);
    expect(frames.some((frame) => frame.eventName === "agentMessageDelta")).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await Promise.all([...disconnects].map((disconnect) => disconnect()));
    fixture.stop();
  }
}, 20000);
