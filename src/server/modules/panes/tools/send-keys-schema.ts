import { z } from "zod";

export const params = z.object({
  paneId: z.string(),
  args: z.array(z.string()).min(1),
  // Read by the chat, not by the handler: keys like ["C-c"] say what was
  // pressed, not why. Optional, and asked for as bash's is.
  description: z.string().optional().describe(
    "What these keys do, in active voice and plain words. The user reads this in place of the " +
    "keys, so do not repeat them or the text typed; say what it is for. Keep it brief, 5-10 words: " +
    "[\"C-c\"] -> \"Stop the dev server\"; [\"-l\", \"bun run dev --port 4180\"] -> " +
    "\"Type the command to start the dev server\"; [\"Enter\"] after it -> \"Start the dev server\"; " +
    "[\"-l\", \"Review the uncommitted changes\"] to an agent -> \"Type a review request for Codex\"; " +
    "[\"Enter\"] after it -> \"Submit the review request\"; " +
    "[\"y\", \"Enter\"] -> \"Confirm the prompt\"."
  )
});
