import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { artifactDir } from "./helpers/diagnostics.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { settle, trackRequests } from "./helpers/settle.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { waitUntil } from "../tests/helpers/wait.js";

/**
 * Background commands through real manager turns. The model is a stub that
 * speaks the Responses stream; it picks its answer from the newest thing in
 * the request it knows: a tool's answer to one of its calls, or the user's
 * (or a command result's) words. Three commands: a build run in the
 * background, which ends by itself and whose result the manager answers; a
 * wait stopped from the Background tasks list; and a foreground check that
 * moves to the background at its timeout. happy-dom has no server, no shell
 * and no model: the line, the result line, the list and the moved call's
 * answer, end to end, are here.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
const shots = () => artifactDir("background-commands");

const MANAGER_PROMPT = "You are the **Manager** for Mandate.";
/** Files the test makes to let a command end: each ends when the test has
 *  seen what it must see while it runs, never by a sleep that load can
 *  outlast. A command whose file never comes gives up after 30 s. */
const GATES = fs.mkdtempSync(path.join(os.tmpdir(), "bgcmd-gates-"));
const gate = (run: Case, name: string) => path.join(GATES, `${run.word}-${name}`);
const until = (file: string) => `for i in $(seq 300); do [ -e '${file}' ] && break; sleep 0.1; done`;
/** The check's timeout: its first line is printed well before it moves. */
const CHECK_TIMEOUT_MS = 3000;
const BUILD = "Build the release binaries";
const WAIT = "Wait forever";
const CHECK = "Run the slow check";
const REPLY = {
  buildStarted: "Started the build.",
  buildPassed: "The build passed.",
  waiting: "Waiting for the deploy.",
  stopped: "Stopped the wait.",
  checkMoved: "The check moved to the background.",
  checkPassed: "The check passed."
};

/** One run: its word, its thread, every step the stub took for it, and the moved call's answer as the model got it. */
interface Case { word: string; threadId: string; steps: string[]; moved: string | null }
const cases: { desk: Case; phone: Case } = {
  desk: { word: "desk-case", threadId: "", steps: [], moved: null },
  phone: { word: "phone-case", threadId: "", steps: [], moved: null }
};
const stray: string[] = [];

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

/** What the newest known thing in the request asks the stub for. */
function step(body: Record<string, any>, run: Case): Response {
  const items = (body.input ?? []) as Array<Record<string, any>>;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "function_call_output") {
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      const call = String(item.call_id ?? "");
      if (call.endsWith("-build")) return say(run, "buildStarted");
      if (call.endsWith("-wait")) return say(run, "waiting");
      if (call.endsWith("-check")) {
        run.moved = output;
        return say(run, "checkMoved");
      }
      continue;
    }
    if (item.role !== "user") continue;
    const text = strings(item.content).join("\n");
    if (text.includes(`“${BUILD}”: exited 0`)) return say(run, "buildPassed");
    if (text.includes(`“${WAIT}”: stopped by the user`)) return say(run, "stopped");
    if (text.includes(`“${CHECK}”: exited 0`)) return say(run, "checkPassed");
    if (text.includes("build the release binaries")) return call(run, "build", { command: `${until(gate(run, "build"))}; printf 'built\\n'`, description: BUILD, run_in_background: true });
    if (text.includes("wait for the deploy")) return call(run, "wait", { command: "sleep 300", description: WAIT, run_in_background: true });
    if (text.includes("run the slow check")) return call(run, "check", { command: checkCommand(run), description: CHECK, timeout: CHECK_TIMEOUT_MS });
  }
  stray.push(JSON.stringify(items.slice(-2)).slice(0, 300));
  return respond(`${run.word}-stray${stray.length}`, { text: "ok" });
}
function checkCommand(run: Case): string {
  return `printf 'early\\n'; ${until(gate(run, "check"))}; printf 'late\\n'`;
}
function say(run: Case, reply: keyof typeof REPLY): Response {
  run.steps.push(reply);
  return respond(`${run.word}-${run.steps.length}`, { text: REPLY[reply] });
}
function call(run: Case, name: string, args: Record<string, unknown>): Response {
  run.steps.push(name);
  return respond(`${run.word}-${run.steps.length}-${name}`, { call: { name: "bash", args } });
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, any>;
      const text = strings(body.instructions ?? "").concat(strings(body.input ?? [])).join("\n");
      const run = text.includes(cases.desk.word) ? cases.desk : text.includes(cases.phone.word) ? cases.phone : null;
      if (!run || !text.includes(MANAGER_PROMPT)) {
        stray.push(text.slice(0, 300));
        return respond(`stray${stray.length}`, { text: "ok" });
      }
      return step(body, run);
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
        cases.desk.threadId = agent.latestManagerThread("Release builds on a desktop").id;
        cases.phone.threadId = agent.createManagerThread("Release builds on a phone").id;
      } finally {
        store.db.close();
      }
    }
  });
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== `http://127.0.0.1:${stub.port}/v1`) {
    throw new Error(`the provider is not the stub: ${JSON.stringify(openai)}`);
  }
}, 60_000);

