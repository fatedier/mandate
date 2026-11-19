import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AGENT_PAGE_BUILTINS, AGENT_PAGE_FIRST, AGENT_PAGE_LIMITS, type AgentPageDataDto } from "@shared/api/agent-page";
import { api } from "@/lib/api-paths";
import { PageShownContext } from "@/lib/page-shown";
import { useResolvedTheme } from "@/lib/theme";
import { CanvasHtmlView } from "@/routes/canvas/CanvasHtmlView";
import type { CanvasView, ResolvedCanvasView } from "@/routes/canvas/canvas-view";
import { agentPageScript, readPageFrameMessage } from "./page-bridge";
import { pageStyleElement, usePageStyleCss } from "./page-style";
import { hasPage } from "./page-place";

/** The page's id in its messages: one page, so one id. */
export const AGENT_PAGE_ID = "agent-page";

/** What a page may keep the host holding for it: gets waiting for data, and
 *  sources followed (every built-in and as many as sources.json may list). */
export const PAGE_GETS_WAITING_MAX = 100;
export const PAGE_FOLLOWED_MAX = AGENT_PAGE_BUILTINS.length + AGENT_PAGE_LIMITS.sources;

/** How long the page in sight stays over another of its version's pages
 *  that has not said it has drawn. */
export const PAGE_HOLD_MAX_MS = 1000;

/** The page never zooms: it lays out at the pane's width. */
const VIEW: CanvasView = { desktop: null, zoom: null };
const RESOLVED: ResolvedCanvasView = { desktop: false, zoom: 1, fit: true, layoutWidth: 0 };
const ignoreView = () => {};

/** The folder a page's relative links resolve against, from the version's. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : `${path.slice(0, cut).split("/").map(encodeURIComponent).join("/")}/`;
}

interface AgentPageFrameProps {
  version: { revision: number; pages: Record<string, string> };
  /** The page of the version shown, by its path in its folder; its first
   *  page when the version has none there. */
  path: string;
  /** A link on the page goes to another of the version's pages. */
  onGo(path: string): void;
  /** What the user typed, by field id: given back to each new version. */
  held: Record<string, string>;
  onFields(values: Record<string, string>): void;
  onFocus(inField: boolean): void;
  /** A source's latest data, or null while it is not loaded. */
  data(name: string): AgentPageDataDto | null;
  /** The page wants this source's data, now and as it changes. */
  subscribe(name: string): void;
  /** The frame that wanted it is gone (a new version, the pane hidden). */
  unsubscribe(name: string): void;
  submit(value: unknown): Promise<{ ok: boolean; error?: string }>;
  open(path: string): void;
  /** Moves on each time the owner lets go of what was typed (an answer
   *  kept): the frame now showing is told to let go too. */
  clearCount?: number;
  /** The user is picking an item of the page to quote. */
  quoting?: boolean;
  /** Whether the page marks an item to quote, as it says. */
  onQuotable?(any: boolean): void;
  /** The item picked while quoting: one each time the mode is on. */
  onQuote?(text: string): void;
  /** Esc in the page while quoting. */
  onQuoteEnd?(): void;
}

/** A frame of the page: a version's page, keyed by both. */
interface Layer {
  version: AgentPageFrameProps["version"];
  path: string;
  key: string;
}

function layerOf(at: { version: AgentPageFrameProps["version"]; path: string }): Layer {
  const path = hasPage(at.version.pages, at.path) ? at.path : AGENT_PAGE_FIRST;
  return { version: at.version, path, key: `${at.version.revision}\n${path}` };
}

type Post = (message: unknown) => void;

/**
 * Personal agent's page in its sandboxed frame, with `window.mandate` answered:
 * a source's data from `data`, its changes as they come, answers sent on,
 * Mandate's pages opened, the version's other pages gone to. A new version,
 * or another page of it, is a new frame (keyed by both), given back what
 * the user had typed. Another page of the same version is drawn under the
 * one in sight, which stays over it until it has drawn from its data (or
 * PAGE_HOLD_MAX_MS), as a browser holds a page until the next one paints:
 * no blank frame, no page without its data, and what both follow is never
 * let go of between them. A new version comes in at once, as always.
 */
