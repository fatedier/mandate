import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import type { ApplyOlder } from "@/routes/window/chat/useTranscriptViewport";
import { newThreadState, useAgentChatStore, type AgentChatScope } from "@/store/agent-chat";
import { useOlderLoadsStore } from "@/store/older-loads";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { agentMessage } from "../helpers/typed.js";

afterEach(() => {
  // Unmount before the store the conversation reads is reset under it.
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  useOlderLoadsStore.setState({ byThread: new Map() });
});

// Each test names its own feature or thread: the store's in-flight loads are
// module state, and a load one test leaves hanging must not answer another's.
const page = (threadId: string, messages = [agentMessage({ threadId, content: { type: "text", text: "Draft the notes" } })]) =>
  ({ thread: { id: threadId }, messages, hasMore: false, contextUsage: null, activeWake: null, readAt: null });

async function render(scope: AgentChatScope) {
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={scope} /></MemoryRouter>);
  await settle();
  return host;
}
const has = (host: ParentNode, selector: string) => host.querySelector(selector) !== null;
const retryIn = (el: Element) => [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;

test("while the first page is on its way, one still Loading… line: no spinner", async () => {
  mockFetch(() => new Promise<Response>(() => {}));
  const host = await render({ type: "worker", featureId: "feat_loading" });
  expect(host.querySelector('[data-slot="loading-line"]')!.textContent).toBe("Loading…");
  expect(has(host, ".animate-spin")).toBe(false);
});

test("a worker's first page that fails is the inline error, not a spinner forever; Retry reads it again", async () => {
  let calls = 0;
  mockFetch(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({ error: "database is locked" }, 500) : jsonResponse(page("t_w1"));
  });
  const host = await render({ type: "worker", featureId: "feat_w1" });
  const failed = host.querySelector('[data-slot="inline-error"]')!;
  expect(failed.textContent).toContain("Couldn't load the conversation.");
  expect(failed.querySelector("p")!.textContent).toBe("database is locked");
  expect(has(host, '[data-slot="loading-line"]')).toBe(false);
  expect(has(host, ".animate-spin")).toBe(false);
  await act(async () => { retryIn(failed).click(); });
  await settle();
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(host.textContent).toContain("Draft the notes");
});

test("a manager thread's first page that fails is the inline error, never \"No messages yet\"", async () => {
  mockFetch(() => jsonResponse({ error: "database is locked" }, 500));
  const host = await render({ type: "manager", threadId: "t_m1" });
  expect(host.querySelector('[data-slot="inline-error"]')!.textContent).toContain("Couldn't load the conversation.");
  expect(host.textContent).not.toContain("No messages yet");
});

test("an empty manager thread says what the agent can do, without the worker's \"this feature\" example", async () => {
  mockFetch(() => jsonResponse(page("t_m2", [])));
  const host = await render({ type: "manager", threadId: "t_m2" });
  expect(host.textContent).toContain("No messages yet");
  expect(host.textContent).toContain("The agent has access to bash, file editing, and your tmux panes.");
  expect(host.textContent).not.toContain("this feature");
});

test("an empty worker chat keeps its example", async () => {
  mockFetch(() => jsonResponse(page("t_w2", [])));
  const host = await render({ type: "worker", featureId: "feat_w2" });
  expect(host.textContent).toContain("No messages yet");
  expect(host.textContent).toContain("what's running in your panes right now?");
});

// Older messages load as the reader scrolls near the top: there
// was a "Load 50 older" button to press, which no chat asks of a reader.
// happy-dom lays nothing out: the scroller is given heights by hand, and a
// scroll is its scrollTop set and a scroll event sent. A page lands as the
// store's does, its write run through the `apply` the list passed.
type Thread = ReturnType<typeof olderThread>;
function olderThread(threadId: string, text = "Draft the notes") {
  return {
    ...newThreadState(), threadId, loaded: true, hasMoreOlder: true, oldestSeqLoaded: 100 as number | null,
    messages: [agentMessage({ id: `${threadId}-latest`, threadId, seq: 100, content: { type: "text", text } })]
  };
}
/** The thread with one older message landed above (and, with `hasMore`
 *  false, the start reached). */
