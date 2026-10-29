import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";
import { seedManagerThread, startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { sseFrame } from "../tests/helpers/sse.js";

/**
 * Commands in the composer, through the real server and a real browser.
 *
 * The model is a stub that records every request it is sent and can hold an
 * answer back, so a turn or a compaction lasts as long as the test needs.
 * What only this can show: the list over the composer and its keys in a real
 * engine; that the model never receives a command's text; that a message sent
 * while a compaction started by hand runs waits for it and is answered against
 * the compacted window; and the wiring from the routes to the compression
 * controller and the scheduler, which no unit test goes through.
 */

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
let threadId = "";
const requests: string[] = [];
const SUMMARY = "SUMMARY-OF-THE-THREAD-SO-FAR";
const REPLY = "Noted.";
/** A reply from before the compaction, to follow through it. */
const EARLIER = "EARLIER-REPLY: the tag is v3.21";
/** The prompt the thread was created with: a thread keeps its prompt until a
 *  compaction replaces it with the current one. */
const STALE_PROMPT = "STALE-PROMPT: the manager prompt of an older release.";
/** How the current manager prompt opens. */
const CURRENT_PROMPT = "You are the **Manager** for Mandate";
type Kind = "summary" | "turn" | "other";
/** Which request one is. The summariser's ends with the compaction prompt (it
 *  asks for the summary "that will take the place of its earlier part"); a turn's
 *  carries the agent's tools (the summariser's does too: it is sent as the next
 *  turn would be); the rest is neither (a compaction also has memories drawn
 *  from what leaves the context, by a request of its own). */
const kindOf = (body: string): Kind =>
  body.includes("take the place of its earlier part") ? "summary"
    : ((JSON.parse(body) as { tools?: unknown[] }).tools?.length ?? 0) > 0 ? "turn" : "other";
const sent = (kind: Kind) => requests.filter((body) => kindOf(body) === kind);
/** While set, the stub's next answer to a request of that kind waits for it. */
let held: { kind: Kind; opened: Promise<void> } | null = null;
let openGate: () => void = () => {};
const hold = (kind: Kind) => { held = { kind, opened: new Promise<void>((resolve) => { openGate = resolve; }) }; };

function answer(id: number, text: string): Response {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }
  ];
  return new Response(events.map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = JSON.stringify(await request.json());
      requests.push(body);
      const kind = kindOf(body);
      if (held?.kind === kind) {
        const { opened } = held;
        held = null;
        await opened;
      }
      return answer(requests.length, kind === "summary" ? SUMMARY : REPLY);
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
      threadId = seedManagerThread(dataDir, 60);
      // The seed's replies carry no text the model is sent: one that does.
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        agent.appendMessage({ threadId, role: "assistant", source: "manager", content: { type: "assistant", text: EARLIER } });
        agent.ensureSystemMessage(threadId, STALE_PROMPT);
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => {
  openGate();
  server?.cleanup();
  stub?.stop(true);
});

const composer = (page: Page) => page.locator('[data-slot="composer"] textarea');
const options = (page: Page) => page.locator('[data-slot="command-list"] [role="option"]');
const boundary = (page: Page) => page.locator('[data-slot="context-boundary"]');
const notice = (page: Page) => page.locator('[data-slot="command-notice"]');
const working = (page: Page) => page.locator('[data-slot="working-verb"]');
const replies = (page: Page) => page.locator("main").getByText(REPLY, { exact: true });
/** Until the composer holds exactly this. What a command's answer does to the
 *  draft lands a moment apart from what the page shows of it (the working
 *  line comes by the stream, the answer by its own response). */
const draftIs = (page: Page, text: string) => page.waitForFunction(
  (want) => document.querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea')?.value === want, text
);