export function AgentPageFrame(props: AgentPageFrameProps) {
  // A version that comes while its page is hidden (kept while another
  // shows, shell/KeptPage), the first one too, waits to be shown: a frame
  // made then would start with no one listening, and what it asks for at
  // its start would be lost.
  const shown = useContext(PageShownContext);
  const [drawn, setDrawn] = useState(shown ? { version: props.version, path: props.path } : null);
  if (shown && (drawn?.version.revision !== props.version.revision || drawn.path !== props.path)) setDrawn({ version: props.version, path: props.path });
  const at = shown ? { version: props.version, path: props.path } : drawn;
  const target = at ? layerOf(at) : null;
  // The frame given what the pane says (live), and the one still in sight
  // over it while it draws (cover): the page the user was on.
  const [layers, setLayers] = useState<{ live: Layer | null; cover: Layer | null }>({ live: target, cover: null });
  if (target && target.key !== layers.live?.key) {
    const before = layers.live;
    const cover = before && before.version.revision === target.version.revision ? layers.cover ?? before : null;
    setLayers({ live: target, cover: cover && cover.key !== target.key ? cover : null });
  }
  const uncover = useCallback(() => setLayers((now) => (now.cover ? { ...now, cover: null } : now)), []);
  // A page that never says it has drawn (its data never comes) is shown anyway.
  const coverKey = layers.cover?.key ?? null;
  const liveKey = layers.live?.key ?? null;
  useEffect(() => {
    if (coverKey === null) return;
    const timer = setTimeout(uncover, PAGE_HOLD_MAX_MS);
    return () => clearTimeout(timer);
  }, [coverKey, liveKey, uncover]);
  if (!target || !layers.live) return null;
  const { live, cover } = layers;
  // In the order they came, so neither moves in the document (a moved frame reloads).
  const order = cover ? [cover, live] : [live];
  return (
    <div className="relative h-full w-full">
      {order.map((layer) => {
        const isCover = layer === cover;
        const inSight = isCover || !cover;
        return (
          // While one draws under the other, neither takes input.
          <div key={layer.key} data-page-frame="" data-in-sight={inSight ? "" : undefined} inert={cover !== null} className={isCover ? "absolute inset-0 z-10" : "absolute inset-0"}>
            <PageVersionFrame {...props} version={layer.version} path={layer.path} still={isCover} onDrawn={cover && !isCover ? uncover : undefined} />
          </div>
        );
      })}
    </div>
  );
}

interface PageVersionFrameProps extends AgentPageFrameProps {
  /** In sight while another page draws under it: it takes and sends nothing
   *  (what the pane gives is for the other page), and keeps what it follows. */
  still: boolean;
  /** Asked once it has loaded and has the data it follows: it has drawn. */
  onDrawn?: (() => void) | undefined;
}