function withOlder(thread: Thread, hasMore = true): Thread {
  const seq = (thread.oldestSeqLoaded ?? 100) - 1;
  const older = agentMessage({ id: `${thread.threadId}-older-${seq}`, threadId: thread.threadId, seq, content: { type: "text", text: `Earlier ${seq}` } });
  return { ...thread, messages: [older, ...thread.messages], oldestSeqLoaded: seq, hasMoreOlder: hasMore };
}
function withNewer(thread: Thread, text = "New"): Thread {
  const seq = (thread.messages.at(-1)?.seq ?? 100) + 1;
  return { ...thread, messages: [...thread.messages, agentMessage({ id: `${thread.threadId}-newer-${seq}`, threadId: thread.threadId, seq, content: { type: "text", text } })] };
}
function sized(host: HTMLElement, size: { content: number; view?: number; hidden?: boolean }) {
  const scroller = host.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
  const view = () => size.view ?? 500;
  const max = () => Math.max(0, size.content - view());
  let top = scroller.scrollTop;
  // A hidden scroller (display: none) reads all zeros and takes no scroll,
  // and keeps its place for when it is shown again, as in Chromium.
  Object.defineProperty(scroller, "scrollHeight", { get: () => (size.hidden ? 0 : size.content), configurable: true });
  Object.defineProperty(scroller, "clientHeight", { get: () => (size.hidden ? 0 : view()), configurable: true });
  // As in a browser, scrollTop stays within the content: set past the end it
  // stops there, and content shrinking under it pulls it back.
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => (size.hidden ? 0 : (top = Math.min(top, max()))),
    set: (value: number) => { if (!size.hidden) top = Math.max(0, Math.min(value, max())); }
  });
  return scroller;
}
const fromEnd = (scroller: HTMLElement) => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
async function scrollTo(scroller: HTMLElement, top: number) {
  await act(async () => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new window.Event("scroll"));
  });
}
/** The scroller given heights, then scrolled to its end, as a conversation
 *  opens in a browser. */
async function openAtEnd(host: HTMLElement, size: { content: number; view?: number }) {
  const scroller = sized(host, size);
  await scrollTo(scroller, size.content - (size.view ?? 500));
  return scroller;
}
/** onLoadOlder answered by the test, oldest request first: `land(write)` runs
 *  the page's write through `apply`, as the store does, and `land()` answers
 *  with nothing written; `fail` rejects. */
function heldOlder() {
  const open: Array<{ apply: ApplyOlder; resolve: () => void; reject: (err: Error) => void }> = [];
  let calls = 0;
  return {
    get calls() { return calls; },
    onLoadOlder: (apply: ApplyOlder) => {
      calls += 1;
      return new Promise<void>((resolve, reject) => { open.push({ apply, resolve, reject }); });
    },
    land: async (write?: () => void) => {
      const request = open.shift()!;
      await act(async () => {
        if (write) request.apply(write);
        request.resolve();
      });
      await settle();
    },
    fail: async (message: string) => {
      const request = open.shift()!;
      await act(async () => { request.reject(new Error(message)); });
      await settle();
    }
  };
}
const olderButton = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => /older/i.test(b.textContent ?? ""));
const latestButton = (host: HTMLElement) => host.querySelector('[aria-label="Scroll to latest message"]');
/** Runs `body` with the scroller's heights given on the prototype, so they
 *  hold from its first layout (a held first page is decided before paint). */
async function withScrollerHeights(size: { content: number; view?: number }, body: () => Promise<void>) {
  const proto = window.HTMLElement.prototype;
  const own = (el: HTMLElement) => el.className.includes("overflow-y-auto");
  const saved = { scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight"), clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight") };
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) { return own(this) ? size.content : 0; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: HTMLElement) { return own(this) ? size.view ?? 500 : 0; } });
  try {
    await body();
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  }
}

test("scrolling within a screen of the top loads older messages, once at a time; farther down it does not", async () => {
  const older = heldOlder();
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(olderThread("t_s")));
  await settle();
  expect(olderButton(view.host) === undefined).toBe(true);
  const scroller = await openAtEnd(view.host, { content: 3000 });
  await scrollTo(scroller, 900);
  expect(older.calls).toBe(0);
  await scrollTo(scroller, 400);
  expect(older.calls).toBe(1);
  // While it loads: one quiet line, and no second request however it is scrolled.
  expect(view.host.querySelector('[data-slot="loading-line"]')!.textContent).toBe("Loading…");
  await scrollTo(scroller, 100);
  expect(older.calls).toBe(1);
  // It answers with the start: nothing more is asked for.
  await older.land(() => view.rerender(list({ ...olderThread("t_s"), hasMoreOlder: false })));
  expect(view.host.querySelector('[data-slot="loading-line"]') === null).toBe(true);
  await scrollTo(scroller, 0);
  expect(older.calls).toBe(1);
});

