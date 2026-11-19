import { afterEach, expect, test } from "bun:test";
import { mountAsync, settle } from "../helpers/mount.js";
import { runCleanups } from "../helpers/cleanup.js";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { handoffIdsOf } from "@/routes/personal/handoff-tools";
import { newThreadState, type AgentMessage, type ThreadState } from "@/store/agent-chat";
import { usePersonalAgentStore } from "@/store/personal-agent";
import type { PersonalHandoffDto } from "@shared/api/personal-agent";

// The personal agent sends with a tool call and then says where it went. The
// card stands where it was sent, in the order things happened: under the work
// that sent it, above what its turn says next. It never moves: not to the end
// of a long turn, nor down to the sentence written after it. Work the turn does
// after the send starts a line of its own below the card, so the line of what
// the turn is doing now stays last.

afterEach(() => { runCleanups(); usePersonalAgentStore.setState({ agent: null, handoffs: new Map() }); });

const at = (second: number) => `2026-10-10T10:17:${String(second).padStart(2, "0")}.000Z`;
const handoff = (id: string, over: Partial<PersonalHandoffDto> = {}): PersonalHandoffDto => ({
  id, kind: "thread", state: "delivered", text: "Look into the invoice template", spoken: false,
  workerId: null, workerName: null, ownerThreadTitle: null,
  threadId: null, threadTitle: null, newThreadTitle: "Invoice template change", reply: null, reason: null, stop: null,
  createdAt: at(0), updatedAt: at(0), repliedAt: null, ...over
});
const base = { threadId: "thr_g", sourceThreadId: null } as const;
const user = (seq: number, text: string): AgentMessage => ({ ...base, id: `u${seq}`, seq, role: "user", source: "user", wakeId: null, createdAt: at(seq), content: { type: "text", text } } as AgentMessage);
const says = (seq: number, wakeId: string | null, text: string, calls: Array<{ id: string; name: string }> = []): AgentMessage => ({
  ...base, id: `a${seq}`, seq, role: "assistant", source: "self", wakeId, createdAt: at(seq),
  content: { type: "assistant", text, toolCalls: calls.map((c) => ({ toolCallId: c.id, toolName: c.name, args: {} })) }
} as AgentMessage);
const notice = (seq: number): AgentMessage => ({ ...base, id: `n${seq}`, seq, role: "user", source: "thread-notice", wakeId: null, createdAt: at(seq), content: { type: "text", text: "[Thread notice] asked" } } as AgentMessage);
const result = (seq: number, wakeId: string | null, callId: string, name: string, value: unknown): AgentMessage => ({
  ...base, id: `t${seq}`, seq, role: "tool", source: "self", wakeId, createdAt: at(seq),
  content: { type: "tool_result", toolCallId: callId, toolName: name, result: value }
} as AgentMessage);

/** The user's question, a lookup, the send, then the sentence that says where it went. */
const proposalTurn = (wakeId = "w1"): AgentMessage[] => [
  user(1, "Who changed the invoice template?"),
  says(2, wakeId, "", [{ id: "c1", name: "list_threads" }]),
  result(3, wakeId, "c1", "list_threads", { threads: [] }),
  says(4, wakeId, "", [{ id: "c2", name: "send_to_thread" }]),
  result(5, wakeId, "c2", "send_to_thread", { handoff: handoff("hof_1") }),
  says(6, wakeId, "Handed to a new thread.")
];

