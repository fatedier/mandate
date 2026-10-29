import { afterEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { SENDING_INDICATOR_DELAY_MS, UserMessage } from "../../src/client/routes/window/chat/UserMessage.js";
import { useManagerThreadsStore } from "../../src/client/store/manager-threads.js";
import type { ArchivedThreadDto } from "../../src/shared/api/agents.js";
import type { Mention } from "../../src/shared/mentions.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, mountAsync } from "../helpers/mount.js";
import { fakeClock } from "../helpers/fake-clock.js";
import { managerThreadDto } from "../helpers/client-builders.js";

// A send swaps the bubble through "sending" to "sent" and then to the stored
// message. Over a slow link that swap used to add a bordered "sending" row and
// then take it away, so the bubble jumped by a line.

type Status = "sending" | "sent" | "persisted";
function render(status: Status) {
  const message = (next: Status) => <UserMessage text="ok" status={next} />;
  const { host: container, rerender } = mount(message(status));
  const draw = (next: Status) => rerender(message(next));
  const bubble = () => container.querySelector('[data-slot="user-bubble"]') as HTMLElement;
  return {
    rerender: draw,
    spinner: () => container.querySelector('[aria-label="Sending"]'),
    bubble,
    // What sizes the bubble: its rows, and whether it has a border.
    shape: () => ({
      rows: Array.from(bubble().children).map((row) => row.tagName.toLowerCase()),
      bordered: bubble().className.split(/\s+/).includes("border"),
      slot: container.querySelector('[data-slot="sending-slot"]') !== null
    })
  };
}

/** The sending state waits out its delay by the clock: tests that wait fake it
 *  first (fakeClock) and move it on. */
const wait = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

test("a send that settles quickly never shows the sending state", async () => {
  fakeClock();
  const view = render("sending");
  expect(view.spinner() === null).toBe(true);
  await wait(SENDING_INDICATOR_DELAY_MS - 200);
  expect(view.spinner() === null).toBe(true);
  view.rerender("sent");
  await wait(300);
  expect(view.spinner() === null).toBe(true);
});

test("a slow send shows the spinner beside the bubble, and the bubble keeps its shape", async () => {
  fakeClock();
  const settled = render("persisted").shape();
  const view = render("sending");
  expect(view.shape()).toEqual(settled);
  await wait(SENDING_INDICATOR_DELAY_MS + 50);
  expect(view.spinner() === null).toBe(false);
  // Same rows, no border: the spinner fills a slot beside every bubble.
  expect(view.shape()).toEqual(settled);
  expect(settled).toEqual({ rows: ["div"], bordered: false, slot: true });
});

// Its time is the transcript's, shown on hover above the row:
// a title on the bubble popped over the text being read.
test("a bubble shows no clock and holds no time of its own", () => {
  const view = render("persisted");
  expect(view.bubble().querySelector("time") === null).toBe(true);
  expect(view.bubble().hasAttribute("title")).toBe(false);
});

test("the spinner goes when the send settles", async () => {
  fakeClock();
  const view = render("sending");
  await wait(SENDING_INDICATOR_DELAY_MS + 50);
  expect(view.spinner() === null).toBe(false);
  view.rerender("sent");
  expect(view.spinner() === null).toBe(true);
});

test("a bubble that goes back to sending waits the full delay again", async () => {
  fakeClock();
  const view = render("sending");
  await wait(SENDING_INDICATOR_DELAY_MS + 50);
  view.rerender("sent");
  view.rerender("sending");
  expect(view.spinner() === null).toBe(true);
  await wait(SENDING_INDICATOR_DELAY_MS + 50);
  expect(view.spinner() === null).toBe(false);
});

test("an attached image's title names it", () => {
  const { host: container } = mount(
    <UserMessage
      text="see this"
      status="persisted"
      attachments={[{ type: "image", id: "a1", name: "screen.png", mediaType: "image/png", data: "AAAA", sizeBytes: 10 }]}
    />
  );
  const thumb = container.querySelector('[data-slot="user-bubble"] button[data-slot="image-open"]')!;
  expect(thumb.getAttribute("title")).toBe("screen.png");
});

// In a worker's chat every bubble was the manager's, drawn as the user's
// own. Its messages now say whose they are,
// and a long one (a task runs to thousands of characters) is folded.
const classes = (el: Element) => el.className.split(/\s+/).filter(Boolean);
const textOf = (root: ParentNode) => root.querySelector('[data-slot="user-bubble"] [data-slot="bubble-text"]') as HTMLElement;
const foldButton = (root: ParentNode) => root.querySelector<HTMLButtonElement>('[data-slot="bubble-fold"]');

test("a sender is named above the bubble; the user's own message names no one", () => {
  const mine = mount(<UserMessage text="ok" status="persisted" />).host;
  expect(mine.querySelector('[data-slot="sender-label"]') === null).toBe(true);
  const managers = mount(<UserMessage text="ok" status="persisted" sender="Manager" />).host;
  const label = managers.querySelector('[data-slot="sender-label"]')!;
  expect(label.textContent).toBe("Manager");
  const bubble = managers.querySelector('[data-slot="user-bubble"]')!;
  expect(label.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(bubble.contains(label)).toBe(false);
});

test("a folded message shows eight lines and Show more; open, all of it and Show less", () => {
  const toggles: Array<[string, boolean]> = [];
  const draw = (open: boolean) => <UserMessage text={"line\n".repeat(40)} status="persisted" foldKey="fold:m1" foldOpen={open} onFoldChange={(key, next) => toggles.push([key, next])} />;
  const { host, rerender } = mount(draw(false));
  expect(classes(textOf(host))).toContain("line-clamp-8");
  expect(foldButton(host)!.textContent).toBe("Show more");
  expect(foldButton(host)!.getAttribute("aria-expanded")).toBe("false");
  act(() => foldButton(host)!.click());
  expect(toggles).toStrictEqual([["fold:m1", true]]);

  rerender(draw(true));
  expect(classes(textOf(host))).not.toContain("line-clamp-8");
  expect(foldButton(host)!.textContent).toBe("Show less");
  expect(foldButton(host)!.getAttribute("aria-expanded")).toBe("true");
  act(() => foldButton(host)!.click());
  expect(toggles).toStrictEqual([["fold:m1", true], ["fold:m1", false]]);
  // The text itself is whole either way: Copy and the page's own search read it.
  expect(textOf(host).textContent).toBe("line\n".repeat(40));
});

test("a message that does not fold has no button and is never clamped", () => {
  const { host } = mount(<UserMessage text={"line\n".repeat(40)} status="persisted" />);
  expect(foldButton(host) === null).toBe(true);
  expect(classes(textOf(host))).not.toContain("line-clamp-8");
});

test("the transcript labels a relayed message by the agent's name, spoken or typed, and nothing else", async () => {
  const { ChatMessageList } = await import("@/routes/window/chat/ChatMessageList");
  const { newThreadState } = await import("@/store/agent-chat");
  const { useGlobalAgentStore } = await import("@/store/global-agent");
  type Message = import("@/store/agent-chat").AgentMessage;
  useGlobalAgentStore.getState().setAgent({ threadId: "thr_g", name: "Jarvis", named: true, unread: false, voiceConfigured: true, lastVisibleSeq: 0, questions: [] });
  const at = "2026-10-05T10:00:00.000Z";
  const user = (seq: number, text: string, relay?: { spoken: boolean }): Message => ({
    id: `m${seq}`, threadId: "thr_w", seq, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: at,
    content: { type: "text", text, ...(relay ? { relay: { by: "global", spoken: relay.spoken, handoffId: `hof_${seq}` } } : {}) }
  } as unknown as Message);
  const thread = { ...newThreadState(), threadId: "thr_w", loaded: true, messages: [user(1, "typed by me"), user(2, "relayed typed", { spoken: false }), user(3, "relayed spoken", { spoken: true })], oldestSeqLoaded: 1 };
  try {
    const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
    expect([...host.querySelectorAll('[data-slot="relay-label"]')].map((el) => el.textContent)).toEqual(["via Jarvis", "via Jarvis · Voice"]);
    expect(host.textContent).toContain("typed by me");
  } finally {
    useGlobalAgentStore.setState({ agent: null });
  }
});

// A message's mentions of other threads, drawn in its bubble.
describe("mentions", () => {
  afterEach(() => {
    runCleanups();
    act(() => useManagerThreadsStore.setState({ threads: new Map(), archived: [] }));
  });

  const open = (id: string, title: string) =>
    managerThreadDto(id, { title, createdAt: "2026-10-19T00:00:00.000Z", lastActivityAt: "2026-10-19T00:00:00.000Z" });
  const M: Mention = { kind: "thread", id: "thr_errors", label: "Parser errors" };
  const TEXT = "跟进 @Parser errors，有结论告诉我";

  function bubble(text: string, mentions?: Mention[]) {
    const { host } = mount(<MemoryRouter><UserMessage text={text} status="persisted" {...(mentions ? { mentions } : {})} /></MemoryRouter>);
    // Read as strings: a failing match on DOM nodes would try to print them whole.
    return { host, links: () => [...host.querySelectorAll<HTMLAnchorElement>('[data-slot="bubble-text"] a')].map((a) => ({ href: a.getAttribute("href"), text: a.textContent })) };
  }

  test("a sent message draws each mention as a tag that opens its thread", () => {
    act(() => useManagerThreadsStore.setState({ threads: new Map([["thr_errors", open("thr_errors", "Parser errors")]]) }));
    const b = bubble(TEXT, [M]);
    expect(b.links()).toEqual([{ href: "/threads/thr_errors", text: "@Parser errors" }]);
    // Copied, the bubble reads the sentence as written.
    expect(b.host.querySelector('[data-slot="bubble-text"]')!.textContent).toBe(TEXT);
  });

  test("a mention of an archived thread still opens it; of a deleted one is plain text", () => {
    const archived: ArchivedThreadDto = { id: "thr_errors", title: "Parser errors", archivedAt: "2026-10-19T01:00:00.000Z", workers: 0, canvases: 0 };
    act(() => useManagerThreadsStore.setState({ threads: new Map(), archived: [archived] }));
    expect(bubble(TEXT, [M]).links().map((a) => a.href)).toEqual(["/threads/thr_errors"]);
    act(() => useManagerThreadsStore.setState({ threads: new Map(), archived: [] }));
    const gone = bubble(TEXT, [M]);
    expect(gone.links()).toEqual([]);
    expect(gone.host.querySelector('[data-slot="bubble-text"]')!.textContent).toBe(TEXT);
  });

  test("a renamed thread's tag shows the words as sent", () => {
    act(() => useManagerThreadsStore.setState({ threads: new Map([["thr_errors", open("thr_errors", "Parser cleanup")]]) }));
    expect(bubble(TEXT, [M]).links().map((a) => a.text)).toEqual(["@Parser errors"]);
  });

  test("a message without mentions renders as before", () => {
    act(() => useManagerThreadsStore.setState({ threads: new Map([["thr_errors", open("thr_errors", "Parser errors")]]) }));
    const b = bubble(TEXT);
    expect(b.links()).toEqual([]);
    expect(b.host.querySelector('[data-slot="bubble-text"]')!.textContent).toBe(TEXT);
  });

  // A tag is a link inside the sentence's own line: no box of its own (which
  // broke native selection and kept a long title from wrapping), its tint
  // continued across a wrap, and no touch area grown past its text (which
  // covered the tag on the line above). A browser checks the effects (e2e).
  test("a tag stays in the sentence's line: an inline link, no flex box, no enlarged touch area", () => {
    act(() => useManagerThreadsStore.setState({ threads: new Map([["thr_errors", open("thr_errors", "Parser errors")]]) }));
    const { host } = mount(<MemoryRouter><UserMessage text={TEXT} status="persisted" mentions={[M]} /></MemoryRouter>);
    const classes = host.querySelector('[data-slot="mention-tag"]')!.getAttribute("class")!.split(/\s+/);
    for (const absent of ["inline-flex", "flex", "hit", "relative"]) expect([absent, classes.includes(absent)]).toEqual([absent, false]);
    expect(classes).toContain("box-decoration-clone");
  });
});
