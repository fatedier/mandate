import { expect, test } from "bun:test";
import { groupToolRuns } from "@/routes/window/chat/group-tool-runs";
import { toolResultsOf, transcriptItems, type TranscriptRow } from "@/routes/window/chat/transcript-rows";
import { callsShownAsEndings, turnEndings, type TurnEnding } from "@/routes/window/chat/turn-endings";
import type { AgentMessage } from "@/store/agent-chat";

// A turn can finish without a word: the agent tidied up and had nothing to
// add. Until now nothing on the page said such a turn was over. Its last row
// was a folded run of tool calls, which is also what a turn still working
// looks like. A turn that said nothing now has an ending: the sentence the
// agent gave when it closed its follow-up of the thread's workers, or, with no
// such sentence, the plain fact that it finished.

const at = (second: number) => `2026-10-12T10:04:${String(second).padStart(2, "0")}.000Z`;
const base = { threadId: "thr-1", sourceThreadId: null } as const;
type Call = { id: string; name: string; args?: Record<string, unknown> };
const step = (seq: number, wakeId: string, text: string, calls: Call[] = [], startedAt: string | null = at(0)): AgentMessage => ({
  ...base, id: `a${seq}`, seq, role: "assistant", source: "self", wakeId, wakeStartedAt: startedAt, createdAt: at(seq),
  content: { type: "assistant", text, toolCalls: calls.map((c) => ({ toolCallId: c.id, toolName: c.name, args: c.args ?? {} })) }
} as AgentMessage);
const result = (seq: number, wakeId: string, callId: string, name: string, isError = false): AgentMessage => ({
  ...base, id: `t${seq}`, seq, role: "tool", source: "self", wakeId, createdAt: at(seq),
  content: { type: "tool_result", toolCallId: callId, toolName: name, result: isError ? null : { ok: true }, isError }
} as AgentMessage);
const failure = (seq: number, wakeId: string): AgentMessage => ({
  ...base, id: `f${seq}`, seq, role: "system", source: "self", wakeId, createdAt: at(seq),
  content: { type: "wake_failure", status: "error", message: "The provider answered 500." }
} as unknown as AgentMessage);
const closes = (id: string, reason: unknown): Call => ({ id, name: "end_sweep", args: { reason } });

/** The endings of a transcript, read as the list builds its rows. */
function endingsOf(messages: AgentMessage[], over: { activeWakeId?: string | null; loadedFrom?: string | null; interrupted?: string[]; draws?: (row: TranscriptRow) => boolean; window?: number } = {}) {
  const { renderItems } = transcriptItems(messages, new Map(), false);
  // The list draws the last rows first; every loaded row is still known.
  const rows: TranscriptRow[] = groupToolRuns(over.window ? renderItems.slice(-over.window) : renderItems);
  const turnStarts = new Map<string, string>();
  for (const m of messages) if (m.wakeId && m.wakeStartedAt) turnStarts.set(m.wakeId, m.wakeStartedAt);
  const found = turnEndings(rows, {
    loaded: renderItems,
    loadedFrom: over.loadedFrom ?? null,
    turnStarts,
    liveWakeIds: new Set(over.activeWakeId ? [over.activeWakeId] : []),
    interruptedWakeIds: new Set(over.interrupted ?? []),
    results: toolResultsOf(messages),
    draws: over.draws ?? (() => true),
    reasonOf: (m) => m.wakeReason ?? null
  });
  return { rows, found, left: [...callsShownAsEndings(found)], list: [...found].map(([row, ending]) => [row.kind === "msg" ? row.message.id : "pending", ending] as [string, TurnEnding]) };
}

