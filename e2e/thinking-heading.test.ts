import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { artifactDir } from "./helpers/diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { trackRequests } from "./helpers/settle.js";

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
let threadId = "";
let calls = 0;
const bodies: Array<Record<string, any>> = [];
const shots = () => artifactDir("thinking-heading");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Step = { wait: number; event: Record<string, unknown> };

function stream(steps: Step[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of steps) {
        if (step.wait) await sleep(step.wait);
        controller.enqueue(encoder.encode(sseFrame({ data: step.event })));
      }
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

/** One response: reasoning summary parts streamed word by word, then a call or a reply. */
function turn(id: string, parts: string[], out: { text: string } | { call: { name: string; args: Record<string, unknown> } }): Response {
  const rs = `rs_${id}`;
  const steps: Step[] = [
    { wait: 150, event: { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } } },
    { wait: 0, event: { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: rs, summary: [] } } }
  ];
  parts.forEach((part, index) => {
    steps.push({ wait: 0, event: { type: "response.reasoning_summary_part.added", item_id: rs, output_index: 0, summary_index: index, part: { type: "summary_text", text: "" } } });
    for (const word of part.split(/(?<= )/)) {
      steps.push({ wait: 30, event: { type: "response.reasoning_summary_text.delta", item_id: rs, output_index: 0, summary_index: index, delta: word } });
    }
    steps.push({ wait: 0, event: { type: "response.reasoning_summary_part.done", item_id: rs, output_index: 0, summary_index: index, part: { type: "summary_text", text: part } } });
  });
  const reasoningItem = { type: "reasoning", id: rs, summary: parts.map((text) => ({ type: "summary_text", text })) };
  steps.push({ wait: 0, event: { type: "response.output_item.done", output_index: 0, item: reasoningItem } });
  let item: Record<string, unknown>;
  if ("text" in out) {
    item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: out.text, annotations: [] }] };
    steps.push(
      { wait: 0, event: { type: "response.output_item.added", output_index: 1, item: { ...item, content: [] } } },
      ...out.text.split(/(?<= )/).map((delta) => ({ wait: 40, event: { type: "response.output_text.delta", item_id: item.id, output_index: 1, content_index: 0, delta } })),
      { wait: 0, event: { type: "response.output_item.done", output_index: 1, item } }
    );
  } else {
    item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: out.call.name, arguments: JSON.stringify(out.call.args), status: "completed" };
    steps.push(
      { wait: 0, event: { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } } },
      { wait: 0, event: { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 1, delta: item.arguments } },
      { wait: 0, event: { type: "response.output_item.done", output_index: 1, item } }
    );
  }
  steps.push({
    wait: 0,
    event: {
      type: "response.completed",
      response: {
        id: `resp_${id}`, status: "completed", output: [reasoningItem, item],
        usage: { input_tokens: 900, output_tokens: 240, total_tokens: 1140, output_tokens_details: { reasoning_tokens: 180 }, input_tokens_details: { cached_tokens: 0 } }
      }
    }
  });
  return stream(steps);
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      bodies.push(await request.json() as Record<string, any>);
      calls += 1;
      if (calls === 1) {
        return turn("1", [
          "**Gathering merged changes**\n\nI need what merged since 3.21. I'll read the recent history first, then group the changes by area so the notes read by what a user notices.",
          "**Checking the changelog format**\n\nThe 3.21 notes grouped entries under Features, Improvements and Fixes, each with the PR number. I'll keep that shape."
        ], { call: { name: "bash", args: { command: "sleep 1.5; echo '#33 #81 #103 #119'", description: "List the recent merges" } } });
      }
      return turn(String(calls), [
        "**Drafting the notes so the project-2 cache expiry on reconnect leads the list and the two small fixes follow it**\n\nThree user-facing changes and two fixes. The project-2 cache expiry changes behaviour on reconnect, so it leads; the two fixes are small enough for one line each."
      ], { text: "Here is a draft of the 3.22 notes:\n\n**Features**\n- Cache expiry on reload (#33)\n- Per-page size limits (#81)\n\n**Fixes**\n- Settings reload loop on Safari (#103)\n- Theme reload drops custom fonts (#119)" });
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
        threadId = new AgentStore(store.db).createManagerThread("project-1 3.22 release").id;
      } finally {
        store.db.close();
      }
    }
  });
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== `http://127.0.0.1:${stub.port}/v1`) throw new Error("the provider is not the stub");
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

