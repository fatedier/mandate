import { afterEach, expect, test } from "bun:test";
import { act, Activity, useState } from "react";
import { useTranscriptViewport, type TranscriptPlace } from "@/routes/window/chat/useTranscriptViewport";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "@/store/agent-chat";
import { mount, mountAsync, settle } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";

afterEach(() => {
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const ROW = 100;
const VIEW = 500;

/** The test DOM has no layout: every transcript row is 100px tall, stacked
 *  in its column, and each scroller shows 500px of it. */
function layout() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
  const scrollerOf = (el: Element) => el.closest<HTMLElement>("[data-scroller]");
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-scroller")) return { top: 0, bottom: VIEW, left: 0, right: 600, height: VIEW, width: 600, x: 0, y: 0 } as DOMRect;
    if (this.matches('[data-slot="transcript-row"]')) {
      const rows = [...(this.parentElement?.children ?? [])].filter((r) => r.matches('[data-slot="transcript-row"]'));
      const top = rows.indexOf(this) * ROW - (scrollerOf(this)?.scrollTop ?? 0);
      return { top, bottom: top + ROW, left: 0, right: 600, height: ROW, width: 600, x: 0, y: top } as DOMRect;
    }
    return { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0, x: 0, y: 0 } as DOMRect;
  };
  // A scroller's scrollTo moves it at once, as a smooth scroll ends, and says so.
  const hadScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  proto.scrollTo = function (this: HTMLElement, to?: ScrollToOptions | number, y?: number) {
    if (!this.hasAttribute("data-scroller")) return;
    this.scrollTop = typeof to === "number" ? (y ?? 0) : (to?.top ?? this.scrollTop);
    this.dispatchEvent(new window.Event("scroll"));
  };
  // A scroller (marked data-scroller) holds its rows' height and shows 500px of it.
  const sizes: Array<[string, (el: HTMLElement) => number]> = [
    ["scrollHeight", (el) => el.querySelectorAll('[data-slot="transcript-row"]').length * ROW],
    ["clientHeight", () => VIEW]
  ];
  const kept = sizes.map(([name]) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
  for (const [name, size] of sizes) {
    const base = Object.getOwnPropertyDescriptor(Element.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute("data-scroller") ? size(this) : base?.get?.call(this); }
    });
  }
  onCleanup(() => {
    if (had) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", had);
    else delete proto.getBoundingClientRect;
    if (hadScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", hadScrollTo);
    else delete proto.scrollTo;
    for (const [name, descriptor] of kept) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });
}
/** Marks a scroller the layout shim sizes. */
function sized(scroller: HTMLElement) {
  scroller.setAttribute("data-scroller", "");
}

