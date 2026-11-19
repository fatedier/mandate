import { z } from "zod";

// How long the screen must stay unchanged is Mandate's (30s), not the agent's:
// agents set it to how long the work would take, however it was worded, and
// no other agent tool lets the model choose its quiet window. A call's
// unchangedFor is dropped.
export const workerPane = z.object({
  paneId: z.string().min(1).describe("Tmux pane id, for example %175. Use list_panes first if you do not know it.")
});

export const managerPane = workerPane.extend({
  workerId: z.string().min(1).describe("The worker's id, from list_workers or get_worker_status.")
});

export const command = z.object({
  run: z.string().min(1).describe("Shell command Mandate runs for you, where bash runs by default (your working directory), with the same powers as bash."),
  every: z.string().min(1).describe("How often to run it: '2m', '5m', '1h'. Between 1m and 6h."),
  wakeWhen: z.enum(["changed", "succeeds"]).optional().describe("'changed' (default): wake when the output differs from the last run. 'succeeds': wake when the command exits 0."),
  // Asked for as bash asks for its description: the chat shows it in place of
  // the command, and the wake message names it.
  description: z.string().optional().describe(
    "What this command waits on, in plain words. The user reads this in place of the command, often without " +
    "seeing the command, so do not repeat its text, flags or ids beyond what names the thing. Keep it to 5-10 words: " +
    "gh pr checks 123 --json state --jq … -> \"CI checks on PR 123\"; " +
    "gh api repos/o/r/issues/123/comments --jq '.[].id' -> \"New review comments on PR 123\"; " +
    "curl -fsS https://staging.example.com/health -> \"Staging comes back up\"."
  )
});

export const params = (pane: typeof workerPane | typeof managerPane) => z.object({
  pane: pane.optional().describe("Wake when this tmux pane's screen has been unchanged for 30s."),
  command: command.optional().describe("Wake when this command's output changes, or when it succeeds."),
  timeout: z.string().optional().describe("Give up after this long: pane default '30m', at most '2h'; command default '24h', at most '7d', and at least its every."),
  note: z.string().min(1).max(600).describe("Why you are waiting and what to do when woken; it comes back in the wake message.")
});

/** The monitor tool's input as each kind of agent is offered it: a worker
 *  names its own panes; a manager may name a worker's. */
export const workerMonitorParams = params(workerPane);
export const managerMonitorParams = params(managerPane);

export const listMonitorsParams = z.object({});

export const cancelMonitorParams = z.object({ monitorId: z.string().min(1) });
