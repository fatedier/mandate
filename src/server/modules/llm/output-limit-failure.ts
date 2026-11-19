import { carryFirstOutput, firstOutputOf } from "./first-output.js";

/** A background call (a summary, a memory pass) whose reply stopped at the
 *  output token limit: what came is cut short, never the whole of it. */
export const OUTPUT_LIMIT_FAILURE = "The reply reached the output token limit.";

/** Throws for such a reply, inside a candidate's attempt: recorded failed,
 *  and the next model on the route is tried, as for any other failure. The
 *  reply did come, so its error carries the time to its first output. */
export function throwIfCutOff(result: { finishReason?: unknown; firstOutputMs?: number | null }): void {
  if (result.finishReason !== "length") return;
  const error = new Error(OUTPUT_LIMIT_FAILURE);
  carryFirstOutput(error, firstOutputOf(result));
  throw error;
}
