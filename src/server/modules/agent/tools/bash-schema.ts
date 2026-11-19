import { z } from "zod";

export const params = z.object({
  command: z.string().min(1),
  // Read by the chat, not by the handler: the transcript shows this instead of
  // the command, which is often unreadable at a glance. Optional. Its
  // description says what to say, what not to repeat, how long, with examples.
  description: z.string().optional().describe(
    "A label for this command: the chat shows it where the command would be, to someone who may " +
    "never read the command. Say what the command is for, starting with a verb; do not restate it: " +
    "no flags, no file paths. 5-10 words. An everyday command gets a plain label: " +
    "bun install -> \"Install dependencies\"; bun test tests/chat-input.test.tsx -> \"Run the composer tests\"; " +
    "git log --oneline -5 -> \"Show the last five commits\". One that is hard to read (a pipeline, rare flags) " +
    "gets what it works out to: " +
    "rg -l TODO src | xargs wc -l -> \"Count lines in the files under src that mention TODO\"; " +
    "git fetch origin && git rebase origin/main -> \"Bring the branch up to date with main\"."
  ),
  cwd: z.string().optional(),
  // The unit is stated where the model reads it: told only "30s", models
  // passed 30, which ran as 30 ms.
  timeout: z.number().int().positive().max(600000).optional().describe(
    "Timeout in milliseconds (default 60000, max 600000)."
  )
});

/** The shell of an agent whose commands can run in the background: workers,
 *  managers and the personal agent. */
export const backgroundParams = params.extend({
  run_in_background: z.boolean().optional().describe(
    "Run the command in the background: the call returns at once with a taskId (no `&` needed), and the output goes to a file. " +
    "You are woken when it ends, with the end of its output. For commands that end (builds, test suites, waiting on CI), not for interactive programs."
  ),
  timeout: z.number().int().positive().max(600000).optional().describe(
    "Timeout in milliseconds for a command in the foreground (default 60000, max 600000). At the timeout it moves to the background. A command in the background has none."
  )
});

/** A shell whose foreground lasts a fixed time: no timeout to set. */
export const fixedForegroundParams = backgroundParams.omit({ timeout: true });
