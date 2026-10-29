import { parseViewportWidth } from "@shared/canvas-page";

const XHTML = "http://www.w3.org/1999/xhtml";

/** The desktop width a report declares with
 *  `<meta name="viewport" content="width=1280">`, read by the browser's own
 *  parser, so a meta inside a comment, a script string or a <template> is not
 *  one. Null when the page reflows: no such meta, `device-width`, or a width
 *  outside 600–2560. */
export function declaredDesktopWidth(html: string): number | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const meta of doc.querySelectorAll("meta[name]")) {
    // DOMParser parses without scripting, so a <noscript>'s contents are
    // markup here; in the viewer they are text. An SVG <meta> is not HTML's.
    if (meta.namespaceURI !== XHTML || meta.closest("noscript")) continue;
    if (meta.getAttribute("name")?.toLowerCase() !== "viewport") continue;
    const declared = parseViewportWidth(meta.getAttribute("content") ?? "");
    if (declared) return "width" in declared ? declared.width : null;
  }
  return null;
}
