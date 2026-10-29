import { expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

const browser = browserForFile();

test("browser renders incremental text, reconnects mid-step, and replaces the stream with one final message", async () => {
  const sse = new AgentSseEmitter();
  const app = new Hono();
  // The thread list names the fixture's conversation, so its page opens.
  const managerThread = {
    id: "zoom-thread", title: "Streaming", named: true, createdAt: "2026-09-13T00:00:00.000Z",
    lastActivityAt: "2026-09-13T00:00:00.000Z", lastVisibleSeq: 0, seenSeq: 0, running: false, failed: false, stopReason: null, questions: [], archivedAt: null
  };
  mountSseRoutes(app, {
    sse, getSnapshot: () => null, getProjectsState: () => [], getManagerThreads: () => [managerThread], heartbeatMs: 60000
  });
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
  const errors = trackPageErrors(page);
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
    await page.route("**/api/agents/threads/zoom-thread?limit=50", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.continue();
    });
    // The manager thread's page.
    await page.goto(fixture.baseUrl + "/threads/zoom-thread");
    const chat = page.locator("main");
    await chat.getByText("Initial fragment", { exact: true }).waitFor();
    delta("Initial fragment, continuing");
    await chat.getByText("Initial fragment, continuing", { exact: true }).waitFor();

    // Complete one step and start another within the same wake.
    const first = fixture.appendMessage("Initial fragment, continuing", "stream-wake");
    // Let reconnect history overtake the live completion. Deduplication must
    // remove the streaming bubble even though its message is already loaded.
    const history = page.waitForResponse((response) => response.url().includes("/threads/zoom-thread?") && response.url().includes("since="));
    await Promise.all([...disconnects].map((disconnect) => disconnect()));
    await history;
    await chat.getByText("Initial fragment, continuing", { exact: true }).nth(1).waitFor();
    sse.emit("agentMessageAppended", { threadId: "zoom-thread", message: first });
    await chat.getByText("Initial fragment, continuing", { exact: true }).nth(1).waitFor({ state: "detached" });
    delta("Second step");
    await chat.getByText("Second step", { exact: true }).waitFor();
    await Promise.all([...disconnects].map((disconnect) => disconnect()));
    delta("Second step, generated while disconnected");
    await chat.getByText("Second step, generated while disconnected", { exact: true }).waitFor();
    delta("Second step, generated while disconnected, resumed");
    await chat.getByText("Second step, generated while disconnected, resumed", { exact: true }).waitFor();

    // Provider fallback replaces the current attempt, without old text left over.
    delta("");
    delta("Final reply after fallback");
    await chat.getByText("Final reply after fallback", { exact: true }).waitFor();
    expect(await chat.getByText("Second step, generated while disconnected, resumed", { exact: true }).count()).toBe(0);
    const final = fixture.appendMessage("Final reply after fallback", "stream-wake");
    sse.emit("agentMessageAppended", { threadId: "zoom-thread", message: final });
    sse.emit("agentWakeFinished", { threadId: "zoom-thread", wakeId: "stream-wake", status: "finished" });
    await page.waitForTimeout(150);
    expect(await chat.getByText("Final reply after fallback", { exact: true }).count()).toBe(1);
    expect(await chat.locator("span.animate-pulse[aria-hidden]").count()).toBe(0);
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
