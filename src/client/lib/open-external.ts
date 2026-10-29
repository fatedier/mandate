import { isTauriRuntime } from "@/lib/runtime";

/** An http(s) URL as the browser would resolve it; null for anything else. */
export function normalizeExternalHttpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Opens a URL in the system browser from the desktop app's webview. */
export async function openExternalHttpUrl(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (error) {
    console.error("[mandate] failed to open external URL", error);
  }
}

/** A link's click in the desktop app: the webview would open nothing, so
 *  the system browser opens it. True when it took the click. */
export function openInSystemBrowser(href: string | null | undefined): boolean {
  if (!isTauriRuntime()) return false;
  const url = normalizeExternalHttpUrl(href);
  if (!url) return false;
  void openExternalHttpUrl(url);
  return true;
}
