import type { AgentMessage } from "@/store/agent-chat";

/** A turn shorter than this needs no record of how long it took: the reply
 *  came back while the reader was still there. */
const WORKED_FOR_MIN_MS = 60_000;

/** How long each finished turn worked, from its wake's start to the last thing
 *  it wrote, for the turns that took over a minute. The running turn has no
 *  length yet. */
export function workedForByWake(messages: readonly AgentMessage[], activeWakeId: string | null): Map<string, number> {
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const message of messages) {
    if (!message.wakeId) continue;
    const start = message.wakeStartedAt ? Date.parse(message.wakeStartedAt) : Number.NaN;
    if (Number.isFinite(start)) starts.set(message.wakeId, start);
    const at = Date.parse(message.createdAt);
    if (Number.isFinite(at)) ends.set(message.wakeId, Math.max(ends.get(message.wakeId) ?? at, at));
  }
  const worked = new Map<string, number>();
  for (const [wakeId, start] of starts) {
    const end = ends.get(wakeId);
    if (wakeId === activeWakeId || end === undefined) continue;
    if (end - start > WORKED_FOR_MIN_MS) worked.set(wakeId, end - start);
  }
  return worked;
}
