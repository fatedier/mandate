import { apiPath } from "@/lib/api-base";
import { isTauriRuntime } from "@/lib/runtime";
import { API_PATHS } from "@shared/api/routes";

const two = (n: number) => String(n).padStart(2, "0");

/** The name a shared file is saved under, by the local time: the one the
 *  server gives it in the desktop app. */
export function sharedFileName(ext: "png" | "md", at = new Date()): string {
  return `mandate-share-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}.${ext}`;
}

/** How long a download's object URL is kept: the browser reads it after the
 *  click returns, and some only when the user answers where to save it. */
const DOWNLOAD_URL_KEPT_MS = 40_000;

/** Saves a shared image or text: in the desktop app through the local
 *  server, into Downloads (its webview downloads nothing); in a browser as a
 *  download. Throws when the server could not save it. */
export async function saveSharedFile(blob: Blob, ext: "png" | "md"): Promise<void> {
  if (isTauriRuntime()) {
    const res = await fetch(apiPath(API_PATHS.shareFiles), { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
    if (!res.ok) throw new Error(`could not save the file (HTTP ${res.status})`);
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sharedFileName(ext);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_KEPT_MS);
}

/** Whether an image can go on the clipboard: the clipboard's write is there
 *  only on a secure page (localhost or https; not a phone over http). */
export function canCopyImage(): boolean {
  return window.isSecureContext && typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined";
}

export async function copyImage(blob: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}
