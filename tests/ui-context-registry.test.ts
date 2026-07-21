import { expect, test } from "bun:test";
import { UiContextRegistry } from "../src/server/modules/ui-context/ui-context-registry.js";
import type { UiSummaryRequestPayload } from "../src/shared/ui-context.js";

test("UiContextRegistry routes explicit page summary requests to the associated client", async () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const registry = new UiContextRegistry((event, data) => {
    events.push({ event, data });
  });
  const location = registry.updateThreadLocation("thread-1", {
    clientId: "client-1",
    capturedAt: "2026-05-09T00:00:00.000Z",
    path: "/activity?status=failed",
    pathname: "/activity",
    search: "?status=failed",
    hash: "",
    routeKind: "activity",
    params: { status: "failed" }
  });

  const pending = registry.requestPageSummary("thread-1", 1000);
  expect(events).toHaveLength(1);
  expect(events[0]!.event).toBe("uiSummaryRequest");
  const request = events[0]!.data as UiSummaryRequestPayload;
  expect(request.clientId).toBe("client-1");

  const accepted = registry.acceptSummaryResponse({
    requestId: request.requestId,
    clientId: request.clientId,
    ok: true,
    summary: {
      clientId: request.clientId,
      capturedAt: "2026-05-09T00:00:01.000Z",
      location,
      summary: {
        page: "activity",
        filters: { status: "failed" }
      }
    }
  });

  expect(accepted).toBe(true);
  const response = await pending;
  expect(response.ok).toBe(true);
  expect(response.summary?.summary).toEqual({
    page: "activity",
    filters: { status: "failed" }
  });
});

test("UiContextRegistry returns an error when no client is associated", async () => {
  const registry = new UiContextRegistry(() => {
    throw new Error("should not emit");
  });
  const response = await registry.requestPageSummary("missing-thread", 100);
  expect(response.ok).toBe(false);
  expect(response.error).toContain("No active client");
});