test("a reader still near the top when an older page lands reads on, until the start", async () => {
  const older = heldOlder();
  const first = olderThread("t_r", "In t_r");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 3000 };
  const scroller = await openAtEnd(view.host, size);
  await scrollTo(scroller, 100);
  expect(older.calls).toBe(1);
  // 300px of older rows land; the reader, kept on their row, is still within a screen of the top.
  await older.land(() => { size.content = 3300; view.rerender(list(withOlder(first))); });
  expect(scroller.scrollTop).toBe(400);
  expect(older.calls).toBe(2);
  // This one is the start: no third, however the reader scrolls.
  await older.land(() => { size.content = 3564; view.rerender(list(withOlder(withOlder(first), false))); });
  expect(older.calls).toBe(2);
  await scrollTo(scroller, 0);
  expect(older.calls).toBe(2);
  expect(has(view.host, '[data-slot="older-slot"]')).toBe(false);
});

test("a page that does not fill the pane loads older messages by itself; a pane with no height does not", async () => {
  const older = heldOlder();
  const view = await mountAsync(<ChatMessageList thread={olderThread("t_f")} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  // happy-dom's own box has no height: nothing measured, nothing loaded.
  expect(older.calls).toBe(0);
  sized(view.host, { content: 300 });
  view.rerender(<ChatMessageList thread={withNewer(olderThread("t_f"), "More")} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  expect(older.calls).toBe(1);
});

test("older messages that fail to load are an inline error; scrolling does not retry, Retry does", async () => {
  const older = heldOlder();
  const { host } = await mountAsync(<ChatMessageList thread={olderThread("t_o1")} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  const scroller = await openAtEnd(host, { content: 3000 });
  await scrollTo(scroller, 200);
  await older.fail("database is locked");
  const failed = host.querySelector('[data-slot="inline-error"]')!;
  expect(failed.textContent).toContain("Couldn't load older messages.");
  expect(failed.querySelector("p")!.textContent).toBe("database is locked");
  await scrollTo(scroller, 50);
  await scrollTo(scroller, 0);
  expect(older.calls).toBe(1);
  // Retry pressed twice in a row asks once.
  await act(async () => { retryIn(failed).click(); retryIn(failed).click(); });
  await settle();
  expect(older.calls).toBe(2);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
});

// A failure is not a page that added nothing: after Retry brings older rows,
// a pane they still do not fill keeps reading on by itself (it cannot be
// scrolled, so no scroll would ever ask again).
test("after Retry brings older rows that still do not fill the pane, older pages keep loading by themselves", async () => {
  await withScrollerHeights({ content: 300 }, async () => {
    const older = heldOlder();
    const first = olderThread("t_rt", "Latest");
    const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
    const view = await mountAsync(list(first));
    await settle();
    expect(older.calls).toBe(1);
    await older.fail("database is locked");
    await act(async () => { retryIn(view.host.querySelector('[data-slot="inline-error"]')!).click(); });
    await settle();
    expect(older.calls).toBe(2);
    await older.land(() => view.rerender(list(withOlder(first))));
    expect(older.calls).toBe(3);
    const column = view.host.querySelector('[data-slot="transcript-column"]')!;
    expect(column.getAttribute("data-filling")).toBe("true");
    expect(column.querySelector('[data-slot="older-slot"] [data-slot="loading-line"]')).not.toBeNull();
  });
});

test("a load-older failure belongs to its conversation: another one loads its own as it is scrolled", async () => {
  const older = heldOlder();
  const list = (threadId: string) => <ChatMessageList thread={olderThread(threadId)} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list("t_a"));
  await settle();
  const scroller = await openAtEnd(view.host, { content: 3000 });
  await scrollTo(scroller, 200);
  await older.fail("database is locked");
  expect(has(view.host, '[data-slot="inline-error"]')).toBe(true);
  view.rerender(list("t_b"));
  await settle();
  expect(has(view.host, '[data-slot="inline-error"]')).toBe(false);
  await scrollTo(scroller, 300);
  expect(older.calls).toBe(2);
  expect(has(view.host, '[data-slot="loading-line"]')).toBe(true);
});

test("a load-older that answers after another conversation opened leaves that conversation where it opened", async () => {
  const older = heldOlder();
  const list = (threadId: string) => <ChatMessageList thread={olderThread(threadId, `In ${threadId}`)} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list("t_a"));
  await settle();
  const size = { content: 1000 };
  const scroller = await openAtEnd(view.host, size);
  await scrollTo(scroller, 100);
  // Another conversation opens while the older page is on its way.
  size.content = 3000;
  view.rerender(list("t_b"));
  // Its rows changing queue the following reader's pin for the next frame
  // (16ms here, tests/setup.ts). It runs before the page lands, as a paint
  // comes between in a browser: left pending, a slow run fired it after the
  // growth below, and it pinned the reader to the new end.
  await settle(20);
  const opened = scroller.scrollTop;
  // The old conversation's page answers.
  await older.land(() => { size.content = 3600; view.rerender(list("t_b")); });
  expect(scroller.scrollTop).toBe(opened);
});

// Nothing of a load outlives its conversation: a reader who scrolled up in
// the next one stays where they are when it grows at its end.
test("a load pending in one conversation does not move a reader in the next as it grows", async () => {
  const older = heldOlder();
  const second = olderThread("t_d2", "In t_d2");
  const view = await mountAsync(<ChatMessageList thread={olderThread("t_d1")} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  const size = { content: 1000 };
  const scroller = await openAtEnd(view.host, size);
  await scrollTo(scroller, 100);
  expect(older.calls).toBe(1);
  size.content = 3000;
  view.rerender(<ChatMessageList thread={{ ...second, hasMoreOlder: false }} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  await scrollTo(scroller, 2500);
  await scrollTo(scroller, 1200);
  size.content = 3100;
  view.rerender(<ChatMessageList thread={withNewer({ ...second, hasMoreOlder: false })} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  expect(scroller.scrollTop).toBe(1200);
  await older.land(() => {});
  expect(scroller.scrollTop).toBe(1200);
});

// Older messages land above what is on screen; the reader stays on what they
// were reading, wherever they had scrolled to, not at the top's old offset.
test("an older page that answers in the same conversation keeps the reader on the message they were reading", async () => {
  const older = heldOlder();
  const first = olderThread("t_a", "In t_a");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 1000 };
  const scroller = await openAtEnd(view.host, size);
  await scrollTo(scroller, 300);
  // Still scrolling up while it loads.
  await scrollTo(scroller, 120);
  // 600px of older messages land above what was on screen.
  await older.land(() => { size.content = 1600; view.rerender(list(withOlder(first))); });
  expect(scroller.scrollTop).toBe(720);
});

// A first page that does not fill the pane, with older messages to come, is
// held out of sight until older pages fill it: shown at once, its
// rows sat near the top and jumped to the bottom when the older page landed.
test("a first page that does not fill the pane is out of sight until older pages fill it, then opens at its end", async () => {
  const size = { content: 300 };
  await withScrollerHeights(size, async () => {
    const older = heldOlder();
    const first = olderThread("t_h", "Latest");
    const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
    const view = await mountAsync(list(first));
    await settle();
    const column = () => view.host.querySelector('[data-slot="transcript-column"]')!;
    const scroller = view.host.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
    expect(column().getAttribute("data-filling")).toBe("true");
    expect(column().className).toContain("[&>*:not([data-slot=older-slot])]:invisible");
    expect(older.calls).toBe(1);
    // An older page fills it: shown, all at once, at its end.
    await older.land(() => { size.content = 900; view.rerender(list(withOlder(first))); });
    expect(column().getAttribute("data-filling")).toBeNull();
    expect(column().className).not.toContain("invisible");
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(400);
  });
});

// A held first page can come to fill the pane with no new row: a streaming
// reply grows. It is shown then, not when the next older page lands.
test("a held first page is shown once a streaming reply fills the pane", async () => {
  const size = { content: 300 };
  await withScrollerHeights(size, async () => {
    const older = heldOlder();
    const first = olderThread("t_hs", "Latest");
    const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
    const view = await mountAsync(list(first));
    await settle();
    const column = () => view.host.querySelector('[data-slot="transcript-column"]')!;
    expect(column().getAttribute("data-filling")).toBe("true");
    size.content = 800;
    view.rerender(list({ ...first, streamingAssistant: { wakeId: "w_hs", totalText: "A long reply" } }));
    await settle(100);
    expect(column().getAttribute("data-filling")).toBeNull();
  });
});

// While there is more, the top holds one slot of a fixed height, with the
// loading line in it while a page loads: the line coming and going moves
// nothing below it. The slot goes with the last page, in the same commit.
test("the top keeps one fixed slot while there is more; Loading… comes and goes inside it", async () => {
  const older = heldOlder();
  const first = olderThread("t_slot");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const slot = () => view.host.querySelector<HTMLElement>('[data-slot="older-slot"]');
  expect(slot()!.className.split(/\s+/)).toContain("h-5");
  expect(slot()!.querySelector('[data-slot="loading-line"]') === null).toBe(true);
  const scroller = await openAtEnd(view.host, { content: 3000 });
  await scrollTo(scroller, 200);
  expect(slot()!.className.split(/\s+/)).toContain("h-5");
  expect(slot()!.querySelector('[data-slot="loading-line"]')!.textContent).toBe("Loading…");
  await older.land(() => view.rerender(list(withOlder(first, false))));
  expect(slot() === null).toBe(true);
});

// Following goes by what the reader did, not by a distance from
// the end: a reader who scrolled up stays on their row when older rows land,
// near the end or not, and is offered the latest until they are back at it.
test("a reader who scrolled up from the end stays on their row as an older page lands, offered the latest until back at the end", async () => {
  const older = heldOlder();
  const first = olderThread("t_pin", "Latest");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 1000 };
  const scroller = await openAtEnd(view.host, size);
  // 70px up from the end, and within a screen of the top: it loads.
  await scrollTo(scroller, 430);
  await older.land(() => { size.content = 1600; view.rerender(list(withOlder(first))); });
  expect(scroller.scrollTop).toBe(1030);
  expect(latestButton(view.host)).not.toBeNull();
  // 20px short of the end is not the end.
  await scrollTo(scroller, 1080);
  expect(latestButton(view.host)).not.toBeNull();
  await scrollTo(scroller, 1100);
  expect(latestButton(view.host) === null).toBe(true);
});

// A conversation's failed load stays its own: another conversation's load
// does not clear it, so coming back does not retry without Retry.
test("a conversation's failed load is still its own after another conversation loads", async () => {
  const asked: string[] = [];
  const onLoadOlderFor = (threadId: string) => () => {
    asked.push(threadId);
    return threadId === "t_x" ? Promise.reject(new Error("database is locked")) : new Promise<void>(() => {});
  };
  const list = (threadId: string) => <ChatMessageList thread={olderThread(threadId)} onLoadOlder={onLoadOlderFor(threadId)} onRetryFailed={() => {}} />;
  const view = await mountAsync(list("t_x"));
  await settle();
  const scroller = await openAtEnd(view.host, { content: 3000 });
  await scrollTo(scroller, 200);
  await settle();
  expect(has(view.host, '[data-slot="inline-error"]')).toBe(true);
  view.rerender(list("t_y"));
  await settle();
  await scrollTo(scroller, 200);
  view.rerender(list("t_x"));
  await settle();
  await scrollTo(scroller, 100);
  expect(has(view.host, '[data-slot="inline-error"]')).toBe(true);
  expect(asked).toStrictEqual(["t_x", "t_y"]);
});

// A reader following at the very end keeps following when a new message
// arrives while an older page loads: rows at the end are no older rows.
test("a reader at the end still follows a new message that arrives while an older page loads", async () => {
  const older = heldOlder();
  const first = olderThread("t_follow", "Latest");
  const view = await mountAsync(<ChatMessageList thread={first} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  const size = { content: 900 };
  // At the end, and within a screen of the top: it loads.
  const scroller = await openAtEnd(view.host, size);
  expect(view.host.querySelector('[data-slot="loading-line"]')).not.toBeNull();
  size.content = 1000;
  view.rerender(<ChatMessageList thread={withNewer(first)} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  expect(fromEnd(scroller)).toBe(0);
  expect(latestButton(view.host) === null).toBe(true);
});

// An older page and a new message in one commit: a reader at the end follows
// the new message; the older rows above do not hold them back.
test("a reader at the end follows a new message that lands in the same commit as an older page", async () => {
  const older = heldOlder();
  const first = olderThread("t_both", "Latest");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 900 };
  const scroller = await openAtEnd(view.host, size);
  expect(older.calls).toBe(1);
  // 10px short of the end is still following (under 24px).
  await scrollTo(scroller, 390);
  await older.land(() => { size.content = 1600; view.rerender(list(withNewer(withOlder(first)))); });
  expect(fromEnd(scroller)).toBe(0);
  expect(latestButton(view.host) === null).toBe(true);
});

// The cache keeps a conversation's newest 500 messages, so a new one can push
// the oldest out: the first row changes, and nothing older landed.
test("a reader at the end follows a new message that pushes the oldest out of the cache", async () => {
  const first = { ...withOlder(olderThread("t_trim", "Latest")), hasMoreOlder: false };
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 1000 };
  const scroller = await openAtEnd(view.host, size);
  const next = withNewer(first);
  size.content = 1685;
  view.rerender(list({ ...next, messages: next.messages.slice(1), oldestSeqLoaded: next.messages[1]!.seq, hasMoreOlder: true }));
  await settle();
  expect(fromEnd(scroller)).toBe(0);
  expect(latestButton(view.host) === null).toBe(true);
});

test("content growing below a following reader, a scroll event and all, does not stop the following", async () => {
  const first = { ...olderThread("t_grow", "Latest"), hasMoreOlder: false };
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 1000 };
  const scroller = await openAtEnd(view.host, size);
  // A pane resize reflows the rows 600px taller; scrollTop stays.
  size.content = 1600;
  await scrollTo(scroller, 500);
  expect(latestButton(view.host) === null).toBe(true);
  view.rerender(list(withNewer(first)));
  await settle();
  expect(fromEnd(scroller)).toBe(0);
});

test("a scroll up of under 24px keeps following; a wheel turned up stops it at once", async () => {
  const first = { ...olderThread("t_wheel", "Latest"), hasMoreOlder: false };
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 3000 };
  const scroller = await openAtEnd(view.host, size);
  await scrollTo(scroller, 2490);
  expect(latestButton(view.host) === null).toBe(true);
  size.content = 3100;
  view.rerender(list(withNewer(first, "One")));
  await settle();
  expect(fromEnd(scroller)).toBe(0);
  // The wheel's own event, before any scroll event: the next message is not followed.
  await act(async () => { scroller.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -4, bubbles: true })); });
  expect(latestButton(view.host)).not.toBeNull();
  size.content = 3200;
  view.rerender(list(withNewer(withNewer(first, "One"), "Two")));
  await settle();
  expect(scroller.scrollTop).toBe(2600);
});

