import type { WakeLlmCandidate } from "../wake-llm-attempts.js";

/** What an idle compaction is asked to do: only the
 *  candidate that kept the cache, only over the minimum, tagged with the
 *  minutes it waited. */
export interface IdleCompactOptions {
  /** The candidate whose cache is warm; no other is tried. */
  only: (candidate: WakeLlmCandidate) => boolean;
  /** The smallest context it compacts, as the compaction gate measures it. */
  minTokens: number;
  /** The minutes since the cache was last kept, written on the summary. */
  idleMinutes: number;
}

/** started: running under the thread's lock; busy: a turn holds the thread;
 *  small: under the minimum; nothing: nothing to fold into a summary. */
export type IdleCompactOutcome = "started" | "busy" | "small" | "nothing";
