import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { mountAsync, settle } from "../helpers/mount.js";
import { runCleanups } from "../helpers/cleanup.js";
import { stubSentTextHeights } from "../helpers/sent-text-layout.js";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { foldOpenKey, toolResultsOf, type TranscriptRow } from "@/routes/window/chat/transcript-rows";
import { runOpenKey } from "@/routes/window/chat/tool-run-summary";
import { handoffIdsOf, openSentTextPausesFollow, turnHandoffs } from "@/routes/global/handoff-tools";
import { newThreadState, type AgentMessage, type ThreadState } from "@/store/agent-chat";
import { useGlobalAgentStore } from "@/store/global-agent";
import type { GlobalHandoffDto } from "@shared/api/global-agent";

// The global agent sends with a tool call and then says where it went. Drawn
// where the call was, the card stood above that sentence; drawn at the end of
// its turn, it passed whatever the turn took in on the way (a notice, the
// user's answer) and landed minutes later. A card is drawn under the first
// thing its turn says from the call's row on, unless something not of its turn
// comes first: then it stays where it was sent.

afterEach(() => { runCleanups(); useGlobalAgentStore.setState({ agent: null, handoffs: new Map() }); });

const at = (second: number) => `2026-10-10T10:17:${String(second).padStart(2, "0")}.000Z`;
const handoff = (id: string, over: Partial<GlobalHandoffDto> = {}): GlobalHandoffDto => ({
  id, kind: "thread", state: "delivered", text: "Look into the invoice template", spoken: false,
  featureId: null, featureName: null, ownerThreadTitle: null,
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

test("the sentence that says where it went comes first, and its card under it, in one row", async () => {
  const host = await draw(thread(proposalTurn()));
  const card = host.querySelector('[data-slot="handoff-card"]')!;
  const sentence = textNode(host, "Handed to a new thread.");
  expect(card.textContent).toContain("Invoice template change");
  expect(card.querySelectorAll("button").length).toBe(0);
  expect(before(sentence, card)).toBe(true);
  // One row: the turn's Copy and time close it under the card.
  expect(sentence.closest('[data-slot="transcript-row"]') === card.closest('[data-slot="transcript-row"]')).toBe(true);
  expect(host.querySelectorAll('[data-slot="handoff-card"]').length).toBe(1);
  // The lookups keep their line, above both.
  expect(before(host.querySelector('[data-slot="tool-run-line"]')!, sentence)).toBe(true);
});

test("drawn, each card of a long turn is in the row of the sentence that says where it went, above what came after", async () => {
  const host = await draw(thread([
    user(1, "Ask the release thread to tag v3.21."),
    says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }]),
    result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1", { newThreadTitle: "Tag v3.21" }) }),
    says(4, "w1", "Sent to the release thread."),
    user(5, "Publish the docs too"),
    says(6, "w1", "", [{ id: "c2", name: "send_to_thread" }]),
    result(7, "w1", "c2", "send_to_thread", { handoff: handoff("hof_2", { newThreadTitle: "Publish the docs" }) }),
    says(8, "w1", "Passed it on."),
    says(9, "w1", "Both are with the release thread.")
  ]));
  const cards = [...host.querySelectorAll('[data-slot="handoff-card"]')];
  expect(cards.map((card) => card.textContent?.includes("Tag v3.21") ? 1 : card.textContent?.includes("Publish the docs") ? 2 : 0)).toEqual([1, 2]);
  const row = (el: Element) => el.closest('[data-slot="transcript-row"]');
  expect(row(cards[0]!) === row(textNode(host, "Sent to the release thread."))).toBe(true);
  expect(before(cards[0]!, textNode(host, "Publish the docs too"))).toBe(true);
  expect(row(cards[1]!) === row(textNode(host, "Passed it on."))).toBe(true);
  expect(before(cards[1]!, textNode(host, "Both are with the release thread."))).toBe(true);
});

test("while the turn is still writing, its card stands under the words so far", async () => {
  const running = proposalTurn().slice(0, 5);
  const host = await draw(thread(running, { streamingAssistant: { wakeId: "w1", totalText: "Handed to a new thread" }, wakePhase: { ...newThreadState().wakePhase, wakeId: "w1", phase: "thinking" } }));
  const card = host.querySelector('[data-slot="handoff-card"]')!;
  const streaming = host.querySelector('[data-slot="streaming-reply"]')!;
  expect(before(streaming, card)).toBe(true);
  // Beside its words, as it will be once they are stored: not a row of its own further down.
  expect(card.parentElement!.parentElement === streaming.parentElement).toBe(true);
  expect(host.querySelectorAll('[data-slot="handoff-card"]').length).toBe(1);
});

