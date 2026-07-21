import { z } from "zod";
import { SSE_EVENTS } from "../../../../shared/api/sse.js";
import type {
  AgentStore,
  AgentTask,
  FeatureEventArtifact,
  AgentTaskStatus,
  FeatureEventContent
} from "../agent-store.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import type { AgentSseEmitter } from "../../sse/sse-events.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { FeaturesStore } from "../../features/features-store.js";
import type { WakeScheduler } from "../wake-loop.js";
import type { WorkItemStore } from "../work-item-store.js";
import type { AgentUserMessageQueue } from "../user-message-queue.js";
import { featureTaskDispatchMetadata } from "../feature-task-dispatch-message.js";
import { buildFeatureEventSourceSnapshot } from "../feature-event-source-snapshot.js";
import { toWorkItemDto } from "../work-item-dto.js";
import { limitToolText } from "../tool-result-format.js";

const taskStatus = z.enum(["queued", "active", "waiting", "blocked", "done", "canceled"]);
const taskChannel = z.enum(["chat", "voice", "manager", "canvas", "watch"]);

const sendParams = z.object({
  feature: z.string().min(1).describe("Feature id — from list_features."),
  message: z.string().min(1).describe("Initial instructions for a new structured task."),
  title: z.string().trim().min(1).max(120).optional(),
  priority: z.number().int().min(0).max(10).optional(),
  channel: taskChannel.optional().describe("Entry channel. Defaults to manager; voice calls are set by the voice coordinator.")
});

const listParams = z.object({
  status: taskStatus.optional(),
  includeDone: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional()
});

const taskIdParams = z.object({
  taskId: z.string().min(1)
});

const updateParams = z.object({
  taskId: z.string().min(1),
  status: taskStatus.optional(),
  note: z.string().trim().max(2000).optional(),
  title: z.string().trim().min(1).max(120).optional()
}).refine((value) => Boolean(value.status || value.note || value.title), {
  message: "status, note, or title is required"
});

const canvasArtifact = z.object({
  type: z.literal("canvas"),
  canvasId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(500).refine((value) => value.startsWith("/canvas/"), {
    message: "canvas artifact path must start with /canvas/"
  }),
  role: z.string().trim().min(1).max(50).optional()
});

const artifact = z.discriminatedUnion("type", [canvasArtifact]);

const completeParams = z.object({
  taskId: z.string().min(1),
  summary: z.string().trim().min(1).max(20_000),
  artifacts: z.array(artifact).max(10).optional().describe(
    "Optional durable outputs to pass back to the caller, such as a canvas report. Keep summary short and attach detailed results here."
  )
});

const notifyParams = z.object({
  taskId: z.string().min(1).optional(),
  message: z.string().trim().min(1).max(20_000),
  kind: z.enum(["info", "progress", "blocked", "needs_user"]).optional(),
  artifacts: z.array(artifact).max(10).optional().describe(
    "Optional durable outputs to pass back to the caller, such as a canvas report."
  )
});

export interface FeatureTaskToolDeps {
  agentStore: AgentStore;
  projectsStore?: ProjectsStore;
  featuresStore: FeaturesStore;
  workStore?: WorkItemStore;
  sse: AgentSseEmitter;
  wakeScheduler: Pick<WakeScheduler, "wake" | "getRunningWakeForThread">;
  userMessageQueue?: Pick<AgentUserMessageQueue, "submitThreadUserMessage">;
  markPendingTaskWake?: (threadId: string) => void;
  markPendingMailboxWake?: (threadId: string) => void;
}

