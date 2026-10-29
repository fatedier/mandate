import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { artifactDir } from "./helpers/diagnostics.js";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { seedProject } from "../tests/helpers/fixtures.js";
import { sseFrame } from "../tests/helpers/sse.js";
import { everyWaitingRow } from "./helpers/home-rows";
import { trackRequests } from "./helpers/settle.js";

/**
 * A question put to the user, through real turns: the model a stub that
 * speaks the Responses stream and calls `ask_user`. The question stands
 * above its thread's composer and marks the thread as needing the user; a
 * suggested answer, or a typed one, answers it; a question taken back says
 * so. A worker's question nobody took up comes to its thread once the thread
 * rests, and a canvas it links to opens over the conversation. The stub tells the cases apart by a word in the user's message, and
 * a turn's steps apart by the tool results already in the request.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
const shots = () => artifactDir("agent-questions");
const seeded = { ask: "", typed: "", two: "", skip: "", withdraw: "", worker: "", phone: "", keyboard: "", workerFeature: "" };
/** Every request the model got, by case. */
const requests = new Map<string, Array<Record<string, any>>>();
/** Lets go of the model step that waits, when the test is done with it. */
let releaseHeldStep: () => void = () => {};

const PUSH = "Push fix/evict-order and open a pull request?";
const PUSH_OPTIONS = [
  { label: "Push and open the PR", description: "The tests pass and the branch is rebased on main." },
  { label: "Push, no PR yet", description: "You open the pull request yourself." },
  { label: "Hold it", description: "Nothing leaves this machine until you say so." }
];
const BUCKET = "Which bucket should the probe upload to?";
const REDIRECTS = "Keep the old URLs working with redirects?";
const SELECTOR = "Which version selector should the new pages use?";
const BUILD_LOOP = "May I run the full build in a loop to catch the flaky test?";
/** The same question as the worker wrote it: Markdown, a canvas linked in it. */
const FLAKY_CANVAS = "/canvas/cnv_P8sV2mQ0rTe";
const BUILD_LOOP_ASKED = `May I run the full build in a loop to catch [the flaky test](${FLAKY_CANVAS})?`;
const SUMMARY = "Send the weekly summary to the team now?";
const RELEASE_DAY = "Which day should the release go out?";
/** As long as a question may be, with a word no line can break inside. */
const LONG = `${"Should the importer keep every legacy field, or only the ones the new schema names? ".repeat(22)}${"x".repeat(160)}`.slice(0, 2000);
const LONG_OPTIONS = [
  { label: "Keep every legacy field and map the unknown ones into a catch-all column", description: "Nothing is lost, and the importer stays slower until the old exporters are retired, which may be a long while yet for the two largest sites." },
  { label: "Only the fields the new schema names" },
  { label: "Keep them for one release, then drop them", description: "A note in the changelog says when." },
  { label: "Ask each site" }
];

/** One model response: text, or a function call. */
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

/** Every string in a request's input, so a test can look for what the model was shown. */
function shown(body: Record<string, any>): string {
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(body.input ?? []);
  return parts.join("\n");
}

