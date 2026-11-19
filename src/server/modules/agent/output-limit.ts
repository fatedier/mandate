/** A step whose reply stopped at the model's output token limit (finish
 *  reason "length"): what the model is told, and how many such steps in a row
 *  a turn takes before it stops. */

/** The result of a call cut off mid-arguments: not run. */
export const OUTPUT_LIMIT_CALL_NOT_RUN =
  "Not run: your reply reached the output token limit before this call's arguments were complete. Make the call again with complete arguments, splitting large content across several smaller calls.";

/** The note after a reply cut off in its text. */
export const OUTPUT_LIMIT_TEXT_CUT =
  "Your last reply was cut off at the output token limit. Continue it: start again at the beginning of the sentence, line, list item or table row that was cut and write it in full; if you were inside a code block or a table, open it again first. Do not repeat anything before that point or mention the interruption.";

/** The note after a reply cut off before it wrote anything: reasoning only. */
export const OUTPUT_LIMIT_REASONING_ONLY =
  "Your last reply reached the output token limit while you were still reasoning, before any text or tool call, so nothing from it was kept. Reason more briefly and give your answer or next tool call well within the limit.";

/** The note after a reply cut off in a tool call the provider dropped. */
export const OUTPUT_LIMIT_CALL_DROPPED =
  "Your last reply was cut off at the output token limit while you were writing a tool call, so that call was not made. Make it again with complete arguments, splitting large content across several smaller calls.";

/** The stop line of a turn whose replies kept being cut off. */
export const OUTPUT_LIMIT_STOPPED = "Cut off at the output token limit.";

/** Cut steps in a row a turn goes on after; the next one ends it. */
export const OUTPUT_LIMIT_RETRIES = 2;

/** What a cut step leaves the model to read before the next one, or null
 *  when its tool results say it (each cut call's own). */
export function outputLimitNote(step: { text: boolean; calls: boolean; droppedCall: boolean }): string | null {
  if (step.droppedCall) return OUTPUT_LIMIT_CALL_DROPPED;
  if (step.calls) return null;
  return step.text ? OUTPUT_LIMIT_TEXT_CUT : OUTPUT_LIMIT_REASONING_ONLY;
}
