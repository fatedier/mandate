import { afterEach, expect, test } from "bun:test";
import { Activity, act, useState, useSyncExternalStore } from "react";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { useReadPoint, useSeenNewLines } from "../../src/client/routes/window/chat/new-replies.js";
import { PageShownContext } from "../../src/client/lib/page-shown.js";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount, mountAsync, settle } from "../helpers/mount.js";

// Back in a conversation after a while, the user's eye goes to the newest
// message: a line marks where what they have not read begins, and while that
// line is above the view a bar says how many replies are new and goes to it.

afterEach(() => {
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  useSeenNewLines.setState({ seen: new Set() });
});

const row = (seq: number, m: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage => ({
  id: `m${seq}`, threadId: "t1", seq, source: "self", sourceThreadId: null, wakeId: `w${seq}`,
  createdAt: `2026-11-12T07:${String(seq).padStart(2, "0")}:00.000Z`, ...m
} as AgentMessage);
const you = (seq: number, text: string) => row(seq, { role: "user", source: "user", wakeId: null, content: { type: "text", text } });
const reply = (seq: number, text: string) => row(seq, { role: "assistant", content: { type: "assistant", text } });
const notice = (seq: number, text: string) => row(seq, { role: "user", source: "thread-notice", wakeId: null, content: { type: "text", text } });

const conversation = [
  you(1, "Did the tests pass?"),
  reply(2, "Still running."),
  notice(3, "[Thread notice] Duty thread \"Water tank watch\" (thr_d): reports.\nReport:\nThe tank is low."),
  reply(4, "The low-water rule fired."),
  reply(5, "Order #12 waits for your approval.")
];

/** happy-dom has no IntersectionObserver: one the test drives, saying
 *  whether the line is above the view or in it. */
function lineObserver() {
  const made: Array<{ cb: IntersectionObserverCallback; targets: Element[] }> = [];
  class FakeObserver {
    targets: Element[] = [];
    constructor(public cb: IntersectionObserverCallback) { made.push(this); }
    observe(target: Element) { this.targets.push(target); }
    unobserve() {}
    disconnect() { this.targets = []; }
    takeRecords() { return []; }
  }
  for (const target of [globalThis, window] as Array<Record<string, unknown>>) {
    const own = Object.getOwnPropertyDescriptor(target, "IntersectionObserver");
    Object.defineProperty(target, "IntersectionObserver", { value: FakeObserver, configurable: true, writable: true });
    onCleanup(() => {
      if (own) Object.defineProperty(target, "IntersectionObserver", own);
      else delete target.IntersectionObserver;
    });
  }
  return (where: "above" | "in" | "below") => act(() => {
    for (const o of made) {
      for (const t of o.targets) {
        const top = where === "above" ? -200 : where === "in" ? 100 : 900;
        o.cb([{ target: t, isIntersecting: where === "in", boundingClientRect: { top }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], o as unknown as IntersectionObserver);
      }
    }
  });
}

/** Element.prototype.scrollIntoView recorded (happy-dom defines it on Element). */
function scrolls() {
  const calls: Array<{ slot: string | null; options: unknown }> = [];
  const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true, writable: true,
    value(this: Element, options: unknown) { calls.push({ slot: this.getAttribute("data-slot"), options }); }
  });
  onCleanup(() => {
    if (own) Object.defineProperty(Element.prototype, "scrollIntoView", own);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  return calls;
}

async function render(newSince: number | null, state: Partial<ThreadState> = {}) {
  const thread: ThreadState = { ...newThreadState(), threadId: "t1", loaded: true, messages: conversation, oldestSeqLoaded: 1, ...state };
  const mounted = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} newSince={newSince} />);
  await settle();
  return mounted.host;
}
const lineOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="new-replies-line"]');
const barOf = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Jump to the first new reply") ?? null;

test("a line marks where what came after the read point begins, above the first new row", async () => {
  lineObserver();
  const host = await render(2);
  const line = lineOf(host)!;
  expect([line.textContent, line.getAttribute("role"), line.getAttribute("aria-label")]).toEqual(["New", "separator", "New replies start here"]);
  // Under the reply already read; above the duty thread's report and the reply to it.
  expect(line.previousElementSibling?.textContent).toContain("Still running.");
  expect(line.nextElementSibling?.textContent).toContain("The low-water rule fired.");
});