/** What the tools answered so far in this conversation, oldest first. */
function toolOutputs(body: Record<string, any>): string[] {
  return ((body.input ?? []) as Array<Record<string, any>>)
    .filter((item) => item.type === "function_call_output")
    .map((item) => (typeof item.output === "string" ? item.output : JSON.stringify(item.output)));
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, any>;
      const text = shown(body);
      const outputs = toolOutputs(body);
      const seen = (name: string) => {
        const list = requests.get(name) ?? [];
        list.push(body);
        requests.set(name, list);
        return `${name}${list.length}`;
      };
      const ask = (question: string, options?: Array<{ label: string; description?: string }>) =>
        ({ call: { name: "ask_user", args: options ? { question, options } : { question } } });
      // A pick reaches the model under a line that names its question. (The
      // answers' own words are in the request from the call that offered them.)
      const answered = (question: string) => text.includes(`[Answer to your question "${question}"]`);

      // The agent above the threads asks the user itself. Told apart first:
      // what it is shown of the threads can hold the other cases' words.
      if (text.includes("agent-case")) {
        const id = seen("agent");
        if (answered(SUMMARY)) return respond(id, { text: "Sent to the team." });
        if (outputs.length === 0) return respond(id, ask(SUMMARY, [{ label: "Send it" }, { label: "Wait until Monday" }]));
        return respond(id, { text: "The summary is written." });
      }
      if (text.includes("ask-case")) {
        const id = seen("ask");
        if (answered(PUSH)) return respond(id, { text: "Pushed. The pull request is yours to open." });
        if (outputs.length === 0) return respond(id, ask(PUSH, PUSH_OPTIONS));
        return respond(id, { text: "The fix is in and the cache tests pass. One thing is yours to decide." });
      }
      if (text.includes("typed-case")) {
        const id = seen("typed");
        if (answered(BUCKET)) return respond(id, { text: "Uploading to probe/ in staging." });
        if (text.includes("Use the staging bucket")) return respond(id, { text: "Noted; I still need the bucket named as the answer." });
        if (outputs.length === 0) return respond(id, ask(BUCKET));
        return respond(id, { text: "The probe is ready to run." });
      }
      if (text.includes("two-case")) {
        const id = seen("two");
        if (answered(SELECTOR)) return respond(id, { text: "Both settled." });
        if (answered(REDIRECTS)) return respond(id, { text: "Redirects it is." });
        if (outputs.length === 0) return respond(id, ask(REDIRECTS, [{ label: "Yes, redirect them" }, { label: "No, let them break" }]));
        if (outputs.length === 1) return respond(id, ask(SELECTOR, [{ label: "The layout's own" }, { label: "Tag it too" }]));
        return respond(id, { text: "Half of the pages are moved. Two things before I go on." });
      }
      if (text.includes("skip-case")) {
        const id = seen("skip");
        if (answered(SELECTOR)) return respond(id, { text: "The layout's own selector it is." });
        if (outputs.length === 0) return respond(id, ask(REDIRECTS, [{ label: "Yes, redirect them" }, { label: "No, let them break" }]));
        if (outputs.length === 1) return respond(id, ask(SELECTOR, [{ label: "The layout's own" }, { label: "Tag it too" }]));
        return respond(id, { text: "The guides are moved. Two things before I go on." });
      }
      if (text.includes("withdraw-case")) {
        const id = seen("withdraw");
        if (outputs.length === 0) return respond(id, ask(SELECTOR, [{ label: "The layout's own" }, { label: "Ours" }]));
        if (outputs.length === 1) {
          const questionId = (JSON.parse(outputs[0]!) as { questionId: string }).questionId;
          return respond(id, { call: { name: "withdraw_question", args: { questionId } } });
        }
        return respond(id, { text: "No need to choose: the new layout ships its own version selector, so I used that." });
      }
      if (text.includes("phone-case")) {
        const id = seen("phone");
        if (text.includes("[Answer to your question")) return respond(id, { text: "Asking each site." });
        if (outputs.length === 0) return respond(id, ask(LONG, LONG_OPTIONS));
        return respond(id, { text: "The importer runs on the sample set." });
      }
      if (text.includes("keyboard-case")) {
        const id = seen("keyboard");
        if (text.includes("[Answer to your question")) return respond(id, { text: "The release goes out then." });
        if (outputs.length === 0) return respond(id, ask(RELEASE_DAY, [{ label: "Friday" }, { label: "Monday" }]));
        return respond(id, { text: "Waiting on the release day." });
      }
      // A manager that works on until it is let go: its thread is not at rest.
      if (text.includes("hold-case")) {
        const id = seen("hold");
        await new Promise<void>((resolve) => {
          releaseHeldStep = resolve;
          request.signal.addEventListener("abort", () => resolve());
        });
        return respond(id, { text: "Looked at the build logs." });
      }
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
      // Named: until it is, its page is the guide that names it, not its conversation.
      config.agent = { ...config.agent, globalAgentName: "Juno" };
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const features = new FeaturesStore(store.db);
        seeded.ask = agents.createManagerThread("Eviction order").id;
        seeded.typed = agents.createManagerThread("Upload probe").id;
        seeded.two = agents.createManagerThread("API reference").id;
        seeded.skip = agents.createManagerThread("Guides move").id;
        seeded.withdraw = agents.createManagerThread("Version selector").id;
        seeded.worker = agents.createManagerThread("Flaky build").id;
        seeded.phone = agents.createManagerThread("Importer fields").id;
        seeded.keyboard = agents.createManagerThread("Release day").id;
        const projectId = seedProject(new ProjectsStore(store.db), { name: "project-1", tmuxSessionName: "md-questions" });
        seeded.workerFeature = features.insert({
          projectId, name: "build-probe", mode: "shared-cwd", branch: null, worktreePath: null,
          tmuxWindowName: "build-probe", ownership: "app", ownerThreadId: seeded.worker
        });
        agents.getOrCreateThread("worker", seeded.workerFeature);
        // The worker asked and stopped; its manager never took the question up.
        new PlanStore(store.db).update(seeded.workerFeature, { goal: "Find the flaky test", openQuestions: [BUILD_LOOP_ASKED] });
      } finally {
        store.db.close();
      }
    }
  });
  // The model must be the stub: never let this test reach a real provider.
  const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== `http://127.0.0.1:${stub.port}/v1`) {
    throw new Error(`the provider is not the stub: ${JSON.stringify(openai)}`);
  }
}, 60_000);

