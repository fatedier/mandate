import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { startServer, type RunningServer } from "./helpers/server";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { seedProject } from "../tests/helpers/fixtures.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { formatWorkerReportText, workerReportMetadata, type WorkerReport } from "../src/shared/worker-report";
import { API_ROUTES } from "../src/shared/api-contracts";
import type { ManagerThreadDto } from "../src/shared/api/agents";
import { createManagerStopCheckStore } from "../src/server/modules/manager-checks/stop/store.js";
import { everyWaitingRow } from "./helpers/home-rows";
import { seedJudgedThread, managerStopCheckOn } from "./helpers/status-seeds";
import { motionEnded } from "./helpers/animations";

// The real binary: the New badge is the server's lastVisibleSeq against the
// seen mark the page posts, not a fixture's say-so.
const browser = browserForFile();
let server: RunningServer;
let ids: { a: string; b: string; worker: string };

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      managerStopCheckOn(dataDir);
      const store = new MandateStore(dataDir);
      const projects = new ProjectsStore(store.db);
      const features = new FeaturesStore(store.db);
      const agent = new AgentStore(store.db);
      const projectId = seedProject(projects, { name: "project-1", tmuxSessionName: "md-project-1-report" });
      const a = agent.createManagerThread("project-2 cache expiry");
      const b = agent.createManagerThread("Sidebar");
      agent.appendMessage({ threadId: b.id, role: "user", source: "user", content: { type: "text", text: "Tighten the sidebar rows" } });
      const worker = features.insert({
        projectId, name: "evicthook", mode: "shared-cwd", branch: null, worktreePath: null,
        tmuxWindowName: "evicthook", ownership: "app", ownerThreadId: a.id
      });
      new PlanStore(store.db).update(worker, {
        conclusion: "EvictHook wired; tests pass",
        steps: [{ title: "Wire EvictHook into the cache expiry", status: "done", note: "commit 5e1f0a2" }]
      });
      const report: WorkerReport = {
        featureId: worker, featureName: "evicthook", projectId, projectName: "project-1",
        key: "done", line: "EvictHook wired; tests pass"
      };
      // A worker's report, then its manager's reply,
      // which the manager stop check found has a result for the user to read.
      agent.appendMessage({
        threadId: a.id, role: "user", source: "worker-report",
        content: { type: "text", text: formatWorkerReportText(report), metadata: workerReportMetadata(report) }
      });
      const reply = agent.appendMessage({ threadId: a.id, role: "assistant", source: "self", content: { type: "assistant", text: "EvictHook is wired into the cache expiry; the tests pass." } });
      createManagerStopCheckStore(store.db).set(a.id, { replySeq: reply.seq, outcome: "result", judgedAt: new Date().toISOString() });
      // Another thread with a result to read, for the page that is not its own.
      seedJudgedThread(store.db, agent, "Release notes", "result", "The release notes for 3.21 are drafted.");
      // A thread whose only news is a worker's report: the report alone marks it New.
      const metrics = agent.createManagerThread("Cache metrics");
      const metricsReport: WorkerReport = { ...report, line: "Hit rate measured: 92%" };
      agent.appendMessage({
        threadId: metrics.id, role: "user", source: "worker-report",
        content: { type: "text", text: formatWorkerReportText(metricsReport), metadata: workerReportMetadata(metricsReport) }
      });
      ids = { a: a.id, b: b.id, worker };
      store.db.close();
    }
  });
}, 60_000);

afterAll(async () => {
  server?.cleanup();
});