test("a turn that sent and has said nothing yet shows its card where it stands", async () => {
  const host = await draw(thread(proposalTurn().slice(0, 5), { wakePhase: { ...newThreadState().wakePhase, wakeId: "w1", phase: "thinking" } }));
  expect(host.querySelectorAll('[data-slot="handoff-card"]').length).toBe(1);
});

// As data: which row draws which cards.
const rowsOf = (messages: AgentMessage[]): TranscriptRow[] => messages.filter((m) => m.role !== "tool").map((message) => ({ kind: "msg", message }));
const placed = (messages: AgentMessage[], streamingWakeId: string | null = null) => {
  const rows = rowsOf(messages);
  const places = turnHandoffs(rows, toolResultsOf(messages), streamingWakeId);
  return {
    byRow: Object.fromEntries(rows.filter((row) => places.byRow.has(row)).map((row) => [(row as { message: AgentMessage }).message.id, places.byRow.get(row)!.map((h) => h.id)])),
    trailing: places.trailing.map((h) => h.id)
  };
};

test("a card goes under the first thing its turn says after it; every other row of the turn draws none", () => {
  expect(placed(proposalTurn())).toEqual({ byRow: { a2: [], a4: [], a6: ["hof_1"] }, trailing: [] });
});

test("a long turn's cards stay with what it said about each, not at the turn's end", () => {
  // It sends, says so, is told of a question, asks the user, passes the
  // answer on, says so, and closes.
  const turn = [
    user(1, "Ask the release thread to tag v3.21."),
    says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }]),
    result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1") }),
    says(4, "w1", "Sent to the release thread."),
    notice(5),
    says(6, "w1", "", [{ id: "c2", name: "ask_user" }]),
    user(7, "Publish it"),
    says(8, "w1", "", [{ id: "c3", name: "send_to_thread" }]),
    result(9, "w1", "c3", "send_to_thread", { handoff: handoff("hof_2") }),
    says(10, "w1", "Passed your answer on."),
    says(11, "w1", "Both are with the release thread.")
  ];
  expect(placed(turn)).toEqual({ byRow: { a2: [], a4: ["hof_1"], a6: [], a8: [], a10: ["hof_2"], a11: [] }, trailing: [] });
});

test("a card stays where it was sent when something not of its turn comes before its turn says anything", () => {
  const sent = [says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }]), result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1") })];
  const sentence = says(5, "w1", "Sent to the release thread.");
  // A notice, the user's message, an alarm, a spoken reply.
  const alarm = { ...user(4, "[Mandate alarm fired]"), source: "alarm" } as AgentMessage;
  expect(placed([...sent, notice(4), sentence])).toEqual({ byRow: { a2: ["hof_1"], a5: [] }, trailing: [] });
  expect(placed([...sent, user(4, "Also the docs"), sentence])).toEqual({ byRow: { a2: ["hof_1"], a5: [] }, trailing: [] });
  expect(placed([...sent, alarm, sentence])).toEqual({ byRow: { a2: ["hof_1"], a5: [] }, trailing: [] });
  expect(placed([...sent, says(4, null, "On it."), sentence])).toEqual({ byRow: { a2: ["hof_1"], a4: [], a5: [] }, trailing: [] });
});

test("a sentence in the call's own row is what it says about the card: the card stays there", () => {
  const turn = [
    says(2, "w1", "Passing this to the release thread.", [{ id: "c1", name: "send_to_thread" }]),
    result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1") }),
    says(4, "w1", "Done.")
  ];
  expect(placed(turn)).toEqual({ byRow: { a2: ["hof_1"], a4: [] }, trailing: [] });
  // Blank words before a call (some models write a newline first) say nothing.
  const blank = [says(2, "w1", "\n\n", [{ id: "c1", name: "send_to_thread" }]), ...turn.slice(1)];
  expect(placed(blank)).toEqual({ byRow: { a2: [], a4: ["hof_1"] }, trailing: [] });
});

