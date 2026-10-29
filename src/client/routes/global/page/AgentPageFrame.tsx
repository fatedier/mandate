import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AGENT_PAGE_BUILTINS, AGENT_PAGE_LIMITS, type AgentPageDataDto } from "@shared/api/agent-page";
import { apiPath } from "@/lib/api-base";
import { useResolvedTheme } from "@/lib/theme";
import { CanvasHtmlView } from "@/routes/canvas/CanvasHtmlView";
import type { CanvasView, ResolvedCanvasView } from "@/routes/canvas/canvas-view";
import { agentPageScript, readPageFrameMessage } from "./page-bridge";
import { pageStyleElement, usePageStyleCss } from "./page-style";

/** The page's id in its messages: one page, so one id. */
export const AGENT_PAGE_ID = "agent-page";

/** What a page may keep the host holding for it: gets waiting for data, and
 *  sources followed (every built-in and as many as sources.json may list). */
export const PAGE_GETS_WAITING_MAX = 100;
export const PAGE_FOLLOWED_MAX = AGENT_PAGE_BUILTINS.length + AGENT_PAGE_LIMITS.sources;

/** The page never zooms: it lays out at the pane's width. */
const VIEW: CanvasView = { desktop: null, zoom: null };
const RESOLVED: ResolvedCanvasView = { desktop: false, zoom: 1, fit: true, layoutWidth: 0 };
const ignoreView = () => {};

interface AgentPageFrameProps {
  version: { revision: number; html: string };
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
}

type Post = (message: unknown) => void;

/**
 * Your agent's page in its sandboxed frame, with `window.mandate` answered:
 * a source's data from `data`, its changes as they come, answers sent on,
 * Mandate's pages opened. A new version is a new frame (keyed by revision),
 * given back what the user had typed.
 */
export function AgentPageFrame(props: AgentPageFrameProps) {
  return <PageVersionFrame key={props.version.revision} {...props} />;
}

function PageVersionFrame({ version, held, onFields, onFocus, data, subscribe, unsubscribe, submit, open, clearCount = 0 }: AgentPageFrameProps) {
  const latest = useRef({ held, onFields, onFocus, data, subscribe, unsubscribe, submit, open });
  useLayoutEffect(() => {
    latest.current = { held, onFields, onFocus, data, subscribe, unsubscribe, submit, open };
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
    if (!send) return;
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
    if (clearCount === clearsSeen.current) return;
    clearsSeen.current = clearCount;
    post.current?.({ type: "mandate.page.clear" });
  }, [clearCount]);
  // Gone: what this frame followed is let go of.
  useEffect(() => {
    const names = followed.current;
    return () => {
      for (const name of names.keys()) latest.current.unsubscribe(name);
      names.clear();
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
      case "fields":
        p.onFields(message.values);
        return;
      case "focus":
        p.onFocus(message.inField);
        return;
    }
  }, [follow]);

  const onFrameLoad = useCallback((send: Post) => {
    post.current = send;
    // The colors of now: a page that reloads itself starts again from the
    // stylesheet it was built with, maybe another theme's.
    styleSent.current = styleNow.current.css;
    send({ type: "mandate.page.style", css: styleNow.current.css });
    // Data not yet sent first, so a form drawn from it is there; then what
    // the user typed, over it. Data the page already has is not sent again:
    // a form rebuilt from it would lose what was just given back.
    flush();
    send({ type: "mandate.page.restore", values: latest.current.held });
  }, [flush]);

  const canvas = useMemo(() => ({ id: AGENT_PAGE_ID, html: version.html, title: "Page" }), [version.html]);
  // Built once per version (a new head would reload the frame): the colors of
  // later themes come by message.
  const [headScript] = useState(() => pageStyleElement(styleCss) + agentPageScript(AGENT_PAGE_ID));
  // Nothing is served next to the page: its relative links resolve against
  // a folder that holds nothing.
  const assetsBaseUrl = useMemo(() => new URL(apiPath("/api/agent-page/assets/"), window.location.href).href, []);
  return (
    <CanvasHtmlView
      canvas={canvas}
      view={VIEW}
      resolved={RESOLVED}
      onViewChange={ignoreView}
      assetsBaseUrl={assetsBaseUrl}
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
