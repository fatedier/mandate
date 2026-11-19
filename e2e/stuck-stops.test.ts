import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { seedProject } from "../tests/helpers/fixtures.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { everyWaitingRow } from "./helpers/home-rows";
import { seedFailedThread } from "./helpers/status-seeds";
import { assertStubProvider, respond, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * The stop for a repeated failing call, through real turns:
 * the model a stub that speaks the Responses stream. A worker repeats a call
 * that can never succeed and is stopped at the fifth failure; it shows why in
 * its transcript and waits on you on Home as Stopped, and Continue resumes
 * it. A manager thread stopped the same way waits there too. A worker whose
 * manager writes to it after the stop goes on by that message alone. The stub
 * tells the workers and the managers apart by what is in the request, so a
 * report waking a manager cannot shift a worker's script.
 *
 * And a person's own stop: a turn stopped with the Stop button before it
 * wrote a reply says it was interrupted, at once and after a reload.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
const seeded = { managerId: "", loopManagerId: "", nudgeManagerId: "", haltManagerId: "", repeatWorker: "", nudgeWorker: "" };
const requests = { repeat: [] as Array<Record<string, any>>, manager: 0, loop: 0, nudge: 0, nudgeManager: 0, halt: 0 };
/** Lets go of the model step that never answers, when the file is done. */
let releaseHeldStep: () => void = () => {};

/** What the stopped worker's manager tells it. */
const NUDGE = "nudge-case: give it one time field only";

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, any>;
      const text = JSON.stringify(body.input ?? []);
      // A manager thread of its own that repeats the same impossible call (checked
      // first: a manager's prompt itself mentions "[Worker report]").
      if (text.includes("mgr-loop-case")) {
        requests.loop += 1;
        const n = requests.loop;
        if (n <= 5) return respond(`l${n}`, { call: { name: "schedule_wake", args: { delayMs: 60_000, atTime: "2026-10-01T12:00:00Z" } } });
        return respond(`l${n}`, { text: "Set the docs check for an hour from now." });
      }
      // A manager a person stops: one call that works, then a step that
      // does not answer until the turn is stopped.
      if (text.includes("halt-case")) {
        requests.halt += 1;
        if (requests.halt === 1) return respond("h1", { call: { name: "schedule_wake", args: { when: "1h", note: "Look at the release notes again." } } });
        await new Promise<void>((resolve) => {
          releaseHeldStep = resolve;
          request.signal.addEventListener("abort", () => resolve());
        });
        return new Response("the turn was stopped", { status: 499 });
      }
      // A manager that acts on its worker's stop: told the worker stopped, it
      // writes to it once; woken again by the worker's reply, it only notes it.
      if (text.includes("[Worker report] nudge-case")) {
        requests.nudgeManager += 1;
        const n = requests.nudgeManager;
        if (n === 1) return respond(`nm${n}`, { call: { name: "message_worker", args: { workerId: seeded.nudgeWorker, message: NUDGE } } });
        return respond(`nm${n}`, { text: "Told it how." });
      }
      // The manager, woken by a worker's report: it only acknowledges.
      if (text.includes("[Worker report]")) {
        requests.manager += 1;
        return respond(`m${requests.manager}`, { text: "Noted." });
      }
      if (text.includes("repeat-case")) {
        requests.repeat.push(body);
        const n = requests.repeat.length;
        // Two time fields where the tool takes one: a validation error, every time.
        if (n <= 5) return respond(`r${n}`, { call: { name: "schedule_wake", args: { delayMs: 60_000, atTime: "2026-10-01T12:00:00Z" } } });
        return respond(`r${n}`, { text: "Scheduled the check with one time field." });
      }
      if (text.includes("nudge-case")) {
        requests.nudge += 1;
        const n = requests.nudge;
        // The same impossible call until its manager's message is in front of it.
        if (!text.includes("one time field only")) return respond(`n${n}`, { call: { name: "schedule_wake", args: { delayMs: 60_000, atTime: "2026-10-01T12:00:00Z" } } });
        return respond(`n${n}`, { text: "Set the check with one field." });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${text.slice(0, 200)}` } }), { status: 500, headers: { "content-type": "application/json" } });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port);
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const projects = new ProjectsStore(store.db);
        const workers = new WorkersStore(store.db);
        seeded.managerId = agents.createManagerThread("project-1 3.22 release").id;
        seeded.loopManagerId = agents.createManagerThread("Docs pass").id;
        seeded.nudgeManagerId = agents.createManagerThread("Build checks").id;
        seeded.haltManagerId = agents.createManagerThread("Release notes").id;
        // Red from the start: once its state is drawn, the status has come.
        seedFailedThread(agents, "Broken build", "provider returned 500");
        const projectId = seedProject(projects, { name: "project-1", tmuxSessionName: "md-stops" });
        const worker = (name: string, ownerThreadId = seeded.managerId) => workers.insert({
          projectId, name, mode: "shared-cwd", branch: null, worktreePath: null,
          tmuxWindowName: name, ownership: "app", ownerThreadId
        });
        seeded.repeatWorker = worker("repeat-case");
        seeded.nudgeWorker = worker("nudge-case", seeded.nudgeManagerId);
        agents.getOrCreateThread("worker", seeded.repeatWorker);
        agents.getOrCreateThread("worker", seeded.nudgeWorker);
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
}, 60_000);

afterAll(() => {
  releaseHeldStep();
  server?.cleanup();
  stub?.stop(true);
});

async function send(workerId: string, content: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/agents/workers/${workerId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content })
  });
  expect(response.status).toBe(202);
}

const line = (page: Page) => page.locator('[data-slot="wake-failure"]');
/** A worker's chat: in its owner thread's panel, beside the thread's own. */
const workerChat = (ownerThreadId: string, workerId: string) => `/threads/${ownerThreadId}?worker=${workerId}&tab=chat`;
const panel = (page: Page) => page.locator('[data-slot="worker-panel"]');
const workerLine = (page: Page) => panel(page).locator('[data-slot="wake-failure"]');
const homeRow = (page: Page, worker: string) =>
  page.locator('section[aria-label="Waiting on you"] [data-waiting]').filter({ hasText: worker });

test("a worker repeating a failing call is stopped at the fifth, says why, is its manager's to hear (no row on Home), and Continue resumes it", async () => {
  await send(seeded.repeatWorker, "repeat-case: schedule a check on the build in an hour");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}${workerChat(seeded.managerId, seeded.repeatWorker)}`);
    await workerLine(page).getByRole("button", { name: "Continue", exact: true }).waitFor();
    const said = await workerLine(page).textContent();
    expect(said).toContain("Stopped");
    expect(said).toContain("schedule_wake failed 5 times in a row");
    expect(said).not.toContain("Failed");
    expect(requests.repeat).toHaveLength(5);
    await look(page, "repeat-desktop");

    // Home: a worker's stop is its manager's (its report went there), not a row of the user's.
    await page.goto(`${server.baseUrl}/home`);
    await page.locator('[data-thread-title="Broken build"] [role="img"][aria-label="state: failed or stopped"]').waitFor();
    expect(await (await everyWaitingRow(page)).filter({ hasText: "repeat-case" }).count()).toBe(0);
    await look(page, "repeat-home");

    // Continue: a person's message clears the stop; the next turn finishes.
    await page.goto(`${server.baseUrl}${workerChat(seeded.managerId, seeded.repeatWorker)}`);
    await workerLine(page).getByRole("button", { name: "Continue", exact: true }).click();
    await panel(page).getByText("Scheduled the check with one time field.").waitFor();
    expect(await workerLine(page).count()).toBe(1);
    expect(await workerLine(page).getByRole("button").count()).toBe(0);
    await page.goto(`${server.baseUrl}/home`);
    await page.locator('[data-thread-title="Broken build"] [role="img"][aria-label="state: failed or stopped"]').waitFor();
    expect(await (await everyWaitingRow(page)).filter({ hasText: "repeat-case" }).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 120_000);

test("a manager thread stopped by a repeat waits on you on Home as Stopped, counted, and Continue clears it", async () => {
  const sent = await fetch(`${server.baseUrl}/api/agents/threads/${seeded.loopManagerId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "mgr-loop-case: check the docs build in an hour" })
  });
  expect(sent.status).toBe(202);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/home`);
    const row = homeRow(page, "Docs pass");
    await row.waitFor();
    expect(await row.getAttribute("data-waiting")).toBe("stopped");
    const said = await row.textContent();
    expect(said).toContain("manager");
    expect(said).toContain("schedule_wake failed 5 times in a row");
    expect(said).toContain("Stopped");
    expect(requests.loop).toBe(5);
    await look(page, "manager-home-desktop");

    // A phone on Home stays open: the count, and the row going live (no reload) on Continue.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    phone.setDefaultTimeout(20_000);
    attachPageDiagnostics(phone);
    try {
      await phone.goto(`${server.baseUrl}/home`);
      await homeRow(phone, "Docs pass").waitFor();
      // The menu button counts every row Home lists (whatever ran before this test), this one included.
      const rows = await (await everyWaitingRow(phone)).count();
      expect(rows).toBeGreaterThanOrEqual(1);
      const label = (n: number) => n === 1 ? "1 item needs you" : `${n} items need you`;
      await phone.locator(`[aria-label="Open navigation"] [aria-label="${label(rows)}"]`).waitFor();
      await look(phone, "manager-home-phone");

      // The row opens the thread, whose last line offers Continue.
      await row.click();
      await page.waitForURL(`**/threads/${seeded.loopManagerId}`);
      await line(page).getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByText("Set the docs check for an hour from now.").waitFor();
      // Gone from the phone's Home as the next turn starts, and the count with it.
      await homeRow(phone, "Docs pass").waitFor({ state: "detached" });
      if (rows === 1) expect(await phone.locator('[aria-label="Open navigation"] [aria-label*="need"]').count()).toBe(0);
      else await phone.locator(`[aria-label="Open navigation"] [aria-label="${label(rows - 1)}"]`).waitFor();
    } finally {
      await phone.close();
    }
  } finally {
    await page.close();
  }
}, 120_000);