export function buildFeatureTaskSendTool(
  deps: FeatureTaskToolDeps
): ToolDefinition<z.infer<typeof sendParams>, {
  taskId?: string;
  featureThreadId?: string;
  status?: "started" | "queued";
  error?: string;
}> {
  return {
    name: "feature_task_send",
    description:
      "Create and send a new structured task to a worker's main conversation. " +
      "Use feature_message_send instead for questions, clarifications, feedback, or continuation. " +
      "The worker will see the task in its main thread and can use task_list/task_update/task_complete to manage it.",
    parameters: sendParams,
    approval: "never",
    handler: async ({ feature, message, title, priority, channel }, ctx) => {
      const f = deps.featuresStore.getById(feature);
      if (!f) return { error: `feature not found: ${feature}` };
      if (f.archivedAt) return { error: `feature is archived: ${feature}` };

      const thread = deps.agentStore.getOrCreateThread("worker", feature);
      const taskChannel = channel ?? "manager";
      const task = deps.agentStore.createTask({
        featureId: feature,
        threadId: thread.id,
        source: "agent",
        channel: taskChannel,
        title: title?.trim() || summarizeTitle(message),
        message,
        priority: priority ?? 0,
        callerThreadId: ctx.threadId,
        createdByThreadId: ctx.threadId
      });
      clearReviewPromptForFeature(deps, feature);
      const taskSource = taskChannel === "voice" ? "voice" : "manager";
      const taskMessageText = renderTaskMessage(task);
      if (deps.userMessageQueue) {
        const result = deps.userMessageQueue.submitThreadUserMessage({
          threadId: thread.id,
          source: taskSource,
          sourceThreadId: ctx.threadId,
          content: taskMessageText,
          pendingTaskWakeOnFlush: true,
          queueWhenBusy: false
        });
        if (result.queued) {
          deps.agentStore.enqueueMailboxMessage({
            threadId: thread.id,
            role: "user",
            source: taskSource,
            sourceThreadId: ctx.threadId,
            content: {
              type: "text",
              text: taskMessageText,
              metadata: featureTaskDispatchMetadata(task.id)
            }
          });
          return { taskId: task.id, featureThreadId: thread.id, status: "queued" };
        }
        if (!result.wakeId) {
          deps.markPendingTaskWake?.(thread.id);
          return { taskId: task.id, featureThreadId: thread.id, status: "queued" };
        }
        return { taskId: task.id, featureThreadId: thread.id, status: "started" };
      }

      const taskMessage = deps.agentStore.appendMessage({
        threadId: thread.id,
        role: "user",
        source: taskSource,
        sourceThreadId: ctx.threadId,
        content: {
          type: "text",
          text: taskMessageText
        }
      });
      deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: thread.id, message: taskMessage });

      const wakeId = deps.wakeScheduler.wake(thread.id, "user", taskMessage.id);
      if (!wakeId) {
        deps.markPendingTaskWake?.(thread.id);
        return { taskId: task.id, featureThreadId: thread.id, status: "queued" };
      }
      return { taskId: task.id, featureThreadId: thread.id, status: "started" };
    }
  };
}

export function buildFeatureTaskTools(
  deps: FeatureTaskToolDeps
): ToolDefinition[] {
  return [
    buildTaskListTool(deps),
    buildTaskGetTool(deps),
    buildTaskClaimTool(deps),
    buildTaskUpdateTool(deps),
    buildTaskCompleteTool(deps),
    buildTaskNotifyCallerTool(deps)
  ];
}

function buildTaskListTool(
  deps: FeatureTaskToolDeps
): ToolDefinition<z.infer<typeof listParams>, { tasks: ReturnType<typeof taskSummary>[] }> {
  return {
    name: "task_list",
    description:
      "List this feature's structured task queue. Use at the start of a wake and before deciding what to work on next.",
    parameters: listParams,
    approval: "never",
    handler: async ({ status, includeDone, limit }, ctx) => {
      const statuses = status ? [status as AgentTaskStatus] : undefined;
      return {
        tasks: deps.agentStore
          .listTasksForThread(ctx.lineageThreadId ?? ctx.threadId, { statuses, includeDone, limit })
          .map(taskSummary)
      };
    }
  };
}

