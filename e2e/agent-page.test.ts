import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { motionEnded, recordAnimations, startedAnimations } from "./helpers/animations";

/**
 * Your agent's page through real turns, the model a stub: the empty state
 * asks Your agent in the chat; Your agent hands the first page to a page
 * subagent, which writes it and a data source; the page draws a seeded
 * thread from the built-in data; Your agent edits the page itself; an answer
 * given on the page reaches it on its next turn; on a phone Chat and Page
 * switch and Back returns to the chat.
 */

const GLOBAL_MARK = "You are the user's agent above all of Mandate's threads";
const PAGE_MARK = "You are a page subagent in Mandate.";
let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
/** The page folder, as the page subagent's prompt names it. */
let pageDir = "";
/** Every input Your agent's model was sent, newest last. */
const globalInputs: string[] = [];
/** A report of the seeded thread's manager, opened as a tab on the page. */
let canvasId = "";
/** Shots for a look, kept under a fixed path (the run's own folder goes when it passes). */
const SHOTS = path.join(import.meta.dir, ".artifacts", "preview-panel-tabs");

const FIRST_PAGE = [
  "<title>Today</title>",
  '<h1 id="head">First page</h1>',
  '<p id="threads">no threads yet</p>',
  '<input id="a">',
  '<button id="pick" onclick="mandate.submit({ pick: \'c\' })">Pick c</button>',
  "<script>",
  'mandate.onData("threads", (d) => { document.getElementById("threads").textContent = (d.value || []).map((t) => t.title).join(", "); });',
  "</script>"
].join("\n");