test("while the line is above the view, a bar says how many replies are new and goes to the line", async () => {
  const moveTo = lineObserver();
  const scrolled = scrolls();
  const host = await render(2);
  expect(barOf(host) === null).toBe(true);
  await moveTo("above");
  const bar = barOf(host)!;
  expect(bar.textContent).toBe("2 new replies");
  // Room at the end, so the bar covers no last line.
  expect(host.querySelector('[data-slot="jump-room"]') !== null).toBe(true);
  act(() => { bar.click(); });
  expect(scrolled).toEqual([{ slot: "new-replies-line", options: { block: "start", behavior: "instant" } }]);
  await moveTo("in");
  expect([barOf(host) === null, host.querySelector('[data-slot="jump-room"]') === null]).toEqual([true, true]);
  // Below the view (scrolled up past it), no bar either: it goes up only.
  await moveTo("below");
  expect(barOf(host) === null).toBe(true);
});

test("once the line has been in view, the bar does not come back as the user reads on past it", async () => {
  const moveTo = lineObserver();
  scrolls();
  // Gone to by the bar, then read past.
  const host = await render(2);
  await moveTo("above");
  act(() => { barOf(host)!.click(); });
  // The browser tells the line came into view, then went past the top as the user read on.
  await moveTo("in");
  await moveTo("above");
  expect([barOf(host) === null, host.querySelector('[data-slot="new-replies-line"]') !== null]).toEqual([true, true]);
});

test("scrolled up to by hand, the line counts as seen too: no bar after it", async () => {
  const moveTo = lineObserver();
  const host = await render(2);
  await moveTo("above");
  expect(barOf(host) !== null).toBe(true);
  await moveTo("in");
  await moveTo("above");
  expect(barOf(host) === null).toBe(true);
});

test("one new reply is said as one", async () => {
  const moveTo = lineObserver();
  const host = await render(4);
  await moveTo("above");
  expect(barOf(host)!.textContent).toBe("1 new reply");
});

test("no line with nothing new, with only a notice new, or with no read point", async () => {
  lineObserver();
  expect(lineOf(await render(5)) === null).toBe(true);
  expect(lineOf(await render(2, { messages: conversation.slice(0, 3) })) === null).toBe(true);
  expect(lineOf(await render(null)) === null).toBe(true);
});

test("once the user writes, the line goes: a message sent from here or one of theirs after the point", async () => {
  lineObserver();
  const pending: ThreadState["pendingUserMessages"] = new Map([["local-1", { localId: "local-1", content: "Merge it.", createdAt: "2026-11-12T07:06:00.000Z", status: "sending" }]]);
  expect(lineOf(await render(2, { pendingUserMessages: pending })) === null).toBe(true);
  expect(lineOf(await render(2, { messages: [...conversation, you(6, "Merge it.")] })) === null).toBe(true);
});

// Where the user had read to when the conversation came into sight is held
// while it stays in sight, though the page marks it all seen at once; out of
// sight and back, it is taken again.
test("the read point is taken as the conversation comes into sight and held while it stays", () => {
  const set: { at?: (next: { key: string; seen: number | null; inSight: boolean }) => void } = {};
  function Probe() {
    const [props, setProps] = useState<{ key: string; seen: number | null; inSight: boolean }>({ key: "t1", seen: 3, inSight: true });
    set.at = setProps;
    const point = useReadPoint(props.key, props.seen, props.inSight);
    return <span data-point>{String(point)}</span>;
  }
  const { host } = mount(<Probe />);
  const point = () => host.querySelector("[data-point]")!.textContent;
  expect(point()).toBe("3");
  act(() => { set.at!({ key: "t1", seen: 5, inSight: true }); });
  expect(point()).toBe("3");
  act(() => { set.at!({ key: "t1", seen: 5, inSight: false }); });
  expect(point()).toBe("null");
  act(() => { set.at!({ key: "t1", seen: 5, inSight: true }); });
  expect(point()).toBe("5");
  // Another conversation in the same place.
  act(() => { set.at!({ key: "t2", seen: 9, inSight: true }); });
  expect(point()).toBe("9");
  // Not known yet: none until it is.
  act(() => { set.at!({ key: "t3", seen: null, inSight: true }); });
  expect(point()).toBe("null");
  act(() => { set.at!({ key: "t3", seen: 2, inSight: true }); });
  expect(point()).toBe("2");
});

