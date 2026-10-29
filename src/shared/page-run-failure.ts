/** Why a page run ended without publishing, where its run's end says so
 *  without an error of its own: the {{reason}} of Your agent's note. */
export const PAGE_RUN_FAILURE = {
  stoppedByUser: "the user stopped it",
  stoppedByAgent: "you stopped it",
  archived: "its conversation was archived",
  interrupted: "Mandate restarted while it ran"
} as const;

/** A failed page update's reason as the pane says it to the user: the
 *  reasons written for Your agent in the user's words, any other as it is. */
export function pageFailureShown(error: string, agentName: string): string {
  switch (error) {
    case PAGE_RUN_FAILURE.stoppedByUser: return "You stopped it.";
    case PAGE_RUN_FAILURE.stoppedByAgent: return `${agentName} stopped it.`;
    case PAGE_RUN_FAILURE.archived: return "The conversation was archived.";
    case PAGE_RUN_FAILURE.interrupted: return "Mandate restarted while it ran.";
    default: return error;
  }
}