afterAll(() => {
  releaseHeldStep();
  server?.cleanup();
  stub?.stop(true);
});

/** A message of the user's to a thread, as the page posts it. */
async function post(threadId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${server.baseUrl}/api/agents/threads/${threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
}
async function say(threadId: string, content: string): Promise<void> {
  expect((await post(threadId, { content })).status).toBe(202);
}

async function open(threadId: string, viewport = { width: 1440, height: 900 }, phone = false): Promise<Page> {
  const page = await browser.newPage(phone ? { viewport, isMobile: true, hasTouch: true } : { viewport });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  const requests = await trackRequests(page);
  await page.goto(`${server.baseUrl}/threads/${threadId}`);
  // The thread page drawn, and what it loads in.
  await page.locator('[data-slot="composer"]').waitFor();
  await requests.idle();
  return page;
}

const dock = (page: Page) => page.locator('[data-slot="question-dock"]');
const slot = (page: Page, name: string) => page.locator(`[data-slot="${name}"]`);
const options = (page: Page) => page.locator('[data-slot="question-option"]');
const optionLabels = (page: Page) => page.locator('[data-slot="question-option-label"]').allTextContents();
const askLines = (page: Page) => page.locator('[data-slot="ask-line"]').evaluateAll((lines) =>
  lines.map((line) => [line.getAttribute("data-state"), line.querySelector('[data-slot="ask-line-label"]')!.textContent, line.querySelector('[data-slot="ask-line-question"]')!.textContent]));
/** Waits for the thread's mark in the sidebar to read `state`. */
const marked = (page: Page, title: string, state: string) =>
  page.locator(`a[data-thread-title="${title}"] [role="img"][aria-label="state: ${state}"]`).waitFor();
const homeRow = (page: Page, title: string) =>
  page.locator('section[aria-label="Waiting on you"] [data-waiting]').filter({ hasText: title });
const composer = (page: Page) => page.locator('[data-slot="composer"] textarea');

test("a manager asks: the question stands above the composer, the thread needs you, and a suggested answer answers it", async () => {
  await say(seeded.ask, "ask-case: fix the eviction order bug and get it ready to ship");
  const page = await open(seeded.ask);
  try {
    await page.getByText("One thing is yours to decide.").waitFor();
    await dock(page).waitFor();
    expect(await slot(page, "question-heading").textContent()).toBe("Needs your answer");
    expect(await slot(page, "question-text").textContent()).toBe(PUSH);
    expect(await optionLabels(page)).toEqual(PUSH_OPTIONS.map((o) => o.label));
    // The first suggested answer is the recommended one, and only it says so.
    expect(await options(page).evaluateAll((all) => all.map((o) => o.textContent!.includes("Recommended")))).toEqual([true, false, false]);
    expect(await slot(page, "question-option-description").allTextContents()).toEqual(PUSH_OPTIONS.map((o) => o.description));
    // Anything else is typed in the question's own field, not the composer.
    expect(await slot(page, "question-input").getAttribute("placeholder")).toBe("Type your own answer");
    expect(await slot(page, "question-hint").count()).toBe(0);
    expect(await slot(page, "question-pager").count()).toBe(0);
    // Above the composer, on its column.
    const [block, input] = [await dock(page).boundingBox(), await slot(page, "composer").boundingBox()];
    expect(block!.y + block!.height).toBeLessThanOrEqual(input!.y + 1);
    expect(Math.abs(block!.x - input!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(block!.width - input!.width)).toBeLessThanOrEqual(1);
    // Where it was asked: one line, open; the call is not among the turn's tool calls.
    expect(await askLines(page)).toEqual([["open", "Asked you", PUSH]]);
    expect(await page.locator('[data-slot="tool-run"]').count()).toBe(0);
    await marked(page, "Eviction order", "needs you");
    await page.screenshot({ path: path.join(shots(), "asked-desktop.png") });

    // Home lists the thread among what waits on the user, with the question.
    const home = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    home.setDefaultTimeout(20_000);
    attachPageDiagnostics(home);
    try {
      await home.goto(`${server.baseUrl}/home`);
      await homeRow(home, "Eviction order").waitFor();
      expect(await homeRow(home, "Eviction order").getAttribute("data-waiting")).toBe("input");
      expect(await homeRow(home, "Eviction order").textContent()).toContain(PUSH);
    } finally {
      await home.close();
    }

    // The second suggested answer: sent as the user's own message.
    await options(page).nth(1).click();
    await page.getByText("Pushed. The pull request is yours to open.").waitFor();
    expect(await slot(page, "user-bubble").last().textContent()).toContain("Push, no PR yet");
    // The answer quotes the question it answers, and the quote leads to where it was asked.
    const quote = slot(page, "user-bubble").last().locator('[data-slot="answer-quote"]');
    expect([await quote.textContent(), await quote.evaluate((el) => el.tagName)]).toEqual([PUSH, "BUTTON"]);
    // Its grey bar stays a straight line: no rounding on its left corners.
    expect(await quote.evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderBottomLeftRadius])).toEqual(["0px", "0px"]);
    await quote.click();
    await page.locator('[data-slot="ask-line"][data-question-flash]').waitFor();
    await dock(page).waitFor({ state: "detached" });
    expect(await askLines(page)).toEqual([["answered", "Asked you · answered", PUSH]]);
    await marked(page, "Eviction order", "idle");
    // The model was told which question the message answers.
    const last = shown(requests.get("ask")!.at(-1)!);
    expect(last).toContain(`[Answer to your question "${PUSH}"]\nPush, no PR yet`);
    // The quote opened its line: the whole question and its suggested answers,
    // the one picked marked as the user's.
    const line = page.locator('[data-slot="ask-line"]');
    const toggle = line.locator("button[aria-expanded]");
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    await line.locator('[data-slot="ask-line-full"]').waitFor();
    expect(await line.locator('[data-slot="ask-line-full"]').textContent()).toBe(PUSH);
    expect(await line.locator('[data-slot="ask-line-option"]').count()).toBe(PUSH_OPTIONS.length);
    expect(await line.locator('[data-slot="ask-line-option"][data-picked="true"]').textContent()).toContain("Push, no PR yet · Your answer");
    await page.screenshot({ path: path.join(shots(), "answered-desktop.png") });
    // Its line closes it again.
    await toggle.click();
    await line.locator('[data-slot="ask-line-body"]').waitFor({ state: "detached" });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await page.close();
  }
}, 120_000);

