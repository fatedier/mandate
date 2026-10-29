import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { startServer, type RunningServer } from "./helpers/server";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { pageOverflow } from "./helpers/page-overflow.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";

// Archived threads are read in the sidebar's Archived group and on their own
// page, read-only, and deleted for good: one from its page, or all at once.
// Against a real server: the rows really go.
const browser = browserForFile();
let server: RunningServer;
let openId = "";
let cacheId = "";
let uploadId = "";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      // The model is a closed local port: the memories an archive draws from
      // the thread fail at once, inside the container, so the thread is not
      // still at work when it is deleted.
      const configFile = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      config.models.providers.openai.baseURL = "http://127.0.0.1:9/v1";
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        const projects = new ProjectsStore(store.db);
        const features = new FeaturesStore(store.db);
        const say = (threadId: string, user: string, reply: string) => {
          agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: user } });
          agent.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: reply } });
        };
        // Archived oldest first: the group lists the newest first.
        uploadId = agent.createManagerThread("project-2 flaky upload").id;
        say(uploadId, "Why does the upload test flake?", "A race on the temp dir; fixed in the harness.");
        agent.archiveThread(uploadId);
        cacheId = agent.createManagerThread("project-1 cache expiry").id;
        say(cacheId, "Look at the cache expiry leak.", "Found it: Stream.Close never closed doneCh.");
        const projectId = projects.insert({ name: "project-1", workingDir: "/tmp", isGit: false, gitRemote: null, tmuxSessionName: "md-project-1-archived", ownership: "app" });
        for (const name of ["evicthook", "racetest"]) {
          const featureId = features.insert({ projectId, name, mode: "shared-cwd", branch: null, worktreePath: null, tmuxWindowName: name, ownership: "app", ownerThreadId: cacheId });
          features.archive(featureId);
        }
        agent.archiveThread(cacheId);
        openId = agent.createManagerThread("project-1 release notes").id;
        say(openId, "Draft the 3.21 release notes.", "Drafted; waiting on the changelog.");
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);
afterAll(() => server?.cleanup());

// Exact: the Archived group's menu is "Archived thread actions".
const threadMenu = (page: Page) => page.getByRole("button", { name: "Thread actions", exact: true });
const archivedToggle = (page: Page) => page.locator("button[aria-expanded]", { hasText: /^Archived/ });
const archivedRows = (page: Page) => page.locator('[role="group"][aria-label="Archived threads"] a');

async function archivedOnServer(): Promise<string[]> {
  const response = await fetch(`${server.baseUrl}/api/agents/manager/threads?archived=1`);
  return ((await response.json()) as { archived: Array<{ title: string }> }).archived.map((t) => t.title);
}

