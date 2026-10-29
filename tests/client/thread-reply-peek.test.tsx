import { act } from "react";
import { afterEach, expect, test } from "bun:test";
import { mount } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../fake-phone-width.js";
import { ThreadReplyPeek } from "@/routes/global/ThreadReplyPeek";
import type { NoticeReplyRef } from "@/routes/window/chat/chatProvenance";
import { useGlobalAgentStore } from "@/store/global-agent";
import { formatClockMinutes } from "@/lib/format";
import { NO_TEXT_REPLY, type GlobalHandoffDto } from "@shared/api/global-agent";

afterEach(() => {
  runCleanups();
  useGlobalAgentStore.setState({ handoffs: new Map() });
});

const AT = "2026-01-12T14:32:00.000Z";
const handoff = (over: Partial<GlobalHandoffDto> = {}): GlobalHandoffDto => ({
  id: "hof_1", kind: "thread", state: "replied", text: "Look into it.", spoken: false, featureId: null, featureName: null,
  ownerThreadTitle: null, threadId: "thr_1", threadTitle: "Search timeout", newThreadTitle: null, reply: "**3.21** is ready to tag.", reason: null,
  stop: "stopped", createdAt: "2026-01-12T14:00:00.000Z", updatedAt: AT, repliedAt: AT, ...over
});
const hold = (...rows: GlobalHandoffDto[]) => act(() => { useGlobalAgentStore.setState({ handoffs: new Map(rows.map((h) => [h.id, h])) }); });
const thread: NoticeReplyRef = { handoffIds: ["hof_1"], kind: "thread", stop: "stopped" };
const peek = (reply = thread, href = "/threads/thr_1") => mount(<ThreadReplyPeek title="Search timeout" href={href} reply={reply} />, { path: "/agent" });
const box = () => document.querySelector<HTMLElement>('[data-slot="thread-reply"]');
const open = (host: HTMLElement) => act(() => { host.querySelector<HTMLElement>('[data-slot="notice-name"]')!.click(); });
const text = (slot: string) => box()?.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;

test("a click on the name opens what the thread said: its name, how it stopped and when, its reply as written, and the way to it", () => {
  hold(handoff());
  const { host } = peek();
  expect(box() === null).toBe(true);
  open(host);
  expect(box() !== null).toBe(true);
  expect(text("thread-reply-title")).toBe("Search timeout");
  expect(text("thread-reply-state")).toBe(`stopped · ${formatClockMinutes(AT)}`);
  // Drawn as the chat draws a reply, not as its source.
  const body = box()!.querySelector('[data-slot="thread-reply-body"]')!;
  expect([body.querySelector("strong")?.textContent, body.textContent]).toEqual(["3.21", "3.21 is ready to tag."]);
  const go = box()!.querySelector('[data-slot="thread-reply-go"]')!;
  expect([go.tagName, go.textContent, go.getAttribute("href")]).toEqual(["A", "Open thread", "/threads/thr_1"]);
});

test("a worker's name opens what the worker said, and leads to the worker", () => {
  hold(handoff({ kind: "feature", featureId: "feat_1", stop: "needs_you", reply: "Which branch?" }));
  const { host } = peek({ handoffIds: ["hof_1"], kind: "feature", stop: "needs_you" }, "/projects/p/features/login?tab=chat");
  open(host);
  expect(text("thread-reply-state")).toBe(`needs you · ${formatClockMinutes(AT)}`);
  const go = box()!.querySelector('[data-slot="thread-reply-go"]')!;
  expect([go.textContent, go.getAttribute("href")]).toEqual(["Open worker", "/projects/p/features/login?tab=chat"]);
});

test("a thread that stopped without writing says so; one whose wait failed says why", () => {
  hold(handoff({ reply: NO_TEXT_REPLY, stop: "stopped" }));
  const silent = peek({ ...thread, stop: "stopped" });
  open(silent.host);
  expect(text("thread-reply-body")).toBe("It stopped without a reply.");
  silent.unmount();
  hold(handoff({ state: "failed", stop: "failed", reply: null, reason: "Its turn failed twice." }));
  const failed = peek({ ...thread, stop: "failed" });
  open(failed.host);
  expect(text("thread-reply-body")).toBe("Its turn failed twice.");
});

test("opened before the page holds the record, it says it is loading, and shows the reply when the record arrives", () => {
  const { host } = peek();
  open(host);
  expect(box()!.querySelector('[data-slot="loading-line"]') !== null).toBe(true);
  // No time to give yet: the state alone.
  expect(text("thread-reply-state")).toBe("stopped");
  hold(handoff());
  expect(box()!.querySelector('[data-slot="loading-line"]') === null).toBe(true);
  expect(box()!.querySelector('[data-slot="thread-reply-body"]')!.textContent).toBe("3.21 is ready to tag.");
});

test("on a phone the reply rises in the sheet, with the way to the thread in its header", () => {
  onCleanup(fakePhoneWidth());
  hold(handoff());
  const { host } = peek();
  open(host);
  const sheet = box()!;
  // The sheet, not the box at the name: the app's bottom sheet holds a body of its own.
  expect(sheet.querySelector('[data-slot="bottom-sheet-body"]') !== null).toBe(true);
  expect(sheet.querySelector('[data-slot="thread-reply-body"]')!.textContent).toBe("3.21 is ready to tag.");
  const go = sheet.querySelector('[data-slot="thread-reply-go"]')!;
  expect([go.textContent, go.getAttribute("href")]).toEqual(["Open thread", "/threads/thr_1"]);
  // Above the body, which does not scroll until the sheet is pulled up.
  expect(sheet.querySelector('[data-slot="bottom-sheet-body"]')!.contains(go)).toBe(false);
});

test("with a mouse the reply is a box at the name, not the sheet", () => {
  hold(handoff());
  const { host } = peek();
  open(host);
  expect(box()!.querySelector('[data-slot="bottom-sheet-body"]') === null).toBe(true);
  expect(box()!.getAttribute("role")).toBe("dialog");
});