/** A worker's reply woke the manager; it read the plan, closed the item, and ended its follow-up. */
const tidiedUp = (reason: unknown = "The rewrite is finished and nothing is waiting on a worker."): AgentMessage[] => [
  step(1, "w1", "", [{ id: "c1", name: "read_plan" }]),
  result(2, "w1", "c1", "read_plan"),
  step(3, "w1", "", [{ id: "c2", name: "dismiss_work_item" }, { id: "c3", name: "memory_update" }]),
  result(4, "w1", "c2", "dismiss_work_item"),
  result(5, "w1", "c3", "memory_update"),
  step(6, "w1", "", [closes("c4", reason)]),
  result(7, "w1", "c4", "end_sweep"),
  step(8, "w1", "")
];

test("a turn that said nothing and closed its follow-up ends with the sentence it gave, under its last row", () => {
  const { rows, list } = endingsOf(tidiedUp());
  // One run row and the empty last step, which draws nothing.
  expect(rows.map((row) => (row.kind === "msg" ? [row.message.id, row.runTail?.length ?? 0] : null))).toEqual([["a1", 2], ["a8", 0]]);
  expect(list).toEqual([
    ["a1", { kind: "settled", reason: "The rewrite is finished and nothing is waiting on a worker.", callId: "c4", at: at(8) }]
  ]);
});

test("a turn that said nothing and gave no such sentence is silent, and says when it ended", () => {
  const { list } = endingsOf([
    step(1, "w1", "", [{ id: "c1", name: "read_plan" }]),
    result(2, "w1", "c1", "read_plan"),
    step(3, "w1", "")
  ]);
  expect(list).toEqual([["a1", { kind: "silent", at: at(3) }]]);
});

test("the turn ended when its last message came, and that can be a tool's answer", () => {
  // Stopped after a call came back and before another step: the answer is the last thing the turn has.
  const { list } = endingsOf([
    step(1, "w1", "", [{ id: "c1", name: "read_plan" }]),
    result(3, "w1", "c1", "read_plan")
  ]);
  expect(list).toEqual([["a1", { kind: "silent", at: at(3) }]]);
});

test("a turn a person stopped before it said anything is interrupted, not finished", () => {
  const cut = [
    step(1, "w1", "", [{ id: "c1", name: "read_plan" }]),
    result(3, "w1", "c1", "read_plan")
  ];
  expect(endingsOf(cut, { interrupted: ["w1"] }).list).toEqual([["a1", { kind: "interrupted", at: at(3) }]]);
  // Another turn's stop says nothing of this one.
  expect(endingsOf(cut, { interrupted: ["w0"] }).list).toEqual([["a1", { kind: "silent", at: at(3) }]]);
});

test("a stopped turn that had closed its follow-up is interrupted all the same, and the call stays in its run", () => {
  const { list, left } = endingsOf(tidiedUp(), { interrupted: ["w1"] });
  expect(list).toEqual([["a1", { kind: "interrupted", at: at(8) }]]);
  expect(left).toEqual([]);
});

test("a stopped turn gets a line where a finished one would: none if it spoke, drew nothing, or is not known to be over", () => {
  const cut = [
    step(1, "w1", "", [{ id: "c1", name: "read_plan" }]),
    result(2, "w1", "c1", "read_plan")
  ];
  const stopped = { interrupted: ["w1"] };
  expect(endingsOf([...cut, step(3, "w1", "Halfway through the plan")], stopped).list).toEqual([]);
  expect(endingsOf(cut, { ...stopped, draws: () => false }).list).toEqual([]);
  expect(endingsOf(cut, { ...stopped, activeWakeId: "w1" }).list).toEqual([]);
  expect(endingsOf(cut, { ...stopped, loadedFrom: at(1) }).list).toEqual([]);
  // Of two rows, the line goes under the last that draws.
  const twoRows = [
    ...cut,
    { ...base, id: "u3", seq: 3, role: "user", source: "user", wakeId: null, createdAt: at(3), content: { type: "text", text: "Wait" } } as AgentMessage,
    step(4, "w1", "", [{ id: "c2", name: "send_to_thread" }]),
    result(5, "w1", "c2", "send_to_thread")
  ];
  expect(endingsOf(twoRows, { ...stopped, draws: (row) => row.kind === "msg" && row.message.id === "a1" }).list).toEqual([["a1", { kind: "interrupted", at: at(5) }]]);
});

