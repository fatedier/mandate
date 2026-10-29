import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { artifactDir } from "./helpers/diagnostics.js";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { trackRequests } from "./helpers/settle.js";

/**
 * A failed turn, through a real one: the model a stub that fails until told
 * not to. The failure is a line in the transcript where the turn stopped, it
 * survives a reload (it used to be a banner only the page that heard it live
 * could show), the thread's dot says it failed, and Retry runs the turn
 * again, after which the line stays as history without its button.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
let threadId = "";
let failing = true;
/** How the failing model fails: overloaded, unless a test refuses the request. */
const OVERLOADED = { status: 500, message: "upstream overloaded" };
let failWith = OVERLOADED;
let modelCalls = 0;
const shots = () => artifactDir("failed-turn");

function reply(text: string): Response {
  const message = { type: "message", id: "msg_ok", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_ok", created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: "resp_ok", status: "completed", output: [message], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } }
  ];
  return new Response(events.map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      modelCalls += 1;
      if (failing) {
        return new Response(JSON.stringify({ error: { message: failWith.message, code: String(failWith.status) } }), { status: failWith.status, headers: { "content-type": "application/json" } });
      }
      return reply("Release notes drafted: the two project-2 fixes lead.");
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
        threadId = new AgentStore(store.db).createManagerThread("project-1 3.21 release").id;
      } finally {
        store.db.close();
      }
    }
  });
  // The model must be the stub: never let this test reach a real provider.
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== `http://127.0.0.1:${stub.port}/v1`) {
    throw new Error(`the provider is not the stub: ${JSON.stringify(openai)}`);
  }
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

const line = (page: Page) => page.locator('[data-slot="wake-failure"]');
const dot = (page: Page) => page.locator(`[data-thread-title="project-1 3.21 release"] [role="img"]`);

test("a failed turn is a line where it stopped, survives a reload, and Retry runs it again", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  const requests = await trackRequests(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    // Live before the turn starts: the thread page drawn, what it loads in,
    // and the event stream's first state.
    await page.locator('[data-slot="composer"]').waitFor();
    await requests.idle();
    const sent = await page.evaluate(async (id) => {
      const response = await fetch(`/api/agents/threads/${id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Draft the release notes" })
      });
      return response.status;
    }, threadId);
    expect(sent).toBe(202);

    // Heard live: the line, under the message it answered, and the dot.
    await line(page).waitFor();
    expect(await line(page).textContent()).toContain("Failed");
    expect(await dot(page).getAttribute("aria-label")).toBe("state: failed or stopped");
    await page.screenshot({ path: path.join(shots(), "live.png") });

    // A reload, or the thread opened anywhere else: the same line, with Retry.
    await page.reload();
    await requests.idle();
    await line(page).waitFor();
    const retry = line(page).getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    const order = await page.evaluate(() => {
      const text = document.querySelector("main")!.textContent ?? "";
      return [text.indexOf("Draft the release notes"), text.indexOf("Failed")];
    });
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]!);
    expect(await dot(page).getAttribute("aria-label")).toBe("state: failed or stopped");
    await page.screenshot({ path: path.join(shots(), "after-reload.png") });

    // Retry, the model back: the reply comes, the line stays without its button.
    const callsBefore = modelCalls;
    failing = false;
    await retry.click();
    await page.getByText("Release notes drafted: the two project-2 fixes lead.").waitFor();
    expect(modelCalls).toBeGreaterThan(callsBefore);
    expect(await line(page).count()).toBe(1);
    expect(await line(page).getByRole("button").count()).toBe(0);
    // Its dot no longer says it failed (nor anything else that wants the user).
    await page.waitForFunction(() => !["state: failed or stopped", "state: needs you"].includes(document.querySelector('[data-thread-title="project-1 3.21 release"] [role="img"]')?.getAttribute("aria-label") ?? ""));
    // The user's message was not sent again.
    expect(await page.getByText("Draft the release notes", { exact: true }).count()).toBe(1);
    await page.screenshot({ path: path.join(shots(), "after-retry.png") });

    // And after a reload the history holds the failure, before the reply.
    await page.reload();
    await page.getByText("Release notes drafted: the two project-2 fixes lead.").waitFor();
    expect(await line(page).count()).toBe(1);
    const history = await page.evaluate(() => {
      const text = document.querySelector("main")!.textContent ?? "";
      return [text.indexOf("Failed"), text.indexOf("Release notes drafted")];
    });
    expect(history[1]).toBeGreaterThan(history[0]!);
  } finally {
    await page.close();
  }
}, 90_000);

test("on a phone the reason takes its own line and Retry stays in reach", async () => {
  failing = true;
  // A refused request: its reason (what to check) is longer than the phone's
  // line, so on the verb's line it would be cut.
  failWith = { status: 400, message: "the model named is not served here" };
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  const requests = await trackRequests(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    // Live before the turn starts: the thread page drawn, what it loads in,
    // and the event stream's first state.
    await page.locator('[data-slot="composer"]').waitFor();
    await requests.idle();
    await page.evaluate(async (id) => {
      await fetch(`/api/agents/threads/${id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Summarize the changelog" })
      });
    }, threadId);
    const newest = line(page).last();
    await newest.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await newest.scrollIntoViewIfNeeded();
    const seen = await newest.evaluate((el) => {
      const head = [...el.querySelectorAll(":scope > span")].find((span) => span.textContent === "Failed")!.getBoundingClientRect();
      const reason = el.querySelector<HTMLElement>(":scope > span[title]")!;
      const retry = el.querySelector("button")!;
      const box = retry.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const main = document.querySelector("main")!;
      return {
        // Under "Failed", on a line of its own.
        reasonBelow: reason.getBoundingClientRect().top >= head.bottom - 0.5,
        // Whole: it wraps there, and nothing of it is cut.
        reasonWhole: reason.scrollWidth <= reason.clientWidth + 1,
        // On the screen, and a tap there reaches it.
        retryOnScreen: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
        retryTakesTap: hit !== null && retry.contains(hit),
        mainFits: main.scrollWidth <= main.clientWidth + 1
      };
    });
    expect(seen).toEqual({ reasonBelow: true, reasonWhole: true, retryOnScreen: true, retryTakesTap: true, mainFits: true });
    await page.screenshot({ path: path.join(shots(), "phone.png") });
  } finally {
    failing = false;
    failWith = OVERLOADED;
    await page.close();
  }
}, 60_000);