test("a browser tab in the back counts as out of sight", () => {
  let state: DocumentVisibilityState = "visible";
  const own = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  onCleanup(() => {
    if (own) Object.defineProperty(document, "visibilityState", own);
    else delete (document as { visibilityState?: unknown }).visibilityState;
  });
  const set: { seen?: (n: number) => void } = {};
  function Probe() {
    const [seen, setSeen] = useState(3);
    set.seen = setSeen;
    return <span data-point>{String(useReadPoint("t1", seen, true))}</span>;
  }
  const { host } = mount(<Probe />);
  const point = () => host.querySelector("[data-point]")!.textContent;
  expect(point()).toBe("3");
  act(() => { set.seen!(6); });
  const flip = (next: DocumentVisibilityState) => act(() => { state = next; document.dispatchEvent(new CustomEvent("visibilitychange")); });
  flip("hidden");
  expect(point()).toBe("null");
  flip("visible");
  expect(point()).toBe("6");
});

// Coming back to a tab in the back, the page marks the conversation seen
// as the tab shows, before this renders: the point is where it had been
// read to while the tab was in the back (another device may have moved it).
test("back from a tab in the back, the point is where it was read to before the page marks it seen", () => {
  let state: DocumentVisibilityState = "visible";
  const own = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  onCleanup(() => {
    if (own) Object.defineProperty(document, "visibilityState", own);
    else delete (document as { visibilityState?: unknown }).visibilityState;
  });
  const set: { seen?: (n: number) => void } = {};
  function Probe() {
    const [seen, setSeen] = useState(3);
    set.seen = setSeen;
    return <span data-point>{String(useReadPoint("t1", seen, true))}</span>;
  }
  const { host } = mount(<Probe />);
  const point = () => host.querySelector("[data-point]")!.textContent;
  act(() => { state = "hidden"; document.dispatchEvent(new CustomEvent("visibilitychange")); });
  // Read to 4 on another device while the tab was in the back.
  act(() => { set.seen!(4); });
  // The tab shows; the page's own listener marks it all seen (9) before this renders.
  act(() => { state = "visible"; set.seen!(9); document.dispatchEvent(new CustomEvent("visibilitychange")); });
  expect(point()).toBe("4");
});

// A request the personal agent passed on to a thread is no word of the user's.
test("a request the personal agent relayed is not the user writing: the line stays", async () => {
  lineObserver();
  const relayed = row(3, { role: "user", source: "user", wakeId: null, content: { type: "text", text: "Release 3.21 as planned.", relay: { by: "personal", spoken: false, handoffId: "hnd_1" } } });
  const host = await render(2, { messages: [you(1, "Did the tests pass?"), reply(2, "Still running."), relayed, reply(4, "Tagging 3.21.")] });
  expect(lineOf(host)?.nextElementSibling?.textContent).toContain("Release 3.21 as planned.");
});

// Tool steps of a turn read up to its first step join that step's line: the
// steps after the point start a line of their own, under the line.
test("tool steps after the point are not folded into a run read before it", async () => {
  lineObserver();
  const tool = (seq: number, text: string, callId: string) => row(seq, { role: "assistant", wakeId: "w9", content: { type: "assistant", text, toolCalls: [{ toolCallId: callId, toolName: "bash", args: { command: "true", description: `Step ${callId}` } }] } });
  const result = (seq: number, callId: string) => row(seq, { role: "tool", wakeId: "w9", content: { type: "tool_result", toolCallId: callId, toolName: "bash", result: { exitCode: 0, stdout: "ok" } } });
  const messages = [you(1, "Check the build."), tool(2, "Checking.", "c1"), result(3, "c1"), tool(4, "", "c2"), result(5, "c2"), row(6, { role: "assistant", wakeId: "w9", content: { type: "assistant", text: "The build is green." } })];
  const host = await render(3, { messages });
  const line = lineOf(host)!;
  expect(line.previousElementSibling?.textContent).toContain("Checking.");
  expect(line.nextElementSibling?.textContent).not.toContain("The build is green.");
});