test("a turn that said anything has no ending of its own: its reply is the end", () => {
  const before = endingsOf([
    step(1, "w1", "On it.", [closes("c1", "Nothing is outstanding.")]),
    result(2, "w1", "c1", "end_sweep"),
    step(3, "w1", "")
  ]);
  expect(before.list).toEqual([]);
  const after = endingsOf([
    step(1, "w1", "", [closes("c1", "Nothing is outstanding.")]),
    result(2, "w1", "c1", "end_sweep"),
    step(3, "w1", "All of it is done.")
  ]);
  expect(after.list).toEqual([]);
});

test("a turn under way, or still writing, has no ending yet, and its closing call stays in its run", () => {
  const live = endingsOf(tidiedUp(), { activeWakeId: "w1" });
  expect(live.list).toEqual([]);
  expect(live.left).toEqual([]);
  expect(endingsOf(tidiedUp(), { activeWakeId: "another" }).list).toHaveLength(1);
});

test("a turn that stopped on a failure has none: its failure row says how it ended", () => {
  expect(endingsOf([...tidiedUp().slice(0, 5), failure(6, "w1")]).list).toEqual([]);
});

test("a turn whose start may not be loaded has none: what it said may be above", () => {
  // Older messages remain, and the loaded ones begin after this turn did.
  expect(endingsOf(tidiedUp(), { loadedFrom: at(1) }).list).toEqual([]);
  // They reach back to its start: the turn is whole.
  expect(endingsOf(tidiedUp(), { loadedFrom: at(0) }).list).toHaveLength(1);
  // A turn that does not say when it began is not known to be whole.
  const undated = tidiedUp().map((m) => ({ ...m, wakeStartedAt: null }));
  expect(endingsOf(undated, { loadedFrom: at(0) }).list).toEqual([]);
  expect(endingsOf(undated).list).toHaveLength(1);
});

test("a closing call that failed, has not answered, or gives no words settles nothing", () => {
  const silent: Array<[string, TurnEnding]> = [["a1", { kind: "silent", at: at(4) }]];
  const turn = (calls: Call, answer: AgentMessage[]) => [
    step(1, "w1", "", [{ id: "c1", name: "read_plan" }, calls]),
    result(2, "w1", "c1", "read_plan"),
    ...answer,
    step(4, "w1", "")
  ];
  expect(endingsOf(turn(closes("c2", "Nothing is outstanding."), [result(3, "w1", "c2", "end_sweep", true)])).list).toEqual(silent);
  expect(endingsOf(turn(closes("c2", "Nothing is outstanding."), [])).list).toEqual(silent);
  expect(endingsOf(turn(closes("c2", "   "), [result(3, "w1", "c2", "end_sweep")])).list).toEqual(silent);
  expect(endingsOf(turn(closes("c2", 7), [result(3, "w1", "c2", "end_sweep")])).list).toEqual(silent);
  // The same turn with a call that went through.
  expect(endingsOf(turn(closes("c2", " Nothing is outstanding. "), [result(3, "w1", "c2", "end_sweep")])).list).toEqual([
    ["a1", { kind: "settled", reason: "Nothing is outstanding.", callId: "c2", at: at(4) }]
  ]);
});

test("only the call that closes the follow-up gives the sentence: another call's reason is its own business", () => {
  const { list } = endingsOf([
    step(1, "w1", "", [{ id: "c1", name: "update_work_item", args: { reason: "The reviewer asked to hold the merge." } }]),
    result(2, "w1", "c1", "update_work_item"),
    step(3, "w1", "")
  ]);
  expect(list).toEqual([["a1", { kind: "silent", at: at(3) }]]);
});