/**
 * Thinking summaries, through a real turn: the model a stub that streams
 * OpenAI Responses reasoning summaries.
 * The working line names the heading the summary has reached; the transcript
 * stays as it was — the summary is kept with the step, never shown or sent.
 */
test("the working line names what it is thinking about; the transcript stays as it was", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const loads = await Promise.all([page, phone].map((on) => trackRequests(on)));
  page.setDefaultTimeout(30_000);
  phone.setDefaultTimeout(30_000);
  const verb = (on: typeof page, text: string) => on.locator('[data-slot="working-verb"]', { hasText: text });
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await phone.goto(`${server.baseUrl}/threads/${threadId}`);
    // Live before the turn starts: each thread page drawn, what it loads in,
    // and the event stream's first state.
    for (const [i, on] of [page, phone].entries()) {
      await on.locator('[data-slot="composer"]').waitFor();
      await loads[i]!.idle();
    }
    const sent = await fetch(`${server.baseUrl}/api/agents/threads/${threadId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Draft the 3.22 release notes from what merged." })
    });
    expect(sent.status).toBe(202);
    // Live: each heading as the summary reaches it.
    await verb(page, "Gathering merged changes").waitFor();
    await verb(page, "Checking the changelog format").waitFor();
    await page.screenshot({ path: path.join(shots(), "live-desktop.png") });
    // The model was asked for it.
    expect(bodies[0]?.reasoning?.summary).toBe("auto");
    // The tool runs: the run's line names it, and the working line stays
    // (it used to step aside, and the chat moved by its height).
    await page.locator('[data-slot="tool-run-line"]', { hasText: "RunningList the recent merges" }).waitFor();
    expect(await page.locator('[data-slot="working-indicator"]').count()).toBe(1);
    // The next step's heading — long enough that a phone cuts it, not the row.
    await verb(phone, "Drafting the notes").waitFor();
    const fits = await phone.evaluate(() => {
      const verbEl = document.querySelector('[data-slot="working-verb"]') as HTMLElement;
      const clock = document.querySelector('[data-slot="working-clock"]') as HTMLElement;
      const main = document.querySelector("main")!;
      return {
        cut: verbEl.scrollWidth > verbEl.clientWidth,
        clockInside: clock.getBoundingClientRect().right <= main.getBoundingClientRect().right,
        noOverflow: main.scrollWidth <= main.clientWidth + 1
      };
    });
    expect(fits).toEqual({ cut: true, clockInside: true, noOverflow: true });
    await phone.screenshot({ path: path.join(shots(), "live-phone.png") });

    await page.getByText("Theme reload drops custom fonts").waitFor();
    await page.locator('[data-slot="working-indicator"]').waitFor({ state: "detached" });
    // The summary itself is nowhere on the page, then or after a reload.
    for (const at of [page, phone]) {
      await at.getByText("Theme reload drops custom fonts").waitFor();
      expect(await at.locator("main").textContent()).not.toContain("I need what merged since 3.21");
    }
    await page.reload();
    await page.getByText("Theme reload drops custom fonts").waitFor();
    expect(await page.locator("main").textContent()).not.toContain("I need what merged since 3.21");
    expect(await page.locator("main").textContent()).not.toContain("Gathering merged changes");
    await page.screenshot({ path: path.join(shots(), "done-desktop.png") });
  } finally {
    await page.close();
    await phone.close();
  }
}, 120_000);
