import type { NavigateFunction } from "react-router";
import { toast } from "sonner";
import { UI_ACTIONS, type UiActionEvent } from "@shared/api-contracts";

let currentNavigate: NavigateFunction | null = null;

export function setNavigate(navigate: NavigateFunction | null): void {
  currentNavigate = navigate;
}

function readPayloadObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  return payload as Record<string, unknown>;
}

export function dispatchUiAction(event: UiActionEvent): void {
  switch (event.action) {
    case UI_ACTIONS.navigate: {
      if (!currentNavigate) return;
      const path = String(readPayloadObject(event.payload).path ?? "");
      if (!path.startsWith("/")) return;
      try { toast.info(`Agent navigated to ${path}`); } catch { /* test env */ }
      // Just navigate. Don't touch the chat drawer — its open/scope state
      // belongs to the user. If they were in overview chat they stay in
      // overview chat; if the drawer was closed it stays closed.
      currentNavigate(path);
      ensureNavigationLanded(path);
      return;
    }
    case UI_ACTIONS.openUrl: {
      const url = String(readPayloadObject(event.payload).url ?? "");
      try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return;
        globalThis.open(url, "_blank", "noopener,noreferrer");
      } catch { /* invalid */ }
      return;
    }
    default:
      console.warn(`[ui-action-dispatcher] unknown action: ${event.action}`);
  }
}

function ensureNavigationLanded(path: string): void {
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    const target = targetPath(path);
    if (!target) return;
    if (`${window.location.pathname}${window.location.search}` === target) return;
    // React Router should handle this. This fallback covers rare cases where
    // the SSE-triggered navigate call is accepted but the browser location
    // remains unchanged.
    try {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
      window.location.assign(path);
    }
  }, 50);
}

function targetPath(path: string): string | null {
  try {
    const url = new URL(path, window.location.origin);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
