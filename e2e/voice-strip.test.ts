import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import fs from "node:fs";
import { fakeVoiceSocket, seedNamedAgentWithVoice, startServer, type RunningServer } from "./helpers/server";
import { browserForFile } from "./helpers/browser";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { look } from "./helpers/page-diagnostics.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

// A phone with voice on: the strip under the top bar says so on every page.
// Voice is the personal agent's, so it names the agent and goes to its page. It
// used to be a pill floating over the bottom-right corner, on top of the
// composer's send button (measured: a tap on the send button's centre landed
// on the pill).
const browser = browserForFile({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
let server: RunningServer;
let otherThread = "";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      const configFile = path.join(dataDir, "config.json");
      const config = (flatFromFile(JSON.parse(fs.readFileSync(configFile, "utf8"))) as Record<string, any>);
      seedNamedAgentWithVoice(config);
      fs.writeFileSync(configFile, JSON.stringify(fileFromFlat(config), null, 2));
      const store = new MandateStore(dataDir);
      const agent = new AgentStore(store.db);
      agent.createManagerThread("project-1 3.21 release");
      otherThread = agent.createManagerThread("Sidebar polish").id;
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
    await look(page, "agent");

    await goTo(page, "/home");
    await strip.waitFor();
    await page.locator("textarea#new-thread-composer").waitFor();
    expectStripAboveThePage(await measure(page, "textarea#new-thread-composer"));
    await look(page, "home");

    await goTo(page, `/threads/${otherThread}`);
    await page.getByPlaceholder("Message the manager…").waitFor();
    expectStripAboveThePage(await measure(page, 'textarea[placeholder="Message the manager…"]'));
    await look(page, "other-thread");

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
    await look(page, "expanded");

    // The sidebar slides (200 ms): the dock's Stop moves with it, and a click
    // whose release lands after the move began goes to the row, not the
    // button. Each step waits for the sidebar's own animation to end (the
    // aside alone: the level bar inside animates on every level change).
    const sidebarStill = () => page.waitForFunction(() => document.querySelector("aside")?.getAnimations().length === 0);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await page.getByRole("button", { name: "Expand sidebar" }).waitFor();
    await sidebarStill();
    expectInSidebarAboveSettings(await place());
    await look(page, "collapsed");
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await sidebarStill();

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
