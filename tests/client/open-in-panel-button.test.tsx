import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { toast } from "sonner";
import type { ReplyTabDto } from "../../src/shared/api-contracts.js";
import { OpenInPanelButton } from "../../src/client/routes/reply-tabs/OpenInPanelButton.js";
import { ReplyTabTargetContext, type ReplyTabTarget } from "../../src/client/routes/reply-tabs/reply-tab-target.js";
import { RowFrame } from "../../src/client/routes/window/chat/TranscriptRowFrame.js";
import { replyTabId } from "../../src/client/lib/panel-tabs.js";
import { useReplyTabsStore } from "../../src/client/store/reply-tabs.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settleRounds, settleUntil } from "../helpers/mount.js";

// A reply's action line opens the reply in the right panel: the first click
// adds it on the server and opens its tab; once it has one, the click shows it.

afterEach(() => {
  runCleanups();
  useReplyTabsStore.setState({ byThread: new Map(), latest: new Map(), applied: new Map() });
});

const tab = (id: string, messageId: string): ReplyTabDto => ({
  id, threadId: "thr_1", messageId, text: `Reply ${messageId}`, repliedAt: "2026-10-29T12:00:00.000Z", createdAt: "2026-10-29T12:01:00.000Z"
});

function serve(initial: ReplyTabDto[], options: { hold?: boolean; refuse?: boolean } = {}) {
  let tabs = initial;
  let release: (() => void) | null = null;
  const calls = mockFetch((call) => {
    if (call.method !== "POST") return jsonResponse({ tabs });
    if (options.refuse) return jsonResponse({ error: "reply not found in this thread" }, 404);
    tabs = [...tabs, tab("rtab_new", "msg_1")];
    const answer = jsonResponse({ tabs });
    return options.hold ? new Promise<Response>((resolve) => { release = () => resolve(answer); }) : answer;
  });
  return { calls, release: () => release?.() };
}

function target(): ReplyTabTarget & { opened: string[] } {
  const opened: string[] = [];
  return { threadId: "thr_1", open: (tabId) => { opened.push(tabId); }, opened };
}

const posts = (calls: FetchCall[]) => calls.filter((c) => c.method === "POST").length;
const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-slot="open-in-panel"]');

async function render(to: ReplyTabTarget | null) {
  return mountAsync(
    <ReplyTabTargetContext.Provider value={to}>
      <OpenInPanelButton messageId="msg_1" text="**Release check**: two of three ready." />
    </ReplyTabTargetContext.Provider>
  );
}

test("Open in panel adds the reply and opens its tab", async () => {
  const { calls } = serve([]);
  const to = target();
  const m = await render(to);
  await settleUntil(() => button(m.host)?.getAttribute("aria-label") === "Open in panel", "the button reads Open in panel");
  await act(async () => { button(m.host)!.click(); });
  await settleUntil(() => to.opened.length === 1, "its tab opened");
  expect(to.opened).toEqual([replyTabId("rtab_new")]);
  expect(JSON.parse(String(calls.find((c) => c.method === "POST")!.init?.body))).toEqual({ messageId: "msg_1", text: "**Release check**: two of three ready." });
  await settleUntil(() => button(m.host)?.getAttribute("aria-label") === "Show in panel", "the button reads Show in panel");
});

test("Show in panel when the reply has a tab: opens it, adds nothing", async () => {
  const { calls } = serve([tab("rtab_7", "msg_1")]);
  const to = target();
  const m = await render(to);
  await settleUntil(() => button(m.host)?.getAttribute("aria-label") === "Show in panel", "the button reads Show in panel");
  // Not a toggle: pressing it again shows the tab, it never un-presses.
  expect(button(m.host)!.hasAttribute("aria-pressed")).toBe(false);
  await act(async () => { button(m.host)!.click(); });
  expect(to.opened).toEqual([replyTabId("rtab_7")]);
  expect(posts(calls)).toBe(0);
});

test("a click while an add is on its way sends nothing more", async () => {
  const server = serve([], { hold: true });
  const to = target();
  const m = await render(to);
  await settleUntil(() => button(m.host)?.getAttribute("aria-label") === "Open in panel", "the button reads Open in panel");
  await act(async () => { button(m.host)!.click(); });
  await act(async () => { button(m.host)!.click(); });
  await settleRounds();
  expect(posts(server.calls)).toBe(1);
  await act(async () => { server.release(); });
  await settleUntil(() => to.opened.length === 1, "its tab opened once");
  expect(to.opened).toEqual([replyTabId("rtab_new")]);
});

test("no button without a target", async () => {
  serve([]);
  const m = await render(null);
  await settleRounds();
  expect(button(m.host) === null).toBe(true);
});

test("a refused add shows the toast and opens nothing", async () => {
  serve([], { refuse: true });
  const shown: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => { shown.push(String(message)); return 0; }) as typeof toast.error;
  onCleanup(() => { toast.error = original; });
  const to = target();
  const m = await render(to);
  await settleUntil(() => button(m.host)?.getAttribute("aria-label") === "Open in panel", "the button reads Open in panel");
  await act(async () => { button(m.host)!.click(); });
  await settleUntil(() => shown.length === 1, "the toast showed");
  expect(shown).toEqual(["Couldn't open it in the panel: reply not found in this thread"]);
  expect(to.opened).toEqual([]);
});

test("an older reply's action line stays shown while the reply has a tab", async () => {
  serve([tab("rtab_7", "msg_1")]);
  const line = (host: HTMLElement) => host.querySelector('[data-slot="row-actions"]')!;
  const actions = { side: "start" as const, copy: "Reply msg_1", at: "2026-10-29T12:00:00.000Z", label: null, workedMs: null, latest: false, deleteId: null };
  const frame = (messageId: string) => (
    <ReplyTabTargetContext.Provider value={target()}>
      <RowFrame rowKey={messageId} at={null} actions={{ ...actions, messageId }}><p>Reply</p></RowFrame>
    </ReplyTabTargetContext.Provider>
  );
  const kept = await mountAsync(frame("msg_1"));
  await settleUntil(() => button(kept.host)?.getAttribute("aria-label") === "Show in panel", "the reply has its tab");
  expect(line(kept.host).classList.contains("opacity-0")).toBe(false);
  const other = await mountAsync(frame("msg_2"));
  await settleUntil(() => button(other.host)?.getAttribute("aria-label") === "Open in panel", "the other reply has none");
  expect(line(other.host).classList.contains("opacity-0")).toBe(true);
});
