import { afterAll, beforeAll, expect, test } from "bun:test";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { settle, untilSteady } from "./helpers/settle.js";
import { seedManagerThread, startServer, type RunningServer } from "./helpers/server.js";
import { paced, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * A wheel turned mostly sideways while a reply streams stops following only
 * if the transcript moves up. Over a wide table it scrolls the table and
 * leaves the transcript where it is: the reply goes on being followed. Over
 * plain text a small move up is the reader's, under the 24px a scroll alone
 * needs: the reader stays where they went.
 *
 * Each reply streams a wide table, then waits for the test before the rest of
 * its text, so the wheel is turned over a still transcript and the growth
 * after it is the test's to start.
 */

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
let threadId = "";

const CELLS = Array.from({ length: 12 }, (_, i) => `column-${i + 1}-value`);
const TABLE = `| ${CELLS.join(" | ")} |\n|${CELLS.map(() => " --- ").join("|")}|\n| ${CELLS.join(" | ")} |`;
const TAIL = Array.from({ length: 40 }, (_, i) => ` word${i + 1}`);
const LAST = TAIL.at(-1)!.trim();

let gate: { promise: Promise<void>; open(): void } = held();
function held() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
/** The table, then (once the gate opens) the rest, a word every 10 ms. */
function reply(id: number, wait: Promise<void>): Response {
  const head = `Here it is.\n\n${TABLE}\n\nAnd the notes:`;
  const text = head + TAIL.join("");
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const delta = (piece: string) => ({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: piece });
  return paced([
    { event: { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } } },
    { event: { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } } },
    { event: delta(head) },
    ...TAIL.map((word, index) => (index === 0 ? { after: wait, event: delta(word) } : { wait: 10, event: delta(word) })),
    { wait: 10, event: { type: "response.output_item.done", output_index: 0, item } },
    { event: { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 60, total_tokens: 72, input_tokens_details: { cached_tokens: 0 } } } } }
  ]);
}

beforeAll(async () => {
  let calls = 0;
  stub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      await request.json();
      calls += 1;
      return reply(calls, gate.promise);
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port);
      threadId = seedManagerThread(dataDir, 60);
    }
  });
}, 60_000);

afterAll(() => {
  gate.open();
  server?.cleanup();
  stub?.stop(true);
});

const transcript = (page: import("playwright").Page) => page.evaluate(() => {
  const el = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
  return { top: Math.round(el.scrollTop), fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
});

/** Sends a message and waits until its reply's table is drawn, the transcript still at its end. */
async function startReply(page: import("playwright").Page, text: string, tables: number) {
  gate = held();
  const box = page.getByPlaceholder("Message the manager…");
  await box.fill(text);
  await box.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll('[data-slot="table-scroll"]').length >= n, tables, { timeout: 30_000 });
  // The transcript at rest, at its end.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
  }, undefined, { timeout: 10_000 });
  await settle(page);
  expect((await transcript(page)).fromEnd).toBeLessThanOrEqual(1);
}

/** Lets the rest of the reply come, and waits until it is all drawn: then
 *  until the transcript is at its end too when the reader is followed, or,
 *  when they are not, a while longer, for a move that should not come. */
async function finishReply(page: import("playwright").Page, replies: number, followed: boolean) {
  gate.open();
  await page.waitForFunction(([word, n]) => [...document.querySelectorAll("p")].filter((p) => p.textContent?.endsWith(word as string)).length >= (n as number), [LAST, replies] as const, { timeout: 30_000 });
  if (!followed) return page.waitForTimeout(600);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 0.5;
  }, undefined, { timeout: 10_000 });
  await settle(page);
}

test("a wheel turned sideways while a reply streams: over a wide table it is followed on, over text a small move up stays", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  attachPageDiagnostics(page);
  const toLatest = page.getByRole("button", { name: "Scroll to latest message" });
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="transcript-column"]')?.parentElement;
      return !!el && el.scrollHeight > el.clientHeight + 40 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    });

    // Across the table: it moves sideways, the transcript does not move up.
    await startReply(page, "Show me the table", 1);
    const table = page.locator('[data-slot="table-scroll"]').last();
    const box = (await table.boundingBox())!;
    const before = await transcript(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(120, -3);
    // A wheel scrolls smoothly: read once both have stopped moving.
    await untilSteady(async () => [await table.evaluate((el) => el.scrollLeft), (await transcript(page)).top]);
    expect(await table.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect((await transcript(page)).top).toBeGreaterThanOrEqual(before.top);
    expect(await toLatest.count()).toBe(0);
    // The rest of the reply: followed to its end.
    await finishReply(page, 1, true);
    expect({ fromEnd: (await transcript(page)).fromEnd, toLatest: await toLatest.count() }).toEqual({ fromEnd: 0, toLatest: 0 });

    // Over the reader's own message (no sideways scroller there): a small move up.
    await startReply(page, "Once more, please", 2);
    const mine = (await page.getByText("Once more, please").last().boundingBox())!;
    const at = await transcript(page);
    await page.mouse.move(mine.x + mine.width / 2, mine.y + mine.height / 2);
    await page.mouse.wheel(60, -20);
    const moved = at.top - (await untilSteady(() => transcript(page))).top;
    // The premise: above the end, under what a scroll alone needs to stop following.
    expect(moved).toBeGreaterThan(2);
    expect(moved).toBeLessThan(24);
    const left = await transcript(page);
    await finishReply(page, 2, false);
    const after = await transcript(page);
    expect({ top: after.top, offEnd: after.fromEnd > 2, toLatest: await toLatest.count() }).toEqual({ top: left.top, offEnd: true, toLatest: 1 });
  } finally {
    await page.close();
  }
}, 120_000);