function View({ id, rows, startAt, onPlace, loadOlder, more = false }: {
  id: string; rows: string[]; startAt?: TranscriptPlace | null; onPlace?: (p: TranscriptPlace | null) => void; loadOlder?: Parameters<typeof useTranscriptViewport>[0]["loadOlder"]; more?: boolean;
}) {
  const { scrollRef, onScroll, onWheel } = useTranscriptViewport({
    threadId: "thr_g", itemCount: rows.length, hasMoreOlder: more, loadOlder: loadOlder ?? (async () => {}), followPaused: false,
    growthKey: rows.at(-1) ?? "", startAt: startAt ?? null, onPlace
  });
  return (
    <div ref={scrollRef} data-scroller="" data-view={id} onScroll={onScroll} onWheel={onWheel}>
      <div data-slot="transcript-column">
        {rows.map((r) => <div key={r} data-slot="transcript-row" data-row-key={r}>{r}</div>)}
      </div>
    </div>
  );
}
const rowsOf = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `m${i + from}`);
const scroller = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-view="${id}"]`)!;
const readUp = (el: HTMLElement, top: number) => act(() => {
  el.scrollTop = top;
  el.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -300, bubbles: true }));
  el.dispatchEvent(new window.Event("scroll", { bubbles: true }));
});

test("History opened at a place shows that message at its top, scrolled up", () => {
  layout();
  const { host } = mount(<View id="h" rows={rowsOf(10)} startAt={{ messageId: "m4", offset: 0 }} />);
  expect(scroller(host, "h").scrollTop).toBe(300);
  // Opened with no place: at the end.
  const other = mount(<View id="h2" rows={rowsOf(10)} />);
  expect(scroller(other.host, "h2").scrollTop).toBe(1000);
});

/** A transcript that draws only its render window, as the chat's list does. */
function Windowed({ rows, startAt }: { rows: string[]; startAt: TranscriptPlace }) {
  const { scrollRef, onScroll, onWheel, renderWindow } = useTranscriptViewport({
    threadId: "thr_g", itemCount: rows.length, hasMoreOlder: false, loadOlder: async () => {}, followPaused: false,
    growthKey: rows.at(-1) ?? "", startAt
  });
  const drawn = Number.isFinite(renderWindow) ? rows.slice(-renderWindow) : rows;
  return (
    <div ref={scrollRef} data-scroller="" data-view="w" onScroll={onScroll} onWheel={onWheel}>
      <div data-slot="transcript-column">
        {drawn.map((r) => <div key={r} data-slot="transcript-row" data-row-key={r}>{r}</div>)}
      </div>
    </div>
  );
}

test("a place in a long conversation holds once all of it is drawn", async () => {
  layout();
  const { host } = mount(<Windowed rows={rowsOf(60)} startAt={{ messageId: "m45", offset: 0 }} />);
  await act(async () => { await settle(60); });
  const el = scroller(host, "w");
  expect(el.querySelectorAll('[data-slot="transcript-row"]').length).toBe(60);
  expect(el.scrollTop).toBe(44 * ROW);
});

test("the place is reported as the reader scrolls: the row at the top, and nothing at the end", () => {
  layout();
  const places: Array<TranscriptPlace | null> = [];
  const { host } = mount(<View id="h" rows={rowsOf(10)} onPlace={(p) => places.push(p)} />);
  readUp(scroller(host, "h"), 250);
  expect(places.at(-1)).toStrictEqual({ messageId: "m3", offset: -50 });
  act(() => {
    const el = scroller(host, "h");
    el.scrollTop = 1000 - VIEW;
    el.dispatchEvent(new window.Event("scroll", { bubbles: true }));
  });
  expect(places.at(-1)).toBeNull();
});

test("both views keep their places when an older page lands", async () => {
  layout();
  let loads = 0;
  let land: (() => void) | null = null;
  function Two() {
    const [rows, setRows] = useState(rowsOf(10, 11));
    const [more, setMore] = useState(true);
    // One older page of five rows, held until both readers are in place, then the start.
    const loadOlder = (a: (write: () => void) => void) => new Promise<void>((resolve) => {
      loads += 1;
      land = () => { a(() => { setRows((r) => [...rowsOf(5, 6), ...r]); setMore(false); }); resolve(); };
    });
    return <><View id="chat" rows={rows} loadOlder={loadOlder} more={more} /><View id="history" rows={rows} loadOlder={loadOlder} more={more} /></>;
  }
  const { host } = mount(<Two />);
  readUp(scroller(host, "chat"), 300);
  readUp(scroller(host, "history"), 0);
  expect(loads).toBe(1);
  await act(async () => { land!(); await settle(10); });
  // Five rows of 100px landed above: each view shows the row it showed.
  expect([scroller(host, "chat").scrollTop, scroller(host, "history").scrollTop]).toEqual([800, 500]);
});

const at = "2026-11-04T09:00:00.000Z";
const msg = (seq: number, m: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage =>
  ({ id: `m${seq}`, threadId: "thr_g", seq, source: m.role === "user" ? "user" : "self", sourceThreadId: null, wakeId: m.role === "assistant" ? `w${seq}` : null, createdAt: at, ...m }) as AgentMessage;
const conversation = (n: number) => Array.from({ length: n }, (_, i) => i % 2 === 0
  ? msg(i + 1, { role: "user", content: { type: "text", text: `Question ${i + 1}` } })
  : msg(i + 1, { role: "assistant", content: { type: "assistant", text: `Answer ${i + 1}` } }));
const threadOf = (messages: AgentMessage[], patch: Partial<ThreadState> = {}): ThreadState =>
  ({ ...newThreadState(), threadId: "thr_g", loaded: true, messages, oldestSeqLoaded: 1, ...patch });

type Take = (() => TranscriptPlace | null) | null;
function Lists({ thread, offerReadBeside }: { thread: ThreadState; offerReadBeside?: (take: Take) => void }) {
  return (
    <>
      <div data-list="chat"><ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} {...(offerReadBeside ? { offerReadBeside } : {})} /></div>
      <div data-list="history"><ChatMessageList thread={thread} view="history" onLoadOlder={async () => {}} /></div>
    </>
  );
}
const listScroller = (host: HTMLElement, list: string) => {
  const el = host.querySelector<HTMLElement>(`[data-list="${list}"] [data-slot="transcript-column"]`)!.parentElement!;
  if (!el.hasAttribute("data-scroller")) sized(el);
  return el;
};

test("a send in the chat does not move History; the chat goes to its end", async () => {
  layout();
  const messages = conversation(12);
  const view = await mountAsync(<Lists thread={threadOf(messages)} />);
  await settle(30);
  const chat = listScroller(view.host, "chat");
  const history = listScroller(view.host, "history");
  readUp(chat, 200);
  readUp(history, 300);
  const pending = new Map([["local_1", { localId: "local_1", content: "One more thing", status: "sending", createdAt: "2026-11-04T09:30:00.000Z" }]]);
  await act(async () => { view.rerender(<Lists thread={threadOf(messages, { pendingUserMessages: pending as never })} />); });
  expect(history.scrollTop).toBe(300);
  expect(chat.scrollTop).toBe(chat.scrollHeight);
});

test("a reply streaming in the chat does not move History scrolled up; the chat follows it", async () => {
  layout();
  const messages = conversation(12);
  const streaming = (text: string) => threadOf(messages, { streamingAssistant: { wakeId: "w13", totalText: text }, wakePhase: { wakeId: "w13", phase: "thinking" } });
  const view = await mountAsync(<Lists thread={streaming("The release")} />);
  await settle(30);
  const chat = listScroller(view.host, "chat");
  const history = listScroller(view.host, "history");
  readUp(history, 300);
  const end = chat.scrollHeight;
  await act(async () => { view.rerender(<Lists thread={threadOf([...messages, msg(13, { role: "assistant", content: { type: "assistant", text: "The release notes are done." } })])} />); });
  await settle(10);
  expect(history.scrollTop).toBe(300);
  expect(chat.scrollHeight).toBeGreaterThan(end - 1);
  expect(chat.scrollTop).toBe(chat.scrollHeight);
});

test("scrolled up, the chat hands over the row at its top and goes back to its end; at its end it hands over nothing", async () => {
  layout();
  let take: Take = null;
  const view = await mountAsync(<Lists thread={threadOf(conversation(12))} offerReadBeside={(t) => { take = t; }} />);
  await settle(30);
  const chat = listScroller(view.host, "chat");
  // At its end: nothing to read beside, and the chat stays.
  expect(take!()).toBeNull();
  readUp(chat, 300);
  // Nothing floats over what is being read but the way to the latest.
  expect(view.host.querySelector('[data-slot="read-beside"]') === null).toBe(true);
  expect(view.host.querySelector('[aria-label="Scroll to latest message"]') !== null).toBe(true);
  const row = chat.querySelectorAll('[data-slot="transcript-row"]')[3]!.getAttribute("data-row-key");
  let place: TranscriptPlace | null = null;
  act(() => { place = take!(); });
  expect(place!.messageId).toBe(row ?? "missing");
  expect(chat.scrollTop).toBe(chat.scrollHeight);
  // Unmounted, it offers nothing.
  view.unmount();
  expect(take).toBeNull();
});

// The page keeps a conversation's newest 500 messages, dropping the oldest as
// new ones come. Dropped above a reader who scrolled up, they moved what the
// reader was reading by a row each time (the scroller does not anchor).
test("scrolled up in the chat, no loaded message is dropped as new ones come; back at its end, the oldest go again", async () => {
  layout();
  const key = "manager:thr_g";
  const many = Array.from({ length: 500 }, (_, i) => msg(i + 1, { role: "user", content: { type: "text", text: `Note ${i + 1}` } }));
  useAgentChatStore.setState({ threadsByScope: new Map([[key, threadOf(many)]]) });
  function Live() {
    const thread = useAgentChatStore((s) => s.threadsByScope.get(key)!);
    return <div data-list="chat"><ChatMessageList thread={thread} holdKey={key} onLoadOlder={async () => {}} /></div>;
  }
  const view = await mountAsync(<Live />);
  await settle(30);
  const chat = listScroller(view.host, "chat");
  const loaded = () => useAgentChatStore.getState().threadsByScope.get(key)!.messages.length;
  const append = (seq: number) => act(() => { useAgentChatStore.getState().onMessageAppended("thr_g", msg(seq, { role: "user", content: { type: "text", text: `Note ${seq}` } })); });
  readUp(chat, 20_000);
  append(501);
  append(502);
  expect([loaded(), chat.querySelector('[data-row-key="m1"]') !== null]).toEqual([502, true]);
  // Back at the end: the next message trims to the newest 500 (the hold
  // goes once that commit is over).
  await act(async () => { view.host.querySelector<HTMLElement>('[aria-label="Scroll to latest message"]')!.click(); await Promise.resolve(); });
  append(503);
  expect(loaded()).toBe(500);
  // Unmounted, nothing is held (let go once the commit is over).
  readUp(chat, 20_000);
  view.unmount();
  await act(async () => { await Promise.resolve(); });
  expect(useAgentChatStore.getState().wholeHeld.has(key)).toBe(false);
});

// Hidden in a page kept while another shows (shell/KeptPage), a reader who
// scrolled up keeps the rows they were reading: messages that come meanwhile
// trim nothing above them.
test("scrolled up in a page that is then hidden, no loaded message is dropped until it shows again at the end", async () => {
  layout();
  const key = "manager:thr_g";
  const many = Array.from({ length: 500 }, (_, i) => msg(i + 1, { role: "user", content: { type: "text", text: `Note ${i + 1}` } }));
  useAgentChatStore.setState({ threadsByScope: new Map([[key, threadOf(many)]]) });
  function Live() {
    const thread = useAgentChatStore((s) => s.threadsByScope.get(key)!);
    return <div data-list="chat"><ChatMessageList thread={thread} holdKey={key} onLoadOlder={async () => {}} /></div>;
  }
  const view = await mountAsync(<Activity mode="visible"><Live /></Activity>);
  await settle(30);
  const chat = listScroller(view.host, "chat");
  const loaded = () => useAgentChatStore.getState().threadsByScope.get(key)!.messages.length;
  const append = (seq: number) => act(() => { useAgentChatStore.getState().onMessageAppended("thr_g", msg(seq, { role: "user", content: { type: "text", text: `Note ${seq}` } })); });
  readUp(chat, 20_000);
  await act(async () => { view.rerender(<Activity mode="hidden"><Live /></Activity>); await Promise.resolve(); });
  append(501);
  append(502);
  expect([loaded(), chat.querySelector('[data-row-key="m1"]') !== null]).toEqual([502, true]);
  // Shown again, still where the reader was: held as before.
  await act(async () => { view.rerender(<Activity mode="visible"><Live /></Activity>); await Promise.resolve(); });
  append(503);
  expect(loaded()).toBe(503);
  expect(useAgentChatStore.getState().wholeHeld.get(key)).toBe(1);
  view.unmount();
  await act(async () => { await Promise.resolve(); });
  expect(useAgentChatStore.getState().wholeHeld.has(key)).toBe(false);
});

test("no trimming while History holds the conversation; trimming again once it lets go", () => {
  const key = "personal:thr_g";
  const many = conversation(520).map((m) => ({ ...m, role: "user" as const, content: { type: "text" as const, text: "x" } }));
  useAgentChatStore.setState({ threadsByScope: new Map([[key, threadOf(many)]]) });
  const release = useAgentChatStore.getState().holdWhole(key);
  const append = (seq: number) => useAgentChatStore.getState().onMessageAppended("thr_g", msg(seq, { role: "user", content: { type: "text", text: "new" } }));
  append(521);
  expect(useAgentChatStore.getState().threadsByScope.get(key)!.messages.length).toBe(521);
  release();
  append(522);
  expect(useAgentChatStore.getState().threadsByScope.get(key)!.messages.length).toBe(500);
});

// Another list may fold the notices differently (History opens with its runs
// closed, and no New line to cut them): a place on a notice that list folds
// away opens at the row holding it.
function Held({ startAt }: { startAt: TranscriptPlace }) {
  const rows: Array<{ key: string; holds?: string[] }> = [{ key: "m1" }, { key: "m2" }, { key: "m5", holds: ["m3", "m4", "m5"] }, ...rowsOf(5, 6).map((key) => ({ key }))];
  const { scrollRef, onScroll } = useTranscriptViewport({
    threadId: "thr_g", itemCount: rows.length, hasMoreOlder: false, loadOlder: async () => {}, followPaused: false,
    growthKey: rows.at(-1)!.key, startAt
  });
  return (
    <div ref={scrollRef} data-scroller="" data-view="held" onScroll={onScroll}>
      <div data-slot="transcript-column">
        {rows.map((r) => <div key={r.key} data-slot="transcript-row" data-row-key={r.key} {...(r.holds ? { "data-row-holds": r.holds.join(" ") } : {})}>{r.key}</div>)}
      </div>
    </div>
  );
}

test("a place on a message another list folds into a row opens at that row", () => {
  layout();
  const { host } = mount(<Held startAt={{ messageId: "m3", offset: 0 }} />);
  expect(scroller(host, "held").scrollTop).toBe(200);
});
