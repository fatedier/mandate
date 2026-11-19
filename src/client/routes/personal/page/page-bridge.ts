/**
 * Personal agent's page talks to Mandate through `window.mandate`, which a head
 * script defines before the page's own scripts run. The frame is sandboxed
 * without same-origin, so postMessage is the only way across; every message
 * names the page it belongs to.
 *
 * Page → host: get (a source's data), subscribe (its changes), submit (an
 * answer for the personal agent), open (a page of Mandate's), go (another
 * page of its own folder), fields (what the user typed, by field id), focus
 * (whether a field has it), quotable (whether it marks an item to quote),
 * quote (the item the user picked to quote), quoteEnd (Esc while quoting),
 * ready (its document is read), drawn (it has painted since asked).
 * Host → page: data, result (of a get or a submit), preview (typed values
 * to show until the load's restore, deciding nothing), restore (put typed
 * values back by id), clear (what was typed is done with), style (the app's
 * colors and fonts for a new theme), quoting (the user is picking an item
 * to quote, or no longer), askQuotable (say quotable again: the host was not
 * listening when it was said), whenDrawn (say drawn after the next paint).
 */

import { AGENT_PAGE_BUILTINS, AGENT_PAGE_LIMITS, AGENT_PAGE_SOURCE_NAME } from "@shared/api/agent-page";
import { foldPageQuote } from "@shared/page-quotes";

export type PageFrameMessage =
  | { type: "get"; name: string; reqId: number }
  | { type: "subscribe"; name: string }
  | { type: "submit"; value: unknown; reqId: number }
  /** A submit the host will not take: answered with its error, never sent on. */
  | { type: "refused"; reqId: number; error: string }
  | { type: "open"; path: string }
  /** Another page of the folder, by its path there: the host shows it if it is one. */
  | { type: "go"; path: string }
  | { type: "fields"; values: Record<string, string> }
  | { type: "focus"; inField: boolean }
  | { type: "quotable"; any: boolean }
  /** The document is read: the typed values can be shown, before its load,
   *  which waits for its pictures and fonts. */
  | { type: "ready" }
  /** It has painted since the host asked (whenDrawn): what it drew from the
   *  data it had is on screen. */
  | { type: "drawn" }
  /** The item picked, folded to one line within the limit. */
  | { type: "quote"; text: string }
  | { type: "quoteEnd" };

/** How long a page's path in its folder may be. */
const PAGE_PATH_MAX_CHARS = 1024;

/** How many typed fields are kept, and how long each value may be. */
export const PAGE_FIELDS_MAX = 200;
export const PAGE_FIELD_VALUE_MAX_CHARS = 20_000;

/** The pages of Mandate a page may open: Home, a thread (a worker in it), a canvas. */
const MANDATE_PATH = /^\/(?:home|threads\/[A-Za-z0-9_-]+(?:\?worker=[A-Za-z0-9_-]+)?|canvas\/[A-Za-z0-9_-]+)$/;

/** The path, when it is one of Mandate's a page may open; null otherwise
 *  (another site, a script URL, a relative path, anything deeper). */
export function pagePathOf(path: unknown): string | null {
  return typeof path === "string" && MANDATE_PATH.test(path) ? path : null;
}

const isSourceName = (name: unknown): name is string =>
  typeof name === "string" && ((AGENT_PAGE_BUILTINS as readonly string[]).includes(name) || AGENT_PAGE_SOURCE_NAME.test(name));
const isReqId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** How deep a submitted value may nest. */
const JSON_DEPTH_MAX = 64;

/** Whether a value is JSON as it stands, within the answer limit: null, a
 *  boolean, a finite number, a string, or arrays and plain objects of those.
 *  A message can carry what JSON cannot (a Map, a buffer, a date, a cycle),
 *  which JSON.stringify would quietly turn into something else. The walk
 *  counts the least each value takes as JSON (a string its length and
 *  quotes, a key the same and a colon, every value a separator) and stops
 *  once that passes the limit: a message that shares one large value many
 *  times over costs no more than the limit, and no oversized JSON is ever
 *  built. Methods are never read off the value: an array may carry its own
 *  `every`. */