test("words in the composer leave a question open; an answer typed in the question answers it, and the model is told which", async () => {
  await say(seeded.typed, "typed-case: run the upload probe");
  const page = await open(seeded.typed);
  try {
    await dock(page).waitFor();
    expect(await slot(page, "question-text").textContent()).toBe(BUCKET);
    expect(await options(page).count()).toBe(0);
    expect(await slot(page, "question-input").getAttribute("placeholder")).toBe("Type your answer");
    await marked(page, "Upload probe", "needs you");
    // In the composer: a message of its own, which names no question.
    await composer(page).fill("Use the staging bucket.");
    await composer(page).press("Enter");
    await page.getByText("Noted; I still need the bucket named as the answer.").waitFor();
    expect(shown(requests.get("typed")!.at(-1)!)).not.toContain("[Answer to your question");
    expect(await dock(page).count()).toBe(1);
    await marked(page, "Upload probe", "needs you");
    // In the question: its answer.
    await slot(page, "question-input").fill("Staging, under probe/.");
    await slot(page, "question-input").press("Enter");
    await page.getByText("Uploading to probe/ in staging.").waitFor();
    await dock(page).waitFor({ state: "detached" });
    expect(await askLines(page)).toEqual([["answered", "Asked you · answered", BUCKET]]);
    await marked(page, "Upload probe", "idle");
    expect(shown(requests.get("typed")!.at(-1)!)).toContain(`[Answer to your question "${BUCKET}"]\nStaging, under probe/.`);
  } finally {
    await page.close();
  }
}, 120_000);

test("two questions are answered one at a time; a pick answers its own, and a second pick for it is refused", async () => {
  await say(seeded.two, "two-case: move the API reference to the new layout");
  const page = await open(seeded.two);
  try {
    await page.getByText("Two things before I go on.").waitFor();
    await slot(page, "question-pager").waitFor();
    expect(await slot(page, "question-position").textContent()).toBe("1 of 2");
    expect(await slot(page, "question-text").textContent()).toBe(REDIRECTS);
    expect(await askLines(page)).toEqual([["open", "Asked you", REDIRECTS], ["open", "Asked you", SELECTOR]]);
    await page.getByRole("button", { name: "Next question" }).click();
    expect(await slot(page, "question-position").textContent()).toBe("2 of 2");
    expect(await slot(page, "question-text").textContent()).toBe(SELECTOR);
    await page.getByRole("button", { name: "Previous question" }).click();
    // Folded, it is one line that still says how many wait.
    await page.getByRole("button", { name: "Hide the question" }).click();
    expect(await slot(page, "question-reminder").textContent()).toBe(`2 questions${REDIRECTS}`);
    await page.screenshot({ path: path.join(shots(), "two-folded.png") });
    await slot(page, "question-reminder").click();
    await page.screenshot({ path: path.join(shots(), "two-open.png") });

    await options(page).first().click();
    await page.getByText("Redirects it is.").waitFor();
    // The first is answered; the second stands alone, and the thread still needs the user.
    await page.waitForFunction((want) => document.querySelector('[data-slot="question-text"]')?.textContent === want, SELECTOR);
    expect(await slot(page, "question-pager").count()).toBe(0);
    expect(await askLines(page)).toEqual([["answered", "Asked you · answered", REDIRECTS], ["open", "Asked you", SELECTOR]]);
    await marked(page, "API reference", "needs you");

    // Another pick for the question already answered (a page that had not caught up) is refused, and closes nothing.
    const stale = (await askedIds(seeded.two))[0]!;
    const refused = await post(seeded.two, { content: "No, let them break", answers: [stale] });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toBe("That question is no longer open.");
    expect(await slot(page, "question-text").textContent()).toBe(SELECTOR);

    await options(page).nth(1).click();
    await page.getByText("Both settled.").waitFor();
    await dock(page).waitFor({ state: "detached" });
    await marked(page, "API reference", "idle");
  } finally {
    await page.close();
  }
}, 120_000);

