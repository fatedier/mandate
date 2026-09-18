import { toast } from "sonner";
import { api } from "@/lib/api-paths";
import { canvasTailwindUrl, localizeCanvasTailwindScript } from "./canvas-tailwind";
import type { CanvasEventRequest, CanvasEventResponse } from "@shared/api-contracts";

export interface CanvasSubmitMessage {
  type: "mandate.canvas.submit";
  canvasId: string;
  action: string;
  data?: unknown;
}

export interface CanvasHeightMessage {
  type: "mandate.canvas.height";
  canvasId: string;
  value: number;
  /** documentElement.scrollWidth — the width the canvas was laid out for. */
  width?: number;
}

type CanvasTheme = "dark" | "light";

interface BuildCanvasSrcDocOptions {
  theme?: CanvasTheme;
  assetBaseUrl?: string;
  /** Inline feature canvases auto-grow with parent page scroll, so the iframe
   *  document itself should not expose an internal scrollbar. Full-page
   *  canvases fill a viewport and keep their own scroll. */
  autoSize?: boolean;
}

/** POST a back-channel action from the canvas iframe to the agent. The iframe
 *  bridge script triggers this for elements with `data-mandate-action` or a
 *  form with `data-mandate-submit` via postMessage. */
export async function submitCanvasEvent(
  canvasId: string,
  message: CanvasSubmitMessage,
  setSubmitting: (value: boolean) => void
): Promise<void> {
  setSubmitting(true);
  try {
    const body: CanvasEventRequest = {
      action: message.action,
      data: message.data ?? {}
    };
    const response = await fetch(api.canvasEvents(canvasId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as CanvasEventResponse;
    if (!response.ok || "error" in payload) {
      toast.error("Canvas submit failed", {
        description: "error" in payload ? payload.error : response.statusText
      });
      return;
    }
    toast.success(payload.queued ? "Response queued" : "Response sent");
  } catch (error) {
    toast.error("Canvas submit failed", {
      description: error instanceof Error ? error.message : String(error)
    });
  } finally {
    setSubmitting(false);
  }
}

/** Wrap an agent-authored HTML fragment / full document into a renderable
 *  iframe srcDoc:
 *
 *  - Auto-injects the bundled Tailwind runtime if the author hasn't included it (so standard
 *    Tailwind classes like `bg-slate-950`, `text-emerald-300`, `p-6` etc. just
 *    work without each agent having to remember the script tag).
 *  - Installs a small sandbox compatibility runtime before agent-authored
 *    scripts, so storage access inside the iframe degrades predictably.
 *  - Auto-injects the Mandate bridge script which (a) reports body height
 *    back to the parent via postMessage so the iframe can grow with content,
 *    and (b) intercepts data-mandate-action / data-mandate-submit elements
 *    and posts those events back as canvas action submissions. */
export function buildCanvasSrcDoc(
  html: string,
  canvasId: string,
  options: BuildCanvasSrcDocOptions = {}
): string {
  const theme = options.theme ?? "dark";
  const themeStyle = canvasThemeStyle(theme, options.autoSize ?? true);
  const withDocumentShell = ensureCanvasDocument(html, theme);
  const withBase = injectCanvasAssetBase(withDocumentShell, options.assetBaseUrl);
  const withSandbox = injectAtHeadStart(withBase, sandboxCanvasRuntimeScript());
  const withTailwind = injectTailwindIfMissing(withSandbox);
  const withTheme = injectBeforeHeadEnd(withTailwind, themeStyle);
  return injectBeforeBodyEnd(withTheme, canvasBridgeScript(canvasId));
}

function injectCanvasAssetBase(html: string, assetBaseUrl: string | undefined): string {
  const href = normalizeAssetBaseUrl(assetBaseUrl);
  if (!href) return html;
  const payload = `<base data-mandate-canvas-assets href="${escapeHtmlAttribute(href)}">`;
  return injectAfterHeadOpen(html, payload);
}

function normalizeAssetBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"]/g, (ch) => (ch === "&" ? "&amp;" : "&quot;"));
}

/** Localize existing CDN scripts in place so following config scripts keep
 * their execution order. Scan real tags, skipping comments and raw text.
 * Standalone documents can retain the existing @tailwind opt-out marker. */
function injectTailwindIfMissing(html: string): string {
  let hasTailwind = false;
  const replacements: Array<{ start: number; end: number; tag: string }> = [];
  scanHtmlTags(html, (tag) => {
    if (tag.name !== "script" || tag.closing) return false;
    const opening = html.slice(tag.start, tag.end + 1);
    const localized = localizeCanvasTailwindScript(opening);
    hasTailwind ||= localized.hasTailwind;
    if (localized.tag !== opening) replacements.push({ ...tag, tag: localized.tag });
    return false;
  });
  for (const replacement of replacements.reverse()) {
    html = html.slice(0, replacement.start) + replacement.tag + html.slice(replacement.end + 1);
  }
  if (hasTailwind) return html;
  if (/@tailwind\b|@apply\b/.test(html)) return html;
  return injectBeforeHeadEnd(html, `<script src="${escapeHtmlAttribute(canvasTailwindUrl()!)}"></script>`);
}

function ensureCanvasDocument(html: string, theme: CanvasTheme): string {
  const leading = html.trimStart().slice(0, 128).toLowerCase();
  const isFullDocument = leading.startsWith("<!doctype") || leading.startsWith("<html");
  if (isFullDocument) return setCanvasTheme(html, theme);

  const isBodyDocument = leading.startsWith("<body") || /<body[\s>]/i.test(html);
  const body = isBodyDocument ? setCanvasTheme(html, theme) : `<body>${html}</body>`;
  return [
    "<!doctype html>",
    `<html data-mandate-theme="${theme}">`,
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "</head>",
    body,
    "</html>"
  ].join("");
}

function setCanvasTheme(html: string, theme: CanvasTheme): string {
  if (/<html\b[^>]*data-mandate-theme=/i.test(html)) return html;
  if (/<html\b/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, `<html$1 data-mandate-theme="${theme}">`);
  }
  if (/<body\b[^>]*data-mandate-theme=/i.test(html)) return html;
  return html.replace(/<body\b([^>]*)>/i, `<body$1 data-mandate-theme="${theme}">`);
}