// The newest page may hold only notices or tool work while a reply waits on
// the page before it: the older pages are looked through all the same.
test("with no reply on the newest page, the older pages are still read back to the point", async () => {
  lineObserver();
  let asked = 0;
  const thread: ThreadState = { ...newThreadState(), threadId: "t1", loaded: true, hasMoreOlder: true, oldestSeqLoaded: 10, messages: [notice(10, "[Thread notice] Worker release (w): stopped."), notice(11, "[Thread notice] Worker docs (w): stopped.")] };
  await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => { asked += 1; }} newSince={5} />);
  await settle();
  expect(asked).toBeGreaterThan(0);
});

// A conversation inside the kept personal agent page (a thread's tab beside
// the chat) is out of sight while another page shows, though its own tab
// stays the selected one: the point follows what is read meanwhile.
test("inside the kept page, another page showing counts as out of sight", () => {
  const set: { at?: (next: { seen: number; shown: boolean }) => void } = {};
  function Probe() {
    const [props, setProps] = useState({ seen: 3, shown: true });
    set.at = setProps;
    return (
      <PageShownContext.Provider value={props.shown}>
        <Point seen={props.seen} />
      </PageShownContext.Provider>
    );
  }
  function Point({ seen }: { seen: number }) {
    return <span data-point>{String(useReadPoint("t1", seen, true))}</span>;
  }
  const { host } = mount(<Probe />);
  const point = () => host.querySelector("[data-point]")!.textContent;
  expect(point()).toBe("3");
  act(() => { set.at!({ seen: 5, shown: true }); });
  expect(point()).toBe("3");
  act(() => { set.at!({ seen: 5, shown: false }); });
  expect(point()).toBe("null");
  act(() => { set.at!({ seen: 5, shown: true }); });
  expect(point()).toBe("5");
});

// A message that failed to send went nowhere: it is not the user writing.
test("a message that failed to send does not take the line away", async () => {
  lineObserver();
  const pending: ThreadState["pendingUserMessages"] = new Map([["local-1", { localId: "local-1", content: "Merge it.", createdAt: "2026-11-12T06:59:00.000Z", status: "failed" }]]);
  expect(lineOf(await render(2, { pendingUserMessages: pending }))?.textContent).toBe("New");
});

// A kept page hidden behind another page follows nothing: its store
// subscriptions are cut while it is hidden (React Activity). Back on it, the
// point is what is read to now (reading on the thread's own page, say), and
// nothing has marked it seen before this renders, as a tab coming back does.
test("back on a kept page that was hidden, the point is where it is read to now", () => {
  let value = 5;
  const listeners = new Set<() => void>();
  const store = {
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    get: () => value,
    set: (next: number) => { value = next; for (const l of listeners) l(); }
  };
  function Point() {
    const seen = useSyncExternalStore(store.subscribe, store.get);
    return <span data-point>{String(useReadPoint("t1", seen, true))}</span>;
  }
  function Shell({ shown }: { shown: boolean }) {
    return (
      <Activity mode={shown ? "visible" : "hidden"}>
        <PageShownContext.Provider value={shown}><Point /></PageShownContext.Provider>
      </Activity>
    );
  }
  const mounted = mount(<Shell shown />);
  const point = () => mounted.host.querySelector("[data-point]")!.textContent;
  expect(point()).toBe("5");
  mounted.rerender(<Shell shown={false} />);
  act(() => { store.set(8); });
  mounted.rerender(<Shell shown />);
  expect(point()).toBe("8");
});