test("two turns keep their own cards, and a turn's several stay in the order it made them", () => {
  const second = [
    user(7, "Also tell release not to delete it yet"),
    says(8, "w2", "", [{ id: "c3", name: "message_feature" }, { id: "c4", name: "send_to_thread" }]),
    result(9, "w2", "c3", "message_feature", { handoff: handoff("hof_2", { kind: "feature", state: "delivered" }) }),
    result(10, "w2", "c4", "send_to_thread", { handoff: handoff("hof_3") }),
    says(11, "w2", "Both done.")
  ];
  expect(placed([...proposalTurn(), ...second])).toEqual({ byRow: { a2: [], a4: [], a6: ["hof_1"], a8: [], a11: ["hof_2", "hof_3"] }, trailing: [] });
});

test("the turn being written keeps its cards for the end of what it is writing", () => {
  expect(placed(proposalTurn().slice(0, 5), "w1")).toEqual({ byRow: { a2: [], a4: [] }, trailing: ["hof_1"] });
  // Another turn's are not held back with them.
  expect(placed([...proposalTurn(), says(12, "w9", "", [{ id: "c9", name: "send_to_thread" }]), result(13, "w9", "c9", "send_to_thread", { handoff: handoff("hof_9") })], "w9"))
    .toEqual({ byRow: { a2: [], a4: [], a6: ["hof_1"], a12: [] }, trailing: ["hof_9"] });
});

test("a card placed once is not moved again while its turn writes on", () => {
  // Under the sentence that says where it went, whatever the turn writes next.
  expect(placed(proposalTurn(), "w1")).toEqual({ byRow: { a2: [], a4: [], a6: ["hof_1"] }, trailing: [] });
  // Held at its call by a notice: the words being written come after the
  // notice, and the card does not follow them there.
  expect(placed([...proposalTurn().slice(0, 5), notice(6)], "w1")).toEqual({ byRow: { a2: [], a4: ["hof_1"] }, trailing: [] });
});

test("a card following its turn's words is not pulled back by what the user sends meanwhile", () => {
  // The send is drawn last while it is on its way, but a running turn takes
  // it in at its next step: it is stored after the words being written.
  const messages = proposalTurn();
  const results = toolResultsOf(messages);
  const sending: TranscriptRow = { kind: "pending", pending: { localId: "p1", content: "And the docs?", status: "sending", createdAt: at(6) } };
  const where = (rows: TranscriptRow[], streamingWakeId: string | null) => {
    const places = turnHandoffs(rows, results, streamingWakeId);
    if (places.trailing.length > 0) return "trailing";
    const row = rows.find((r) => (places.byRow.get(r) ?? []).length > 0);
    return row?.kind === "msg" ? row.message.id : null;
  };
  const sent = rowsOf(messages.slice(0, 5));
  // Following the words; the user sends; the words are stored, the send still on its way.
  expect([where(sent, "w1"), where([...sent, sending], "w1"), where([...rowsOf(messages), sending], null)]).toEqual(["trailing", "trailing", "a6"]);
});

test("a row that draws nothing is never given a card: an empty last step leaves it with the row before", () => {
  const turn = [...proposalTurn().slice(0, 5), says(6, "w1", "")];
  expect(placed(turn)).toEqual({ byRow: { a2: [], a4: ["hof_1"] }, trailing: [] });
  // Nor does such a row hold a card back from the sentence after it.
  expect(placed([...turn, says(7, "w1", "Handed to a new thread.")])).toEqual({ byRow: { a2: [], a4: [], a7: ["hof_1"] }, trailing: [] });
});

test("a call with no turn of its own (a spoken one) keeps its card on its own row", () => {
  const spoken = [says(2, null, "OK", [{ id: "c1", name: "message_feature" }]), result(3, null, "c1", "message_feature", { handoff: handoff("hof_1", { kind: "feature" }) }), says(4, null, "Passed on to release.")];
  expect(placed(spoken)).toEqual({ byRow: { a2: ["hof_1"], a4: [] }, trailing: [] });
});

test("a send to a thread makes a card; a wait with nothing sent makes none", () => {
  const turn = [
    says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }, { id: "c2", name: "await_stop" }]),
    result(3, "w1", "c1", "send_to_thread", { handoff: handoff("hof_1", { state: "delivered" }) }),
    result(4, "w1", "c2", "await_stop", { waiting: true, handoff: handoff("hof_2", { state: "waiting", text: "" }) }),
    says(5, "w1", "Handed to the thread.")
  ];
  expect(placed(turn)).toEqual({ byRow: { a2: [], a5: ["hof_1"] }, trailing: [] });
});