function sandboxCanvasRuntimeScript(): string {
  return `<script data-mandate-sandbox-runtime>
(() => {
  const createStorage = () => {
    let values = Object.create(null);
    const storage = {
      getItem(key) {
        const k = String(key);
        return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : null;
      },
      setItem(key, value) {
        values[String(key)] = String(value);
      },
      removeItem(key) {
        delete values[String(key)];
      },
      clear() {
        values = Object.create(null);
      },
      key(index) {
        return Object.keys(values)[Number(index)] ?? null;
      }
    };
    Object.defineProperty(storage, "length", {
      get() {
        return Object.keys(values).length;
      }
    });
    return storage;
  };

  const usableStorage = (name) => {
    try {
      const storage = window[name];
      const key = "__mandate_canvas_probe__";
      storage.setItem(key, "1");
      storage.removeItem(key);
      return true;
    } catch (_) {
      return false;
    }
  };

  const installStorageFallback = (name) => {
    if (usableStorage(name)) return;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        value: createStorage()
      });
    } catch (_) {
      try {
        window[name] = createStorage();
      } catch (_) {
        // Some sandboxed engines keep storage read-only.
      }
    }
  };

  installStorageFallback("localStorage");
  installStorageFallback("sessionStorage");

  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest
      ? event.target.closest("a[href]")
      : null;
    if (!target) return;
    const href = target.getAttribute("href");
    if (href == null) return;
    if (href === "" || href === "#") {
      event.preventDefault();
      window.scrollTo({ top: 0, left: 0 });
      return;
    }
    if (!href.startsWith("#")) return;
    const id = href.slice(1);
    const destination = id ? document.getElementById(id) : null;
    if (!destination) return;
    event.preventDefault();
    destination.scrollIntoView();
  }, true);
})();
</script>`;
}

function injectAtHeadStart(html: string, payload: string): string {
  return injectAfterHeadOpen(html, payload);
}

function injectBeforeHeadEnd(html: string, payload: string): string {
  return injectNearHeadEnd(html, payload);
}

function injectBeforeBodyEnd(html: string, payload: string): string {
  return injectNearBodyEnd(html, payload);
}

function injectAfterHeadOpen(html: string, payload: string): string {
  const head = findHtmlTag(html, "head", false);
  if (head) return `${html.slice(0, head.end + 1)}${payload}${html.slice(head.end + 1)}`;
  const htmlTag = findHtmlTag(html, "html", false);
  if (htmlTag) return `${html.slice(0, htmlTag.end + 1)}<head>${payload}</head>${html.slice(htmlTag.end + 1)}`;
  const body = findHtmlTag(html, "body", false);
  if (body) return `${html.slice(0, body.start)}<head>${payload}</head>${html.slice(body.start)}`;
  return `<head>${payload}</head>${html}`;
}

function injectNearHeadEnd(html: string, payload: string): string {
  const headEnd = findHtmlTag(html, "head", true);
  if (headEnd) return `${html.slice(0, headEnd.start)}${payload}${html.slice(headEnd.start)}`;
  return injectAfterHeadOpen(html, payload);
}