function buildTaskGetTool(
  deps: FeatureTaskToolDeps
): ToolDefinition<z.infer<typeof taskIdParams>, { task?: ReturnType<typeof taskDetail>; error?: string }> {
  return {
    name: "task_get",
    description: "Read one task from this feature's structured task queue, with long text capped.",
    parameters: taskIdParams,
    approval: "never",
    handler: async ({ taskId }, ctx) => {
      const task = deps.agentStore.getTaskById(taskId);
      if (!task || task.threadId !== (ctx.lineageThreadId ?? ctx.threadId)) {
        return { error: `task not found: ${taskId}` };
      }
      return { task: taskDetail(task) };
    }
  };
}

function buildTaskClaimTool(
  deps: FeatureTaskToolDeps
): ToolDefinition<z.infer<typeof taskIdParams>, TaskMutationResult | { error: string }> {
  return {
    name: "task_claim",
    description: "Mark a queued/waiting/blocked task as active before you start working on it.",
    parameters: taskIdParams,
    approval: "never",
    handler: async ({ taskId }, ctx) => {
      const task = requireOwnedTask(deps.agentStore, taskId, ctx);
      if ("error" in task) return task;
      const updated = deps.agentStore.updateTask({ id: task.id, status: "active" });
      if (updated) clearReviewPromptForTask(deps, updated);
      return updated ? taskMutationResult(updated) : { error: `task not found: ${taskId}` };
    }
  };
}

function buildTaskUpdateTool(
  deps: FeatureTaskToolDeps
): ToolDefinition<z.infer<typeof updateParams>, TaskMutationResult | { error: string }> {
  return {
    name: "task_update",
    description:
      "Update task status or a short note. Use waiting after starting long-running tmux work plus watch_window; use blocked when user or caller input is needed.",
    parameters: updateParams,
    approval: "never",
    handler: async ({ taskId, status, note, title }, ctx) => {
      const task = requireOwnedTask(deps.agentStore, taskId, ctx);
      if ("error" in task) return task;
      const updated = deps.agentStore.updateTask({
        id: task.id,
        status: status as AgentTaskStatus | undefined,
        title,
        lastNote: note
      });
      if (updated && (updated.status === "active" || updated.status === "waiting")) {
        clearReviewPromptForTask(deps, updated);
      }
      return updated ? taskMutationResult(updated) : { error: `task not found: ${taskId}` };
    }
  };
}

