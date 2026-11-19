import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { trackRequests } from "./helpers/settle.js";
import { assertStubProvider, paced, type PacedEvent, seedStubProvider } from "./helpers/responses-stub.js";
import { look } from "./helpers/page-diagnostics.js";

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
let threadId = "";
let calls = 0;
const bodies: Array<Record<string, any>> = [];
/** A point the stub's stream waits at until the test has seen what came before it. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}
/** One per summary part: its words are all sent, then the stream waits until
 *  the test has seen the part's heading on the page. */
const seen = { gathering: gate(), checking: gate(), drafting: gate() };
/** The first step's command runs until the test has seen it running. */
let gateFile = "";

/** One response: reasoning summary parts streamed word by word, each held
 *  open at its end (see `seen`), then a call or a reply. */
function turn(id: string, parts: Array<{ text: string; seen: Promise<void> }>, out: { text: string } | { call: { name: string; args: Record<string, unknown> } }): Response {
  const rs = `rs_${id}`;
  const steps: PacedEvent[] = [
    { event: { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } } },
    { event: { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: rs, summary: [] } } }
  ];
  parts.forEach(({ text: part, seen }, index) => {
    steps.push({ event: { type: "response.reasoning_summary_part.added", item_id: rs, output_index: 0, summary_index: index, part: { type: "summary_text", text: "" } } });
    for (const word of part.split(/(?<= )/)) {
      steps.push({ event: { type: "response.reasoning_summary_text.delta", item_id: rs, output_index: 0, summary_index: index, delta: word } });
    }
    steps.push({ after: seen, event: { type: "response.reasoning_summary_part.done", item_id: rs, output_index: 0, summary_index: index, part: { type: "summary_text", text: part } } });
  });
  const reasoningItem = { type: "reasoning", id: rs, summary: parts.map(({ text }) => ({ type: "summary_text", text })) };
  steps.push({ event: { type: "response.output_item.done", output_index: 0, item: reasoningItem } });
  let item: Record<string, unknown>;
  if ("text" in out) {
    item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: out.text, annotations: [] }] };
    steps.push(
      { event: { type: "response.output_item.added", output_index: 1, item: { ...item, content: [] } } },
      ...out.text.split(/(?<= )/).map((delta) => ({ event: { type: "response.output_text.delta", item_id: item.id, output_index: 1, content_index: 0, delta } })),
      { event: { type: "response.output_item.done", output_index: 1, item } }
    );
  } else {
    item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: out.call.name, arguments: JSON.stringify(out.call.args), status: "completed" };
    steps.push(
      { event: { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } } },
      { event: { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 1, delta: item.arguments } },
      { event: { type: "response.output_item.done", output_index: 1, item } }
    );
  }
  steps.push({
    event: {
      type: "response.completed",
      response: {
        id: `resp_${id}`, status: "completed", output: [reasoningItem, item],
        usage: { input_tokens: 900, output_tokens: 240, total_tokens: 1140, output_tokens_details: { reasoning_tokens: 180 }, input_tokens_details: { cached_tokens: 0 } }
      }
    }
  });
  return paced(steps);
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
          { text: "**Gathering merged changes**\n\nI need what merged since 3.21. I'll read the recent history first, then group the changes by area so the notes read by what a user notices.", seen: seen.gathering.opened },
          { text: "**Checking the changelog format**\n\nThe 3.21 notes grouped entries under Workers, Improvements and Fixes, each with the PR number. I'll keep that shape.", seen: seen.checking.opened }
        ], { call: { name: "bash", args: { command: `while [ ! -e '${gateFile}' ]; do sleep 0.05; done; echo '#1 #2 #3 #4'`, description: "List the recent merges" } } });
      }
      return turn(String(calls), [
        { text: "**Drafting the notes so the project-2 photo import on big files leads the list and the two small fixes follow it**\n\nThree user-facing changes and two fixes. The project-2 photo import changes behaviour on big files, so it leads; the two fixes are small enough for one line each.", seen: seen.drafting.opened }
      ], { text: "Here is a draft of the 3.22 notes:\n\n**Workers**\n- Photo import on big files (#1)\n- Per-album size limits (#2)\n\n**Fixes**\n- Slideshow loop on Safari (#3)\n- Theme reload drops custom fonts (#4)" });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      gateFile = path.join(dataDir, "merges-listed");
      seedStubProvider(dataDir, stub.port);
      const store = new MandateStore(dataDir);
      try {
        threadId = new AgentStore(store.db).createManagerThread("project-1 3.22 release").id;
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
}, 60_000);

afterAll(() => {
  for (const part of Object.values(seen)) part.open();
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
    seen.gathering.open();
    await verb(page, "Checking the changelog format").waitFor();
    await look(page, "live-desktop");
    seen.checking.open();
    // The model was asked for it.
    expect(bodies[0]?.reasoning?.summary).toBe("auto");
    // The tool runs: the run's line names it, and the working line stays
    // (it used to step aside, and the chat moved by its height).
    await page.locator('[data-slot="tool-run-line"]', { hasText: "RunningList the recent merges" }).waitFor();
    expect(await page.locator('[data-slot="working-indicator"]').count()).toBe(1);
    fs.writeFileSync(gateFile, "");
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
    await look(phone, "live-phone");
    seen.drafting.open();

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
    await look(page, "done-desktop");
  } finally {
    await page.close();
    await phone.close();
  }
}, 120_000);