function isJson(value: unknown, budget = { left: AGENT_PAGE_LIMITS.answerMaxBytes }, depth = 0, path = new Set<object>()): boolean {
  // A separator before every value inside another; none before the whole.
  if (depth > 0 && --budget.left < 0) return false;
  if (value === null || typeof value === "boolean") return (budget.left -= 4) >= 0;
  if (typeof value === "string") return (budget.left -= value.length + 2) >= 0;
  if (typeof value === "number") return Number.isFinite(value) && (budget.left -= String(value).length) >= 0;
  if (typeof value !== "object" || depth >= JSON_DEPTH_MAX || path.has(value)) return false;
  path.add(value);
  try {
    // Undefined goes as JSON has it: null in an array, a key left out.
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) if (!isJson(value[i] === undefined ? null : value[i], budget, depth + 1, path)) return false;
      return true;
    }
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if ((budget.left -= key.length + 3) < 0) return false;
      if (!isJson(item, budget, depth + 1, path)) return false;
    }
    return true;
  } finally {
    path.delete(value);
  }
}

/** The JSON a value is sent as, in UTF-8 bytes (Infinity once it is over
 *  the limit, counted before anything is built); null when it is not JSON. */
function jsonBytes(value: unknown): number | null {
  const budget = { left: AGENT_PAGE_LIMITS.answerMaxBytes };
  if (!isJson(value, budget)) return budget.left < 0 ? Number.POSITIVE_INFINITY : null;
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** A message from the page's frame, checked. Anything else (another page, a
 *  wrong shape, an unknown source, a path not Mandate's) is null; a submit
 *  over the limit or not JSON is refused with why. */
export function readPageFrameMessage(data: unknown, pageId: string): PageFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.pageId !== pageId) return null;
  switch (d.type) {
    case "mandate.page.get":
      return isSourceName(d.name) && isReqId(d.reqId) ? { type: "get", name: d.name, reqId: d.reqId } : null;
    case "mandate.page.subscribe":
      return isSourceName(d.name) ? { type: "subscribe", name: d.name } : null;
    case "mandate.page.submit": {
      if (!isReqId(d.reqId)) return null;
      const bytes = jsonBytes(d.value);
      if (bytes === null) return { type: "refused", reqId: d.reqId, error: "submit takes a JSON value" };
      if (bytes > AGENT_PAGE_LIMITS.answerMaxBytes) return { type: "refused", reqId: d.reqId, error: "an answer is at most 8 KB of JSON" };
      return { type: "submit", value: d.value, reqId: d.reqId };
    }
    case "mandate.page.open": {
      const path = pagePathOf(d.path);
      return path ? { type: "open", path } : null;
    }
    case "mandate.page.go":
      return typeof d.path === "string" && d.path.length > 0 && d.path.length <= PAGE_PATH_MAX_CHARS ? { type: "go", path: d.path } : null;
    case "mandate.page.fields": {
      if (!d.values || typeof d.values !== "object" || Array.isArray(d.values)) return null;
      const values: Record<string, string> = {};
      for (const [id, value] of Object.entries(d.values as Record<string, unknown>).slice(0, PAGE_FIELDS_MAX)) {
        if (typeof value === "string" && id && value.length <= PAGE_FIELD_VALUE_MAX_CHARS) values[id] = value;
      }
      return { type: "fields", values };
    }
    case "mandate.page.focus":
      return typeof d.inField === "boolean" ? { type: "focus", inField: d.inField } : null;
    case "mandate.page.ready":
      return { type: "ready" };
    case "mandate.page.drawn":
      return { type: "drawn" };
    case "mandate.page.quotable":
      return typeof d.any === "boolean" ? { type: "quotable", any: d.any } : null;
    case "mandate.page.quote": {
      const text = typeof d.text === "string" ? foldPageQuote(d.text) : "";
      return text ? { type: "quote", text } : null;
    }
    case "mandate.page.quoteEnd":
      return { type: "quoteEnd" };
    default:
      return null;
  }
}

