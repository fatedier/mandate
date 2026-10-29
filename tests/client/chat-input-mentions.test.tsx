import { afterEach, expect, test } from "bun:test";
import { act, Profiler } from "react";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useWakeActivityStore } from "@/store/wake-activity";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useMonitorActivityStore } from "@/store/monitor-activity";
import { useThreadStatusStore } from "@/store/thread-status";
import type { AgentChatScope } from "@/store/agent-chat";
import type { AgentCommandDto, ArchivedThreadDto, ManagerThreadDto } from "@shared/api/agents";
import type { Mention } from "@shared/mentions";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync } from "../helpers/mount.js";
import { managerThreadDto } from "../helpers/client-builders.js";

afterEach(() => {
  runCleanups();
  act(() => useManagerThreadsStore.setState({ threads: new Map(), archived: [] }));
});

const thread = (id: string, title: string, lastActivityAt: string) => managerThreadDto(id, { title, createdAt: lastActivityAt, lastActivityAt });
const ERRORS = thread("thr_errors", "Parser errors", "2026-10-19T05:00:00.000Z");
const SPEED = thread("thr_speed", "Parser speed", "2026-10-18T05:00:00.000Z");
const GENERAL = thread("thr_general", "General", "2026-10-17T05:00:00.000Z");
const ARCHIVED: ArchivedThreadDto = { id: "thr_old", title: "Parser archived", archivedAt: "2026-10-01T00:00:00.000Z", workers: 0, canvases: 0 };
const mention = (t: ManagerThreadDto): Mention => ({ kind: "thread", id: t.id, label: t.title });

async function composer(opts: { mentions?: { excludeId: string | null } | null; scope?: AgentChatScope; commands?: AgentCommandDto[] } = {}) {
  // Kept in no particular order: the list sorts by last activity itself.
  act(() => useManagerThreadsStore.setState({ threads: new Map([GENERAL, SPEED, ERRORS].map((t) => [t.id, t])), archived: [ARCHIVED] }));
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const sent: Array<{ content: string; mentions: Mention[] }> = [];
  let renders = 0;
  const node = (scope: AgentChatScope | undefined) => (
    <Profiler id="composer" onRender={() => { renders += 1; }}>
    <ChatInput
      scope={scope}
      onSend={(content, _attachments, mentions) => { sent.push({ content, mentions: mentions ?? [] }); }}
      mentions={opts.mentions === null ? undefined : opts.mentions ?? { excludeId: null }}
      commands={opts.commands}
      commandState="idle"
      onCommand={async () => true}
    />
    </Profiler>
  );
  const { host, rerender } = await mountAsync(node(opts.scope));
  const show = (scope: AgentChatScope) => rerender(node(scope));
  const textarea = () => host.getElementsByTagName("textarea")[0]!;
  /** Types the whole draft, with the caret where a person left it (or what
   *  the edit wrote left selected, as a drop does: caret..end). */
  const type = async (text: string, caret = text.length, end = caret) => {
    await act(async () => {
      const ta = textarea();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")!.set!.call(ta, text);
      ta.setSelectionRange(caret, end);
      ta.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    });
  };
  const key = async (name: string, init: KeyboardEventInit = {}) => {
    await act(async () => {
      textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="mention-list"] [role="option"]')];
  const list = () => rows().map((row) => `${row.querySelector('[data-slot="mention-title"]')!.textContent}${row.getAttribute("aria-selected") === "true" ? "*" : ""}`);
  return { textarea, type, key, rows, list, sent, show, renders: () => renders };
}

test("typing @Parser lists the matching open threads, newest first, under Threads", async () => {
  const c = await composer();
  await c.type("Follow up on @Parser");
  expect(c.list()).toEqual(["Parser errors*", "Parser speed"]);
  expect(document.querySelector('[data-slot="mention-list"] [role="group"]')!.getAttribute("aria-label")).toBe("Threads");
  // The row a screen reader is on is the textarea's active descendant.
  expect(c.textarea().getAttribute("aria-activedescendant")).toBe(c.rows()[0]!.id);
  await c.key("ArrowDown");
  expect(c.list()).toEqual(["Parser errors", "Parser speed*"]);
  // An empty query lists every open thread.
  await c.type("@");
  expect(c.list()).toEqual(["Parser errors*", "Parser speed", "General"]);
});

test("the conversation being typed in is not listed", async () => {
  const c = await composer({ mentions: { excludeId: ERRORS.id } });
  await c.type("@Parser");
  expect(c.list()).toEqual(["Parser speed*"]);
});

test("Enter picks: the query becomes \"@<title>\" and one space, with the text after the caret kept", async () => {
  const c = await composer();
  await c.type("Follow up on @Parser");
  await c.key("Enter");
  expect([c.textarea().value, c.list(), c.sent]).toEqual(["Follow up on @Parser errors ", [], []]);
  await c.type("Follow up on @Parser then", "Follow up on @Parser".length);
  await c.key("Enter");
  expect(c.textarea().value).toBe("Follow up on @Parser errors then");
  expect(c.textarea().selectionStart).toBe("Follow up on @Parser errors ".length);
  await c.type("跟进 @Parser然后", "跟进 @Parser".length);
  await c.key("Tab");
  expect(c.textarea().value).toBe("跟进 @Parser errors 然后");
});

test("Esc closes the list until the next keystroke", async () => {
  const c = await composer();
  await c.type("@Parser");
  await c.key("Escape");
  expect(c.list()).toEqual([]);
  await c.type("@Parse");
  expect(c.list()).toEqual(["Parser errors*", "Parser speed"]);
});

test("while an IME composes the list shows but Enter does not pick", async () => {
  const c = await composer();
  await c.type("@Parser");
  await c.key("Enter", { isComposing: true });
  expect([c.textarea().value, c.list()]).toEqual(["@Parser", ["Parser errors*", "Parser speed"]]);
});

test("nothing matching shows no list", async () => {
  const c = await composer();
  await c.type("@zzz");
  expect(document.querySelector('[data-slot="mention-list"]') === null).toBe(true);
});

test("the send carries the picks still written, in order", async () => {
  const c = await composer();
  // Picked, then its title edited: plain words.
  await c.type("Follow up on @Parser");
  await c.key("Enter");
  await c.type("Follow up on @Parser erro");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "Follow up on @Parser erro", mentions: [] });
  // Two picks, both written.
  await c.type("@Parser");
  await c.key("Enter");
  await c.type("@Parser errors and @Gen");
  await c.key("Enter");
  expect(c.textarea().value).toBe("@Parser errors and @General ");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Parser errors and @General", mentions: [mention(ERRORS), mention(GENERAL)] });
  // A title typed by hand, never picked: words.
  await c.type("@General hi");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@General hi", mentions: [] });
});

