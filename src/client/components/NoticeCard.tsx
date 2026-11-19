import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { Bell, Sparkles, SquareCheckBig, X } from "lucide-react";
import { Toaster as Sonner } from "sonner";
import { Button } from "@/components/ui/button";
import { noticeLines } from "@shared/notice-text";
import { useResolvedTheme } from "@/lib/theme";

/** The notices' own toaster: a corner apart from the feedback toasts (Saved,
 *  errors), which keep the top of the page. */
export const NOTICE_TOASTER_ID = "notices";

export interface NoticeEvent {
  key: string;
  title: string;
  body: string;
}

/** The personal agent's own matters, a task's, or anything else. */
function NoticeIcon({ matterKey }: { matterKey: string }) {
  const className = "mt-0.5 size-4 shrink-0 text-status-review";
  if (matterKey.startsWith("agent:")) return <Sparkles aria-hidden className={className} />;
  if (matterKey.startsWith("task:") || matterKey.startsWith("tasks:")) return <SquareCheckBig aria-hidden className={className} />;
  return <Bell aria-hidden className={className} />;
}

/** What holds the news cards' time: the pointer on the notices, the keys'
 *  focus in them, or the page hidden. The notices' toaster watches it from
 *  the document for as long as it is there, whatever cards it shows (a
 *  question alone too), so a card that comes later knows at once; each news
 *  card is told when it may have changed. */
const NOTICES = '[data-slot="notices"]';
const inNotices = (node: EventTarget | null) => typeof (node as Element | null)?.closest === "function" && (node as Element).closest(NOTICES) !== null;
let pointerOnNotices = false;
let focusInNotices = false;
const holdWatchers = new Set<() => void>();
const noticesHeld = () => pointerOnNotices || focusInNotices || document.hidden;
const holdMayHaveChanged = () => { for (const watcher of holdWatchers) watcher(); };
/** A browser need not say focus left a card taken away while it had it
 *  (Firefox does not): where it is now, once the card has gone. */
const focusAfterCardGone = () => {
  focusInNotices = inNotices(document.activeElement);
  holdMayHaveChanged();
};

function useWatchNotices() {
  useEffect(() => {
    const pointerTo = (on: boolean) => {
      if (on === pointerOnNotices) return;
      pointerOnNotices = on;
      holdMayHaveChanged();
    };
    const over = (event: PointerEvent) => pointerTo(inNotices(event.target));
    // Out of the window altogether.
    const out = (event: PointerEvent) => { if (event.relatedTarget === null) pointerTo(false); };
    const focusTo = (on: boolean) => {
      if (on === focusInNotices) return;
      focusInNotices = on;
      holdMayHaveChanged();
    };
    const focusIn = (event: FocusEvent) => focusTo(inNotices(event.target));
    // Where it goes: nothing (null) when focus leaves the page.
    const focusOut = (event: FocusEvent) => focusTo(inNotices(event.relatedTarget));
    focusInNotices = inNotices(document.activeElement);
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    document.addEventListener("visibilitychange", holdMayHaveChanged);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
      document.removeEventListener("visibilitychange", holdMayHaveChanged);
      pointerOnNotices = false;
      focusInNotices = false;
    };
  }, []);
}

/** A news card's own time: `lifeMs` on screen while the notices do not hold
 *  it, then `onExpire`; it goes on with the time it had left. sonner's own
 *  hold is not used: it lets go when its list changes down to one card,
 *  under a pointer that has not moved. Nor is its timer, which also runs
 *  for a card it keeps hidden behind the three it shows. */
function useLifetime(cardRef: RefObject<HTMLElement | null>, lifeMs: number | undefined, onExpire: (() => void) | undefined) {
  useEffect(() => {
    if (lifeMs === undefined || !onExpire) return;
    const toast = cardRef.current?.closest<HTMLElement>("[data-sonner-toast]") ?? null;
    const hiddenInStack = () => toast?.getAttribute("data-visible") === "false";
    let left = lifeMs;
    let since = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (noticesHeld() || hiddenInStack()) {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        left -= Date.now() - since;
      } else if (timer === undefined) {
        since = Date.now();
        timer = setTimeout(onExpire, Math.max(0, left));
      }
    };
    holdWatchers.add(update);
    const shownOrHidden = new MutationObserver(update);
    if (toast) shownOrHidden.observe(toast, { attributes: true, attributeFilter: ["data-visible"] });
    update();
    return () => {
      clearTimeout(timer);
      holdWatchers.delete(update);
      shownOrHidden.disconnect();
    };
  }, [cardRef, lifeMs, onExpire]);
}

/** One notice: what it is about, one line of it, Open and ×. Given a
 *  `lifeMs`, it goes by itself after that long (see useLifetime). */
export function NoticeCard({ event, onOpen, onDismiss, lifeMs, onExpire }: {
  event: NoticeEvent;
  onOpen: () => void;
  onDismiss: () => void;
  lifeMs?: number;
  onExpire?: () => void;
}) {
  const { lead, line } = noticeLines(event);
  const cardRef = useRef<HTMLDivElement>(null);
  useLifetime(cardRef, lifeMs, onExpire);
  // Run once the card's elements have left the page.
  useEffect(() => focusAfterCardGone, []);
  return (
    <div
      ref={cardRef}
      data-slot="notice-card"
      className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-popover py-2.5 pl-3 pr-2 text-popover-foreground shadow-lg"
    >
      <NoticeIcon matterKey={event.key} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-5">{lead}</p>
        {line && <p className="line-clamp-2 break-words text-[13px] leading-5 text-muted-foreground">{line}</p>}
      </div>
      <Button type="button" variant="outline" size="xs" className="mt-px shrink-0" onClick={onOpen}>Open</Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss" className="shrink-0 text-muted-foreground" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}

/** Top right, under the pane's header (52px); on a phone across the top. */
export function NoticeToaster() {
  const theme = useResolvedTheme();
  useWatchNotices();
  return (
    <div data-slot="notices" className="contents">
      <Sonner
        id={NOTICE_TOASTER_ID}
        theme={theme}
        position="top-right"
        offset={{ top: 60, right: 16 }}
        mobileOffset={{ top: 60, left: 12, right: 12 }}
        visibleToasts={3}
        containerAriaLabel="Notices"
        style={{ "--width": "380px" } as CSSProperties}
      />
    </div>
  );
}
