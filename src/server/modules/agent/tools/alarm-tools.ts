import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { AgentAlarmManager, AlarmRecord } from "../agent-alarm-manager.js";

interface ScheduleWakeResult {
  alarmId: string;
  fireAt: string;
}

interface AlarmSummary {
  alarmId: string;
  fireAt: string;
  status: AlarmRecord["status"];
  note: string;
  firedAt?: string;
}

interface CancelAlarmResult {
  ok: true;
  alarmId: string;
  status: AlarmRecord["status"];
}

// One tool, one time field. Earlier designs (mode discriminator + optional
// delayMs/atTime; or two split tools schedule_wake_in/_at) tripped up
// LLMs that either misused the discriminator or had to pick between
// near-identical tool names.
const scheduleParams = z.object({
  when: z.string().min(1).describe(
    "When to wake. Use a relative duration like '30m', '2h', '1d', or an absolute ISO time with timezone like '2026-05-22T10:30:00+08:00'. Range: 1 second to 30 days from now."
  ),
  note: z.string().min(1).max(600).describe(
    "Why you're scheduling this wake — included in the alarm message so future-you knows what to do."
  )
});

const cancelParams = z.object({
  alarmId: z.string().min(1)
});

const listParams = z.object({
  includeFired: z.boolean().optional()
});

export function buildAlarmTools(manager: AgentAlarmManager): ToolDefinition[] {
  return [
    buildScheduleWakeTool(manager),
    buildListAlarmsTool(manager),
    buildCancelAlarmTool(manager)
  ];
}

function buildScheduleWakeTool(manager: AgentAlarmManager): ToolDefinition<z.infer<typeof scheduleParams>, ScheduleWakeResult | { error: string }> {
  return {
    name: "schedule_wake",
    description:
      "Schedule a future wake of YOUR OWN thread with a note describing why. " +
      "Persistent across server restarts. Use for 'check back in N minutes' or " +
      "'follow up after the build' patterns — when the alarm fires, you are " +
      "woken with the note attached so future-you knows what to do.",
    parameters: scheduleParams,
    approval: "never",
    handler: async (input, ctx) => {
      try {
        const alarm = manager.schedule({
          threadId: ctx.threadId,
          when: input.when,
          note: input.note
        });
        return {
          alarmId: alarm.id,
          fireAt: alarm.fireAt
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  };
}

function buildListAlarmsTool(manager: AgentAlarmManager): ToolDefinition<z.infer<typeof listParams>, { alarms: AlarmSummary[] }> {
  return {
    name: "list_my_alarms",
    description:
      "List alarms scheduled on YOUR OWN thread. By default returns only " +
      "pending alarms; pass includeFired=true to also see fired/canceled ones.",
    parameters: listParams,
    approval: "never",
    handler: async (input, ctx) => ({
      alarms: manager
        .list(ctx.threadId, { includeFired: input.includeFired ?? false })
        .map(alarmSummary)
    })
  };
}

function buildCancelAlarmTool(manager: AgentAlarmManager): ToolDefinition<z.infer<typeof cancelParams>, CancelAlarmResult | { error: string }> {
  return {
    name: "cancel_alarm",
    description:
      "Cancel a pending alarm by id (must be on YOUR OWN thread). Already-fired " +
      "alarms are unchanged.",
    parameters: cancelParams,
    approval: "never",
    handler: async (input, ctx) => {
      const result = manager.cancel(input.alarmId, ctx.threadId);
      if (!result) return { error: `alarm not found: ${input.alarmId}` };
      return {
        ok: true,
        alarmId: result.id,
        status: result.status
      };
    }
  };
}

function alarmSummary(alarm: AlarmRecord): AlarmSummary {
  return {
    alarmId: alarm.id,
    fireAt: alarm.fireAt,
    status: alarm.status,
    note: alarm.note,
    ...(alarm.firedAt ? { firedAt: alarm.firedAt } : {})
  };
}
