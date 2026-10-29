import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import fs from "node:fs";
import { fakeVoiceSocket, seedNamedAgentWithVoice, startServer, type RunningServer } from "./helpers/server";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { seedProject } from "../tests/helpers/fixtures.js";

// A phone with voice on: the strip under the top bar says so on every page.
// Voice is the global agent's, so it names the agent and goes to its page. It
// used to be a pill floating over the bottom-right corner, on top of the
// composer's send button (measured: a tap on the send button's centre landed
// on the pill).
const browser = browserForFile({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
let server: RunningServer;
let otherThread = "";
const WORKER_PAGE = "/projects/md-project-1-voice/features/evicthook";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      const configFile = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      seedNamedAgentWithVoice(config);
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      const agent = new AgentStore(store.db);
      const ownerThread = agent.createManagerThread("project-1 3.21 release").id;
      otherThread = agent.createManagerThread("Sidebar polish").id;
      const projectId = seedProject(new ProjectsStore(store.db), { name: "project-1", tmuxSessionName: "md-project-1-voice" });
      new FeaturesStore(store.db).insert({ projectId, name: "evicthook", mode: "shared-cwd", branch: null, worktreePath: null, tmuxWindowName: "evicthook", ownership: "app", ownerThreadId: ownerThread });
      store.db.close();
    }
  });
}, 60_000);
afterAll(() => { server?.cleanup(); });

/** Client-side, as a link would: a reload would end voice. */
async function goTo(page: Page, pathname: string) {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, pathname);
  await page.waitForURL((url) => url.pathname === pathname);
}

/** The strip against the top bar and the page, and whether the composer's
 *  bottom-right corner (its send button) is the composer's to tap. */
async function measure(page: Page, composer: string) {
  return page.evaluate((selector) => {
    const box = (el: Element) => el.getBoundingClientRect();
    const topBar = document.querySelector('header:has([aria-label="Open navigation"])')!;
    const strip = document.querySelector('[data-slot="voice-strip"]');
    const main = document.querySelector("main")!;
    let frame = document.querySelector(selector)!.parentElement!;
    while (frame.parentElement && box(frame).height < 60) frame = frame.parentElement;
    const f = box(frame);
    const corner = document.elementFromPoint(f.right - 24, f.bottom - 20);
    return {
      topBarBottom: box(topBar).bottom,
      stripTop: strip ? box(strip).top : null,
      stripBottom: strip ? box(strip).bottom : null,
      stripText: strip?.textContent ?? null,
      mainTop: box(main).top,
      composerBottom: f.bottom,
      viewport: window.innerHeight,
      cornerIsComposer: corner !== null && frame.contains(corner)
    };
  }, composer);
}

function expectStripAboveThePage(seen: Awaited<ReturnType<typeof measure>>) {
  expect(seen.stripText).toContain("Voice on");
  expect(seen.stripText).toContain("Jarvis");
  // In the page's flow under the top bar, not over anything.
  expect(seen.stripTop!).toBeGreaterThanOrEqual(seen.topBarBottom - 1);
  expect(seen.mainTop).toBeGreaterThanOrEqual(seen.stripBottom! - 1);
  // The composer keeps the bottom, and its send button is its own.
  expect(seen.composerBottom).toBeGreaterThan(seen.viewport - 60);
  expect(seen.cornerIsComposer).toBe(true);
}

