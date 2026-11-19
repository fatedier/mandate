import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { seedProject } from "../tests/helpers/fixtures.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { settle, trackRequests } from "./helpers/settle.js";
import { assertStubProvider, respond, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * The personal agent through real turns, the model a stub that answers by
 * whose conversation it is reading: the guide names it; a named worker gets
 * the agent's message straight away, and when it stops the agent is woken by
 * a one-line notice; work that names no worker goes to a thread at once, with
 * no question; what the agent says after a notice, while the user is
 * elsewhere, lights the sidebar row; the agent is told when a thread has
 * stopped, not when its manager's turn ends; what it sent is folded on its
 * card until opened; stopped for a call it kept failing, it is still told
 * when what it follows stops; a question it can answer by looking is answered
 * with a command.
 */

const PERSONAL_MARK = "You are the user's personal agent above all of Mandate's threads";
let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
const seeded = { managerId: "", workerId: "", spikeThreadId: "", spikeWorkerId: "" };
/** While set, the worker's model holds its reply until the test releases it. */
let workerGate: Promise<void> | null = null;

let calls = 0;
/** The tools the provider was offered for the personal agent's last turn. */
let personalTools: string[] = [];

/** What the stub's personal agent says when it is woken by a notice. */
const HEARD = "Heard back.";

/** What the stub's personal agent says once it has sent work to a thread. */
const ASKED = "Sent it to Docs overhaul.";

/** A message long enough to fold on its card and to fill more than a screen
 *  once opened: sixty paragraphs. */
const LONG_BRIEF = Array.from({ length: 60 }, (_, i) => `Part ${i + 1}: write up the story of the install script: who asked for it, why it stays, and when to look again.`).join("\n\n");

/** What the user types, and what the stub's personal agent does about it. */
const ASKS = [
  { text: "Tell release to keep the old install script for now and drop it next version.", done: "Sent it to release.",
    call: () => ({ name: "message_worker", args: { workerId: seeded.workerId, text: "Keep the old install script for now and drop it next version." } }) },
  { text: "Open a worker and find out if that 15 PR is safe.", done: ASKED,
    call: () => ({ name: "send_to_thread", args: { threadId: seeded.managerId, text: "Check whether PR 15 is safe to merge." } }) },
  { text: "Check the install script one more time.", done: "Asked release again.",
    call: () => ({ name: "message_worker", args: { workerId: seeded.workerId, text: "Keep the old install script; check it one more time." } }) },
  // Sent while a worker of that thread is still running (the gate holds it).
  { text: "Have the thread sum up what it found on 15.", done: "Sent that to Docs overhaul too.",
    call: () => ({ name: "send_to_thread", args: { threadId: seeded.managerId, text: "Sum up PR 15 in three sentences." } }) },
  { text: "Have release write up the story of the install script.", done: "Asked release to write it up.",
    call: () => ({ name: "message_worker", args: { workerId: seeded.workerId, text: LONG_BRIEF } }) },
  // A call that fails the same way each time (it names no thread), made again
  // and again: the turn is stopped at the fifth.
  { text: "Read the thread that cannot be read.", done: "", again: true,
    call: () => ({ name: "read_thread", args: {} }) },
  // A question it can answer by looking: it runs a command, and hands nothing off.
  { text: "Can you run a command on this machine right now?", done: "It can: the command printed its marker.",
    call: () => ({ name: "bash", args: { command: "echo MANDATE_E2E_SHELL_OK", description: "Print a marker" } }) },
  // A thread the user wants put away: it archives it, with its worker.
  { text: "Archive the Old spike thread.", done: "Archived Old spike.",
    call: () => ({ name: "archive_thread", args: { threadId: seeded.spikeThreadId } }) }
];
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
      if (all.includes(PERSONAL_MARK)) {
        personalTools = ((body.tools ?? []) as Array<{ name?: string }>).map((tool) => tool.name ?? "");
        // The personal agent. The ask is the latest of the known ones in its
        // input (each is sent once); it calls the tool for it once, and once
        // a tool output follows the ask, says it is done.
        const asks = ASKS.map((ask) => ({ ask, at: input.lastIndexOf(JSON.stringify(ask.text).slice(1, -1)) })).filter((a) => a.at >= 0);
        const latest = asks.sort((a, b) => b.at - a.at)[0];
        // Woken by a notice that came after the latest ask, and not answered yet.
        const noticeAt = input.lastIndexOf("[Thread notice]");
        if (noticeAt > (latest?.at ?? -1) && noticeAt > input.lastIndexOf(HEARD)) return respond(`g${calls}`, { text: HEARD });
        if (!latest) return respond(`g${calls}`, { text: "Nothing waits on you." });
        const answered = input.lastIndexOf("function_call_output") > latest.at && !("again" in latest.ask);
        return answered ? respond(`g${calls}`, { text: latest.ask.done }) : respond(`g${calls}`, { call: latest.ask.call() });
      }
      // The manager's thread first: it also reads what the user told its
      // worker (a note), so the worker's words are in its input too.
      if (input.includes("in three sentences")) return respond(`m${calls}`, { text: "Done: the three sentences are above." });
      if (input.includes("Check whether PR 15")) return respond(`m${calls}`, { text: "On it." });
      if (input.includes("Keep the old install script")) {
        if (workerGate) await workerGate;
        const said = input.includes("one more time") ? "Confirmed: the install script stays." : "OK, the install script **stays**.";
        return respond(`w${calls}`, { text: said });
      }
      return respond(`x${calls}`, { text: "Noted." });
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
        seeded.managerId = agents.createManagerThread("Docs overhaul").id;
        const projectId = seedProject(projects, { name: "mandate", tmuxSessionName: "md-global" });
        seeded.workerId = workers.insert({
          projectId, name: "release", mode: "shared-cwd", branch: null, worktreePath: null,
          tmuxWindowName: "release", ownership: "app", ownerThreadId: seeded.managerId
        });
        agents.getOrCreateThread("worker", seeded.workerId);
        // A second thread with a worker of its own, for the agent to archive.
        seeded.spikeThreadId = agents.createManagerThread("Old spike").id;
        seeded.spikeWorkerId = workers.insert({
          projectId, name: "spike", mode: "shared-cwd", branch: null, worktreePath: null,
          tmuxWindowName: "spike", ownership: "app", ownerThreadId: seeded.spikeThreadId
        });
        agents.getOrCreateThread("worker", seeded.spikeWorkerId);
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

async function open(pathname: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  attachPageDiagnostics(page);
  const requests = await trackRequests(page);
  await page.goto(`${server.baseUrl}${pathname}`);
  await requests.idle();
  return page;
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByPlaceholder("Ask about any thread or worker, or tell one what to do");
  await box.fill(text);
  await box.press("Enter");
}

test("unnamed, the row says the personal agent and the page is the guide; Start names it", async () => {
  const page = await open("/agent");
  try {
    await page.locator('[data-slot="personal-agent"]').getByText("Personal agent").waitFor({ timeout: 15_000 });
    await page.getByText("What should I be called?").waitFor();
    await page.locator("#personal-agent-name").fill("Jarvis");
    await page.getByText("Hi, I'm Jarvis.").waitFor();
    await page.locator('[data-slot="personal-agent-start"]').click();
    await page.getByText("Sees every thread and worker").waitFor({ timeout: 15_000 });
    await page.locator('[data-slot="personal-agent"]').getByText("Jarvis").waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

test("an empty composer grows when the page narrows and its placeholder wraps, and draws no scrollbar", async () => {
  // Seen on a phone: measured only on typing, the box stayed one line short of
  // a placeholder that wrapped later, and showed a scrollbar for the rest.
  const page = await browser.newPage({ viewport: { width: 600, height: 900 } });
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/agent`);
    const box = page.getByPlaceholder("Ask about any thread or worker, or tell one what to do");
    await box.waitFor();
    const fit = () => box.evaluate((el: HTMLTextAreaElement) => ({ height: el.clientHeight, content: el.scrollHeight, overflowY: getComputedStyle(el).overflowY }));
    const wide = await fit();
    await page.setViewportSize({ width: 340, height: 900 });
    await page.waitForFunction(() => {
      const el = document.querySelector("textarea")!;
      return el.clientHeight >= el.scrollHeight;
    }, null, { timeout: 2000 }).catch(() => {});
    const narrow = await fit();
    expect(narrow.content).toBeGreaterThan(wide.content); // the placeholder wrapped
    expect(narrow.height).toBeGreaterThanOrEqual(narrow.content);
    expect(narrow.overflowY).toBe("hidden");
  } finally {
    await page.close();
  }
}, 30_000);

/** Whether `upper` ends above where `lower` begins. */
async function above(upper: ReturnType<Page["locator"]>, lower: ReturnType<Page["locator"]>): Promise<boolean> {
  const [a, b] = await Promise.all([upper.boundingBox(), lower.boundingBox()]);
  return a !== null && b !== null && a.y + a.height <= b.y + 0.5;
}

/** How many of `selector` (holding `text`) the page draws after the user's
 *  latest message that says `said`; -1 with no such message. Only what came
 *  after it: the page draws a conversation's latest rows first and its older
 *  ones a moment later, above them, so a count of all of them can still grow. */
function drawnAfter(page: Page, said: string, selector: string, text = ""): Promise<number> {
  return page.evaluate(([said, selector, text]) => {
    const bubble = [...document.querySelectorAll('[data-slot="user-bubble"]')].filter((el) => el.textContent?.includes(said)).at(-1);
    if (!bubble) return -1;
    return [...document.querySelectorAll(selector)]
      .filter((el) => (el.textContent ?? "").includes(text) && (bubble.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).length;
  }, [said, selector, text] as const);
}

test("a named worker gets the agent's message now; when it stops the agent is woken by a one-line notice, and the worker's chat says via Jarvis", async () => {
  const page = await open("/agent");
  try {
    await send(page, "Tell release to keep the old install script for now and drop it next version.");
    const card = page.locator('[data-slot="handoff-card"]').filter({ hasText: "Sent to release" });
    await card.waitFor({ timeout: 20_000 });
    // What the agent told the worker is on its line.
    expect((await card.locator('[data-slot="handoff-first"]').innerText()).trim()).toBe("Keep the old install script for now and drop it next version.");
    await page.getByText("Sent it to release.").last().waitFor({ timeout: 20_000 });
    // The worker answered and stopped: that woke the agent, which
    // has a turn of its own after it.
    await page.getByText(HEARD).first().waitFor({ timeout: 30_000 });
    // The notice that woke it is one line over its words: who stopped, and how.
    const noticeLine = page.locator('[data-slot="provenance-label"]').filter({ hasText: /^release · / }).first();
    await noticeLine.waitFor({ timeout: 15_000 });
    expect(await page.locator('[data-slot="user-bubble"]').filter({ hasText: "[Thread notice]" }).count()).toBe(0);
    // In its row: the line, then what the agent said. Under the card and what it said when it sent.
    const heard = page.getByText(HEARD).first();
    expect(await above(noticeLine, heard)).toBe(true);
    expect(await above(card, noticeLine)).toBe(true);
    expect(await above(page.getByText("Sent it to release.").last(), noticeLine)).toBe(true);
    // What the worker said is not drawn in the conversation: the agent has read it.
    expect(await page.locator('[data-slot="handoff-outcome"]').count()).toBe(0);
    expect(await page.getByText("the install script stays.").count()).toBe(0);
    // The line's name opens what was sent, with the way to the worker's chat,
    // in the panel of the thread that owns it.
    const workerChat = `/threads/${seeded.managerId}?worker=${seeded.workerId}&tab=chat`;
    await card.locator('[data-slot="handoff-target"]').click();
    const sentBox = page.locator('[data-slot="handoff-peek"]');
    expect((await sentBox.locator('[data-slot="handoff-peek-body"]').innerText()).trim()).toBe("Keep the old install script for now and drop it next version.");
    expect(await sentBox.locator('[data-slot="handoff-open"]').getAttribute("href")).toBe(workerChat);
    await page.keyboard.press("Escape");
    await sentBox.waitFor({ state: "detached" });
    // The worker's name on the notice opens it in place, as the worker wrote it, and the page stays.
    await noticeLine.locator('[data-slot="notice-name"]').click();
    const said = page.locator('[data-slot="thread-reply"]');
    await said.waitFor();
    expect((await said.locator('[data-slot="thread-reply-body"]').innerText()).trim()).toBe("OK, the install script stays.");
    expect(await said.locator('[data-slot="thread-reply-body"] strong').innerText()).toBe("stays");
    expect(new URL(page.url()).pathname).toBe("/agent");
    // Its button leads there too.
    const go = said.locator('[data-slot="thread-reply-go"]');
    expect([(await go.innerText()).trim(), await go.getAttribute("href")]).toEqual(["Open worker", workerChat]);
    // The worker's own chat (a planning worker opens on Plan without the tab):
    // the message, labelled as passed on, and the worker's answer.
    await go.click();
    await page.waitForURL((url) => url.pathname === `/threads/${seeded.managerId}`);
    // The owner thread's own chat sits beside it: the worker's is the panel's.
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.locator(`[data-worker-tab="${seeded.workerId}"][aria-selected="true"]`).waitFor({ timeout: 15_000 });
    await panel.getByPlaceholder("Message the worker…").waitFor({ timeout: 15_000 });
    const relayed = panel.locator('[data-slot="user-bubble"]').filter({ hasText: "Keep the old install script for now and drop it next version." });
    await relayed.first().waitFor({ timeout: 15_000 });
    expect((await relayed.first().innerText()).trim()).toBe("Keep the old install script for now and drop it next version.");
    await panel.locator('[data-slot="relay-label"]').filter({ hasText: "via Jarvis" }).first().waitFor({ timeout: 15_000 });
    await panel.getByText("stays").first().waitFor({ timeout: 15_000 });
  } finally {
    await page.close();
  }
}, 90_000);

test("work that names no worker goes to a thread at once, with no question; the card opens the thread", async () => {
  const page = await open("/agent");
  try {
    await send(page, "Open a worker and find out if that 15 PR is safe.");
    const card = page.locator('[data-slot="handoff-card"]').filter({ hasText: "Docs overhaul" }).last();
    await card.waitFor({ timeout: 20_000 });
    await page.getByText(ASKED).last().waitFor({ timeout: 20_000 });
    // Nothing to confirm: it is already in the thread, as the user's message,
    // marked as passed on. Its one button, the thread's name, opens what was sent.
    expect(await card.locator("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("data-slot")))).toEqual(["handoff-target"]);
    const thread = await (await fetch(`${server.baseUrl}/api/agents/threads/${seeded.managerId}`)).json() as { messages: unknown[] };
    expect(JSON.stringify(thread.messages)).toContain("Check whether PR 15");
    // The card stands where it was sent, above the sentence the agent wrote after it.
    await page.waitForFunction(() => document.querySelector('[data-slot="streaming-reply"]') === null);
    const order = await card.evaluate((el, text) => {
      const sentence = [...document.querySelectorAll('[data-slot="transcript-row"] p')].filter((p) => p.textContent === text).at(-1);
      return sentence ? { cardOverSentence: el.getBoundingClientRect().bottom <= sentence.getBoundingClientRect().top + 0.5 } : "no sentence";
    }, ASKED);
    expect(order).toEqual({ cardOverSentence: true });
    // The thread answered and stopped: the agent was woken by its notice.
    await page.locator('[data-slot="provenance-label"]').filter({ hasText: "Docs overhaul · " }).last().waitFor({ timeout: 30_000 });
    // The line says what the agent told the thread, and its box opens the thread that did the work.
    expect((await card.locator('[data-slot="handoff-first"]').innerText()).trim()).toBe("Check whether PR 15 is safe to merge.");
    expect(await card.locator('[data-slot="handoff-state"]').count()).toBe(0);
    await card.locator('[data-slot="handoff-target"]').click();
    await page.locator('[data-slot="handoff-peek"] [data-slot="handoff-open"]').click();
    await page.waitForURL(new RegExp(`/threads/${seeded.managerId}$`));
    // The thread's own message, not the agent page's line it left.
    await page.locator('[data-slot="user-bubble"]').filter({ hasText: "Check whether PR 15 is safe to merge." }).last().waitFor({ timeout: 15_000 });
    await page.locator('[data-slot="relay-label"]').filter({ hasText: "via Jarvis" }).last().waitFor();
  } finally {
    await page.close();
  }
}, 90_000);

test("what the agent says after a notice, while the user is elsewhere, lights the row; opening the page clears it", async () => {
  let release!: () => void;
  workerGate = new Promise<void>((resolve) => { release = resolve; });
  const page = await open("/agent");
  const dot = page.locator('[data-slot="personal-agent-unread"]');
  try {
    const sentCards = page.locator('[data-slot="handoff-card"]').filter({ hasText: "Sent to release" });
    await sentCards.first().waitFor({ timeout: 20_000 });
    const before = await sentCards.count();
    await send(page, "Check the install script one more time.");
    await page.waitForFunction(
      (n) => [...document.querySelectorAll('[data-slot="handoff-card"]')].filter((el) => el.textContent?.includes("Sent to release")).length > n,
      before, { timeout: 20_000 }
    );
    // The agent's own answer, stored and marked seen here before leaving: the
    // dot later can only be what follows the worker's reply.
    await page.getByText("Asked release again.").waitFor({ timeout: 20_000 });
    await waitUntil(async () => {
      const agent = await serverAgent();
      const thread = await (await fetch(`${server.baseUrl}/api/agents/threads/${agent.threadId}`)).json() as { messages: Array<{ seq: number; content: { text?: string } }> };
      const answer = thread.messages.find((m) => m.content.text === "Asked release again.");
      return answer !== undefined && agent.lastVisibleSeq >= answer.seq && !agent.unread;
    }, { timeout: 15_000, interval: 200, label: "the agent's answer was stored and marked seen" });
    await page.goto(`${server.baseUrl}/home`);
    await page.locator('[data-slot="personal-agent"]').getByText("Jarvis").waitFor();
    expect(await dot.count()).toBe(0);
    release();
    await dot.waitFor({ timeout: 30_000 });
    await page.locator('[data-slot="personal-agent"]').click();
    await dot.waitFor({ state: "detached", timeout: 15_000 });
    // It was the notice and the agent's words after it: the newest things on the page.
    const heard = page.getByText(HEARD).last();
    await heard.waitFor({ timeout: 15_000 });
    expect(await above(page.getByText("Asked release again.").last(), heard)).toBe(true);
    // Recorded, not only hidden here: the server says so, and a reload keeps it clear.
    await waitUntil(async () => !(await serverUnread()), { timeout: 15_000, interval: 200, label: "the server recorded the seen mark" });
    await page.reload();
    await page.locator('[data-slot="personal-agent"]').getByText("Jarvis").waitFor();
    expect(await dot.count()).toBe(0);
  } finally {
    release();
    workerGate = null;
    await page.close();
  }
}, 90_000);

// The manager's turn ending is not the thread stopping. While a worker of the
// thread still runs, the agent is not told; when the worker stops, it is,
// once, and it is woken.
test("the agent is not told when the manager's turn ends while a worker still runs; it is told when the thread stops", async () => {
  let release!: () => void;
  workerGate = new Promise<void>((resolve) => { release = resolve; });
  const page = await open("/agent");
  try {
    // The thread's notices after this test's first message.
    const threadNotices = () => drawnAfter(page, "Check the install script one more time.", '[data-slot="provenance-label"]', "Docs overhaul · ");
    await page.getByPlaceholder("Ask about any thread or worker, or tell one what to do").waitFor();
    // Earlier tests left the same sentences in this conversation: every wait
    // below is for a message after this point.
    const startSeq = Math.max(0, ...(await agentMessages()).map((m) => m.seq));
    // A worker of the thread starts and is held.
    await send(page, "Check the install script one more time.");
    await waitUntil(async () => (await agentMessages()).some((m) => m.seq > startSeq && m.content.text === "Asked release again."),
      { timeout: 20_000, interval: 200, label: "the agent asked the worker again" });
    // Work goes to the thread; its manager answers and its turn ends.
    await send(page, "Have the thread sum up what it found on 15.");
    await page.getByText("Sent that to Docs overhaul too.").waitFor({ timeout: 20_000 });
    await waitUntil(async () => {
      const thread = await (await fetch(`${server.baseUrl}/api/agents/threads/${seeded.managerId}`)).json() as { messages: Array<{ content: { text?: string } }> };
      return thread.messages.some((m) => m.content.text === "Done: the three sentences are above.");
    }, { timeout: 30_000, interval: 200, label: "the manager answered" });
    // The thread has not stopped: its worker is still running. No notice.
    await page.waitForTimeout(2500);
    expect(await threadNotices()).toBe(0);
    // The worker stops: now the thread has, and the agent is told once.
    release();
    await waitUntil(async () => (await threadNotices()) === 1, { timeout: 30_000, interval: 200, label: "one notice for the thread" });
    await page.waitForTimeout(1500);
    expect(await threadNotices()).toBe(1);
    // And it was woken by that notice: it spoke after it. (The worker's own
    // notice arrives beside it and is answered too; only words after the
    // thread's count.)
    await waitUntil(async () => {
      const messages = await agentMessages();
      const notice = messages.find((m) => m.seq > startSeq && noticeFor(m) === "thread:Docs overhaul");
      return notice !== undefined && messages.some((m) => m.seq > notice.seq && m.role === "assistant" && m.content.text === HEARD);
    }, { timeout: 20_000, interval: 200, label: "the agent spoke after the thread's notice" });
  } finally {
    release();
    workerGate = null;
    await page.close();
  }
}, 120_000);

// What the agent sent is one line, however long: a brief can run to a screen
// or more. Its name opens the whole of it in a box, and nothing in the
// conversation moves, at its end or anywhere.
test("what it sent is one line; its name opens all of it in a box, and the conversation stays where it is", async () => {
  const page = await open("/agent");
  try {
    await page.getByPlaceholder("Ask about any thread or worker, or tell one what to do").waitFor();
    const startSeq = Math.max(0, ...(await agentMessages()).map((m) => m.seq));
    await send(page, "Have release write up the story of the install script.");
    const card = page.locator('[data-slot="handoff-card"]').filter({ hasText: "Part 1:" });
    await card.waitFor({ timeout: 30_000 });
    // The worker has answered and the agent has spoken after its notice:
    // nothing more is on its way to move the page.
    await waitUntil(async () => {
      const messages = await agentMessages();
      const notice = messages.find((m) => m.seq > startSeq && noticeFor(m) === "worker:release");
      return notice !== undefined && messages.some((m) => m.seq > notice.seq && m.role === "assistant" && m.content.text === HEARD);
    }, { timeout: 30_000, interval: 200, label: "the agent spoke after the worker's notice" });
    // And the page has drawn it, last, and stopped moving.
    await page.waitForFunction((heard) => {
      const rows = document.querySelectorAll('[data-slot="transcript-row"]');
      return rows[rows.length - 1]?.textContent?.includes(heard) === true && document.querySelector('[data-slot="streaming-reply"]') === null;
    }, HEARD);
    await settle(page);
    const atEnd = () => page.evaluate(() => {
      const el = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
      return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
    });
    const place = async () => {
      const box = (await card.boundingBox())!;
      return { top: Math.round(box.y), height: Math.round(box.height) };
    };
    expect(await atEnd()).toBe(0);
    const before = await place();
    // One line of the run's height, its first line only.
    expect(before.height).toBeLessThanOrEqual(30);
    expect((await card.locator('[data-slot="handoff-first"]').innerText()).trim()).toBe("Part 1: write up the story of the install script: who asked for it, why it stays, and when to look again.");
    await card.locator('[data-slot="handoff-target"]').click();
    const sent = page.locator('[data-slot="handoff-peek"]');
    await sent.waitFor();
    const body = sent.locator('[data-slot="handoff-peek-body"]');
    expect(await body.locator("p").count()).toBe(60);
    expect((await body.locator("p").last().innerText()).trim()).toBe("Part 60: write up the story of the install script: who asked for it, why it stays, and when to look again.");
    // The box stays in the window, and scrolls inside itself.
    const boxed = (await sent.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(boxed.y >= 0 && boxed.y + boxed.height <= viewport.height).toBe(true);
    await settle(page);
    expect([await place(), await atEnd()]).toEqual([before, 0]);
    await page.keyboard.press("Escape");
    await sent.waitFor({ state: "detached" });
    expect([await place(), await atEnd()]).toEqual([before, 0]);
  } finally {
    await page.close();
  }
}, 90_000);

// A turn stopped for making the same failing call again and again used to
// leave the agent deaf: only the user's next message woke it, so a thread it
// followed stopped unheard and the times it had set passed. It must be able
// to recover by itself: the stop ends that turn and nothing more.
test("stopped for a call it kept failing, the agent is still told when what it follows stops", async () => {
  let release!: () => void;
  workerGate = new Promise<void>((resolve) => { release = resolve; });
  const page = await open("/agent");
  try {
    await page.getByPlaceholder("Ask about any thread or worker, or tell one what to do").waitFor();
    const startSeq = Math.max(0, ...(await agentMessages()).map((m) => m.seq));
    // It follows a worker, which is held at work.
    await send(page, "Check the install script one more time.");
    await waitUntil(async () => (await agentMessages()).some((m) => m.seq > startSeq && m.content.text === "Asked release again."),
      { timeout: 20_000, interval: 200, label: "the agent asked the worker again" });
    // Then a turn in which it makes one failing call until it is stopped.
    const stops = page.locator('[data-slot="wake-failure"][data-status="stuck"]');
    const stopsBefore = await stops.count();
    await send(page, "Read the thread that cannot be read.");
    await waitUntil(async () => (await stops.count()) > stopsBefore, { timeout: 30_000, interval: 200, label: "the turn was stopped" });
    expect(await stops.last().innerText()).toContain("read_thread failed 5 times in a row");
    const stoppedSeq = Math.max(0, ...(await agentMessages()).map((m) => m.seq));
    const notices = page.locator('[data-slot="provenance-label"]').filter({ hasText: "release · " });
    const noticesBefore = await notices.count();
    // The worker stops. The agent is told, and speaks.
    release();
    await waitUntil(async () => {
      const messages = await agentMessages();
      const notice = messages.find((m) => m.seq > stoppedSeq && noticeFor(m) === "worker:release");
      return notice !== undefined && messages.some((m) => m.seq > notice.seq && m.role === "assistant" && m.content.text === HEARD);
    }, { timeout: 30_000, interval: 200, label: "the agent, stopped before, spoke after the worker's notice" });
    await waitUntil(async () => (await notices.count()) > noticesBefore, { timeout: 15_000, interval: 200, label: "the notice's line is on the page" });
  } finally {
    release();
    workerGate = null;
    await page.close();
  }
}, 120_000);

// A question the agent can answer by
// looking is answered here, by a command it runs itself. Before, it had no
// shell and could only hand the question to a thread.
test("a question it can answer by looking is answered with a command, and no handoff is made", async () => {
  const page = await open("/agent");
  try {
    await page.getByPlaceholder("Ask about any thread or worker, or tell one what to do").waitFor();
    await send(page, "Can you run a command on this machine right now?");
    await page.getByText("It can: the command printed its marker.").waitFor({ timeout: 30_000 });
    expect(await drawnAfter(page, "Can you run a command on this machine right now?", '[data-slot="handoff-card"]')).toBe(0);
    // The command ran on the server, once, and its output is the tool's result.
    const agent = await serverAgent();
    const thread = await (await fetch(`${server.baseUrl}/api/agents/threads/${agent.threadId}`)).json() as { messages: Array<{ content: { type: string; toolName?: string; result?: unknown; isError?: boolean } }> };
    const ran = thread.messages.filter((m) => m.content.type === "tool_result" && m.content.toolName === "bash");
    expect(ran.map((m) => [m.content.isError ?? false, String(m.content.result).includes("MANDATE_E2E_SHELL_OK")])).toEqual([[false, true]]);
    // On the page the turn reads as a command it ran, like any agent's.
    await page.locator('[data-slot="tool-run-line"]').filter({ hasText: "Print a marker" }).waitFor({ timeout: 10_000 });
    // What the provider was offered: the shell, read, and
    // write and edit for its own directory; none of the tools that run workers.
    for (const offered of ["bash", "read", "write", "edit", "schedule_wake"]) expect([offered, personalTools.includes(offered)]).toEqual([offered, true]);
    for (const kept of ["view_image", "create_worker", "archive_worker"]) expect([kept, personalTools.includes(kept)]).toEqual([kept, false]);
  } finally {
    await page.close();
  }
}, 90_000);

// No agent could archive a thread: the user did it by hand, a worker at a
// time first. Asked now, the personal agent archives the thread together with
// its worker, through the server's one archive, and both leave the page.
test("asked to archive a thread, the agent archives it with its worker, and both are gone from the page", async () => {
  const page = await open("/agent");
  try {
    const threads = page.getByRole("group", { name: "Threads" });
    await threads.getByText("Old spike", { exact: true }).waitFor();
    const openThreads = async () => ((await (await fetch(`${server.baseUrl}/api/agents/manager/threads`)).json()) as { threads: Array<{ id: string }> }).threads.map((t) => t.id);
    expect((await openThreads()).includes(seeded.spikeThreadId)).toBe(true);

    await send(page, "Archive the Old spike thread.");
    await page.getByText("Archived Old spike.").waitFor({ timeout: 30_000 });

    // The tool was offered and called once, and answered with what went.
    expect(personalTools.includes("archive_thread")).toBe(true);
    const agent = await serverAgent();
    const thread = await (await fetch(`${server.baseUrl}/api/agents/threads/${agent.threadId}`)).json() as { messages: Array<{ content: { type: string; toolName?: string; result?: unknown; isError?: boolean } }> };
    const archived = thread.messages.filter((m) => m.content.type === "tool_result" && m.content.toolName === "archive_thread");
    expect(archived.map((m) => m.content.result)).toEqual([{ ok: true, threadId: seeded.spikeThreadId, archivedWorkers: ["spike"] }]);
    // On the server: the thread is no longer open, and its worker is among its archived ones.
    expect((await openThreads()).includes(seeded.spikeThreadId)).toBe(false);
    const gone = await (await fetch(`${server.baseUrl}/api/agents/manager/threads/${seeded.spikeThreadId}/workers?archived=1`)).json() as { workers: Array<{ name: string }> };
    expect(gone.workers.map((w) => w.name)).toEqual(["spike"]);
    // The thread the agent did not name is as it was.
    expect((await openThreads()).includes(seeded.managerId)).toBe(true);
    // On the page: the turn reads as an archive, and the thread has left the sidebar.
    await page.locator('[data-slot="tool-run-line"]').filter({ hasText: "Archived a thread" }).waitFor({ timeout: 10_000 });
    await threads.getByText("Old spike", { exact: true }).waitFor({ state: "detached", timeout: 10_000 });
    expect(await threads.getByText("Docs overhaul", { exact: true }).count()).toBe(1);
  } finally {
    await page.close();
  }
}, 90_000);

/** The personal agent as the server holds it. */
async function serverAgent(): Promise<{ threadId: string; unread: boolean; lastVisibleSeq: number }> {
  const body = await (await fetch(`${server.baseUrl}/api/agents/personal`)).json() as { agent: { threadId: string; unread: boolean; lastVisibleSeq: number } };
  return body.agent;
}

async function serverUnread(): Promise<boolean> {
  return (await serverAgent()).unread;
}

interface StoredMessage {
  seq: number;
  role: string;
  content: { text?: string; metadata?: { threadNotice?: { kind?: string; title?: string } } };
}

/** The personal agent's conversation as the server holds it. */
async function agentMessages(): Promise<StoredMessage[]> {
  const agent = await serverAgent();
  const thread = await (await fetch(`${server.baseUrl}/api/agents/threads/${agent.threadId}`)).json() as { messages: StoredMessage[] };
  return thread.messages;
}

/** What a notice is about, as "<kind>:<title>"; null for any other message. */
function noticeFor(message: StoredMessage): string | null {
  const notice = message.content.metadata?.threadNotice;
  return notice ? `${notice.kind}:${notice.title}` : null;
}