// Every row of an older page is drawn in the commit it lands in: the render
// window opens with it. Left to open a frame later, the rows still to come
// moved the reader by their height after their place was restored.
test("an older page's rows are all drawn in the commit they land in", async () => {
  const messages = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) =>
    agentMessage({ id: `t_win-${from + i}`, threadId: "t_win", seq: from + i, content: { type: "text", text: `Row ${from + i}` } }));
  const first = { ...olderThread("t_win"), messages: messages(81, 100), oldestSeqLoaded: 81 };
  let drawnAtOnce: boolean | null = null;
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={onLoadOlder} onRetryFailed={() => {}} />;
  const onLoadOlder = async (apply: ApplyOlder) => {
    await Promise.resolve();
    apply(() => view.rerender(list({ ...first, messages: messages(71, 100), oldestSeqLoaded: 71, hasMoreOlder: false })));
    drawnAtOnce = view.host.textContent!.includes("Row 71");
  };
  const view = await mountAsync(list(first));
  await settle();
  const scroller = await openAtEnd(view.host, { content: 3000 });
  await scrollTo(scroller, 100);
  await settle();
  expect(drawnAtOnce === true).toBe(true);
});

// A scroll's event comes with the next frame: a page landing, or a new
// message drawn, before it must still see that the reader left the end.
test("a reader who scrolled up just before an older page lands, its scroll event not yet sent, stays on their row", async () => {
  const older = heldOlder();
  const first = olderThread("t_race", "Latest");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 900 };
  const scroller = await openAtEnd(view.host, size);
  expect(older.calls).toBe(1);
  scroller.scrollTop = 330;
  await older.land(() => { size.content = 1500; view.rerender(list(withOlder(first))); });
  expect(scroller.scrollTop).toBe(930);
});

