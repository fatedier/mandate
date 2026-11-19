import { createElement } from "react";
import type { ExternalToast, toast as sonnerToast } from "sonner";
import { NOTICE_TOASTER_ID, NoticeCard } from "@/components/NoticeCard";
import type { NotificationShowEvent, NotificationWithdrawEvent } from "@shared/api/notifications";
import { systemNoticeText } from "@shared/notice-text";
import type { DesktopNotifier } from "./desktop-notify";

export type ToastApi = ((title: string, options?: ExternalToast) => string | number) & Pick<typeof sonnerToast, "dismiss" | "custom">;

/** What this window is, set by the shell while it is mounted. */
export interface InAppEnv {
  windowId: string;
  shell: "browser" | "desktop-app";
  navigate: (to: string) => void;
  /** The user opened a notice here, leading to `link`: noted as input there. */
  touched: (link: string) => void;
  toast: ToastApi;
  desktop: DesktopNotifier;
}

let env: InAppEnv | null = null;
/** How long a news notice card stays (a task ready for review): it asks
 *  nothing of the user. */
const NEWS_NOTICE_MS = 8_000;
/** The notice card this window shows for each matter, by its own id: a card
 *  that replaces another is a new one (a new time of its own), so whatever
 *  the old one still does as it goes cannot touch it. */
const cards = new Map<string, string>();
let cardCount = 0;

/** Takes back the card shown for a matter, if any. */
function dropCard(key: string): void {
  const id = cards.get(key);
  if (id === undefined) return;
  cards.delete(key);
  env?.toast.dismiss(id);
}
/** The browser notifications this page shows, by matter. */
const shown = new Map<string, Notification>();

export function setInAppEnv(next: InAppEnv | null): void {
  env = next;
}

/** A notice the server meant for some windows: this one shows it if named. */
export function handleShow(event: NotificationShowEvent): void {
  const current = env;
  if (!current) return;
  // One notice per matter: what this window shows of an older one goes,
  // whether the newer comes here or to another window.
  closeShown(event.key);
  dropCard(event.key);
  if (event.toast.includes(current.windowId)) {
    // One that waits on the user stays until opened, closed, or withdrawn;
    // news goes by itself, on the card's own time: sonner ends neither.
    const id = `${event.key}#${++cardCount}`;
    const dismiss = () => {
      if (cards.get(event.key) === id) cards.delete(event.key);
      current.toast.dismiss(id);
    };
    cards.set(event.key, id);
    const open = () => { dismiss(); current.touched(event.link); current.navigate(event.link); };
    const life = event.level === "news" ? { lifeMs: NEWS_NOTICE_MS, onExpire: dismiss } : {};
    current.toast.custom(
      () => createElement(NoticeCard, { event, onOpen: open, onDismiss: dismiss, ...life }),
      { id, toasterId: NOTICE_TOASTER_ID, duration: Infinity }
    );
    return;
  }
  if (!event.system.includes(current.windowId)) return;
  if (current.shell === "desktop-app") {
    void current.desktop.show({ title: event.title, body: systemNoticeText(event), link: event.link })
      .catch((error: unknown) => console.warn("[mandate-desktop] notification failed", error));
    return;
  }
  if (typeof window.Notification === "undefined" || window.Notification.permission !== "granted") return;
  const notice = new window.Notification(event.title, { body: systemNoticeText(event), tag: event.key });
  notice.onclick = () => {
    window.focus();
    current.touched(event.link);
    current.navigate(event.link);
    notice.close();
  };
  notice.onclose = () => {
    if (shown.get(event.key) === notice) shown.delete(event.key);
  };
  shown.set(event.key, notice);
}

/** The notice was seen or settled: what this window shows of it goes. The
 *  desktop app's stay (its plugin cannot remove them on macOS). */
export function handleWithdraw(event: NotificationWithdrawEvent): void {
  dropCard(event.key);
  closeShown(event.key);
}

function closeShown(key: string): void {
  const notice = shown.get(key);
  if (notice) {
    shown.delete(key);
    notice.close();
  }
}

let reportNow: (() => void) | null = null;

/** Lets Settings send a fresh presence report (a permission just given). */
export function setPresenceReporter(fn: (() => void) | null): void {
  reportNow = fn;
}

export function reportPresenceNow(): void {
  reportNow?.();
}

/** After the event stream reconnects: a withdraw sent while it was down never
 *  came, so the cards shown before go. What still waits on the user is in
 *  Waiting on you. */
export function dropNoticeCards(): void {
  for (const key of [...cards.keys()]) dropCard(key);
}
