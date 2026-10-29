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

/**
 * The thread's model in the composer: named in the toolbar, switched from
 * its menu (a sheet on a phone), and, while a turn runs, the model that
 * turn calls now — a fallback's after the primary failed.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
const seeded = { desk: "", fallback: "", phone: "" };
/** The model each case's requests asked for, by provider path. */
const asked = new Map<string, string[]>();
let releaseBackup: () => void = () => {};

function respond(id: string, text: string): Response {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } } } }
  ];
  return new Response(events.map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

const shown = (body: Record<string, any>) => JSON.stringify(body.input ?? []);

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const provider = url.pathname.startsWith("/backup/") ? "backup" : "primary";
      const body = await request.json() as Record<string, any>;
      const text = shown(body);
      const note = (name: string) => {
        const list = asked.get(name) ?? [];
        list.push(`${provider}/${String(body.model)}`);
        asked.set(name, list);
        return `${name}${list.length}`;
      };
      if (text.includes("desk-case")) return respond(note("desk"), "Done on the model you chose.");
      if (text.includes("phone-case")) return respond(note("phone"), "Done.");
      if (text.includes("fallback-case")) {
        const id = note("fallback");
        // The primary is down (an outage moves on to the fallback; a refused
        // request does not); the fallback answers once the test lets it.
        if (provider === "primary") return new Response(JSON.stringify({ error: { message: "service unavailable", type: "server_error" } }), { status: 503, headers: { "content-type": "application/json" } });
        await new Promise<void>((resolve) => {
          releaseBackup = resolve;
          request.signal.addEventListener("abort", () => resolve());
        });
        return respond(id, "Answered by the fallback.");
      }
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${text.slice(0, 200)}` } }), { status: 500, headers: { "content-type": "application/json" } });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.models.providers.openai = {
        type: "openai-compatible", apiKey: "not-a-real-key", baseURL: `http://127.0.0.1:${stub.port}/primary/v1`,
        models: [{ id: "gpt-5.5", input: ["text"], supportsReasoning: true }, { id: "gpt-5.5-mini", input: ["text"], supportsReasoning: true }]
      };
      config.models.providers.backup = {
        type: "openai-compatible", apiKey: "not-a-real-key", baseURL: `http://127.0.0.1:${stub.port}/backup/v1`,
        models: [{ id: "gpt-5.5", input: ["text"], supportsReasoning: true }]
      };
      config.agent = {
        ...config.agent,
        managerModel: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
        managerModelFallbacks: [{ model: "backup/gpt-5.5", reasoningEffort: "provider-default" }]
      };
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        seeded.desk = agents.createManagerThread("Switch probe").id;
        seeded.fallback = agents.createManagerThread("Fallback probe").id;
        seeded.phone = agents.createManagerThread("Phone probe").id;
      } finally {
        store.db.close();
      }
    }
  });
  // The models must be the stub: never let this test reach a real provider.
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const providers = (settings.config ?? settings).models?.providers ?? {};
  if (!String(providers.openai?.baseURL).startsWith(`http://127.0.0.1:${stub.port}/`) || !String(providers.backup?.baseURL).startsWith(`http://127.0.0.1:${stub.port}/`)) {
    throw new Error(`the providers are not the stub: ${JSON.stringify(providers)}`);
  }
}, 60_000);

afterAll(() => {
  releaseBackup();
  server?.cleanup();
  stub?.stop(true);
});

