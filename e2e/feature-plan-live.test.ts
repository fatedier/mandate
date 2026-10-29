import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { SSE_EVENTS } from "../src/shared/api-contracts";
import { emptyPlan, type FeaturePlanDto } from "../src/shared/api/plans";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

const browser = browserForFile();

async function open(setup?: (page: Page) => Promise<void>, prepare?: (fixture: ReturnType<typeof startWorkspaceFixture>) => void) {
  const fixture = startWorkspaceFixture();
  prepare?.(fixture);
  let errors: string[];
  let page: Page | undefined;
  const close = async () => {
    try { await page?.close(); } finally { fixture.stop(); }
  };
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(5000);
    errors = trackPageErrors(page);
    await setup?.(page);
    await page.goto(fixture.baseUrl + WORKER_PATH);
  } catch (error) {
    await close();
    throw error;
  }
  // The worker's state shows once on its page, in the header; the Plan
  // section does not repeat it.
  return { fixture, page, errors, card: page.locator('section[aria-label="Plan"]'), state: page.locator('[data-slot="feature-status"]'), close };
}

test("a worker's plan update reaches the open Plan tab live", async () => {
  const env = await open();
  try {
    await env.card.locator('[data-slot="plan-conclusion"]').filter({ hasText: "No plan yet" }).waitFor();
    const plan: FeaturePlanDto = {
      ...emptyPlan("zoom-worker"),
      conclusion: "Waiting on upstream",
      steps: [{
        id: 1, title: "wait for project-2", status: "blocked", note: "project-2#17",
        createdAt: "2026-09-26T10:00:00.000Z", startedAt: "2026-09-26T10:00:00.000Z", blockedAt: "2026-09-26T10:05:00.000Z",
        completedAt: null, updatedAt: "2026-09-26T10:05:00.000Z"
      }],
      updatedAt: "2026-09-26T10:05:00.000Z"
    };
    // Pushed only, never stored: a plan fetch still in flight answers the
    // empty plan, so only the push can put this plan on the card.
    env.fixture.emit(SSE_EVENTS.featurePlanUpdated, { plan });
    await env.card.locator('[data-slot="plan-conclusion"]').filter({ hasText: "Waiting on upstream" }).waitFor();
    expect(await env.state.textContent()).toBe("Blocked");
    expect(await env.card.locator('[data-slot="feature-state"]').count()).toBe(0);
    expect(await env.card.locator('[data-slot="plan-step"]').count()).toBe(1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("returning to Plan retries a failed lookup for a work item outside the startup list", async () => {
  let lookups = 0;
  let failed!: Promise<unknown>;
  const env = await open(async (page) => {
    failed = page.waitForResponse((response) => response.url().includes("featureId=") && response.status() === 503);
    await page.route("**/api/work-items?*", async (route) => {
      if (!new URL(route.request().url()).searchParams.has("featureId")) {
        return route.fulfill({ json: { items: [], nextCursor: null } });
      }
      lookups++;
      if (lookups === 1) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      const response = await route.fetch();
      const body = await response.json() as { items: Array<Record<string, unknown>> };
      // What the second lookup brings: the worker's last wake failed.
      return route.fulfill({ response, json: { ...body, items: body.items.map((item) => ({ ...item, failedAt: new Date().toISOString(), failedMessage: "provider returned 500", failedKind: "error" })) } });
    });
  });
  try {
    await env.card.locator('[data-slot="plan-conclusion"]').waitFor();
    // The first lookup has failed in the page before the user leaves Plan.
    await failed;
    expect(lookups).toBe(1);
    expect(await env.state.textContent()).not.toBe("Failed");
    await env.page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await env.page.getByRole("tab", { name: "Plan", exact: true }).click();
    await env.state.filter({ hasText: "Failed" }).waitFor();
    expect(lookups).toBe(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

// The worker's history beside its plan: folded to its first line, opened in place.
test("the Plan tab shows the worker's record and opens it", async () => {
  const record = { id: "mem_rec1", content: "Release entries on a short TTL\n\n- **Done:** the cache keys carry the TTL", updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  const env = await open(undefined, (fixture) => fixture.setRecord("zoom-worker", record));
  try {
    const row = env.card.locator('[data-slot="plan-work-record"]');
    await row.waitFor();
    expect(await row.textContent()).toBe("Work record · Updated 2h ago");
    expect(await row.getAttribute("aria-expanded")).toBe("false");
    expect(await env.card.locator('[data-slot="plan-work-record-first-line"]').textContent()).toBe("Release entries on a short TTL");
    await row.click();
    const body = env.card.locator('[data-slot="plan-work-record-body"]');
    await body.locator("strong").filter({ hasText: "Done:" }).waitFor();
    expect(await body.isVisible()).toBe(true);
    expect(await row.getAttribute("aria-expanded")).toBe("true");
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

