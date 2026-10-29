/**
 * The scripts Mandate puts inside a report's frame, and the messages they
 * send. The frame is sandboxed without same-origin, so postMessage is the
 * only way across.
 *
 * Frame → viewer: scroll (position and page height, for keeping the reader's
 * place across zoom and width changes), interact (the reader scrolled, pressed
 * or used a navigation key, so a kept place lets go), zoom (Ctrl+scroll, a trackpad pinch), key
 * (Esc and ⌘⇧Enter, which do not bubble out of an iframe), go (an
 * artboard's link to another board of its design).
 * Viewer → frame: theme (live, no reload), scrollTo.
 */

type CanvasFrameMessage =
  | { type: "scroll"; y: number; height: number }
  | { type: "interact" }
  | { type: "zoom"; wheel: number | null; scale: number | null; x: number; y: number; scrollY: number | null; height: number | null }
  | { type: "key"; key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }
  | { type: "go"; path: string };

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A message from a report frame, validated. Anything else (another canvas,
 *  a malformed payload, a removed message type) is null. */
export function readCanvasFrameMessage(data: unknown, canvasId: string): CanvasFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.canvasId !== canvasId) return null;
  switch (d.type) {
    case "mandate.canvas.scroll":
      return isNumber(d.y) && isNumber(d.height) ? { type: "scroll", y: Math.max(0, d.y), height: Math.max(0, d.height) } : null;
    case "mandate.canvas.interact":
      return { type: "interact" };
    case "mandate.canvas.zoom": {
      const wheel = isNumber(d.wheel) ? d.wheel : null;
      const scale = isNumber(d.scale) && d.scale > 0 ? d.scale : null;
      if ((wheel === null) === (scale === null) || !isNumber(d.x) || !isNumber(d.y)) return null;
      return {
        type: "zoom", wheel, scale, x: d.x, y: d.y,
        scrollY: isNumber(d.scrollY) ? Math.max(0, d.scrollY) : null,
        height: isNumber(d.height) ? Math.max(0, d.height) : null
      };
    }
    case "mandate.canvas.key":
      return typeof d.key === "string"
        ? { type: "key", key: d.key, metaKey: d.metaKey === true, ctrlKey: d.ctrlKey === true, shiftKey: d.shiftKey === true }
        : null;
    case "mandate.canvas.go":
      return typeof d.path === "string" ? { type: "go", path: d.path } : null;
    default:
      return null;
  }
}

/** Runs before the page's own scripts: storage degrades to memory instead of
 *  throwing in the sandbox, and in-page `#anchor` links scroll. */
export function canvasRuntimeScript(): string {
  return `<script data-mandate-runtime>
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

  // The element an in-page link names, found the way the browser finds a
  // fragment: by id, then an <a name>, each as written and then
  // percent-decoded (a Chinese heading's id arrives encoded).
  const indicated = (fragment) => {
    let decoded = fragment;
    try { decoded = decodeURIComponent(fragment); } catch (_) { /* keep it as written */ }
    for (const name of [fragment, decoded]) {
      if (!name) continue;
      const found = document.getElementById(name) ||
        Array.from(document.getElementsByName(name)).find((element) => element.localName === "a");
      if (found) return found;
    }
    return /^top$/i.test(decoded) || decoded === "" ? "top" : null;
  };

  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest
      ? event.target.closest("a[href], area[href]")
      : null;
    if (!target) return;
    const href = target.getAttribute("href");
    if (href == null) return;
    if (href !== "" && !href.startsWith("#")) {
      // Every link leaves in a new tab, whatever target it names: _self or
      // _top would replace the report inside its frame.
      target.setAttribute("target", "_blank");
      return;
    }
    // An in-page link never leaves: resolved against the report's folder, one
    // whose target is missing would open that folder in a new tab.
    event.preventDefault();
    const destination = indicated(href.slice(1));
    if (destination === "top") window.scrollTo({ top: 0, left: 0 });
    else if (destination) destination.scrollIntoView();
  }, true);
})();
</script>`;
}

/** Runs after the page: reports scroll and zoom gestures, forwards keys, and
 *  takes the viewer's theme and scroll-to messages. */
