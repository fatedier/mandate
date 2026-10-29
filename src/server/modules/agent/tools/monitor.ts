import { z } from "zod";
import type { AgentScope } from "../agent-store.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import type { FeaturesStore } from "../../features/features-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import { WINDOW_WATCH_LIMITS, type WindowWatchManager } from "../window-watch-manager.js";
import { COMMAND_MONITOR_LIMITS, CommandMonitorRefusal, type CommandMonitorManager } from "../command-monitor-manager.js";
import { formatDurationShort, parseDurationMs } from "../duration.js";
import { assertReadInScope } from "../tool-scope.js";
import { resolvePaneWindowKey } from "./pane-watch-target.js";


// How long the screen must stay unchanged is Mandate's (30s), not the agent's:
// agents set it to how long the work would take, however it was worded, and
// no other agent tool lets the model choose its quiet window. A call's
// unchangedFor is dropped.
const workerPane = z.object({
  paneId: z.string().min(1).describe("Tmux pane id, for example %175. Use list_panes first if you do not know it.")
});
const managerPane = workerPane.extend({
  featureId: z.string().min(1).optional().describe("The worker's feature id, from list_features or get_feature_status."),
  projectSlug: z.string().min(1).optional().describe("Project slug, with featureSlug, when featureId is unavailable."),
  featureSlug: z.string().min(1).optional().describe("Feature slug, with projectSlug.")
});
const command = z.object({
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
const params = (pane: typeof workerPane | typeof managerPane) => z.object({
  pane: pane.optional().describe("Wake when this tmux pane's screen has been unchanged for 30s."),
  command: command.optional().describe("Wake when this command's output changes, or when it succeeds."),
  timeout: z.string().optional().describe("Give up after this long: pane default '30m', at most '2h'; command default '24h', at most '7d', and at least its every."),
  note: z.string().min(1).max(600).describe("Why you are waiting and what to do when woken; it comes back in the wake message.")
});
type MonitorParams = z.infer<ReturnType<typeof params>> & { pane?: z.infer<typeof managerPane> };

const DESCRIPTION =
  "Ask Mandate to wake you when something happens, at no cost while you wait. Exactly one source:\n" +
  "- pane: wakes you when a tmux pane's screen has stayed unchanged for 30s. Use it after starting long-running work in a pane: " +
  "a program at work keeps its screen changing, so this suits long work too.\n" +
  "- command: Mandate runs `run` every `every` and wakes you once. Use it to wait on something outside a pane — a PR review, a CI run, a deploy — instead of scheduling wakes to check.\n" +
  "  Prefer wakeWhen 'succeeds' with the condition written into the command: it exits 0 when CI finished, the PR is approved, there are more than N comments. " +
  "Under 'succeeds' a check that cannot run looks like one still waiting: make sure the first run's output says what you expect. " +
  "A non-zero exit that also writes to stderr counts as a failed run; send stderr to /dev/null if the command writes there normally while you wait. " +
  "Use 'changed' only when you cannot say in advance what you are waiting for, and print only what you wait on — ids, counts, states — never times or durations: " +
  "output that differs between two runs 3s apart is refused. Under 'changed' any non-zero exit is a failed run; append `|| true` if the command can exit non-zero normally.\n" +
  "Registering a command monitor runs it at once and returns what it read. A monitor fires once and ends; register again to keep waiting. " +
  "Registering the same pane, or the same command in the same directory, again updates it instead of adding another. " +
  "Registering a monitor is an action: then stop and wait — do not re-read a watched pane or re-run the command yourself in the meantime. " +
  "list_my_monitors and cancel_monitor manage your monitors.";

export function buildMonitorTools(deps: {
  scope: AgentScope;
  watchManager: WindowWatchManager;
  commandMonitorManager?: CommandMonitorManager;
  projectsStore?: ProjectsStore;
  featuresStore?: FeaturesStore;
}): ToolDefinition[] {
  const monitor: ToolDefinition<MonitorParams, unknown> = {
    name: "monitor",
    description: DESCRIPTION,
    parameters: params(deps.scope === "worker" ? workerPane : managerPane) as z.ZodType<MonitorParams>,
    handler: async (args, ctx) => {
      if (Boolean(args.pane) === Boolean(args.command)) return { error: "monitor takes exactly one of pane or command" };
      if (args.pane) {
        const timeoutMs = args.timeout ? parseDurationMs(args.timeout) : WINDOW_WATCH_LIMITS.defaultTimeoutMs;
        if (timeoutMs === null || timeoutMs < 1000) return { error: "timeout must be a duration like '30m'" };
        if (timeoutMs > WINDOW_WATCH_LIMITS.maxTimeoutMs) return { error: "a pane monitor's timeout is at most 2h" };
        const result = deps.watchManager.register({
          ownerThreadId: ctx.threadId,
          windowKey: resolvePaneWindowKey(ctx, args.pane, deps),
          paneId: args.pane.paneId,
          stableMs: WINDOW_WATCH_LIMITS.defaultStableMs,
          timeoutMs,
          note: args.note
        });
        return { status: result.status, monitorId: result.watchId, kind: "pane", unchangedFor: formatDurationShort(result.stableMs), timeoutAt: result.timeoutAt };
      }
      const cmd = args.command!;
      if (!deps.commandMonitorManager) return { error: "command monitors are not available here" };
      const everyMs = parseDurationMs(cmd.every);
      if (everyMs === null) return { error: "every must be a duration like '5m'" };
      const timeoutMs = args.timeout ? parseDurationMs(args.timeout) : COMMAND_MONITOR_LIMITS.defaultTimeoutMs;
      if (timeoutMs === null) return { error: "timeout must be a duration like '24h'" };
      const wakeWhen = cmd.wakeWhen ?? "changed";
      try {
        const result = await deps.commandMonitorManager.register({
          ownerThreadId: ctx.threadId,
          command: cmd.run,
          cwd: defaultCwd(ctx),
          everyMs,
          wakeWhen,
          timeoutMs,
          note: args.note,
          description: cmd.description
        });
        if (result.status === "already_satisfied") {
          return { status: result.status, kind: "command", exitCode: 0, output: result.output, ...notesOf(result), note: "The condition already holds; nothing was registered." };
        }
        return {
          status: result.status, monitorId: result.monitorId, kind: "command", every: formatDurationShort(everyMs), wakeWhen,
          timeoutAt: result.timeoutAt, nextRunAt: result.nextRunAt, exitCode: result.exitCode, output: result.output, ...notesOf(result)
        };
      } catch (err) {
        if (err instanceof CommandMonitorRefusal) return { error: err.message, output: err.output };
        throw err;
      }
    }
  };
  const list: ToolDefinition<Record<string, never>, unknown> = {
    name: "list_my_monitors",
    description:
      "List the monitors waiting on YOUR OWN thread, pane and command, each with the monitorId cancel_monitor takes. " +
      "A monitor leaves this list once it fires or is cancelled.",
    parameters: z.object({}) as z.ZodType<Record<string, never>>,
    handler: async (_args, ctx) => ({
      monitors: [
        ...deps.watchManager.list(ctx.threadId).map((w) => ({
          monitorId: w.id, kind: "pane", paneId: w.paneId, windowKey: w.windowKey, unchangedFor: formatDurationShort(w.stableMs),
          note: w.note, createdAt: new Date(w.createdAtMs).toISOString(), timeoutAt: new Date(w.timeoutAtMs).toISOString()
        })),
        ...(deps.commandMonitorManager?.list(ctx.threadId) ?? []).map((m) => ({
          monitorId: m.id, kind: "command", command: m.command, cwd: m.cwd, every: formatDurationShort(m.everyMs), wakeWhen: m.wakeWhen,
          description: m.description, note: m.note, createdAt: m.createdAt, timeoutAt: m.timeoutAt, nextRunAt: m.nextRunAt,
          lastRunAt: m.lastRunAt, consecutiveFailures: m.consecutiveFailures
        }))
      ]
    })
  };
  const cancel: ToolDefinition<{ monitorId: string }, unknown> = {
    name: "cancel_monitor",
    description: "Cancel a monitor on YOUR OWN thread by monitorId, when what it waits on is no longer worth waiting for.",
    parameters: z.object({ monitorId: z.string().min(1) }),
    handler: async ({ monitorId }, ctx) => {
      const found = deps.watchManager.cancel(monitorId, ctx.threadId)?.id ?? deps.commandMonitorManager?.cancel(monitorId, ctx.threadId)?.id;
      return found ? { ok: true, monitorId: found } : { error: `monitor not found: ${monitorId}` };
    }
  };
  return [monitor, list, cancel];
}

/** Where bash runs by default: the worker's checkout, or the manager's directory. */
function defaultCwd(ctx: ToolContext): string {
  const dir = ctx.scope.kind === "worker"
    ? (ctx.scope.feature?.workingDir ?? ctx.scope.project.workingDir)
    : ctx.scope.managerDir;
  return assertReadInScope(dir || process.cwd(), ctx.scope);
}

/** What the first run wrote to stderr, and the warning that goes with it,
 *  when there is any: next to the output, which is stdout only. */
function notesOf(result: { stderr?: string; warning?: string }): { stderr?: string; warning?: string } {
  return {
    ...(result.stderr ? { stderr: result.stderr } : {}),
    ...(result.warning ? { warning: result.warning } : {})
  };
}