function injectNearBodyEnd(html: string, payload: string): string {
  const bodyEnd = findHtmlTag(html, "body", true);
  if (bodyEnd) return `${html.slice(0, bodyEnd.start)}${payload}${html.slice(bodyEnd.start)}`;
  return `${html}${payload}`;
}

interface HtmlTagLocation {
  start: number;
  end: number;
  name: string;
  closing: boolean;
}

const RAW_TEXT_TAGS = new Set(["script", "style", "template", "textarea", "title"]);

function findHtmlTag(html: string, name: string, closing: boolean): HtmlTagLocation | null {
  const target = name.toLowerCase();
  return scanHtmlTags(html, (tag) => tag.name === target && tag.closing === closing);
}

function scanHtmlTags(
  html: string,
  matches: (tag: HtmlTagLocation) => boolean
): HtmlTagLocation | null {
  const lower = html.toLowerCase();
  let index = 0;
  while (index < lower.length) {
    const start = lower.indexOf("<", index);
    if (start === -1) return null;
    if (lower.startsWith("<!--", start)) {
      const commentEnd = lower.indexOf("-->", start + 4);
      index = commentEnd === -1 ? lower.length : commentEnd + 3;
      continue;
    }
    const tag = parseHtmlTag(lower, start);
    if (!tag) {
      index = start + 1;
      continue;
    }
    if (matches(tag)) return tag;
    if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
      const closeStart = lower.indexOf(`</${tag.name}`, tag.end + 1);
      if (closeStart === -1) return null;
      const closeTag = parseHtmlTag(lower, closeStart);
      index = closeTag ? closeTag.end + 1 : closeStart + tag.name.length + 2;
      continue;
    }
    index = tag.end + 1;
  }
  return null;
}

function parseHtmlTag(lowerHtml: string, start: number): HtmlTagLocation | null {
  let cursor = start + 1;
  const first = lowerHtml[cursor];
  if (!first || first === "!" || first === "?") return null;
  const closing = first === "/";
  if (closing) cursor++;
  while (/\s/.test(lowerHtml[cursor] ?? "")) cursor++;
  const nameStart = cursor;
  while (/[a-z0-9:-]/.test(lowerHtml[cursor] ?? "")) cursor++;
  if (cursor === nameStart) return null;
  const name = lowerHtml.slice(nameStart, cursor);
  let quote: string | null = null;
  for (; cursor < lowerHtml.length; cursor++) {
    const char = lowerHtml[cursor];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return { start, end: cursor, name, closing };
    }
  }
  return null;
}

function canvasThemeStyle(theme: CanvasTheme, autoSize: boolean): string {
  // Infrastructure only — the canvas owns its own design (background, palette,
  // typography). We inject a sane default surface for canvases that set
  // nothing, a CSS reset, autosize guards, and an unstyled-<code> default.
  // The fallback variables are namespaced and low-specificity so the agent's
  // own colors render faithfully even when its style block appears earlier.
  return `<style id="mandate-canvas-base">
:where(:root) {
  color-scheme: ${theme};
  --mandate-canvas-background: ${theme === "dark" ? "#0c0e12" : "#ffffff"};
  --mandate-canvas-foreground: ${theme === "dark" ? "#e6e9ef" : "#1c2128"};
  --mandate-canvas-muted: ${theme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"};
  --mandate-canvas-primary: ${theme === "dark" ? "#6e79f7" : "#5058e8"};
}
:where(html) {
  margin: 0;
  background: transparent;
}
:where(body) {
  margin: 0;
  background: var(--mandate-canvas-background);
  color: var(--mandate-canvas-foreground);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
${autoSize
    ? [
        "html,body{height:auto !important;min-height:0 !important;overflow:hidden !important;}",
        ".min-h-screen,.min-h-dvh,.min-h-svh,.min-h-lvh,[class~=\"min-h-[100vh]\"],[class~=\"min-h-[100dvh]\"],[class~=\"min-h-[100svh]\"],[class~=\"min-h-[100lvh]\"]{min-height:auto !important;}",
        ".h-screen,.h-dvh,.h-svh,.h-lvh,[class~=\"h-[100vh]\"],[class~=\"h-[100dvh]\"],[class~=\"h-[100svh]\"],[class~=\"h-[100lvh]\"]{height:auto !important;}"
      ].join("")
    : "html,body{min-height:100%;overflow:auto;}"}
*, ::before, ::after { box-sizing: border-box; }
button,input,select,textarea{font:inherit;}
:where(a){color:var(--mandate-canvas-primary);}
:where(code:not([class])) {
  border-radius: 0.25rem;
  background: var(--mandate-canvas-muted);
  color: var(--mandate-canvas-foreground);
  padding: 0.08rem 0.25rem;
}
</style>`;
}

