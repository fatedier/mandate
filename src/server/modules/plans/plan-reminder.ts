import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { FeaturePlanDto } from "../../../shared/api/plans.js";
import { planHeadLines, renderPlanText, stepLine } from "../../../shared/plan-text.js";
import { planProgress } from "../../../shared/feature-state.js";
import { planRounds } from "../../../shared/plan-rounds.js";
import type { AgentMessage, AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { PlanStore } from "./plan-store.js";

export const PLAN_REMINDER_STEPS = 10;
/** And as long since the plan was touched, and since the last reminder: ten
 *  quick steps (files read in a row) are a minute, not work the plan fell
 *  behind; a long wait has few steps. */
export const PLAN_REMINDER_MS = 10 * 60_000;
const PLAN_TOOLS = new Set(["update_plan", "read_plan"]);

/** Whether the worker has gone PLAN_REMINDER_STEPS assistant steps and
 *  PLAN_REMINDER_MS without touching its plan, and as many and as long since
 *  the last reminder. Counted over the active history: after compaction the
 *  count starts again (timed from the window's start), and the initial
 *  context there carries the plan anyway. */
export function planReminderDue(messages: AgentMessage[], nowMs: number): boolean {
  let sinceTool = 0;
  let sinceReminder = 0;
  let toolAt: string | null = null;
  let reminderAt: string | null = null;
  for (let i = messages.length - 1; i >= 0 && !(toolAt && reminderAt); i--) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      const calls = m.content.type === "assistant" ? m.content.toolCalls ?? [] : [];
      if (!toolAt && calls.some((c) => PLAN_TOOLS.has(c.toolName))) toolAt = m.createdAt;
      if (!toolAt) sinceTool++;
      if (!reminderAt) sinceReminder++;
    } else if (m.source === "plan-reminder" && !reminderAt) {
      reminderAt = m.createdAt;
    }
  }
  if (sinceTool < PLAN_REMINDER_STEPS || sinceReminder < PLAN_REMINDER_STEPS) return false;
  const start = messages[0]?.createdAt ?? "";
  const elapsed = (at: string | null) => nowMs - Date.parse(at ?? start);
  return elapsed(toolAt) >= PLAN_REMINDER_MS && elapsed(reminderAt) >= PLAN_REMINDER_MS;
}

export function renderPlanReminder(plan: FeaturePlanDto): string {
  return [
    "<plan-reminder>",
    "The plan has not been updated for a while. If the work moved on (a step started, finished or got blocked, the picture changed), update it with update_plan. This is only a reminder; ignore it if nothing changed.",
    "",
    reminderPlanText(plan),
    "</plan-reminder>"
  ].join("\n");
}

/** The plan as the reminder shows it: its head and the steps not done; the
 *  done ones are counted, not listed (read_plan has them). */
function reminderPlanText(plan: FeaturePlanDto): string {
  const text = renderPlanText(plan);
  if (text === "No plan yet.") return text;
  const lines = planHeadLines(plan);
  const { done, total } = planProgress(plan);
  const open = planRounds(plan).current.filter((s) => s.status !== "done");
  if (open.length > 0) {
    lines.push("Steps not done:", ...open.map(stepLine));
    if (done > 0) lines.push("(Done steps are not shown; read_plan lists them.)");
  } else if (total > 0) {
    lines.push(`(All ${total} step${total === 1 ? "" : "s"} done.)`);
  }
  return lines.join("\n");
}

export function appendPlanReminderIfDue(
  deps: { agentStore: AgentStore; planStore: PlanStore; sse?: AgentSseEmitter },
  at: { threadId: string; wakeId: string; featureId: string }
): void {
  if (!planReminderDue(deps.agentStore.getActiveMessages(at.threadId), Date.now())) return;
  const message = deps.agentStore.appendMessage({
    threadId: at.threadId, role: "user", source: "plan-reminder", wakeId: at.wakeId,
    content: { type: "text", text: renderPlanReminder(deps.planStore.get(at.featureId)) }
  });
  deps.sse?.emit(SSE_EVENTS.agentMessageAppended, { threadId: at.threadId, message });
}
