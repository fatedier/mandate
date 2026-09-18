import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const files: FeatureChangedFileDto[] = ["a.ts", "b.ts"].map((path) => ({
  path, oldPath: null, status: "M", additions: 1, deletions: 1,
  binary: false, uncommitted: true, untracked: false
}));
const list: FeatureChangesResponse = {
  compare: "head", baseRef: "HEAD", mergeBase: "same-head", head: "same-head",
  files, totalAdditions: 2, totalDeletions: 2
};
function patch(path: string, revision: string) {
  return { path, patch: `@@ -1 +1 @@\n-old\n+${revision}-${path}\n`, truncated: false, binary: false };
}
async function chooseFile(page: Page, path: string) {
  const back = page.getByRole("button", { name: "Back to changed files", exact: true });
  if (await back.count()) await back.click();
  await page.locator(`[id="change-${path}"]`).click();
}

for (const mobile of [false, true]) {
  test(`Changes reuses pending and completed patches and refreshes at the same HEAD on ${mobile ? "mobile" : "desktop"}`, async () => {
    const fixture = startWorkspaceFixture();
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let revision = "before";
    let lists = 0;
    const requests: string[] = [];
    let receive!: (route: Route) => void;
    const pending = new Promise<Route>((resolve) => { receive = resolve; });
    let receiveRefresh!: (route: Route) => void;
    const refreshing = new Promise<Route>((resolve) => { receiveRefresh = resolve; });
    await page.route("**/api/features/zoom-worker/changes**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/file")) {
        const path = url.searchParams.get("path")!;
        requests.push(`${revision}:${path}`);
        if (requests.length === 1) receive(route);
        else await route.fulfill({ json: patch(path, revision) });
      } else {
        lists++;
        if (lists === 1) await route.fulfill({ json: list });
        else receiveRefresh(route);
      }
    });
    try {
      await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=changes&file=a.ts`);
      const held = await pending;
      await chooseFile(page, "b.ts");
      await page.getByText("before-b.ts", { exact: true }).waitFor();
      await chooseFile(page, "a.ts");
      await page.getByText("Loading…", { exact: true }).waitFor();
      expect(requests).toEqual(["before:a.ts", "before:b.ts"]);
      await held.fulfill({ json: patch("a.ts", revision) });
      await page.getByText("before-a.ts", { exact: true }).waitFor();
      await chooseFile(page, "b.ts");
      await page.getByText("before-b.ts", { exact: true }).waitFor();
      expect(requests.length).toBe(2);
      revision = "after";
      await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
      const heldRefresh = await refreshing;
      await chooseFile(page, "a.ts");
      await page.getByText("before-a.ts", { exact: true }).waitFor();
      await chooseFile(page, "b.ts");
      await page.getByText("before-b.ts", { exact: true }).waitFor();
      expect(requests.length).toBe(2);
      await heldRefresh.fulfill({ json: list });
      await page.getByText("after-b.ts", { exact: true }).waitFor();
      await chooseFile(page, "a.ts");
      await page.getByText("after-a.ts", { exact: true }).waitFor();
      expect(requests).toEqual(["before:a.ts", "before:b.ts", "after:b.ts", "after:a.ts"]);
      expect(lists).toBe(2);
      expect(await page.getByText("before-a.ts", { exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 20000);
}

test("leaving Changes cancels an unfinished patch and reopening can load it", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  let receive!: (route: Route) => void;
  const pending = new Promise<Route>((resolve) => { receive = resolve; });
  let requests = 0;
  await page.route("**/api/features/zoom-worker/changes**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/file")) {
      if (++requests === 1) receive(route);
      else await route.fulfill({ json: patch("a.ts", "reopened") });
    } else await route.fulfill({ json: list });
  });
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=changes`);
    const held = await pending;
    const cancelled = page.waitForEvent("requestfailed", { predicate: (request) => request === held.request() });
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await cancelled;
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.getByText("reopened-a.ts", { exact: true }).waitFor();
    expect(requests).toBe(2);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 15000);