test("of two closing calls the later sentence stands, and a turn drawn in two rows ends under the second", () => {
  const { rows, list } = endingsOf([
    step(1, "w1", "", [closes("c1", "First thought.")]),
    result(2, "w1", "c1", "end_sweep"),
    // The user's message lands mid-turn and splits the run.
    { ...base, id: "u3", seq: 3, role: "user", source: "user", wakeId: null, createdAt: at(3), content: { type: "text", text: "And the docs?" } } as AgentMessage,
    step(4, "w1", "", [{ id: "c2", name: "read_plan" }]),
    result(5, "w1", "c2", "read_plan"),
    step(6, "w1", "", [closes("c3", "Second thought.")]),
    result(7, "w1", "c3", "end_sweep"),
    step(8, "w1", "")
  ]);
  expect(rows.map((row) => (row.kind === "msg" ? row.message.id : null))).toEqual(["a1", "u3", "a4", "a8"]);
  expect(list).toEqual([["a4", { kind: "settled", reason: "Second thought.", callId: "c3", at: at(8) }]]);
});

test("a sentence given before the turn went on to other work is not its conclusion: the call stays where it is", () => {
  // The closing call is in the turn's first row; a message landed, and the turn
  // did more. Taking the sentence down to the last row would leave the first
  // row with nothing in it.
  const { list, left } = endingsOf([
    step(1, "w1", "", [closes("c1", "Nothing is outstanding.")]),
    result(2, "w1", "c1", "end_sweep"),
    { ...base, id: "u3", seq: 3, role: "user", source: "user", wakeId: null, createdAt: at(3), content: { type: "text", text: "And the docs?" } } as AgentMessage,
    step(4, "w1", "", [{ id: "c2", name: "read_plan" }]),
    result(5, "w1", "c2", "read_plan"),
    step(6, "w1", "")
  ]);
  expect(list).toEqual([["a4", { kind: "silent", at: at(6) }]]);
  expect(left).toEqual([]);
});

test("a turn none of whose rows draws anything has no row to say it finished under; a closing sentence is still drawn", () => {
  // A call can leave its run and draw nothing of its own (a send whose card
  // another row draws): the list says which rows draw.
  const quiet = [
    step(1, "w1", "", [{ id: "c1", name: "send_to_thread" }]),
    result(2, "w1", "c1", "send_to_thread"),
    step(3, "w1", "")
  ];
  expect(endingsOf(quiet, { draws: () => false }).list).toEqual([]);
  expect(endingsOf(quiet).list).toEqual([["a1", { kind: "silent", at: at(3) }]]);
  // Of two rows, the line goes under the last that draws.
  const twoRows = [
    step(1, "w1", "", [{ id: "c1", name: "read_plan" }]),
    result(2, "w1", "c1", "read_plan"),
    { ...base, id: "u3", seq: 3, role: "user", source: "user", wakeId: null, createdAt: at(3), content: { type: "text", text: "Yes" } } as AgentMessage,
    step(4, "w1", "", [{ id: "c2", name: "send_to_thread" }]),
    result(5, "w1", "c2", "send_to_thread"),
    step(6, "w1", "")
  ];
  expect(endingsOf(twoRows, { draws: (row) => row.kind === "msg" && row.message.id === "a1" }).list).toEqual([["a1", { kind: "silent", at: at(6) }]]);
  // The sentence is something to draw whatever the row's calls do.
  const closed = endingsOf(tidiedUp(), { draws: () => false });
  expect(closed.list.map(([id, ending]) => [id, ending.kind])).toEqual([["a1", "settled"]]);
  expect(closed.left).toEqual(["c4"]);
});

test("each turn is judged on its own, and a turn that drew nothing has no row to end under", () => {
  const { list } = endingsOf([
    // Woke, had nothing to do, said nothing: the transcript draws nothing for it.
    step(1, "w0", "", [], at(1)),
    ...tidiedUp().map((m) => ({ ...m, seq: m.seq + 1, id: `${m.id}x`, createdAt: at(m.seq + 1) })),
    step(20, "w2", "Here is what changed.", [], at(19))
  ]);
  expect(list.map(([id, ending]) => [id, ending.kind])).toEqual([["a1x", "settled"]]);
});

