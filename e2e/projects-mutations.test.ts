import { expect, test } from "bun:test";
import type { Page, Route } from "playwright";
import { SSE_EVENTS } from "../src/shared/api-contracts";
import { startWorkspaceFixture, THREAD_ID, workerPath } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

const browser = browserForFile();
/** A Projects row links to its worker in its thread's panel. */
const ROW_HREF = `/threads/${THREAD_ID}?worker=zoom-worker`;

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
// actions at all and the pin lives in the worker's ⋯ menu in its thread (see the phone
// test below). The desktop path still checks the aria-disabled guard on the
// row button.
test("pin controls prevent overlapping saves and navigation on desktop", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  const requests = await holdRequests(page, "**/api/workers/zoom-worker/pin");
  try {
    await page.goto(`${fixture.baseUrl}/projects/zoom-project`);
    const card = page.locator(`a[href="${ROW_HREF}"]`).filter({ hasText: "Worker pane zoom" });
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
    expect(new URL(page.url()).pathname).toBe("/projects/zoom-project");
    const savedTime = "2026-09-15T00:00:00.000Z";
    await respond(page, first, { json: { worker: { pinnedAt: savedTime, updatedAt: savedTime } } });
    await page.locator('button[aria-label="Unpin"][aria-disabled="false"]').click();
    const second = await requests.next();
    expect(second.request().postDataJSON()).toEqual({ pinned: false });
    await card.hover();
    const pendingUnpin = page.locator('button[aria-label="Pin to top"][aria-disabled="true"]:visible');
    await pendingUnpin.click({ force: true });
    expect(requests.count()).toBe(2);
    expect(new URL(page.url()).pathname).toBe("/projects/zoom-project");
    await respond(page, second, { status: 503, json: { error: "Unavailable" } });
    await page.locator('button[aria-label="Unpin"][aria-disabled="false"]').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 15000);

test("pin controls on a phone go through the worker's ⋯ menu in its thread's sheet and survive a failed save", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  const requests = await holdRequests(page, "**/api/workers/zoom-worker/pin");
  const openMenu = () => page.locator('[data-slot="worker-sheet"]').getByRole("button", { name: "Worker actions", exact: true }).click();
  try {
    // A passive row carries no pin on a phone.
    await page.goto(`${fixture.baseUrl}/projects/zoom-project`);
    await page.locator(`a[href="${ROW_HREF}"]`).filter({ hasText: "Worker pane zoom" }).waitFor();
    expect(await page.locator('button[aria-label="Pin to top"]:visible').count()).toBe(0);
    await page.goto(`${fixture.baseUrl}${workerPath()}`);
    await openMenu();
    await page.getByRole("menuitem", { name: "Pin to top" }).click();
    const first = await requests.next();
    expect(first.request().postDataJSON()).toEqual({ pinned: true });
    expect(new URL(page.url()).pathname).toBe(`/threads/${THREAD_ID}`);
    const savedTime = "2026-09-15T00:00:00.000Z";
    await respond(page, first, { json: { worker: { pinnedAt: savedTime, updatedAt: savedTime } } });
    await openMenu();
    await page.getByRole("menuitem", { name: "Unpin" }).click();
    const second = await requests.next();
    expect(second.request().postDataJSON()).toEqual({ pinned: false });
    await respond(page, second, { status: 503, json: { error: "Unavailable" } });
    // The failed unpin leaves the worker pinned.
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

test("project reorder locks all move controls and preserves incoming workers on failure", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const requests = await holdRequests(page, "**/api/projects/reorder");
  try {
    const { projects } = fixture.connectState();
    const project = projects[0]!;
    const second = { ...project, id: "second-project", name: "Second project", tmuxSessionName: "second-project", sortOrder: 1000, workers: [] };
    await page.goto(`${fixture.baseUrl}/projects`);
    const rowOf = (id: string) => page.locator(`[data-slot="project-row"][data-project-id="${id}"]`);
    await rowOf(project.id).waitFor();
    fixture.emit(SSE_EVENTS.projectsState, [project, second]);
    const section = rowOf(second.id);
    await section.getByRole("button", { name: "Project actions" }).click();
    await page.getByRole("menuitem", { name: "Move to top", exact: true }).click();
    const request = await requests.next();
    await section.getByRole("button", { name: "Project actions" }).click();
    for (const name of ["Move to top", "Move up", "Move down"]) {
      expect(await page.getByRole("menuitem", { name, exact: true }).getAttribute("aria-disabled")).toBe("true");
    }
    await page.keyboard.press("Escape");
    const working = (n: number) => rowOf(project.id).locator('[data-slot="project-row-fact"]', { hasText: `${n} working` });
    await working(project.workers.length).waitFor();
    const added = { ...project.workers[0]!, id: "added-worker", name: "Added worker", tmuxWindowName: "added-worker" };
    fixture.emit(SSE_EVENTS.workerCreated, added);
    await working(project.workers.length + 1).waitFor();
    await respond(page, request, { status: 503, json: { error: "Unavailable" } });
    expect(await page.locator('[data-slot="project-row-name"]').allTextContents()).toEqual([project.name, second.name]);
    expect(await working(project.workers.length + 1).count()).toBe(1);
    await section.getByRole("button", { name: "Project actions" }).click();
    expect(await page.getByRole("menuitem", { name: "Move to top", exact: true }).getAttribute("aria-disabled")).not.toBe("true");
    expect(requests.count()).toBe(1);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 15000);
