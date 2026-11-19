import { expect, test } from "bun:test";
import { arrivingRows, type ShownRow, type ShownTranscript } from "@/routes/window/chat/arriving-rows";
import type { AgentMessage, PendingMessage } from "@/store/agent-chat-types";

// Which rows rise into place as they arrive: what the store holds that is
// newer than anything loaded before, a message as it is sent, a reply as its
// words start; never history, nor a stored copy taking the place of what
// already showed it.

const message = (seq: number, fields: Partial<AgentMessage> = {}): AgentMessage => ({
  id: `msg-${seq}`, threadId: "thr_release", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
  createdAt: "2026-10-23T09:00:00.000Z", content: { type: "assistant", text: `Reply ${seq}` }, ...fields
} as AgentMessage);
const said = (seq: number, text: string, fields: Partial<AgentMessage> = {}) => message(seq, { role: "user", source: "user", wakeId: null, content: { type: "text", text }, ...fields });
const row = (m: AgentMessage): ShownRow => ({ key: m.id, kind: "message", message: m });
const pendingRow = (localId: string): ShownRow => ({ key: localId, kind: "pending", localId });
const streamRow = (wakeId: string): ShownRow => ({ key: `streaming-${wakeId}`, kind: "stream", wakeId });
const pendingOf = (localId: string, content: string, over: Partial<PendingMessage> = {}): PendingMessage => ({ localId, content, status: "sent", createdAt: "2026-10-23T09:00:00.000Z", ...over });
const shown = (rows: ShownRow[], over: Partial<ShownTranscript> = {}): ShownTranscript => ({
  threadId: "thr_release", rows, newestSeq: Math.max(0, ...rows.flatMap((r) => (r.kind === "message" ? [r.message.seq] : []))),
  pending: new Map(), streamedWords: null, voiceWords: { user: false, assistant: false }, ...over
});

test("what it opened with is drawn, not arrived; another conversation too", () => {
  expect(arrivingRows(null, shown([row(message(1)), row(message(2))]))).toEqual([]);
  expect(arrivingRows(shown([row(message(1))]), shown([row(message(1)), row(message(2))], { threadId: "thr_cache" }))).toEqual([]);
});

test("stored rows newer than anything loaded before arrive; older ones loaded, or brought into view, do not", () => {
  const before = shown([row(message(5)), row(message(6))]);
  expect(arrivingRows(before, shown([row(message(5)), row(message(6)), row(message(7))]))).toEqual(["msg-7"]);
  expect(arrivingRows(before, shown([row(message(3)), row(message(4)), row(message(5)), row(message(6))]))).toEqual([]);
  // A page of nothing drawn (silent replies), then older history drawn: history.
  expect(arrivingRows(shown([], { newestSeq: 9 }), shown([row(message(2)), row(message(3))], { newestSeq: 9 }))).toEqual([]);
  // Nothing in common with what showed (the oldest trimmed away, a run keyed anew), yet newer: it arrived.
  expect(arrivingRows(shown([row(message(501))], { newestSeq: 502 }), shown([row(message(503))], { newestSeq: 503 }))).toEqual(["msg-503"]);
});

test("a message sent arrives wherever it is drawn, even above a reply still streaming", () => {
  const before = shown([row(message(1)), streamRow("w1")]);
  expect(arrivingRows(before, shown([row(message(1)), pendingRow("local-1"), streamRow("w1")]))).toEqual(["local-1"]);
});

test("the stored copy of a stand-in drawn just before does not arrive again; another message in the same update does", () => {
  const pending = new Map([["local-1", pendingOf("local-1", "Tag 3.21 today.", { messageId: "msg-2" })]]);
  const before = shown([row(said(1, "Check the build.")), pendingRow("local-1")], { pending });
  const mine = said(2, "Tag 3.21 today.");
  const theirs = said(3, "Also bump the changelog.", { id: "msg-other-tab" });
  expect(arrivingRows(before, shown([row(said(1, "Check the build.")), row(mine), row(theirs)]))).toEqual(["msg-other-tab"]);
  // Matched by the request id too, before the server's id is known.
  const early = new Map([["local-2", pendingOf("local-2", "Ship it.")]]);
  const sent = said(4, "Ship it.", { content: { type: "text", text: "Ship it.", clientRequestId: "local-2" } } as Partial<AgentMessage>);
  expect(arrivingRows(shown([pendingRow("local-2")], { pending: early, newestSeq: 3 }), shown([row(sent)]))).toEqual([]);
});

test("a queued message, out of the transcript while it waits, rises as it is delivered", () => {
  const pending = new Map([["local-1", pendingOf("local-1", "After this, run the tests.", { status: "queued", messageId: "msg-2" })]]);
  const before = shown([row(said(1, "Check the build."))], { pending });
  expect(arrivingRows(before, shown([row(said(1, "Check the build.")), row(said(2, "After this, run the tests."))]))).toEqual(["msg-2"]);
});

test("the stored reply that replaces words shown streaming does not arrive again; a reply after a stream with no words does", () => {
  const streamed = shown([row(message(1)), streamRow("w1")], { streamedWords: "w1" });
  expect(arrivingRows(streamed, shown([row(message(1)), row(message(2))]))).toEqual([]);
  // The stream started over empty (another provider took the turn) and the reply is calls only.
  const calls = message(2, { content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c1", toolName: "bash", args: { command: "bun test" } }] } } as Partial<AgentMessage>);
  expect(arrivingRows(shown([row(message(1)), streamRow("w1")]), shown([row(message(1)), row(calls)]))).toEqual(["msg-2"]);
  // Words shown, then a stored row of calls only in their place: the calls are new.
  expect(arrivingRows(streamed, shown([row(message(1)), row(calls)]))).toEqual(["msg-2"]);
  // Another turn's reply arrives.
  expect(arrivingRows(streamed, shown([row(message(1)), streamRow("w1"), row(message(2, { wakeId: "w2" }))]))).toEqual(["msg-2"]);
});

test("a voice line's stored copy does not arrive again once its words were shown as they were spoken", () => {
  const spoken = shown([row(message(1))], { voiceWords: { user: true, assistant: true } });
  const heard = said(2, "What failed?", { source: "voice" });
  const answered = message(3, { source: "voice" });
  expect(arrivingRows(spoken, shown([row(message(1)), row(heard), row(answered)]))).toEqual([]);
  // A call the voice made is no copy of the words spoken: it arrives.
  const called = message(4, { source: "voice", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "v1", toolName: "bash", args: { command: "bun test" } }] } } as Partial<AgentMessage>);
  expect(arrivingRows(spoken, shown([row(message(1)), row(called)]))).toEqual(["msg-4"]);
  expect(arrivingRows(shown([row(message(1))]), shown([row(message(1)), row(answered)]))).toEqual(["msg-3"]);
});