test("commands in a thread's composer: the list and its keys, a compaction by hand, and what the model was sent before and after it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await composer(page).waitFor();
    // The newest message a person wrote (the seed's even ones).
    await page.getByText("MSG-058").first().waitFor();
    await page.getByText(EARLIER).first().waitFor();

    // The list: a slash opens it, a path does not.
    await composer(page).fill("/");
    await options(page).nth(2).waitFor();
    expect(await options(page).count()).toBe(3);
    expect(await options(page).first().getAttribute("aria-selected")).toBe("true");
    // The list is read from the box: the cursor stays in it.
    expect(await composer(page).evaluate((el) => el === document.activeElement)).toBe(true);
    await composer(page).fill("/tmp/foo");
    await options(page).first().waitFor({ state: "detached" });
    // A path is a message, as it always was: sent, and answered. It is also
    // the turn from before the compaction, for what the model is sent then.
    await composer(page).fill("/tmp/foo is broken");
    await composer(page).press("Enter");
    await page.getByText("/tmp/foo is broken").first().waitFor();
    await replies(page).first().waitFor();
    expect(requests.map(kindOf)).toEqual(["turn"]);

    // "/c" Enter completes and runs nothing; the list sits over the composer, inside the page.
    await composer(page).fill("/c");
    const box = await page.locator('[data-slot="command-list"]').boundingBox();
    const anchor = await page.locator('[data-slot="composer"]').boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(anchor!.y + 1);
    expect(Math.abs(box!.width - anchor!.width)).toBeLessThanOrEqual(1);
    await composer(page).press("Enter");
    expect(await composer(page).inputValue()).toBe("/compact");
    // Completing ran nothing.
    expect(requests.map(kindOf)).toEqual(["turn"]);
    expect(await boundary(page).count()).toBe(0);

    // The second Enter runs it. The summariser's answer is held, so the compaction lasts.
    hold("summary");
    await composer(page).press("Enter");
    await working(page).getByText("Compacting context").waitFor();
    await draftIs(page, "");
    // A second one is refused while it runs, and its draft stays.
    await composer(page).fill("/compact");
    await composer(page).press("Enter");
    await notice(page).getByText("Already compacting.").waitFor();
    expect(await composer(page).inputValue()).toBe("/compact");
    // The draft stays; the list does not stay over what the refusal says (it
    // fades out, then is gone).
    await page.locator('[data-slot="command-list"]').waitFor({ state: "detached" });
    // A message sent meanwhile waits: the thread is busy as during a turn.
    await composer(page).fill("after the compaction, please");
    await composer(page).press("Enter");
    await page.getByText("Queued").first().waitFor();
    expect(requests.map(kindOf)).toEqual(["turn", "summary"]);

    openGate();
    // A turn before it measured the context, so the boundary says the size it was compacted at.
    await boundary(page).getByText(/^Compacted \d+ earlier messages at [\d.]+k? tokens · View summary$/).waitFor();
    // What queued is delivered after the boundary, and answered against the compacted window.
    await replies(page).nth(1).waitFor();
    expect(sent("turn")).toHaveLength(2);
    const [before, after] = sent("turn") as [string, string];
    expect({
      // Before: the prompt the thread was created with, and the earlier reply itself.
      before: { stalePrompt: before.includes(STALE_PROMPT), currentPrompt: before.includes(CURRENT_PROMPT), earlier: before.includes(EARLIER) },
      summarised: { earlier: sent("summary")[0]!.includes(EARLIER), stalePrompt: sent("summary")[0]!.includes(STALE_PROMPT) },
      // After: the current prompt, the summary in the earlier reply's place, and the message that waited.
      after: {
        stalePrompt: after.includes(STALE_PROMPT), currentPrompt: after.includes(CURRENT_PROMPT), earlier: after.includes(EARLIER),
        summary: after.includes(SUMMARY), message: after.includes("after the compaction, please")
      }
    }).toEqual({
      before: { stalePrompt: true, currentPrompt: false, earlier: true },
      summarised: { earlier: true, stalePrompt: true },
      after: { stalePrompt: false, currentPrompt: true, earlier: false, summary: true, message: true }
    });
    // The summariser was sent as the next turn would have been, for the turn's
    // prompt cache: the turn's tools and cache key, and the turn's input first.
    type Body = { tools?: unknown[]; input?: unknown[]; prompt_cache_key?: string };
    const turnBody = JSON.parse(before) as Body;
    const summaryBody = JSON.parse(sent("summary")[0]!) as Body;
    expect(turnBody.tools?.length).toBeGreaterThan(0);
    expect(summaryBody.tools).toEqual(turnBody.tools);
    expect(summaryBody.prompt_cache_key).toBe(threadId);
    expect(summaryBody.prompt_cache_key).toBe(turnBody.prompt_cache_key);
    expect(summaryBody.input?.slice(0, turnBody.input?.length)).toEqual(turnBody.input);
    const transcript = await page.locator("main").innerText();
    expect(transcript.indexOf("Compacted")).toBeLessThan(transcript.indexOf("after the compaction, please"));
    // The model never received a command.
    expect(requests.filter((body) => body.includes("/compact")).length).toBe(0);

    // /context: the size the provider counted for that reply.
    await composer(page).fill("/context");
    await composer(page).press("Enter");
    await notice(page).getByText(/^Context: 12 of [\d.]+k tokens$/).waitFor();
    // It goes at the next keystroke.
    await composer(page).pressSequentially("x");
    await notice(page).waitFor({ state: "detached" });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 90_000);