const thread = (messages: AgentMessage[], over: Partial<ThreadState> = {}): ThreadState => ({ ...newThreadState(), threadId: "thr_g", messages, oldestSeqLoaded: 1, ...over });
async function draw(state: ThreadState) {
  const { host } = await mountAsync(<ChatMessageList thread={state} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  return host;
}
/** Whether `first` comes before `second` in the document. */
const before = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
const textNode = (host: HTMLElement, text: string) => [...host.querySelectorAll("p, div, span")].find((el) => el.children.length === 0 && el.textContent === text)!;

const row = (el: Element) => el.closest('[data-slot="transcript-row"]');
const cardsOf = (host: HTMLElement) => [...host.querySelectorAll('[data-slot="handoff-card"]')];
const runLines = (host: HTMLElement) => [...host.querySelectorAll('[data-slot="tool-run-line"]')];

test("a card stands where it was sent: under the work that sent it, above what its turn then says", async () => {
  const host = await draw(thread(proposalTurn()));
  const card = host.querySelector('[data-slot="handoff-card"]')!;
  const sentence = textNode(host, "Handed to a new thread.");
  expect(card.textContent).toContain("Invoice template change");
  // Its one control is the target's name, which opens what was sent.
  expect([...card.querySelectorAll("button")].map((b) => b.getAttribute("data-slot"))).toEqual(["handoff-target"]);
  expect(cardsOf(host).length).toBe(1);
  // The lookups' line, then the card, in the row that sent it; the sentence after, in its own.
  const lines = runLines(host);
  expect(lines.length).toBe(1);
  expect([before(lines[0]!, card), before(card, sentence)]).toEqual([true, true]);
  expect(row(card) === row(lines[0]!)).toBe(true);
  expect(row(card) === row(sentence)).toBe(false);
});

test("words written with the call come before its card, as they were written", async () => {
  const host = await draw(thread([
    user(1, "Pass this to the release thread."),
    says(2, "w1", "Passing this to the release thread.", [{ id: "c1", name: "send_to_thread" }]),
    result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1") }),
    says(4, "w1", "Done.")
  ]));
  const card = host.querySelector('[data-slot="handoff-card"]')!;
  expect([before(textNode(host, "Passing this to the release thread."), card), before(card, textNode(host, "Done."))]).toEqual([true, true]);
});

test("work after the send starts its own line below the card: the line of what the turn is doing now stays last", async () => {
  const messages = [
    ...proposalTurn().slice(0, 5),
    says(6, "w1", "", [{ id: "c3", name: "bash" }])
  ];
  const host = await draw(thread(messages, { wakePhase: { ...newThreadState().wakePhase, wakeId: "w1", phase: "thinking" } }));
  const card = host.querySelector('[data-slot="handoff-card"]')!;
  const lines = runLines(host);
  expect(lines.length).toBe(2);
  expect([before(lines[0]!, card), before(card, lines[1]!)]).toEqual([true, true]);
  // A send that was refused drew no card: the work stays one line.
  const refused = [
    ...proposalTurn().slice(0, 4),
    result(5, "w1", "c2", "send_to_thread", { error: "no such thread" }),
    says(6, "w1", "", [{ id: "c3", name: "bash" }])
  ];
  runCleanups();
  const plain = await draw(thread(refused, { wakePhase: { ...newThreadState().wakePhase, wakeId: "w1", phase: "thinking" } }));
  expect([cardsOf(plain).length, runLines(plain).length]).toEqual([0, 1]);
});

test("while the turn is still writing, its card stays where it was sent, above the words so far", async () => {
  const running = proposalTurn().slice(0, 5);
  const host = await draw(thread(running, { streamingAssistant: { wakeId: "w1", totalText: "Handed to a new thread" }, wakePhase: { ...newThreadState().wakePhase, wakeId: "w1", phase: "thinking" } }));
  const card = host.querySelector('[data-slot="handoff-card"]')!;
  const streaming = host.querySelector('[data-slot="streaming-reply"]')!;
  expect(before(card, streaming)).toBe(true);
  expect(cardsOf(host).length).toBe(1);
});

test("a long turn's cards each stand where they were sent, in the order things happened", async () => {
  const host = await draw(thread([
    user(1, "Ask the release thread to tag v3.21."),
    says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }]),
    result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1", { newThreadTitle: "Tag v3.21" }) }),
    says(4, "w1", "Sent to the release thread."),
    notice(5),
    user(6, "Publish the docs too"),
    says(7, "w1", "", [{ id: "c2", name: "message_worker" }, { id: "c3", name: "send_to_thread" }]),
    result(8, "w1", "c2", "message_worker", { handoff: handoff("hof_2", { kind: "worker", workerId: "wkr_docs", workerName: "Publish the docs" }) }),
    result(9, "w1", "c3", "send_to_thread", { handoff: handoff("hof_3", { newThreadTitle: "Tell the docs thread" }) }),
    says(10, "w1", "Passed it on."),
    says(11, "w1", "Both are with the release thread.")
  ]));
  const cards = cardsOf(host);
  const which = (card: Element) => ["Tag v3.21", "Publish the docs", "Tell the docs thread"].findIndex((title) => card.textContent?.includes(title)) + 1;
  expect(cards.map(which)).toEqual([1, 2, 3]);
  expect([before(cards[0]!, textNode(host, "Sent to the release thread.")), before(textNode(host, "Publish the docs too"), cards[1]!), before(cards[2]!, textNode(host, "Passed it on."))]).toEqual([true, true, true]);
});