function PageVersionFrame({ version, path, onGo, held, onFields, onFocus, data, subscribe, unsubscribe, submit, open, clearCount = 0, quoting = false, onQuotable, onQuote, onQuoteEnd, still, onDrawn }: PageVersionFrameProps) {
  const latest = useRef({ held, onFields, onFocus, data, subscribe, unsubscribe, submit, open, onGo, onQuotable, onQuote, onQuoteEnd });
  const stillNow = useRef(still);
  const onDrawnNow = useRef(onDrawn);
  useLayoutEffect(() => {
    latest.current = { held, onFields, onFocus, data, subscribe, unsubscribe, submit, open, onGo, onQuotable, onQuote, onQuoteEnd };
    stillNow.current = still;
    onDrawnNow.current = onDrawn;
  });
  // The app's colors and fonts for the page, and the theme they are of.
  const styleCss = usePageStyleCss();
  const theme = useResolvedTheme();
  const styleNow = useRef({ css: styleCss, theme });
  useLayoutEffect(() => {
    styleNow.current = { css: styleCss, theme };
  });
  // The frame's way in, from its latest message or load.
  const post = useRef<Post | null>(null);
  // Sources the page follows, with the data last sent for each.
  const followed = useRef(new Map<string, AgentPageDataDto | null>());
  // Gets waiting for a source's first data, and how many.
  const waiting = useRef(new Map<string, number[]>());
  const waitingCount = useRef(0);

  /** Sends what changed: the data of followed sources, and answers to gets
   *  that were waiting for it. */
  const flush = useCallback(() => {
    const send = post.current;
    if (!send || stillNow.current) return;
    for (const [name, sent] of followed.current) {
      const now = latest.current.data(name);
      if (now && now !== sent) {
        followed.current.set(name, now);
        send({ type: "mandate.page.data", name, data: shape(now) });
      }
    }
    for (const [name, reqIds] of waiting.current) {
      const now = latest.current.data(name);
      if (!now) continue;
      waiting.current.delete(name);
      waitingCount.current -= reqIds.length;
      for (const reqId of reqIds) send({ type: "mandate.page.result", reqId, ok: true, data: shape(now) });
    }
  }, []);

  // Whether it was asked to say it has drawn.
  const drawAsked = useRef(false);
  /** Asks it to say once it has drawn: once its document is read, and at its
   *  load (which waits for pictures: a browser shows the next page once it
   *  paints, not once it has loaded). The page judges when that is: it alone
   *  knows what it asked for and what it has taken in (page-bridge). */
  const askDrawn = useCallback(() => {
    if (!onDrawnNow.current) return;
    drawAsked.current = true;
    post.current?.({ type: "mandate.page.whenDrawn" });
  }, []);

  // Each render may carry new data.
  useEffect(() => { flush(); });
  // A new theme's stylesheet, into the document as it stands. The theme is
  // said again after it: the frame reads its ground (for its scrollbars) when
  // told the theme, which the viewer told it before the new colors came.
  const styleSent = useRef(styleCss);
  useEffect(() => {
    if (styleCss === styleSent.current) return;
    styleSent.current = styleCss;
    post.current?.({ type: "mandate.page.style", css: styleCss });
    post.current?.({ type: "mandate.canvas.theme", theme: styleNow.current.theme });
  }, [styleCss]);
  // A clear asked for since this frame came: passed on to its document.
  const clearsSeen = useRef(clearCount);
  useEffect(() => {
    if (still || clearCount === clearsSeen.current) return;
    clearsSeen.current = clearCount;
    post.current?.({ type: "mandate.page.clear" });
  }, [clearCount, still]);
  // Quoting: the frame is told as the mode starts and ends. A quote is taken
  // only while it is on, one each time: the page cannot put more in the
  // composer than the user picked.
  const quotingNow = useRef(quoting);
  const quoteTaken = useRef(false);
  useLayoutEffect(() => {
    if (still || quoting === quotingNow.current) return;
    quotingNow.current = quoting;
    quoteTaken.current = false;
    post.current?.({ type: "mandate.page.quoting", on: quoting });
  }, [quoting, still]);
  // Gone, or hidden in a page kept while another shows (shell/KeptPage):
  // what this frame followed is let go of. Shown again, the same frame is
  // there and does not ask again, so what it followed is followed again.
  useEffect(() => {
    const names = followed.current;
    for (const name of names.keys()) latest.current.subscribe(name);
    // What the page said while hidden was not heard (the frame listens only
    // while shown): whether it has an item to quote, it says again.
    post.current?.({ type: "mandate.page.askQuotable" });
    return () => {
      for (const name of names.keys()) latest.current.unsubscribe(name);
    };
  }, []);

  /** Follows a source, within the limit; whether it is followed. */
  const follow = useCallback((name: string): boolean => {
    if (followed.current.has(name)) return true;
    if (followed.current.size >= PAGE_FOLLOWED_MAX) return false;
    followed.current.set(name, null);
    latest.current.subscribe(name);
    return true;
  }, []);

  const onFrameMessage = useCallback((raw: unknown, reply: Post) => {
    post.current = reply;
    if (stillNow.current) return;
    let message: ReturnType<typeof readPageFrameMessage>;
    try {
      message = readPageFrameMessage(raw, AGENT_PAGE_ID);
    } catch {
      // A payload that broke the check: refused, so the page's promise settles.
      const reqId = raw && typeof raw === "object" ? (raw as { reqId?: unknown }).reqId : undefined;
      if (typeof reqId === "number") reply({ type: "mandate.page.result", reqId, ok: false, error: "not a message the host takes" });
      return;
    }
    if (!message) return;
    const p = latest.current;
    switch (message.type) {
      case "get": {
        const now = p.data(message.name);
        if (now) {
          reply({ type: "mandate.page.result", reqId: message.reqId, ok: true, data: shape(now) });
          return;
        }
        if (waitingCount.current >= PAGE_GETS_WAITING_MAX) {
          reply({ type: "mandate.page.result", reqId: message.reqId, ok: false, error: "too many requests waiting" });
          return;
        }
        if (!follow(message.name)) {
          reply({ type: "mandate.page.result", reqId: message.reqId, ok: false, error: "too many sources followed" });
          return;
        }
        const queue = waiting.current.get(message.name);
        if (queue) queue.push(message.reqId);
        else waiting.current.set(message.name, [message.reqId]);
        waitingCount.current += 1;
        return;
      }
      case "subscribe": {
        if (!follow(message.name)) return;
        // Followed already (the page reloaded itself): this document has
        // not had the data, so it is sent again.
        const now = p.data(message.name);
        if (now) {
          followed.current.set(message.name, now);
          reply({ type: "mandate.page.data", name: message.name, data: shape(now) });
        }
        return;
      }
      case "submit":
        void p.submit(message.value).then(
          (result) => reply({ type: "mandate.page.result", reqId: message.reqId, ok: result.ok, ...(result.error ? { error: result.error } : {}) }),
          (error: unknown) => reply({ type: "mandate.page.result", reqId: message.reqId, ok: false, error: error instanceof Error ? error.message : "not sent" })
        );
        return;
      case "refused":
        reply({ type: "mandate.page.result", reqId: message.reqId, ok: false, error: message.error });
        return;
      case "open":
        p.open(message.path);
        return;
      case "go":
        if (hasPage(version.pages, message.path)) p.onGo(message.path);
        return;
      case "fields":
        p.onFields(message.values);
        return;
      case "ready":
        // Its document is read: what the user typed, to show until its load
        // gives it back for good (after the data, onFrameLoad).
        reply({ type: "mandate.page.preview", values: p.held });
        askDrawn();
        return;
      case "drawn":
        if (drawAsked.current) onDrawnNow.current?.();
        return;
      case "focus":
        p.onFocus(message.inField);
        return;
      case "quotable":
        p.onQuotable?.(message.any);
        return;
      case "quote":
        if (!quotingNow.current || quoteTaken.current) return;
        quoteTaken.current = true;
        p.onQuote?.(message.text);
        return;
      case "quoteEnd":
        if (quotingNow.current) p.onQuoteEnd?.();
        return;
    }
  }, [follow, version.pages, askDrawn]);

  const onFrameLoad = useCallback((send: Post) => {
    post.current = send;
    // In sight over another page (a page that reloads itself meanwhile):
    // what the pane holds now is that page's.
    if (stillNow.current) return;
    // The colors of now: a page that reloads itself starts again from the
    // stylesheet it was built with, maybe another theme's.
    styleSent.current = styleNow.current.css;
    send({ type: "mandate.page.style", css: styleNow.current.css });
    // Data not yet sent first, so a form drawn from it is there; then what
    // the user typed, over it. Data the page already has is not sent again:
    // a form rebuilt from it would lose what was just given back.
    flush();
    send({ type: "mandate.page.restore", values: latest.current.held });
    // A document that loads while the user is picking (the page reloaded
    // itself) starts outside the mode: it is told.
    if (quotingNow.current) send({ type: "mandate.page.quoting", on: true });
    // Asked again, in case it never said its document was read; a page
    // that has drawn answers once more, to no effect.
    askDrawn();
  }, [flush, askDrawn]);

  const canvas = useMemo(() => ({ id: AGENT_PAGE_ID, html: version.pages[path] ?? "", title: "Page" }), [version.pages, path]);
  // Built once per frame (a new head would reload it): the colors of later
  // themes come by message.
  const [headScript] = useState(() => pageStyleElement(styleCss) + agentPageScript(AGENT_PAGE_ID, { path, pages: Object.keys(version.pages) }));
  // What the page loads by relative path comes from its version's folder,
  // resolved from the page's own place in it; the whole folder may load.
  // Absolute, from the API's path: the desktop app's page is tauri://.
  const folderUrl = useMemo(() => new URL(api.agentPageFilesBase(version.revision), window.location.href).href, [version.revision]);
  return (
    <CanvasHtmlView
      canvas={canvas}
      view={VIEW}
      resolved={RESOLVED}
      onViewChange={ignoreView}
      assetsBaseUrl={folderUrl + folderOf(path)}
      folderUrl={folderUrl}
      headScript={headScript}
      onFrameMessage={onFrameMessage}
      onFrameLoad={onFrameLoad}
    />
  );
}

/** What the page reads of a source: its value, when it was read, its error. */
function shape(data: AgentPageDataDto): { value: unknown; at: string | null; error: string | null } {
  return { value: data.value, at: data.at, error: data.error };
}
