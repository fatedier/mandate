import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { artifactDir } from "./helpers/diagnostics.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { settle, trackRequests } from "./helpers/settle.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { parseFetchText, parseSearchText, WEB_TEXT_SENTENCE } from "../src/shared/web-tool-text.js";
import { sseFrame } from "../tests/helpers/sse.js";

/**
 * A manager turn that searches the web and reads a page, end to end: the
 * model is a stub speaking the Responses stream, the search backend a stub
 * SearXNG instance, the page a stub site, all on loopback. What the model was
 * given (the markers, who found the results, the page's fields) is read from
 * the stub's requests; what the person sees, from the chat on a desktop and
 * on a phone. happy-dom has no server, no fetch and no layout: here they are.
 */

let server: RunningServer;
const browser = browserForFile();
let model: ReturnType<typeof Bun.serve>;
let searx: ReturnType<typeof Bun.serve>;
let site: ReturnType<typeof Bun.serve>;
const shots = () => artifactDir("web-tools");

const MANAGER_PROMPT = "You are the **Manager** for Mandate.";
const WORD = "web-tools-case";
const QUERY = "kettle boiling point";
const DONE = "Done.";
let threadId = "";
/** The function call outputs the model was sent, by the step that made the call. */
const outputs: Record<string, string> = {};
const stray: string[] = [];

// Written for this test; no real site's page. Long enough to read as an
// article to Defuddle.
const ARTICLE = `<!doctype html><html><head><title>Kettle Notes</title>
<meta name="author" content="Ada Lane"></head><body><nav><a href="/">Home</a> · <a href="/shop">Shop</a></nav>
<article><h1>Kettle Notes</h1><p>Water boils at 100 degrees at sea level, and a little lower on a mountain, where the air presses on it less.</p>
<p>A kettle switches itself off when the steam reaches a small strip of metal that bends as it warms and breaks the circuit.</p>
<pre><code>kettle --boil --until 100</code></pre>
<p>Scale builds up on the element where the water is hard. Boil a mix of water and vinegar once a month, pour it away, and boil fresh water twice before you make tea again.</p>
<p>Fill it only as far as you need: heating water you then pour away costs time and power, and the kettle boils faster with less in it.</p></article>
<footer>Kettle Notes</footer></body></html>`;

/** One model response: text, or a function call whose id names its step. */
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
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`, status: "completed", output: [item],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } }
      }
    }
  ];
  return new Response(events.map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** Every string in a value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** The newest known thing in the request decides the stub's answer: the
 *  search's output asks for the page, the page's for the last word, the
 *  user's message for the search. */
function step(body: Record<string, any>): Response {
  const items = (body.input ?? []) as Array<Record<string, any>>;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "function_call_output") {
      const call = String(item.call_id ?? "");
      const output = strings(item.output).join("\n");
      if (call.endsWith("-search")) {
        outputs.search = output;
        return respond(`${WORD}-fetch`, { call: { name: "web_fetch", args: { url: `http://127.0.0.1:${site.port}/kettle` } } });
      }
      if (call.endsWith("-fetch")) {
        outputs.fetch = output;
        return respond(`${WORD}-done`, { text: DONE });
      }
      continue;
    }
    if (item.role !== "user") continue;
    if (strings(item.content).join("\n").includes("Look this up")) {
      return respond(`${WORD}-search`, { call: { name: "web_search", args: { query: QUERY } } });
    }
  }
  stray.push(JSON.stringify(items.slice(-2)).slice(0, 300));
  return respond(`stray${stray.length}`, { text: "ok" });
}

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, any>;
      const text = strings(body.instructions ?? "").concat(strings(body.input ?? [])).join("\n");
      if (!text.includes(WORD) || !text.includes(MANAGER_PROMPT)) {
        stray.push(text.slice(0, 300));
        return respond(`stray${stray.length}`, { text: "ok" });
      }
      return step(body);
    }
  });
  site = Bun.serve({
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/kettle"
        ? new Response(ARTICLE, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("not here", { status: 404 });
    }
  });
  searx = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/search" || url.searchParams.get("format") !== "json") return new Response("no", { status: 403 });
      return Response.json({
        query: url.searchParams.get("q"),
        results: [
          { title: "Kettle Notes", url: `http://127.0.0.1:${site.port}/kettle`, content: "Water boils at 100 degrees at sea level." },
          { title: "Descaling a kettle", url: `http://127.0.0.1:${site.port}/descale`, content: "Vinegar and water, once a month." }
        ]
      });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.models.providers.openai.type = "openai-compatible";
      config.models.providers.openai.baseURL = `http://127.0.0.1:${model.port}/v1`;
      config.webSearch = { use: "searxng", kinds: { searxng: { address: `http://127.0.0.1:${searx.port}` } } };
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        threadId = new AgentStore(store.db).latestManagerThread("Kettle questions").id;
      } finally {
        store.db.close();
      }
    }
  });
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const config = settings.config ?? settings;
  if (config.models?.providers?.openai?.baseURL !== `http://127.0.0.1:${model.port}/v1` || config.webSearch?.use !== "searxng") {
    throw new Error(`not set up for the stubs: ${JSON.stringify({ openai: config.models?.providers?.openai, webSearch: config.webSearch })}`);
  }
}, 60_000);

