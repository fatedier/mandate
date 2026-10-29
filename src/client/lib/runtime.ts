type MandateDesktopConfig = {
  apiBaseUrl?: string;
};

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

declare global {
  interface Window {
    __MANDATE_DESKTOP__?: MandateDesktopConfig;
  }
}

export function mandateDesktopConfig(): MandateDesktopConfig | null {
  if (typeof window === "undefined") return null;
  return window.__MANDATE_DESKTOP__ ?? null;
}

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

export function isDesktopRuntime(): boolean {
  return isTauriRuntime() || Boolean(mandateDesktopConfig()?.apiBaseUrl);
}

/** Stamps `<html data-shell="desktop">` when running inside the Tauri webview,
 *  and removes it otherwise. Called once before first render, so the
 *  traffic-light spacer (CSS keyed on the attribute) never pops in late. */
export function applyShellFlag(doc: Document = document): void {
  if (isTauriRuntime()) doc.documentElement.setAttribute("data-shell", "desktop");
  else doc.documentElement.removeAttribute("data-shell");
}