test("during a turn: /compact is refused and the turn goes on; /stop ends it; the menu's Compact now is greyed, and once idle says it has started", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await composer(page).waitFor();
    const before = sent("turn").length;
    hold("turn");
    await composer(page).fill("a slow one");
    await composer(page).press("Enter");
    await working(page).getByText("Working").waitFor();

    await composer(page).fill("/");
    expect(await options(page).first().getAttribute("data-blocked")).toBe("");
    expect(await options(page).first().innerText()).toContain("A turn is running");
    await composer(page).fill("/compact");
    await composer(page).press("Enter");
    await notice(page).getByText("A turn is running. Try again when it finishes.").waitFor();
    await page.locator('[data-slot="command-list"]').waitFor({ state: "detached" });
    await working(page).getByText("Working").waitFor();

    await page.getByRole("button", { name: "Thread actions" }).click();
    expect(await page.getByRole("menuitem", { name: "Compact now" }).getAttribute("data-disabled")).toBe("");
    await page.keyboard.press("Escape");

    await composer(page).fill("/stop");
    await composer(page).press("Enter");
    await working(page).waitFor({ state: "detached" });
    openGate();
    expect(sent("turn").length).toBe(before + 1);
    // Idle again: the command says so, and the menu item is live.
    await composer(page).fill("/stop");
    await composer(page).press("Enter");
    await notice(page).getByText("Nothing is running.").waitFor();

    // From the menu, idle: it starts, and a toast says so. A menu is in reach
    // where no working line is in view (a worker's Plan tab), so it speaks itself.
    const boundaries = await boundary(page).count();
    hold("summary");
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("menuitem", { name: "Compact now" }).click();
    await page.locator("[data-sonner-toast]").getByText("Compacting context…").waitFor();
    await working(page).getByText("Compacting context").waitFor();
    openGate();
    await boundary(page).nth(boundaries).waitFor();
  } finally {
    openGate();
    await page.close();
  }
}, 60_000);

test("on a phone: a tap fills a command in, Send runs it, and the rows are tall enough for a thumb", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await composer(page).waitFor();
    await composer(page).fill("/");
    const rows = options(page);
    await rows.nth(2).waitFor();
    for (const box of await Promise.all([0, 1, 2].map((i) => rows.nth(i).boundingBox()))) expect(box!.height).toBeGreaterThanOrEqual(44);
    // The list stays inside the screen.
    const list = (await page.locator('[data-slot="command-list"]').boundingBox())!;
    expect(list.x).toBeGreaterThanOrEqual(0);
    expect(list.x + list.width).toBeLessThanOrEqual(390);

    // The tap must not take the cursor out of the box, even for a moment: on a
    // phone that drops the keyboard and raises it again.
    await composer(page).evaluate((el) => {
      const counter = window as unknown as { blurs: number };
      counter.blurs = 0;
      el.addEventListener("blur", () => { counter.blurs += 1; });
    });
    await rows.filter({ hasText: "/context" }).tap();
    expect(await composer(page).inputValue()).toBe("/context");
    expect(await page.evaluate(() => [(window as unknown as { blurs: number }).blurs, document.activeElement?.tagName])).toEqual([0, "TEXTAREA"]);
    expect(await notice(page).count()).toBe(0);
    await page.getByRole("button", { name: "Send message" }).tap();
    await notice(page).getByText(/^(Context: |Not measured)/).waitFor();
    await draftIs(page, "");
  } finally {
    await context.close();
  }
}, 60_000);
