import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type RunningServer } from "./helpers/server";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { waitUntil } from "../tests/helpers/wait.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { assertStubProvider, respond, seedStubProvider, shown } from "./helpers/responses-stub.js";

// @ in a composer picks a thread to mention: the list, the pick, the sent
// tag, what the agent reads, Home's first message, and a phone. The model
// is a stub that answers "OK." and keeps every request it was sent.

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
const ids = { tErrors: "", tSpeed: "", general: "", long: "", alpha: "", beta: "", oven: "", design: "", release: "", check: "" };
const LONG_TITLE = "averyveryverylongunbrokenthreadtitlethatwontfitonaphonebubbleatall";
/** Every string of every request the model got. */
const shownToModel: string[] = [];

beforeAll(async () => {
  let count = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      shownToModel.push(shown(await request.json() as Record<string, unknown>));
      count += 1;
      return respond(String(count), "OK.");
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
        const agents = new AgentStore(store.db);
        // Created oldest first: the list shows the newest activity first.
        // Oldest of all: a Chinese title, found by its pinyin.
        ids.release = agents.createManagerThread("发布 3.21 版本").id;
        ids.long = agents.createManagerThread(LONG_TITLE).id;
        ids.alpha = agents.createManagerThread("alpha").id;
        ids.beta = agents.createManagerThread("beta").id;
        ids.general = agents.createManagerThread("General").id;
        ids.tSpeed = agents.createManagerThread("Parser speed study").id;
        ids.tErrors = agents.createManagerThread("Parser error messages").id;
        // Canvases: a manager thread's report and the personal agent's design.
        const canvases = new CanvasStore(store.db, dataDir);
        ids.oven = canvases.create({ title: "Oven timer report", scope: "manager", scopeId: null, threadId: ids.general }).id;
        ids.design = canvases.create({ title: "Settings page design", scope: "manager", scopeId: null, threadId: agents.getOrCreateThread("personal", null).id, kind: "design" }).id;
        // A minute apart, the design newest: made in one millisecond, their order would be the ids'.
        const touched = store.db.prepare("update canvas_documents set updated_at = ? where id = ?");
        touched.run("2026-11-06T09:00:00.000Z", ids.oven);
        ids.check = canvases.create({ title: "发布前检查报告", scope: "manager", scopeId: null, threadId: ids.general }).id;
        touched.run("2026-11-06T08:00:00.000Z", ids.check);
        touched.run("2026-11-06T09:01:00.000Z", ids.design);
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

const titles = (page: import("playwright").Page) => page.locator('[data-slot="mention-list"] [data-slot="mention-title"]').allTextContents();
/** The list once it answers what was typed. Until every source has, it keeps
 *  what it showed for the words before (up to 300 ms), so it is read, or
 *  picked from, only once it shows these. */
async function listShows(page: import("playwright").Page, expected: string[]): Promise<void> {
  await page.locator('[data-slot="mention-list"]').waitFor();
  let seen: string[] = [];
  await waitUntil(async () => JSON.stringify(seen = await titles(page)) === JSON.stringify(expected), { label: () => `the list to show ${JSON.stringify(expected)}; it shows ${JSON.stringify(seen)}` });
}

test("@ in the personal agent picks a thread, the sent message tags it, and the agent reads which thread it is", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/agent`);
    const box = page.locator('[data-slot="composer"] textarea');
    await box.click();
    await page.keyboard.type("Follow up on @Parser");
    await listShows(page, ["Parser error messages", "Parser speed study"]);
    await look(page, "desktop-list");
    await page.keyboard.press("Enter");
    expect(await box.inputValue()).toBe("Follow up on @Parser error messages ");
    await page.keyboard.type("and tell me what you find");
    await page.keyboard.press("Enter");
    const tag = page.locator(`[data-slot="mention-tag"][href="/threads/${ids.tErrors}"]`).first();
    await tag.waitFor();
    expect(await tag.textContent()).toBe("@Parser error messages");
    await look(page, "desktop-sent");
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
    // just after the URL changes the personal agent's composer can still be on screen.
    const threadBox = page.getByPlaceholder("Message the manager…");
    await threadBox.click();
    await page.keyboard.type("@Parser");
    await listShows(page, ["Parser speed study"]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("@ names a canvas too, under Canvases; it is sent as a tag that opens it, and the agent reads which canvas it is", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/agent`);
    const box = page.locator('[data-slot="composer"] textarea');
    await box.click();
    await page.keyboard.type("Check @");
    await page.locator('[data-slot="mention-list"] [role="group"][aria-label="Canvases"]').waitFor();
    const groups = page.locator('[data-slot="mention-list"] [role="group"]');
    expect(await groups.evaluateAll((all) => all.map((g) => g.getAttribute("aria-label")))).toEqual(["Threads", "Canvases"]);
    // Four threads of six, and how many more; both canvases, the newest first, each saying where it came from.
    expect(await groups.first().locator('[data-slot="group-more"]').textContent()).toBe("3 more · keep typing");
    const canvasRows = await groups.last().locator('[role="option"]').evaluateAll((rows) => rows.map((row) => [
      row.querySelector('[data-slot="mention-title"]')!.textContent,
      row.querySelector('[data-slot="mention-meta"]')!.textContent!.split(" · ")[0]
    ]));
    expect(canvasRows).toEqual([["Settings page design", "Juno"], ["Oven timer report", "General"], ["发布前检查报告", "General"]]);
    await look(page, "desktop-bare-list");
    await page.keyboard.type("Oven");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="mention-list"] [data-slot="mention-title"]')].map((el) => el.textContent).join("|") === "Oven timer report");
    await page.keyboard.press("Enter");
    expect(await box.inputValue()).toBe("Check @Oven timer report ");
    await page.keyboard.type("against the notes");
    await page.keyboard.press("Enter");
    const tag = page.locator(`[data-slot="mention-tag"][href="/canvas/${ids.oven}"]`).first();
    await tag.waitFor();
    expect(await tag.evaluate((el) => [el.textContent, el.querySelector('[data-slot="mention-icon"]')?.getAttribute("data-kind")])).toEqual(["Oven timer report", "report"]);
    await look(page, "desktop-canvas-sent");
    const line = `[Mentioned canvas "Oven timer report", canvasId ${ids.oven}; read it with canvas (action read)]`;
    await waitUntil(() => shownToModel.some((text) => text.includes(`${line}\nCheck @Oven timer report against the notes`)), { label: () => `the model's last request: ${shownToModel.at(-1)?.slice(-600)}` });
    // A click opens the canvas in the page, not a new browser tab.
    await tag.click();
    await page.waitForFunction((id) => window.location.pathname.includes(id) || document.querySelector(`[data-canvas-tab]`) !== null, ids.oven);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("pinyin after @ finds Chinese titles, what answered marked; while an input method composes, a click picks one and leaves no letters", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const rows = () => page.locator('[data-slot="mention-list"] [data-slot="mention-title"]').evaluateAll((all) => all.map((title) =>
    [...title.childNodes].map((node) => (node instanceof HTMLElement && node.dataset.slot === "mention-mark" ? `[${node.textContent}]` : node.textContent)).join("")));
  try {
    await page.goto(`${server.baseUrl}/agent`);
    const box = page.locator('[data-slot="composer"] textarea');
    await box.click();
    await page.keyboard.type("Ship @fb");
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="mention-list"] [data-slot="mention-mark"]').length >= 2);
    expect(await rows()).toEqual(["[发布] 3.21 版本", "[发布]前检查报告"]);
    await look(page, "desktop-pinyin");
    await page.keyboard.press("Escape");
    await box.fill("");

    // A Chinese input method composing "fa bu" after the @: the list follows its letters.
    await page.keyboard.type("Ship @");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "fa bu", selectionStart: 5, selectionEnd: 5 });
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="mention-list"] [data-slot="mention-mark"]').length >= 2);
    expect(await rows()).toEqual(["[发布] 3.21 版本", "[发布]前检查报告"]);
    await look(page, "desktop-pinyin-composing");
    await page.locator('[data-slot="mention-list"] [role="option"]').first().click();
    expect(await box.inputValue()).toBe("Ship @发布 3.21 版本 ");
    // The input method lets go: none of its letters come back.
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    await page.waitForTimeout(150);
    expect(await box.inputValue()).toBe("Ship @发布 3.21 版本 ");
    await page.keyboard.type("now");
    expect(await box.inputValue()).toBe("Ship @发布 3.21 版本 now");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("letters an input method composes after a typed space ask for nothing", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/agent`);
    const box = page.locator('[data-slot="composer"] textarea');
    const list = page.locator('[data-slot="mention-list"]');
    await box.click();
    await page.keyboard.type("Ship @Parser");
    await list.waitFor();
    await page.keyboard.type(" ");
    await list.waitFor({ state: "hidden" });
    // "Parser sp" is in a thread's title: the space typed before the input
    // method began is what ends the query, whatever it composes after it.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "sp", selectionStart: 2, selectionEnd: 2 });
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea')?.value === "Ship @Parser sp");
    await page.waitForTimeout(300);
    expect(await list.isVisible()).toBe(false);
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
    await listShows(page, ["General"]);
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
  const personal = (await (await fetch(`${server.baseUrl}/api/agents/personal`)).json() as { agent: { threadId: string } }).agent.threadId;
  // Sent as the page sends it: two mentions on two lines, and a long title.
  for (const body of [
    { content: "@alpha\n@beta", mentions: [{ kind: "thread", id: ids.alpha, label: "alpha" }, { kind: "thread", id: ids.beta, label: "beta" }] },
    { content: `see @${LONG_TITLE}`, mentions: [{ kind: "thread", id: ids.long, label: LONG_TITLE }] }
  ]) {
    const res = await fetch(`${server.baseUrl}/api/agents/threads/${personal}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
    await look(page, "phone-tags");
    // The list, over the composer, with rows a finger can take.
    await page.locator('[data-slot="composer"] textarea').tap();
    await page.keyboard.type("@Parser");
    await listShows(page, ["Parser error messages", "Parser speed study"]);
    const heights = await page.locator('[data-slot="mention-list"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(heights.length).toBe(2);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    await look(page, "phone-list");
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
