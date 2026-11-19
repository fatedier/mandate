import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { motionEnded, recordAnimations, startedAnimations } from "./helpers/animations";
import { assertStubProvider, respond, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * Personal agent's page through real turns, the model a stub: the empty state
 * asks the personal agent in the chat; the personal agent hands the first page to a page
 * subagent, which writes it, a stylesheet and a second page into site/, a
 * data source and a scheduled update, paused from its menu; the page draws a seeded thread from the built-in data, on
 * either page, and its links go between them; the personal agent edits the page itself; an answer
 * given on the page reaches it on its next turn; an item the page marks is
 * quoted in the chat, on a desktop and a phone; on a phone Chat and Page
 * switch and Back returns to the chat.
 */

const PERSONAL_MARK = "You are the user's personal agent above all of Mandate's threads";
const PAGE_MARK = "You are a page subagent in Mandate.";
let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
/** The page folder, as the page subagent's prompt names it. */
let pageDir = "";
/** Every input the personal agent's model was sent, newest last. */
const personalInputs: string[] = [];
/** A report of the seeded thread's manager, opened as a tab on the page. */
let canvasId = "";

const FIRST_PAGE = [
  "<title>Today</title>",
  '<link rel="stylesheet" href="style.css">',
  '<h1 id="head">First page</h1>',
  '<a id="to-mr" href="mr.html">MRs</a>',
  '<p id="threads">no threads yet</p>',
  '<input id="a">',
  // A picture, served by the test: the next version's comes late (step 3).
  '<img id="pic" src="pic.png" alt="">',
  '<button id="pick" onclick="mandate.submit({ pick: \'c\' })">Pick c</button>',
  // Two items to quote: one by the sentence it gives, one by its own text.
  '<div id="mr-card" data-quote="MR !12 waits for your review"><b>MR !12</b> waits</div>',
  '<div id="own" data-quote=""><b>Frost</b> warning 03:00</div>',
  "<script>",
  'mandate.onData("threads", (d) => { document.getElementById("threads").textContent = (d.value || []).map((t) => t.title).join(", "); });',
  "</script>"
].join("\n");

/** The page's second page, drawn from data too, with a way back. */
const MR_PAGE = [
  '<h1 id="mr">MR list</h1>',
  '<p id="mr-threads"></p>',
  '<a id="home" href="index.html">Home</a>',
  "<script>",
  'mandate.onData("threads", (d) => { document.getElementById("mr-threads").textContent = (d.value || []).map((t) => t.title).join(", "); });',
  "</script>"
].join("\n");

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
        // The page subagent: site/'s three files, sources.json and updates.json, then one line.
        pageDir = all.match(/The page folder is (\/[^:]+): site\//)?.[1] ?? pageDir;
        const done = input.split("function_call_output").length - 1;
        if (done === 0) return respond(`p${calls}`, { call: { name: "write", args: { path: `${pageDir}/site/index.html`, content: FIRST_PAGE } } });
        if (done === 1) return respond(`p${calls}`, { call: { name: "write", args: { path: `${pageDir}/site/style.css`, content: "#head { color: rgb(1, 2, 3); }" } } });
        if (done === 2) return respond(`p${calls}`, { call: { name: "write", args: { path: `${pageDir}/site/mr.html`, content: MR_PAGE } } });
        if (done === 3) {
          const sources = JSON.stringify([{ name: "count", run: "printf '{\"n\":1}'", every: "1m" }]);
          return respond(`p${calls}`, { call: { name: "write", args: { path: `${pageDir}/sources.json`, content: sources } } });
        }
        if (done === 4) {
          const updates = JSON.stringify([{ name: "morning-summary", when: "0 9 * * *", task: "Sum up yesterday at the top." }]);
          return respond(`p${calls}`, { call: { name: "write", args: { path: `${pageDir}/updates.json`, content: updates } } });
        }
        return respond(`p${calls}`, { text: "Made the first page." });
      }
      if (all.includes(PERSONAL_MARK)) {
        personalInputs.push(input);
        // The latest ask decides; each is answered once its tools have run.
        const asks = ["Make your page.", "Change the heading.", "What did I pick?", "Can this wait until Monday?"]
          .map((ask) => ({ ask, at: input.lastIndexOf(ask) })).filter((a) => a.at >= 0).sort((a, b) => b.at - a.at);
        const latest = asks[0]?.ask;
        const done = latest ? outputsAfter(input, latest) ?? 0 : 0;
        if (latest === "Make your page.") {
          return done === 0
            ? respond(`g${calls}`, { call: { name: "subagent", args: { type: "page", title: "First page", task: "Make the first page." } } })
            : respond(`g${calls}`, { text: "A page subagent is making it." });
        }
        if (latest === "Change the heading.") {
          if (done === 0) return respond(`g${calls}`, { call: { name: "read", args: { path: `${pageDir}/site/index.html` } } });
          if (done === 1) return respond(`g${calls}`, { call: { name: "edit", args: { path: `${pageDir}/site/index.html`, oldString: "First page", newString: "Second page" } } });
          return respond(`g${calls}`, { text: "Changed it." });
        }
        if (latest === "What did I pick?") return respond(`g${calls}`, { text: "You picked c." });
        if (latest === "Can this wait until Monday?") return respond(`g${calls}`, { text: "It can wait." });
        return respond(`g${calls}`, { text: "Nothing waits on you." });
      }
      return respond(`x${calls}`, { text: "Noted." });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port, (config) => {
        config.agent = { ...config.agent, personalAgentName: "Juno" };
      });
      const store = new MandateStore(dataDir);
      try {
        const thread = new AgentStore(store.db).createManagerThread("Docs overhaul");
        const canvases = new CanvasStore(store.db, dataDir);
        const canvas = canvases.create({ title: "Release plan", scope: "manager", scopeId: thread.id, threadId: thread.id });
        canvases.writeSource(canvas.id, "<h1>Ship the cache fix</h1><p>Then write the release notes.</p>");
        if (canvases.publishSource(canvas.id).error) throw new Error("canvas did not publish");
        canvasId = canvas.id;
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
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

/** A 1x1 transparent PNG. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("Personal agent's page from its first version to an answer", async () => {
  const page = await open("/agent");
  // The page's picture: the first version's at once, a later version's
  // after 3 s, which holds that document's load (not its showing).
  await page.route(/\/api\/agent-page\/files\/(\d+)\/pic\.png$/, async (route) => {
    const revision = Number(/files\/(\d+)\//.exec(route.request().url())![1]);
    if (revision > 1) await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }).catch(() => {});
  });
  try {
    const pane = page.locator('[data-slot="agent-page"]');
    // 1. Before the first page: the button asks the personal agent in the chat.
    await pane.getByText("Juno hasn't made a page yet.").waitFor({ timeout: 15_000 });
    await pane.getByRole("button", { name: "Ask Juno to make its page" }).click();
    await page.locator('[data-slot="agent-chat"]').getByText("Make your page.").first().waitFor({ timeout: 15_000 });

    // 2. The page subagent's first page, published at its end.
    await pane.getByText("· updated").waitFor({ timeout: 30_000 });
    const frame = page.frameLocator('[data-slot="agent-page"] [data-in-sight] iframe');
    await frame.locator("#head").getByText("First page").waitFor({ timeout: 15_000 });
    // Drawn from the built-in data: the seeded thread.
    await frame.locator("#threads").getByText("Docs overhaul").waitFor({ timeout: 15_000 });
    await pane.getByRole("button", { name: "Sources · 1" }).click();
    await page.locator('[data-source="count"]').waitFor();
    await page.keyboard.press("Escape");
    // Its scheduled update, listed with when it runs; paused from the menu.
    await pane.getByRole("button", { name: "Updates · 1" }).click();
    const update = page.locator('[data-update="morning-summary"]');
    await update.getByText(/^Daily 09:00 · next \d\d:\d\d · not run yet$/).waitFor({ timeout: 15_000 });
    expect(await update.getAttribute("title")).toBe("Sum up yesterday at the top.");
    await update.getByRole("button", { name: "Pause" }).click();
    await update.getByText("Daily 09:00 · paused").waitFor({ timeout: 10_000 });
    const listed = await (await fetch(`${server.baseUrl}/api/agent-page/updates`)).json() as { updates: Array<{ name: string; paused: boolean }> };
    expect(listed.updates).toMatchObject([{ name: "morning-summary", paused: true }]);
    await page.keyboard.press("Escape");
    // The chat shows no page note.
    expect(await page.locator('[data-slot="agent-chat"]').innerText()).not.toContain("[Page]");
    // Its stylesheet came from site/ with it.
    expect(await frame.locator("#head").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(1, 2, 3)");
    // A link to its other page shows that page in the frame, data and all;
    // the link back returns.
    await frame.locator("#to-mr").click();
    await frame.locator("#mr").getByText("MR list").waitFor({ timeout: 15_000 });
    // The page it left stayed in sight until this one had drawn from its
    // data: never a page with its list still empty.
    expect(await frame.locator("#mr-threads").textContent()).toContain("Docs overhaul");
    expect(new URL(page.url()).pathname).toBe("/agent");
    await frame.locator("#home").click();
    await frame.locator("#head").getByText("First page").waitFor({ timeout: 15_000 });

    // 3. The personal agent edits the page itself; its turn's end publishes it. The
    // user typed in a page field first and then went to the composer: the
    // field no longer has focus, so the new version comes in by itself and
    // keeps what they typed.
    await frame.locator("#a").fill("gardener");
    await send(page, "Change the heading.");
    await page.getByText("Changed it.").first().waitFor({ timeout: 30_000 });
    await frame.locator("#head").getByText("Second page").waitFor({ timeout: 15_000 });
    // What they typed comes back by message once the new version's document
    // is read, not when its picture has loaded: the value is waited for (the
    // heading can show a moment before it), and the picture is still coming.
    let typed = "";
    await waitUntil(async () => (typed = await frame.locator("#a").inputValue()) === "gardener", { timeout: 10_000, label: () => `the typed value back in #a; it reads "${typed}"` });
    expect(await frame.locator("#pic").evaluate((img) => (img as HTMLImageElement).complete)).toBe(false);
    expect(await pane.getByRole("button", { name: "New version — Reload" }).count()).toBe(0);

    // 4. An answer on the page: kept, and in the personal agent's next turn.
    await frame.locator("#pick").click();
    await waitUntil(async () => {
      const answers = await (await fetch(`${server.baseUrl}/api/agent-page/data/answers`)).json() as { value: Array<{ value: unknown }> };
      return answers.value.some((answer) => JSON.stringify(answer.value) === JSON.stringify({ pick: "c" }));
    }, { label: "the answer to be kept", timeout: 10_000 });
    await send(page, "What did I pick?");
    await page.getByText("You picked c.").first().waitFor({ timeout: 30_000 });
    expect(personalInputs.at(-1)).toContain("[Page answer");
    expect(await page.locator('[data-slot="agent-chat"]').innerText()).not.toContain("[Page answer");
  } finally {
    await page.close();
  }
}, 120_000);

test("an item of the page quoted in the chat: Quote outlines what can be picked, a pick goes into the composer, and the personal agent reads it with the words", async () => {
  const page = await open("/agent");
  try {
    const pane = page.locator('[data-slot="agent-page"]');
    const frame = page.frameLocator('[data-slot="agent-page"] [data-in-sight] iframe');
    const quote = pane.getByRole("button", { name: "Quote", exact: true });
    await frame.locator("#mr-card").waitFor({ timeout: 15_000 });
    await quote.waitFor({ timeout: 10_000 });
    // A page that marks nothing has no Quote; the way back brings it again.
    await frame.locator("#to-mr").click();
    await frame.locator("#mr").waitFor({ timeout: 15_000 });
    await quote.waitFor({ state: "detached", timeout: 10_000 });
    await frame.locator("#home").click();
    await quote.waitFor({ timeout: 15_000 });

    await quote.click();
    // The pressed button and the outlined items say the mode is on: no line over the page.
    await pane.locator('[data-slot="page-quote"][aria-pressed="true"]').waitFor();
    expect(await pane.getByText("Choose an item to quote").count()).toBe(0);
    expect(await frame.locator("#mr-card").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("dashed");
    // Meanwhile a link is not followed.
    await frame.locator("#to-mr").click();
    expect(await frame.locator("#head").count()).toBe(1);
    await frame.locator("#mr-card b").click();
    await pane.locator('[data-slot="page-quote"][aria-pressed="false"]').waitFor();
    expect(await frame.locator("#mr-card").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
    const chat = page.locator('[data-slot="agent-chat"]');
    const chip = chat.locator('[data-slot="composer-quote"]');
    await chip.getByText("MR !12 waits for your review").waitFor();
    // The composer has the focus: the words come next.
    await page.keyboard.type("Can this wait until Monday?");
    await page.keyboard.press("Enter");
    await page.getByText("It can wait.").first().waitFor({ timeout: 30_000 });
    expect(personalInputs.at(-1)).toContain(JSON.stringify('[Quoting your page index.html: "MR !12 waits for your review"]\nCan this wait until Monday?').slice(1, -1));
    await chat.locator('[data-slot="page-quote"]').getByText("MR !12 waits for your review").waitFor();
    expect(await chip.count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);

test("on a phone an item quoted brings the chat back, the quote in its composer", async () => {
  const page = await open("/agent", { width: 390, height: 844 }, true);
  try {
    const tabs = page.getByRole("tablist", { name: "View" });
    await tabs.getByRole("tab", { name: "Panel" }).click();
    const pane = page.locator('[data-slot="agent-page"]');
    const frame = page.frameLocator('[data-slot="agent-page"] [data-in-sight] iframe');
    await frame.locator("#own").waitFor({ timeout: 15_000 });
    await pane.getByRole("button", { name: "Quote", exact: true }).tap();
    await pane.locator('[data-slot="page-quote"][aria-pressed="true"]').waitFor();
    await frame.locator("#own").tap();
    await page.waitForFunction(() => !document.querySelector('[data-slot="agent-page"]'), null, { timeout: 5000 });
    expect(await tabs.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    // Quoted by its own text, on one line.
    await page.locator('[data-slot="composer-quote"]').getByText("Frost warning 03:00", { exact: true }).waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

test("on a phone Chat and Panel switch, and Back returns to the chat", async () => {
  const page = await open("/agent", { width: 390, height: 844 }, true);
  try {
    const tabs = page.getByRole("tablist", { name: "View" });
    await tabs.waitFor({ timeout: 15_000 });
    expect(await page.locator('[data-slot="agent-page"]').count()).toBe(0);
    await tabs.getByRole("tab", { name: "Panel" }).click();
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

// On a desktop a canvas opens on Personal agent's page as a tab beside its Page,
// not over the window; the tab is remembered, Page and back keep it, and its
// menu's Close tab returns to Page.
test("a canvas on Personal agent's page is a tab beside the chat: Page and back, then Close tab", async () => {
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
    await look(page, "agent-canvas-tab-1440");

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

// The page is kept once opened: another page hides it, and the way back
// finds the report's frame as it was left, not built again (a rebuilt one
// stays blank while it fetches its web fonts again).
test("Personal agent's page is kept while another page shows: the report's frame is the one left, drawn at once", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPageDiagnostics(page);
  try {
    await page.addInitScript((tab) => {
      if (window.top !== window) return;
      localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, maximized: false, ratio: 0.5, tabs: [tab], active: tab }, version: 0 }));
    }, `canvas:${canvasId}`);
    await page.goto(`${server.baseUrl}/agent`);
    const shown = page.locator('[data-slot="agent-page"] [data-slot="canvas-tab-view"]:not(.hidden)');
    await shown.frameLocator("iframe").getByText("Ship the cache fix").waitFor({ timeout: 15_000 });
    const frame = (await (await shown.locator("iframe").elementHandle())!.contentFrame())!;
    await frame.evaluate(() => { (window as unknown as { kept: string }).kept = "left here"; });

    await page.locator('a[href="/projects"]').first().click();
    await page.waitForURL(`${server.baseUrl}/projects`);
    // Hidden, and nothing of it in the header: the page shown has the header.
    await page.locator('[data-slot="agent-page"]').waitFor({ state: "hidden" });
    expect(await page.locator('[data-slot="pane-header"]').first().textContent()).not.toContain("Juno");
    await look(page, "agent-kept-away");

    await page.locator('a[href="/agent"]').first().click();
    await page.waitForURL(`${server.baseUrl}/agent`);
    // The frame left, with what it held, and its report there the moment
    // the page shows: nothing to load again.
    await page.locator('[data-slot="agent-page"]').waitFor({ state: "visible" });
    expect(await shown.frameLocator("iframe").getByText("Ship the cache fix").isVisible()).toBe(true);
    expect(await frame.evaluate(() => (window as unknown as { kept?: string }).kept)).toBe("left here");
    await look(page, "agent-kept-back");
  } finally {
    await page.close();
  }
}, 60_000);