function respond(id: string, out: { text: string } | { call: { name: string; args: Record<string, unknown> } }): Response {
  const item = "text" in out
    ? { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: out.text, annotations: [] }] }
    : { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: out.call.name, arguments: JSON.stringify(out.call.args), status: "completed" };
  const events = [
    { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: "text" in out ? { ...item, content: [] } : { ...item, arguments: "" } },
    "text" in out
      ? { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: out.text }
      : { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: (item as { arguments: string }).arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } } } }
  ];
  return new Response(events.map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** How many tool outputs follow the latest of these asks in the input. */
function outputsAfter(input: string, ask: string): number | null {
  const at = input.lastIndexOf(ask);
  if (at < 0) return null;
  return input.slice(at).split("function_call_output").length - 1;
}

let calls = 0;
beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, unknown>;
      const all = JSON.stringify(body);
      const input = JSON.stringify(body.input ?? []);
      calls += 1;
      if (all.includes(PAGE_MARK)) {
        // The page subagent: index.html, then sources.json, then one line.
        pageDir = all.match(/The page folder is (\/[^:]+): index\.html/)?.[1] ?? pageDir;
        const done = input.split("function_call_output").length - 1;
        if (done === 0) return respond(`p${calls}`, { call: { name: "write", args: { path: `${pageDir}/index.html`, content: FIRST_PAGE } } });
        if (done === 1) {
          const sources = JSON.stringify([{ name: "count", run: "printf '{\"n\":1}'", every: "1m" }]);
          return respond(`p${calls}`, { call: { name: "write", args: { path: `${pageDir}/sources.json`, content: sources } } });
        }
        return respond(`p${calls}`, { text: "Made the first page." });
      }
      if (all.includes(GLOBAL_MARK)) {
        globalInputs.push(input);
        // The latest ask decides; each is answered once its tools have run.
        const asks = ["Make your page.", "Change the heading.", "What did I pick?"]
          .map((ask) => ({ ask, at: input.lastIndexOf(ask) })).filter((a) => a.at >= 0).sort((a, b) => b.at - a.at);
        const latest = asks[0]?.ask;
        const done = latest ? outputsAfter(input, latest) ?? 0 : 0;
        if (latest === "Make your page.") {
          return done === 0
            ? respond(`g${calls}`, { call: { name: "subagent", args: { type: "page", title: "First page", task: "Make the first page." } } })
            : respond(`g${calls}`, { text: "A page subagent is making it." });
        }
        if (latest === "Change the heading.") {
          if (done === 0) return respond(`g${calls}`, { call: { name: "read", args: { path: `${pageDir}/index.html` } } });
          if (done === 1) return respond(`g${calls}`, { call: { name: "edit", args: { path: `${pageDir}/index.html`, oldString: "First page", newString: "Second page" } } });
          return respond(`g${calls}`, { text: "Changed it." });
        }
        if (latest === "What did I pick?") return respond(`g${calls}`, { text: "You picked c." });
        return respond(`g${calls}`, { text: "Nothing waits on you." });
      }
      return respond(`x${calls}`, { text: "Noted." });
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
        const thread = new AgentStore(store.db).createManagerThread("Docs overhaul");
        const canvases = new CanvasStore(store.db, dataDir);
        const canvas = canvases.create({ title: "Release plan", scope: "manager", scopeId: thread.id, threadId: thread.id });
        canvases.writeSource(canvas.id, "<h1>Ship the cache fix</h1><p>Then widen it to every region.</p>");
        if (canvases.publishSource(canvas.id).error) throw new Error("canvas did not publish");
        canvasId = canvas.id;
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

async function open(pathname: string, viewport = { width: 1280, height: 900 }, phone = false): Promise<Page> {
  const page = await browser.newPage({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  attachPageDiagnostics(page);
  await recordAnimations(page);
  await page.goto(`${server.baseUrl}${pathname}`);
  return page;
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByPlaceholder("Ask about any thread or worker, or tell one what to do");
  await box.fill(text);
  await box.press("Enter");
}

test("Your agent's page from its first version to an answer", async () => {
  const page = await open("/agent");
  try {
    const pane = page.locator('[data-slot="agent-page"]');
    // 1. Before the first page: the button asks Your agent in the chat.
    await pane.getByText("Juno hasn't made a page yet.").waitFor({ timeout: 15_000 });
    await pane.getByRole("button", { name: "Ask Juno to make its page" }).click();
    await page.locator('[data-slot="agent-chat"]').getByText("Make your page.").first().waitFor({ timeout: 15_000 });

    // 2. The page subagent's first page, published at its end.
    await pane.getByText("· updated").waitFor({ timeout: 30_000 });
    const frame = page.frameLocator('[data-slot="agent-page"] iframe');
    await frame.locator("#head").getByText("First page").waitFor({ timeout: 15_000 });
    // Drawn from the built-in data: the seeded thread.
    await frame.locator("#threads").getByText("Docs overhaul").waitFor({ timeout: 15_000 });
    await pane.getByRole("button", { name: "Sources · 1" }).click();
    await page.locator('[data-source="count"]').waitFor();
    await page.keyboard.press("Escape");
    // The chat shows no page note.
    expect(await page.locator('[data-slot="agent-chat"]').innerText()).not.toContain("[Page]");

    // 3. Your agent edits the page itself; its turn's end publishes it. The
    // user typed in a page field first and then went to the composer: the
    // field no longer has focus, so the new version comes in by itself and
    // keeps what they typed.
    await frame.locator("#a").fill("ops-readonly");
    await send(page, "Change the heading.");
    await page.getByText("Changed it.").first().waitFor({ timeout: 30_000 });
    await frame.locator("#head").getByText("Second page").waitFor({ timeout: 15_000 });
    expect(await frame.locator("#a").inputValue()).toBe("ops-readonly");
    expect(await pane.getByRole("button", { name: "New version — Reload" }).count()).toBe(0);

    // 4. An answer on the page: kept, and in Your agent's next turn.
    await frame.locator("#pick").click();
    await waitUntil(async () => {
      const answers = await (await fetch(`${server.baseUrl}/api/agent-page/data/answers`)).json() as { value: Array<{ value: unknown }> };
      return answers.value.some((answer) => JSON.stringify(answer.value) === JSON.stringify({ pick: "c" }));
    }, { label: "the answer to be kept", timeout: 10_000 });
    await send(page, "What did I pick?");
    await page.getByText("You picked c.").first().waitFor({ timeout: 30_000 });
    expect(globalInputs.at(-1)).toContain("[Page answer");
    expect(await page.locator('[data-slot="agent-chat"]').innerText()).not.toContain("[Page answer");
  } finally {
    await page.close();
  }
}, 120_000);

test("on a phone Chat and Page switch, and Back returns to the chat", async () => {
  const page = await open("/agent", { width: 390, height: 844 }, true);
  try {
    const tabs = page.getByRole("tablist", { name: "View" });
    await tabs.waitFor({ timeout: 15_000 });
    expect(await page.locator('[data-slot="agent-page"]').count()).toBe(0);
    await tabs.getByRole("tab", { name: "Page" }).click();
    await page.locator('[data-slot="agent-page"]').waitFor();
    // It slides in over the chat, as a page opened on a phone does.
    expect(await startedAnimations(page, "agent-page")).toEqual([{ frames: ["translateX(100%)", "translateX(0)"], duration: 240 }]);
    // The page's step is in the history (a person cannot press Back in the
    // moment between the page showing and its step being added).
    await page.waitForFunction(() => (history.state as { usr?: { agentPage?: boolean } } | null)?.usr?.agentPage === true, null, { timeout: 5000 });
    // Back while it still slides in takes effect at once; after, it slides.
    await motionEnded(page, "agent-page");
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector('[data-slot="agent-page"]'), null, { timeout: 5000 });
    // And slides away again on the way back.
    expect((await startedAnimations(page, "agent-page")).at(-1)).toEqual({ frames: ["translateX(0)", "translateX(100%)"], duration: 240 });
    expect(new URL(page.url()).pathname).toBe("/agent");
    expect(await tabs.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
  } finally {
    await page.close();
  }
}, 60_000);

// On a desktop a canvas opens on Your agent's page as a tab beside its Page,
// not over the window; the tab is remembered, Page and back keep it, and its
// menu's Close tab returns to Page.
test("a canvas on Your agent's page is a tab beside the chat: Page and back, then Close tab", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPageDiagnostics(page);
  try {
    await page.addInitScript((tab) => {
      // The page only: a report's sandboxed frame has no storage to write.
      if (window.top !== window) return;
      localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, maximized: false, ratio: 0.5, tabs: [tab], active: tab }, version: 0 }));
    }, `canvas:${canvasId}`);
    await page.goto(`${server.baseUrl}/agent`);
    const pane = page.locator('[data-slot="agent-page"]');
    const tab = pane.locator(`[data-canvas-tab="${canvasId}"]`);
    await pane.locator(`[data-canvas-tab="${canvasId}"][aria-selected="true"]`).getByText("Release plan").waitFor({ timeout: 15_000 });
    const shown = pane.locator('[data-slot="canvas-tab-view"]:not(.hidden)');
    await shown.frameLocator("iframe").getByText("Ship the cache fix").waitFor({ timeout: 15_000 });
    expect(await shown.locator('[data-slot="canvas-tab-bar"]').textContent()).toContain("Report · updated");
    expect(await page.getByRole("dialog", { name: "Canvas", exact: true }).count()).toBe(0);
    await page.waitForTimeout(300);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, "agent-canvas-tab-1440.png") });

    // Page: the page's body shows and the canvas waits hidden; back to it.
    await pane.getByRole("tab", { name: "Page", exact: true }).click();
    await pane.locator('[data-slot="agent-page-body"]:not(.hidden)').waitFor();
    expect(await shown.count()).toBe(0);
    await tab.click();
    await shown.frameLocator("iframe").getByText("Ship the cache fix").waitFor();

    // Close tab, from the canvas's menu: the tab goes and Page is open.
    await shown.getByRole("button", { name: "Canvas menu" }).click();
    await page.getByRole("menuitem", { name: "Close tab" }).click();
    await tab.waitFor({ state: "detached" });
    expect(await pane.getByRole("tab", { name: "Page", exact: true }).getAttribute("aria-selected")).toBe("true");
  } finally {
    await page.close();
  }
}, 60_000);
