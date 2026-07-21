import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { api } from "@/lib/api-paths";
import { randomId } from "@/lib/random-id";
import type {
  UiLocationRequest,
  UiPageSummaryRequest,
  UiLocation,
  UiPageSummary,
  UiRouteKind,
  UiSummaryRequestPayload
} from "@shared/api-contracts";

const CLIENT_ID_KEY = "mandate.clientId";
const LAST_NON_CANVAS_PATH_KEY = "mandate.lastNonCanvasPath";

type UiPageSummaryProvider = () => Record<string, unknown> | Promise<Record<string, unknown>>;
type LocationListener = (location: UiLocation) => void;

let currentLocation: UiLocation | null = null;
let clientIdCache: string | null = null;
const locationListeners = new Set<LocationListener>();
const summaryProviders = new Map<string, UiPageSummaryProvider>();

export function getClientId(): string {
  if (clientIdCache) return clientIdCache;
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) {
      clientIdCache = existing;
      return existing;
    }
    const next = randomId();
    window.sessionStorage.setItem(CLIENT_ID_KEY, next);
    clientIdCache = next;
    return next;
  } catch {
    clientIdCache = `client-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    return clientIdCache;
  }
}

export function getCurrentUiLocation(): UiLocation {
  if (currentLocation) return currentLocation;
  return deriveUiLocation({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash
  });
}

export function subscribeUiLocation(listener: LocationListener): () => void {
  locationListeners.add(listener);
  if (currentLocation) listener(currentLocation);
  return () => { locationListeners.delete(listener); };
}

export function getLastNonCanvasPath(): string {
  try {
    const value = window.sessionStorage.getItem(LAST_NON_CANVAS_PATH_KEY);
    if (value?.startsWith("/") && !value.startsWith("/canvas/")) return value;
  } catch {
    // Ignore storage failures and use the stable app fallback below.
  }
  return "/projects";
}

export function usePublishUiLocation(): void {
  const location = useLocation();
  useEffect(() => {
    const uiLocation = deriveUiLocation(location);
    currentLocation = uiLocation;
    rememberNonCanvasLocation(uiLocation);
    for (const listener of locationListeners) listener(uiLocation);
    void publishUiLocation(uiLocation);
  }, [location]);
}

export function useUiPageSummary(key: string, provider: UiPageSummaryProvider): void {
  const providerRef = useRef(provider);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);
  useEffect(() => {
    summaryProviders.set(key, () => providerRef.current());
    return () => { summaryProviders.delete(key); };
  }, [key]);
}

export async function respondToUiSummaryRequest(payload: UiSummaryRequestPayload): Promise<void> {
  if (payload.clientId !== getClientId()) return;

  let response: UiPageSummaryRequest;
  try {
    response = {
      requestId: payload.requestId,
      clientId: payload.clientId,
      ok: true,
      summary: await readCurrentPageSummary()
    };
  } catch (err) {
    response = {
      requestId: payload.requestId,
      clientId: payload.clientId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  await fetch(api.uiPageSummary, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(response)
  }).catch(() => {
    // Requester has its own timeout. Nothing useful to surface in the UI.
  });
}

function deriveUiLocation(input: Pick<Location, "pathname" | "search" | "hash">): UiLocation {
  const pathname = input.pathname || "/";
  const search = input.search || "";
  const hash = input.hash || "";
  const { routeKind, params } = routeInfo(pathname);
  return {
    clientId: getClientId(),
    capturedAt: new Date().toISOString(),
    path: `${pathname}${search}${hash}`,
    pathname,
    search,
    hash,
    routeKind,
    ...(params ? { params } : {})
  };
}

async function publishUiLocation(location: UiLocation): Promise<void> {
  const payload: UiLocationRequest = { location };
  await fetch(api.uiLocation, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {
    // Best-effort metadata. Chat sends the latest location too.
  });
}

function rememberNonCanvasLocation(location: UiLocation): void {
  if (location.pathname.startsWith("/canvas/")) return;
  if (!location.path.startsWith("/")) return;
  try {
    window.sessionStorage.setItem(LAST_NON_CANVAS_PATH_KEY, location.path);
  } catch {
    // Best-effort UI affordance only.
  }
}

async function readCurrentPageSummary(): Promise<UiPageSummary> {
  const location = getCurrentUiLocation();
  const provider = lastSummaryProvider();
  const summary = provider ? await provider() : {};
  return {
    clientId: getClientId(),
    capturedAt: new Date().toISOString(),
    location,
    summary
  };
}

function lastSummaryProvider(): UiPageSummaryProvider | null {
  let provider: UiPageSummaryProvider | null = null;
  for (const value of summaryProviders.values()) provider = value;
  return provider;
}

function routeInfo(pathname: string): { routeKind: UiRouteKind; params?: Record<string, string> } {
  const parts = pathname.split("/").filter(Boolean).map(safeDecode);
  if (parts.length === 0) return { routeKind: "projects" };

  if (parts[0] === "projects") {
    if (parts.length === 1) return { routeKind: "projects" };
    if (parts[2] === "features" && parts[1] && parts[3]) {
      if (parts[4] === "pane" && parts[5]) {
        return {
          routeKind: "pane",
          params: { projectSlug: parts[1], featureSlug: parts[3], paneId: parts[5] }
        };
      }
      return {
        routeKind: "feature",
        params: { projectSlug: parts[1], featureSlug: parts[3] }
      };
    }
  }

  if (parts[0] === "sessions") {
    if (parts.length === 1) return { routeKind: "sessions" };
    if (parts[2] === "windows" && parts[1] && parts[3]) {
      if (parts[4] === "pane" && parts[5]) {
        return {
          routeKind: "pane",
          params: { sessionName: parts[1], windowName: parts[3], paneId: parts[5] }
        };
      }
      return {
        routeKind: "session-window",
        params: { sessionName: parts[1], windowName: parts[3] }
      };
    }
    if (parts[1]) return { routeKind: "session", params: { sessionName: parts[1] } };
  }

  if (parts[0] === "activity") return { routeKind: "activity" };
  if (parts[0] === "settings") return { routeKind: "settings" };
  if (parts[0] === "canvas" && parts.length === 1) return { routeKind: "canvas" };
  if (parts[0] === "canvas" && parts[1]) return { routeKind: "canvas", params: { canvasId: parts[1] } };
  return { routeKind: "unknown" };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
