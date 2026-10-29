/** A background call (a summary, a memory pass) whose reply stopped at the
 *  output token limit: what came is cut short, never the whole of it. */
export const OUTPUT_LIMIT_FAILURE = "The reply reached the output token limit.";

/** Throws for such a reply, inside a candidate's attempt: recorded failed,
 *  and the next model on the route is tried, as for any other failure. */
export function throwIfCutOff(finishReason: unknown): void {
  if (finishReason === "length") throw new Error(OUTPUT_LIMIT_FAILURE);
}
