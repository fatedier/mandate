import {
  UI_ROUTE_KINDS,
  type UiLocation,
  type UiPageSummary,
  type UiRouteKind,
  type UiSummaryRequestPayload,
  type UiSummaryResponsePayload
} from "../../../shared/ui-context.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { newId } from "../../platform/ids.js";
import type { AgentMessage } from "../agent/agent-store.js";

const UI_ROUTE_KIND_SET = new Set<string>(UI_ROUTE_KINDS);
const MAX_CLIENT_ID_LENGTH = 120;
const MAX_PATH_LENGTH = 1200;
const MAX_PARAM_KEY_LENGTH = 80;
const MAX_PARAM_VALUE_LENGTH = 300;
const MAX_PARAMS = 12;
const MAX_SUMMARY_JSON_LENGTH = 120_000;
const DEFAULT_SUMMARY_TIMEOUT_MS = 1500;
const MAX_SUMMARY_TIMEOUT_MS = 5000;

interface ClientState {
  location: UiLocation;
  updatedAt: number;
}

interface PendingRequest {
  clientId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: UiSummaryResponsePayload) => void;
}

export class UiContextRegistry {
  private readonly byClient = new Map<string, ClientState>();
  private readonly threadClientIds = new Map<string, string>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly emit: (
      event: typeof SSE_EVENTS.uiSummaryRequest,
      data: UiSummaryRequestPayload
    ) => void
  ) {}

  updateLocation(input: unknown): UiLocation | null {
    const location = parseUiLocation(input);
    if (!location) return null;
    this.byClient.set(location.clientId, {
      location,
      updatedAt: Date.now()
    });
    return location;
  }

  updateThreadLocation(threadId: string, input: unknown): UiLocation | null {
    const location = this.updateLocation(input);
    if (!location) return null;
    this.associateThread(threadId, location.clientId);
    return location;
  }

  associateThread(threadId: string, clientId: string | null | undefined): void {
    const normalized = normalizeClientId(clientId);
    if (!normalized) return;
    this.threadClientIds.set(threadId, normalized);
  }

  getLocationForThread(threadId: string): UiLocation | null {
    const clientId = this.threadClientIds.get(threadId);
    if (!clientId) return null;
    return this.byClient.get(clientId)?.location ?? null;
  }

  async requestPageSummary(threadId: string, timeoutMs = DEFAULT_SUMMARY_TIMEOUT_MS): Promise<UiSummaryResponsePayload> {
    const clientId = this.threadClientIds.get(threadId);
    if (!clientId) {
      return {
        requestId: "",
        clientId: "",
        ok: false,
        error: "No active client is associated with this agent thread."
      };
    }
    if (!this.byClient.has(clientId)) {
      return {
        requestId: "",
        clientId,
        ok: false,
        error: `Client '${clientId}' has no current page location.`
      };
    }

    const requestId = newId("ui");
    const safeTimeoutMs = Math.min(
      MAX_SUMMARY_TIMEOUT_MS,
      Math.max(100, Math.floor(timeoutMs))
    );
    const payload: UiSummaryRequestPayload = {
      requestId,
      clientId,
      timeoutMs: safeTimeoutMs
    };

    const promise = new Promise<UiSummaryResponsePayload>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          requestId,
          clientId,
          ok: false,
          error: "Timed out waiting for the frontend page summary."
        });
      }, safeTimeoutMs);
      this.pending.set(requestId, { clientId, timer, resolve });
    });

    this.emit(SSE_EVENTS.uiSummaryRequest, payload);
    return promise;
  }

  acceptSummaryResponse(input: unknown): boolean {
    const response = parseSummaryResponse(input);
    if (!response) return false;
    const pending = this.pending.get(response.requestId);
    if (!pending) return false;
    if (pending.clientId !== response.clientId) return false;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
    return true;
  }
}

export function latestUiLocationFromMessages(messages: AgentMessage[]): UiLocation | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user" || message.content.type !== "text") continue;
    const location = parseUiLocation(message.content.uiLocation);
    if (location) return location;
  }
  return null;
}

export function renderUiLocationPrompt(location: UiLocation | null): string {
  if (!location) return "";
  const params = location.params && Object.keys(location.params).length > 0
    ? `\nParams: ${JSON.stringify(location.params)}`
    : "";
  return [
    "## Current User Page",
    "This is lightweight browser location metadata supplied by Mandate.",
    "Do not assume page contents from it. If you need structured details about the visible page, call ui_read_page_summary.",
    `Path: ${location.path}`,
    `Route kind: ${location.routeKind}${params}`
  ].join("\n");
}

export function parseUiLocation(input: unknown): UiLocation | null {
  if (!isRecord(input)) return null;
  const clientId = normalizeClientId(input.clientId);
  if (!clientId) return null;
  const pathname = boundedString(input.pathname, MAX_PATH_LENGTH);
  const search = boundedString(input.search, MAX_PATH_LENGTH);
  const hash = boundedString(input.hash, MAX_PATH_LENGTH);
  const explicitPath = boundedString(input.path, MAX_PATH_LENGTH);
  const path = explicitPath || `${pathname}${search}${hash}`;
  const routeKind = normalizeRouteKind(input.routeKind);
  const capturedAt = normalizeIsoDate(input.capturedAt) ?? new Date().toISOString();
  return {
    clientId,
    capturedAt,
    path,
    pathname,
    search,
    hash,
    routeKind,
    params: normalizeParams(input.params)
  };
}

export function normalizeClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_ID_LENGTH) return null;
  return trimmed;
}

function parseSummaryResponse(input: unknown): UiSummaryResponsePayload | null {
  if (!isRecord(input)) return null;
  const requestId = boundedString(input.requestId, 200);
  const clientId = normalizeClientId(input.clientId);
  if (!requestId || !clientId) return null;
  if (!input.ok) {
    return {
      requestId,
      clientId,
      ok: false,
      error: boundedString(input.error, 1000) || "Page summary failed."
    };
  }
  const summary = parsePageSummary(input.summary);
  if (!summary) {
    return {
      requestId,
      clientId,
      ok: false,
      error: "Frontend returned an invalid page summary."
    };
  }
  const jsonLength = safeJsonLength(summary);
  if (jsonLength > MAX_SUMMARY_JSON_LENGTH) {
    return {
      requestId,
      clientId,
      ok: false,
      error: `Frontend page summary was too large (${jsonLength} bytes).`
    };
  }
  return { requestId, clientId, ok: true, summary };
}

function parsePageSummary(input: unknown): UiPageSummary | null {
  if (!isRecord(input)) return null;
  const clientId = normalizeClientId(input.clientId);
  const location = parseUiLocation(input.location);
  if (!clientId || !location) return null;
  const capturedAt = normalizeIsoDate(input.capturedAt) ?? new Date().toISOString();
  const summary = isRecord(input.summary) ? input.summary : {};
  return { clientId, capturedAt, location, summary };
}

function normalizeRouteKind(value: unknown): UiRouteKind {
  return typeof value === "string" && UI_ROUTE_KIND_SET.has(value)
    ? value as UiRouteKind
    : "unknown";
}

function normalizeParams(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value).slice(0, MAX_PARAMS)) {
    if (key.length > MAX_PARAM_KEY_LENGTH) continue;
    const normalized = boundedString(raw, MAX_PARAM_VALUE_LENGTH);
    if (normalized) result[key] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, max);
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString();
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return MAX_SUMMARY_JSON_LENGTH + 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