afterAll(() => {
  try {
    fs.writeFileSync(path.join(shots(), "requests.json"), JSON.stringify({ desk: cases.desk, phone: cases.phone, stray }, null, 2));
  } finally {
    server?.cleanup();
    stub?.stop(true);
    fs.rmSync(GATES, { recursive: true, force: true });
  }
});

const strip = (page: Page) => page.locator('[data-slot="worker-strip"]');
const tasksList = (page: Page, phone: boolean) =>
  page.locator(phone ? '[data-slot="background-tasks-sheet"]' : '[data-slot="background-tasks-popover"]');

async function textOf(locator: Locator): Promise<string> {
  return (await locator.count()) > 0 ? ((await locator.first().textContent()) ?? "") : "";
}

interface ListRow { section: string; name: string; line: string }
function listRows(list: Locator): Promise<ListRow[]> {
  return list.locator('[data-slot="background-task-row"]').evaluateAll((rows) => rows.map((row) => ({
    section: row.closest('[data-slot="background-tasks-section"]')?.getAttribute("data-section") ?? "",
    name: row.querySelector('[data-slot="background-task-name"]')?.textContent ?? "",
    line: row.querySelector('[data-slot="background-task-step"], [data-slot="background-task-outcome"]')?.textContent ?? ""
  })));
}
function smallTargets(list: Locator): Promise<string[]> {
  return list.locator("button").evaluateAll((buttons) => buttons.flatMap((button) => {
    const box = button.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return [];
    if (Math.min(box.width, box.height) >= 44) return [];
    return [`${button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "button"} ${Math.round(box.width)}x${Math.round(box.height)}`];
  }));
}