// The chat keeps the newest messages and lets the oldest go as new ones
// come: while the line shows, the rows it stands among are held, or a reader
// kept at the newest would see it go with them.
test("while the line shows, the conversation's rows are held whole", async () => {
  lineObserver();
  const thread: ThreadState = { ...newThreadState(), threadId: "t1", loaded: true, messages: conversation, oldestSeqLoaded: 1 };
  const held = () => useAgentChatStore.getState().wholeHeld.has("manager:t1");
  const without = await mountAsync(<ChatMessageList thread={thread} holdKey="manager:t1" onLoadOlder={async () => {}} newSince={null} />);
  await settle();
  expect(held()).toBe(false);
  without.unmount();
  await settle();
  await mountAsync(<ChatMessageList thread={thread} holdKey="manager:t1" onLoadOlder={async () => {}} newSince={2} />);
  await settle();
  expect(held()).toBe(true);
});

// A scrollbar drag or Home and End move the line from above the view to
// below it (or back) without it ever crossing the view, which the observer
// alone never reports: the scroll itself is measured.
test("a jump from above the view to below it hides the bar, and back shows it", async () => {
  const moveTo = lineObserver();
  const host = await render(2);
  await moveTo("above");
  expect(barOf(host) !== null).toBe(true);
  const scroller = host.querySelector<HTMLElement>(".overflow-y-auto")!;
  const line = lineOf(host)!;
  const place = (top: number) => act(() => {
    Object.defineProperty(line, "getBoundingClientRect", { configurable: true, value: () => ({ top, bottom: top + 12, left: 0, right: 0, width: 0, height: 12 }) });
    Object.defineProperty(scroller, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 600, left: 0, right: 0, width: 0, height: 600 }) });
    scroller.dispatchEvent(new CustomEvent("scroll"));
  });
  place(900);
  expect(barOf(host) === null).toBe(true);
  place(-300);
  expect(barOf(host) !== null).toBe(true);
});

// A hold taken only for the line goes when the reader leaves the page: a
// kept page hidden behind another would otherwise hold the rows the whole
// time away. A reader scrolled up keeps theirs (their place is in them).
test("leaving the kept page lets go of a hold taken only for the line", async () => {
  lineObserver();
  const thread: ThreadState = { ...newThreadState(), threadId: "t1", loaded: true, messages: conversation, oldestSeqLoaded: 1 };
  const held = () => useAgentChatStore.getState().wholeHeld.has("personal:t1");
  function Shell({ shown }: { shown: boolean }) {
    return (
      <Activity mode={shown ? "visible" : "hidden"}>
        <ChatMessageList thread={thread} holdKey="personal:t1" onLoadOlder={async () => {}} newSince={shown ? 2 : null} />
      </Activity>
    );
  }
  const mounted = await mountAsync(<Shell shown />);
  await settle();
  expect(held()).toBe(true);
  await act(async () => { mounted.rerender(<Shell shown={false} />); });
  await settle();
  expect(held()).toBe(false);
});

test("a line drawn for a moment above the first rows a long conversation shows first is not the line seen", async () => {
  const moveTo = lineObserver();
  // Forty new replies: the first ones drawn are the last 24, the line above them for now.
  const messages = [you(1, "Did the tests pass?"), ...Array.from({ length: 40 }, (_, n) => reply(n + 2, `Update ${n + 1}.`))];
  const thread: ThreadState = { ...newThreadState(), threadId: "t1", loaded: true, messages, oldestSeqLoaded: 1 };
  await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} newSince={1} />);
  await moveTo("in");
  // The rest drawn: the line stands above reply 1, past the top.
  await settle(60);
  await moveTo("above");
  expect(document.querySelector('button[aria-label="Jump to the first new reply"]') !== null).toBe(true);
});

test("a line seen stays seen though the conversation's list is drawn anew (a page resized across the phone's width)", async () => {
  const moveTo = lineObserver();
  const first = await mountAsync(<ChatMessageList thread={{ ...newThreadState(), threadId: "t1", loaded: true, messages: conversation, oldestSeqLoaded: 1 }} onLoadOlder={async () => {}} newSince={2} />);
  await settle();
  await moveTo("in");
  first.unmount();
  const host = await render(2);
  await moveTo("above");
  expect(barOf(host) === null).toBe(true);
});