test("each conversation keeps its own picks", async () => {
  const a: AgentChatScope = { type: "manager", threadId: "thr_a" };
  const b: AgentChatScope = { type: "manager", threadId: "thr_b" };
  const c = await composer({ scope: a });
  await c.type("@Parser");
  await c.key("Enter");
  await act(async () => c.show(b));
  expect(c.textarea().value).toBe("");
  // Another conversation has none of A's picks: the title typed by hand is words.
  await c.type("@Parser errors hi");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Parser errors hi", mentions: [] });
  await act(async () => c.show(a));
  expect(c.textarea().value).toBe("@Parser errors ");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Parser errors", mentions: [mention(ERRORS)] });
});

test("a draft emptied by hand drops its picks: a title typed again is words", async () => {
  const c = await composer();
  await c.type("@Parser");
  await c.key("Enter");
  await c.type("");
  await c.type("@Parser errors hi");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Parser errors hi", mentions: [] });
});

test("no @ list without the mentions prop (a worker's composer)", async () => {
  const c = await composer({ mentions: null });
  await c.type("@Parser");
  expect(document.querySelector('[data-slot="mention-list"]') === null).toBe(true);
});

test("a pick that leaves the text as it was still puts the caret after the space, and nothing moves it later", async () => {
  const c = await composer();
  const text = "before @General after";
  await c.type(text, "before @General".length);
  await c.key("Enter");
  expect(c.textarea().value).toBe(text);
  expect(c.textarea().selectionStart).toBe("before @General ".length);
  // Typing on at the end leaves the caret at the end.
  await c.type(`${text}!`);
  expect(c.textarea().selectionStart).toBe(text.length + 1);
});

test("a command that empties the draft drops its picks: a title typed afterwards is words", async () => {
  const c = await composer({ commands: [{ name: "/context", description: "Show how much context is in use", blocked: {} }] });
  await c.type("@Parser");
  await c.key("Enter");
  await c.type("/context");
  await c.key("Enter");
  await c.key("Enter");
  expect(c.textarea().value).toBe("");
  await c.type("@Parser errors hi");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Parser errors hi", mentions: [] });
});