test("a send to a thread makes a card; a wait with nothing sent makes none; a refused call makes none", async () => {
  const host = await draw(thread([
    says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }, { id: "c2", name: "await_stop" }]),
    result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1", { state: "delivered" }) }),
    result(4, "w1", "c2", "await_stop", { waiting: true, handoff: handoff("hof_2", { state: "waiting", text: "" }) }),
    says(5, "w1", "Handed to the thread.")
  ]));
  expect(cardsOf(host).length).toBe(1);
  runCleanups();
  const refused = await draw(thread([
    says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }]),
    result(3, "w1", "c1", "send_to_thread", { error: "no such thread" })
  ]));
  expect([cardsOf(refused).length, runLines(refused).length]).toEqual([0, 1]);
});

// A turn that said nothing gets a line saying it finished, under the last row
// of its that draws something. A send is a card that leaves its run, so a row
// of only such calls is judged by its cards, not by having called a tool.
test("a turn that only sent something has its card to finish under: the line goes there", async () => {
  const wakeStartedAt = at(0);
  const dated = (m: AgentMessage): AgentMessage => ({ ...m, wakeStartedAt } as AgentMessage);
  const host = await draw(thread([
    user(1, "Tell the docs thread about the template."),
    dated(says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }])),
    result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1") }),
    dated(says(4, "w1", ""))
  ]));
  const card = host.querySelector('[data-slot="handoff-card"]')!;
  const line = [...host.querySelectorAll('[data-slot="row-actions"]')].find((el) => el.textContent?.includes("Finished without a reply"))!;
  expect(line !== undefined).toBe(true);
  expect(line.closest('[data-slot="transcript-row"]') === card.closest('[data-slot="transcript-row"]')).toBe(true);
  expect(before(card, line)).toBe(true);
});

test("the ids a page reads are the cards its transcript draws: a tool that draws none adds none", () => {
  const result = (seq: number, toolName: string, id: string) => ({
    id: `m${seq}`, threadId: "thr_g", seq, role: "tool", source: "self", sourceThreadId: null, wakeId: "w", createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "tool_result", toolCallId: `c${seq}`, toolName, result: { handoff: { id } } }
  }) as unknown as AgentMessage;
  const calls = {
    id: "m0", threadId: "thr_g", seq: 0, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w", createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [1, 2, 3].map((seq) => ({ toolCallId: `c${seq}`, toolName: "x", args: {} })) }
  } as unknown as AgentMessage;
  expect(handoffIdsOf([calls, result(2, "await_stop", "hof_w")])).toEqual([]);
  expect(handoffIdsOf([calls, result(1, "send_to_thread", "hof_p"), result(2, "await_stop", "hof_w"), result(3, "message_worker", "hof_a")])).toEqual(["hof_a", "hof_p"]);
});

test("a result whose call is on a page not loaded yet draws no card, so its id waits for the card", () => {
  const call = (seq: number, toolCallId: string, toolName: string) => ({
    id: `m${seq}`, threadId: "thr_g", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w", createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId, toolName, args: {} }] }
  }) as unknown as AgentMessage;
  const result = (seq: number, toolCallId: string, toolName: string, id: string) => ({
    id: `m${seq}`, threadId: "thr_g", seq, role: "tool", source: "self", sourceThreadId: null, wakeId: "w", createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "tool_result", toolCallId, toolName, result: { handoff: { id } } }
  }) as unknown as AgentMessage;
  expect(handoffIdsOf([result(2, "c1", "send_to_thread", "hof_p")])).toEqual([]);
  expect(handoffIdsOf([call(1, "c1", "send_to_thread"), result(2, "c1", "send_to_thread", "hof_p")])).toEqual(["hof_p"]);
});
