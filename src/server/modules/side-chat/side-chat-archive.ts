import * as fs from "node:fs";
import * as path from "node:path";
import { formatAgentTime } from "../../platform/time/agent-time.js";
import type { AgentMessage } from "../agent/agent-store.js";

/** A time as the agents read it ("Thu 2026-11-05 18:42 +08:00"), split. */
function partsOf(at: Date | string, timeZone: string): { day: string; clock: string; full: string } {
  const full = formatAgentTime(at, timeZone) ?? "";
  const [, day = "", clock = ""] = full.split(" ");
  return { day, clock, full };
}

/** The file's name: the minute it was sent, in the server's zone, with -2,
 *  -3 … when that name is taken. */
export function sideChatArchiveName(at: Date, timeZone: string, taken: (name: string) => boolean): string {
  const { day, clock } = partsOf(at, timeZone);
  const base = `${day}-${clock.replace(":", "")}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.md` : `${base}-${n}.md`;
    if (!taken(name)) return name;
  }
}

/** A fence longer than any run of backticks in the text. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function resultText(content: AgentMessage["content"] | undefined): string {
  if (!content || content.type !== "tool_result") return "(no result)";
  if (content.isError) return `Error: ${content.error ?? "failed"}`;
  return typeof content.result === "string" ? content.result : JSON.stringify(content.result);
}

/** The whole side chat as Markdown: each question and answer with its time,
 *  each call with its arguments and its result as the side chat kept it, a
 *  background command's end with what it printed (its output file goes with
 *  the side chat), and a failure as its line. The boundary row is the
 *  model's, not the user's. */
export function sideChatArchiveMarkdown(rows: readonly AgentMessage[], at: Date, timeZone: string): string {
  const results = new Map<string, AgentMessage["content"]>();
  for (const row of rows) if (row.content.type === "tool_result") results.set(row.content.toolCallId, row.content);
  const lines = [`# Side chat · ${partsOf(at, timeZone).full}`, ""];
  // The answer whose heading was written last: its later steps go under it.
  let answer: string | null = null;
  for (const row of rows) {
    const clock = partsOf(row.createdAt, timeZone).clock;
    const content = row.content;
    if (row.role === "user" && content.type === "text" && row.source === "user") {
      lines.push(`## You · ${clock}`, "", content.text, "");
      answer = null;
    } else if (content.type === "assistant") {
      if (row.wakeId === null || row.wakeId !== answer) lines.push(`## Side chat · ${clock}`, "");
      answer = row.wakeId;
      if (content.text?.trim()) lines.push(content.text, "");
      for (const call of content.toolCalls ?? []) {
        lines.push(`Called \`${call.toolName}\` with \`${JSON.stringify(call.args ?? {})}\`:`, "", fenced(resultText(results.get(call.toolCallId))), "");
      }
    } else if (row.role === "user" && row.source === "command-result" && content.type === "text") {
      lines.push(`## Command · ${clock}`, "", fenced(content.text), "");
      answer = null;
    } else if (content.type === "wake_failure") {
      const head = content.status === "error" ? "Failed" : "Stopped";
      lines.push(`_${head} · ${clock}${content.message ? `: ${content.message}` : ""}_`, "");
    }
  }
  return lines.join("\n");
}

/** Writes the side chat to a new file in `dir` (never over another) and
 *  gives its path. */
export function writeSideChatArchive(dir: string, rows: readonly AgentMessage[], at: Date, timeZone: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const text = sideChatArchiveMarkdown(rows, at, timeZone);
  for (;;) {
    const file = path.join(dir, sideChatArchiveName(at, timeZone, (name) => fs.existsSync(path.join(dir, name))));
    try {
      fs.writeFileSync(file, text, { flag: "wx" });
      return file;
    } catch (err) {
      // Taken between the look and the write: the next free name.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}
