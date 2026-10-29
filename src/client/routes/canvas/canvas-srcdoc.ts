import { api } from "@/lib/api-paths";
import { CANVAS_FONT_SOURCES, CANVAS_SCRIPT_SOURCES, CANVAS_STYLE_SOURCES } from "@shared/canvas-page";
import { canvasBridgeScript, canvasRuntimeScript } from "./canvas-bridge";

type CanvasTheme = "light" | "dark";

interface BuildCanvasSrcDocOptions {
  canvasId: string;
  /** null: an artboard, which never follows the viewer's theme (no stamp). */
  theme: CanvasTheme | null;
  /** Absolute URL of the page's folder, ending in "/". */
  assetsBaseUrl: string;
  /** Absolute URL of the canvas folder, what the CSP admits: an artboard in a
   *  subfolder may still use files above its own. Defaults to assetsBaseUrl. */
  folderUrl?: string;
  /** A design's artboard: its path and every board's, for prototype links. */
  artboard?: { path: string; boards: string[] };
  /** A script of the viewer's own that runs before the page's (Your agent's
   *  page: window.mandate), after the runtime. */
  headScript?: string;
}

/** The report's folder as an absolute URL. The desktop app's page origin is
 *  tauri://, its API origin http://127.0.0.1:<port>, so this is resolved from
 *  the API path, not from location.origin. */
export function canvasAssetsUrl(canvasId: string): string {
  return new URL(api.canvasAssetsBase(canvasId), window.location.href).href;
}

/** The folder an artboard's relative links resolve against: the canvas
 *  folder plus the artboard's own subfolder. */
export function artboardAssetsUrl(canvasId: string, boardPath: string): string {
  const folder = boardPath.includes("/") ? boardPath.slice(0, boardPath.lastIndexOf("/") + 1) : "";
  return canvasAssetsUrl(canvasId) + folder;
}

/** The allowlist as a CSP, plus the report's own folder for what
 *  can load from it: fonts and workers cannot (CORS and same-origin rules
 *  refuse the sandbox's opaque origin), so they get no folder entry. */
export function canvasCsp(assetsBaseUrl: string): string {
  const assets = assetsBaseUrl;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${CANVAS_SCRIPT_SOURCES.join(" ")} ${assets}`,
    `style-src 'unsafe-inline' ${CANVAS_STYLE_SOURCES.join(" ")} ${assets}`,
    `font-src ${CANVAS_FONT_SOURCES.join(" ")} data:`,
    `img-src data: blob: ${assets}`,
    `media-src data: blob: ${assets}`,
    "worker-src blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    `base-uri ${assets}`
  ].join("; ");
}

/** The base rules every report starts from; the page contract lists them.
 *
 *  The scrollbars are the viewer's: under `color-scheme: light` a dark page
 *  that never says it is dark kept the browser's light scrollbar, a white
 *  track down its side. The thumb is a grey that reads on a light or a dark
 *  ground, as faint as the app's own thumb (globals.css). The track is the page's own ground, which the bridge reads
 *  (`--mandate-ground`): a clear track shows the viewer behind the frame, a
 *  strip of another colour beside the page. The two rules sit in a cascade
 *  layer, the first of the document, so whatever a page says of its own
 *  scrollbars wins: on any selector, in a layer of its own or in none. */
const RESET_STYLE =
  "<style data-mandate-reset>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}" +
  "@layer{:root{scrollbar-color:rgb(128 128 128/.14) var(--mandate-ground,transparent)}*{scrollbar-width:thin}}" +
  "body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif;background:#fafaf9}" +
  "img{max-width:100%}[hidden]{display:none!important}</style>";

const CHARSET_META = '<meta charset="utf-8">';
const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';

/** A report's page content wrapped in the skeleton, with the CSP,
 *  the base for its own files, the runtime and the bridge. A file that brings
 *  its own document (an old canvas, a model that ignored the rule) is wrapped
 *  the same way, and the browser's parser folds it in: its doctype and <head>
 *  tag are dropped, its <html> and <body> attributes are added where the
 *  skeleton's have none (so the skeleton's data-theme wins), and its title,
 *  metas, styles and scripts stay where they stand. The CSP is always first,
 *  with nothing of the page's before it. */
export function buildCanvasSrcDoc(html: string, options: BuildCanvasSrcDocOptions): string {
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(canvasCsp(options.folderUrl ?? options.assetsBaseUrl))}">` +
    `<base href="${escapeHtmlAttribute(options.assetsBaseUrl)}" target="_blank">` +
    RESET_STYLE +
    canvasRuntimeScript() +
    (options.headScript ?? "");
  const bridge = canvasBridgeScript(options.canvasId, { artboard: options.artboard });
  return `<!doctype html><html${options.theme ? ` data-theme="${options.theme}"` : ""}><head>${CHARSET_META}${VIEWPORT_META}${head}</head><body>${html}${bridge}</body></html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"]/g, (ch) => (ch === "&" ? "&amp;" : "&quot;"));
}
