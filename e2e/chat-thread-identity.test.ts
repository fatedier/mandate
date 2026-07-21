import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Route } from "playwright";
import { SSE_EVENTS, type AgentClientMessageDto, type AgentThreadDto } from "../src/shared/api-contracts";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const now = "2026-09-15T00:00:00.000Z";
function thread(id: string): AgentThreadDto {
  return {
    id, scope: "manager", scopeId: null, kind: "main", parentThreadId: null, ephemeral: false,
    forkContextStartSeq: null, forkContextEndSeq: null, closedAt: null,
    createdAt: now, updatedAt: now, archivedAt: null
  };
}
function message(threadId: string, seq: number, text: string): AgentClientMessageDto {
  return {
    id: `${threadId}-${seq}`, threadId, seq, role: "assistant", source: "self",
    sourceThreadId: null, wakeId: null, content: { type: "assistant", text }, createdAt: now
  };
}

for (const action of ["history", "send"] as const) {
  test(`new chat ignores a delayed ${action} response from the previous conversation`, async () => {
    const fixture = startWorkspaceFixture();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let activeId = "old-thread";
    let receive!: (route: Route) => void;
    const pending = new Promise<Route>((resolve) => { receive = resolve; });
    await page.route("**/api/agents/manager/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith("/new-chat")) {
        activeId = "new-thread";
        await route.fulfill({ json: { ok: true, oldThreadId: "old-thread", newThreadId: activeId } });
      } else if (url.searchParams.has("before") || request.method() === "POST" && url.pathname.endsWith("/messages")) {
        receive(route);
      } else if (url.pathname.endsWith("/thread")) {
        await route.fulfill({ json: {
          thread: thread(activeId),
          messages: activeId === "old-thread" && !url.searchParams.has("since")
            ? [message(activeId, 51, "Current old conversation")]
            : [],
          hasMore: activeId === "old-thread", contextUsage: null
        } });
      } else await route.continue();
    });
    try {
      await page.goto(`${fixture.baseUrl}/projects`);
      await page.getByText("Current old conversation", { exact: true }).waitFor();
      if (action === "history") await page.getByRole("button", { name: "Load 50 older", exact: true }).click();
      else {
        await page.getByPlaceholder("Message the agent…").fill("Pending old message");
        await page.getByPlaceholder("Message the agent…").press("Enter");
      }
      const route = await pending;
      await page.getByRole("button", { name: "New manager chat", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "New chat", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      fixture.emit(SSE_EVENTS.agentMessageAppended, {
        threadId: activeId, message: message(activeId, 1, "New conversation reply")
      });
      await page.getByText("New conversation reply", { exact: true }).waitFor();

      const finished = page.waitForEvent("requestfinished", { predicate: (request) => request === route.request() });
      await route.fulfill({ json: action === "history"
        ? { thread: thread("old-thread"), messages: [message("old-thread", 1, "Stale conversation reply")], hasMore: false }
        : { threadId: "old-thread", messageId: "old-user-message", wakeId: "old-wake", queued: false }
      });
      await finished;
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      fixture.emit(SSE_EVENTS.agentWakeFinished, { threadId: "old-thread", wakeId: "old-wake", status: "finished" });
      fixture.emit(SSE_EVENTS.agentMessageAppended, {
        threadId: activeId, message: message(activeId, 2, "Completion barrier")
      });
      await page.getByText("Completion barrier", { exact: true }).waitFor();
      expect(await page.getByText("New conversation reply", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Stale conversation reply", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Stop agent", exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 15000);
}