test("Skip closes a question without an answer and wakes nobody; the manager reads that it was skipped when it next looks", async () => {
  await say(seeded.skip, "skip-case: move the guides to the new layout");
  const page = await open(seeded.skip);
  try {
    await page.getByText("Two things before I go on.").waitFor();
    expect(await slot(page, "question-text").textContent()).toBe(REDIRECTS);
    const asked = requests.get("skip")!.length;
    await slot(page, "question-skip").click();
    await page.waitForFunction((want) => document.querySelector('[data-slot="question-text"]')?.textContent === want, SELECTOR);
    expect(await askLines(page)).toEqual([["skipped", "Asked you · skipped", REDIRECTS], ["open", "Asked you", SELECTOR]]);
    // Read again from the server: still skipped, and the manager was never woken for it.
    await page.reload();
    await page.locator('[data-slot="ask-line"][data-state="skipped"]').waitFor();
    expect(await slot(page, "question-text").textContent()).toBe(SELECTOR);
    expect(await askLines(page)).toEqual([["skipped", "Asked you · skipped", REDIRECTS], ["open", "Asked you", SELECTOR]]);
    expect(requests.get("skip")!.length).toBe(asked);
    // Its next turn, for the other answer, reads that the first was skipped.
    await options(page).first().click();
    await page.getByText("The layout's own selector it is.").waitFor();
    expect(shown(requests.get("skip")!.at(-1)!)).toContain(`The user skipped your question "${REDIRECTS}".`);
    await dock(page).waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
}, 120_000);

/** The ids of the questions a thread's manager asked, oldest first, from its transcript. */
async function askedIds(threadId: string): Promise<string[]> {
  const data = await (await fetch(`${server.baseUrl}/api/agents/threads/${threadId}`)).json() as { messages: Array<{ content: Record<string, any> }> };
  return data.messages
    .filter((m) => m.content.type === "tool_result" && m.content.toolName === "ask_user")
    .map((m) => (m.content.result as { questionId: string }).questionId);
}

test("a question its asker took back says so where it was asked, and nothing waits", async () => {
  await say(seeded.withdraw, "withdraw-case: move the pages to the new layout");
  const page = await open(seeded.withdraw);
  try {
    await page.getByText("No need to choose").waitFor();
    expect(await askLines(page)).toEqual([["withdrawn", "Asked you · withdrawn", SELECTOR]]);
    expect(await dock(page).count()).toBe(0);
    // Asked and taken back in one stretch of work: the line says both, and no call is drawn for it.
    expect(await page.locator('[data-slot="tool-run"]').count()).toBe(0);
    await marked(page, "Version selector", "idle");
    await page.screenshot({ path: path.join(shots(), "withdrawn-desktop.png") });
  } finally {
    await page.close();
  }
}, 120_000);

test("a worker's question nobody took up comes to its thread once the thread rests, and leaves while the thread works", async () => {
  const page = await open(seeded.worker);
  try {
    await dock(page).waitFor();
    expect(await slot(page, "question-heading").textContent()).toBe("build-probe is waiting for an answer");
    expect(await slot(page, "question-text").textContent()).toBe(BUILD_LOOP);
    expect(await options(page).count()).toBe(0);
    expect(await slot(page, "question-hint").textContent()).toBe("Type your answer below.");
    await marked(page, "Flaky build", "needs you");
    await page.screenshot({ path: path.join(shots(), "worker-question-desktop.png") });
    const home = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    home.setDefaultTimeout(20_000);
    attachPageDiagnostics(home);
    try {
      await home.goto(`${server.baseUrl}/home`);
      await homeRow(home, "build-probe").waitFor();
      expect(await homeRow(home, "build-probe").getAttribute("data-waiting")).toBe("input");
      expect(await homeRow(home, "build-probe").textContent()).toContain(BUILD_LOOP);
      // The manager works: the question is its to take up, not the user's.
      await say(seeded.worker, "hold-case: look at the build logs first");
      await dock(page).waitFor({ state: "detached" });
      await homeRow(home, "build-probe").waitFor({ state: "detached" });
      await marked(page, "Flaky build", "working");
      // It stops without taking the question up: the question is the user's again.
      releaseHeldStep();
      await page.getByText("Looked at the build logs.").waitFor();
      await dock(page).waitFor();
      expect(await slot(page, "question-text").textContent()).toBe(BUILD_LOOP);
      await homeRow(home, "build-probe").waitFor();
      // Its link opens the canvas beside the conversation, as a tab in the
      // thread's panel; the conversation stays where it is.
      const threadPath = new URL(page.url()).pathname;
      await slot(page, "question-text").getByRole("link", { name: "the flaky test" }).click();
      await page.locator(`[data-slot="worker-panel"] [data-canvas-tab="${FLAKY_CANVAS.slice("/canvas/".length)}"][aria-selected="true"]`).waitFor();
      expect(new URL(page.url()).pathname).toBe(threadPath);
      expect(await page.getByRole("dialog", { name: "Canvas", exact: true }).count()).toBe(0);
      expect(await page.locator('[data-slot="transcript-column"]').count()).toBe(1);
    } finally {
      await home.close();
    }
  } finally {
    await page.close();
  }
}, 120_000);

// The keyboard of a phone (a tall input method, the browser's bar) can leave
// 240 px, where the composer would draw over the answer field. While a field
// above the composer has the focus, the composer steps aside; it comes back
// with the focus.
test("on a phone with the keyboard up, the composer steps aside for the answer field and comes back with the focus", async () => {
  await say(seeded.keyboard, "keyboard-case: pick the release day");
  const page = await open(seeded.keyboard, { width: 390, height: 844 }, true);
  try {
    await page.getByText("Waiting on the release day.").waitFor();
    await dock(page).waitFor();
    const field = slot(page, "question-input");
    await field.tap();
    await field.fill("Friday after the freeze");
    await page.setViewportSize({ width: 390, height: 240 });
    const room = () => page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-slot="question-input"]');
      const area = document.querySelector('[data-slot="composer-area"]')!.getBoundingClientRect();
      if (!input) return { areaHeight: Math.round(area.height) };
      const r = input.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inView: r.top >= 0 && r.bottom <= window.innerHeight, uncovered: hit === input, areaHeight: Math.round(area.height) };
    });
    await page.waitForFunction(() => document.querySelector('[data-slot="composer-area"]')!.getBoundingClientRect().height === 0);
    expect(await room()).toEqual({ inView: true, uncovered: true, areaHeight: 0 });
    await page.screenshot({ path: path.join(shots(), "keyboard-phone-answering.png") });
    // A tap outside the field, on nothing that takes the focus: the keyboard
    // goes down, and the composer comes back rather than stay folded.
    await page.locator("header").getByText("Release day").tap();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('[data-slot="composer-area"]')!.getBoundingClientRect().height > 40);
    // Back in the field with the keyboard up, folded again; Send tapped: the
    // focus moves to the button as the finger lands, and the composer stays
    // folded until the tap is done, so the tap is Send's (back mid-tap, it
    // would make the tap miss).
    await field.tap();
    await page.setViewportSize({ width: 390, height: 240 });
    await page.waitForFunction(() => document.querySelector('[data-slot="composer-area"]')!.getBoundingClientRect().height === 0);
    await slot(page, "question-send").tap();
    await dock(page).waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-slot="composer"] textarea'));
    await page.waitForFunction(() => document.querySelector('[data-slot="composer-area"]')!.getBoundingClientRect().height > 40);
    await page.getByText("The release goes out then.").waitFor();
    await page.screenshot({ path: path.join(shots(), "keyboard-phone-answered.png") });
  } finally {
    await page.close();
  }
}, 60_000);

