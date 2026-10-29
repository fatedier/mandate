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
import { waitUntil } from "../tests/helpers/wait.js";
import { trackRequests } from "./helpers/settle.js";

/**
 * The chat's working line through one real turn: the model a stub that speaks
 * the Responses stream on a script (think, write, call bash, think, answer),
 * the bash call real. happy-dom has no clock, no animation and no server, so
 * this is where the line is seen to name each phase, to stay, counting the
 * turn's time, while the command runs (the run's line names the command and
 * keeps no clock of its own), and to come back with its clock after a reload
 * mid-turn.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
let threadId = "";
const shots = () => artifactDir("working-indicator");

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

/** One model turn: a pause, some text a piece at a time, then maybe a call. */
function turn(id: string, pause: number, pieces: string[], call?: { name: string; args: Record<string, unknown> }): Response {
  const text = pieces.join("");
  const message = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const output: Array<Record<string, unknown>> = [message];
  const steps: Step[] = [
    { wait: pause, event: { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } } },
    { wait: 0, event: { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } } },
    ...pieces.map((delta) => ({ wait: 300, event: { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta } })),
    { wait: 0, event: { type: "response.output_item.done", output_index: 0, item: message } }
  ];
  if (call) {
    const item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: call.name, arguments: JSON.stringify(call.args), status: "completed" };
    output.push(item);
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
      response: { id: `resp_${id}`, status: "completed", output, usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } }
    }
  });
  return stream(steps);
}

let modelCalls = 0;

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      modelCalls += 1;
      if (modelCalls === 1) {
        return turn("1", 1500, ["I'll run ", "the unit ", "tests first."], {
          name: "bash", args: { command: "sleep 3", description: "Run the unit tests" }
        });
      }
      if (modelCalls === 2) return turn("2", 1500, ["All tests ", "pass."]);
      return turn(String(modelCalls), 0, ["ok"]);
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      // A compatible gateway, as the stub is one.
      config.models.providers.openai.type = "openai-compatible";
      config.models.providers.openai.baseURL = `http://127.0.0.1:${stub.port}/v1`;
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        threadId = agent.latestManagerThread("Run the tests").id;
      } finally {
        store.db.close();
      }
    }
  });
  // The model must be the stub: never let this test reach a real provider.
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  fs.writeFileSync(path.join(shots(), "settings.json"), JSON.stringify(settings, null, 2));
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== `http://127.0.0.1:${stub.port}/v1`) {
    throw new Error(`the provider is not the stub: ${JSON.stringify(openai)}`);
  }
});

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

type Phase = "Working" | "writing" | "running" | "done" | "none";

/** One snapshot of the page: its phase, the working line's clock, and
 *  whether the line shows — read together, so a phase and the line are
 *  never from two moments either side of a change. */
async function phaseOf(page: Page): Promise<{ phase: Phase; clock: string | null; withLine: boolean; runClock: boolean }> {
  return page.evaluate(() => {
    // The line as the reader sees it: set aside while the reply moves, it
    // keeps its place but shows nothing.
    const line = document.querySelector('[data-slot="working-indicator"]:not([data-state="aside"])');
    const verb = line?.querySelector('[data-slot="working-verb"]')?.textContent ?? "";
    const clock = line?.querySelector('[data-slot="working-clock"]')?.textContent ?? null;
    const running = [...document.querySelectorAll('[data-slot="tool-run-line"]')].some((run) => run.textContent?.includes("Running"));
    const streaming = document.querySelector('[data-slot="streaming-reply"]');
    const withLine = line !== null;
    // Read in the same snapshot as "running": a command that finishes between
    // two reads shows its own duration, which is no second clock.
    const runClock = document.querySelector('[data-slot="tool-run-line"] [data-slot="tool-run-duration"]') !== null;
    if (running) return { phase: "running" as const, clock, withLine, runClock };
    if (verb.startsWith("Working")) return { phase: "Working" as const, clock, withLine, runClock };
    // A live reply with no working line under it: the line stepped aside.
    if (streaming && !line) return { phase: "writing" as const, clock, withLine, runClock };
    // Done once the final reply is in and nothing is streaming or working.
    if (!streaming && !line && document.body.textContent?.includes("All tests pass.")) return { phase: "done" as const, clock, withLine, runClock };
    return { phase: "none" as const, clock, withLine, runClock };
  });
}