async function open(threadId: string, phone = false): Promise<Page> {
  const page = await browser.newPage(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}/threads/${threadId}`);
  // Drawn once the thread's model has come.
  await page.locator('[data-slot="thread-model-name"]').waitFor();
  return page;
}

const modelName = (page: Page) => page.locator('[data-slot="thread-model-name"]');
const say = async (threadId: string, content: string) => {
  const response = await fetch(`${server.baseUrl}/api/agents/threads/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  expect(response.status).toBe(202);
};
const pickOf = async (threadId: string) => ((await (await fetch(`${server.baseUrl}/api/agents/threads/${threadId}/model`)).json()) as { model: { override: { ref: string } | null } }).model.override?.ref ?? null;
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("the composer names the thread's model; the menu switches it, the next turn runs on it, and Default takes it back", async () => {
  const page = await open(seeded.desk);
  try {
    // Awaited first: Bun's matcher pumps the event loop (helpers/browser.ts).
    expect(await modelName(page).textContent()).toBe("gpt-5.5");
    await page.locator('[data-slot="thread-model"]').click();
    const items = page.locator('[role="menuitemradio"]');
    expect(await items.allTextContents()).toEqual(["Defaultgpt-5.5", "gpt-5.5", "gpt-5.5-mini", "gpt-5.5"]);
    await items.filter({ hasText: "gpt-5.5-mini" }).click();
    await page.locator('[data-slot="thread-model-name"]', { hasText: "gpt-5.5-mini" }).waitFor();
    expect(await pickOf(seeded.desk)).toBe("openai/gpt-5.5-mini");
    await say(seeded.desk, "desk-case: write the summary");
    await until(() => (asked.get("desk") ?? []).length > 0, "the turn's request");
    expect(asked.get("desk")).toEqual(["primary/gpt-5.5-mini"]);
    await page.locator('[data-slot="thread-model"]').click();
    await page.locator('[role="menuitemradio"]').first().click();
    await page.locator('[data-slot="thread-model-name"]', { hasText: /^gpt-5\.5$/ }).waitFor();
    expect(await pickOf(seeded.desk)).toBeNull();
  } finally {
    await page.close();
  }
}, 60_000);

test("while a turn runs on its fallback, the composer names the fallback, with its provider; then the thread's own again", async () => {
  const page = await open(seeded.fallback);
  try {
    // Awaited first: Bun's matcher pumps the event loop (helpers/browser.ts).
    expect(await modelName(page).textContent()).toBe("gpt-5.5");
    await say(seeded.fallback, "fallback-case: look at the logs");
    await page.locator('[data-slot="thread-model-name"]', { hasText: "gpt-5.5 · backup" }).waitFor();
    // A page opened now reads it with the running turn.
    const late = await open(seeded.fallback);
    try {
      await late.locator('[data-slot="thread-model-name"]', { hasText: "gpt-5.5 · backup" }).waitFor();
    } finally {
      await late.close();
    }
    releaseBackup();
    await page.locator('[data-slot="thread-model-name"]', { hasText: /^gpt-5\.5$/ }).waitFor();
    expect(asked.get("fallback")?.at(-1)).toBe("backup/gpt-5.5");
  } finally {
    await page.close();
  }
}, 60_000);

test("on a phone the name opens a sheet of the choices; a pick is named and the sheet gives focus back", async () => {
  const page = await open(seeded.phone, true);
  try {
    await modelName(page).waitFor();
    const button = page.locator('[data-slot="thread-model"]');
    // Its touch area reaches 22px above and below its middle (hit), without
    // making the composer taller.
    const reach = await button.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      return [box.height, ...[y - 21, y + 21].map((at) => el.contains(document.elementFromPoint(x, at)))];
    });
    expect(reach).toEqual([28, true, true]);
    await button.tap();
    const rows = page.locator('[role="menuitemradio"]');
    await rows.first().waitFor();
    expect(await rows.allTextContents()).toEqual(["✓Defaultgpt-5.5", "gpt-5.5", "gpt-5.5-mini", "gpt-5.5"]);
    await rows.filter({ hasText: "gpt-5.5-mini" }).tap();
    await page.locator('[data-slot="thread-model-name"]', { hasText: "gpt-5.5-mini" }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-slot") === "thread-model");
    expect(await pickOf(seeded.phone)).toBe("openai/gpt-5.5-mini");
  } finally {
    await page.close();
  }
}, 60_000);
