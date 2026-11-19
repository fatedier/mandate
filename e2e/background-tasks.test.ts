import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { artifactDir } from "./helpers/diagnostics.js";
import { listRows, smallTargets, strip, tasksList, textOf, type ListRow } from "./helpers/background-list.js";
import { browserForFile } from "./helpers/browser.js";
import { look, trackPageErrors } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { settle, trackRequests } from "./helpers/settle.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { assertStubProvider, respond, seedStubProvider, strings, toolOutputs } from "./helpers/responses-stub.js";

/**
 * Background tasks through real turns. The model is a stub that speaks the
 * Responses stream on a script. A manager is asked for two jobs: it starts
 * a subagent, then (held until the test lets it go) a second. The first
 * subagent's model is held too, so its row is seen while it runs; the second
 * runs until it is stopped from the list. Let go, the first reads a notes
 * file with the manager's own read and answers in text: its result lands in
 * the manager's conversation, and the manager answers it. The stub tells a
 * subagent's requests from its manager's by their system prompts, the two
 * cases (desktop, phone) apart by a word in the user's message and in every
 * task, and a step by the tool results already in the request. happy-dom
 * has no layout, no server and no model: where the list opens, the
 * touch-sized sheet and the round trip are here.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
const shots = () => artifactDir("background-tasks");

/** How each system prompt opens (the subagent's is its prompt's first sentence). */
const SUBAGENT_PROMPT = "You are a subagent in Mandate.";
const MANAGER_PROMPT = "You are the **Manager** for Mandate.";
const FIRST = "Release changes";
const HELD = "Benchmark notes";
const HELD_MARK = "benchmark-notes";
/** What the first subagent reads: a file of the test's own, outside every project. */
const NOTES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bgtasks-notes-"));
const NOTES = path.join(NOTES_DIR, "CHANGELOG.md");
fs.writeFileSync(NOTES, "## 0.72.0\n\n- Retry a failed wake once.\n- Drop the legacy cache flag.\n");
const REPLY_END = "Nothing in the changelog was missing.";
const FIRST_REPLY = `0.72 retries a failed wake once and drops the legacy cache flag. ${REPLY_END}`;
const STARTED_REPLY = "Two subagents are at work: the release changes and the benchmark notes.";
const STOPPED_REPLY = "The benchmark notes were stopped; the release changes are still being read.";
const DONE_REPLY = "The release changes are in.";

interface Gate { open: () => void; opened: Promise<void> }
function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

/** One run: its word, its thread, what holds its manager's second step and
 *  its first subagent's first step, and every request the stub took for it. */
interface Case { word: string; threadId: string; parent: Gate; first: Gate; requests: string[] }
const cases: { desk: Case; phone: Case } = {
  desk: { word: "desk-case", threadId: "", parent: gate(), first: gate(), requests: [] },
  phone: { word: "phone-case", threadId: "", parent: gate(), first: gate(), requests: [] }
};
/** Requests no case claims (another agent's, if one wakes): answered, kept for the record. */
const stray: string[] = [];

/** Until the gate opens, or the request is dropped (its wake was stopped). */
function held(opened: Promise<void>, request: Request): Promise<void> {
  return new Promise<void>((resolve) => {
    void opened.then(resolve);
    request.signal.addEventListener("abort", () => resolve());
  });
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    // A held model call sends nothing until its gate opens, however long the
    // steps before take: no idle limit cuts it short.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, any>;
      // Every string the model was shown: its instructions, then its input.
      const text = strings([body.instructions ?? "", body.input ?? []]).join("\n");
      const outputs = toolOutputs(body);
      const run = text.includes(cases.desk.word) ? cases.desk : text.includes(cases.phone.word) ? cases.phone : null;
      const subagent = text.includes(SUBAGENT_PROMPT);
      if (!run || (!subagent && !text.includes(MANAGER_PROMPT))) {
        stray.push(text.slice(0, 300));
        return respond(`stray${stray.length}`, { text: "ok" });
      }
      const id = `${run.word}-${run.requests.length + 1}`;
      if (subagent && text.includes(HELD_MARK)) {
        run.requests.push("benchmark");
        // Runs until it is stopped: the stop cancels its wake, which drops this request.
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve()));
        return respond(id, { text: "never read" });
      }
      if (subagent) {
        run.requests.push(`first:${outputs.length}`);
        if (outputs.length === 0) {
          await held(run.first.opened, request);
          return respond(id, { call: { name: "read", args: { path: NOTES } } });
        }
        // Its read is the manager's own: it reaches a file outside every project.
        if (!outputs[0]!.includes("Retry a failed wake once.")) return respond(id, { text: `The read failed: ${outputs[0]!.slice(0, 200)}` });
        return respond(id, { text: FIRST_REPLY });
      }
      run.requests.push(`manager:${outputs.length}`);
      // A result first: a later request also holds the earlier result.
      if (text.includes(`“${FIRST}”: finished`)) return respond(id, { text: DONE_REPLY });
      if (text.includes(`“${HELD}”: stopped by the user`)) return respond(id, { text: STOPPED_REPLY });
      if (outputs.length === 0) {
        return respond(id, { call: { name: "subagent", args: { title: FIRST, task: `${run.word} release-changes: read ${NOTES} and say in two sentences what 0.72 changes. Only look; change nothing.` } } });
      }
      if (outputs.length === 1) {
        await held(run.parent.opened, request);
        return respond(id, { call: { name: "subagent", args: { title: HELD, task: `${run.word} ${HELD_MARK}: read bench/0.72.txt and list the three slowest runs.` } } });
      }
      return respond(id, { text: STARTED_REPLY });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port);
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        cases.desk.threadId = agent.latestManagerThread("Release 0.72 on a desktop").id;
        cases.phone.threadId = agent.createManagerThread("Release 0.72 on a phone").id;
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
// As the other model-backed files: the server may take its readiness wait.
}, 60_000);