/** A worker's message to its manager: what woke the manager's next turn. */
const workerReply = (seq: number, id = `r${seq}`): AgentMessage => ({
  ...base, id, seq, role: "user", source: "feature-message", wakeId: null, createdAt: at(seq),
  content: { type: "text", text: "Single-file checks are done; all 38 pass." }
} as AgentMessage);
/** The one empty step a turn woken by mail leaves when it has nothing to add. */
const quietStep = (seq: number, wakeId: string, reason: AgentMessage["wakeReason"] = "user"): AgentMessage =>
  ({ ...step(seq, wakeId, "", [], at(seq - 1)), wakeReason: reason });
/** What the model is told at a turn's start; never drawn. */
const context = (seq: number, wakeId: string): AgentMessage => ({
  ...base, id: `x${seq}`, seq, role: "user", source: "runtime-context", wakeId, createdAt: at(seq),
  content: { type: "text", text: "Runtime context" }
} as AgentMessage);

test("a turn that drew nothing after a worker's reply ends under that reply", () => {
  // The manager read the reply, had nothing to add, and its turn left only
  // rows that are never drawn: the reply is the row that woke it.
  const quiet = [workerReply(1), context(2, "w1"), quietStep(3, "w1")];
  expect(endingsOf(quiet).list).toEqual([["r1", { kind: "silent", at: at(3) }]]);
  // Its time is when the turn's last message came.
  expect(endingsOf([...quiet, quietStep(4, "w1")]).list).toEqual([["r1", { kind: "silent", at: at(4) }]]);
  // Stopped before it drew anything, it says that instead.
  expect(endingsOf(quiet, { interrupted: ["w1"] }).list).toEqual([["r1", { kind: "interrupted", at: at(3) }]]);
  // Two replies, then the turn they woke: under the last one.
  expect(endingsOf([workerReply(1), workerReply(2), context(3, "w1"), quietStep(4, "w1")]).list)
    .toEqual([["r2", { kind: "silent", at: at(4) }]]);
  // A hidden row of no turn between them changes nothing.
  const system = { ...base, id: "s2", seq: 2, role: "system", source: "self", wakeId: null, createdAt: at(2), content: { type: "text", text: "system" } } as AgentMessage;
  expect(endingsOf([workerReply(1), system, quietStep(3, "w1")]).list).toEqual([["r1", { kind: "silent", at: at(3) }]]);
  // A turn resumed after a restart opens with its recovery line, a row of the
  // turn's own that is not its work: the reply delivered after it woke it.
  const recovered = { ...base, id: "b1", seq: 1, role: "user", source: "restart-recovery", wakeId: "w1", createdAt: at(1), content: { type: "text", text: "The server restarted." } } as AgentMessage;
  expect(endingsOf([recovered, workerReply(2), quietStep(3, "w1")]).list).toEqual([["r2", { kind: "silent", at: at(3) }]]);
  // A reply that came while it ran was read too: one line, under the last.
  expect(endingsOf([workerReply(1), quietStep(2, "w1"), workerReply(3), quietStep(4, "w1")]).list)
    .toEqual([["r3", { kind: "silent", at: at(4) }]]);
});

test("a turn that drew nothing gets no line while it runs, after it failed, or when its start may not be loaded", () => {
  const quiet = [workerReply(1), context(2, "w1"), quietStep(3, "w1")];
  expect(endingsOf(quiet, { activeWakeId: "w1" }).list).toEqual([]);
  expect(endingsOf([...quiet, failure(4, "w1")]).list).toEqual([]);
  // Older messages remain and the turn does not say when it began.
  expect(endingsOf([workerReply(1), { ...quietStep(2, "w1"), wakeStartedAt: null }], { loadedFrom: at(1) }).list).toEqual([]);
});

