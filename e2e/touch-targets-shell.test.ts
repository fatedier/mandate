import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, type Page } from "playwright";
import { fakeVoiceSocket, startServer, type RunningServer } from "./helpers/server.js";
import { startTouchHarness, stopTouchHarness, onPhone, expectFit, PNG, PHONE } from "./helpers/touch-targets";
import { pressBack, recordCloseWatchers } from "./helpers/close-requests";
import { settle } from "./helpers/settle.js";

// Touch targets: Home and the drawer, a thread, Projects, first
// run, and a mouse's desktop. The rule and the measurement are in
// helpers/touch-targets.ts.
let browser: Browser;
let server: RunningServer;
let threadId = "";
let archivedThreadId = "";
beforeAll(async () => {
  const harness = await startTouchHarness({ server: true });
  browser = harness.browser;
  server = harness.server!;
  threadId = harness.threadId;
  archivedThreadId = harness.archivedThreadId;
}, 60_000);
afterAll(stopTouchHarness);

test("Home and the drawer", async () => {
  expectFit("home", await onPhone(`${server.baseUrl}/home`, '[aria-label="Open navigation"]'));
  expectFit("drawer", await onPhone(`${server.baseUrl}/home`, '[aria-label="Open navigation"]', async (page) => {
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.getByRole("dialog").locator("[data-thread-title]").first().waitFor();
  }));
}, 60_000);

test("the Threads page on each tab, and an archived thread with its menu", async () => {
  expectFit("threads page, active", await onPhone(`${server.baseUrl}/threads`, '[data-slot="thread-row"]'));
  expectFit("threads page, selecting", await onPhone(`${server.baseUrl}/threads`, '[data-slot="thread-row"]', async (page) => {
    await page.getByRole("button", { name: "Select", exact: true }).tap();
    await page.locator('[data-slot="thread-row"]').first().tap();
    await page.locator('[data-slot="threads-selected-count"]', { hasText: "1 selected" }).waitFor();
  }));
  expectFit("threads page, archived", await onPhone(`${server.baseUrl}/threads`, '[data-slot="threads-page"]', async (page) => {
    await page.getByRole("tab", { name: /^Archived/ }).tap();
    await page.locator('[data-slot="thread-row"]').first().waitFor();
    await page.getByRole("button", { name: "Archived thread actions" }).waitFor();
  }));
  const url = `${server.baseUrl}/threads/${archivedThreadId}`;
  expectFit("archived thread", await onPhone(url, '[data-slot="archived-note"]'));
  expectFit("archived thread, its menu open", await onPhone(url, '[data-slot="archived-note"]', async (page) => {
    await page.getByRole("button", { name: "Thread actions" }).tap();
    await page.getByRole("menuitem").first().waitFor();
  }));
}, 60_000);

// Threads open beside the personal agent: on a phone tabs of its panel. More than
// fit: the row ends in its list of all tabs and the "+"; a tab shows the
// thread's conversation.
test("The personal agent's panel with more threads open beside it than fit", async () => {
  const tabs = `${server.baseUrl}/api/agents/personal/thread-tabs`;
  const listed = await (await fetch(`${server.baseUrl}/api/agents/manager/threads`)).json() as { threads: Array<{ id: string }> };
  const open = [threadId, ...listed.threads.map((t) => t.id).filter((id) => id !== threadId)].slice(0, 4);
  for (const id of open) await fetch(tabs, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: id }) });
  try {
    expectFit("agent's panel, thread tabs past the row", await onPhone(`${server.baseUrl}/agent`, '[role="tablist"][aria-label="View"]', async (page) => {
      await page.getByRole("tablist", { name: "View" }).getByRole("tab", { name: "Panel" }).tap();
      await page.getByRole("button", { name: "All tabs" }).waitFor();
      await page.locator(`[role="tab"][data-thread-tab="${threadId}"]`).tap();
      await page.locator('[data-slot="thread-tab-view"] [data-slot="composer"]').waitFor();
    }));
  } finally {
    for (const id of open) await fetch(`${tabs}/${id}`, { method: "DELETE" });
  }
}, 60_000);

