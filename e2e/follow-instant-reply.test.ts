import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { seedManagerThread, startServer, type RunningServer } from "./helpers/server.js";
import { sseFrame } from "../tests/helpers/sse.js";

/**
 * A reader at the end of a long conversation stays there when a reply comes
 * all at once.
 *
 * The working line steps aside the moment the reply starts (it returns nothing
 * while the text moves), which makes the transcript a little shorter and the
 * browser pull scrollTop back with it. Nothing read the scroller then: the
 * list's growth key did not change, and no ResizeObserver reports a row that
 * is gone. When the reply's row landed a moment later, the list compared the
 * scroller with what it had read BEFORE the line went: scrollTop smaller, the
 * content taller, so "the reader scrolled up". It stopped following, 35px
 * short of the end, with Scroll to latest showing (found with the global
 * agent's stub turn).
 *
 * A model that takes time to write hides this: each piece of text is a read.
 * So the stub here answers in one piece, at once, and the timing is the
 * browser's own: only a real engine clamps scrollTop.
 */

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
let threadId = "";
const REPLY = "Noted, nothing else to do here.";

/** One whole answer in one stream, nothing held back. */
function answer(id: number): Response {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: REPLY, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: REPLY },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18, input_tokens_details: { cached_tokens: 0 } } } }
  ];
  return new Response(events.map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  let calls = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      await request.json();
      calls += 1;
      return answer(calls);
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
      threadId = seedManagerThread(dataDir, 60);
    }
  });
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

test("a reply that comes all at once leaves the reader at the end, still following", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  attachPageDiagnostics(page);
  const place = () => page.evaluate(() => {
    const el = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
    return { fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), overflows: el.scrollHeight > el.clientHeight + 40 };
  });
  const toLatest = page.getByRole("button", { name: "Scroll to latest message" });
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="transcript-column"]')?.parentElement;
      return !!el && el.scrollHeight > el.clientHeight + 40 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    });
    // Two turns: the second starts from a transcript that already ends in a reply's line.
    for (const text of ["Check the current state first", "Good, check once more"]) {
      const before = await page.getByText(REPLY).count();
      const box = page.getByPlaceholder("Message the manager…");
      await box.fill(text);
      await box.press("Enter");
      await page.waitForFunction(([reply, n]) => [...document.querySelectorAll("p")].filter((p) => p.textContent === reply).length > (n as number), [REPLY, before] as const, { timeout: 30_000 });
      // Past any frame that would still be catching up.
      await page.waitForTimeout(600);
      expect({ text, ...(await place()), toLatest: await toLatest.count() }).toEqual({ text, fromEnd: 0, overflows: true, toLatest: 0 });
    }
  } finally {
    await page.close();
  }
}, 90_000);
