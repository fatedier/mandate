import { startTransition, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { TouchEvent, WheelEvent } from "react";
import { flushSync } from "react-dom";
import { errorText } from "@shared/error-text";
import { useOlderLoadsStore, type OlderLoad } from "@/store/older-loads";
import {
  AT_END_PX,
  distanceFromEnd,
  followAfterScroll,
  scrollTopAfterPrepend,
  shouldLoadOlder,
  type ScrollBox
} from "./transcript-scroll";

/** Writes an older page into the conversation. The page's owner (the store,
 *  or an archived worker's view) passes its write to this, and the viewport
 *  runs it between measuring the reader's place and restoring it, in one
 *  task: nothing is painted in between.
 *
 *  The owner's loadOlder, resolved, has either added older messages or
 *  reached the start (hasMoreOlder false); a page it cannot take, it rejects.
 *  Only the owner knows which happened, so the viewport never judges it: a
 *  load that resolved with neither would be asked for again. */
export type ApplyOlder = (write: () => void) => void;

/** Items rendered on mount before the rest is released. Roughly two
 *  screenfuls, so the reader can scroll a little before the full list
 *  arrives; grown before the first paint when they do not fill one. */
const INITIAL_RENDER_WINDOW = 24;
/** Message rows measured when an older page lands (see rowTops). */
const ANCHOR_ROWS = 8;

function boxOf(el: HTMLElement): ScrollBox {
  return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
}

/** Whether the content overflows a view that has a height: a hidden pane
 *  measures nothing, so its content does not count as filling it. */
function overflows(el: HTMLElement): boolean {
  return el.clientHeight > 0 && el.scrollHeight > el.clientHeight;
}

/** A row's top in content coordinates: where it is whatever the scroll. */
function contentTop(el: HTMLElement, node: Element): number {
  return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

/** The message rows from the first one the reader can see down, with their
 *  content tops: an older page landing is measured by how far they move.
 *  Several, as the first can be redrawn as another node by the page (a tool
 *  run the page boundary cut joins the steps before it); the first still
 *  drawn counts. Date dividers are not rows: the day's divider moves to its
 *  new first row. */
function rowTops(el: HTMLElement): Array<{ node: Element; top: number }> {
  const viewTop = el.getBoundingClientRect().top;
  const column = el.querySelector('[data-slot="transcript-column"]');
  const rows: Array<{ node: Element; top: number }> = [];
  for (const child of Array.from(column?.children ?? [])) {
    if (!child.matches('[data-slot="transcript-row"]')) continue;
    const rect = child.getBoundingClientRect();
    if (rect.bottom <= viewTop) continue;
    rows.push({ node: child, top: rect.top - viewTop + el.scrollTop });
    if (rows.length === ANCHOR_ROWS) break;
  }
  return rows;
}

/** The transcript showing each conversation now. A page on its way lands
 *  through it, whichever transcript asked for the page: the one that asked
 *  may have been closed and the conversation opened again meanwhile. A
 *  conversation no transcript shows takes its page as written. */
const shownTranscripts = new Map<string, ApplyOlder>();

/** Whether a box between the gesture's target and the scroller can scroll
 *  up itself (a capped tool output): the gesture is that box's, not the
 *  transcript's. A box that does not scroll always reads scrollTop 0. */
function innerScrollsUp(target: EventTarget, scroller: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
    if (node.scrollTop > 0) return true;
  }
  return false;
}

/** The transcript scroller: which rows are drawn, following the end, and
 *  older messages loading as the reader nears the top, the reader keeping
 *  their place as they land. The decisions are plain functions
 *  in transcript-scroll.ts; this reads the scroller and writes it.
 *
 *  Inserting content leaves scrollTop alone: the scroller has
 *  `overflow-anchor: none` (see ChatMessageList for why), so every place
 *  that grows the content above the reader restores their place by hand. */
export function useTranscriptViewport({
  threadId,
  itemCount,
  hasMoreOlder,
  loadOlder,
  followPaused,
  sentAt = null,
  growthKey
}: {
  threadId: string | null;
  /** Transcript items loaded: the render window counts them. */
  itemCount: number;
  hasMoreOlder: boolean;
  loadOlder: (apply: ApplyOlder) => Promise<void>;
  /** Holds following while true (a run open in the transcript, so what is
   *  open is not scrolled away). */
  followPaused: boolean;
  /** When the newest message the reader sent from this page was written
   *  (ISO time, null with none): a newer one takes them to the end, from
   *  wherever they were reading. */
  sentAt?: string | null;
  /** Changes whenever the end can have grown without the item count
   *  moving: a newest row in place of a trimmed oldest, a streaming reply,
   *  the working line, a voice line. */
  growthKey: string;
}) {
  const key = threadId ?? "";
  const scrollRef = useRef<HTMLDivElement>(null);
  // The box as last read or written here: each reading is taken against it
  // (followAfterScroll), and one that finds scrollTop where a write left it
  // is that write's echo, not the reader.
  const lastBoxRef = useRef<ScrollBox | null>(null);
  // The conversation the reader left the end of. Any other one follows, so
  // a conversation opened or switched to starts at its end.
  const detachedRef = useRef<string | null>(null);
  const openedRef = useRef<string | undefined>(undefined);
  const touchYRef = useRef<number | null>(null);
  // This commit's values, for code resuming after an await or inside a
  // write's commit. Set by the first layout effect, before any other runs.
  const live = useRef({ key, followPaused });
  // True while an older page is written: the layout inside that commit is
  // half done (the top slot gone, the browser clamping scrollTop to a shorter
  // end) and decides nothing; the page's own reading before it does.
  const writingOlderRef = useRef(false);

  const [detached, setDetached] = useState<string | null>(null);
  const [endHidden, setEndHidden] = useState(false);
  const [windowState, setWindowState] = useState({ thread: key, size: INITIAL_RENDER_WINDOW });
  // Each conversation's older load, kept with the conversation (see the store).
  const olderLoad = useOlderLoadsStore((state) => state.byThread.get(key));
  // A first page that does not fill the pane, with older messages to come,
  // is kept out of sight until older pages fill it or the start is reached:
  // shown at once, its rows sat near the top and jumped to the
  // bottom when the older page landed. Per conversation.
  const [filledThread, setFilledThread] = useState<string | null>(null);

  const renderWindow = windowState.thread === key ? windowState.size : INITIAL_RENDER_WINDOW;
  const windowed = itemCount > renderWindow;
  const olderError = olderLoad?.status === "failed" ? olderLoad.error : null;
  const filling = filledThread !== key && hasMoreOlder && olderError === null;
  const following = detached !== key;

  useLayoutEffect(() => {
    live.current = { key, followPaused };
  });

  const isFollowing = () => detachedRef.current !== live.current.key;
  const follow = (next: boolean) => {
    const id = next ? null : live.current.key;
    detachedRef.current = id;
    setDetached(id);
  };
  const noteEnd = (el: HTMLElement) => setEndHidden(distanceFromEnd(boxOf(el)) > AT_END_PX);
  const pin = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    lastBoxRef.current = boxOf(el);
    setEndHidden(false);
  };
  /** Reads the scroller as its scroll event will, and decides following by
   *  it. Every decision reads it first: a scroll's event comes with the next
   *  frame, and a commit or a page landing before then must not take a
   *  reader who just scrolled up for one still following. */
  const readScroll = (el: HTMLElement): ScrollBox => {
    const before = lastBoxRef.current;
    const now = boxOf(el);
    // A hidden scroller (its pane hidden while mounted) reads all zeros: that
    // is no scroll, and least of all the reader reaching the end. The box
    // before it is kept for when it is shown again.
    if (now.client === 0 || writingOlderRef.current) return now;
    lastBoxRef.current = now;
    follow(followAfterScroll(isFollowing(), before, now));
    return now;
  };
  // The reader's own send takes them to the end, whether they were following
  // or had scrolled up to read: what they sent, and the answer to it, are
  // what they look for next. Once, at the send: an open run still holds what
  // follows after it.
  // The newest send seen: only a newer one moves the reader (a message
  // settling into the transcript leaves an older one, or none). One clock
  // writes them all, so it holds across conversations too.
  const sentRef = useRef(sentAt);
  const onSent = useEffectEvent(() => {
    const seen = sentRef.current;
    if (sentAt === null || (seen !== null && sentAt <= seen)) return;
    sentRef.current = sentAt;
    follow(true);
    const el = scrollRef.current;
    if (el) pin(el);
  });
  useLayoutEffect(() => { onSent(); }, [sentAt]);
  const loadOf = (id: string) => useOlderLoadsStore.getState().byThread.get(id);
  const setLoad = (id: string, load: OlderLoad | null) => useOlderLoadsStore.getState().set(id, load);

  // The window counts items, and a stretch of tool-only steps folds into one
  // run line, so 24 items can be two rows that do not fill the screen.
  // Painted like that, they sit at the top and jump to the bottom when the
  // rest is released. So before the first paint (a layout effect's update
  // renders synchronously) the window doubles until the transcript overflows
  // or holds everything. A box with no height is left to the release.
  useLayoutEffect(() => {
    if (!windowed) return;
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0 || el.scrollHeight > el.clientHeight) return;
    setWindowState({ thread: key, size: renderWindow * 2 });
  }, [windowed, key, renderWindow, itemCount]);

  // Mounting a long transcript in one pass was ~80ms of reconciliation, enough
  // to eat the dock's open animation, and all but the last screenful is out
  // of sight. So a window is drawn first and the rest released once the
  // browser has painted: two frames, one to paint, one to be sure it landed,
  // then at low priority. (content-visibility measured as a no-op: the cost
  // is reconciliation, not layout or paint.)
  useEffect(() => {
    if (!windowed) return;
    const id = key;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => startTransition(() => setWindowState({ thread: id, size: Number.POSITIVE_INFINITY })));
    });
    return () => cancelAnimationFrame(raf);
  }, [windowed, key]);

  // A conversation's first content opens at its end. After that, each commit
  // that can have grown the transcript keeps a following reader at the end,
  // before the paint: a new message, the window opening (its rows go ABOVE
  // the ones on screen, which would leave scrollTop pointing into older
  // messages), a streaming reply, a run closing. A paused or departed reader
  // is left where they are, and told when the end is out of sight.
  const onGrowth = useEffectEvent(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (openedRef.current !== key && itemCount > 0) {
      openedRef.current = key;
      follow(true);
      pin(el);
      return;
    }
    readScroll(el);
    if (isFollowing() && !followPaused) pin(el);
    else noteEnd(el);
  });
  useLayoutEffect(() => {
    onGrowth();
  }, [key, itemCount, renderWindow, growthKey, followPaused]);

  useLayoutEffect(() => {
    if (!filling) return;
    const el = scrollRef.current;
    if (el && overflows(el)) setFilledThread(key);
  }, [filling, key, itemCount, renderWindow, growthKey]);

  // Wraps an older page's write (see ApplyOlder): the reader's place is
  // measured right before the rows land and restored right after, with the
  // window released in the same commit so every row lands at once. Inserted
  // a commit or two apart, they moved the reader by the rows still to come.
  const applyOlder = useEffectEvent((write: () => void) => {
    const el = scrollRef.current;
    // Hidden, nothing in it can be measured, nor kept in place.
    if (!el || el.clientHeight === 0) {
      write();
      return;
    }
    const id = key;
    const before = readScroll(el);
    const rows = rowTops(el);
    writingOlderRef.current = true;
    try {
      flushSync(() => {
        setWindowState((current) => (current.thread === id && current.size === Number.POSITIVE_INFINITY
          ? current
          : { thread: id, size: Number.POSITIVE_INFINITY }));
        write();
      });
    } finally {
      writingOlderRef.current = false;
    }
    if (isFollowing() && !live.current.followPaused) {
      pin(el);
      return;
    }
    const row = rows.find((r) => r.node.isConnected);
    el.scrollTop = scrollTopAfterPrepend(
      { top: before.top, height: before.height, anchorTop: row?.top ?? null },
      { height: el.scrollHeight, anchorTop: row ? contentTop(el, row.node) : null }
    );
    lastBoxRef.current = boxOf(el);
    noteEnd(el);
  });
  useLayoutEffect(() => {
    if (!threadId) return;
    const transcript: ApplyOlder = (write) => applyOlder(write);
    shownTranscripts.set(threadId, transcript);
    return () => {
      if (shownTranscripts.get(threadId) === transcript) shownTranscripts.delete(threadId);
    };
  }, [threadId]);

  const runLoad = async (id: string) => {
    setLoad(id, { status: "loading" });
    try {
      await loadOlder((write) => {
        const shown = shownTranscripts.get(id);
        if (shown) shown(write);
        else write();
      });
      setLoad(id, null);
    } catch (err) {
      setLoad(id, { status: "failed", error: errorText(err) });
    }
  };

  // Older messages load as the reader scrolls within a screen of the top, or
  // when what is loaded does not fill the pane: a "Load 50
  // older" button asked of the reader what no chat does. One at a time per
  // conversation; after a failure only Retry asks again.
  const maybeLoadOlder = () => {
    const el = scrollRef.current;
    if (!el || !threadId) return;
    const load = loadOf(threadId);
    const ask = shouldLoadOlder(boxOf(el), {
      hasMore: hasMoreOlder,
      failed: load?.status === "failed",
      loading: load?.status === "loading",
      windowed
    });
    if (ask) void runLoad(threadId);
  };

  const retryOlder = () => {
    if (!threadId || loadOf(threadId)?.status !== "failed") return;
    void runLoad(threadId);
  };

  // After every commit: a page that does not fill the pane, or a reader
  // still within a screen of the top when a page lands, reads on.
  useEffect(() => {
    maybeLoadOlder();
  });

  // Growth no commit announces: the scroller's own box (a pane resize, the
  // phone keyboard), and each row's (the markdown renderer reflowing a reply,
  // an image, a streaming delta inside a row). A following reader is pinned
  // on the next frame; content that now fills the pane is shown; content
  // that no longer does reads on.
  const onResize = useEffectEvent((): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    if (overflows(el)) setFilledThread((current) => (current === key ? current : key));
    readScroll(el);
    maybeLoadOlder();
    if (isFollowing() && !followPaused) return true;
    noteEnd(el);
    return false;
  });
  const onPinFrame = useEffectEvent(() => {
    const el = scrollRef.current;
    if (!el) return;
    readScroll(el);
    if (isFollowing() && !followPaused) pin(el);
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf: number | null = null;
    const keepPinned = () => {
      // Cancel before deciding: a pin queued by an earlier event must not
      // survive one after which the reader no longer follows.
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      if (!onResize()) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        onPinFrame();
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepPinned);
    observer?.observe(el);
    // The scroller's own box does not change when the transcript grows, so
    // each row is watched too. The rows live in the centring column; childList
    // only, so a delta inside a row costs nothing here (that row's box has it).
    const contentObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepPinned);
    const column = el.querySelector('[data-slot="transcript-column"]') ?? el;
    const observeRows = () => {
      if (!contentObserver) return;
      contentObserver.disconnect();
      for (const row of column.children) contentObserver.observe(row);
    };
    observeRows();
    // A row leaving is a change of the content's height that nothing else
    // reports: its own box is gone, and the list's growth effect runs only for
    // what the list knows changed. The working line leaves by itself when the
    // reply starts (it returns nothing while the text moves); the content gets
    // shorter and the browser pulls scrollTop back with it. Unread, that was
    // taken for the reader scrolling up as soon as the reply's row made the
    // content taller again: following stopped, 35px short of the end, on any
    // reply that came in one piece. So the scroller is read when
    // the rows change, before the next commit can grow them.
    const rowsChanged = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      observeRows();
      keepPinned();
    });
    rowsChanged?.observe(column, { childList: true });
    const vv = window.visualViewport;
    vv?.addEventListener("resize", keepPinned);
    vv?.addEventListener("scroll", keepPinned);
    return () => {
      observer?.disconnect();
      contentObserver?.disconnect();
      rowsChanged?.disconnect();
      vv?.removeEventListener("resize", keepPinned);
      vv?.removeEventListener("scroll", keepPinned);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    readScroll(el);
    noteEnd(el);
    maybeLoadOlder();
  };

  // A scroll up by wheel or finger stops following at once, before its
  // scroll event: a streaming reply pins the end between those, and would
  // take back a scroll smaller than DETACH_PX each time.
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || event.deltaY >= 0 || el.scrollHeight <= el.clientHeight || innerScrollsUp(event.target, el)) return;
    follow(false);
  };
  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchYRef.current = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    const y = event.touches[0]?.clientY;
    const from = touchYRef.current;
    if (!el || y === undefined || from === null) return;
    touchYRef.current = y;
    // The finger moving down scrolls the transcript up.
    if (y > from && el.scrollHeight > el.clientHeight && !innerScrollsUp(event.target, el)) follow(false);
  };

  const scrollToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    follow(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return {
    scrollRef,
    onScroll,
    onWheel,
    onTouchStart,
    onTouchMove,
    renderWindow,
    /** Offer the way to the latest: the reader left the end, or a pause
     *  holds them while the end grew out of sight. */
    showLatest: !following || (followPaused && endHidden),
    scrollToLatest,
    loadingOlder: olderLoad?.status === "loading",
    olderError,
    retryOlder,
    filling
  };
}
