import { expect, test } from "bun:test";
import type { AgentMessage } from "@/store/agent-chat";
import { rowActions, unansweredOwnMessages, type TranscriptFacts } from "@/routes/window/chat/row-actions";
import type { TranscriptRow } from "@/routes/window/chat/transcript-rows";
import { agentMessage } from "../helpers/typed.js";

// Which rows' action lines name their message for Open in panel: a turn's
// last reply, when Copy has the whole turn; nothing else.

const user = (id: string, at: string): AgentMessage => agentMessage({ id, createdAt: at, content: { type: "text", text: `Question ${id}` } });
const reply = (id: string, wakeId: string, at: string): AgentMessage =>
  agentMessage({ id, role: "assistant", source: "self", wakeId, createdAt: at, content: { type: "assistant", text: `Reply ${id}` } });
const row = (message: AgentMessage): TranscriptRow => ({ kind: "msg", message });

const stored = (rows: readonly TranscriptRow[]): AgentMessage[] => rows.flatMap((r) => (r.kind === "msg" ? [r.message] : []));

function facts(rows: TranscriptRow[], over: Partial<TranscriptFacts> = {}): TranscriptFacts {
  return {
    loaded: rows,
    // As the list gives it: over the stored messages, with whether a turn runs.
    unanswered: unansweredOwnMessages(stored(rows), (over.activeWakeId ?? null) !== null),
    loadedFrom: null,
    turnStarts: new Map(),
    activeWakeId: null,
    workedFor: new Map(),
    endings: new Map(),
    isUserBubble: (r) => r.kind === "msg" && r.message.role === "user",
    ...over
  };
}

test("the button is on a turn's last row only, and only when Copy has the whole turn", () => {
  const asked = row(user("u1", "2026-10-29T12:00:00.000Z"));
  const first = row(reply("r1a", "wake_1", "2026-10-29T12:00:10.000Z"));
  const last = row(reply("r1b", "wake_1", "2026-10-29T12:00:20.000Z"));
  const silent = row(agentMessage({
    id: "r2", role: "assistant", source: "self", wakeId: "wake_2", createdAt: "2026-10-29T12:01:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "call_1", toolName: "bash", args: { command: "ls" } }] }
  }));
  const rows = [asked, first, last, silent];
  const actions = rowActions(rows, facts(rows, { endings: new Map([[silent, { kind: "silent" as const, at: "2026-10-29T12:01:05.000Z" }]]) }));
  expect(actions.get(last)).toMatchObject({ copy: "Reply r1a\n\nReply r1b", messageId: "r1b" });
  expect(actions.get(first)).toBeUndefined();
  expect(actions.get(asked)?.messageId).toBeNull();
  expect(actions.get(silent)?.messageId).toBeNull();

  // A turn whose start is not loaded copies nothing, so it opens nothing.
  const partial = rowActions([last], facts([last], { loadedFrom: "2026-10-29T12:00:15.000Z" }));
  expect(partial.get(last)).toMatchObject({ copy: null, messageId: null });
});

test("a side chat sent to the personal agent copies the note the user wrote, not what the model read; with no note there is nothing to copy", () => {
  const sent = (id: string, note: string) => row(agentMessage({
    id, createdAt: "2026-11-05T10:00:00.000Z",
    content: { type: "text", text: "[Side chat] The user talked this over…", sideChat: { note, summary: "- Export.", file: "/f.md" } }
  }));
  const withNote = sent("s1", "Go with the button.");
  const bare = sent("s2", "");
  const actions = rowActions([withNote, bare], facts([withNote, bare]));
  expect(actions.get(withNote)?.copy).toBe("Go with the button.");
  expect(actions.get(bare)?.copy).toBeNull();
});

// A message of the owner's that the agent has not answered names itself for
// Delete: one they typed, with no reply and no tool call after it before the
// next message that came in, and no turn still running after the last one.
const at = (minute: number) => `2026-10-29T12:${String(minute).padStart(2, "0")}:00.000Z`;
const deletes = (rows: TranscriptRow[], over: Partial<TranscriptFacts> = {}) => {
  const actions = rowActions(rows, facts(rows, over));
  return rows.map((r) => actions.get(r)?.deleteId ?? null);
};