test("on a phone a question as long as one may be fits: nothing scrolls sideways, and the composer keeps its place", async () => {
  await say(seeded.phone, "phone-case: import the sample set");
  const page = await open(seeded.phone, { width: 390, height: 844 }, true);
  try {
    await page.getByText("The importer runs on the sample set.").waitFor();
    await dock(page).waitFor();
    expect(await slot(page, "question-text").textContent()).toBe(LONG);
    expect(await optionLabels(page)).toEqual(LONG_OPTIONS.map((o) => o.label));
    expect(await pageOverflow(page)).toEqual([]);
    const measured = await page.evaluate(() => {
      const rect = (name: string) => document.querySelector(`[data-slot="${name}"]`)!.getBoundingClientRect();
      const body = document.querySelector<HTMLElement>('[data-slot="question-body"]')!;
      const asked = document.querySelector<HTMLElement>('[data-slot="question-text"]')!;
      const block = rect("question-dock");
      const input = document.querySelector('[data-slot="composer"] textarea')!.getBoundingClientRect();
      const first = document.querySelector('[data-slot="question-option"]')!.getBoundingClientRect();
      return {
        left: block.left, right: block.right, top: block.top, height: block.height, inputBottom: input.bottom,
        scrolls: asked.scrollHeight > asked.clientHeight, sideways: Math.max(body.scrollWidth - body.clientWidth, asked.scrollWidth - asked.clientWidth),
        firstAnswerInView: first.top >= body.getBoundingClientRect().top && first.bottom <= body.getBoundingClientRect().bottom,
        optionHeights: [...document.querySelectorAll('[data-slot="question-option"]')].map((o) => o.getBoundingClientRect().height),
        // The head's controls (fold, Skip): each a 44px touch area at least,
        // grown about its own middle, and no two of them overlapping.
        headOverlaps: (() => {
          const head = document.querySelector('[data-slot="question-heading"]')!.parentElement!;
          const areas = [...head.querySelectorAll("button")].map((button) => {
            const r = button.getBoundingClientRect();
            const w = Math.max(44, r.width), h = Math.max(44, r.height);
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            return { name: button.getAttribute("aria-label") ?? button.textContent, l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 };
          });
          return areas.flatMap((a, i) => areas.slice(i + 1).filter((b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5).map((b) => `${a.name} / ${b.name}`));
        })(),
        headControls: [...document.querySelector('[data-slot="question-heading"]')!.parentElement!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent),
        viewport: [window.innerWidth, window.innerHeight]
      };
    });
    // Inside the screen, with its gutters; the long question scrolls in a few
    // lines of its own, so the answers are in view; the block leaves the
    // conversation and the composer their room.
    expect(measured.firstAnswerInView).toBe(true);
    expect(measured.height).toBeLessThanOrEqual(measured.viewport[1]! * 0.62);
    expect(measured.left).toBeGreaterThanOrEqual(0);
    expect(measured.right).toBeLessThanOrEqual(measured.viewport[0]!);
    expect(measured.top).toBeGreaterThanOrEqual(0);
    expect(measured.inputBottom).toBeLessThanOrEqual(measured.viewport[1]!);
    expect(measured.scrolls).toBe(true);
    expect(measured.sideways).toBeLessThanOrEqual(0);
    // Each suggested answer is a touch target.
    expect(Math.min(...measured.optionHeights)).toBeGreaterThanOrEqual(44);
    expect(measured.headControls).toEqual(["Hide the question", "Skip"]);
    expect(measured.headOverlaps).toEqual([]);
    await page.screenshot({ path: path.join(shots(), "long-phone.png") });

    // A short screen and a draft of many lines: the block gives up its height,
    // not the composer. Send stays on the screen, and so does the block's head.
    await page.setViewportSize({ width: 390, height: 560 });
    await composer(page).fill(Array.from({ length: 8 }, (_, line) => `line ${line + 1}`).join("\n"));
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea')!.value.includes("line 8"));
    const squeezed = await page.evaluate(() => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const send = rect(document.querySelector('button[aria-label="Send message"]')!);
      const head = rect(document.querySelector('[data-slot="question-heading"]')!);
      const block = rect(document.querySelector('[data-slot="question-dock"]')!);
      const input = rect(document.querySelector('[data-slot="composer"]')!);
      const banner = rect(document.querySelector("header")!);
      return { sendBottom: send.bottom, headTop: head.top, blockBottom: block.bottom, inputTop: input.top, bannerBottom: banner.bottom, height: window.innerHeight };
    });
    expect(squeezed.sendBottom).toBeLessThanOrEqual(squeezed.height);
    expect(squeezed.headTop).toBeGreaterThanOrEqual(squeezed.bannerBottom);
    expect(squeezed.blockBottom).toBeLessThanOrEqual(squeezed.inputTop + 1);
    expect(await pageOverflow(page)).toEqual([]);
    await page.screenshot({ path: path.join(shots(), "long-phone-short-screen.png") });
    await composer(page).fill("");
    await page.setViewportSize({ width: 390, height: 844 });
    // Folded, the conversation has its room back.
    await page.getByRole("button", { name: "Hide the question" }).tap();
    await slot(page, "question-reminder").waitFor();
    expect(await pageOverflow(page)).toEqual([]);
    await page.screenshot({ path: path.join(shots(), "long-phone-folded.png") });
    await slot(page, "question-reminder").tap();
    await options(page).nth(3).tap();
    await page.getByText("Asking each site.").waitFor();
    await dock(page).waitFor({ state: "detached" });
    expect(await slot(page, "user-bubble").last().textContent()).toContain("Ask each site");
    // Its bubble quotes the long question in two lines, the rest cut, and nothing scrolls sideways.
    const quoted = await slot(page, "user-bubble").last().locator('[data-slot="answer-quote-text"]').evaluate((el) => ({
      lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
      cut: el.scrollHeight > el.clientHeight + 1
    }));
    expect(quoted).toEqual({ lines: 2, cut: true });
    expect(await pageOverflow(page)).toEqual([]);
    // Its quote opens the question where it was asked, whole: a touch-sized
    // line, the picked answer marked, and nothing scrolls sideways.
    await slot(page, "user-bubble").last().locator('[data-slot="answer-quote"]').tap();
    const asked = page.locator('[data-slot="ask-line"]');
    await asked.locator('[data-slot="ask-line-full"]').waitFor();
    expect(await asked.locator("button[aria-expanded]").evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await asked.locator('[data-slot="ask-line-option"][data-picked="true"]').textContent()).toContain("Ask each site · Your answer");
    expect(await pageOverflow(page)).toEqual([]);
    // Once it has grown in, its head is still in view: following the end did
    // not push it off the top as it grew.
    await asked.locator('[data-slot="fold"]').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    expect(await asked.locator('[data-slot="ask-line-head"]').evaluate((el) => {
      const head = el.getBoundingClientRect();
      return head.top >= 0 && head.bottom <= window.innerHeight;
    })).toBe(true);
    await page.screenshot({ path: path.join(shots(), "answered-phone-open.png") });
    // Taken there again, already open and taller than the screen: its head is
    // in view, not the middle of the question.
    const again = slot(page, "user-bubble").last().locator('[data-slot="answer-quote"]');
    await again.scrollIntoViewIfNeeded();
    await again.tap();
    await page.waitForFunction(() => {
      const head = document.querySelector('[data-slot="ask-line-head"]')!.getBoundingClientRect();
      return head.top >= 0 && head.bottom <= window.innerHeight;
    });
  } finally {
    await page.close();
  }
}, 120_000);