test("a reader who scrolled up just before a new message is drawn, its scroll event not yet sent, is not pulled to it", async () => {
  const first = { ...olderThread("t_race2", "Latest"), hasMoreOlder: false };
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 3000 };
  const scroller = await openAtEnd(view.host, size);
  scroller.scrollTop = 2400;
  size.content = 3100;
  view.rerender(list(withNewer(first)));
  await settle();
  expect(scroller.scrollTop).toBe(2400);
  expect(latestButton(view.host)).not.toBeNull();
});

// An empty last page only takes the top slot away: no row is added, so the
// commit has no growth of its own to read the scroll for; the page's landing
// reads it.
test("a reader who scrolled up just before an empty last page lands stays on their row", async () => {
  const messages = Array.from({ length: 30 }, (_, i) =>
    agentMessage({ id: `t_empty-${71 + i}`, threadId: "t_empty", seq: 71 + i, content: { type: "text", text: `Row ${71 + i}` } }));
  const first = { ...olderThread("t_empty"), messages, oldestSeqLoaded: 71 };
  const older = heldOlder();
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  // Two frames, and the window opens.
  await settle(100);
  expect(view.host.textContent).toContain("Row 71");
  const size = { content: 900 };
  const scroller = await openAtEnd(view.host, size);
  expect(older.calls).toBe(1);
  scroller.scrollTop = 330;
  await older.land(() => { size.content = 864; view.rerender(list({ ...first, hasMoreOlder: false })); });
  expect(scroller.scrollTop).toBe(294);
});