afterAll(() => {
  try {
    fs.writeFileSync(path.join(shots(), "requests.json"), JSON.stringify({ outputs, stray }, null, 2));
  } finally {
    server?.cleanup();
    model?.stop(true);
    searx?.stop(true);
    site?.stop(true);
  }
});

/** Each call row's phrase and note, as drawn, and whether they sit on one line. */
function callRows(page: Page, scope: string) {
  return page.evaluate((root) => [...document.querySelectorAll(`${root} [data-slot="tool-call"]`)].map((row) => {
    const part = (slot: string) => row.querySelector(`[data-slot="${slot}"]`);
    const parts = ["tool-lead", "tool-detail", "tool-call-note"].map(part).filter((el): el is Element => el !== null && el.getClientRects().length > 0);
    const tops = parts.map((el) => el.getBoundingClientRect().top);
    return {
      lead: part("tool-lead")?.textContent ?? null,
      detail: part("tool-detail")?.textContent ?? null,
      note: part("tool-call-note")?.textContent ?? null,
      oneLine: parts.length === 3 && Math.max(...tops) - Math.min(...tops) < 4
    };
  }), scope);
}

const NOTE_CHARS = /^· [\d,]+ chars$/;

test("desktop: the manager searches, reads the first page, and both calls read as what they found", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  try {
    const page = await context.newPage();
    const errors = trackPageErrors(page);
    const shot = (name: string) => page.screenshot({ path: path.join(shots(), `desktop-${name}.png`) });
    const requests = await trackRequests(page);
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    // Live before the turn starts: the thread page drawn, what it loads in,
    // and the event stream's first state.
    await page.locator('[data-slot="composer"]').waitFor();
    await requests.idle();
    expect(await page.evaluate(async ({ id, body }) => (await fetch(`/api/agents/threads/${id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: body })
    })).status, { id: threadId, body: `${WORD}: Look this up.` })).toBe(202);
    await page.getByText(DONE, { exact: true }).first().waitFor({ timeout: 30_000 });

    // What the model was given: the results between the markers, who found
    // them; the page's fields after the sentence. Read back with the chat's
    // parsers, which take only the formatter's text, markers matching.
    expect(outputs.search).toContain('<<<WEB_TEXT id="');
    const search = parseSearchText(outputs.search ?? "");
    expect(search === null || search === "nothing" ? search : [search.backend, search.results.map((r) => [r.title, r.url])]).toEqual([
      `SearXNG · 127.0.0.1:${searx.port}`,
      [["Kettle Notes", `http://127.0.0.1:${site.port}/kettle`], ["Descaling a kettle", `http://127.0.0.1:${site.port}/descale`]]
    ]);
    expect(outputs.fetch).toContain(WEB_TEXT_SENTENCE);
    const fetched = parseFetchText(outputs.fetch ?? "");
    expect([fetched?.title, fetched?.author, fetched?.finalUrl]).toEqual(["Kettle Notes", "Ada Lane", `http://127.0.0.1:${site.port}/kettle`]);
    expect(stray.filter((s) => s.includes(WORD))).toEqual([]);

    // The two calls are one run; opened, each says what it found.
    const line = page.locator('[data-slot="tool-run-line"]').last();
    await line.click();
    await page.locator('[data-slot="tool-call"]').nth(1).waitFor();
    const rows = await callRows(page, '[data-slot="tool-run-calls"]');
    expect(rows.map((r) => [r.lead, r.detail, r.oneLine])).toEqual([
      ["Searched the web for", QUERY, true],
      ["Fetched", `127.0.0.1:${site.port}/kettle`, true]
    ]);
    expect(rows[0]!.note).toBe("· 2 results");
    expect(rows[1]!.note).toMatch(NOTE_CHARS);
    await shot("1-calls");

    await page.locator('[data-slot="tool-call"]').first().click();
    const results = page.locator('[data-slot="web-search-results"] a');
    await results.first().waitFor();
    expect(await results.evaluateAll((links) => links.map((a) => [a.textContent, a.getAttribute("href")]))).toEqual([
      ["Kettle Notes", `http://127.0.0.1:${site.port}/kettle`],
      ["Descaling a kettle", `http://127.0.0.1:${site.port}/descale`]
    ]);
    expect(await page.locator('[data-slot="web-search-found-by"]').textContent()).toMatch(new RegExp(`^Found by SearXNG · 127\\.0\\.0\\.1:${searx.port} in \\d+\\.\\d s$`));
    await page.locator('[data-slot="tool-call"]').nth(1).click();
    const pageFields = page.locator('[data-slot="web-fetch-page"]');
    await pageFields.waitFor();
    // The page names no site: the author is not given again as one.
    expect(await pageFields.locator("dt").allTextContents()).toEqual(["Title", "Author", "Address", "Shown"]);
    expect(await pageFields.locator("dd").first().textContent()).toBe("Kettle Notes");
    await settle(page);
    await shot("2-details");
    expect(await page.locator("body").textContent()).not.toContain("WEB_TEXT");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);

test("phone: the same calls in the sheet, each on one line, and nothing wider than the screen", async () => {
  expect(outputs.fetch).toBeDefined();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const errors = trackPageErrors(page);
    const shot = (name: string) => page.screenshot({ path: path.join(shots(), `phone-${name}.png`) });
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.getByText(DONE, { exact: true }).first().waitFor({ timeout: 20_000 });
    await page.locator('[data-slot="tool-run-line"]').last().click();
    const sheet = '[role="dialog"]';
    await page.locator(`${sheet} [data-slot="tool-call"]`).nth(1).waitFor();
    await settle(page);
    const rows = await callRows(page, sheet);
    expect(rows.map((r) => [r.lead, r.detail, r.oneLine])).toEqual([
      ["Searched the web for", QUERY, true],
      ["Fetched", `127.0.0.1:${site.port}/kettle`, true]
    ]);
    expect(rows[0]!.note).toBe("· 2 results");
    expect(rows[1]!.note).toMatch(NOTE_CHARS);
    expect(await pageOverflow(page)).toEqual([]);
    await shot("1-sheet");
    await page.locator(`${sheet} [data-slot="tool-call"]`).first().click();
    await page.locator(`${sheet} [data-slot="web-search-results"] a`).first().waitFor();
    expect(await page.locator(`${sheet} [data-slot="tool-sheet-status"]`).textContent()).toContain("2 results");
    expect(await page.locator(`${sheet} [data-slot="web-search-results"] a`).count()).toBe(2);
    expect(await pageOverflow(page)).toEqual([]);
    await shot("2-search");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);
