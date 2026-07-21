import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Route } from "playwright";
import { SSE_EVENTS, type ActiveWakeDto, type SseEventPayloadMap } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const wake: ActiveWakeDto = {
  threadId: "zoom-thread", wakeId: "wake-1", scope: "worker", scopeId: "zoom-worker"
};

for (const active of [true, false]) {
  test(`a delayed wake snapshot preserves a Worker's ${active ? "running" : "idle"} card after SSE updates`, async () => {
    const fixture = startWorkspaceFixture();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let receive!: (route: Route) => void;
    const pending = new Promise<Route>((resolve) => { receive = resolve; });
    await page.route("**/api/agents/active-wakes", (route) => receive(route));
    try {
      await page.goto(`${fixture.baseUrl}/projects`);
      const route = await pending;
      const card = page.locator(`a[href="${WORKER_PATH}"]`).filter({ hasText: "Worker pane zoom" });
      const dot = card.locator(".bg-phase-working");
      await dot.waitFor();
      // Remove terminal activity so only the wake drives the card's pulse.
      fixture.emit(SSE_EVENTS.snapshot, { sessions: [], counts: { totalWindows: 0 } });
      await card.locator(".animate-live").waitFor({ state: "detached" });
      fixture.emit(SSE_EVENTS.agentWakeStarted, { ...wake, reason: "user" } satisfies SseEventPayloadMap["agentWakeStarted"]);
      await card.locator(".animate-live").waitFor();
      if (!active) {
        fixture.emit(SSE_EVENTS.agentWakeFinished, { ...wake, status: "finished" } satisfies SseEventPayloadMap["agentWakeFinished"]);
        await card.locator(".animate-live").waitFor({ state: "detached" });
      }

      const finished = page.waitForEvent("requestfinished", {
        predicate: (request) => new URL(request.url()).pathname === "/api/agents/active-wakes"
      });
      await route.fulfill({ json: { wakes: active ? [] : [wake] } });
      await finished;
      // Allow the delivered response and React's following render to finish.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      expect(await dot.evaluate((element) => element.classList.contains("animate-live"))).toBe(active);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 10000);
}
