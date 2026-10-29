import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { startServer, type RunningServer } from "./helpers/server";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { waitUntil } from "../tests/helpers/wait.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";

// @ in a composer picks a thread to mention: the list, the pick, the sent
// tag, what the agent reads, Home's first message, and a phone. The model
// is a stub that answers "OK." and keeps every request it was sent.

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
const shots = () => artifactDir("thread-mentions");
const ids = { tErrors: "", tSpeed: "", general: "", long: "", alpha: "", beta: "" };
const LONG_TITLE = "averyveryverylongunbrokenthreadtitlethatwontfitonaphonebubbleatall";
/** Every string of every request the model got. */
const shownToModel: string[] = [];

function shown(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(body.input ?? []);
  return parts.join("\n");
}

function ok(id: string): Response {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK.", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } } } }
  ];
  return new Response(events.map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  let count = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      shownToModel.push(shown(await request.json() as Record<string, unknown>));
      count += 1;
      return ok(String(count));
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.models.providers.openai.type = "openai-compatible";
      config.models.providers.openai.baseURL = `http://127.0.0.1:${stub.port}/v1`;
      config.agent = { ...config.agent, globalAgentName: "Juno" };
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        // Created oldest first: the list shows the newest activity first.
        ids.long = agents.createManagerThread(LONG_TITLE).id;
        ids.alpha = agents.createManagerThread("alpha").id;
        ids.beta = agents.createManagerThread("beta").id;
        ids.general = agents.createManagerThread("General").id;
        ids.tSpeed = agents.createManagerThread("Parser speed study").id;
        ids.tErrors = agents.createManagerThread("Parser error messages").id;
      } finally {
        store.db.close();
      }
    }
  });
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== `http://127.0.0.1:${stub.port}/v1`) throw new Error(`the provider is not the stub: ${JSON.stringify(openai)}`);
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

const titles = (page: import("playwright").Page) => page.locator('[data-slot="mention-list"] [data-slot="mention-title"]').allTextContents();