function canvasBridgeScript(canvasId: string): string {
  const id = JSON.stringify(canvasId);
  return `
<script>
(() => {
  const canvasId = ${id};
  const send = (payload) => {
    try { window.parent.postMessage({ ...payload, canvasId }, "*"); }
    catch (_) { /* parent gone */ }
  };
  const hasOpenOverlay = () => Array.from(document.querySelectorAll(
    'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'
  )).some((overlay) => {
    if (overlay.closest('[hidden], [aria-hidden="true"], [data-state="closed"]')) return false;
    const style = getComputedStyle(overlay);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && overlay.getClientRects().length > 0;
  });
  // Keyboard events do not bubble out of the sandboxed iframe. Open Canvas
  // overlays own them; closed modal nodes must not disable pane shortcuts.
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if (hasOpenOverlay()) return;
    const zoom = event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey;
    if (!zoom && event.key !== "Escape") return;
    const forward = () => send({ type: "mandate.canvas.key", key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
    if (zoom) {
      event.preventDefault();
      forward();
    } else {
      // A task runs after the entire dispatch, including later document and
      // window listeners. A microtask can run between native listeners.
      setTimeout(() => {
        if (!event.defaultPrevented && !hasOpenOverlay()) forward();
      }, 0);
    }
  });
  const measureHeight = () => {
    const root = document.documentElement;
    const body = document.body;
    if (!body) return 0;
    let value = Math.max(root.offsetHeight, body.scrollHeight, body.offsetHeight, body.getBoundingClientRect().bottom);
    const nodes = body.querySelectorAll("*");
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      if (style.position === "fixed") continue;
      const rect = node.getBoundingClientRect();
      const marginBottom = Number.parseFloat(style.marginBottom) || 0;
      value = Math.max(value, rect.bottom + marginBottom);
    }
    // +8px buffer so subpixel rounding / late layout shifts don't leave the
    // body 1-2px taller than the iframe element — that's the classic
    // 'why is there still a scrollbar inside?' bug for auto-resizing iframes.
    return Math.ceil(value) + 8;
  };
  const measureWidth = () => {
    const root = document.documentElement;
    const body = document.body;
    if (!body) return 0;
    return Math.ceil(Math.max(root.scrollWidth, body.scrollWidth));
  };
  let lastHeight = -1;
  let lastWidth = -1;
  const postHeight = () => {
    const value = measureHeight();
    const width = measureWidth();
    if (value <= 0 || (value === lastHeight && width === lastWidth)) return;
    lastHeight = value;
    lastWidth = width;
    send({ type: "mandate.canvas.height", value, width });
  };
  // Initial measurement after first paint, plus a few retries while assets
  // (Tailwind styles, fonts, images) are still landing.
  window.addEventListener("load", postHeight);
  setTimeout(postHeight, 30);
  setTimeout(postHeight, 200);
  setTimeout(postHeight, 800);
  if (typeof ResizeObserver !== "undefined" && document.body) {
    try { new ResizeObserver(() => postHeight()).observe(document.body); }
    catch (_) { /* ignore */ }
  }
  // Re-measure when images / fonts finish loading.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(postHeight).catch(() => {});
  }

  // Back-channel action submission via data-mandate-action / data-mandate-submit
  const submit = (action, data) => {
    if (!action || typeof action !== "string") return;
    send({ type: "mandate.canvas.submit", action, data: data || {} });
  };
  const valueFor = (value) => {
    if (typeof File !== "undefined" && value instanceof File) {
      return { name: value.name, type: value.type, size: value.size };
    }
    return value;
  };
  const formDataObject = (form) => {
    const output = {};
    for (const [key, raw] of new FormData(form).entries()) {
      const value = valueFor(raw);
      if (Object.prototype.hasOwnProperty.call(output, key)) {
        const existing = output[key];
        output[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        output[key] = value;
      }
    }
    return output;
  };
  window.mandateCanvas = { submit };
  document.addEventListener("submit", (event) => {
    const form = event.target && event.target.closest ? event.target.closest("form[data-mandate-submit]") : null;
    if (!form) return;
    event.preventDefault();
    submit(form.getAttribute("data-mandate-submit"), formDataObject(form));
  }, true);
  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest ? event.target.closest("[data-mandate-action]") : null;
    if (!target) return;
    const action = target.getAttribute("data-mandate-action");
    if (!action) return;
    event.preventDefault();
    submit(action, {
      value: target.getAttribute("data-mandate-value"),
      text: (target.textContent || "").trim()
    });
  }, true);
})();
</script>`;
}
