import { formatSubagentDuration } from "./subagent-messages.js";

/** How a background command ended, as its result says it. */
export type CommandOutcome = "exited" | "user" | "output" | "signal" | "interrupted";

/** On a command-result message (flat in its metadata): which command, how it
 *  ended and how long it took — what the result line draws. The text is what
 *  the model reads (formatCommandResultText). */
export interface CommandResultMetadata {
  taskId: string;
  title: string;
  outcome: CommandOutcome;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputLines: number;
}

export const COMMAND_LIMITS = {
  /** Running background commands per conversation; one more is refused. */
  perThread: 20,
  /** Output past this kills the command. */
  outputMaxBytes: 1024 ** 3,
  /** The end of the output the model reads: at most this many lines… */
  tailMaxLines: 2000,
  /** …and at most this many bytes. */
  tailMaxBytes: 51_200,
  /** A running command's last line reaches the client at most this often. */
  liveLineMs: 2000
} as const;

export type CommandLimits = Record<keyof typeof COMMAND_LIMITS, number>;

export const COMMAND_LIMIT_REACHED = "20 background commands of this conversation are running: stop one (stop_task) or wait for one to end.";

/** The refusal of one command more than a conversation may run: its own
 *  kind, so a move refused at the limit is told apart from other failures. */
export class CommandLimitReached extends Error {
  constructor(readonly limit: number) {
    super(COMMAND_LIMIT_REACHED.replace("20", String(limit)));
    this.name = "CommandLimitReached";
  }
}

export function commandResultMetadata(result: CommandResultMetadata): Record<string, unknown> {
  return {
    taskId: result.taskId,
    title: result.title,
    outcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    outputLines: result.outputLines
  };
}

/** What the conversation reads when its background command ends: how it
 *  ended, then the end of its output and where the whole of it is. */
export function formatCommandResultText(input: {
  title: string;
  outcome: CommandOutcome;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  tail: string;
  shownLines: number;
  totalLines: number;
  outputPath: string;
}): string {
  const after = formatSubagentDuration(input.durationMs);
  const ending = {
    exited: `exited ${input.exitCode} after ${after}.`,
    user: `stopped by the user after ${after}.`,
    output: `stopped after ${after}: its output passed 1 GB.`,
    signal: `ended on ${input.signal} after ${after}.`,
    interrupted: `was stopped when Mandate restarted, after ${after}. Run it again if you still need it.`
  }[input.outcome];
  const first = `[Background command] “${input.title}”: ${ending}`;
  if (input.totalLines === 0 && !input.tail) return `${first}\n\nIt printed nothing.`;
  const head = input.shownLines >= input.totalLines
    ? `Its ${input.totalLines} lines (the whole output is in ${input.outputPath}):`
    : `Last ${input.shownLines} of ${input.totalLines} lines (the whole output is in ${input.outputPath}):`;
  return `${first}\n\n${head}\n${input.tail}`;
}

const UNTIL_IT_ENDS = "You will be woken when it ends, with the end of its output. Until then you know nothing of how it went: do not report, assume or predict it, and do not wait for it with sleep or repeated reads.";

/** What bash returns for a command it started in the background. */
export function commandStartedMessage(taskId: string, outputPath: string): string {
  return `Running in the background as ${taskId}; its output goes to ${outputPath}. ${UNTIL_IT_ENDS} Carry on with other work, or end your turn. list_tasks shows what is running; stop_task stops it.`;
}

/** What bash returns for a foreground command still running at its timeout
 *  that could not move to the background: the limit was reached, and it was
 *  stopped. */
export function commandMoveRefusedMessage(movedAfterMs: number, limit: number): string {
  return `Still running after ${Math.round(movedAfterMs / 1000)} s, and it could not move to the background: ${limit} background commands of this conversation are running. It was stopped (outputSoFar holds its end so far). Stop one (stop_task) or wait for one to end, then run it again.`;
}

/** What bash returns for a foreground command it moved to the background at its timeout. */
export function commandMovedMessage(taskId: string, outputPath: string, movedAfterMs: number): string {
  return `Still running after ${Math.round(movedAfterMs / 1000)} s, so it moved to the background as ${taskId}; its output goes to ${outputPath} (outputSoFar holds its end so far). ${UNTIL_IT_ENDS}`;
}
