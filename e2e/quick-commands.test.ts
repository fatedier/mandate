import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { artifactDir } from "./helpers/diagnostics.js";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { waitUntil } from "../tests/helpers/wait.js";

/**
 * A turn of quick commands, read at every frame. The working line used to
 * leave while each command ran and come back when it ended, so a reader at
 * the end of the chat saw everything drop by the line's height and rise
 * again, twice a command; and the run's line named a command only while it
 * ran, a frame or two, so the turn read "Ran N commands" and "Working…".
 * The model is a stub on a script; the commands are real.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
let threadId = "";
const shots = () => artifactDir("quick-commands");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const COMMANDS = [
  ["sleep 0.3; echo two", "List the old containers"],
  ["sleep 0.3; echo removed", "Remove the old containers"],
  ["sleep 0.3; df -h /", "Check disk space"],
  ["sleep 0.3; echo none", "Confirm nothing is left"]
] as const;

function stream(events: Array<{ wait: number; event: Record<string, unknown> }>): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of events) {
        if (step.wait) await sleep(step.wait);
        controller.enqueue(encoder.encode(sseFrame({ data: step.event })));
      }
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

/** One model step: a pause, then a bash call, its arguments in one delta. */
function callStep(id: string, pause: number, command: string, description: string): Response {
  const item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "bash", arguments: JSON.stringify({ command, description }), status: "completed" };
  return stream([
    { wait: pause, event: { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } } },
    { wait: 0, event: { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } } },
    { wait: 0, event: { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments } },
    { wait: 0, event: { type: "response.output_item.done", output_index: 0, item } },
    { wait: 0, event: { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } } }
  ]);
}

/** The last step: a pause, then the reply in one delta. */
function replyStep(id: string, pause: number, text: string): Response {
  const message = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return stream([
    { wait: pause, event: { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } } },
    { wait: 0, event: { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } } },
    { wait: 0, event: { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text } },
    { wait: 0, event: { type: "response.output_item.done", output_index: 0, item: message } },
    { wait: 0, event: { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [message], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } } }
  ]);
}

let modelCalls = 0;

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      modelCalls += 1;
      const id = String(modelCalls);
      const command = COMMANDS[modelCalls - 1];
      if (command) return callStep(id, 800, command[0], command[1]);
      return replyStep(id, 800, "Removed the old containers; nothing is left.");
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
        const agent = new AgentStore(store.db);
        threadId = agent.latestManagerThread("Container cleanup").id;
        // Enough of a conversation that the chat scrolls and the reader sits at its end.
        for (let i = 0; i < 10; i++) {
          const ask = agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: `Question ${i + 1}: what does the nightly job keep?` } });
          const wake = agent.createWake({ threadId, reason: "user", triggerMessageId: ask.id });
          agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "It keeps the last seven days of build cache and removes the rest, at night, so it never competes with a build." } });
          agent.finishWake(wake.id, "finished");
        }
      } finally {
        store.db.close();
      }
    }
  });
  // The model must be the stub: never let this test reach a real provider.
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== `http://127.0.0.1:${stub.port}/v1`) throw new Error(`the provider is not the stub: ${JSON.stringify(openai)}`);
});

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

interface Sample { t: number; askTop: number | null; run: string | null; working: boolean; replied: boolean }

test("quick commands: the chat holds still while they run, and the run's line names each one", async () => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.locator('[data-slot="transcript-row"]').last().waitFor();
    // At every frame: where the user's message sits in the scroller's view,
    // what the run's line says, and whether the working line is drawn.
    await page.evaluate(() => {
      const w = window as unknown as { __samples: Sample[] };
      w.__samples = [];
      const t0 = performance.now();
      const tick = () => {
        const scroller = document.querySelector<HTMLElement>('[data-slot="transcript-column"]')?.parentElement;
        const ask = [...document.querySelectorAll<HTMLElement>('[data-slot="transcript-row"]')].filter((row) => row.textContent?.includes("Clean up the old containers")).at(-1);
        const view = scroller?.getBoundingClientRect();
        w.__samples.push({
          t: Math.round(performance.now() - t0),
          askTop: ask && view ? Math.round((ask.getBoundingClientRect().top - view.top) * 10) / 10 : null,
          run: [...document.querySelectorAll('[data-slot="tool-run-line"]')].at(-1)?.textContent ?? null,
          working: document.querySelector('[data-slot="working-indicator"]') !== null,
          replied: document.body.textContent?.includes("nothing is left.") ?? false
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sent = await page.evaluate(async (id) => (await fetch(`/api/agents/threads/${id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Clean up the old containers" })
    })).status, threadId);
    expect(sent).toBe(202);
    await waitUntil(async () => (await page.locator('[data-slot="transcript-row"]').filter({ hasText: "nothing is left." }).count()) > 0, { timeout: 30_000, interval: 200, label: "the reply" });
    await page.locator('[data-slot="transcript-column"]').screenshot({ path: path.join(shots(), "after.png") });
    const samples = await page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples);
    fs.writeFileSync(path.join(shots(), "samples.json"), JSON.stringify(samples));

    // From the first frame the run is drawn to the last before the reply.
    const during = samples.filter((sample) => sample.run !== null && !sample.replied && sample.askTop !== null);
    expect(during.length).toBeGreaterThan(30);
    // Held still: the user's message stays put while the commands run, but
    // for a sub-pixel of rounding (it dropped by the working line's height,
    // 44px with the gap, as each began, and rose as each ended).
    const tops = during.map((sample) => sample.askTop!);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
    expect(during.every((sample) => sample.working)).toBe(true);
    // Each command stays named on the line once done, until the next one:
    // a line that named only the call under way showed a quick one for a
    // frame, and then "Ran N commands".
    for (const [, description] of COMMANDS) {
      expect(during.some((sample) => sample.run?.includes(`Ran${description}`))).toBe(true);
    }
    // The reply ends the run: its line is the tally.
    expect(await page.locator('[data-slot="tool-run-line"]').last().textContent()).toContain("Ran 4 commands");
  } finally {
    await context.close();
  }
}, 60_000);
