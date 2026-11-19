import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { sideChatArchiveMarkdown, sideChatArchiveName } from "../src/server/modules/side-chat/side-chat-archive.js";
import { sideChatHandoffMessage, sideChatHandoffRequest } from "../src/server/modules/side-chat/side-chat-texts.js";
import { sweepSideChatArchives } from "../src/server/platform/fs/side-chat-archive-retention.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import { tempDir } from "./helpers/temp.js";

// What a side chat sent to the personal agent leaves: the file that keeps
// the whole of it, and the texts the two models read.

const ZONE = "Asia/Singapore";
// 18:42 in Singapore.
const AT = new Date("2026-11-05T10:42:30.000Z");

function row(seq: number, role: AgentMessage["role"], source: string, content: AgentMessage["content"], at = "2026-11-05T10:31:00.000Z", wakeId: string | null = null): AgentMessage {
  return { id: `side_x_${seq}`, threadId: "side_x", seq, role, source: source as AgentMessage["source"], sourceThreadId: null, wakeId, content, createdAt: at };
}

const ROWS: AgentMessage[] = [
  row(1, "user", "side-chat-boundary", { type: "text", text: "[Side chat] boundary" }),
  row(2, "user", "user", { type: "text", text: "Button or a nightly export?" }),
  row(3, "assistant", "self", { type: "assistant", text: "Let me look at the notes folder.", toolCalls: [{ toolCallId: "c1", toolName: "bash", args: { command: "ls docs/notes" } }] }, "2026-11-05T10:32:00.000Z", "side_x_a1"),
  row(4, "tool", "self", { type: "tool_result", toolCallId: "c1", toolName: "bash", result: "a.md\nb.md" }, "2026-11-05T10:32:00.000Z", "side_x_a1"),
  row(5, "assistant", "self", { type: "assistant", text: "A button is simpler.", toolCalls: [] }, "2026-11-05T10:32:30.000Z", "side_x_a1"),
  row(6, "user", "user", { type: "text", text: "Then a button." }, "2026-11-05T10:38:00.000Z"),
  row(7, "system", "wake-failure", { type: "wake_failure", status: "error", message: "provider down", stepCount: 0 }, "2026-11-05T10:39:00.000Z", "side_x_a2")
];

test("the summary request carries the note, or reads without one; the message the personal agent reads holds the summary, the file and the note", () => {
  expect(sideChatHandoffRequest("Go with the button.")).toBe(
    "The user is sending this side chat to your main conversation, which has not seen it, with this note:\nGo with the button.\n\n" +
    "Write the summary the main conversation needs to act on that note: what the user wants done, what was decided and why, what is still open, and the facts found that the work needs. " +
    "Keep every decision and constraint that bears on it, even ones the note does not mention; leave out what was looked at and dropped. " +
    "Write it in the user's language, as short notes, with no greeting. The whole side chat is kept in a file the main conversation can read, so there is no need to copy it."
  );
  expect(sideChatHandoffRequest("  ")).toBe(
    "The user is sending this side chat to your main conversation, which has not seen it.\n\n" +
    "Write the summary the main conversation needs to carry the work on: what the user wants done, what was decided and why, what is still open, and the facts found that the work needs. " +
    "Keep every decision and constraint; leave out what was looked at and dropped. " +
    "Write it in the user's language, as short notes, with no greeting. The whole side chat is kept in a file the main conversation can read, so there is no need to copy it."
  );
  expect(sideChatHandoffMessage({ summary: "- Export as Markdown.", file: "/d/side-chats/2026-11-05-1842.md", note: "Go with the button." })).toBe(
    "[Side chat] The user talked this over in a side chat beside this conversation. Its summary, written there:\n\n- Export as Markdown.\n\n" +
    "The whole side chat: /d/side-chats/2026-11-05-1842.md\n[End of side chat]\n\nGo with the button."
  );
  expect(sideChatHandoffMessage({ summary: "- Export.", file: "/f.md", note: "" })).toBe(
    "[Side chat] The user talked this over in a side chat beside this conversation. Its summary, written there:\n\n- Export.\n\nThe whole side chat: /f.md\n[End of side chat]"
  );
});

test("the file is named by the minute in the server's zone, with -2 when the name is taken; it holds the questions, answers, calls and failures", () => {
  expect(sideChatArchiveName(AT, ZONE, () => false)).toBe("2026-11-05-1842.md");
  const taken = new Set(["2026-11-05-1842.md", "2026-11-05-1842-2.md"]);
  expect(sideChatArchiveName(AT, ZONE, (name) => taken.has(name))).toBe("2026-11-05-1842-3.md");
  expect(sideChatArchiveMarkdown(ROWS, AT, ZONE)).toBe([
    "# Side chat · Thu 2026-11-05 18:42 +08:00",
    "",
    "## You · 18:31",
    "",
    "Button or a nightly export?",
    "",
    "## Side chat · 18:32",
    "",
    "Let me look at the notes folder.",
    "",
    "Called `bash` with `{\"command\":\"ls docs/notes\"}`:",
    "",
    "```",
    "a.md\nb.md",
    "```",
    "",
    "A button is simpler.",
    "",
    "## You · 18:38",
    "",
    "Then a button.",
    "",
    "_Failed · 18:39: provider down_",
    ""
  ].join("\n"));
});

test("a command's end is in the file with what it printed", () => {
  const ended = row(8, "user", "command-result", { type: "text", text: "[Background command ended] Build exited 0 after 2s.\nLast 1 of 1 lines:\nok" }, "2026-11-05T10:40:00.000Z");
  expect(sideChatArchiveMarkdown([...ROWS, ended], AT, ZONE).endsWith([
    "_Failed · 18:39: provider down_",
    "",
    "## Command · 18:40",
    "",
    "```",
    "[Background command ended] Build exited 0 after 2s.\nLast 1 of 1 lines:\nok",
    "```",
    ""
  ].join("\n"))).toBe(true);
});

test("the files of side chats go 30 days after they were written; younger ones and a folder that is not there are fine", () => {
  const dir = tempDir("md-handoff-retention-");
  const now = new Date("2026-12-10T00:00:00.000Z");
  const write = (name: string, daysOld: number) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "x");
    const at = new Date(now.getTime() - daysOld * 86_400_000);
    fs.utimesSync(file, at, at);
  };
  write("2026-11-08-1000.md", 31);
  write("2026-11-12-1000.md", 29);
  expect(sweepSideChatArchives({ dir, now })).toStrictEqual({ deleted: 1 });
  expect(fs.readdirSync(dir)).toStrictEqual(["2026-11-12-1000.md"]);
  expect(sweepSideChatArchives({ dir: path.join(dir, "missing"), now })).toStrictEqual({ deleted: 0 });
});