test("a phone shows running voice as a strip under the top bar, clear of every composer", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ["microphone"] });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const shots = artifactDir("voice-strip");
  const strip = page.locator('[data-slot="voice-strip"]');
  try {
    await fakeVoiceSocket(page, { type: "ready" });
    await page.goto(`${server.baseUrl}/agent`);
    await page.getByRole("button", { name: "Start voice" }).tap();
    // The agent's page carries voice's bar where its composer was: its one
    // control there. The strip is for every other page.
    await page.getByText("Listening").first().waitFor();
    expect(await page.getByRole("button", { name: "Stop voice" }).count()).toBe(1);
    expect(await strip.count()).toBe(0);
    expect(await page.locator('[aria-label="Start voice"]').count()).toBe(0);
    await page.screenshot({ path: path.join(shots, "agent.png") });

    await goTo(page, "/home");
    await strip.waitFor();
    await page.locator("textarea#new-thread-composer").waitFor();
    expectStripAboveThePage(await measure(page, "textarea#new-thread-composer"));
    await page.screenshot({ path: path.join(shots, "home.png") });

    await goTo(page, `/threads/${otherThread}`);
    await page.getByPlaceholder("Message the manager…").waitFor();
    expectStripAboveThePage(await measure(page, 'textarea[placeholder="Message the manager…"]'));
    await page.screenshot({ path: path.join(shots, "other-thread.png") });

    await goTo(page, WORKER_PAGE);
    await page.getByRole("tab", { name: "Chat", exact: true }).first().tap();
    await page.getByPlaceholder("Message the worker…").waitFor();
    expectStripAboveThePage(await measure(page, 'textarea[placeholder="Message the worker…"]'));
    await page.screenshot({ path: path.join(shots, "worker.png") });

    // A tap on the strip goes to the agent's page, where the bar takes over;
    // its Stop ends voice.
    await page.locator('[data-slot="voice-strip-back"]').tap();
    await page.waitForURL((url) => url.pathname === "/agent");
    await strip.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Stop voice" }).tap();
    await page.getByRole("button", { name: "Start voice" }).waitFor();
  } finally { await context.close(); }
}, 45_000);

test("a desktop shows running voice as a dock above Settings on every page, expanded or collapsed", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const shots = artifactDir("voice-dock");
  const dock = page.locator('[data-slot="voice-dock"]');
  /** The dock against the sidebar and its Settings row. */
  const place = () => page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const aside = document.querySelector("aside")!;
    const dock = document.querySelector('[data-slot="voice-dock"]')!;
    const settings = aside.querySelector('a[href="/settings"]')!;
    const fitsItsBox = [...dock.querySelectorAll<HTMLElement>("*")].every((el) => el.scrollWidth <= el.clientWidth + 1);
    return { aside: box(aside), dock: box(dock), settingsTop: box(settings).top, viewport: window.innerHeight, fitsItsBox, text: dock.textContent ?? "" };
  });
  const expectInSidebarAboveSettings = (seen: Awaited<ReturnType<typeof place>>) => {
    expect(seen.dock.width).toBeGreaterThan(0);
    expect(seen.dock.left).toBeGreaterThanOrEqual(seen.aside.left);
    expect(seen.dock.right).toBeLessThanOrEqual(seen.aside.right + 0.5);
    expect(seen.dock.bottom).toBeLessThanOrEqual(seen.settingsTop + 0.5);
    expect(seen.dock.bottom).toBeLessThanOrEqual(seen.viewport);
    expect(seen.fitsItsBox).toBe(true);
  };
  try {
    await fakeVoiceSocket(page, { type: "ready" });
    await page.goto(`${server.baseUrl}/agent`);
    await page.getByRole("button", { name: "Start voice" }).click();
    // On the agent's page voice's bar is its one control; the dock is for
    // every other page.
    await page.getByText("Listening").first().waitFor();
    expect(await dock.count()).toBe(0);
    await goTo(page, `/threads/${otherThread}`);
    await page.getByPlaceholder("Message the manager…").waitFor();
    await dock.waitFor();
    const onThread = await place();
    expect(onThread.text).toContain("Voice on");
    expectInSidebarAboveSettings(onThread);
    await page.screenshot({ path: path.join(shots, "expanded.png") });

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await page.getByRole("button", { name: "Expand sidebar" }).waitFor();
    expectInSidebarAboveSettings(await place());
    await page.screenshot({ path: path.join(shots, "collapsed.png") });
    await page.getByRole("button", { name: "Expand sidebar" }).click();

    await dock.getByRole("button", { name: "Stop voice" }).click();
    await dock.waitFor({ state: "detached" });
  } finally { await context.close(); }
}, 45_000);

test("a voice service that will not open stops voice and says why, instead of retrying for ever", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    // The real server: its voice service is a closed port.
    await page.goto(`${server.baseUrl}/agent`);
    await page.getByRole("button", { name: "Start voice" }).click();
    const notice = page.locator('[data-slot="voice-stopped"]');
    await notice.waitFor();
    expect(await notice.textContent()).toStartWith("Voice stopped: ");
    await page.getByRole("button", { name: "Start voice" }).waitFor();
    expect(await page.locator('[data-slot="voice-dock"]').count()).toBe(0);
  } finally { await context.close(); }
}, 45_000);
