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
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { seedProject } from "../tests/helpers/fixtures.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { everyWaitingRow } from "./helpers/home-rows";
import { seedFailedThread } from "./helpers/status-seeds";
import { seedThreadNotice } from "./helpers/global-notice.js";
import { API_PATHS, API_ROUTES } from "../src/shared/api-contracts";
import type { ManagerThreadDto } from "../src/shared/api/agents";

/**
 * Each thread speaks for itself, through real turns: the model a stub that
 * speaks the Responses stream, and Decisions that same model with the stop
 * check on. A finished worker under a working manager leaves the thread
 * working; a manager that stops on a reply leaving the user a choice turns
 * its thread blue and puts it on Home until the reply is read; a round the
 * user drove in a thread Your agent sent a request reaches Your agent as a
 * line, waking nothing; with the manager stop check off the same stop is
 * asked nothing and stays as it is.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
const shots = () => artifactDir("thread-status");
const seeded = { cacheWork: "", releaseDates: "", searchTimeout: "", rolloutNotes: "" };
const calls = { managerStopChecks: 0, agentWakes: 0 };
/** Lets the held manager turn answer: made before the turn starts, so a
 *  release that comes before its request is not lost. */
let releaseSlow: () => void = () => {};
const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });

/** One model response: text, as the Responses stream sends it. */
function respond(id: string, text: string): Response {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } } }
    }
  ];
  return new Response(events.map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  let n = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const text = JSON.stringify(await request.json());
      n += 1;
      // The manager stop check first: its context quotes the thread's own messages.
      if (text.includes("A work thread has stopped")) {
        calls.managerStopChecks += 1;
        return respond(`s${n}`, text.includes("status-quiet") ? "{\"status\": \"result\"}" : "{\"status\": \"decision\"}");
      }
      // Your agent woken by a notice.
      if (text.includes("[Thread notice]")) {
        calls.agentWakes += 1;
        return respond(`g${n}`, "Noted.");
      }
      if (text.includes("status-slow")) {
        await slowGate;
        return respond(`m${n}`, "The cache work is wrapped up.");
      }
      if (text.includes("status-decide")) return respond(`m${n}`, "Two options: ship Friday, or wait for the fix?");
      if (text.includes("status-direct")) return respond(`m${n}`, "Tightened to one page. Ship it Friday, or hold for review?");
      if (text.includes("status-quiet")) return respond(`m${n}`, "Trimmed the notes to the three steps.");
      if (text.includes("status-off")) return respond(`m${n}`, "Raised the search timeout to 30 s.");
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${text.slice(0, 200)}` } }), { status: 500, headers: { "content-type": "application/json" } });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.models.providers.openai.type = "openai-compatible";
      config.models.providers.openai.baseURL = `http://127.0.0.1:${stub.port}/v1`;
      config.agent = {
        ...config.agent,
        decisionsEnabled: true,
        decisionsModel: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
        managerStopCheckEnabled: true,
        // Named, so its page is its chat rather than the first-run intro.
        globalAgentName: "Atlas"
      };
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const features = new FeaturesStore(store.db);
        const projectId = seedProject(new ProjectsStore(store.db), { name: "project-1", tmuxSessionName: "md-status" });
        seeded.cacheWork = agents.createManagerThread("Cache work").id;
        seeded.releaseDates = agents.createManagerThread("Release dates").id;
        seeded.searchTimeout = agents.createManagerThread("Search timeout").id;
        // Your agent sent it a request earlier, and heard its answer.
        seeded.rolloutNotes = agents.createManagerThread("Rollout notes").id;
        seedThreadNotice(store.db, agents, { threadId: seeded.rolloutNotes, title: "Rollout notes", stop: "stopped", reply: "Notes drafted." });
        // Red from the start: once its state is drawn, the status has come.
        seedFailedThread(agents, "Broken build", "provider returned 500");
        const worker = (name: string, ownerThreadId: string) => features.insert({
          projectId, name, mode: "shared-cwd", branch: null, worktreePath: null, tmuxWindowName: name, ownership: "app", ownerThreadId
        });
        // A worker whose plan is done, under "Cache work".
        const finished = worker("evicthook", seeded.cacheWork);
        new PlanStore(store.db).update(finished, { conclusion: "EvictHook wired", steps: [{ title: "Wire EvictHook", status: "done", note: "commit 5e1f0a2" }] });
      } finally {
        store.db.close();
      }
    }
  });
  // The model must be the stub: never let this test reach a real provider.
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== `http://127.0.0.1:${stub.port}/v1`) throw new Error(`the provider is not the stub: ${JSON.stringify(openai)}`);
}, 60_000);