const seconds = (clock: string | null) => {
  const match = clock?.match(/^(?:(\d+)m )?(\d+)s$/);
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : Number.NaN;
};

test("the working line names each phase of a real turn, steps aside for the reply, stays through the command, and survives a reload", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  attachPageDiagnostics(page);
  const requests = await trackRequests(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    // Live before the turn starts: the thread page drawn, what it loads in,
    // and the event stream's first state.
    await page.locator('[data-slot="composer"]').waitFor();
    await requests.idle();
    const sentAt = Date.now();
    const sent = await page.evaluate(async (id) => {
      const response = await fetch(`/api/agents/threads/${id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Run the tests" })
      });
      return response.status;
    }, threadId);
    expect(sent).toBe(202);

    const seen: Phase[] = [];
    const clocks: Record<string, string | null> = {};
    let reloaded = false;
    let reloadedAt = 0;
    let clockAfterReload: string | null = null;
    let clockReadAt = 0;
    let runningWithLine = false;
    let runLineClock = false;
    const turnClocks: number[] = [];
    await waitUntil(async () => {
      const { phase, clock, withLine, runClock } = await phaseOf(page);
      if (phase === "running") {
        if (withLine) runningWithLine = true;
        if (runClock) runLineClock = true;
        turnClocks.push(seconds(clock));
      }
      if (phase !== "none" && seen.at(-1) !== phase) {
        seen.push(phase);
        clocks[`${seen.length}-${phase}`] = clock;
        await page.locator('[data-slot="transcript-column"]').screenshot({ path: path.join(shots(), `${seen.length}-${phase}${reloaded ? "-after-reload" : ""}.png`) });
      }
      if (phase === "running" && !reloaded) {
        reloaded = true;
        reloadedAt = Date.now();
        await page.reload();
        return false;
      }
      if (reloaded && clock !== null && clockAfterReload === null) {
        clockAfterReload = clock;
        clockReadAt = Date.now();
      }
      return phase === "done";
    }, { timeout: 40_000, interval: 100, label: () => `the turn to finish (phases seen: ${seen.join(" -> ") || "none"})` });

    // Each phase in turn; the reply takes over and gives the line back.
    expect(seen).toEqual(["Working", "writing", "running", "Working", "writing", "done"]);
    // While the command runs the line stays, so the chat keeps its height,
    // and its clock, the turn's, is the only one: it counts on through the
    // command (1.5s waiting, ~0.9s writing, then the 3s sleep).
    expect(runningWithLine).toBe(true);
    expect(runLineClock).toBe(false);
    const counted = turnClocks.filter(Number.isFinite);
    expect(counted.length).toBeGreaterThan(0);
    expect(Math.max(...counted)).toBeGreaterThanOrEqual(4);
    // After the reload the page knew the turn and when it began: its first
    // clock counts from the send, not from the reload, which came 2.4s or
    // more after it (1.5s waiting, ~0.9s writing).
    expect(seconds(clockAfterReload)).toBeGreaterThanOrEqual(Math.floor((clockReadAt - sentAt) / 1000) - 1);
    expect(seconds(clockAfterReload)).toBeGreaterThanOrEqual(Math.floor((clockReadAt - reloadedAt) / 1000) + 1);
    // Once the turn is done the line fades out, and is gone.
    await page.locator('[data-slot="working-indicator"]').waitFor({ state: "detached" });
    fs.writeFileSync(path.join(shots(), "phases.json"), JSON.stringify({ seen, clocks, clockAfterReload, clockReadAt, sentAt, reloadedAt, modelCalls }, null, 2));
  } finally {
    await context.close();
  }
}, 90_000);
