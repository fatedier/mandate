import { expect, test } from "bun:test";
import type { AgentMessage } from "@/store/agent-chat";
import { handoffIdsOf } from "@/routes/global/handoff-tools";
import { noticeReplyOf } from "@/routes/global/notice-reply";
import { NO_TEXT_REPLY, type GlobalHandoffDto } from "@shared/api/global-agent";
import { threadNoticeMetadata } from "@shared/thread-notice";

const handoff = (over: Partial<GlobalHandoffDto>): GlobalHandoffDto => ({
  id: "hof_1", kind: "thread", state: "replied", text: "Look into it.", spoken: false, featureId: null, featureName: null,
  ownerThreadTitle: null, threadId: "thr_1", threadTitle: "Search timeout", newThreadTitle: null, reply: null, reason: null,
  stop: "stopped", createdAt: "2026-01-12T14:00:00.000Z", updatedAt: "2026-01-12T14:32:00.000Z", repliedAt: "2026-01-12T14:32:00.000Z", ...over
});
const held = (...rows: GlobalHandoffDto[]) => new Map(rows.map((h) => [h.id, h]));

test("what a thread said when it stopped, and when", () => {
  const reply = noticeReplyOf(["hof_1"], held(handoff({ reply: "3.21 is ready to tag." })));
  expect(reply).toEqual({ state: "said", text: "3.21 is ready to tag.", at: "2026-01-12T14:32:00.000Z" });
});

test("one notice can end several waits: the newest of them that heard something is what the thread said", () => {
  const older = handoff({ id: "hof_a", reply: "First answer.", repliedAt: "2026-01-12T14:32:00.000Z" });
  // Begun after that answer, it heard nothing of its own.
  const newer = handoff({ id: "hof_b", reply: NO_TEXT_REPLY, repliedAt: "2026-01-12T14:32:00.000Z" });
  expect(noticeReplyOf(["hof_a", "hof_b"], held(older, newer))).toEqual({ state: "said", text: "First answer.", at: "2026-01-12T14:32:00.000Z" });
  const heard = { ...newer, reply: "Second answer." };
  expect(noticeReplyOf(["hof_a", "hof_b"], held(older, heard))).toEqual({ state: "said", text: "Second answer.", at: "2026-01-12T14:32:00.000Z" });
});

test("a thread that stopped without writing anything said nothing, and that is not its reply", () => {
  expect(noticeReplyOf(["hof_1"], held(handoff({ reply: NO_TEXT_REPLY })))).toEqual({ state: "silent", reason: null, at: "2026-01-12T14:32:00.000Z" });
});

test("a wait that failed says why when nothing was said, and what was said when something was", () => {
  const failed = handoff({ state: "failed", stop: "failed", reply: null, reason: "It failed." });
  expect(noticeReplyOf(["hof_1"], held(failed))).toEqual({ state: "silent", reason: "It failed.", at: "2026-01-12T14:32:00.000Z" });
  expect(noticeReplyOf(["hof_1"], held({ ...failed, reply: "The build broke on line 12." }))).toEqual({ state: "said", text: "The build broke on line 12.", at: "2026-01-12T14:32:00.000Z" });
});

test("until the page holds the notice's records there is nothing to say yet", () => {
  expect(noticeReplyOf(["hof_1"], held())).toEqual({ state: "loading" });
  // One of two is here and heard nothing: the other may have.
  expect(noticeReplyOf(["hof_a", "hof_b"], held(handoff({ id: "hof_a", reply: NO_TEXT_REPLY })))).toEqual({ state: "loading" });
  // What was heard is known as soon as it is here.
  expect(noticeReplyOf(["hof_a", "hof_b"], held(handoff({ id: "hof_b", reply: "Done." }))).state).toBe("said");
});

test("a record as it stood before its wait ended is not yet the notice's: nothing is said until its ended copy is here", () => {
  // Held from when the page opened; the stop came while the event stream was down.
  const waiting = handoff({ state: "delivered", stop: null, reply: null, repliedAt: null });
  expect(noticeReplyOf(["hof_1"], held(waiting))).toEqual({ state: "loading" });
  expect(noticeReplyOf(["hof_1"], held({ ...waiting, state: "replied", stop: "stopped", reply: "Done.", repliedAt: "2026-01-12T14:32:00.000Z" }))).toEqual({ state: "said", text: "Done.", at: "2026-01-12T14:32:00.000Z" });
});

test("the page reads the records its notices name, beside its cards'", () => {
  const notice = (seq: number, handoffIds: string[]) => ({
    id: `n${seq}`, threadId: "thr_g", seq, role: "user", source: "thread-notice", sourceThreadId: "thr_1", wakeId: null, createdAt: "2026-01-12T14:32:00.000Z",
    content: { type: "text", text: "[Thread notice] …", metadata: threadNoticeMetadata({ handoffIds, kind: "thread", targetThreadId: "thr_1", featureId: null, title: "Search timeout", stop: "stopped", reason: null }) }
  }) as unknown as AgentMessage;
  const call = {
    id: "m1", threadId: "thr_g", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w", createdAt: "2026-01-12T14:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c1", toolName: "send_to_thread", args: {} }] }
  } as unknown as AgentMessage;
  const result = {
    id: "m2", threadId: "thr_g", seq: 2, role: "tool", source: "self", sourceThreadId: null, wakeId: "w", createdAt: "2026-01-12T14:00:00.000Z",
    content: { type: "tool_result", toolCallId: "c1", toolName: "send_to_thread", result: { handoff: { id: "hof_card" } } }
  } as unknown as AgentMessage;
  // A notice whose card is on a page not loaded yet still has its record read.
  expect(handoffIdsOf([notice(3, ["hof_old", "hof_older"])])).toEqual(["hof_old", "hof_older"]);
  expect(handoffIdsOf([call, result, notice(3, ["hof_card", "hof_other"])])).toEqual(["hof_card", "hof_other"]);
  // Words that only look like a notice name no record.
  const plain = { ...notice(4, ["hof_x"]), source: "user", content: { type: "text", text: "[Thread notice] …" } } as unknown as AgentMessage;
  expect(handoffIdsOf([plain])).toEqual([]);
});
