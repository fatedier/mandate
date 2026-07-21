import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";

let fixture: ReturnType<typeof startWorkspaceFixture>;
let browser: Browser;
beforeAll(async () => {
  fixture = startWorkspaceFixture();
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); fixture?.stop(); });

test("Projects renders from SSE with one request per initial collection", async () => {
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(url.pathname + url.search);
  });
  try {
    // A real network delay makes both the shell and mounted chat ask for the
    // same initial history before either can observe the hydrated store.
    await page.route("**/api/agents/manager/thread?limit=50", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.continue();
    });
    await page.goto(fixture.baseUrl + "/projects");
    await page.getByText("Worker pane zoom", { exact: true }).first().waitFor();
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("/api/agents/manager/thread?limit=50")));
    await page.waitForTimeout(200);
    expect(requests).not.toContain("/api/state");
    expect(requests.filter((url) => url.startsWith("/api/work-items?"))).toEqual(["/api/work-items?needsUser=any&limit=200"]);
    for (const url of ["/api/agents/manager/thread?limit=50", "/api/agents/active-wakes", "/api/setup/status", "/api/settings/config", "/api/events?messageFormat=delta&snapshotFormat=delta"]) {
      expect(requests.filter((request) => request === url)).toHaveLength(1);
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
    await page.clock.fastForward(120000);
    await card.getByText("2m ago", { exact: true }).waitFor();

    fixture.emit("error", { message: "fixture polling failure" });
    const toasts = page.locator("[data-sonner-toast]").filter({ hasText: "fixture polling failure" });
    await toasts.first().waitFor();
    fixture.emit("error", { message: "fixture polling failure", at: "later" });
    // A browser task after the second SSE frame lets BannerToaster run.
    await page.waitForTimeout(100);
    expect(await toasts.count()).toBe(1);
  } finally { await page.close(); }
}, 15000);