// The sheet's Close keeps the right end at both of its levels, and the
// phone's Back steps back a level, then closes the sheet, instead of leaving
// the thread.
test("on a phone the tool calls sheet keeps Close at its right end, and Back steps back to the list, then closes it, not the page", async () => {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await recordCloseWatchers(page);
  try {
    const url = `${server.baseUrl}/threads/${threadId}`;
    await page.goto(url);
    await page.locator('[data-slot="tool-run-line"]').first().tap();
    const sheet = page.locator('[data-slot="tool-sheet"]');
    await sheet.waitFor();
    // Risen: measured where it rests.
    await settle(page);
    // Where Close and the left slot sit, against the screen's 390px.
    const ends = async () => {
      const close = await sheet.getByRole("button", { name: "Close", exact: true }).boundingBox();
      // Drawn with the level it belongs to: read, not waited for (a wait for
      // one that is not there took the whole timeout).
      const backButton = sheet.getByRole("button", { name: "All calls in this run", exact: true });
      const back = (await backButton.count()) > 0 ? await backButton.boundingBox() : null;
      return { closeRight: Math.round(close!.x + close!.width), back: back ? Math.round(back.x) : null };
    };
    const list = await ends();
    expect(list.back).toBeNull();
    expect(list.closeRight).toBeGreaterThan(390 - 20);
    await sheet.locator('[data-slot="tool-call"]').nth(1).tap();
    await sheet.locator('[data-slot="tool-details"]').waitFor();
    const details = await ends();
    expect(details.closeRight).toBe(list.closeRight);
    expect(details.back).toBeLessThan(20);

    // Back steps back as ‹ does: to the list first, then out of the sheet.
    expect(await pressBack(page)).toBe(true);
    await sheet.locator('[data-slot="tool-details"]').waitFor({ state: "detached" });
    await sheet.locator('[data-slot="tool-call"]').nth(1).waitFor();
    expect(await sheet.count()).toBe(1);
    expect(await pressBack(page)).toBe(true);
    await sheet.waitFor({ state: "detached" });
    expect(page.url()).toBe(url);
    await page.locator('[data-slot="tool-run-line"]').first().waitFor();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60_000);

// A chat image opens in place, over the thread: never a new tab, whose
// data: URL Chrome refuses to load (the tab stayed blank until reloaded).
test("a chat image opens in place: on a phone the screen's width, closed by Back and ×; on a desktop pane fitted, closed by Esc and a click beside it", async () => {
  const url = `${server.baseUrl}/threads/${threadId}`;
  const thumb = '[data-slot="user-bubble"] button[data-slot="image-open"]';
  const viewer = '[role="dialog"]:has(img[alt="build-12.png"])';
  const settled = (page: Page) => page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAnimations().length === 0);
  expectFit("thread, an image open", await onPhone(url, thumb, async (page) => {
    await page.locator(thumb).first().tap();
    await page.locator(viewer).waitFor();
  }));

  const phone = await browser.newContext(PHONE);
  try {
    const page = await phone.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await recordCloseWatchers(page);
    await page.goto(url);
    await page.locator(thumb).first().tap();
    const picture = page.locator(`${viewer} img`);
    await picture.waitFor();
    await settled(page);
    const box = (await picture.boundingBox())!;
    expect(Math.round(box.width)).toBe(390);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    // Back closes the picture, not the thread.
    expect(await pressBack(page)).toBe(true);
    await page.locator(viewer).waitFor({ state: "detached" });
    expect(page.url()).toBe(url);
    await page.locator(thumb).first().tap();
    await page.locator(viewer).getByRole("button", { name: "Close", exact: true }).tap();
    await page.locator(viewer).waitFor({ state: "detached" });
    expect(phone.pages().length).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await phone.close();
  }

  // Half of a 1440px screen: two panes side by side.
  const desktop = await browser.newContext({ viewport: { width: 720, height: 900 } });
  try {
    const page = await desktop.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const opener = page.locator(thumb).first();
    const small = (await opener.boundingBox())!;
    await opener.click();
    const picture = page.locator(`${viewer} img`);
    await picture.waitFor();
    await settled(page);
    const box = (await picture.boundingBox())!;
    expect(box.width).toBeGreaterThan(small.width * 3);
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThan(720);
    expect(box.y).toBeGreaterThan(0);
    expect(box.y + box.height).toBeLessThan(900);
    await page.keyboard.press("Escape");
    await page.locator(viewer).waitFor({ state: "detached" });
    // Focus is back on the thumbnail that opened it.
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-slot") === "image-open");
    await opener.click();
    await picture.waitFor();
    await settled(page);
    // A click on the picture keeps it; one beside it closes it.
    await picture.click();
    expect(await page.locator(viewer).count()).toBe(1);
    await page.mouse.click(8, 450);
    await page.locator(viewer).waitFor({ state: "detached" });
    expect(desktop.pages().length).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await desktop.close();
  }
}, 60_000);

test("an image in the composer opens in place too: tapped in its middle on a phone, clicked on a desktop; its × only removes it", async () => {
  const url = `${server.baseUrl}/threads/${threadId}`;
  const thumb = 'button[data-slot="image-open"]:has(img[alt="shot.png"])';
  const viewer = '[role="dialog"]:has(img[alt="shot.png"])';
  const attach = async (page: Page) => {
    await page.locator('input[type="file"]').first().setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await page.locator(thumb).waitFor();
  };

  const phone = await browser.newContext(PHONE);
  try {
    const page = await phone.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await recordCloseWatchers(page);
    await page.goto(url);
    await attach(page);
    // A tap in the middle opens it: the remove button's corner leaves it.
    await page.locator(thumb).tap();
    const picture = page.locator(`${viewer} img`);
    await picture.waitFor();
    expect(await picture.getAttribute("src")).toStartWith("data:image/png;base64,");
    expect(await pressBack(page)).toBe(true);
    await page.locator(viewer).waitFor({ state: "detached" });
    expect(page.url()).toBe(url);
    // Still attached; its × takes it out and opens nothing.
    await page.getByRole("button", { name: "Remove image" }).tap();
    await page.locator(thumb).waitFor({ state: "detached" });
    expect(await page.locator(viewer).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await phone.close();
  }

  const desktop = await browser.newContext({ viewport: { width: 720, height: 900 } });
  try {
    const page = await desktop.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await attach(page);
    await page.locator(thumb).click();
    await page.locator(`${viewer} img`).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(viewer).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Remove image" }).click();
    await page.locator(thumb).waitFor({ state: "detached" });
    expect(await page.locator(viewer).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await desktop.close();
  }
}, 60_000);

test("a thread: its header, composer, transcript and a tool call's details", async () => {
  const url = `${server.baseUrl}/threads/${threadId}`;
  expectFit("thread", await onPhone(url, '[data-slot="tool-run-line"]'));
  expectFit("thread, a call open", await onPhone(url, '[data-slot="tool-run-line"]', async (page) => {
    await page.locator('[data-slot="tool-run-line"]').first().tap();
    await page.locator('[data-slot="tool-call"]').nth(1).tap();
    await page.locator('[data-slot="tool-details"]').waitFor();
  }));
  expectFit("thread, its menu open", await onPhone(url, '[data-slot="tool-run-line"]', async (page) => {
    await page.getByRole("button", { name: "Thread actions" }).tap();
    await page.getByRole("menuitem").first().waitFor();
  }));
  // Sent while a turn runs, messages wait in the composer's queue, each
  // line with its remove. The server is told to queue every send.
  expectFit("thread, two messages queued", await onPhone(url, '[data-slot="tool-run-line"]', async (page) => {
    const composer = page.getByPlaceholder("Message the manager…");
    for (const text of ["Then check the evict path", "And rerun the race test"]) {
      await composer.fill(text);
      await page.getByRole("button", { name: "Send message" }).tap();
    }
    await page.getByRole("button", { name: "Remove queued message" }).nth(1).waitFor();
  }, async (page) => {
    await page.route("**/api/agents/threads/*/messages", (route) => route.request().method() === "POST"
      ? route.fulfill({ json: { threadId, messageId: null, wakeId: null, queued: true } })
      : route.fallback());
  }));
  expectFit("thread, an image attached", await onPhone(url, '[data-slot="tool-run-line"]', async (page) => {
    await page.locator('input[type="file"]').first().setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Remove image" }).waitFor();
  }));
  const agentUrl = `${server.baseUrl}/agent`;
  // A thread the agent heard back from: its name on the line over the reply
  // is a control, and opens what the thread said in the sheet.
  expectFit("agent, a thread's notice over a reply", await onPhone(agentUrl, '[data-slot="notice-name"]'));
  expectFit("agent, what a thread said", await onPhone(agentUrl, '[data-slot="notice-name"]', async (page) => {
    await page.locator('[data-slot="notice-name"]').tap();
    await page.locator('[data-slot="thread-reply"] [data-slot="thread-reply-go"]').waitFor();
  }));
  // Voice is the personal agent's: started on its page, its bar there. The
  // mic is a silent stream and the socket the test's, so voice is live.
  const listens = (page: Page) => fakeVoiceSocket(page, { type: "ready" }, { silentMic: true });
  expectFit("agent, voice on", await onPhone(agentUrl, '[aria-label="Start voice"]', async (page) => {
    await page.getByRole("button", { name: "Start voice" }).tap();
    await page.getByRole("button", { name: /mute microphone/i }).first().waitFor();
    await page.getByText("Listening").first().waitFor();
  }, listens));
  // Another device took voice: Resume here and Stop, side by side.
  expectFit("agent, voice moved", await onPhone(agentUrl, '[aria-label="Start voice"]', async (page) => {
    await page.getByRole("button", { name: "Start voice" }).tap();
    await page.locator('[data-slot="voice-moved"]').getByRole("button", { name: "Stop" }).waitFor();
  }, (page) => fakeVoiceSocket(page, { type: "superseded" }, { silentMic: true })));
  // Voice on, then elsewhere: a strip under the top bar.
  expectFit("memory, voice on", await onPhone(agentUrl, '[aria-label="Start voice"]', async (page) => {
    await page.getByRole("button", { name: "Start voice" }).tap();
    await page.getByText("Listening").first().waitFor();
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.getByRole("link", { name: "Memory" }).first().tap();
    await page.locator('[data-slot="voice-strip"]').waitFor();
  }, listens));
  // Voice stopped by a limit: why, with Dismiss — above the agent's
  // composer, and in the strip's place elsewhere. The test's socket ends
  // voice the moment it opens.
  const stopsAtOnce = (page: Page) => fakeVoiceSocket(page, { type: "closed", reason: "idle-timeout", afterMs: 300_000 }, { silentMic: true });
  expectFit("agent, voice stopped", await onPhone(agentUrl, '[aria-label="Start voice"]', async (page) => {
    await page.getByRole("button", { name: "Start voice" }).tap();
    await page.locator('[data-slot="voice-stopped"] [aria-label="Dismiss"]').waitFor();
  }, stopsAtOnce));
  expectFit("memory, voice stopped", await onPhone(agentUrl, '[aria-label="Start voice"]', async (page) => {
    await page.getByRole("button", { name: "Start voice" }).tap();
    await page.locator('[data-slot="voice-stopped"]').waitFor();
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.getByRole("link", { name: "Memory" }).first().tap();
    await page.locator('[data-slot="voice-stopped-notice"] [aria-label="Dismiss"]').waitFor();
  }, stopsAtOnce));
  expectFit("thread, a generic call open", await onPhone(url, '[data-slot="tool-run-line"]', async (page) => {
    await page.locator('[data-slot="tool-run-line"]').first().tap();
    await page.locator('[data-slot="tool-call"]').nth(3).tap();
    await page.getByRole("button", { name: "JSON" }).waitFor();
    await page.getByRole("button", { name: "Copy note" }).waitFor();
  }));
  expectFit("thread, a call of only writing open", await onPhone(url, '[data-slot="tool-run-line"]', async (page) => {
    await page.locator('[data-slot="tool-run-line"]').first().tap();
    await page.locator('[data-slot="tool-call"]').nth(4).tap();
    await page.getByRole("button", { name: /^Copy a very long argument/ }).waitFor();
  }));
}, 60_000);


test("Projects, and a project's page", async () => {
  expectFit("projects", await onPhone(`${server.baseUrl}/projects`, '[data-slot="project-row"]'));
  expectFit("project", await onPhone(`${server.baseUrl}/projects/md-project-1-touch`, "text=evicthook"));
}, 60_000);

test("first run, and a window that has closed", async () => {
  const fresh = await startServer();
  try {
    // The checklist's steps, then its Project step.
    expectFit("first-run setup", await onPhone(`${fresh.baseUrl}/home`, 'button:has-text("Agent preferences")'));
    expectFit("first-run setup, its project step", await onPhone(`${fresh.baseUrl}/home`, 'button:has-text("Agent preferences")', async (page) => {
      await page.locator("button", { hasText: /^\d*\s*Project/ }).last().tap();
      await page.getByRole("button", { name: "New project" }).last().scrollIntoViewIfNeeded();
    }));
  } finally {
    fresh.cleanup();
  }
  expectFit("a window not found", await onPhone(`${server.baseUrl}/terminals/window/%40999`, "text=Back to Terminals"));
}, 90_000);


test("with a mouse nothing changes: no touch area, rows at their desktop height", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.locator('[data-slot="tool-run-line"]').first().waitFor();
    const shape = await page.evaluate(() => ({
      afterOnButtons: [...document.querySelectorAll("button")].filter((b) => getComputedStyle(b, "::after").content !== "none").length,
      buttons: document.querySelectorAll("button").length,
      threadRow: Math.round(document.querySelector<HTMLElement>("[data-thread-title]")!.getBoundingClientRect().height)
    }));
    expect(shape.buttons).toBeGreaterThan(0);
    expect(shape.afterOnButtons).toBe(0);
    expect(shape.threadRow).toBe(28);
    // Row-filling links and buttons fill their rows on a touch screen only.
    await page.goto(`${server.baseUrl}/memory`);
    await page.getByText("project-1 releases are tagged").first().waitFor();
    const scopeLink = await page.locator('a[href*="scope=project"]').first().evaluate((a) => Math.round(a.getBoundingClientRect().height));
    expect(scopeLink).toBeLessThanOrEqual(20);
    await page.goto(`${server.baseUrl}/settings?tab=providers&provider=openai`);
    const back = page.locator('[data-slot="provider-page"] > button').first();
    await back.waitFor();
    expect(await back.evaluate((b) => Math.round(b.getBoundingClientRect().height))).toBeLessThanOrEqual(20);
  } finally {
    await context.close();
  }
}, 30_000);
