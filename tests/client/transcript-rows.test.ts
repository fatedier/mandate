import { describe, expect, test } from "bun:test";
import type { AgentMessage, PendingMessage } from "@/store/agent-chat";
import { runOpenKey } from "@/routes/window/chat/tool-run-summary";
import {
  datedRows,
  dividerSeedFor,
  FOLD_OVER_CHARS,
  foldOpenKey,
  foldsWhenLong,
  openFoldPausesFollow,
  openRunPausesFollow,
  rendersNothing,
  transcriptItems,
  type DatedRow,
  type TranscriptItem
} from "@/routes/window/chat/transcript-rows";
import { agentMessage } from "../helpers/typed.js";

// The transcript's rows as data: the same rules the list draws, without a DOM
// or the 200ms render-window release the list tests wait for.

const user = (id: string, createdAt: string, over: Partial<AgentMessage> = {}) =>
  agentMessage({ id, createdAt, content: { type: "text", text: id }, ...over });
const reply = (id: string, createdAt: string, wakeId: string, toolCallIds: string[] = []) =>
  agentMessage({
    id, createdAt, role: "assistant", source: "self", wakeId,
    content: { type: "assistant", text: id, toolCalls: toolCallIds.map((toolCallId) => ({ toolCallId, toolName: "bash", args: {} })) }
  });
const pending = (localId: string, status: PendingMessage["status"], messageId?: string): PendingMessage =>
  ({ localId, content: localId, status, createdAt: "2026-10-04T10:30:00.000Z", ...(messageId ? { messageId } : {}) });
const asItems = (messages: AgentMessage[]): TranscriptItem[] => messages.map((message) => ({ kind: "msg", message }));
const idOf = (item: TranscriptItem) => item.kind === "msg" ? item.message.id : item.pending.localId;
const shape = (rows: DatedRow[]) => rows.map((row) => row.kind === "item" ? idOf(row.item) : `${row.kind}:${row.key}`);

describe("transcriptItems", () => {
  const messages = [
    user("u1", "2026-10-04T10:00:00.000Z"),
    reply("a1", "2026-10-04T10:01:00.000Z", "w1", ["call-1"]),
    agentMessage({ id: "t1", role: "tool", source: "self", createdAt: "2026-10-04T10:01:30.000Z", content: { type: "tool_result", toolCallId: "call-1", toolName: "bash", result: "ok" } }),
    user("ctx", "2026-10-04T10:02:00.000Z", { source: "runtime-context" }),
    user("u2", "2026-10-04T10:03:00.000Z")
  ];
  const sends = new Map([
    ["p1", pending("p1", "queued")],
    ["p2", pending("p2", "sent", "u2")],
    ["p3", pending("p3", "sending")]
  ]);

  test("draws messages, then sends still on their way; tool results and model-only rows are not rows", () => {
    const { renderItems, toolResultsByCallId, hiddenQueuedCount } = transcriptItems(messages, sends, false);
    expect(renderItems.map(idOf)).toEqual(["u1", "a1", "u2", "p1", "p3"]);
    expect(toolResultsByCallId.get("call-1")?.result).toBe("ok");
    expect(hiddenQueuedCount).toBe(0);
  });

  // Notes about Your agent's page (a page answer, a page result) are for the
  // model: kept in the thread, never drawn, and never splitting a tool run.
  test("page answers and page results are not rows, and leave a tool run whole", () => {
    const withNotes = [
      user("u1", "2026-10-04T10:00:00.000Z"),
      reply("a1", "2026-10-04T10:01:00.000Z", "w1", ["call-1"]),
      user("note", "2026-10-04T10:01:10.000Z", { source: "page-result", content: { type: "text", text: "[Page] Version 2, from the page subagent “Tidy”: Done." } }),
      agentMessage({ id: "t1", role: "tool", source: "self", createdAt: "2026-10-04T10:01:30.000Z", content: { type: "tool_result", toolCallId: "call-1", toolName: "bash", result: "ok" } }),
      user("answer", "2026-10-04T10:01:40.000Z", { source: "page-input", content: { type: "text", text: "[Page answer, 10:01] {\"pick\":\"c\"}" } }),
      reply("a2", "2026-10-04T10:02:00.000Z", "w1")
    ];
    const { renderItems } = transcriptItems(withNotes, new Map(), false);
    expect(renderItems.map(idOf)).toEqual(["u1", "a1", "a2"]);
    expect(rendersNothing({ kind: "msg", message: withNotes[2]! })).toBe(true);
    expect(rendersNothing({ kind: "msg", message: withNotes[4]! })).toBe(true);
  });

  test("a sent message already in the thread is drawn once; queued ones can be left out and counted", () => {
    const { renderItems, hiddenQueuedCount } = transcriptItems(messages, sends, true);
    expect(renderItems.map(idOf)).toEqual(["u1", "a1", "u2", "p3"]);
    expect(hiddenQueuedCount).toBe(1);
  });
});