test("a refused call makes no card", () => {
  const turn = [
    says(2, "w1", "", [{ id: "c1", name: "send_to_thread" }]),
    result(3, "w1", "c1", "send_to_thread", { error: "no such thread" })
  ];
  expect(placed(turn)).toEqual({ byRow: { a2: [] }, trailing: [] });
});

// What the agent sent is two lines on its card until opened,
// and a brief runs to a screen or more. Opened at the end of the
// conversation it must not be scrolled away by its own growth or by what
// comes next: the list stops following while it is open, as for a long
// message opened in place.
test("a card's sent text opened in place pauses following; a mark with no card on the loaded rows does not", () => {
  const messages = proposalTurn();
  const rows = rowsOf(messages);
  const results = toolResultsOf(messages);
  expect(openSentTextPausesFollow(rows, results, new Set([foldOpenKey("hof_1")]))).toBe(true);
  expect(openSentTextPausesFollow(rows, results, new Set())).toBe(false);
  expect(openSentTextPausesFollow(rows, results, new Set([foldOpenKey("hof_gone")]))).toBe(false);
  // A run's mark is not a fold's, though the call is the card's own.
  expect(openSentTextPausesFollow(rows, results, new Set([runOpenKey("c2")]))).toBe(false);
  // The call is loaded and its result is not: no card is drawn, so nothing is open.
  const cut = messages.slice(0, 4);
  expect(openSentTextPausesFollow(rowsOf(cut), toolResultsOf(cut), new Set([foldOpenKey("hof_1")]))).toBe(false);
});

test("opened at the end of the conversation, what it sent is not followed away by the next message", async () => {
  // This DOM lays nothing out: the card's text is given a height that folds,
  // and the scroller its own: at the end, and 400px taller when the next
  // message is drawn. Followed, it moves to the new end; paused, it is left
  // short and offers "Scroll to latest".
  const layout = stubSentTextHeights({ full: 80, clamped: 40 });
  const list = (messages: AgentMessage[], over: Partial<ThreadState> = {}) =>
    <ChatMessageList thread={thread(messages, over)} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
  // `writing`: the card is opened while its turn is still writing, where it
  // stands under the words so far; the next thing drawn is the turn's stored
  // sentence, with the card under it.
  const run = async (open: boolean, writing = false) => {
    const view = await mountAsync(writing
      ? list(proposalTurn().slice(0, 5), { streamingAssistant: { wakeId: "w1", totalText: "Handed to a new thread" }, wakePhase: { ...newThreadState().wakePhase, wakeId: "w1", phase: "thinking" } })
      : list(proposalTurn()));
    await settle();
    try {
      const scroller = view.host.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
      let contentHeight = 5000;
      Object.defineProperty(scroller, "scrollHeight", { get: () => contentHeight, configurable: true });
      Object.defineProperty(scroller, "clientHeight", { get: () => 500, configurable: true });
      await act(async () => {
        scroller.scrollTop = 4500;
        scroller.dispatchEvent(new window.Event("scroll"));
      });
      const fold = view.host.querySelector<HTMLButtonElement>('[data-slot="sent-fold"]')!;
      expect(fold.textContent).toBe("Show more");
      if (open) {
        await act(async () => { fold.click(); });
        expect(view.host.querySelector('[data-slot="sent-fold"]')!.textContent).toBe("Show less");
      }
      contentHeight = 5400;
      view.rerender(list(writing ? proposalTurn() : [...proposalTurn(), user(7, "And then?")]));
      await settle();
      // Opened, it is still open where it now stands, and can be closed: the
      // card drawn again under the stored sentence keeps what was measured.
      if (open) expect(view.host.querySelector('[data-slot="sent-fold"]')!.textContent).toBe("Show less");
      return view.host.querySelector('[aria-label="Scroll to latest message"]') !== null;
    } finally {
      view.unmount();
    }
  };
  try {
    // The control: folded, the list follows the new message.
    expect(await run(false)).toBe(false);
    expect(await run(true)).toBe(true);
    expect(await run(false, true)).toBe(false);
    expect(await run(true, true)).toBe(true);
  } finally {
    layout.restore();
  }
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
  expect(handoffIdsOf([calls, result(1, "send_to_thread", "hof_p"), result(2, "await_stop", "hof_w"), result(3, "message_feature", "hof_a")])).toEqual(["hof_a", "hof_p"]);
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