test("the agent's own question stands on its page, marks its row, and is on Home and in the phone's count until it is answered", async () => {
  const agent = (await (await fetch(`${server.baseUrl}/api/agents/global`)).json() as { agent: { threadId: string } }).agent;
  await say(agent.threadId, "agent-case: write the weekly summary");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/agent`);
    await page.getByText("The summary is written.").waitFor();
    await dock(page).waitFor();
    expect(await slot(page, "question-heading").textContent()).toBe("Needs your answer");
    expect(await slot(page, "question-text").textContent()).toBe(SUMMARY);
    expect(await optionLabels(page)).toEqual(["Send it", "Wait until Monday"]);
    // Its row in the sidebar takes the mark a thread takes when its manager asked.
    await page.locator('[data-slot="global-agent-question"]').waitFor();

    // On a phone that row is inside the drawer: Home lists the question first;
    // the menu button counts the rest, as the sidebar does (Your agent's row shows its own).
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    phone.setDefaultTimeout(20_000);
    attachPageDiagnostics(phone);
    try {
      await phone.goto(`${server.baseUrl}/home`);
      const rows = phone.locator('section[aria-label="Waiting on you"] [data-waiting]');
      await homeRow(phone, SUMMARY).waitFor();
      expect(await rows.first().getAttribute("href")).toBe("/agent");
      expect(await rows.first().locator('[data-slot="waiting-title"]').textContent()).toBe("Juno");
      expect(await rows.first().locator('[data-slot="waiting-reason"]').textContent()).toBe(SUMMARY);
      const count = await (await everyWaitingRow(phone)).count();
      const label = (n: number) => (n === 1 ? "1 item needs you" : `${n} items need you`);
      if (count > 1) await phone.locator(`[aria-label="Open navigation"] [aria-label="${label(count - 1)}"]`).waitFor();
      else expect(await phone.locator('[aria-label="Open navigation"] [role="img"]').count()).toBe(0);
      expect(await pageOverflow(phone)).toEqual([]);
      await phone.screenshot({ path: path.join(shots(), "agent-home-phone.png") });

      // Answered on the agent's page: the row and its place in the count go.
      await options(page).first().click();
      await page.getByText("Sent to the team.").waitFor();
      await dock(page).waitFor({ state: "detached" });
      await page.locator('[data-slot="global-agent-question"]').waitFor({ state: "detached" });
      await homeRow(phone, SUMMARY).waitFor({ state: "detached" });
      expect(await rows.count()).toBe(count - 1);
      expect(shown(requests.get("agent")!.at(-1)!)).toContain(`[Answer to your question "${SUMMARY}"]\nSend it`);
    } finally {
      await phone.close();
    }
  } finally {
    await page.close();
  }
}, 120_000);
