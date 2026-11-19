import { afterAll, beforeAll, expect, test } from "bun:test";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { paced, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * A reader scrolled up in a long conversation stays on their row while the
 * agent writes below.
 *
 * The page keeps a conversation's newest 500 messages and dropped the oldest
 * as each new one came. Dropped above a reader who had scrolled up, they
 * moved what the reader was on by a row per message, and by thousands of
 * pixels when older pages had taken the page past 500 (the scroller does not
 * anchor: overflow-anchor none). Only a real engine lays the rows out.
 */

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
let threadId = "";
const PARTS = Array.from({ length: 4 }, (_, i) => `Part ${i + 1} of the answer, long enough to wrap in the column. `);
const REPLY = PARTS.join("").trim();

/** An answer written a piece at a time, as a model streams it. */
function streamed(id: number): Response {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: REPLY, annotations: [] }] };
  return paced([
    { event: { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } } },
    { event: { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } } },
    ...PARTS.map((delta, i) => ({ wait: 20, event: { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: i === PARTS.length - 1 ? delta.trimEnd() : delta } })),
    { event: { type: "response.output_item.done", output_index: 0, item } },
    { event: { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18, input_tokens_details: { cached_tokens: 0 } } } } }
  ]);
}

/** 560 tall messages: more than the page keeps. */
function seedLong(dataDir: string): string {
  const store = new MandateStore(dataDir);
  try {
    const agent = new AgentStore(store.db);
    const thread = agent.createManagerThread("Long conversation");
    for (let index = 0; index < 560; index += 1) {
      agent.appendMessage({
        threadId: thread.id, role: index % 2 === 0 ? "user" : "assistant", source: "user",
        content: { type: "text", text: `MSG-${String(index).padStart(3, "0")} ${"lorem ipsum ".repeat(14)}` }
      });
    }
    return thread.id;
  } finally {
    store.db.close();
  }
}

beforeAll(async () => {
  let calls = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      await request.json();
      calls += 1;
      return streamed(calls);
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port);
      threadId = seedLong(dataDir);
    }
  });
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

type Page = import("playwright").Page;
const SCROLLER = 'document.querySelector(\'[data-slot="transcript-column"]\').parentElement';
/** The top of the row that starts with `label`, in the window; null when not drawn. */
const rowTop = (page: Page, label: string) => page.evaluate((l) => {
  const row = [...document.querySelectorAll('[data-slot="transcript-row"]')].find((r) => r.textContent?.includes(l));
  return row ? row.getBoundingClientRect().top : null;
}, label);
const replies = (page: Page) => page.evaluate((reply) => [...document.querySelectorAll("p")].filter((p) => p.textContent === reply).length, REPLY);

/** A message from another client (not this page's send, which would take the
 *  reader to the end), and the answer streamed after it, landed. */
async function messageFromElsewhere(page: Page, text: string) {
  const before = await replies(page);
  const res = await page.request.post(`${server.baseUrl}/api/agents/threads/${threadId}/messages`, { data: { content: text, clientRequestId: `elsewhere-${text}` } });
  expect(res.ok()).toBe(true);
  await page.waitForFunction(([reply, n]) => [...document.querySelectorAll("p")].filter((p) => p.textContent === reply).length > (n as number), [REPLY, before] as const, { timeout: 30_000 });
}

test("a reader scrolled up stays on their row while messages land below; back at the end, the oldest go", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="transcript-column"]')?.parentElement;
      return !!el && el.scrollHeight > el.clientHeight + 40;
    });
    // Scrolling to the top loads older pages until the first message: 560
    // loaded, past the 500 the page keeps.
    for (let i = 0; i < 20 && (await rowTop(page, "MSG-000 ")) === null; i += 1) {
      const rows = await page.locator('[data-slot="transcript-row"]').count();
      await page.evaluate(`${SCROLLER}.scrollTop = 0`);
      await page.waitForFunction((n) => document.querySelectorAll('[data-slot="transcript-row"]').length > n, rows, { timeout: 8_000 });
    }
    expect(await rowTop(page, "MSG-000 ")).not.toBeNull();
    // The reader reads MSG-120, 200px down the view.
    await page.evaluate(`(() => { const s = ${SCROLLER}; const row = [...document.querySelectorAll('[data-slot="transcript-row"]')].find((r) => r.textContent.includes("MSG-120 ")); s.scrollTop += row.getBoundingClientRect().top - s.getBoundingClientRect().top - 200; })()`);
    const reading = (await rowTop(page, "MSG-120 "))!;
    for (const text of ["one", "two"]) {
      await messageFromElsewhere(page, text);
      expect({ text, moved: Math.round(((await rowTop(page, "MSG-120 ")) ?? Number.NaN) - reading) }).toEqual({ text, moved: 0 });
    }
    // Back at the end, the next message lets the oldest go.
    await page.getByRole("button", { name: "Scroll to latest message" }).click();
    await page.waitForFunction(`${SCROLLER}.scrollHeight - ${SCROLLER}.scrollTop - ${SCROLLER}.clientHeight <= 1`);
    await messageFromElsewhere(page, "three");
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-slot="transcript-row"]')].some((r) => r.textContent?.includes("MSG-000 ")));
    expect(await page.evaluate(`${SCROLLER}.scrollHeight - ${SCROLLER}.scrollTop - ${SCROLLER}.clientHeight`)).toBeLessThanOrEqual(1);
  } finally {
    await page.close();
  }
}, 120_000);
