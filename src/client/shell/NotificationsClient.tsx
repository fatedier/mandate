import { useCallback, useContext, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast as sonnerToast } from "sonner";
import { API_ROUTES } from "@shared/api-contracts";
import { PRESENCE_HEARTBEAT_MS, type PresenceReport } from "@shared/api/notifications";
import { apiPath } from "@/lib/api-base";
import { HistoryLocationContext } from "@/lib/covered-route";
import { randomId } from "@/lib/random-id";
import { isTauriRuntime } from "@/lib/runtime";
import { deviceKind, pageNotifySupport } from "@/lib/notification-support";
import { tauriDesktopNotifier, type DesktopNotifier } from "@/lib/desktop-notify";
import { setInAppEnv, setPresenceReporter, type ToastApi } from "@/lib/in-app-notifications";
import { useThreadChatInSight } from "@/routes/threads/thread-chat-sight";

export type { ToastApi } from "@/lib/in-app-notifications";

/** Input sends a report at most this often; between reports it is only noted. */
const INPUT_REPORT_MS = 15_000;
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
/** What a canvas frame posts when its reader scrolls, presses or zooms in it,
 *  and Personal agent's page when its reader types in a field. Not a canvas's
 *  scroll reports: it sends those on load and resize too. */
const FRAME_INPUT: ReadonlySet<string> = new Set(["mandate.canvas.interact", "mandate.canvas.zoom", "mandate.canvas.key", "mandate.page.fields"]);

/** One per page load: a reload is a new window (the old one says it is gone),
 *  and a duplicated tab never shares its id. */
const WINDOW_ID = randomId();

/**
 * Tells the server where this window is (page, visible, focused, last input,
 * whether it can show a system notification), so a notice goes where the
 * user is; and shows the notices meant for this window. Renders nothing.
 * `toast` and `desktop` are injectable for tests.
 */
export function NotificationsClient({ toast = sonnerToast as ToastApi, desktop = tauriDesktopNotifier }: { toast?: ToastApi; desktop?: DesktopNotifier }) {
  const navigate = useNavigate();
  // Where the user is: a canvas opened over a thread is the page shown, though
  // the shell around it is drawn for the thread behind.
  const routed = useLocation();
  const location = useContext(HistoryLocationContext) ?? routed;
  const path = location.pathname + location.search;
  const shell: PresenceReport["shell"] = isTauriRuntime() ? "desktop-app" : "browser";
  // The thread whose chat the page has in sight, if any (ThreadPage).
  const threadChat = useThreadChatInSight((s) => s.threadId);
  const state = useRef({ path, threadChat, lastInputAt: null as string | null, lastInputReport: 0, desktopReady: false });

  const send = useCallback(() => {
    const s = state.current;
    const report: PresenceReport = {
      windowId: WINDOW_ID,
      device: deviceKind(),
      shell,
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
      lastInputAt: s.lastInputAt,
      path: s.path,
      ...(s.threadChat ? { threadChat: s.threadChat } : {}),
      canShowSystem: shell === "desktop-app" ? s.desktopReady : pageNotifySupport() === "ok"
    };
    void fetch(apiPath(API_ROUTES.notificationsPresence), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true
    }).catch(() => {});
  }, [shell]);

  useEffect(() => {
    // Opening a notice is the user acting here, though no key or pointer
    // reached the page: the page it opens is reported as seen.
    // Reported now, from where it leads (a notice opened on the page already
    // shown changes no route; reported from the page it leaves, New thread
    // would mark every matter seen).
    const touched = (link: string) => {
      state.current.lastInputAt = new Date().toISOString();
      state.current.path = link;
      send();
    };
    setInAppEnv({ windowId: WINDOW_ID, shell, navigate, touched, toast, desktop });
    if (shell === "desktop-app") {
      void desktop.listen((link) => {
        touched(link);
        navigate(link);
      });
    }
    return () => setInAppEnv(null);
  }, [navigate, toast, desktop, shell, send]);

  // Every page change is reported. A page opened in a window the user is
  // looking at counts as touching it — a link followed from a notification,
  // Back and Forward, which reach the page as no input event — so the matter
  // it shows is seen at once.
  useEffect(() => {
    const s = state.current;
    s.path = path;
    if (document.visibilityState === "visible" && document.hasFocus()) s.lastInputAt = new Date().toISOString();
    send();
  }, [path, send]);

  // The chat in sight changing (the panel maximized, the sheet pulled up) is
  // no page change and no input of its own: reported as it is.
  useEffect(() => {
    const s = state.current;
    if (s.threadChat === threadChat) return;
    s.threadChat = threadChat;
    send();
  }, [threadChat, send]);

  useEffect(() => {
    const s = state.current;
    const onInput = () => {
      s.lastInputAt = new Date().toISOString();
      if (Date.now() - s.lastInputReport < INPUT_REPORT_MS) return;
      s.lastInputReport = Date.now();
      send();
    };
    const onChange = () => send();
    // Inside a canvas the reader's keys and scrolling stay in its frame,
    // which says so with these messages.
    const onFrame = (event: MessageEvent) => {
      const type = (event.data as { type?: unknown } | null)?.type;
      if (typeof type === "string" && FRAME_INPUT.has(type)) onInput();
    };
    const onHide = () => {
      const body = new Blob([JSON.stringify({ windowId: WINDOW_ID, gone: true })], { type: "application/json" });
      navigator.sendBeacon?.(apiPath(API_ROUTES.notificationsPresence), body);
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { capture: true, passive: true });
    window.addEventListener("message", onFrame);
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    window.addEventListener("pagehide", onHide);
    const heartbeat = window.setInterval(send, PRESENCE_HEARTBEAT_MS);
    setPresenceReporter(send);
    let live = true;
    if (shell === "desktop-app") {
      void desktop.ready().then((ready) => {
        if (!live) return;
        s.desktopReady = ready;
        send();
      });
    }
    return () => {
      live = false;
      window.removeEventListener("message", onFrame);
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      window.removeEventListener("pagehide", onHide);
      window.clearInterval(heartbeat);
      setPresenceReporter(null);
    };
  }, [send, shell, desktop]);

  return null;
}
