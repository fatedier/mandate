import type { AgentWakeReason } from "../../shared/api/agents.js";

/** The reason of a wake started for mail queued while the thread was busy or
 *  held. A thread woken only by reports, only by notices, only by its
 *  background commands' ends, only by results of its subagents (its page
 *  subagents' and its commands' among them), or only by its alarms says so; anything else a
 *  person or a worker sent reads as a message to answer. */
export function mailboxWakeReason(sources: readonly string[]): AgentWakeReason {
  if (sources.every((source) => source === "worker-report")) return "worker-report";
  if (sources.every((source) => source === "thread-notice")) return "thread-notice";
  if (sources.every((source) => source === "command-result")) return "command-result";
  if (sources.every((source) => source === "subagent-result" || source === "command-result" || source === "page-result")) return "subagent-result";
  if (sources.every((source) => source === "alarm")) return "alarm";
  return "user";
}

/** At start-up every thread with queued mail is woken as if a person had
 *  written, so a recovery runs and a stopped thread reads its mail as
 *  before; only a mailbox holding nothing but notices keeps its own reason. */
export function startupMailboxWakeReason(sources: readonly string[]): AgentWakeReason {
  return sources.length > 0 && mailboxWakeReason(sources) === "thread-notice" ? "thread-notice" : "user";
}