afterAll(() => {
  releaseSlow();
  server?.cleanup();
  stub?.stop(true);
});

async function send(threadId: string, content: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/agents/threads/${threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content })
  });
  expect(response.status).toBe(202);
}

const mark = (page: Page, title: string) => page.locator(`[role="group"][aria-label="Threads"] [data-thread-title="${title}"] [role="img"]`);
/** Home's rows about `text`, the fold of rows to look at opened first. */
const homeRows = async (page: Page, text: string) => (await everyWaitingRow(page)).filter({ hasText: text });

async function open(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}${url}`);
  return page;
}

test("a finished worker under a working manager: the thread reads working, never its worker's state", async () => {
  await send(seeded.cacheWork, "status-slow: wrap up the cache work");
  const page = await open("/home");
  try {
    await page.locator('[data-thread-title="Cache work"] [role="img"][aria-label="state: working"]').waitFor();
    // While the turn is held, it stays working.
    for (let i = 0; i < 5; i++) {
      expect(await mark(page, "Cache work").getAttribute("aria-label")).toBe("state: working");
      await page.waitForTimeout(200);
    }
    expect(await (await homeRows(page, "Cache work")).count()).toBe(0);
    await page.screenshot({ path: path.join(shots(), "working.png") });
  } finally {
    await page.close();
    // Let it answer and stop; its manager stop check is asked once.
    const before = calls.managerStopChecks;
    releaseSlow();
    await waitUntil(() => calls.managerStopChecks > before, { timeout: 20_000, label: "the held thread's manager stop check" });
  }
}, 60_000);

test("a manager that stops on a reply leaving a choice turns its thread blue and puts it on Home; reading the reply clears it", async () => {
  await send(seeded.releaseDates, "status-decide: pick the release date");
  const page = await open("/home");
  try {
    await page.locator('[data-thread-title="Release dates"] [role="img"][aria-label="state: decision needed"]').waitFor();
    // Two or more rows to look at fold into one: opened first.
    await page.locator('section[aria-label="Waiting on you"] :is([data-waiting], [data-slot="waiting-fold"])').first().waitFor();
    const row = (await everyWaitingRow(page)).filter({ hasText: "Release dates" });
    await row.waitFor();
    expect(await row.getAttribute("data-waiting")).toBe("decision");
    expect(await row.textContent()).toContain("Decision needed");
    expect(await row.textContent()).toContain("Two options: ship Friday, or wait for the fix?");
    await page.screenshot({ path: path.join(shots(), "decision-home.png") });

    // Opened, the reply is read: the thread rests, and Home lists it no more.
    await row.click();
    await page.waitForURL(`${server.baseUrl}/threads/${seeded.releaseDates}`);
    await page.getByText("Two options: ship Friday, or wait for the fix?").waitFor();
    await page.locator('[data-thread-title="Release dates"] [role="img"][aria-label="state: idle"]').waitFor();
    await page.goto(`${server.baseUrl}/home`);
    await page.getByText("What should we work on?").waitFor();
    // The status has come (a thread only it reads red is drawn so) before reading Home's rows.
    await page.locator('[data-thread-title="Broken build"] [role="img"][aria-label="state: failed or stopped"]').waitFor();
    expect(await (await everyWaitingRow(page)).filter({ hasText: "Release dates" }).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);

// A decision is the user's to make: Your agent is woken to tell them.
// The user's own round: they have its reply in front of them, so even a
// decision it leaves is told quietly.
test("the user's own round in a thread Your agent sent a request: a decision it left reaches Your agent's chat as a line, waking nothing", async () => {
  const before = calls.agentWakes;
  await send(seeded.rolloutNotes, "status-direct: tighten the rollout notes");
  // Told on the server first: Your agent's conversation holds the notice.
  const agent = (await (await fetch(`${server.baseUrl}/api/agents/global`)).json() as { agent: { threadId: string } }).agent;
  const messagesOf = async (threadId: string) =>
    (await (await fetch(`${server.baseUrl}${API_PATHS.agentThread(threadId)}`)).json() as { messages: Array<{ source: string; content: { metadata?: { threadNotice?: { direct?: boolean } } } }> }).messages;
  await waitUntil(async () => (await messagesOf(agent.threadId)).some((m) => m.source === "thread-notice" && m.content.metadata?.threadNotice?.direct === true), { timeout: 20_000, label: "the quiet notice in Your agent's conversation" });
  const page = await open("/agent");
  try {
    const line = page.locator('[data-slot="provenance-label"]').filter({ hasText: "decision needed" });
    await line.waitFor();
    expect((await line.innerText()).trim()).toBe("Rollout notes · decision needed");
    expect(await line.locator('[data-slot="provenance-link"]').getAttribute("href")).toBe(`/threads/${seeded.rolloutNotes}`);
    await page.screenshot({ path: path.join(shots(), "quiet-notice.png") });
    await page.waitForTimeout(1500);
    expect(calls.agentWakes).toBe(before);
  } finally {
    await page.close();
  }
}, 60_000);

test("a result of the user's own round reaches Your agent's chat as a line, waking nothing", async () => {
  const agent = (await (await fetch(`${server.baseUrl}/api/agents/global`)).json() as { agent: { threadId: string } }).agent;
  const resultNotices = async () =>
    ((await (await fetch(`${server.baseUrl}${API_PATHS.agentThread(agent.threadId)}`)).json()) as { messages: Array<{ source: string; content: { metadata?: { threadNotice?: { direct?: boolean; verdict?: string } } } }> }).messages
      .filter((m) => m.source === "thread-notice" && m.content.metadata?.threadNotice?.direct === true && m.content.metadata.threadNotice.verdict === "result").length;
  const before = calls.agentWakes;
  await send(seeded.rolloutNotes, "status-quiet: trim the rollout notes");
  await waitUntil(async () => (await resultNotices()) > 0, { timeout: 20_000, label: "the quiet result notice in Your agent's conversation" });
  const page = await open("/agent");
  try {
    const line = page.locator('[data-slot="provenance-label"]').filter({ hasText: "result to read" });
    await line.waitFor();
    expect((await line.innerText()).trim()).toBe("Rollout notes · result to read");
    await page.waitForTimeout(1500);
    expect(calls.agentWakes).toBe(before);
  } finally {
    await page.close();
  }
}, 60_000);

test("with the manager stop check off, the same stop asks it nothing and the thread does not turn blue", async () => {
  const saved = await fetch(`${server.baseUrl}/api/settings/config`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: { managerStopCheckEnabled: false } })
  });
  expect(saved.status).toBe(200);
  const before = calls.managerStopChecks;
  await send(seeded.searchTimeout, "status-off: raise the search timeout");
  const page = await open(`/home`);
  try {
    await page.locator('[data-thread-title="Broken build"] [role="img"][aria-label="state: failed or stopped"]').waitFor();
    // Its reply is in, and it has stopped: idle, not blue.
    await waitUntil(async () => {
      const { threads } = await (await fetch(`${server.baseUrl}${API_ROUTES.agentManagerThreads}`)).json() as { threads: ManagerThreadDto[] };
      const thread = threads.find((t) => t.id === seeded.searchTimeout);
      return Boolean(thread && !thread.running && thread.lastVisibleSeq > 0);
    }, { timeout: 20_000, label: "the search-timeout reply" });
    await page.locator('[data-thread-title="Search timeout"] [role="img"][aria-label="state: idle"]').waitFor();
    await page.waitForTimeout(1500);
    expect(await mark(page, "Search timeout").getAttribute("aria-label")).toBe("state: idle");
    expect(await (await homeRows(page, "Search timeout")).count()).toBe(0);
    expect(calls.managerStopChecks).toBe(before);
  } finally {
    await page.close();
  }
}, 60_000);