describe("datedRows", () => {
  test("a date divider opens each day; the hidden system row never takes it", () => {
    const system = agentMessage({ id: "sys", seq: 0, role: "system", source: "self", createdAt: "2026-10-03T08:00:00.000Z", content: { type: "text", text: "system" } });
    const rows = asItems([
      system,
      user("u1", "2026-10-03T10:00:00.000Z"),
      reply("a1", "2026-10-03T10:01:00.000Z", "w1"),
      reply("a2", "2026-10-03T10:02:00.000Z", "w1"),
      user("u2", "2026-10-04T09:00:00.000Z")
    ]);
    expect(shape(datedRows(rows, dividerSeedFor(rows, rows.length))))
      .toEqual(["sys", "date:u1", "u1", "a1", "a2", "date:u2", "u2"]);
  });

  test("a row five minutes or more after the last one ended gets the time; one sooner does not", () => {
    const rows = asItems([
      user("u1", "2026-10-04T10:00:00.000Z"),
      user("u2", "2026-10-04T10:04:00.000Z"),
      user("u3", "2026-10-04T10:09:00.000Z")
    ]);
    expect(shape(datedRows(rows, dividerSeedFor(rows, rows.length)))).toEqual(["date:u1", "u1", "u2", "date:u3", "u3"]);
  });

  test("rows above the render window decide the first drawn row's divider", () => {
    const all = asItems([user("u1", "2026-10-04T10:00:00.000Z"), user("u2", "2026-10-04T10:02:00.000Z")]);
    // Only u2 is drawn: u1, above the window, already opened the day.
    expect(shape(datedRows(all.slice(1), dividerSeedFor(all, 1)))).toEqual(["u2"]);
  });
});

describe("openRunPausesFollow", () => {
  const rows = asItems([reply("a1", "2026-10-04T10:01:00.000Z", "w1", ["call-1"])]);
  test("a run open on screen pauses following; on a phone, or with only a mark left, nothing does", () => {
    expect(openRunPausesFollow(rows, new Set([runOpenKey("call-1")]), false)).toBe(true);
    expect(openRunPausesFollow(rows, new Set([runOpenKey("call-1")]), true)).toBe(false);
    expect(openRunPausesFollow(rows, new Set([runOpenKey("call-gone")]), false)).toBe(false);
    expect(openRunPausesFollow(rows, new Set(), false)).toBe(false);
  });
  test("a call drawn elsewhere (its turn's closing sentence) is in no run, so its mark holds nothing", () => {
    const two = asItems([reply("a1", "2026-10-04T10:01:00.000Z", "w1", ["call-1", "call-2"])]);
    const open = new Set([runOpenKey("call-1")]);
    expect(openRunPausesFollow(two, open, false, new Set(["call-1"]))).toBe(false);
    // Another call of the same row is still a run on screen.
    expect(openRunPausesFollow(two, open, false, new Set(["call-2"]))).toBe(true);
  });
});

// A manager's long message in a worker's chat is folded until opened.
describe("a long message from the manager", () => {
  const long = "任".repeat(FOLD_OVER_CHARS + 1);
  const fromManager = (id: string, text: string) => agentMessage({ id, createdAt: "2026-10-09T15:54:00.000Z", source: "manager", content: { type: "text", text } });
  test("folds past 600 characters; a shorter one, the user's own, and a reply never do", () => {
    expect(FOLD_OVER_CHARS).toBe(600);
    expect(foldsWhenLong(fromManager("m1", long))).toBe(true);
    expect(foldsWhenLong(fromManager("m2", "任".repeat(FOLD_OVER_CHARS)))).toBe(false);
    expect(foldsWhenLong(agentMessage({ id: "u1", createdAt: "2026-10-09T15:54:00.000Z", content: { type: "text", text: long } }))).toBe(false);
    expect(foldsWhenLong(agentMessage({ id: "a1", createdAt: "2026-10-09T15:54:00.000Z", role: "assistant", source: "manager", content: { type: "assistant", text: long } }))).toBe(false);
  });
  test("opened, it holds the reader's place as an open run does, on a phone too; a mark with no message holds nothing", () => {
    const rows = asItems([fromManager("m1", long), fromManager("m2", "short")]);
    expect(openFoldPausesFollow(rows, new Set([foldOpenKey("m1")]))).toBe(true);
    expect(openFoldPausesFollow(rows, new Set())).toBe(false);
    // Not long enough to fold, so its mark opened nothing.
    expect(openFoldPausesFollow(rows, new Set([foldOpenKey("m2")]))).toBe(false);
    expect(openFoldPausesFollow(rows, new Set([foldOpenKey("gone")]))).toBe(false);
    // A run's mark is not a fold's.
    expect(openFoldPausesFollow(rows, new Set([runOpenKey("m1")]))).toBe(false);
  });
});