test("archive, read, delete one, delete the rest: the group, the read-only page and the dialogs, with the rows gone on the server", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${openId}`);
    await page.getByPlaceholder("Message the manager…").waitFor();
    await archivedToggle(page).waitFor();
    expect(await archivedToggle(page).textContent()).toBe("Archived2");
    expect(await archivedToggle(page).getAttribute("aria-expanded")).toBe("false");

    // Archiving the open one moves it into the group.
    await threadMenu(page).click();
    await page.getByRole("menuitem", { name: "Archive thread" }).click();
    expect(await page.getByRole("dialog").locator('[data-slot="dialog-description"]').textContent())
      .toBe("It moves to Archived in the sidebar, where you can still read it.");
    await page.getByRole("dialog").getByRole("button", { name: "Archive", exact: true }).click();
    await page.waitForURL(`${server.baseUrl}/home`);
    await page.locator("button[aria-expanded]", { hasText: "Archived3" }).waitFor();
    await archivedToggle(page).click();
    expect(await archivedRows(page).count()).toBe(3);
    const titles = await archivedRows(page).evaluateAll((rows) => rows.map((row) => row.querySelectorAll("span")[1]!.textContent));
    expect(titles).toEqual(["project-1 release notes", "project-1 cache expiry", "project-2 flaky upload"]);

    // An archived thread opens read-only, with the workers it had.
    await archivedRows(page).nth(1).click();
    await page.waitForURL(`${server.baseUrl}/threads/${cacheId}`);
    await page.locator('[data-slot="archived-note"]').waitFor();
    expect(await page.locator('[data-slot="archived-title"]').textContent()).toBe("project-1 cache expiry");
    expect(await page.locator('[data-slot="archived-date"]').textContent()).toMatch(/^Archived [A-Z][a-z]{2} \d{1,2}$/);
    await page.getByText("Found it: Stream.Close never closed doneCh.").waitFor();
    expect(await page.locator("textarea").count()).toBe(0);
    await page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]').click();
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.locator('section[aria-label="Archived"] button', { hasText: "evicthook" }).waitFor();
    expect(await panel.locator('section[aria-label="Archived"] button').count()).toBe(2);

    // Deleted from its page: the dialog counts what goes, then Home.
    await threadMenu(page).click();
    await page.getByRole("menuitem", { name: "Delete permanently…" }).click();
    const dialog = page.getByRole("dialog");
    expect(await dialog.locator("h2").textContent()).toBe("Delete “project-1 cache expiry” permanently?");
    expect(await dialog.locator('[data-slot="delete-list"] li').allTextContents())
      .toEqual(["the thread’s conversation", "its 2 workers, with their chats and plans"]);
    await dialog.getByRole("button", { name: "Delete permanently" }).click();
    await page.waitForURL(`${server.baseUrl}/home`);
    await page.locator("button[aria-expanded]", { hasText: "Archived2" }).waitFor();
    expect(await archivedOnServer()).toEqual(["project-1 release notes", "project-2 flaky upload"]);
    // Its address now finds nothing.
    await page.goto(`${server.baseUrl}/threads/${cacheId}`);
    await page.getByText("Thread not found").waitFor();

    // The rest at once, from the group's menu (shown on hover on a desktop).
    await archivedToggle(page).hover();
    await page.getByRole("button", { name: "Archived thread actions" }).click();
    await page.getByRole("menuitem", { name: "Delete all archived threads…" }).click();
    expect(await dialog.locator("h2").textContent()).toBe("Delete all 2 archived threads permanently?");
    await dialog.getByRole("button", { name: "Delete 2 threads" }).click();
    await archivedToggle(page).waitFor({ state: "detached" });
    expect(await archivedOnServer()).toEqual([]);
    expect(await page.locator("[data-thread-title]").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60_000);

test("a phone: the group in the drawer, its menu always shown, and an archived thread read full screen", async () => {
  // One of its own: the first test deletes the seeded ones.
  const response = await fetch(`${server.baseUrl}/api/agents/manager/threads`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "project-3 docs pass" })
  });
  const created = ((await response.json()) as { thread: { id: string } }).thread.id;
  await fetch(`${server.baseUrl}/api/agents/manager/threads/${created}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true })
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/home`);
    await page.getByRole("button", { name: "Open navigation" }).tap();
    const drawer = page.getByRole("dialog");
    const toggle = drawer.locator("button[aria-expanded]", { hasText: /^Archived/ });
    await toggle.waitFor();
    // No hover on a touch screen: the menu is in sight.
    expect(await drawer.getByRole("button", { name: "Archived thread actions" }).evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await toggle.tap();
    await drawer.locator('[role="group"][aria-label="Archived threads"] a', { hasText: "project-3 docs pass" }).tap();
    await page.waitForURL(`${server.baseUrl}/threads/${created}`);
    await page.locator('[data-slot="archived-note"]').waitFor();
    expect(await page.locator("header").first().textContent()).toContain("project-3 docs pass");
    expect(await page.locator("textarea").count()).toBe(0);
    expect(await pageOverflow(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60_000);
