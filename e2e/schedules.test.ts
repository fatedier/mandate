import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { fakeGreenhouse } from "./helpers/fake-greenhouse.js";
import { settle } from "./helpers/settle.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { API_PATHS, API_ROUTES } from "../src/shared/api-contracts.js";
import type { AgentClientMessageDto } from "../src/shared/api/agents.js";
import type { ScheduleRunDto } from "../src/shared/api/schedules.js";
import { assertStubProvider, respond, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * A schedule through the compiled server, the model a stub that answers by
 * whose conversation it reads: the user asks the personal agent to watch a greenhouse
 * (files standing for its log and readings); the personal agent creates the schedule,
 * whose check has its first run; a check that finds nothing adds nothing to
 * the duty thread; a new finding in the log wakes it with what the check found,
 * and its reply reaches the personal agent as the report; a known matter ends in
 * NO_REPORT and tells the personal agent nothing. Then the duty thread as the user
 * sees it, on a desktop and a phone.
 */

const PERSONAL_MARK = "You are the user's personal agent above all of Mandate's threads";
const DUTY_MARK = "## Your duty";
const REPORT = "New since yesterday: dry soil in bed 3. A worker is looking at it.";
const ASK_WATCH = "Watch the greenhouse for me every morning.";
const ASK_RUN = (n: number) => `Run the greenhouse check now (${n}).`;

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
const greenhouse = fakeGreenhouse(fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-greenhouse-")));
let calls = 0;

/** The personal agent: the user's latest ask, once; then it says it is done. */
function yourAgent(input: string): Response {
  const watchAt = input.lastIndexOf(ASK_WATCH);
  const runs = [1, 2, 3].map((n) => ({ n, at: input.lastIndexOf(ASK_RUN(n)) })).filter((r) => r.at >= 0).sort((a, b) => b.at - a.at);
  const latest = runs[0] && runs[0].at > watchAt ? { at: runs[0].at, kind: "run" as const } : watchAt >= 0 ? { at: watchAt, kind: "watch" as const } : null;
  const noticeAt = input.lastIndexOf("[Thread notice]");
  if (!latest || noticeAt > latest.at) return respond(`g${calls}`, { text: "Noted." });
  if (input.lastIndexOf("function_call_output") > latest.at) return respond(`g${calls}`, { text: "Done." });
  if (latest.kind === "watch") {
    return respond(`g${calls}`, { call: { name: "manage_schedule", args: {
      action: "create", name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC", check: greenhouse.checkScript,
      brief: "Each morning, look into what the check found in the greenhouse: new findings in its log, a reading far above its baseline.",
      thread: { newTitle: "greenhouse watch" }
    } } });
  }
  const id = /sch_[A-Za-z0-9_-]+/.exec(input)?.[0] ?? "missing";
  return respond(`g${calls}`, { call: { name: "manage_schedule", args: { action: "run_now", id } } });
}

/** The duty thread: its brief is noted; a check that found something new is
 *  reported; a check on what it already knows is not. */
function dutyThread(input: string): Response {
  const wakeAt = input.lastIndexOf("[Mandate schedule check]");
  if (wakeAt < 0) return respond(`d${calls}`, { text: "Understood: I keep my notes and report what is new." });
  return respond(`d${calls}`, { text: input.slice(wakeAt).includes("rate:bed5") ? "NO_REPORT" : REPORT });
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, unknown>;
      const all = JSON.stringify(body);
      const input = JSON.stringify(body.input ?? []);
      calls += 1;
      if (all.includes(PERSONAL_MARK)) return yourAgent(input);
      if (all.includes(DUTY_MARK)) return dutyThread(input);
      return respond(`x${calls}`, { text: "Noted." });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port);
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

const api = async <T>(pathname: string): Promise<T> => (await fetch(`${server.baseUrl}${pathname}`)).json() as Promise<T>;
const messages = async (threadId: string) => (await api<{ messages: AgentClientMessageDto[] }>(`${API_PATHS.agentThread(threadId)}?limit=200`)).messages;
const textOf = (m: AgentClientMessageDto) => (m.content.type === "text" || m.content.type === "assistant" ? m.content.text ?? "" : "");
const runs = async (id: string) => (await api<{ runs: ScheduleRunDto[] }>(API_PATHS.scheduleRuns(id))).runs;
const threads = async () => (await api<{ threads: Array<{ id: string; title: string; duty: { schedules: Array<{ id: string }> } | null }> }>(API_ROUTES.agentManagerThreads)).threads;

async function ask(text: string): Promise<string> {
  const agent = (await api<{ agent: { threadId: string } }>("/api/agents/personal")).agent;
  const sent = await fetch(`${server.baseUrl}/api/agents/threads/${agent.threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text })
  });
  expect(sent.status).toBe(202);
  return agent.threadId;
}

/** A scheduled check's new items, as its wake lists them (renderScheduleWake). */
function newItems(text: string): string[] {
  const lines = text.split("\n");
  const from = lines.indexOf("new items:");
  if (from < 0) return [];
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((line) => !line.startsWith("| "));
  return (end < 0 ? rest : rest.slice(0, end)).map((line) => line.slice(2));
}

/** The personal agent's notices from the duty thread that reported. */
const reportsTo = async (personalId: string) => (await messages(personalId)).filter((m) => m.source === "thread-notice" && textOf(m).includes(": reports."));

const duty = { threadId: "", scheduleId: "" };

test("a schedule from the personal agent has its first run, stays quiet, then wakes its duty thread, whose reply is the report", async () => {
  const personalId = await ask(ASK_WATCH);
  // Saved at once: its thread is on duty, and its first run follows.
  const found = await waitUntil(async () => (await threads()).find((t) => t.duty) ?? null, { timeout: 30_000, label: "the duty thread" });
  duty.threadId = found.id;
  duty.scheduleId = found.duty!.schedules[0]!.id;
  expect(found.title).toBe("greenhouse watch");
  await waitUntil(async () => (await runs(duty.scheduleId)).length > 0 || null, { timeout: 20_000, label: "the first run" });
  expect((await runs(duty.scheduleId)).map((r) => r.outcome)).toEqual(["test"]);
  // The brief's round ends; the personal agent has heard back.
  await waitUntil(async () => (await messages(duty.threadId)).some((m) => textOf(m).startsWith("Understood")) || null, { timeout: 20_000, label: "the brief's round" });
  const before = (await messages(duty.threadId)).length;

  // Nothing new: the check runs and the thread hears nothing.
  await ask(ASK_RUN(1));
  await waitUntil(async () => (await runs(duty.scheduleId))[0]?.outcome === "manual_quiet" || null, { timeout: 20_000, label: "a quiet run" });
  expect((await messages(duty.threadId)).length).toBe(before);

  // A new finding: the thread is woken with it, and its reply is the report.
  greenhouse.logLine("ERROR Dry soil in bed 3");
  await ask(ASK_RUN(2));
  await waitUntil(async () => (await runs(duty.scheduleId))[0]?.outcome === "manual_woke" || null, { timeout: 20_000, label: "a run that wakes" });
  const wake = await waitUntil(async () => (await messages(duty.threadId)).find((m) => m.source === "schedule") ?? null, { timeout: 20_000, label: "the scheduled check" });
  expect(textOf(wake)).toContain("Dry soil in bed 3");
  const reports = await waitUntil(async () => { const r = await reportsTo(personalId); return r.length > 0 ? r : null; }, { timeout: 30_000, label: "the report to the personal agent" });
  expect(reports).toHaveLength(1);
  expect(textOf(reports[0]!)).toContain(REPORT);
  await waitUntil(async () => (await messages(duty.threadId)).some((m) => m.dutyReport === "sent") || null, { timeout: 10_000, label: "the reply marked sent" });

  // The same finding again, and the reading over its baseline: a known matter
  // the thread keeps back with NO_REPORT, which tells the personal agent nothing.
  greenhouse.logLine("ERROR Dry soil in bed 3");
  greenhouse.setMoisture("bed5", 4);
  await ask(ASK_RUN(3));
  await waitUntil(async () => (await messages(duty.threadId)).some((m) => m.dutyReport === "no_report") || null, { timeout: 30_000, label: "the reply kept back" });
  expect(await reportsTo(personalId)).toHaveLength(1);
  const woken = (await messages(duty.threadId)).filter((m) => m.source === "schedule");
  expect(woken).toHaveLength(2);
  // Only what is new: the reading's item for the day, not the finding delivered before.
  expect(newItems(textOf(woken[1]!))).toEqual([expect.stringMatching(/^rate:bed5:\d{4}-\d{2}-\d{2}  bed 5 moisture at 4x baseline$/)]);
  expect(newItems(textOf(woken[0]!))).toEqual([expect.stringMatching(/^sig:\d+  Dry soil in bed 3$/)]);
}, 120_000);

async function open(pathname: string, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport, ...(viewport.width < 768 ? { hasTouch: true, isMobile: true } : {}) });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}${pathname}`);
  return page;
}

test("the duty thread reads as one: Home while its report is unread, its sidebar group once put there, its schedule's card and its marks", async () => {
  expect(duty.threadId).not.toBe("");
  // Put in the sidebar by the user (the On duty page's Show in sidebar).
  expect((await fetch(`${server.baseUrl}${API_PATHS.dutySidebar(duty.threadId)}`, { method: "PUT" })).status).toBe(200);
  const desktop = await open("/home", { width: 1280, height: 900 });
  try {
    // Its report waits unread: Home lists it, then the way to the page.
    const row = desktop.locator('section[aria-label="On duty"] [data-duty-thread]');
    await row.waitFor({ timeout: 10_000 });
    expect(await row.locator('[data-slot="duty-line"]').textContent()).toMatch(/^Next check .+ · 3 checks so far$/);
    expect(await desktop.locator('section[aria-label="On duty"] [data-slot="duty-all"]').textContent()).toBe("All 1 on duty");
    await desktop.goto(`${server.baseUrl}/threads/${duty.threadId}`);
    const group = desktop.locator('[role="group"][aria-label="On duty"]');
    await group.getByText("greenhouse watch").waitFor({ timeout: 15_000 });
    expect(await desktop.locator('[role="group"][aria-label="Threads"]').getByText("greenhouse watch").count()).toBe(0);
    await desktop.getByText("Sent to Personal agent as the report").waitFor({ timeout: 15_000 });
    await desktop.getByText("NO_REPORT · not sent to Personal agent").waitFor();
    expect(await desktop.getByText("Scheduled check").count()).toBe(2);
    await desktop.locator('[data-slot="schedule-chip"]').click();
    const card = desktop.locator('[data-slot="schedule-popover"] [data-slot="schedule-card"]');
    await card.getByText("Run now · woke the thread").first().waitFor({ timeout: 10_000 });
    await card.getByText("Run now · nothing new").waitFor();
    await card.getByText("First run").waitFor();
    expect(await card.locator('[data-slot="schedule-card-ask"]').textContent()).toBe("To change the schedule, ask Personal agent.");
    await desktop.keyboard.press("Escape");
  } finally {
    await desktop.close();
  }

  const phone = await open(`/threads/${duty.threadId}`, { width: 390, height: 844 });
  try {
    const chip = phone.locator('[data-slot="phone-duty-row"] [data-slot="schedule-chip"]');
    await chip.waitFor({ timeout: 15_000 });
    // Under the title, which keeps its room.
    const title = await phone.getByText("greenhouse watch").first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(title).toBe(true);
    await chip.click();
    const sheet = phone.locator('[data-slot="schedule-sheet"] [data-slot="schedule-card"]');
    await sheet.getByText("Run now · woke the thread").first().waitFor({ timeout: 10_000 });
    await settle(phone);
    const box = await phone.locator('[data-slot="schedule-sheet"]').boundingBox();
    expect(box !== null && box.width <= 390 && box.y > 0).toBe(true);
  } finally {
    await phone.close();
  }
}, 60_000);