function buildTaskCompleteTool(
  deps: FeatureTaskToolDeps
): ToolDefinition<z.infer<typeof completeParams>, {
  ok?: true;
  completedAt?: string | null;
  needsUserBumped?: "review";
  notifiedCaller?: boolean;
  callerWakeId?: string;
  error?: string;
}> {
  return {
    name: "task_complete",
    description:
      "Mark a task done with a summary stored in lastNote. " +
      "BEFORE calling this, decide: did this task advance the feature's main work, " +
      "or was it a side-task (one-off lookup/query)?\n" +
      "- Main work: FIRST call update_my_work_item({ phase: 'done', summary }) " +
      "so the dashboard reflects the result, THEN task_complete. " +
      "Do NOT try to set needsUser — that's manager/user only; the manager will " +
      "decide whether to flag the item for review when it sees the completion.\n" +
      "- Side-task: task_complete alone is fine.\n" +
      "When unsure, treat it as main work.\n" +
      "If the task has a caller (manager-dispatched), task_complete also wakes the " +
      "caller with a completion event carrying the summary + any artifacts. " +
      "task_complete will REJECT the call if the feature's work_item has no " +
      "bound canvas yet — create one via canvas_create({ bindToFeature: true }) " +
      "first, since the canvas is a required visual half of the dashboard.",
    parameters: completeParams,
    approval: "never",
    handler: async ({ taskId, summary, artifacts }, ctx) => {
      const task = requireOwnedTask(deps.agentStore, taskId, ctx);
      if ("error" in task) return task;

      // For manager-dispatched tasks (the "main work" path), the bound
      // work_item must have a canvas before we accept the completion. The
      // canvas is the required visual half of the dashboard; skipping it
      // would leave the user with only the 200-char summary. Block here
      // so the agent fixes it up before declaring done.
      if (deps.workStore && task.featureId && task.callerThreadId) {
        const wi = deps.workStore.getByFeature(task.featureId);
        if (wi && !wi.canvasId) {
          return {
            error:
              "this feature's work_item has no bound canvas yet. " +
              "Create one with canvas_create({ title, bindToFeature: true }) " +
              "and publish meaningful content (phase progress, key decisions, " +
              "open questions, etc.), then call task_complete again. " +
              "Every manager-dispatched feature task must leave behind a " +
              "canvas as the visual companion to the work_item summary."
          };
        }
      }

      const updated = deps.agentStore.updateTask({ id: task.id, status: "done", lastNote: summary });
      if (!updated) return { error: `task not found: ${taskId}` };

      // Auto-flag the work_item for user review on manager-dispatched task
      // completions. task_complete is the agent's most reliable "I'm done"
      // signal, so use that as the trigger. Side-tasks (no callerThreadId)
      // leave state alone. The manager can downgrade later if it judges no
      // review needed.
      let needsUserBumped = false;
      if (
        deps.workStore &&
        updated.featureId &&
        updated.callerThreadId
      ) {
        const wi = deps.workStore.getByFeature(updated.featureId);
        if (wi && wi.needsUser === null) {
          const next = deps.workStore.update(wi.id, { needsUser: "review" });
          if (next) {
            deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(next) });
            needsUserBumped = true;
          }
        }
      }

      const notified = updated.callerThreadId
        ? notifyCallerThread(deps, updated, summary, ctx.threadId, "completion", null, artifacts)
        : { notified: false, wakeId: null };
      return {
        ok: true,
        completedAt: updated.completedAt,
        ...(needsUserBumped ? { needsUserBumped: "review" as const } : {}),
        ...(notified.notified ? { notifiedCaller: true } : {}),
        ...(notified.wakeId ? { callerWakeId: notified.wakeId } : {})
      };
    }
  };
}

function buildTaskNotifyCallerTool(
  deps: FeatureTaskToolDeps
): ToolDefinition<z.infer<typeof notifyParams>, {
  ok?: true;
  notifiedCaller?: boolean;
  callerWakeId?: string;
  error?: string;
}> {
  return {
    name: "task_notify_caller",
    description:
      "Send a progress/blocker/update message to the caller before the task is complete. Use this sparingly for important updates.",
    parameters: notifyParams,
    approval: "never",
    handler: async ({ taskId, message, kind, artifacts }, ctx) => {
      const task = taskId
        ? requireOwnedTask(deps.agentStore, taskId, ctx)
        : firstCallableTask(deps.agentStore, ctx.lineageThreadId ?? ctx.threadId);
      if ("error" in task) return task;

      deps.agentStore.updateTask({ id: task.id, lastNote: message });

      // info / progress: silent — just record the note on the task.
      if (kind === "info" || kind === "progress" || !kind) {
        return { ok: true };
      }

      // blocked / needs_user: escalate to caller (the manager) via mailbox feature_event,
      // AND set needsUser='input' so the user sees it
      // immediately in the attention zone. The manager can downgrade later.
      if (deps.workStore && task.featureId) {
        const wi = deps.workStore.getByFeature(task.featureId);
        if (wi && wi.needsUser !== "input") {
          const next = deps.workStore.update(wi.id, { needsUser: "input" });
          if (next) {
            deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(next) });
          }
        }
      }
      const notified = notifyCallerThread(deps, task, message, ctx.threadId, "escalation", kind, artifacts);
      return {
        notifiedCaller: notified.notified,
        ...(notified.wakeId ? { callerWakeId: notified.wakeId } : {})
      };
    }
  };
}