/** Which page of the folder a document is, and the folder's pages. */
export interface PagePlace { path: string; pages: string[] }

/** How the items a page marked look while the user picks one to quote: in
 *  the app's link color, over whatever the page gave them. */
const QUOTING_CSS = "html[data-mandate-quoting] [data-quote]{outline:1.5px dashed var(--mandate-link,currentColor)!important;outline-offset:-3px!important;cursor:pointer!important}" +
  "html[data-mandate-quoting] [data-quote]:hover,html[data-mandate-quoting] [data-quote]:focus-visible{outline-style:solid!important;outline-width:2px!important}";

/** JSON that can sit inside a script element: no "</script>" in it. */
const inScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** The head script: `window.mandate`, the fields' keeping and restoring,
 *  links to Mandate's pages opened in the app, and links to the folder's
 *  other pages (`place`) gone to in the frame. It runs before the page's
 *  own scripts, after the runtime (whose link handler sends every other link
 *  to a new tab). */
export function agentPageScript(pageId: string, place?: PagePlace): string {
  const id = JSON.stringify(pageId);
  const path = MANDATE_PATH.source;
  return `<script data-mandate-page>
(() => {
  const pageId = ${id};
  const mandatePath = new RegExp(${JSON.stringify(path)});
  const place = ${inScript(place ?? null)};
  const send = (payload) => {
    try { window.parent.postMessage({ ...payload, pageId }, "*"); }
    catch (_) { /* parent gone */ }
  };
  // Request ids start at random, so an answer meant for this page before it
  // reloaded itself never settles a request of the reloaded page.
  let seq = (() => {
    try { const r = crypto.getRandomValues(new Uint32Array(2)); return (r[0] % 2097152) * 4294967296 + r[1]; }
    catch (_) { return Math.floor(Math.random() * 9007199254740000); }
  })();
  const pending = new Map();
  const latest = new Map();
  const listeners = new Map();
  // Gets not answered yet, and how often what the page asked for or took
  // in changed: a get or a source asked for, data or a result come in.
  const gets = new Set();
  let stirred = 0;
  const request = (type, payload) => new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    if (type === "mandate.page.get") {
      gets.add(seq);
      stirred += 1;
    }
    send({ type, reqId: seq, ...payload });
  });
  // Asked by the host (whenDrawn) while this page draws under the one in
  // sight: said once every get is answered and every source followed has
  // come, after a paint with nothing asked for or taken in since.
  let drawWanted = false;
  let drawing = false;
  const hasItsData = () => gets.size === 0 && Array.from(listeners.keys()).every((name) => latest.has(name));
  const sayDrawn = () => {
    if (!drawWanted || drawing || !hasItsData()) return;
    drawing = true;
    const at = stirred;
    // A frame's callbacks run before its paint: the next frame's, after it.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      drawing = false;
      // Anything since: waited for again (what came in yet to be painted,
      // what was asked for yet to come).
      if (stirred !== at || !hasItsData()) {
        sayDrawn();
        return;
      }
      drawWanted = false;
      send({ type: "mandate.page.drawn" });
    }));
  };
  const call = (fn, data) => {
    try { fn(data); } catch (error) { setTimeout(() => { throw error; }, 0); }
  };
  window.mandate = Object.freeze({
    data(name) {
      return request("mandate.page.get", { name: String(name) });
    },
    onData(name, fn) {
      const key = String(name);
      if (typeof fn !== "function") return;
      if (!listeners.has(key)) {
        listeners.set(key, new Set());
        send({ type: "mandate.page.subscribe", name: key });
      }
      listeners.get(key).add(fn);
      stirred += 1;
      if (latest.has(key)) call(fn, latest.get(key));
    },
    submit(value) {
      return request("mandate.page.submit", { value }).then(() => {
        // Sent: what the user typed is done with; a form drawn again starts empty.
        kept = {};
        early = null;
        sendFields();
      });
    },
    open(path) {
      send({ type: "mandate.page.open", path: String(path) });
    }
  });

  // Typed values, by field id: kept by the host, so they come back when a
  // new version of the page replaces this one.
  const fields = () => Array.from(document.querySelectorAll("input[id], textarea[id], select[id]"))
    .filter((el) => !["hidden", "file", "password", "submit", "button", "reset", "image"].includes((el.type || "").toLowerCase()));
  const valueOf = (el) => (el.type === "checkbox" || el.type === "radio") ? String(el.checked) : String(el.value);
  // What the user typed, by field id: only fields they edited, so one the
  // page fills itself keeps following its data. Kept by the host for the
  // next version, and given back to any field of its id the page adds or
  // draws again, in this document or the next, once per field.
  let kept = {};
  const filled = new WeakSet();
  // The typed values shown before the load's restore, and whether it came
  // (preview, below).
  let early = null;
  let restored = false;
  // Values shown but not yet given back (\`early\`, below) stay held: typing in
  // one field before the load's restore must not drop the others.
  const sendFields = () => send({ type: "mandate.page.fields", values: { ...(early || {}), ...kept } });
  // A radio group is held as one entry, the id of the radio picked in it,
  // under a key no field id can be: its name within its form (by the form's
  // id, else its place among the page's forms). A radio drawn later, in
  // this document or the next, is checked only if it is that one.
  const radioKey = (el) => {
    const form = el.form;
    // The attribute: form.id is a control's when one is named "id".
    const formId = form ? form.getAttribute("id") : null;
    const owner = form ? (formId ? "#" + formId : String(Array.prototype.indexOf.call(document.forms, form))) : "";
    return "\u0000radio\u0000" + owner + "\u0000" + el.name;
  };
  const isGrouped = (el) => el.type === "radio" && Boolean(el.name);
  const keyOf = (el) => (isGrouped(el) ? radioKey(el) : el.id);
  const restore = () => {
    for (const el of fields()) {
      const key = keyOf(el);
      if (!Object.prototype.hasOwnProperty.call(kept, key)) continue;
      if (isGrouped(el)) {
        // The user's pick holds the group whenever the page draws: checked
        // again if a member drawn checked took it, the rest unchecked once.
        const picked = el.id === kept[key];
        if (picked ? !el.checked : !filled.has(el)) el.checked = picked;
        filled.add(el);
        continue;
      }
      if (filled.has(el)) continue;
      const value = kept[key];
      if (typeof value !== "string") continue;
      // A select whose options come later keeps its value waiting for them.
      if (el.tagName === "SELECT" && !Array.from(el.options).some((option) => option.value === value)) continue;
      filled.add(el);
      if (el.type === "checkbox" || el.type === "radio") el.checked = value === "true";
      else el.value = value;
    }
  };
  // The typed values the host shows once the document is read, until the
  // load's restore: put in the fields, once each, and nothing else. They are
  // not kept or marked filled, so the load's restore settles every field as
  // it would alone, over whatever the page filled meanwhile.
  const previewed = new WeakSet();
  const preview = () => {
    if (!early) return;
    for (const el of fields()) {
      if (previewed.has(el) || filled.has(el)) continue;
      const key = keyOf(el);
      // Typed or picked here already (a radio group by any member): theirs.
      if (Object.prototype.hasOwnProperty.call(kept, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(early, key)) continue;
      const value = early[key];
      if (typeof value !== "string") continue;
      if (isGrouped(el)) {
        // Only the member picked, when drawn; the rest wait for the restore.
        if (el.id && el.id === value) { previewed.add(el); el.checked = true; }
        continue;
      }
      if (el.tagName === "SELECT" && !Array.from(el.options).some((option) => option.value === value)) continue;
      previewed.add(el);
      if (el.type === "checkbox" || el.type === "radio") el.checked = value === "true";
      else el.value = value;
    }
  };
  const edited = (event) => {
    const el = event.target;
    // A radio picked, with an id or not, is its group's choice now (one with
    // no id is given back as none of the others).
    if (el && el.tagName === "INPUT" && isGrouped(el) && el.checked) {
      if (el.id) filled.add(el);
      kept[radioKey(el)] = el.id || "";
      sendFields();
      return;
    }
    if (!el || !el.id || !fields().includes(el)) return;
    if (isGrouped(el)) return;
    filled.add(el);
    kept[el.id] = valueOf(el);
    sendFields();
  };
  document.addEventListener("input", edited, true);
  document.addEventListener("change", edited, true);
  // Read, and its own scripts run: the typed values are asked for to show.
  // The load would wait for the page's pictures and fonts, and the fields
  // would show empty until then.
  document.addEventListener("DOMContentLoaded", () => send({ type: "mandate.page.ready" }));
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(() => { if (Object.keys(kept).length > 0) restore(); preview(); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }
  const isField = (el) => Boolean(el && el !== document.body &&
    (el.matches("input, textarea, select") || el.isContentEditable));
  // A field has focus only while this frame does: one that lost focus to the
  // app (the chat's composer) keeps its input as active element.
  const inField = () => (typeof document.hasFocus !== "function" || document.hasFocus()) && isField(document.activeElement);
  document.addEventListener("focusin", () => send({ type: "mandate.page.focus", inField: inField() }), true);
  document.addEventListener("focusout", () => {
    setTimeout(() => send({ type: "mandate.page.focus", inField: inField() }), 0);
  }, true);
  window.addEventListener("blur", () => send({ type: "mandate.page.focus", inField: false }));
  window.addEventListener("focus", () => send({ type: "mandate.page.focus", inField: inField() }));
  // Loaded: whether a field has focus now (the user may have started typing
  // before the last script arrived, or the page reloaded in the middle of it).
  window.addEventListener("load", () => send({ type: "mandate.page.focus", inField: inField() }));

  // A link to one of Mandate's pages opens it in the app; the raw href, as
  // written, decides (a resolved one would carry the frame's base).
  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href], area[href]") : null;
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (!mandatePath.test(href)) return;
    event.preventDefault();
    send({ type: "mandate.page.open", path: href });
  }, true);

  // A link to another page of the folder shows it in the frame: resolved
  // from this page's own path, one that begins with "/" from the folder's
  // top. A file that is not a page goes as any other link.
  if (place) {
    const here = "http://page.invalid/" + place.path.split("/").map(encodeURIComponent).join("/");
    document.addEventListener("click", (event) => {
      const link = event.target && event.target.closest ? event.target.closest("a[href], area[href]") : null;
      if (!link) return;
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href) || mandatePath.test(href)) return;
      let target;
      try {
        const url = new URL(href, here);
        // Another origin is another site, whatever its path (the parser trims
        // the whitespace a raw check would miss).
        if (url.origin !== "http://page.invalid") return;
        target = decodeURIComponent(url.pathname.slice(1));
      }
      catch (_) { return; }
      if (!place.pages.includes(target)) return;
      event.preventDefault();
      send({ type: "mandate.page.go", path: target });
    }, true);
  }

  // Quoting: while the host has the mode on, the user picks an item the page
  // marked with data-quote. These listeners are the window's, in its capture
  // phase, added before the page's own scripts run: the page hears nothing of
  // the clicks and keys meanwhile, and no link is followed.
  let quoting = false;
  let quotable = null;
  const tabbed = new Set();
  const sayQuotable = () => {
    const any = Boolean(document.querySelector("[data-quote]"));
    if (any === quotable) return;
    quotable = any;
    send({ type: "mandate.page.quotable", any });
  };
  // Once the document is read (a script still loading from a CDN holds load back).
  document.addEventListener("DOMContentLoaded", sayQuotable);
  window.addEventListener("load", sayQuotable);
  // Each marked item a tab stop while quoting, unless the page gave it its
  // own: those there when the mode starts, and those the page draws meanwhile.
  const addTabStops = () => {
    for (const el of document.querySelectorAll("[data-quote]")) {
      if (el.hasAttribute("tabindex")) continue;
      el.setAttribute("tabindex", "0");
      tabbed.add(el);
    }
  };
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      if (quotable !== null) sayQuotable();
      if (quoting) addTabStops();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-quote"] });
  }
  const quotingStyle = ${inScript(QUOTING_CSS)};
  const setQuoting = (on) => {
    if (on === quoting) return;
    quoting = on;
    const root = document.documentElement;
    if (on) {
      if (!document.querySelector("style[data-mandate-quoting]")) {
        const style = document.createElement("style");
        style.setAttribute("data-mandate-quoting", "");
        style.textContent = quotingStyle;
        // Last in the head, so it is over the page's own styles.
        (document.head || root).appendChild(style);
      }
      root.setAttribute("data-mandate-quoting", "");
      addTabStops();
    } else {
      root.removeAttribute("data-mandate-quoting");
      for (const el of tabbed) el.removeAttribute("tabindex");
      tabbed.clear();
    }
  };
  const quoteOf = (el) => {
    const own = (el.getAttribute("data-quote") || "").trim();
    const text = own || (typeof el.innerText === "string" ? el.innerText : el.textContent) || "";
    // The host folds it and keeps 500 characters; a few more go, never a page.
    return text.slice(0, 4000);
  };
  const pick = (event) => {
    const el = event.target && event.target.closest ? event.target.closest("[data-quote]") : null;
    if (el) send({ type: "mandate.page.quote", text: quoteOf(el) });
  };
  const swallow = (event) => {
    if (!quoting) return;
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
    if (event.type === "click") pick(event);
  };
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"]) {
    window.addEventListener(type, swallow, true);
  }
  window.addEventListener("keydown", (event) => {
    if (!quoting || event.isComposing) return;
    if (event.key === "Escape") {
      event.stopImmediatePropagation();
      event.preventDefault();
      send({ type: "mandate.page.quoteEnd" });
    } else if (event.key === "Enter" || event.key === " ") {
      event.stopImmediatePropagation();
      event.preventDefault();
      pick(event);
    }
  }, true);

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "mandate.page.quoting" && typeof data.on === "boolean") {
      setQuoting(data.on);
    } else if (data.type === "mandate.page.askQuotable") {
      quotable = null;
      sayQuotable();
    } else if (data.type === "mandate.page.whenDrawn") {
      drawWanted = true;
      sayDrawn();
    } else if (data.type === "mandate.page.data" && typeof data.name === "string") {
      stirred += 1;
      latest.set(data.name, data.data);
      for (const fn of listeners.get(data.name) || []) call(fn, data.data);
      sayDrawn();
    } else if (data.type === "mandate.page.result" && pending.has(data.reqId)) {
      stirred += 1;
      const { resolve, reject } = pending.get(data.reqId);
      pending.delete(data.reqId);
      gets.delete(data.reqId);
      if (data.ok) resolve(data.data);
      else reject(new Error(typeof data.error === "string" ? data.error : "refused"));
      // After what the page does with the answer (its then, a microtask).
      Promise.resolve().then(sayDrawn);
    } else if (data.type === "mandate.page.style" && typeof data.css === "string") {
      // The app's colors and fonts for a new theme, in place of the old.
      const style = document.querySelector("style[data-mandate-page-style]");
      if (style) style.textContent = data.css;
    } else if (data.type === "mandate.page.clear") {
      // An answer was kept (maybe from a version before this one): what was
      // typed is done with.
      kept = {};
      early = null;
    } else if (data.type === "mandate.page.preview" && data.values && typeof data.values === "object" && !restored) {
      early = data.values;
      preview();
    } else if (data.type === "mandate.page.restore" && data.values && typeof data.values === "object") {
      // What the user typed before this version, unless typed again since.
      // Settled from here: the preview is over.
      early = null;
      restored = true;
      kept = { ...data.values, ...kept };
      restore();
    }
  });
})();
</script>`;
}
