import { afterAll, beforeAll, expect, test } from "bun:test";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";

let fixture: ReturnType<typeof startWorkspaceFixture>;
const browser = browserForFile();
beforeAll(() => {
  fixture = startWorkspaceFixture();
});
afterAll(() => { fixture?.stop(); });

test("Projects renders from SSE with one request per initial collection", async () => {
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(url.pathname + url.search);
  });
  try {
    await page.goto(fixture.baseUrl + "/projects");
    await page.getByText("Worker pane zoom", { exact: true }).first().waitFor();
    await page.waitForTimeout(200);
    expect(requests).not.toContain("/api/state");
    expect(requests.filter((url) => url.startsWith("/api/work-items?"))).toEqual(["/api/work-items?limit=200"]);
    // No chat is on this page, so no conversation's history is read.
    expect(requests.filter((url) => url.startsWith("/api/agents/threads/") || url.includes("/thread?"))).toEqual([]);
    for (const url of ["/api/agents/active-wakes", "/api/events"]) {
      expect(requests.filter((request) => request === url)).toHaveLength(1);
    }
    // The setup checklist lives on Home now; nothing here asks twice.
    for (const url of ["/api/setup/status", "/api/settings/config"]) {
      expect(requests.filter((request) => request === url).length).toBeLessThanOrEqual(1);
    }
  } finally { await page.close(); }
}, 15000);

test("activity ages advance locally without another snapshot or duplicate error toasts", async () => {
  const page = await browser.newPage();
  try {
    await page.clock.install({ time: new Date("2026-09-13T00:00:00Z") });
    await page.goto(fixture.baseUrl + "/projects");
    const card = page.getByRole("link").filter({ hasText: "Worker pane zoom" }).first();
    await card.getByText("just now", { exact: true }).waitFor();

    // The errors go first: the clock's jump below outlasts the stream's
    // heartbeat, so the page reconnects, and an event sent while it does is lost.
    fixture.emit("error", { message: "fixture polling failure" });
    const toasts = page.locator("[data-sonner-toast]").filter({ hasText: "fixture polling failure" });
    await toasts.first().waitFor();
    fixture.emit("error", { message: "fixture polling failure", at: "later" });
    // A browser task after the second SSE frame lets BannerToaster run.
    await page.waitForTimeout(100);
    expect(await toasts.count()).toBe(1);

    await page.clock.fastForward(120000);
    await card.getByText("2m ago", { exact: true }).waitFor();
  } finally { await page.close(); }
}, 15000);