function notifyCallerThread(
  deps: FeatureTaskToolDeps,
  task: AgentTask,
  summary: string,
  sourceThreadId: string,
  kind: "escalation" | "completion",
  signal: "blocked" | "needs_user" | null,
  artifacts?: FeatureEventArtifact[]
): { notified: boolean; wakeId: string | null } {
  if (!task.callerThreadId) return { notified: false, wakeId: null };
  const source = buildFeatureEventSourceSnapshot(deps, task.featureId);
  const content: FeatureEventContent = {
    type: "feature_event",
    kind,
    taskId: task.id,
    featureId: task.featureId,
    workItemId: source.workItem?.id ?? null,
    source,
    label: task.title,
    summary,
    ...(signal ? { signal } : {}),
    ...(artifacts?.length ? { artifacts } : {})
  };
  deps.agentStore.enqueueMailboxEvent({
    threadId: task.callerThreadId,
    role: "user",
    source: "feature-event",
    sourceThreadId,
    content
  });
  const wakeId = deps.wakeScheduler.wake(
    task.callerThreadId,
    "feature-event",
    null,
    { featureEvents: [content] }
  );
  if (!wakeId) deps.markPendingMailboxWake?.(task.callerThreadId);
  return { notified: true, wakeId };
}

function clearReviewPromptForTask(deps: FeatureTaskToolDeps, task: AgentTask): void {
  clearReviewPromptForFeature(deps, task.featureId);
}

function clearReviewPromptForFeature(deps: FeatureTaskToolDeps, featureId: string): void {
  if (!deps.workStore) return;
  const wi = deps.workStore.getByFeature(featureId);
  if (!wi || wi.needsUser !== "review") return;
  const next = deps.workStore.update(wi.id, { needsUser: null });
  if (next) deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(next) });
}

function requireOwnedTask(
  agentStore: AgentStore,
  taskId: string,
  ctx: ToolContext
): AgentTask | { error: string } {
  const task = agentStore.getTaskById(taskId);
  if (!task || task.threadId !== (ctx.lineageThreadId ?? ctx.threadId)) {
    return { error: `task not found: ${taskId}` };
  }
  return task;
}

function firstCallableTask(agentStore: AgentStore, threadId: string): AgentTask | { error: string } {
  const task = agentStore.listTasksForThread(threadId, {
    statuses: ["active", "waiting", "blocked", "queued"],
    limit: 10
  }).find((candidate) => Boolean(candidate.callerThreadId));
  return task ?? { error: "no task with a caller found" };
}

function taskSummary(task: AgentTask) {
  const lastNote = task.lastNote ? limitToolText(task.lastNote, 1200) : null;
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    source: task.source,
    channel: task.channel,
    priority: task.priority,
    ...(lastNote ? { lastNote: lastNote.text, ...(lastNote.truncated ? { lastNoteTruncated: true } : {}) } : {}),
    hasCaller: Boolean(task.callerThreadId),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt
  };
}

function taskDetail(task: AgentTask) {
  const message = limitToolText(task.message, 4000);
  return {
    ...taskSummary(task),
    message: message.text,
    ...(message.truncated ? { messageTruncated: true } : {})
  };
}

interface TaskMutationResult {
  ok: true;
  taskId: string;
  title: string;
  status: AgentTaskStatus;
}

function taskMutationResult(task: AgentTask): TaskMutationResult {
  return {
    ok: true,
    taskId: task.id,
    title: task.title,
    status: task.status
  };
}

function renderTaskMessage(task: AgentTask): string {
  return [
    `[Mandate feature task]`,
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Source: ${task.source}`,
    `Channel: ${task.channel}`,
    `Priority: ${task.priority}`,
    "",
    task.message
  ].join("\n");
}

function summarizeTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (!oneLine) return "Feature task";
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}