test("only an unanswered message the owner typed can be deleted; the last one not while a turn runs", () => {
  const answered = row(user("u1", at(0)));
  const first = row(reply("r1", "wake_1", at(1)));
  const stray = row(user("u2", at(2)));
  const notice = row(agentMessage({ id: "n1", source: "thread-notice", createdAt: at(3), content: { type: "text", text: "[Thread notice] stopped." } }));
  const second = row(reply("r2", "wake_2", at(4)));
  const last = row(user("u3", at(5)));
  const rows = [answered, first, stray, notice, second, last];
  expect(deletes(rows)).toEqual([null, null, "u2", null, null, "u3"]);
  // A turn under way: the last message waits for it to be stopped; the earlier one can go.
  expect(deletes(rows, { activeWakeId: "wake_3" })).toEqual([null, null, "u2", null, null, null]);
});

test("a tool call answers a message as a reply does; a failure line and a summary do not", () => {
  const called = row(user("u1", at(0)));
  const result = row(agentMessage({ id: "t1", role: "tool", source: "self", wakeId: "wake_1", createdAt: at(1), content: { type: "tool_result", toolCallId: "c1", toolName: "bash", result: "ok" } }));
  const failed = row(user("u2", at(2)));
  const failure = row(agentMessage({ id: "f1", role: "system", source: "wake-failure", wakeId: "wake_2", createdAt: at(3), content: { type: "wake_failure", status: "error", message: "LLM call failed", stepCount: 0 } }));
  const summary = row(agentMessage({ id: "s1", source: "compression", createdAt: at(4), content: { type: "summary", text: "Earlier: a report was asked for.", retained: [] } as never }));
  const rows = [called, result, failed, failure, summary];
  expect(deletes(rows, { isUserBubble: (r) => r.kind === "msg" && r.message.source === "user" })).toEqual([null, null, "u2", null, null]);
});

test("not a message sent for the owner, an answer picked for a question, a side chat handed over, or one still on its way", () => {
  const relayed = row(agentMessage({ id: "u1", createdAt: at(0), content: { type: "text", text: "Build it.", relay: { by: "personal", spoken: false, handoffId: "hof_1", name: "Juno" } } }));
  const answer = row(agentMessage({ id: "u2", createdAt: at(1), content: { type: "text", text: "Yes.", metadata: { answers: [{ id: "q_1", question: "Ship it?" }] } } }));
  const handed = row(agentMessage({ id: "u3", createdAt: at(2), content: { type: "text", text: "From a side chat.", sideChat: { note: "Carry this on." } as never } }));
  const pending: TranscriptRow = { kind: "pending", pending: { localId: "local_1", content: "On its way", status: "sending", createdAt: at(3) } as never };
  const rows = [relayed, answer, handed, pending];
  expect(deletes(rows, { isUserBubble: () => true })).toEqual([null, null, null, null]);
});

test("the rule reads the stored messages, not the drawn rows: what came in unseen ends the wait for an answer, what the model alone reads does not", () => {
  const stray = user("u1", at(0));
  const answer = reply("r1", "wake_1", at(2));
  const unseen = (id: string, source: AgentMessage["source"]) => agentMessage({ id, source, createdAt: at(1), content: { type: "text", text: `[${source}]` } });
  // Given on the agent's page: a message that came in, though the chat draws none.
  const given = [stray, unseen("p1", "page-input"), answer];
  expect([...unansweredOwnMessages(given, false)]).toEqual(["u1"]);
  // A reminder or the turn's context: the reply after it answers the message.
  expect([...unansweredOwnMessages([stray, unseen("p2", "plan-reminder"), answer], false)]).toEqual([]);
  expect([...unansweredOwnMessages([stray, unseen("p3", "runtime-context"), answer], false)]).toEqual([]);
  // The drawn rows hold neither; Delete follows what the list was given.
  const rows = [row(stray), row(answer)];
  expect(rowActions(rows, facts(rows, { unanswered: unansweredOwnMessages(given, false) })).get(rows[0]!)?.deleteId).toBe("u1");
  expect(rowActions(rows, facts(rows)).get(rows[0]!)?.deleteId).toBeNull();
});
