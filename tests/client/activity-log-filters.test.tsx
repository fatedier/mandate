import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ActivityPage } from "@/routes/activity/ActivityPage";
import { activitySummaryCache } from "@/routes/activity/useActivitySummary";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

afterEach(() => {
  runCleanups();
  activitySummaryCache.clear();
});

/** One loaded call, of one model; the server knows of more. */
function serve(options: { failOptions?: boolean } = {}) {
  mockFetch(({ url }) => {
    if (url.includes("/api/activity/filter-options")) {
      return options.failOptions
        ? jsonResponse({ error: "database is locked" }, 500)
        : jsonResponse({ models: [{ provider: "gateway", model: "vendor/recent" }, { provider: "gateway", model: "vendor/old" }], purposes: ["memory_dream", "agent_wake_step"] });
    }
    if (url.includes("/api/activity/calls")) {
      return jsonResponse({ calls: [{
        id: "llm_1", purpose: "agent_wake_step", scopeType: null, scopeId: null, providerName: "gateway", provider: "openai-compatible",
        model: "vendor/recent", status: "succeeded", error: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
        startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:00:01.000Z", latencyMs: 1000,
        createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:01.000Z"
      }] });
    }
    return jsonResponse({ ok: true });
  });
}

async function renderLogs() {
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/activity?tab=logs"]}>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <ActivityPage />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  await settle();
  return host;
}

async function openFilter(host: HTMLElement, label: string): Promise<string[]> {
  await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); });
  return [...document.querySelectorAll("[cmdk-item]")].map((item) => item.textContent ?? "");
}

test("the model filter offers every model the log has, not only the loaded rows'", async () => {
  serve();
  const host = await renderLogs();
  expect(await openFilter(host, "Model")).toEqual(["Any model", "gateway / vendor/recent", "gateway / vendor/old"]);
  expect(document.querySelector("[cmdk-input]")?.getAttribute("placeholder")).toBe("Search models…");
});

test("the purpose filter offers every purpose the log has", async () => {
  serve();
  const host = await renderLogs();
  expect(await openFilter(host, "Purpose")).toEqual(["Any purpose", "memory_dream", "agent_wake_step"]);
  expect(document.querySelector("[cmdk-input]")?.getAttribute("placeholder")).toBe("Search purposes…");
});

test("without the server's list the filters still offer the loaded rows'", async () => {
  serve({ failOptions: true });
  const host = await renderLogs();
  expect(await openFilter(host, "Model")).toEqual(["Any model", "gateway / vendor/recent"]);
});