// A stopped worker reports "stopped" to its manager, which is told it can
// write to the worker. That message used to sit unread in the
// worker's mail and the manager was told "queued": the worker waited for the
// user alone. Its manager's message wakes it.
test("a stopped worker's manager writes to it, and the worker goes on with nobody else's word", async () => {
  await send(seeded.nudgeWorker, "nudge-case: schedule a check on the build in an hour");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}${workerChat(seeded.nudgeManagerId, seeded.nudgeWorker)}`);
    // Stopped at the fifth failure, as any worker is.
    await workerLine(page).filter({ hasText: "schedule_wake failed 5 times in a row" }).waitFor();
    // Its manager's message arrives in its chat, and it answers: one more
    // request to the model, the sixth, with no person having written.
    await panel(page).getByText(NUDGE).waitFor();
    await panel(page).getByText("Set the check with one field.").waitFor();
    expect(requests.nudge).toBe(6);
    expect(requests.nudgeManager).toBeGreaterThanOrEqual(1);
    // Nothing offers Continue any more: a turn has run since the stop.
    expect(await workerLine(page).getByRole("button", { name: "Continue", exact: true }).count()).toBe(0);
    await look(page, "nudged-desktop");
    // And it no longer waits on the user: the stop is cleared on the server
    // (asked there first, so an empty Home is not just a Home still loading).
    const body = await (await fetch(`${server.baseUrl}/api/work-items?workerId=${seeded.nudgeWorker}`)).json() as { items?: Array<{ failedKind: string | null }>; item?: { failedKind: string | null } };
    expect((body.items ?? (body.item ? [body.item] : [])).map((item) => item.failedKind)).toEqual([null]);
    await page.goto(`${server.baseUrl}/home`);
    // The status has come (a thread only it reads red is drawn so) before reading Home's rows.
    await page.locator('[data-thread-title="Broken build"] [role="img"][aria-label="state: failed or stopped"]').waitFor();
    expect(await homeRow(page, "nudge-case").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 120_000);

// A turn stopped by its reader did not finish: the line under its run used to
// say "Finished without a reply", as for a turn that ended by itself.
test("a turn stopped with the Stop button before it replied says it was interrupted, at once and after a reload", async () => {
  const sent = await fetch(`${server.baseUrl}/api/agents/threads/${seeded.haltManagerId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "halt-case: remind me about the release notes in an hour" })
  });
  expect(sent.status).toBe(202);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  const label = page.locator('[data-slot="row-label"]');
  const wakeMessages = async () => {
    const body = await (await fetch(`${server.baseUrl}/api/agents/threads/${seeded.haltManagerId}`)).json() as { messages: Array<{ wakeId: string | null; wakeInterrupted?: boolean }> };
    return body.messages.filter((m) => m.wakeId !== null);
  };
  try {
    await page.goto(`${server.baseUrl}/threads/${seeded.haltManagerId}`);
    // Its one call is done and drawn, and the second step is with the model.
    await page.locator('[data-slot="tool-run-line"]').waitFor();
    await waitUntil(() => requests.halt === 2, { timeout: 20_000 });
    const stop = page.getByRole("button", { name: "Stop agent", exact: true });
    await stop.waitFor();
    // Under way: nothing says the turn is over, and the server has not said it
    // was stopped of any of the turn's messages (what was asked, the call, its answer).
    expect(await label.count()).toBe(0);
    expect((await wakeMessages()).map((m) => m.wakeInterrupted ?? false)).toEqual([false, false, false]);
    // Every word the line shows from here on, so that a moment of "Finished" would be seen.
    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { labelsSeen: Set<string> }).labelsSeen = seen;
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[data-slot="row-label"]')) seen.add(el.textContent ?? "");
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await stop.click();
    await label.waitFor();
    expect(await label.locator("..").textContent()).toMatch(/^Interrupted · \d{2}:\d{2}$/);
    // The server ends the turn as stopped, and each of its messages then says so.
    await waitUntil(async () => (await wakeMessages()).every((m) => m.wakeInterrupted === true), { timeout: 20_000 });
    expect(await wakeMessages()).toHaveLength(3);
    // The end event has reached the page by now or does within a moment; the line never read otherwise.
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => [...(window as unknown as { labelsSeen: Set<string> }).labelsSeen])).toEqual(["Interrupted · "]);
    expect(await page.getByText("Finished without a reply").count()).toBe(0);
    expect(await stop.count()).toBe(0);
    await look(page, "interrupted-desktop");

    // Read again from the server, with nothing the page remembered.
    await page.reload();
    await label.waitFor();
    expect(await label.locator("..").textContent()).toMatch(/^Interrupted · \d{2}:\d{2}$/);
    expect(await page.getByText("Finished without a reply").count()).toBe(0);
    // The model was asked twice and never again: a stop is not retried.
    expect(requests.halt).toBe(2);
  } finally {
    await page.close();
  }
}, 120_000);