test("a report marks its thread New; its result to read is blue and on Home, leads into the thread, and goes once read; the card opens its worker", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/home`);
    const threads = page.locator('[role="group"][aria-label="Threads"]');
    const aUnread = threads.locator('[data-thread-title="project-2 cache expiry"][data-unread]');
    const b = threads.locator('[data-thread-title="Sidebar"]');
    await aUnread.waitFor();
    await b.waitFor();
    expect(await b.getAttribute("data-unread")).toBe(null);
    // A worker's report alone marks its thread New.
    await threads.locator('[data-thread-title="Cache metrics"][data-unread]').waitFor();
    const mark = (state: string) => threads.locator(`[data-thread-title="project-2 cache expiry"] [role="img"][aria-label="state: ${state}"]`);
    await mark("result to read").waitFor();

    // Home: its row, with the reply it is about.
    const row = (await everyWaitingRow(page)).filter({ hasText: "project-2 cache expiry" });
    await row.waitFor();
    expect(await row.getAttribute("data-waiting")).toBe("result");
    expect(await row.textContent()).toContain("Result to read");
    expect(await row.textContent()).toContain("EvictHook is wired into the cache expiry; the tests pass.");

    // Into the thread: the report reads.
    await row.click();
    await page.waitForURL(`${server.baseUrl}/threads/${ids.a}`);
    const card = page.locator('[data-slot="worker-report"][data-key="done"]');
    await card.getByText("EvictHook wired; tests pass").waitFor();

    // On screen, so seen — and the server holds it, not just this page; the
    // result read, the thread is no longer blue.
    await aUnread.waitFor({ state: "detached" });
    const held = async () => {
      const { threads } = await (await fetch(`${server.baseUrl}${API_ROUTES.agentManagerThreads}`)).json() as { threads: ManagerThreadDto[] };
      const thread = threads.find((t) => t.id === ids.a)!;
      return thread.seenSeq >= thread.lastVisibleSeq && thread.lastVisibleSeq > 0;
    };
    await waitUntil(held, { timeout: 5000, interval: 50, label: "the server to hold the thread as seen" });
    expect(await held()).toBe(true);
    await mark("idle").waitFor();

    // The card opens its worker in the panel, on its plan.
    const panel = page.locator('[data-slot="worker-panel"]');
    await card.getByRole("button", { name: "Open in panel" }).click();
    await panel.locator(`[data-worker-tab="${ids.worker}"][aria-selected="true"]`).waitFor();
    await panel.getByRole("tab", { name: "Plan", exact: true, selected: true }).waitFor();
    await panel.getByText("Wire EvictHook into the cache expiry").waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("the thread page's own controls: another thread's result dot and the count in its colour, nothing over the transcript, no count the panel already shows", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${ids.a}`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.waitFor();
    // Another thread stopped on a result for the user: its dot is blue, and
    // with only results to read the count on New thread is in that colour.
    await page.locator('[role="group"][aria-label="Threads"] [data-thread-title="Release notes"] [role="img"][aria-label="state: result to read"]').waitFor();
    const badge = page.locator('[data-slot="new-thread"] [role="img"][aria-label$=" to look at"]');
    await badge.waitFor();
    const colour = (selector: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).color, selector);
    const reviewColour = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "text-status-review";
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(await colour('[data-slot="new-thread"] [role="img"]')).toBe(reviewColour);
    expect(await badge.count()).toBe(1);

    // No measurement yet: no context meter at all.
    const header = page.locator('[data-slot="pane-header"]');
    expect(await header.textContent()).not.toContain("--");
    // The panel holds reports beside the workers: the header button says
    // Panel and counts nothing; the panel's Workers tab counts.
    expect((await page.locator('[data-slot="panel-toggle"][aria-label="Hide panel"]').textContent())?.trim()).toBe("Panel");

    // Nothing floats over the transcript: the chat column holds no control of
    // its own; the header's Workers toggle gives the chat the whole row.
    const chat = page.locator('[data-slot="thread-chat"]');
    expect(await chat.locator("[data-pane-zoom]").count()).toBe(0);
    const shots = artifactDir("thread-page-controls");
    await page.screenshot({ path: path.join(shots, "split.png") });

    // Hidden: the same toggle brings it back, and still counts nothing.
    await page.locator('[data-slot="panel-toggle"][aria-label="Hide panel"]').click();
    await panel.waitFor({ state: "detached" });
    expect((await page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]').textContent())?.trim()).toBe("Panel");
    await page.screenshot({ path: path.join(shots, "chat-alone.png") });
    await page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]').click();
    await panel.waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("a narrow window shows one side of the thread at a time, whole", async () => {
  const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${ids.a}`);
    const chat = page.locator('[data-slot="thread-chat"]');
    const panel = page.locator('[data-slot="worker-panel"]');
    const width = async (locator: typeof chat) => Math.round((await locator.boundingBox())!.width);
    // The row both sides share: the chat's parent.
    const rowWidth = () => chat.evaluate((el) => Math.round(el.parentElement!.getBoundingClientRect().width));
    // 820 less the sidebar leaves a row under 720px: too narrow for both, so
    // the chat has it alone and the toggle offers the panel.
    const show = page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]');
    await show.waitFor();
    expect(await rowWidth()).toBeLessThan(720);
    expect(await panel.count()).toBe(0);
    expect(await width(chat)).toBe(await rowWidth());
    const shots = artifactDir("thread-narrow-row");
    await page.screenshot({ path: path.join(shots, "chat.png") });

    // The panel takes the row in the chat's place, with nothing to maximize.
    await show.click();
    await panel.waitFor();
    // It slides over the chat, which goes once covered.
    await chat.waitFor({ state: "hidden" });
    expect(await chat.isVisible()).toBe(false);
    expect(await width(panel)).toBe(await rowWidth());
    expect(await panel.locator("[data-pane-zoom]").count()).toBe(0);
    await page.screenshot({ path: path.join(shots, "panel.png") });

    // However many tabs it holds, the panel keeps to the row: its tab strip
    // scrolls and Hide stays on screen.
    await page.evaluate((thread) => {
      const key = "mandate.worker-panel.v1";
      const saved = JSON.parse(localStorage.getItem(key)!);
      const tabs = Array.from({ length: 12 }, (_, i) => `gone-worker-${i}`);
      saved.state.byThread[thread] = { ...saved.state.byThread[thread], tabs, active: "workers" };
      localStorage.setItem(key, JSON.stringify(saved));
    }, ids.a);
    await page.reload();
    await page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]').click();
    await panel.waitFor();
    await motionEnded(page, "worker-panel");
    expect(await width(panel)).toBe(await rowWidth());
    expect(await panel.getByRole("button", { name: "Hide panel" }).isVisible()).toBe(true);
    const hide = (await panel.getByRole("button", { name: "Hide panel" }).boundingBox())!;
    expect(hide.x + hide.width).toBeLessThanOrEqual(820);
    await page.screenshot({ path: path.join(shots, "panel-many-tabs.png") });

    // A wide window has both again; narrowing again shows the chat.
    await page.setViewportSize({ width: 1440, height: 900 });
    await chat.waitFor({ state: "visible" });
    expect(await width(chat) + await width(panel)).toBe(await rowWidth());
    await page.setViewportSize({ width: 820, height: 900 });
    await panel.waitFor({ state: "detached" });
    expect(await width(chat)).toBe(await rowWidth());
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
