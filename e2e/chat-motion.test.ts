import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { cssAnimations, recordCssAnimations } from "./helpers/animations.js";

/**
 * Rows that arrive in a chat rise into place, through one real turn: the
 * message sent, then the reply as its words start. Neither rises again when
 * the stored copy takes its place, and what the chat opened with does not
 * move. A thread that goes over another in the sidebar slides there. The
 * working line fades in and out, and keeps its place while the
 * reply streams; the composer's list fades out as it closes. The model is a
 * stub that streams a short answer, slowly.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
let threadId = "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function reply(pieces: string[]): Response {
  const text = pieces.join("");
  const message = { type: "message", id: "msg_reply", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events: Array<[number, Record<string, unknown>]> = [
    [600, { type: "response.created", response: { id: "resp_reply", created_at: 1, model: "gpt-5.5" } }],
    [0, { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } }],
    ...pieces.map((delta): [number, Record<string, unknown>] => [300, { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta }]),
    [0, { type: "response.output_item.done", output_index: 0, item: message }],
    [0, { type: "response.completed", response: { id: "resp_reply", status: "completed", output: [message], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } }]
  ];
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [wait, event] of events) {
        if (wait) await sleep(wait);
        controller.enqueue(encoder.encode(sseFrame({ data: event })));
      }
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      return reply(["The cache test ", "fails because two reads ", "close the channel twice."]);
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.models.providers.openai.type = "openai-compatible";
      config.models.providers.openai.baseURL = `http://127.0.0.1:${stub.port}/v1`;
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        const thread = agent.createManagerThread("Release checks");
        threadId = thread.id;
        const ask = agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "Check why build 4128 failed." } });
        const wake = agent.createWake({ threadId, reason: "user", triggerMessageId: ask.id });
        agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Three checks failed; the cache test is the real one." } });
        agent.finishWake(wake.id, "finished");
        // A newer thread, over it in the sidebar until it works again.
        const docs = agent.createManagerThread("Docs pass");
        agent.appendMessage({ threadId: docs.id, role: "user", source: "user", content: { type: "text", text: "Tidy the setup guide." } });
        store.db.prepare("update agent_messages set created_at = ? where thread_id = ?").run("2026-01-12T08:00:00.000Z", threadId);
      } finally {
        store.db.close();
      }
    }
  });
});

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

/** Notes, from the page's first script on, each row of the transcript that
 *  rises (an animation on a child of its column), by its first words. */
async function recordRises(page: Page) {
  await page.addInitScript(() => {
    const rose: string[] = [];
    (window as unknown as { __rose: string[] }).__rose = rose;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const thread = this.getAttribute("data-thread-title");
      if (thread) rose.push(`sidebar: ${thread}`);
      else if (this.parentElement?.getAttribute("data-slot") === "transcript-column") {
        rose.push(this.getAttribute("data-slot") === "streaming-reply" ? "the streamed reply" : (this.textContent ?? "").slice(0, 24));
      }
      return animate.call(this, keyframes, options);
    };
  });
}
const rises = (page: Page) => page.evaluate(() => (window as unknown as { __rose: string[] }).__rose.filter((r) => !r.startsWith("sidebar: ")));
const sidebarMoves = (page: Page) => page.evaluate(() => [...new Set((window as unknown as { __rose: string[] }).__rose.filter((r) => r.startsWith("sidebar: ")))].sort());
const sidebarOrder = (page: Page) => page.locator('[role="group"][aria-label="Threads"] [data-thread-title]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-thread-title")));

test("in a real turn the message sent and the reply as it starts rise once each; the stored copies and what was there do not", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  attachPageDiagnostics(page);
  try {
    await recordRises(page);
    await recordCssAnimations(page);
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.getByText("Three checks failed; the cache test is the real one.").waitFor();
    expect(await rises(page)).toEqual([]);
    expect(await sidebarOrder(page)).toEqual(["Docs pass", "Release checks"]);
    const composer = page.locator('[data-slot="composer"] textarea');
    await composer.fill("Guard the close and tell me when the race test passes.");
    await composer.press("Enter");
    // While the reply streams, the working line is set aside in its place.
    let asideWhileStreaming = false;
    await waitUntil(async () => {
      const now = await page.evaluate(() => ({
        streaming: document.querySelector('[data-slot="streaming-reply"]') !== null,
        line: document.querySelector('[data-slot="working-indicator"]')?.getAttribute("data-state") ?? null,
        text: document.querySelector('[data-slot="transcript-column"]')?.textContent ?? ""
      }));
      if (now.streaming && now.line === "aside") asideWhileStreaming = true;
      return now.text.includes("close the channel twice.") && !now.streaming;
    }, { timeout: 20_000, interval: 50, label: () => "the reply to be stored" });
    expect(await rises(page)).toEqual(["Guard the close and tell", "the streamed reply"]);
    expect(asideWhileStreaming).toBe(true);
    // At work, the thread went over the other in the sidebar: both slid to
    // their new places.
    expect(await sidebarOrder(page)).toEqual(["Release checks", "Docs pass"]);
    expect(await sidebarMoves(page)).toEqual(["sidebar: Docs pass", "sidebar: Release checks"]);
    // The turn over, the working line fades out and is gone.
    await page.locator('[data-slot="working-indicator"]').waitFor({ state: "detached" });
    expect(await cssAnimations(page, "shown")).toEqual(["enter", "exit"]);
  } finally {
    await context.close();
  }
}, 40_000);

test("the composer's list fades out as it closes, then is gone", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  attachPageDiagnostics(page);
  try {
    await recordCssAnimations(page);
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    const composer = page.locator('[data-slot="composer"] textarea');
    await composer.fill("/");
    const list = page.locator('[data-slot="command-list"]');
    await list.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-slot="command-list"]')?.getAnimations().length === 0);
    await composer.press("Escape");
    // As it fades it still shows its commands, out of the pointer's way even
    // under the inline pointer-events Radix sets in a modal sheet.
    expect(await list.locator('[role="option"]').count()).toBeGreaterThan(0);
    expect(await list.evaluate((el) => { el.style.pointerEvents = "auto"; return getComputedStyle(el).pointerEvents; })).toBe("none");
    await list.waitFor({ state: "detached" });
    expect(await cssAnimations(page, "command-list")).toEqual(["enter", "exit"]);
  } finally {
    await context.close();
  }
}, 30_000);
