import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import type { ActivityGroupKey, ActivitySummaryResponse } from "../src/shared/api-contracts";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";

let fixture: ReturnType<typeof startWorkspaceFixture>;
let browser: Browser;

beforeAll(async () => {
  fixture = startWorkspaceFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  fixture?.stop();
});

function summary(url: URL, calls: number): ActivitySummaryResponse {
  return {
    days: Number(url.searchParams.get("days")),
    group: url.searchParams.get("group") as ActivityGroupKey,
    daily: [{
      date: "2026-09-13", calls, failed: 0, inputTokens: 1_000,
      outputTokens: 100, cacheReadTokens: 500, p50Ms: 1_000, p95Ms: 2_000, p99Ms: 3_000
    }],
    buckets: [{ bucket: "1-5s", calls }], groups: [],
    p50Ms: 1_000, p95Ms: 2_000, p99Ms: 3_000,
    ttft: { calls, p50Ms: 100, p95Ms: 200, p99Ms: 300 }
  };
}

test("Activity reuses each cached query, revalidates after five minutes and honors Refresh", async () => {
  const page = await browser.newPage();
  const startedAt = new Date("2026-09-13T12:00:00Z").getTime();
  const queries: string[] = [];
  let holdResponse: Promise<void> | null = null;
  let releaseResponse: (() => void) | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(startedAt);
  await page.addInitScript(() => localStorage.setItem("mandate.chat.drawerOpen.v1", "false"));
  await page.route("**/api/activity/summary?*", async (route) => {
    const url = new URL(route.request().url());
    queries.push(url.search);
    const data = summary(url, 100 + queries.length);
    await holdResponse;
    await route.fulfill({ json: data });
  });
  const headline = page.locator("#activity-panel-overview .text-xl").first();
  const home = async () => {
    await page.locator('nav a[href="/projects"]').click();
    await page.waitForFunction(() => !document.querySelector("#activity-panel-overview"));
  };
  const activity = () => page.locator('nav a[href="/activity"]').click();

  try {
    await page.goto(`${fixture.baseUrl}/activity`);
    await headline.getByText("101", { exact: true }).waitFor();
    expect(queries).toHaveLength(1);

    await home();
    await page.clock.setFixedTime(startedAt + 5 * 60_000 - 1);
    await activity();
    await headline.getByText("101", { exact: true }).waitFor();
    expect(queries).toHaveLength(1);

    await home();
    await page.clock.setFixedTime(startedAt + 5 * 60_000);
    holdResponse = new Promise((resolve) => { releaseResponse = resolve; });
    const revalidation = page.waitForRequest((request) => request.url().includes("/api/activity/summary"));
    await activity();
    await revalidation;
    await headline.getByText("101", { exact: true }).waitFor();
    expect(queries).toHaveLength(2);
    expect(await page.getByRole("button", { name: "Refreshing", exact: true }).isDisabled()).toBe(true);
    holdResponse = null;
    releaseResponse!();
    await headline.getByText("102", { exact: true }).waitFor();

    await home();
    await activity();
    await headline.getByText("102", { exact: true }).waitFor();
    expect(queries).toHaveLength(2);

    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await headline.getByText("103", { exact: true }).waitFor();
    expect(queries).toHaveLength(3);

    await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
    await headline.getByText("104", { exact: true }).waitFor();
    expect(queries.at(-1)).toContain("days=7");
    await page.getByRole("button", { name: "Last 30 days", exact: true }).click();
    await headline.getByText("103", { exact: true }).waitFor();
    expect(queries).toHaveLength(4);

    await page.reload();
    await headline.getByText("105", { exact: true }).waitFor();
    expect(queries).toHaveLength(5);
    expect(errors).toEqual([]);
  } finally {
    releaseResponse?.();
    await page.close();
  }
}, 20_000);

for (const tab of ["Overview", "Breakdown"]) {
  test(`opening Logs first still shows loading when switching to ${tab}`, async () => {
    const page = await browser.newPage();
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await page.addInitScript(() => localStorage.setItem("mandate.chat.drawerOpen.v1", "false"));
    await page.route("**/api/activity/calls?*", (route) => route.fulfill({ json: { calls: [] } }));
    await page.route("**/api/activity/summary?*", async (route) => {
      await responseGate;
      await route.fulfill({ json: summary(new URL(route.request().url()), 101) });
    });
    try {
      await page.goto(`${fixture.baseUrl}/activity?tab=logs`);
      const request = page.waitForRequest((request) => request.url().includes("/api/activity/summary"));
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await request;
      await page.locator('[role="tabpanel"] [data-slot="skeleton"]').first().waitFor();
      expect(await page.getByRole("button", { name: "Refreshing", exact: true }).isDisabled()).toBe(true);
      releaseResponse!();
      await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
      expect(await page.locator('[role="tabpanel"] [data-slot="skeleton"]').count()).toBe(0);
    } finally {
      releaseResponse?.();
      await page.close();
    }
  }, 15_000);
}

test("a failed manual Refresh preserves the headline and retries when returning from Home", async () => {
  const page = await browser.newPage();
  let requests = 0;
  await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"));
  await page.addInitScript(() => localStorage.setItem("mandate.chat.drawerOpen.v1", "false"));
  await page.route("**/api/activity/summary?*", async (route) => {
    requests += 1;
    if (requests === 2) {
      await route.fulfill({ status: 503, json: { error: "Summary unavailable" } });
    } else {
      await route.fulfill({ json: summary(new URL(route.request().url()), 100 + requests) });
    }
  });
  const headline = page.locator("#activity-panel-overview .text-xl").first();
  try {
    await page.goto(`${fixture.baseUrl}/activity`);
    await headline.getByText("101", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText("Summary unavailable", { exact: true }).waitFor();
    expect(await headline.textContent()).toBe("101");
    await page.locator('nav a[href="/projects"]').click();
    await page.waitForFunction(() => !document.querySelector("#activity-panel-overview"));
    await page.locator('nav a[href="/activity"]').click();
    await headline.getByText("103", { exact: true }).waitFor();
    expect(requests).toBe(3);
    expect(await page.getByText("Summary unavailable", { exact: true }).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 15_000);