// A conversation's load is its own, not its transcript's: leaving the chat
// tab or the thread unmounts the transcript, and opening it again must not
// retry a failure by itself, nor ask a second time for a page on its way
// (it would land twice).
test("a failure is still there when a conversation's transcript is opened again, and nothing is asked by itself", async () => {
  const older = heldOlder();
  const list = () => <ChatMessageList thread={olderThread("t_rm")} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const first = await mountAsync(list());
  await settle();
  await scrollTo(await openAtEnd(first.host, { content: 3000 }), 200);
  await older.fail("database is locked");
  first.unmount();
  const again = await mountAsync(list());
  await settle();
  const scroller = await openAtEnd(again.host, { content: 3000 });
  await scrollTo(scroller, 100);
  expect(again.host.querySelector('[data-slot="inline-error"] p')!.textContent).toBe("database is locked");
  expect(older.calls).toBe(1);
});

test("a transcript opened again while its conversation's older page is on its way does not ask for it twice", async () => {
  const older = heldOlder();
  const first = olderThread("t_rp");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  await scrollTo(await openAtEnd(view.host, { content: 3000 }), 200);
  expect(older.calls).toBe(1);
  view.unmount();
  const again = await mountAsync(list(first));
  await settle();
  const scroller = await openAtEnd(again.host, { content: 3000 });
  await scrollTo(scroller, 100);
  expect(older.calls).toBe(1);
  expect(again.host.querySelector('[data-slot="loading-line"]')).not.toBeNull();
  // Far from the top when it lands: nothing more to read on to.
  await scrollTo(scroller, 2000);
  await older.land(() => again.rerender(list(withOlder(first))));
  expect(again.host.querySelector('[data-slot="loading-line"]') === null).toBe(true);
  expect(again.host.textContent).toContain("Earlier 99");
  expect(has(again.host, '[data-slot="inline-error"]')).toBe(false);
  expect(older.calls).toBe(1);
});

