import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { newThreadState, type AgentMessage, type ThreadState } from "@/store/agent-chat";
import type { PendingMessage } from "@/store/agent-chat-types";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle } from "../helpers/mount.js";

afterEach(() => runCleanups());

// An answer picked or typed in a question is the user's message naming the
// question: its bubble quotes it, so the reader can tell what it answers
// however far below the question it lands.

const QUESTION = "The image build most likely fails because the Docker build installs only some workspaces. Reproduce it in isolation and compare the lockfile and workspace inputs?";
const at = "2026-10-16T05:20:00.000Z";
const base = { threadId: "thr-1", sourceThreadId: null, wakeId: null, createdAt: at } as const;
const asking: AgentMessage[] = [
  { ...base, id: "a1", seq: 1, role: "assistant", source: "self", wakeId: "w1",
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c1", toolName: "ask_user", args: { question: QUESTION } }] } } as AgentMessage,
  { ...base, id: "t1", seq: 2, role: "tool", source: "self", wakeId: "w1",
    content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: "q_a", question: QUESTION, options: [{ label: "Reproduce it" }, { label: "Hold it" }] } } } as AgentMessage,
  { ...base, id: "a2", seq: 3, role: "assistant", source: "self", wakeId: "w1",
    content: { type: "assistant", text: "One thing is left for you to decide.", toolCalls: [] } } as AgentMessage
];
const reply: AgentMessage = { ...base, id: "u1", seq: 4, role: "user", source: "user",
  content: { type: "text", text: "Reproduce it", metadata: { answers: [{ id: "q_a", question: QUESTION }] } } } as AgentMessage;
const typed: AgentMessage = { ...base, id: "u2", seq: 5, role: "user", source: "user", content: { type: "text", text: "Thanks." } } as AgentMessage;

async function render(messages: AgentMessage[], pending: PendingMessage[] = []) {
  const thread: ThreadState = {
    ...newThreadState(), threadId: "thr-1", messages, oldestSeqLoaded: messages[0]?.seq ?? null,
    pendingUserMessages: new Map(pending.map((p) => [p.localId, p]))
  };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  return host;
}
const bubbles = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-slot="user-bubble"]')];
const quoteIn = (bubble: HTMLElement) => bubble.querySelector<HTMLElement>('[data-slot="answer-quote"]');

test("an answer quotes its question above its words, two lines at most; a typed message quotes nothing", async () => {
  const host = await render([...asking, reply, typed]);
  const [answer, plain] = bubbles(host);
  const quote = quoteIn(answer!);
  const words = quote?.querySelector('[data-slot="answer-quote-text"]');
  expect([quote?.textContent, quote?.getAttribute("title"), words?.className.split(/\s+/).includes("line-clamp-2")]).toEqual([QUESTION, QUESTION, true]);
  expect(answer!.querySelector('[data-slot="bubble-text"]')?.textContent).toBe("Reproduce it");
  expect(quoteIn(plain!) === null).toBe(true);
});

test("the quote takes the reader to the question: its line scrolls into view at once and flashes", async () => {
  const scrolled: unknown[] = [];
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  // What scrolled: the question's line by its id, and which of its parts.
  Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) { scrolled.push([this.closest("[data-question-id]")?.getAttribute("data-question-id") ?? this.tagName, this.getAttribute("data-slot"), options]); };
  onCleanup(() => { if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original); else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });
  const host = await render([...asking, reply]);
  const quote = quoteIn(bubbles(host)[0]!)!;
  expect(quote.tagName).toBe("BUTTON");
  await act(async () => { quote.click(); });
  // At once: a smooth scroll still at the end when the next streamed word
  // arrives would let following the end take the reader back down.
  // Its head: a line opened taller than the screen would else be centred
  // whole, its head and the question's start above the view.
  expect(scrolled).toStrictEqual([["q_a", "ask-line-head", { block: "center", behavior: "instant" }]]);
  expect(host.querySelector('[data-slot="ask-line"][data-question-id="q_a"]')?.hasAttribute("data-question-flash")).toBe(true);
  // And opened: the whole question is there to read.
  expect(host.querySelector('[data-slot="ask-line"][data-question-id="q_a"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[data-slot="ask-line"][data-question-id="q_a"] [data-slot="ask-line-full"]')?.textContent).toBe(QUESTION);
  // The answer the user picked, read from their message, is marked as theirs.
  expect(host.querySelector('[data-slot="ask-line"][data-question-id="q_a"] [data-slot="ask-line-option"][data-picked="true"]')?.textContent).toBe("Reproduce it · Your answer");
  // Taken there again, the line already open: its head again, not the whole.
  await act(async () => { quote.click(); });
  expect(scrolled.at(-1)).toEqual(["q_a", "ask-line-head", { block: "center", behavior: "instant" }]);
  expect(host.querySelector('[data-slot="ask-line"][data-question-id="q_a"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
});

test("a question whose line is not loaded is still quoted, but the quote leads nowhere", async () => {
  const host = await render([reply]);
  const quote = quoteIn(bubbles(host)[0]!);
  expect([quote?.textContent, quote?.tagName]).toEqual([QUESTION, "DIV"]);
});

test("a page that starts at the question's result, its asking turn not loaded, draws no line for it: the quote leads nowhere", async () => {
  const host = await render([asking[1]!, asking[2]!, reply]);
  expect(host.querySelector('[data-slot="ask-line"]') === null).toBe(true);
  expect(quoteIn(bubbles(host)[0]!)?.tagName).toBe("DIV");
});

test("an answer still on its way quotes its question already", async () => {
  const host = await render([...asking], [
    { localId: "local-1", content: "Reproduce it", status: "sending", createdAt: at, answers: [{ id: "q_a", question: QUESTION }] }
  ]);
  expect(quoteIn(bubbles(host)[0]!)?.textContent).toBe(QUESTION);
});

test("an answer waiting behind a running turn, listed above the composer, says what it answers after its words", async () => {
  const { host } = await mountAsync(
    <ChatInput onSend={() => {}} queuedMessages={[
      { localId: "local-1", content: "Reproduce it", status: "queued", createdAt: at, answers: [{ id: "q_a", question: QUESTION }] },
      { localId: "local-2", content: "And the docs.", status: "queued", createdAt: at }
    ]} />
  );
  const lines = [...host.querySelectorAll<HTMLElement>('[data-slot="queued-message"]')];
  expect(lines.map((line) => line.textContent)).toEqual([`Reproduce it · answer to “${QUESTION}”`, "And the docs."]);
  // Hovering the row shows the question even when a long answer pushes it out of sight.
  expect([lines[0]!.getAttribute("title"), lines[1]!.getAttribute("title")]).toEqual([QUESTION, null]);
});
