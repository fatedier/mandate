/**
 * The rules a report page is held to, shared by the server (publish checks,
 * the page cap, the title) and the client (the viewer's CSP and desktop
 * width). The hosts and limits are fixed here, in one place.
 * Reading the page itself is left to real parsers: parse5 on the server
 * (canvas-html.ts), the browser in the viewer.
 */

/** Script origins the viewer's CSP admits. */
export const CANVAS_SCRIPT_SOURCES: readonly string[] = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net/npm/",
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com"
];
export const CANVAS_STYLE_SOURCES: readonly string[] = ["https://fonts.googleapis.com"];
export const CANVAS_FONT_SOURCES: readonly string[] = ["https://fonts.gstatic.com"];

/** The page's cap. Embedded data: URIs count; files next to index.html do not. */
export const CANVAS_PAGE_MAX_BYTES = 16 * 1024 * 1024;
/** Only this much of the file is scanned for <title>. */
export const CANVAS_TITLE_SCAN_BYTES = 8192;
export const CANVAS_TITLE_MAX_CHARS = 120;

export const CANVAS_DESKTOP_WIDTH_DEFAULT = 1280;
export const CANVAS_DESKTOP_WIDTH_MIN = 600;
export const CANVAS_DESKTOP_WIDTH_MAX = 2560;

export type DeclaredViewport = { width: number } | { invalid: string } | null;

/** The width a viewport meta's `content` declares: null for none or
 *  `device-width` (the page reflows), invalid for anything but an integer from
 *  600 to 2560 (the viewer ignores it). */
export function parseViewportWidth(content: string): DeclaredViewport {
  const width = /(?:^|[\s,;])width\s*=\s*([^\s,;]*)/i.exec(content)?.[1];
  if (width === undefined || width.toLowerCase() === "device-width") return null;
  const n = /^\d+$/.test(width) ? Number(width) : Number.NaN;
  return n >= CANVAS_DESKTOP_WIDTH_MIN && n <= CANVAS_DESKTOP_WIDTH_MAX ? { width: n } : { invalid: width };
}