test("two threads of one title picked out of text order still each name the thread picked for their place", async () => {
  const c = await composer();
  const older = thread("thr_same_old", "Same", "2026-10-10T00:00:00.000Z");
  const newer = thread("thr_same_new", "Same", "2026-10-12T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [older.id, older], [newer.id, newer]]) })));
  // "keep @Same" names the newer one.
  await c.type("keep @Sa");
  await c.key("Enter");
  expect(c.textarea().value).toBe("keep @Same ");
  // Back at the start, "archive @Same" names the older one.
  await c.type("archive @Sa keep @Same ", "archive @Sa".length);
  await c.key("ArrowDown");
  await c.key("Enter");
  expect(c.textarea().value).toBe("archive @Same keep @Same ");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "archive @Same keep @Same", mentions: [mention(older), mention(newer)] });
});

// Two threads of one title: an edit to the first mention and a pick again
// there leaves the second naming the thread picked for it.
test("a mention edited and picked again keeps the other same-title mention on its own thread", async () => {
  const c = await composer();
  const a = thread("thr_same_a", "Same", "2026-10-12T00:00:00.000Z");
  const b = thread("thr_same_b", "Same", "2026-10-10T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [a.id, a], [b.id, b]]) })));
  await c.type("keep @Sa");
  await c.key("Enter");
  await c.type("keep @Same archive @Sa");
  await c.key("ArrowDown");
  await c.key("Enter");
  expect(c.textarea().value).toBe("keep @Same archive @Same ");
  // "me" deleted from the first; picked again (a) there.
  await c.type("keep @Sa archive @Same ", "keep @Sa".length);
  await c.key("Enter");
  expect(c.textarea().value).toBe("keep @Same archive @Same ");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "keep @Same archive @Same", mentions: [mention(a), mention(b)] });
});

test("many mentions before two same-title ones do not change which thread each names", async () => {
  const c = await composer();
  const a = thread("thr_same_a", "Same", "2026-10-12T00:00:00.000Z");
  const b = thread("thr_same_b", "Same", "2026-10-10T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [a.id, a], [b.id, b]]) })));
  let draft = "";
  for (let i = 0; i < 10; i++) {
    await c.type(`${draft}@Gen`);
    await c.key("Enter");
    draft = c.textarea().value;
  }
  await c.type(`${draft}keep @Sa`);
  await c.key("Enter");
  await c.type(`${c.textarea().value}archive @Sa`);
  await c.key("ArrowDown");
  await c.key("Enter");
  // The ten General mentions deleted by hand: the two Same keep their threads.
  const rest = c.textarea().value.slice(draft.length);
  await c.type(rest, 0);
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "keep @Same archive @Same", mentions: [mention(a), mention(b)] });
});

const GENERAL_NOTES = thread("thr_general_notes", "General notes", "2026-10-16T00:00:00.000Z");

test("cutting the first of two mentions whose words repeat leaves the second on its own thread", async () => {
  const c = await composer();
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [GENERAL_NOTES.id, GENERAL_NOTES]]) })));
  await c.type("@General");
  await c.key("Enter");
  await c.type("@General @General");
  await c.key("ArrowDown");
  await c.key("Enter");
  expect(c.textarea().value).toBe("@General @General notes ");
  // The first "@General " cut: the caret lands at the start.
  await c.type("@General notes ", 0);
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@General notes", mentions: [mention(GENERAL_NOTES)] });
});

test("picking a longer title over a mention reopened at its end replaces it", async () => {
  const c = await composer();
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [GENERAL_NOTES.id, GENERAL_NOTES]]) })));
  await c.type("@General");
  await c.key("Enter");
  // Its trailing space deleted: the caret is in the mention again.
  await c.type("@General");
  expect(c.list()).toEqual(["General*", "General notes"]);
  await c.key("ArrowDown");
  await c.key("Enter");
  expect(c.textarea().value).toBe("@General notes ");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@General notes", mentions: [mention(GENERAL_NOTES)] });
});

