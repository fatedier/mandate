import { expect, test } from "bun:test";
import type { TranscriptRow } from "@/routes/window/chat/transcript-rows";
import { cardItems, pickedRuns, preselection, rangeBetween, shareableRows, shareKeyOf, shareText } from "@/routes/window/chat/share-selection";
import { agentMessage } from "../helpers/typed.js";

// What can go into a shared image, what is picked when sharing begins at a
// message, and what the image is made of: the user's words and the agent's
// replies, in order, nothing else.

let at = 0;
const time = () => new Date(Date.UTC(2026, 10, 6, 10, 0, at++)).toISOString();
const user = (id: string, text = `Question ${id}`): TranscriptRow => ({ kind: "msg", message: agentMessage({ id, createdAt: time(), content: { type: "text", text } }) });
const reply = (id: string, wakeId: string | null, text = `Reply ${id}`): TranscriptRow => ({
  kind: "msg",
  message: agentMessage({ id, role: "assistant", source: "self", ...(wakeId ? { wakeId } : {}), createdAt: time(), content: { type: "assistant", text } })
});
const toolsOnly = (id: string, wakeId: string): TranscriptRow => ({
  kind: "msg",
  message: agentMessage({ id, role: "assistant", source: "self", wakeId, createdAt: time(), content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `call_${id}`, toolName: "bash", args: { command: "ls" } }] } })
});
const manager = (id: string): TranscriptRow => ({ kind: "msg", message: agentMessage({ id, source: "manager", createdAt: time(), content: { type: "text", text: "Draft the notes." } }) });
const notice = (id: string): TranscriptRow => ({ kind: "msg", message: agentMessage({ id, source: "thread-notice", createdAt: time(), content: { type: "text", text: "[Thread notice] done" } }) });
const isUserBubble = (row: TranscriptRow) => row.kind === "pending" || (row.message.role === "user" && row.message.source === "user");
const keys = (rows: readonly TranscriptRow[]) => rows.map(shareKeyOf);

test("only the user's sent words and the agent's reply text can be shared, in order; a turn still running cannot", () => {
  const pending: TranscriptRow = { kind: "pending", pending: { localId: "local_1", content: "Still sending", createdAt: time(), status: "sending" } as never };
  const rows = [user("u1"), toolsOnly("t1", "wake_1"), reply("r1", "wake_1"), notice("n1"), user("u2", "   "), reply("r2", "wake_2"), pending, user("u3"), reply("r3", "wake_3")];
  const shareable = shareableRows(rows, { isUserBubble, liveWakeIds: new Set(["wake_3"]) });
  expect(keys(shareable)).toEqual(["u1", "r1", "r2", "u3"]);
  expect(shareable.map(shareText)).toEqual(["Question u1", "Reply r1", "Reply r2", "Question u3"]);
});

test("sharing from a reply picks the question that started its turn through the turn's last reply", () => {
  const rows = [user("u0"), reply("r0", "wake_0"), user("u1"), reply("r1a", "wake_1"), user("u1b", "Also check the logs"), reply("r1b", "wake_1"), user("u2"), reply("r2", "wake_2")];
  const shareable = shareableRows(rows, { isUserBubble, liveWakeIds: new Set() });
  expect([...preselection("r1b", rows, shareable)]).toEqual(["u1", "r1a", "u1b", "r1b"]);
  // From the user's message: it and the turn it started.
  expect([...preselection("u1", rows, shareable)]).toEqual(["u1", "r1a", "u1b", "r1b"]);
  expect([...preselection("u2", rows, shareable)]).toEqual(["u2", "r2"]);
  // A message sent while the turn ran: from it on, not the replies before it.
  expect([...preselection("u1b", rows, shareable)]).toEqual(["u1b", "r1b"]);
});

test("a turn nobody asked for (a notice woke it) is picked alone; a question with no answer yet, or a reply outside a turn, alone too", () => {
  const rows = [user("u1"), reply("r1", "wake_1"), notice("n1"), reply("r2a", "wake_2"), reply("r2b", "wake_2"), reply("loose", null), user("u3")];
  const shareable = shareableRows(rows, { isUserBubble, liveWakeIds: new Set() });
  expect([...preselection("r2b", rows, shareable)]).toEqual(["r2a", "r2b"]);
  expect([...preselection("loose", rows, shareable)]).toEqual(["loose"]);
  expect([...preselection("u3", rows, shareable)]).toEqual(["u3"]);
  expect([...preselection("missing", rows, shareable)]).toEqual([]);
});