export function canvasBridgeScript(canvasId: string, options: { artboard?: { path: string; boards: string[] } } = {}): string {
  const id = JSON.stringify(canvasId);
  // Board paths follow the design index's path rule, so this JSON can never
  // hold "</script>".
  const artboard = JSON.stringify(options.artboard ?? null);
  return `<script data-mandate-bridge>
(() => {
  const canvasId = ${id};
  const send = (payload) => {
    try { window.parent.postMessage({ ...payload, canvasId }, "*"); }
    catch (_) { /* parent gone */ }
  };
  // A design's artboard: a link that names another board moves the viewer to
  // it (a prototype link). Capture phase, after the runtime's
  // handler: that one sets target=_blank, this one then stops the navigation.
  const artboard = ${artboard};
  if (artboard) {
    // ⌘+wheel zooms the whole page in Firefox on a Mac; an artboard has no
    // zoom of its own in the focused view, so neither modifier reaches the browser.
    window.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    }, { passive: false });
    document.addEventListener("click", (event) => {
      const link = event.target && event.target.closest ? event.target.closest("a[href], area[href]") : null;
      if (!link) return;
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      let target;
      try {
        const url = new URL(href, "http://design.invalid/" + artboard.path);
        // Another origin is another site, whatever its path (the parser trims
        // the whitespace a raw check would miss).
        if (url.origin !== "http://design.invalid") return;
        target = decodeURIComponent(url.pathname.slice(1));
      }
      catch (_) { return; }
      if (!artboard.boards.includes(target)) return;
      event.preventDefault();
      send({ type: "mandate.canvas.go", path: target });
    }, true);
  }
  const hasOpenOverlay = () => Array.from(document.querySelectorAll(
    'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'
  )).some((overlay) => {
    if (overlay.closest('[hidden], [aria-hidden="true"], [data-state="closed"]')) return false;
    const style = getComputedStyle(overlay);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && overlay.getClientRects().length > 0;
  });
  // Keyboard events do not bubble out of the sandboxed iframe. Open overlays
  // in the page own them; closed modal nodes must not disable pane shortcuts.
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
  const pageHeight = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  let queued = false;
  const postScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      send({ type: "mandate.canvas.scroll", y: window.scrollY, height: pageHeight() });
    });
  };
  window.addEventListener("scroll", postScroll, { passive: true });
  window.addEventListener("resize", postScroll);
  window.addEventListener("load", postScroll);
  if (typeof ResizeObserver !== "undefined" && document.body) {
    try { new ResizeObserver(postScroll).observe(document.body); }
    catch (_) { /* ignore */ }
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(postScroll).catch(() => {});
  postScroll();
  // The page's ground, for the track of its scrollbars (the skeleton's rule
  // reads it): the colour the browser paints behind the page, which is the
  // root's, or the body's when the root has none. Read now, and again with
  // each theme the viewer sends: it sends one whenever a report has loaded,
  // by when a stylesheet or a script may have set the ground late. A ground
  // that is no one colour (a gradient, a picture) reads as clear, and so is
  // its track.
  const groundOf = (element) => window.getComputedStyle(element).backgroundColor;
  const takeGround = () => {
    const root = groundOf(document.documentElement);
    document.documentElement.style.setProperty("--mandate-ground", root === "rgba(0, 0, 0, 0)" ? groundOf(document.body) : root);
  };
  takeGround();
  // The reader scrolling by hand: wheel, touch, a press, or a navigation key.
  // Sent at once and every time (no throttle: any one of them may be the one
  // that must end a newer hold), ahead of the scroll report that scrolling
  // queues for the next frame.
  const interacted = () => send({ type: "mandate.canvas.interact" });
  window.addEventListener("wheel", (event) => { if (!event.ctrlKey) interacted(); }, { passive: true });
  window.addEventListener("touchmove", interacted, { passive: true });
  // A press anywhere: following an in-page link, dragging the scrollbar.
  window.addEventListener("pointerdown", interacted, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) interacted();
  });
  // Ctrl+scroll and a trackpad pinch (Chrome, Edge, Firefox) zoom the report,
  // not the browser page.
  window.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    // Firefox reports a mouse notch in lines (deltaMode 1): report pixels.
    const deltaY = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY;
    send({ type: "mandate.canvas.zoom", wheel: deltaY, x: event.clientX, y: event.clientY, scrollY: window.scrollY, height: pageHeight() });
  }, { passive: false });
  // WebKit reports a trackpad pinch as gesture events. A phone's pinch is left
  // to the browser, which magnifies the whole screen.
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  let gestureScale = 1;
  window.addEventListener("gesturestart", (event) => {
    if (coarse) return;
    event.preventDefault();
    gestureScale = 1;
  });
  window.addEventListener("gesturechange", (event) => {
    if (coarse) return;
    event.preventDefault();
    const factor = event.scale / gestureScale;
    gestureScale = event.scale;
    send({ type: "mandate.canvas.zoom", scale: factor, x: event.clientX, y: event.clientY, scrollY: window.scrollY, height: pageHeight() });
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "mandate.canvas.theme" && (data.theme === "light" || data.theme === "dark")) {
      document.documentElement.setAttribute("data-theme", data.theme);
      takeGround();
    } else if (data.type === "mandate.canvas.scrollTo" && typeof data.y === "number") {
      // A jump, even on a page with scroll-behavior: smooth.
      window.scrollTo({ top: data.y, behavior: "instant" });
    }
  });
})();
</script>`;
}