test("@ in Your agent picks a thread, the sent message tags it, and the agent reads which thread it is", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/agent`);
    const box = page.locator('[data-slot="composer"] textarea');
    await box.click();
    await page.keyboard.type("Follow up on @Parser");
    await page.locator('[data-slot="mention-list"]').waitFor();
    expect(await titles(page)).toEqual(["Parser error messages", "Parser speed study"]);
    await page.screenshot({ path: path.join(shots(), "desktop-list.png") });
    await page.keyboard.press("Enter");
    expect(await box.inputValue()).toBe("Follow up on @Parser error messages ");
    await page.keyboard.type("and tell me what you find");
    await page.keyboard.press("Enter");
    const tag = page.locator(`[data-slot="mention-tag"][href="/threads/${ids.tErrors}"]`).first();
    await tag.waitFor();
    expect(await tag.textContent()).toBe("@Parser error messages");
    await page.screenshot({ path: path.join(shots(), "desktop-sent.png") });
    // The agent reads which thread it is, then the words as typed.
    const line = `[Mentioned thread "Parser error messages", threadId ${ids.tErrors}; read it with read_thread]`;
    await waitUntil(() => shownToModel.some((text) => text.includes(`${line}\nFollow up on @Parser error messages and tell me what you find`)), { label: () => `the model's last request: ${shownToModel.at(-1)?.slice(-600)}` });
    // Selected in the browser, the bubble reads as the sentence was typed.
    // The sent bubble is replaced once the server has the message: select
    // the one on screen, again if it went in between.
    const sentence = "Follow up on @Parser error messages and tell me what you find";
    const selectBubble = () => tag.evaluate((el) => {
      const bubble = el.closest('[data-slot="bubble-text"]')!;
      const range = document.createRange();
      range.selectNodeContents(bubble);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    let selected = "";
    await waitUntil(async () => (selected = await selectBubble()) === sentence, { label: () => `the selection read: ${JSON.stringify(selected)}` });
    expect(selected).toBe(sentence);
    // The tag opens the thread.
    await tag.click();
    await page.waitForURL(`${server.baseUrl}/threads/${ids.tErrors}`);
    // A thread's own composer offers the other threads, not itself. Its own:
    // just after the URL changes Your agent's composer can still be on screen.
    const threadBox = page.getByPlaceholder("Message the manager…");
    await threadBox.click();
    await page.keyboard.type("@Parser");
    await page.locator('[data-slot="mention-list"]').waitFor();
    expect(await titles(page)).toEqual(["Parser speed study"]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("Home's first message mentions a thread and the new thread shows the tag", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/home`);
    await page.locator("#new-thread-composer").click();
    await page.keyboard.type("Continue @Gen");
    await page.locator('[data-slot="mention-list"]').waitFor();
    await page.keyboard.press("Enter");
    await page.keyboard.type("from here");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/threads\//);
    await page.locator(`[data-slot="mention-tag"][href="/threads/${ids.general}"]`).first().waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("on a phone the list's rows are 44px, a long title wraps inside the bubble, and a tap opens the tag it lands on", async () => {
  const global = (await (await fetch(`${server.baseUrl}/api/agents/global`)).json() as { agent: { threadId: string } }).agent.threadId;
  // Sent as the page sends it: two mentions on two lines, and a long title.
  for (const body of [
    { content: "@alpha\n@beta", mentions: [{ kind: "thread", id: ids.alpha, label: "alpha" }, { kind: "thread", id: ids.beta, label: "beta" }] },
    { content: `see @${LONG_TITLE}`, mentions: [{ kind: "thread", id: ids.long, label: LONG_TITLE }] }
  ]) {
    const res = await fetch(`${server.baseUrl}/api/agents/threads/${global}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(202);
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/agent`);
    const alpha = page.locator(`[data-slot="mention-tag"][href="/threads/${ids.alpha}"]`).first();
    await alpha.waitFor();
    // The long title wraps within its bubble: two lines or more, every one
    // of them seen and inside it.
    const long = page.locator(`[data-slot="mention-tag"][href="/threads/${ids.long}"]`).first();
    await long.scrollIntoViewIfNeeded();
    const wrap = await long.evaluate((el) => {
      const bubble = el.closest('[data-slot="bubble-text"]')!.getBoundingClientRect();
      const rects = [...el.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      return {
        lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
        // Inside the bubble's box both ways: a bubble that clipped its lines
        // (folded, or capped in height) would leave fragments below it.
        inside: rects.every((rect) => rect.right <= bubble.right + 0.5 && rect.left >= bubble.left - 0.5
          && rect.top >= bubble.top - 0.5 && rect.bottom <= bubble.bottom + 0.5),
        visible: getComputedStyle(el).visibility === "visible" && getComputedStyle(el).overflow === "visible"
      };
    });
    expect(wrap.lines).toBeGreaterThanOrEqual(2);
    expect(wrap).toMatchObject({ inside: true, visible: true });
    await page.screenshot({ path: path.join(shots(), "phone-tags.png") });
    // The list, over the composer, with rows a finger can take.
    await page.locator('[data-slot="composer"] textarea').tap();
    await page.keyboard.type("@Parser");
    await page.locator('[data-slot="mention-list"]').waitFor();
    const heights = await page.locator('[data-slot="mention-list"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(heights.length).toBe(2);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: path.join(shots(), "phone-list.png") });
    await page.keyboard.press("Escape");
    await page.locator('[data-slot="mention-list"]').waitFor({ state: "detached" });
    // A tap on the lower edge of the upper tag opens that one, not the tag below.
    await alpha.scrollIntoViewIfNeeded();
    const point = await alpha.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.bottom - 2 };
    });
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForURL(`${server.baseUrl}/threads/${ids.alpha}`);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60_000);
