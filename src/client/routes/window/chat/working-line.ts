import type { AgentMessage, ThreadState } from "@/store/agent-chat";

export interface WorkingInputs {
  wakePhase: ThreadState["wakePhase"];
  compressionPhase: ThreadState["compressionPhase"];
  streaming: ThreadState["streamingAssistant"];
  messages: readonly AgentMessage[];
  /** The heading the running step's reasoning summary has reached, if any. */
  reasoningHeading?: string | null;
  /** When this wake's streaming reply last moved (client clock), if heard. */
  replyMovedAt?: number | null;
}

export interface WorkingLine {
  /** Compacting context (the word the boundary it leaves uses: "Compacted N
   *  earlier messages"), the heading the step's reasoning has reached, else
   *  Working. Never "Thinking": the model may be waiting, not
   *  reasoning. */
  verb: string;
  /** When the turn began; null when the client never heard. */
  since: string | null;
  /** Set while this wake's reply has text: when that text last moved. The
   *  line steps aside until it has been still for REPLY_QUIET_MS. */
  replyMovedAt?: number;
}

/** What the line says while a compaction runs. A menu that starts one says
 *  the same where the line is not in view (CompactNowItem). */
export const COMPACTING_VERB = "Compacting context";

/** How long the reply's text must stay still before the line comes back: a
 *  preamble before a long tool call, or a stream cut off, is not the reply
 *  moving. */
const REPLY_QUIET_MS = 1_500;

/** Whether the line shows at `now`: not while its wake's reply is moving. */
export function lineVisible(line: WorkingLine, now: number): boolean {
  return line.replyMovedAt === undefined || now - line.replyMovedAt >= REPLY_QUIET_MS;
}

/** What the chat's working line says, or null when it shows nothing. It names
 *  the phase the turn is in, and steps aside while the reply streams: the
 *  reply is then the thing that moves. It stays while a call runs: leaving
 *  for each call and coming back moved the whole chat by its height twice a
 *  call, and the run's line names the call. Its clock is the turn's, the
 *  only one shown. */
export function workingLine({ wakePhase, compressionPhase, streaming, messages, reasoningHeading, replyMovedAt }: WorkingInputs): WorkingLine | null {
  const wakeId = wakePhase.phase === "idle" ? null : wakePhase.wakeId;
  const wakeStart = wakeId
    ? wakePhase.startedAt ?? messages.find((message) => message.wakeId === wakeId && message.wakeStartedAt)?.wakeStartedAt ?? null
    : null;
  if (compressionPhase) return { verb: COMPACTING_VERB, since: wakeStart ?? compressionPhase.startedAt };
  if (!wakeId) return null;
  const line: WorkingLine = { verb: reasoningHeading || "Working", since: wakeStart };
  const replying = streaming?.wakeId === wakeId && streaming.totalText !== "";
  return replying && typeof replyMovedAt === "number" ? { ...line, replyMovedAt } : line;
}
