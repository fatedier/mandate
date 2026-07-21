import type { Hono } from "hono";
import {
  API_ROUTES,
  type UiContextWriteResponse,
  type UiLocationRequest,
  type UiPageSummaryRequest
} from "../../../shared/api-contracts.js";
import type { UiContextRegistry } from "./ui-context-registry.js";

export function mountUiContextRoutes(app: Hono, deps: { uiContextRegistry: UiContextRegistry }): void {
  app.post(API_ROUTES.uiLocation, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }

    const request = body as UiLocationRequest;
    const location = deps.uiContextRegistry.updateLocation(isRecord(request) ? request.location ?? request : request);
    if (!location) return c.json({ ok: false, error: "invalid UI location" }, 400);
    const response = { ok: true } satisfies UiContextWriteResponse;
    return c.json(response);
  });

  app.post(API_ROUTES.uiPageSummary, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }

    const request = body as UiPageSummaryRequest;
    const accepted = deps.uiContextRegistry.acceptSummaryResponse(request);
    if (!accepted) return c.json({ ok: false, error: "unknown or invalid summary request" }, 404);
    const response = { ok: true } satisfies UiContextWriteResponse;
    return c.json(response);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
