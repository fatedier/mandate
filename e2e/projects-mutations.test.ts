import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { SSE_EVENTS, type ProjectStateDto } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function holdRequests(page: Page, pattern: string) {
  const queued: Route[] = [];
  let receive: ((route: Route) => void) | undefined;
  let count = 0;
  await page.route(pattern, (route) => {
    count++;
    if (receive) {
      const listener = receive;
      receive = undefined;
      listener(route);
    } else queued.push(route);
  });
  return {
    count: () => count,
    next: () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<Route>((resolve) => { receive = resolve; })
  };
}

async function respond(page: Page, route: Route, response: Parameters<Route["fulfill"]>[0]) {
  const finished = page.waitForEvent("requestfinished", { predicate: (request) => request === route.request() });
  await route.fulfill(response);
  await finished;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

// Home rows carry the pin only for the pointer: on phones a passive row shows no
// actions at all and the pin lives in the feature page's ⋯ menu (see the phone
// test below). The desktop path still checks the aria-disabled guard on the
// row button.
for (const mobile of [false]) {
  test(`pin controls prevent overlapping saves and navigation on ${mobile ? "mobile" : "desktop"}`, async () => {
    const fixture = startWorkspaceFixture();
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = await holdRequests(page, "**/api/features/zoom-worker/pin");
    try {
      await page.goto(`${fixture.baseUrl}/projects`);
      const card = page.locator(`a[href="${WORKER_PATH}"]`).filter({ hasText: "Worker pane zoom" });
      await card.hover();
      await page.locator('button[aria-label="Pin to top"]:visible').click();
      const first = await requests.next();
      expect(first.request().postDataJSON()).toEqual({ pinned: true });
      const pending = page.locator('button[aria-label="Unpin"][aria-disabled="true"]');
      await pending.waitFor();
      // Force a real click despite aria-disabled to check the event guard and
      // ensure the surrounding card link does not navigate.
      await pending.click({ force: true });
      expect(requests.count()).toBe(1);
      expect(new URL(page.url()).pathname).toBe("/projects");
      const savedTime = "2026-09-15T00:00:00.000Z";
      await respond(page, first, { json: { feature: { pinnedAt: savedTime, updatedAt: savedTime } } });
      await page.locator('button[aria-label="Unpin"][aria-disabled="false"]').click();
      const second = await requests.next();
      expect(second.request().postDataJSON()).toEqual({ pinned: false });
      await card.hover();
      const pendingUnpin = page.locator('button[aria-label="Pin to top"][aria-disabled="true"]:visible');
      await pendingUnpin.click({ force: true });
      expect(requests.count()).toBe(2);
      expect(new URL(page.url()).pathname).toBe("/projects");
      await respond(page, second, { status: 503, json: { error: "Unavailable" } });
      await page.locator('button[aria-label="Unpin"][aria-disabled="false"]').waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 15000);
}

test("pin controls on a phone go through the feature page's ⋯ menu and survive a failed save", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = await holdRequests(page, "**/api/features/zoom-worker/pin");
  const openMenu = () => page.getByRole("button", { name: "Feature actions", exact: true }).click();
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    // A passive row on Home carries no pin on a phone.
    await page.goto(`${fixture.baseUrl}/projects`);
    await page.locator(`a[href="${WORKER_PATH}"]`).filter({ hasText: "Worker pane zoom" }).waitFor();
    expect(await page.locator('button[aria-label="Pin to top"]:visible').count()).toBe(0);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await openMenu();
    await page.getByRole("menuitem", { name: "Pin to top" }).click();
    const first = await requests.next();
    expect(first.request().postDataJSON()).toEqual({ pinned: true });
    expect(new URL(page.url()).pathname).toBe(WORKER_PATH);
    const savedTime = "2026-09-15T00:00:00.000Z";
    await respond(page, first, { json: { feature: { pinnedAt: savedTime, updatedAt: savedTime } } });
    await openMenu();
    await page.getByRole("menuitem", { name: "Unpin" }).click();
    const second = await requests.next();
    expect(second.request().postDataJSON()).toEqual({ pinned: false });
    await respond(page, second, { status: 503, json: { error: "Unavailable" } });
    // The failed unpin leaves the feature pinned.
    await openMenu();
    await page.getByRole("menuitem", { name: "Unpin" }).waitFor();
    await page.keyboard.press("Escape");
    expect(requests.count()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 15000);

test("project reorder locks all move controls and preserves incoming Workers on failure", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const requests = await holdRequests(page, "**/api/projects/reorder");
  try {
    const { projects } = await (await page.request.get(`${fixture.baseUrl}/api/state`)).json() as { projects: ProjectStateDto[] };
    const project = projects[0]!;
    const second = { ...project, id: "second-project", name: "Second project", tmuxSessionName: "second-project", sortOrder: 1000, features: [] };
    await page.goto(`${fixture.baseUrl}/projects`);
    await page.getByRole("heading", { name: project.name, exact: true }).waitFor();
    fixture.emit(SSE_EVENTS.projectsState, [project, second]);
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Second project", exact: true }) });
    await section.getByRole("button", { name: "Project actions" }).click();
    await page.getByRole("menuitem", { name: "Move to top", exact: true }).click();
    const request = await requests.next();
    await section.getByRole("button", { name: "Project actions" }).click();
    for (const name of ["Move to top", "Move up", "Move down"]) {
      expect(await page.getByRole("menuitem", { name, exact: true }).getAttribute("aria-disabled")).toBe("true");
    }
    await page.keyboard.press("Escape");
    const added = { ...project.features[0]!, id: "added-worker", name: "Added worker", tmuxWindowName: "added-worker" };
    fixture.emit(SSE_EVENTS.featureCreated, added);
    const addedCard = page.locator('section a[href="/projects/zoom-project/features/added-worker"]');
    await addedCard.waitFor();
    await respond(page, request, { status: 503, json: { error: "Unavailable" } });
    expect(await page.locator("section > header h2").allTextContents()).toEqual([project.name, second.name]);
    expect(await addedCard.count()).toBe(1);
    await section.getByRole("button", { name: "Project actions" }).click();
    expect(await page.getByRole("menuitem", { name: "Move to top", exact: true }).getAttribute("aria-disabled")).not.toBe("true");
    expect(requests.count()).toBe(1);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 15000);