test("words pasted between two same-title mentions leave each on its own thread", async () => {
  const c = await composer();
  const a = thread("thr_same_a", "Same", "2026-10-12T00:00:00.000Z");
  const b = thread("thr_same_b", "Same", "2026-10-10T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [a.id, a], [b.id, b]]) })));
  await c.type("@Sa");
  await c.key("Enter");
  await c.type("@Same @Sa");
  await c.key("ArrowDown");
  await c.key("Enter");
  expect(c.textarea().value).toBe("@Same @Same ");
  // "@Same " pasted between them: the caret lands after the pasted words.
  await c.type("@Same @Same @Same ", 12);
  // The last one (b's) deleted: what was pasted is words, a still names a.
  await c.type("@Same @Same ", 12);
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Same @Same", mentions: [mention(a)] });
});

test("words dropped between two same-title mentions, left selected, leave each on its own thread", async () => {
  const c = await composer();
  const a = thread("thr_same_a", "Same", "2026-10-12T00:00:00.000Z");
  const b = thread("thr_same_b", "Same", "2026-10-10T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [a.id, a], [b.id, b]]) })));
  await c.type("@Sa");
  await c.key("Enter");
  await c.type("@Same @Sa");
  await c.key("ArrowDown");
  await c.key("Enter");
  // "@Same " dropped between them: the dropped words are left selected.
  await c.type("@Same @Same @Same ", 6, 12);
  // The first one (a's) deleted: b still names b.
  await c.type("@Same @Same ", 0);
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Same @Same", mentions: [mention(b)] });
});

test("a mention whose words were edited stays words when they are typed back", async () => {
  const c = await composer();
  await c.type("@Gen");
  await c.key("Enter");
  // Its last letter typed over, then typed over again with what it was.
  await c.type("@Generax ", 8);
  await c.type("@General ", 8);
  // The caret is in "@General" again: the list is open; closed, Enter sends.
  await c.key("Escape");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@General", mentions: [] });
});

test("mentions right beside a new pick's @ keep their threads", async () => {
  const c = await composer();
  const release = thread("thr_release", "Release 计划", "2026-10-11T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [release.id, release]]) })));
  await c.type("@Rel");
  await c.key("Enter");
  // Its space deleted and an @ typed right after it (计划 is no ASCII letter, so the list opens).
  await c.type("@Release 计划@Gen");
  await c.key("Enter");
  expect(c.textarea().value).toBe("@Release 计划@General ");
  // An @ typed right before it, at the start.
  await c.type("@Gen@Release 计划@General ", 4);
  await c.key("Enter");
  expect(c.textarea().value).toBe("@General @Release 计划@General ");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@General @Release 计划@General", mentions: [mention(GENERAL), mention(release), mention(GENERAL)] });
});

test("a picked title that repeats the words after its @ still moves the mentions after it", async () => {
  const c = await composer();
  await c.type("Review @Gen");
  await c.key("Enter");
  expect(c.textarea().value).toBe("Review @General ");
  const review = thread("thr_review", "Review @General", "2026-10-20T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [review.id, review]]) })));
  // An @ typed at the start, and "Review @General" (the newest) picked for it.
  await c.type("@Review @General ", 1);
  await c.key("Enter");
  expect(c.textarea().value).toBe("@Review @General Review @General ");
  // Only the new mention's words edited: the General one after it stands.
  await c.type("@Review @Generax Review @General ", 16);
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Review @Generax Review @General", mentions: [mention(GENERAL)] });
});

test("a title with doubled spaces or a tab is written and sent on one line, as the server keeps it", async () => {
  const c = await composer();
  const spaced = thread("thr_spaced", "Parser  test\tplan", "2026-10-20T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [spaced.id, spaced]]) })));
  await c.type("@Parser");
  await c.key("Enter");
  expect(c.textarea().value).toBe("@Parser test plan ");
  await c.key("Enter");
  expect(c.sent.at(-1)).toEqual({ content: "@Parser test plan", mentions: [{ kind: "thread", id: spaced.id, label: "Parser test plan" }] });
});

test("a composer redraws for thread and worker changes only while an @ is being typed", async () => {
  const c = await composer();
  // Every store the list's rows read, each given a new value (and put back after).
  const stores = [
    [useWakeActivityStore, "activeByFeatureId", () => new Map()],
    [useProjectsStore, "projects", () => []],
    [useWorkItemsStore, "items", () => new Map()],
    [useFeaturePlansStore, "plans", () => new Map()],
    [useMonitorActivityStore, "waitingByThread", () => new Map()],
    [useThreadStatusStore, "states", () => new Map()]
  ] as const;
  for (const [store, field] of stores) {
    const saved = (store.getState() as unknown as Record<string, unknown>)[field];
    onCleanup(() => act(() => (store as unknown as { setState(v: object): void }).setState({ [field]: saved })));
  }
  const quiet = c.renders();
  const later = thread("thr_later", "Parser later", "2026-10-21T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [later.id, later]]) })));
  for (const [store, field, fresh] of stores) {
    act(() => (store as unknown as { setState(v: object): void }).setState({ [field]: fresh() }));
    expect([field, c.renders()]).toEqual([field, quiet]);
  }
  // While the list is open it follows them: a thread made meanwhile is listed.
  await c.type("@Parser");
  const another = thread("thr_another", "Parser another", "2026-10-22T00:00:00.000Z");
  act(() => useManagerThreadsStore.setState((s) => ({ threads: new Map([...s.threads, [another.id, another]]) })));
  expect(c.list()).toEqual(["Parser another*", "Parser later", "Parser errors", "Parser speed"]);
});
