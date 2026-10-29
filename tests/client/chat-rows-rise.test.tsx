import { afterEach, expect, test } from "bun:test";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { newThreadState, type ThreadState } from "@/store/agent-chat";
import type { AgentMessage } from "@/store/agent-chat-types";
import type { VoiceTranscriptLine } from "@/store/voice";
import { runCleanups } from "../helpers/cleanup.js";
import { recordAnimations, reducedMotion } from "../helpers/motion.js";
import { mountAsync, settle } from "../helpers/mount.js";

// Rows that arrive in a chat rise into place (6px up, fading in); what it
// opened with, and a stored copy taking the place of what showed it already,
// do not move.

afterEach(runCleanups);

let seq = 0;
const message = (fields: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage => {
  seq += 1;
  return {
    id: `msg-${seq}`, threadId: "thr-release", seq, source: fields.role === "user" ? "user" : "self", sourceThreadId: null, wakeId: null,
    createdAt: `2026-10-23T09:${String(seq).padStart(2, "0")}:00.000Z`, ...fields
  } as AgentMessage;
};
const asked = (text: string) => message({ role: "user", content: { type: "text", text } });
const replied = (text: string, wakeId: string) => message({ role: "assistant", wakeId, content: { type: "assistant", text } });
const thread = (messages: AgentMessage[], over: Partial<ThreadState> = {}): ThreadState => ({
  ...newThreadState(), threadId: "thr-release", messages, oldestSeqLoaded: messages[0]?.seq ?? 1, ...over
});

type Voice = { user: VoiceTranscriptLine | null; assistant: VoiceTranscriptLine | null };
const list = (thread: ThreadState, voice?: Voice) => <ChatMessageList thread={thread} inProgressLines={voice} onLoadOlder={async () => {}} onRetryFailed={() => {}} onOpenWorker={() => {}} />;
async function draw(first: ThreadState, voice?: Voice) {
  const view = await mountAsync(list(first, voice));
  await settle();
  return async (next: ThreadState, nextVoice?: Voice) => {
    view.rerender(list(next, nextVoice));
    await settle();
  };
}
/** The rows that rose: a row by its text (its clock left out), the streamed
 *  reply by its slot (its words come a moment after it shows). */
const rose = (started: ReturnType<typeof recordAnimations>) => started
  .filter((a) => JSON.stringify(a.keyframes).includes("translateY(6px)"))
  .map((a) => (a.slot === "transcript-row" ? (a.text ?? "").replace(/\d{2}:\d{2}$/, "") : a.slot));

test("what the chat opened with does not move; a reply that comes later rises into place", async () => {
  const started = recordAnimations();
  const opening = [asked("Check why build 4128 failed."), replied("Three checks failed; the cache test is the real one.", "w1")];
  const redraw = await draw(thread(opening));
  expect(rose(started)).toEqual([]);
  await redraw(thread([...opening, replied("Guarded the close; the race test passes.", "w2")]));
  expect(rose(started)).toEqual(["Guarded the close; the race test passes."]);
  expect(started.find((a) => a.text?.startsWith("Guarded"))?.duration).toBe(180);
});

test("a message sent rises as it goes out, not again when the server's copy takes its place", async () => {
  const started = recordAnimations();
  const opening = [asked("Check why build 4128 failed.")];
  const redraw = await draw(thread(opening));
  const pending = { localId: "local-1", content: "Tag 3.21 today.", status: "sent" as const, createdAt: "2026-10-23T09:59:00.000Z", messageId: "msg-sent" };
  await redraw(thread(opening, { pendingUserMessages: new Map([["local-1", pending]]) }));
  expect(rose(started)).toEqual(["Tag 3.21 today."]);
  await redraw(thread([...opening, { ...asked("Tag 3.21 today."), id: "msg-sent" }]));
  expect(rose(started)).toEqual(["Tag 3.21 today."]);
});

test("a reply rises as its words start to stream, not again when its stored copy takes their place", async () => {
  const started = recordAnimations();
  const opening = [asked("Check why build 4128 failed.")];
  const redraw = await draw(thread(opening, { wakePhase: { wakeId: "w1", phase: "thinking" } }));
  await redraw(thread(opening, { wakePhase: { wakeId: "w1", phase: "thinking" }, streamingAssistant: { wakeId: "w1", totalText: "The cache test fails." } }));
  expect(rose(started)).toEqual(["streaming-reply"]);
  // Its words show: the list draws a stream's words at most every 80 ms.
  await settle(100);
  expect(document.querySelector('[data-slot="streaming-reply"]')?.textContent).toContain("The cache test fails.");
  await redraw(thread([...opening, replied("The cache test fails.", "w1")]));
  expect(rose(started)).toEqual(["streaming-reply"]);
});

test("a message sent while a reply streams rises, though it is drawn above that reply", async () => {
  const started = recordAnimations();
  const opening = [asked("Check why build 4128 failed.")];
  const streaming = { wakePhase: { wakeId: "w1", phase: "thinking" as const }, streamingAssistant: { wakeId: "w1", totalText: "The cache test fails." } };
  const redraw = await draw(thread(opening, streaming));
  const pending = { localId: "local-2", content: "Also bump the changelog.", status: "sent" as const, createdAt: "2026-10-23T09:59:00.000Z" };
  await redraw(thread(opening, { ...streaming, pendingUserMessages: new Map([["local-2", pending]]) }));
  expect(rose(started)).toEqual(["Also bump the changelog."]);
});

test("a voice reply's stored copy does not rise over the words already shown as they were spoken", async () => {
  const started = recordAnimations();
  const opening = [asked("What failed?")];
  const spoken: Voice = { user: null, assistant: { speaker: "assistant", text: "The cache test failed.", isFinal: true, createdAt: 1 } };
  const redraw = await draw(thread(opening), spoken);
  await redraw(thread([...opening, { ...replied("The cache test failed.", "w1"), source: "voice" }]), { user: null, assistant: null });
  expect(rose(started)).toEqual([]);
});

test("asked for less motion, nothing rises", async () => {
  reducedMotion();
  const started = recordAnimations();
  const opening = [asked("Check why build 4128 failed.")];
  const redraw = await draw(thread(opening));
  await redraw(thread([...opening, replied("Three checks failed.", "w1")]));
  expect(rose(started)).toEqual([]);
});