test("a turn that drew nothing ends under nothing but a worker's reply just before it", () => {
  // After the manager's own reply (a heartbeat woke it), or after the user's
  // message, the row before is not what woke it as a worker's reply is.
  const user = { ...base, id: "u1", seq: 1, role: "user", source: "user", wakeId: null, createdAt: at(1), content: { type: "text", text: "Thanks" } } as AgentMessage;
  expect(endingsOf([user, context(2, "w1"), quietStep(3, "w1")]).list).toEqual([]);
  expect(endingsOf([step(1, "w0", "All three are merged.", [], at(0)), context(2, "w1"), quietStep(3, "w1", "work-item-heartbeat")]).list).toEqual([]);
  // A worker's message that woke nobody (a note the user wrote to a worker
  // directly) is not what woke the heartbeat after it.
  expect(endingsOf([workerReply(1), quietStep(2, "w1", "work-item-heartbeat")]).list).toEqual([]);
  // A second quiet turn after the first does not take the reply's line.
  expect(endingsOf([workerReply(1), quietStep(2, "w1"), quietStep(3, "w2")]).list)
    .toEqual([["r1", { kind: "silent", at: at(2) }]]);
  // Nor when the first gets no line of its own: the reply was the first's.
  expect(endingsOf([workerReply(1), { ...quietStep(2, "w1"), wakeStartedAt: null }, quietStep(3, "w2")], { loadedFrom: at(1) }).list).toEqual([]);
  // A turn that began with an empty step and then replied: its reply is its end.
  expect(endingsOf([workerReply(1), quietStep(2, "w1"), { ...step(3, "w1", "All 38 pass; nothing to do.", [], at(1)), wakeReason: "user" }]).list).toEqual([]);
  // Nor while its rows are above the rows drawn so far: it drew them all the same.
  const worked = [{ ...step(1, "w1", "", [{ id: "c1", name: "read_plan" }], at(0)), wakeReason: "user" as const }, result(2, "w1", "c1", "read_plan"), workerReply(3), quietStep(4, "w1")];
  expect(endingsOf(worked, { window: 2 }).list).toEqual([]);
  expect(endingsOf([{ ...step(1, "w1", "Reading the plan first.", [], at(0)), wakeReason: "user" as const }, workerReply(2), quietStep(3, "w1")], { window: 2 }).list).toEqual([]);
  // A turn that drew something ends under its own row, not under the reply.
  expect(endingsOf([workerReply(1), context(2, "w1"), step(3, "w1", "", [{ id: "c1", name: "read_plan" }], at(2)), result(4, "w1", "c1", "read_plan"), step(5, "w1", "", [], at(2))]).list)
    .toEqual([["a3", { kind: "silent", at: at(5) }]]);
});

test("a turn that asked the user a question said something: nothing says it only finished", () => {
  const asking = (accepted: boolean): AgentMessage[] => [
    step(1, "w1", "", [{ id: "c1", name: "read_plan" }]),
    result(2, "w1", "c1", "read_plan"),
    step(3, "w1", "", [{ id: "c2", name: "ask_user", args: { question: "Push the branch?" } }]),
    {
      ...result(4, "w1", "c2", "ask_user", !accepted),
      content: {
        type: "tool_result", toolCallId: "c2", toolName: "ask_user", isError: !accepted,
        result: accepted ? { asked: true, questionId: "q_1", question: "Push the branch?", options: [] } : null
      }
    } as AgentMessage,
    step(5, "w1", "")
  ];
  expect(endingsOf(asking(true)).list).toEqual([]);
  // A question that was refused asked nothing: the turn is silent as before.
  expect(endingsOf(asking(false)).list).toEqual([["a1", { kind: "silent", at: at(5) }]]);
  // Stopped by a person after asking: its question is still what it said.
  expect(endingsOf(asking(true), { interrupted: ["w1"] }).list).toEqual([]);
});