test("a reply's turn starts with the user's message only when that message is the row just before the turn", () => {
  // The user's request ended in commands alone; the manager's instruction, or a notice, woke the next turn.
  for (const waker of [manager("m1"), notice("n1")]) {
    const rows = [user("u1"), toolsOnly("t1", "wake_1"), waker, reply("r2", "wake_2")];
    const shareable = shareableRows(rows, { isUserBubble, liveWakeIds: new Set() });
    expect(keys(shareable)).toEqual(["u1", "r2"]);
    expect([...preselection("r2", rows, shareable)]).toEqual(["r2"]);
  }
  // A turn that ran commands before it wrote still starts at the message.
  const rows = [user("u1"), toolsOnly("t1", "wake_1"), reply("r1", "wake_1")];
  expect([...preselection("r1", rows, shareableRows(rows, { isUserBubble, liveWakeIds: new Set() }))]).toEqual(["u1", "r1"]);
  // A message the user sent while it ran commands is in it, with the one that started it.
  const midTurn = [user("u1"), toolsOnly("t1", "wake_1"), user("u2"), reply("r1", "wake_1")];
  expect([...preselection("r1", midTurn, shareableRows(midTurn, { isUserBubble, liveWakeIds: new Set() }))]).toEqual(["u1", "u2", "r1"]);
  // The notice that woke a turn is drawn as its cause line, not a row: the reply before is another turn's.
  const caused = [user("u1"), reply("r1", "wake_1"), reply("r2", "wake_2")];
  expect([...preselection("r2", caused, shareableRows(caused, { isUserBubble, liveWakeIds: new Set() }))]).toEqual(["r2"]);
});

test("a Shift range runs between the two rows whichever way it was drawn", () => {
  const rows = [user("u1"), reply("r1", "wake_1"), user("u2"), reply("r2", "wake_2")];
  const shareable = shareableRows(rows, { isUserBubble, liveWakeIds: new Set() });
  expect(rangeBetween(shareable, "r1", "r2")).toEqual(["r1", "u2", "r2"]);
  expect(rangeBetween(shareable, "r2", "u1")).toEqual(["u1", "r1", "u2", "r2"]);
  expect(rangeBetween(shareable, "r1", "gone")).toEqual(["gone"]);
});

test("the image holds the picked rows in order, with a break where rows between them were left out", () => {
  const rows = [user("u1"), reply("r1", "wake_1"), user("u2"), reply("r2", "wake_2"), user("u3"), reply("r3", "wake_3")];
  const shareable = shareableRows(rows, { isUserBubble, liveWakeIds: new Set() });
  // Picked out of order: the image follows the conversation.
  expect(cardItems(shareable, new Set(["r3", "u1", "r1", "u3"]))).toEqual([
    { key: "u1", side: "user", text: "Question u1", skipBefore: false },
    { key: "r1", side: "agent", text: "Reply r1", skipBefore: false },
    { key: "u3", side: "user", text: "Question u3", skipBefore: true },
    { key: "r3", side: "agent", text: "Reply r3", skipBefore: false }
  ]);
  expect(cardItems(shareable, new Set())).toEqual([]);
});

test("picked rows drawn one after another are one run; a divider between them, or a row not picked, ends it", () => {
  const drawn = ["u1", "a1", "a2", null, "u2", "b1", "u3", "b3"];
  const runs = pickedRuns(drawn, new Set(["u1", "a1", "a2", "u2", "b1", "b3"]));
  const marks = drawn.flatMap((key) => (key === null ? [] : [`${key}:${runs.get(key)?.above ? "^" : ""}${runs.get(key)?.below ? "v" : ""}`]));
  // u1..a2 one run; the divider parts it from u2..b1; u3 is not picked; b3 alone.
  expect(marks).toEqual(["u1:v", "a1:^v", "a2:^", "u2:v", "b1:^", "u3:", "b3:"]);
});