// A pane with no height (a hidden one) measures nothing: it neither loads nor
// counts as filled, so its first page is still held once it is shown.
test("a first page in a pane with no height is held until it is shown, then until older pages fill it", async () => {
  const size = { content: 300, view: 0 };
  await withScrollerHeights(size, async () => {
    const older = heldOlder();
    const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
    const view = await mountAsync(list(olderThread("t_hid", "Latest")));
    await settle();
    const column = () => view.host.querySelector('[data-slot="transcript-column"]')!;
    expect(older.calls).toBe(0);
    expect(column().getAttribute("data-filling")).toBe("true");
    size.view = 500;
    view.rerender(list(withNewer(olderThread("t_hid", "Latest"))));
    await settle();
    expect(older.calls).toBe(1);
    expect(column().getAttribute("data-filling")).toBe("true");
  });
});

// A page on its way lands in whichever transcript shows its conversation
// then: one opened again meanwhile keeps its reader's place, and judges
// whether the page added anything.
test("a page landing in a transcript opened again while it was on its way keeps that reader's place", async () => {
  const older = heldOlder();
  const first = olderThread("t_rk");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  await scrollTo(await openAtEnd(view.host, { content: 3000 }), 200);
  expect(older.calls).toBe(1);
  view.unmount();
  const again = await mountAsync(list(first));
  await settle();
  const size = { content: 3000 };
  const scroller = await openAtEnd(again.host, size);
  await scrollTo(scroller, 300);
  await older.land(() => { size.content = 3600; again.rerender(list(withOlder(first))); });
  expect(scroller.scrollTop).toBe(900);
});

// A pane hidden while mounted (the split row maximizing the other pane)
// measures all zeros: that is not the reader reaching the end. Shown again,
// a reader who had scrolled up is where they were, not pulled to the latest.
test("a reader who scrolled up stays there through their pane being hidden and shown again", async () => {
  const first = { ...olderThread("t_hide", "Latest"), hasMoreOlder: false };
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size: { content: number; hidden?: boolean } = { content: 3000 };
  const scroller = await openAtEnd(view.host, size);
  await scrollTo(scroller, 1000);
  size.hidden = true;
  view.rerender(list(withNewer(first, "While hidden")));
  await settle();
  size.hidden = false;
  size.content = 3100;
  view.rerender(list(withNewer(withNewer(first, "While hidden"), "Shown again")));
  await settle();
  expect(scroller.scrollTop).toBe(1000);
  expect(latestButton(view.host)).not.toBeNull();
});

