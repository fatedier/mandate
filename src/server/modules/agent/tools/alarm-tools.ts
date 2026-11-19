import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { AgentAlarmManager, AlarmRecord } from "../agent-alarm-manager.js";
import { errorText } from "../../../../shared/error-text.js";
import { scheduleParams, listParams, cancelParams } from "./alarm-tools-schema.js";

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
      "woken with the note attached so future-you knows what to do. " +
      "To wait for something to change — a pane, a PR, a CI run — use monitor instead of scheduling wakes to check.",
    parameters: scheduleParams,
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
        return { error: errorText(err) };
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