afterAll(() => {
  try {
    fs.writeFileSync(path.join(shots(), "requests.json"), JSON.stringify({ desk: cases.desk.requests, phone: cases.phone.requests, stray }, null, 2));
  } finally {
    // Whatever keeping the requests did: nothing is left running or on disk.
    server?.cleanup();
    stub?.stop(true);
    fs.rmSync(NOTES_DIR, { recursive: true, force: true });
  }
});

async function flow(page: Page, run: Case, phone: boolean) {
  const device = phone ? "phone" : "desktop";
  const shot = (step: string) => look(page, `${device}-${step}`);
  const errors = trackPageErrors(page);
  const requests = await trackRequests(page);
  await page.goto(`${server.baseUrl}/threads/${run.threadId}`);
  // Live before the turn starts: the thread page drawn, what it loads in,
  // and the event stream's first state.
  await page.locator('[data-slot="composer"]').waitFor();
  await requests.idle();
  const sent = await page.evaluate(async ({ id, content }) => (await fetch(`/api/agents/threads/${id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content })
  })).status, { id: run.threadId, content: `${run.word}: find out what 0.72 changes, and collect the benchmark notes.` });
  expect(sent).toBe(202);

  // One subagent at work (its manager is held before it starts the second): its own row, with Stop.
  let seen = "";
  await waitUntil(async () => {
    seen = await textOf(strip(page));
    return seen.includes("Subagent") && seen.includes(FIRST);
  }, { timeout: 20_000, interval: 100, label: () => `the strip to show the subagent (it showed: ${seen || "nothing"})` });
  expect(await strip(page).locator('button[aria-label^="Stop"]').count()).toBeGreaterThan(0);
  await shot("1-one-running");

  // Two at work: one row names both.
  run.parent.open();
  await waitUntil(async () => {
    seen = await textOf(strip(page));
    return seen.includes("2 subagents");
  }, { timeout: 20_000, interval: 100, label: () => `the strip to fold the two subagents (it showed: ${seen || "nothing"})` });
  await page.getByText(STARTED_REPLY).first().waitFor({ timeout: 20_000 });
  await shot("2-two-running");

  // The folded row opens the list: above itself on a desktop, a sheet on a phone.
  const folded = strip(page).locator("button", { hasText: "2 subagents" });
  const list = tasksList(page, phone);
  await folded.click();
  await list.waitFor();
  await settle(page);
  expect(await textOf(list.locator('[data-slot="background-tasks-counts"]'))).toBe("2 running");
  expect((await listRows(list)).map((row) => [row.section, row.name])).toEqual([
    ["running", `${FIRST} · Subagent`],
    ["running", `${HELD} · Subagent`]
  ]);
  if (phone) {
    expect(await smallTargets(list)).toEqual([]);
    expect(await pageOverflow(page)).toEqual([]);
    await list.getByRole("button", { name: "Close" }).click();
  } else {
    const row = await folded.boundingBox();
    const box = await list.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(row!.y + 1);
    // Pressed again, the row closes it: the row is its toggle, not a press outside.
    await folded.click();
  }
  await list.waitFor({ state: "detached" });

  // The ⋯ menu's first item opens the same list, under the ⋯ on a desktop.
  const menuButton = page.locator('button[aria-label="Thread actions"]');
  const item = page.locator('[role="menuitem"]', { hasText: "Background tasks" });
  await menuButton.click();
  await item.waitFor();
  expect(await page.locator('[role="menuitem"]').first().textContent()).toBe("Background tasks");
  await shot("3-menu");
  await item.click();
  await list.waitFor();
  await settle(page);
  if (!phone) {
    const trigger = await menuButton.boundingBox();
    const box = await list.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(trigger!.y + trigger!.height - 1);
  }

  // Stop the second from the list: it moves to Done, stopped; the first runs on.
  await list.getByRole("button", { name: `Stop ${HELD}` }).click();
  let rows: ListRow[] = [];
  await waitUntil(async () => {
    rows = await listRows(list);
    return rows.some((row) => row.section === "done" && row.name.startsWith(HELD));
  }, { timeout: 20_000, interval: 100, label: () => `the stopped task to move to Done (rows: ${JSON.stringify(rows)})` });
  expect(rows.map((row) => [row.section, row.name.split(" · ")[0], row.section === "done" ? row.line.split(" · ")[0] : "-"])).toEqual([
    ["running", FIRST, "-"],
    ["done", HELD, "Stopped"]
  ]);
  expect(await textOf(list.locator('[data-slot="background-tasks-counts"]'))).toBe("1 running");
  await shot("4-stopped");
  // Its manager was told, and answered.
  await page.getByText(STOPPED_REPLY).first().waitFor({ timeout: 20_000 });
  if (phone) await list.getByRole("button", { name: "Close" }).click();
  else await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });

  // Let the first go: it reads the notes with the manager's own read and answers in text.
  run.first.open();
  // Its result is one line in the conversation; its reply opens from it.
  const line = page.locator('[data-slot="subagent-result-open"]').filter({ hasText: FIRST }).last();
  await line.waitFor({ timeout: 30_000 });
  const lineText = (await line.textContent()) ?? "";
  expect(lineText).toContain("Subagent");
  expect(lineText).toContain("Finished");
  await page.getByText(DONE_REPLY).first().waitFor({ timeout: 20_000 });
  expect(await page.locator('[data-slot="transcript-row"]').filter({ hasText: REPLY_END }).count()).toBe(0);
  if (phone) await line.tap();
  else await line.click();
  const reply = page.locator('[data-slot="subagent-reply"]');
  await reply.getByText(REPLY_END).first().waitFor();
  await page.keyboard.press("Escape");
  await reply.waitFor({ state: "detached" });
  // Nothing runs now, and the thread has no workers: the strip has nothing to show.
  expect(await strip(page).count()).toBe(0);
  await shot("5-result");

  // The list holds both, done, the latest first; a row opens its steps and its reply; ‹ goes back.
  await menuButton.click();
  await item.click();
  await list.waitFor();
  await settle(page);
  // Done ones are not counted.
  expect(await textOf(list.locator('[data-slot="background-tasks-counts"]'))).toBe("");
  expect((await listRows(list)).map((row) => [row.section, row.name.split(" · ")[0], row.line.split(" · ")[0]])).toEqual([
    ["done", FIRST, "Finished"],
    ["done", HELD, "Stopped"]
  ]);
  await list.locator('[data-slot="background-task-row"]').first().click();
  // What it was asked, then what it answered; its steps folded, with how many.
  await list.locator('[data-slot="task-reply"]').getByText(REPLY_END).first().waitFor();
  expect(await textOf(list.locator('[data-slot="task-brief-text"]'))).toContain(`read ${NOTES} and say in two sentences what 0.72 changes.`);
  expect([await textOf(list.locator('[data-slot="task-steps-count"]')), await list.locator('[data-slot="tool-call"]').count()]).toEqual(["· 1", 0]);
  await shot("6-detail");
  // Its one step, once opened: the read.
  await list.locator('[data-slot="task-steps-toggle"]').click();
  await list.locator('[data-slot="tool-call"]').first().waitFor();
  expect(await list.locator('[data-slot="tool-call"]').count()).toBe(1);
  await shot("6-detail-steps");
  await list.getByRole("button", { name: "All background tasks" }).click();
  await list.locator('[data-slot="background-tasks-section"]').first().waitFor();
  expect(errors).toEqual([]);
}

test("desktop: a manager's subagents run, fold into one row, one is stopped from the list, one answers with what it read", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  try {
    await flow(await context.newPage(), cases.desk, false);
  } finally {
    await context.close();
  }
}, 120_000);

test("phone: the same in a sheet, with touch-sized targets and nothing wider than the screen", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await flow(await context.newPage(), cases.phone, true);
  } finally {
    await context.close();
  }
}, 120_000);
