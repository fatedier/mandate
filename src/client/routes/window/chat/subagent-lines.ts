import { isRecord } from "@shared/guards";
import type { BackgroundTaskKind, SubagentType } from "@shared/api-contracts";
import type { CommandOutcome, CommandResultMetadata } from "@shared/command-messages";
import type { SubagentOutcome, SubagentResultMetadata } from "@shared/subagent-messages";
import type { AgentMessage } from "@/store/agent-chat";
import type { ToolCallSpec, ToolResultSpec } from "./tool-run-summary";

/** A background task where it started and where its result landed, read
 *  from the conversation's rows. Pure, so which calls and messages become
 *  lines and cards is tested as data. */

export const SUBAGENT_TOOL = "subagent";

/** The task a call started: a subagent the server took (its result names
 *  the task, started or queued), or a bash command that went to the
 *  background (run_in_background, or moved at its timeout: its result names
 *  the task, running). One refused, or still on its way, started nothing and
 *  stays a call in its run. */
export function startedTask(
  call: ToolCallSpec,
  result: ToolResultSpec | null | undefined
): { taskId: string; title: string; kind: BackgroundTaskKind; type?: SubagentType } | null {
  if (!result || result.isError) return null;
  const value = result.result;
  if (!isRecord(value) || typeof value.taskId !== "string" || !value.taskId) return null;
  const args = isRecord(call.args) ? call.args : {};
  if (call.toolName === "bash") {
    if (value.status !== "running") return null;
    const description = typeof args.description === "string" ? args.description.trim() : "";
    return { taskId: value.taskId, title: description || (typeof args.command === "string" ? args.command : ""), kind: "command" };
  }
  if (call.toolName !== SUBAGENT_TOOL) return null;
  if (value.status !== "started" && value.status !== "queued") return null;
  return { taskId: value.taskId, title: typeof args.title === "string" ? args.title.trim() : "", kind: "subagent", type: args.type === "page" ? "page" : "general" };
}

const OUTCOMES: ReadonlySet<string> = new Set<SubagentOutcome>(["finished", "stopped", "failed", "interrupted"]);

/** A result as it landed in its conversation, read from its metadata alone
 *  (what the server recorded for the card: subagentResultMetadata);
 *  null for any other message, or one whose metadata is not a result's. The
 *  message's text is the model's and is never read here. */
export function subagentResultOf(message: AgentMessage): SubagentResultMetadata | null {
  if (message.source !== "subagent-result" || message.content.type !== "text") return null;
  const meta = message.content.metadata;
  if (!isRecord(meta)) return null;
  const { taskId, outcome, title, durationMs, reply, error } = meta;
  if (typeof taskId !== "string" || typeof outcome !== "string" || !OUTCOMES.has(outcome)) return null;
  if (typeof title !== "string" || typeof durationMs !== "number" || !Number.isFinite(durationMs)) return null;
  if (reply !== null && typeof reply !== "string") return null;
  return { taskId, outcome: outcome as SubagentOutcome, title, durationMs, reply, error: typeof error === "string" ? error : null };
}

const COMMAND_OUTCOMES: ReadonlySet<string> = new Set<CommandOutcome>(["exited", "user", "output", "signal", "interrupted"]);

/** A command's result as it landed, read from its metadata alone (what the
 *  server recorded: commandResultMetadata); null for any other message, or
 *  one whose metadata is not a command result's. Its text is the model's. */
export function commandResultOf(message: AgentMessage): CommandResultMetadata | null {
  if (message.source !== "command-result" || message.content.type !== "text") return null;
  const meta = message.content.metadata;
  if (!isRecord(meta)) return null;
  const { taskId, title, outcome, exitCode, signal, durationMs, outputLines } = meta;
  if (typeof taskId !== "string" || typeof title !== "string" || typeof outcome !== "string" || !COMMAND_OUTCOMES.has(outcome)) return null;
  if (exitCode !== null && typeof exitCode !== "number") return null;
  if (signal !== null && typeof signal !== "string") return null;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || typeof outputLines !== "number") return null;
  return { taskId, title, outcome: outcome as CommandOutcome, exitCode, signal, durationMs, outputLines };
}
