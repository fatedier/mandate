export const UI_ROUTE_KINDS = [
  "projects",
  "feature",
  "pane",
  "sessions",
  "session",
  "session-window",
  "activity",
  "settings",
  "canvas",
  "unknown"
] as const;

export type UiRouteKind = (typeof UI_ROUTE_KINDS)[number];

export interface UiLocation {
  clientId: string;
  capturedAt: string;
  path: string;
  pathname: string;
  search: string;
  hash: string;
  routeKind: UiRouteKind;
  params?: Record<string, string>;
}

export interface UiPageSummary {
  clientId: string;
  capturedAt: string;
  location: UiLocation;
  summary: Record<string, unknown>;
}

export interface UiSummaryRequestPayload {
  requestId: string;
  clientId: string;
  timeoutMs: number;
}

export interface UiSummaryResponsePayload {
  requestId: string;
  clientId: string;
  ok: boolean;
  summary?: UiPageSummary;
  error?: string;
}
