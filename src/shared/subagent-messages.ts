import type { BackgroundTaskStatus } from "./api/background-tasks.js";

/** How a run ended, as its result says. */
export type SubagentOutcome = Exclude<BackgroundTaskStatus, "queued" | "running">;

/** On a subagent-result message (flat in its metadata): which run, how it
 *  ended, how long it took and its reply — what the result card draws. The
 *  message's text is what the model reads (formatSubagentResultText); the
 *  card never reads it. */
export interface SubagentResultMetadata {
  taskId: string;
  outcome: SubagentOutcome;
  title: string;
  durationMs: number;
  /** The child's final text, as the run keeps it (cut at SUBAGENT_LIMITS.replyMaxChars). */
  reply: string | null;
  /** Why it failed, as its run records it; null when it did not. */
  error: string | null;
}

export function subagentResultMetadata(result: SubagentResultMetadata): Record<string, unknown> {
  return {
    taskId: result.taskId,
    outcome: result.outcome,
    title: result.title,
    durationMs: result.durationMs,
    reply: result.reply,
    error: result.error
  };
}

/** How long a run took, as its result says it: "45s", "4m 12s", "1h 05m". */
export function formatSubagentDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** What a parent reads when its subagent ends: how it ended, then its reply
 *  when it left one. Only a run the user stopped is ever delivered stopped
 *  (its own agent's stop and an archive tell nobody). */
export function formatSubagentResultText(input: {
  title: string;
  outcome: SubagentOutcome;
  durationMs: number;
  reply: string | null;
  error: string | null;
}): string {
  const after = formatSubagentDuration(input.durationMs);
  const ending =
    input.outcome === "finished"
      ? `finished after ${after}.`
      : input.outcome === "stopped"
        ? `stopped by the user after ${after}, before it finished.`
        : input.outcome === "failed"
          ? `failed after ${after}: ${withoutFinalStop(input.error)}.`
          : "was interrupted when Mandate restarted, before it finished. Start it again if you still need it.";
  const first = `[Subagent result] “${input.title}”: ${ending}`;
  const reply = input.reply?.trim() ?? "";
  return reply ? `${first}\n\n${reply}` : first;
}

/** The reason as recorded, without the full stop the sentence adds itself. */
function withoutFinalStop(error: string | null): string {
  return (error ?? "").trim().replace(/\.+$/, "") || "unknown error";
}