async function flow(page: Page, run: Case, phone: boolean) {
  const device = phone ? "phone" : "desktop";
  const shot = (name: string) => page.screenshot({ path: path.join(shots(), `${device}-${name}.png`) });
  const errors = trackPageErrors(page);
  const requests = await trackRequests(page);
  await page.goto(`${server.baseUrl}/threads/${run.threadId}`);
  // Live before the turn starts: the thread page drawn, what it loads in,
  // and the event stream's first state.
  await page.locator('[data-slot="composer"]').waitFor();
  await requests.idle();
  const send = async (content: string) => expect(await page.evaluate(async ({ id, body }) => (await fetch(`/api/agents/threads/${id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: body })
  })).status, { id: run.threadId, body: `${run.word}: ${content}` })).toBe(202);
  const lineOf = (title: string) => page.locator('[data-slot="subagent-line"]').filter({ hasText: title }).last();
  const resultOf = (title: string) => page.locator('[data-slot="command-result"]').filter({ hasText: title }).last();

  // 1. A build in the background: its line where the call was, its row on the strip, while it runs.
  await send("build the release binaries.");
  await lineOf(BUILD).waitFor({ timeout: 20_000 });
  expect((await lineOf(BUILD).textContent()) ?? "").toContain(`Command · ${BUILD} · Running`);
  // On the strip, seen, while it runs (it ends only once the test lets it).
  await strip(page).locator('[data-slot="task-strip-open"]', { hasText: `Command · ${BUILD}` }).waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText(REPLY.buildStarted).first().waitFor({ timeout: 20_000 });
  await shot("1-build-running");
  fs.writeFileSync(gate(run, "build"), "");
  // It ends by itself: one line where its result landed, then the manager's answer.
  await resultOf(BUILD).waitFor({ timeout: 30_000 });
  expect((await resultOf(BUILD).textContent()) ?? "").toMatch(new RegExp(`^Command · ${BUILD} · Exit 0 · \\d+s$`));
  await page.getByText(REPLY.buildPassed).first().waitFor({ timeout: 20_000 });
  await waitUntil(async () => ((await lineOf(BUILD).textContent()) ?? "").includes("Exit 0"), { timeout: 10_000, interval: 100, label: "its line to say how it exited" });
  await shot("2-build-done");

  // 2. A wait, stopped from the Background tasks list.
  await send("wait for the deploy.");
  await lineOf(WAIT).waitFor({ timeout: 20_000 });
  await page.getByText(REPLY.waiting).first().waitFor({ timeout: 20_000 });
  const menuButton = page.locator('button[aria-label="Thread actions"]');
  const item = page.locator('[role="menuitem"]', { hasText: "Background tasks" });
  const list = tasksList(page, phone);
  await menuButton.click();
  await item.click();
  await list.waitFor();
  await settle(page);
  let rows: ListRow[] = await listRows(list);
  expect(rows.filter((row) => row.section === "running").map((row) => [row.name, row.line])).toEqual([[`${WAIT} · Command`, "Running"]]);
  if (phone) {
    expect(await smallTargets(list)).toEqual([]);
    expect(await pageOverflow(page)).toEqual([]);
  }
  await shot("3-list");
  await list.getByRole("button", { name: `Stop ${WAIT}` }).click();
  await waitUntil(async () => {
    rows = await listRows(list);
    return rows.some((row) => row.section === "done" && row.name.startsWith(WAIT));
  }, { timeout: 20_000, interval: 100, label: () => `the stopped command to move to Done (rows: ${JSON.stringify(rows)})` });
  expect(rows.find((row) => row.name.startsWith(WAIT))!.line.split(" · ")[0]).toBe("Stopped");
  await page.getByText(REPLY.stopped).first().waitFor({ timeout: 20_000 });
  if (phone) await list.getByRole("button", { name: "Close" }).click();
  else await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  await shot("4-stopped");

  // 3. A foreground check still running at its timeout moves to the background.
  await send("run the slow check.");
  await page.getByText(REPLY.checkMoved).first().waitFor({ timeout: 20_000 });
  const moved = JSON.parse(run.moved ?? "{}") as Record<string, unknown>;
  expect([moved.status, moved.outputSoFar, moved.movedAfterMs]).toEqual(["running", "early", CHECK_TIMEOUT_MS]);
  await lineOf(CHECK).waitFor({ timeout: 10_000 });
  // It ends once moved: the rest of its output follows into its file.
  fs.writeFileSync(gate(run, "check"), "");
  await resultOf(CHECK).waitFor({ timeout: 30_000 });
  expect((await resultOf(CHECK).textContent()) ?? "").toMatch(new RegExp(`^Command · ${CHECK} · Exit 0 · \\d+s$`));
  await page.getByText(REPLY.checkPassed).first().waitFor({ timeout: 20_000 });
  // Its detail: the command, its whole output (what came before the move and after), how much and where.
  await menuButton.click();
  await item.click();
  await list.waitFor();
  await settle(page);
  await list.locator('[data-slot="background-task-row"]').filter({ hasText: CHECK }).first().click();
  await list.locator('[data-slot="task-output-text"]').waitFor();
  expect([await textOf(list.locator('[data-slot="task-command-text"]')), await textOf(list.locator('[data-slot="task-output-text"]'))])
    .toEqual([checkCommand(run), "early\nlate"]);
  expect(await textOf(list.locator('[data-slot="task-output-note"]'))).toMatch(/^Last 2 of 2 lines · 11 B · full output: \/.+\.log$/);
  if (phone) expect(await pageOverflow(page)).toEqual([]);
  await shot("5-detail");
  expect(errors).toEqual([]);
}

test("desktop: a manager's background commands run, end, are stopped from the list, and one moves there at its timeout", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  try {
    await flow(await context.newPage(), cases.desk, false);
  } finally {
    await context.close();
  }
}, 150_000);

test("phone: the same in a sheet, with touch-sized targets and nothing wider than the screen", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await flow(await context.newPage(), cases.phone, true);
  } finally {
    await context.close();
  }
}, 150_000);