// The last page takes the top slot away: the content shrinks, and the browser
// pulls a reader near the end up to the new end in the page's own commit. That
// in-between layout is not the reader coming back to the end: they stay
// detached, 10px above it as before.
test("a reader just above the end stays detached and in place when the last, empty page takes the top slot away", async () => {
  const older = heldOlder();
  const first = olderThread("t_clamp", "Latest");
  const list = (thread: Thread) => <ChatMessageList thread={thread} onLoadOlder={older.onLoadOlder} onRetryFailed={() => {}} />;
  const view = await mountAsync(list(first));
  await settle();
  const size = { content: 900 };
  const scroller = await openAtEnd(view.host, size);
  expect(older.calls).toBe(1);
  await act(async () => { scroller.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -4, bubbles: true })); });
  await scrollTo(scroller, 390);
  await older.land(() => { size.content = 864; view.rerender(list({ ...first, hasMoreOlder: false })); });
  expect(scroller.scrollTop).toBe(354);
  expect(latestButton(view.host)).not.toBeNull();
});

// Through the store's own write: a page for another thread (the scope's
// conversation was rotated on the server) cannot be taken, and asked again
// would come back the same, so it is a failure with Retry; an empty page is
// the start, whatever it says of more (the store's rule since before load on
// scroll).
async function storeConversation(threadId: string, older: () => object) {
  const reads: string[] = [];
  mockFetch(({ url }) => {
    if (!url.includes(`/api/agents/threads/${threadId}`)) return jsonResponse({});
    reads.push(url);
    if (url.includes("before=")) return jsonResponse(older());
    return jsonResponse({ ...page(threadId, [agentMessage({ id: `${threadId}-50`, threadId, seq: 50, content: { type: "text", text: "Latest" } })]), hasMore: true });
  });
  const host = await render({ type: "manager", threadId });
  const scroller = await openAtEnd(host, { content: 3000 });
  await scrollTo(scroller, 100);
  await settle();
  return { host, reads };
}

test("an older page the store does not take (another thread's) is a failure with Retry", async () => {
  const { host, reads } = await storeConversation("t_store_x", () => ({ ...page("t_other", [agentMessage({ id: "o-1", threadId: "t_other", seq: 1, content: { type: "text", text: "Elsewhere" } })]), hasMore: true }));
  expect(host.querySelector('[data-slot="inline-error"] p')!.textContent).toBe("The server answered with another conversation.");
  expect(reads.filter((url) => url.includes("before="))).toHaveLength(1);
  await act(async () => { retryIn(host.querySelector('[data-slot="inline-error"]')!).click(); });
  await settle();
  expect(reads.filter((url) => url.includes("before="))).toHaveLength(2);
});

test("an empty older page is the start: the top slot goes, with no failure", async () => {
  const { host, reads } = await storeConversation("t_store_e", () => ({ ...page("t_store_e", []), hasMore: true }));
  expect(reads.filter((url) => url.includes("before="))).toHaveLength(1);
  expect(has(host, '[data-slot="older-slot"]')).toBe(false);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
});

// Whether a page added anything is its owner's to say (a load it resolved
// added older messages or reached the start). A live worker's page landing
// in its own store, while the worker's archived view (another owner, the same
// conversation) is on screen, fails nothing there; that view reads on itself.
test("a page from a conversation's live view, landing while another view of it shows, fails nothing there", async () => {
  const live = heldOlder();
  const archived = heldOlder();
  const first = olderThread("t_arch");
  const view = await mountAsync(<ChatMessageList thread={first} onLoadOlder={live.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  await scrollTo(await openAtEnd(view.host, { content: 3000 }), 200);
  expect(live.calls).toBe(1);
  view.unmount();
  const shown = await mountAsync(<ChatMessageList thread={first} onLoadOlder={archived.onLoadOlder} onRetryFailed={() => {}} />);
  await settle();
  const scroller = await openAtEnd(shown.host, { content: 3000 });
  await scrollTo(scroller, 100);
  expect(archived.calls).toBe(0);
  // Written into the live view's store, which this view does not read.
  await live.land(() => {});
  expect(has(shown.host, '[data-slot="inline-error"]')).toBe(false);
  expect(archived.calls).toBe(1);
});
