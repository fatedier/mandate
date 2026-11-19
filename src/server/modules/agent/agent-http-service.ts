import type { TaskBoardService } from "../task-board/task-board-service.js";
import type { AgentScope, AgentStore, AgentThread, AgentWakeReason } from "./agent-store.js";
import { resolveMentions } from "./mentions.js";
import { readPageQuotes } from "../../../shared/page-quotes.js";
import { normalizeThreadTitle, type ManagerThreadService } from "./manager-threads.js";
import type { ThreadArchive } from "./thread-archive.js";
import type { ThreadDeletion } from "./thread-delete.js";
import type { MessageDeletion } from "./message-delete.js";
import { ThreadLabelRefusal, type ThreadLabels } from "./thread-labels.js";
import type { CanvasStore } from "../canvas/canvas-store.js";
import type { AgentUserMessageQueue } from "./user-message-queue.js";
import type { ScopeRuntime } from "../../runtime/scope.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { ThreadModels } from "../../runtime/thread-models.js";
import type { AgentMessageAttachment, ModelInputType } from "../../../shared/agent-message-types.js";
import type { AnsweredQuestion } from "../../../shared/questions.js";
import type { AgentActiveWakeDto, AgentWakeMetadata, ModelRefDto, ThreadLabelDto, ThreadWorkerRefDto } from "../../../shared/api/agents.js";
import type { AgentClientMessageDto, AgentMessageDto, BackgroundTaskDto } from "../../../shared/api-contracts.js";
import type { DutyReportOutcome } from "../../../shared/api/schedules.js";
import type { AllPendingMonitorsSnapshot, PendingMonitorsSnapshot } from "./pending-monitors.js";
import { toAgentClientMessage, withDutyMarks } from "./agent-message-dto.js";
import { isRecord } from "../../../shared/guards.js";
import { listAgentCommands, runAgentCommand, type CommandHost } from "./commands.js";
import type { ManualCompactionOutcome } from "./compression.js";

export interface AgentsApiDeps {
  agentStore: AgentStore;
  /** For a mention of a canvas: whether it is there (without it, none is). */
  canvases?: Pick<CanvasStore, "getById">;
  /** For a mention of a task: the task, carried into the message (without it, none is). */
  taskBoard?: Pick<TaskBoardService, "detail">;
  /** The personal agent's name, as a task's comments name it. */
  agentName?: () => string;
  wakeScheduler: {
    wake: (
      threadId: string,
      reason: AgentWakeReason,
      triggerMessageId: string | null,
      metadata?: AgentWakeMetadata | null
    ) => string | null;
    cancelWake?: (wakeId: string) => { ok: boolean; wakeId: string; status: string; message?: string };
    getRunningWakeForThread?: (threadId: string) => { id: string } | null;
    /** The model a thread's running turn calls now. */
    modelInFlight?: (threadId: string) => ModelRefDto | null;
  };
  userMessageQueue: Pick<
    AgentUserMessageQueue,
    "submitUserMessage" | "submitThreadUserMessage" | "removeQueuedMessage" | "skipQuestion"
  >;
  /** Optional SSE emitter — when provided, user messages are broadcast like
   *  assistant ones (so all connected clients see the message in seq order
   *  rather than only the sender's pending-messages). */
  sse?: Pick<AgentSseEmitter, "emit">;
  /** The worker scope's runtime: worker routes ask it whether a worker id
   *  names a worker before anything else. */
  scopes: Pick<Record<AgentScope, ScopeRuntime>, "worker">;
  /** Current per-scope model capability check. When omitted (tests/minimal
   *  embedders), image input is accepted and the LLM layer decides. */
  modelSupportsInput?: (scope: AgentScope, input: ModelInputType) => boolean;
  /** Whether the model a thread runs on first (its own pick, else its
   *  route's) takes this input. When given, a message to a known thread is
   *  checked against it rather than against its scope's route. */
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  /** Compression threshold used as the current agent context-budget
   *  denominator. A function reads it at each request, so a change saved in
   *  the settings shows at once, as the turns' own updates show it. */
  contextBudgetTokens?: number | (() => number);
  /** Manager thread list/create/rename/archive/seen. Absent in embedders that
   *  do not serve threads; the thread routes then answer 404. */
  managerThreads?: ManagerThreadService;
  /** What became of duty threads' replies: history carries it. */
  dutyReportsFor?: (messageIds: string[]) => ReadonlyMap<string, DutyReportOutcome>;
  /** Archives a thread together with its workers. */
  threadArchive?: Pick<ThreadArchive, "archive">;
  /** Archived threads: listed, and deleted for good. */
  threadDeletion?: Pick<ThreadDeletion, "archivedThreads" | "delete" | "deleteAllArchived">;
  /** The owner's delete of a message of theirs the agent has not answered. */
  messageDeletion?: Pick<MessageDeletion, "delete" | "deletedIn">;
  threadLabels?: Pick<ThreadLabels, "add" | "remove">;
  /** The workers a thread owns, for its panel: active, or archived. */
  listThreadWorkers?: (threadId: string, archived: boolean) => ThreadWorkerRefDto[];
  /** What a thread's agent is still waiting on: its pending monitors. */
  pendingMonitors?: (threadId: string) => PendingMonitorsSnapshot;
  /** A thread's model as its composer shows and sets it. Absent: the model
   *  route answers 404. */
  threadModels?: Pick<ThreadModels, "state" | "set">;
  /** Every thread that waits on something, for the sidebar. */
  allPendingMonitors?: () => AllPendingMonitorsSnapshot;
  /** A compaction started by hand (the /compact command). Absent in embedders
   *  with no compression controller: /compact then finds nothing to compact. */
  compaction?: {
    start: (threadId: string) => ManualCompactionOutcome;
    inFlight: (threadId: string) => boolean;
  };
  /** A thread's background tasks (its subagents): listed newest first, and
   *  stopped by the user. Absent: no thread has any. */
  backgroundTasks?: {
    get: (taskId: string) => BackgroundTaskDto | null;
    /** Its brief and its reply, for its detail. */
    detailOf: (taskId: string) => { brief: string; reply: string | null } | null;
    pageForThread: (threadId: string, before: string | null) => { tasks: BackgroundTaskDto[]; olderDone: string | null; seq: number };
    changedSince: (threadId: string, since: number) => { tasks: BackgroundTaskDto[]; seq: number };
    stop: (taskId: string) => BackgroundTaskDto | null;
    /** A command's output now: its end, and how much there is. Null when its
     *  file cannot be read. */
    commandOutput?: (taskId: string) => { text: string; shownLines: number; totalLines: number; bytes: number; path: string } | null;
  };
}

type AgentHttpStatus = 200 | 201 | 202 | 400 | 404 | 409 | 500;

export interface AgentHttpResult<T = unknown> {
  status: AgentHttpStatus;
  body: T;
}

export class AgentHttpService {
  constructor(private readonly deps: AgentsApiDeps) {}

  private clientMessages(messages: AgentMessageDto[]): AgentClientMessageDto[] {
    return withDutyMarks(messages.map(toAgentClientMessage), this.deps.dutyReportsFor);
  }

  postWorkerMessage(input: { workerId: string | null; body: unknown }): AgentHttpResult {
    const verifyError = this.verifyWorker(input.workerId);
    if (verifyError) return json({ error: verifyError }, 404);
    const threadId = this.deps.agentStore.getThreadByScope("worker", input.workerId)?.id ?? null;
    const parsed = this.parseMessageInput("worker", input.body, threadId);
    if ("error" in parsed) return json({ error: parsed.error }, 400);

    const result = this.deps.userMessageQueue.submitUserMessage({
      scope: "worker",
      // verifyWorker refused a request without its worker id.
      scopeId: input.workerId!,
      content: parsed.content,
      attachments: parsed.attachments,
      clientRequestId: parsed.clientRequestId
    });
    return json({ ...result, wakeStartedAt: this.wakeStartedAt(result.wakeId) }, 202);
  }

  postThreadMessage(input: { threadId: string; body: unknown }): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(input.threadId);
    if (!acceptsThreadMessages(thread)) {
      return json({ error: "open thread not found" }, 404);
    }
    // The personal agent's page is quoted only in its own conversation.
    const pageQuotes = thread.scope === "personal" && isRecord(input.body) ? readPageQuotes(input.body.pageQuotes) : [];
    const parsed = this.parseMessageInput(thread.scope, input.body, thread.id, pageQuotes.length > 0);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    const answers = this.pickedAnswers(thread.id, isRecord(input.body) ? input.body.answers : undefined);
    if ("error" in answers) return json({ error: answers.error }, answers.status);
    // Continue under a stopped turn: the user's, and no answer to what was asked.
    const control = isRecord(input.body) && input.body.control === "continue" ? "continue" as const : null;
    const result = this.deps.userMessageQueue.submitThreadUserMessage({
      threadId: thread.id,
      content: parsed.content,
      attachments: parsed.attachments,
      source: "user",
      sourceThreadId: null,
      clientRequestId: parsed.clientRequestId,
      answers: answers.answers,
      control,
      mentions: resolveMentions({
        agentStore: this.deps.agentStore,
        ...(this.deps.canvases ? { canvases: this.deps.canvases } : {}),
        ...(this.deps.taskBoard ? { taskBoard: this.deps.taskBoard } : {}),
        ...(this.deps.agentName ? { agentName: this.deps.agentName } : {})
      }, thread.id, isRecord(input.body) ? input.body.mentions : undefined),
      pageQuotes
    });
    return json({ ...result, wakeStartedAt: this.wakeStartedAt(result.wakeId) }, 202);
  }

  /** The user skips a question of a manager thread or of the personal agent:
   *  it closes without an answer, and nobody is woken. One no longer open
   *  (answered in another window, taken back) is refused. */
  skipThreadQuestion(input: { threadId: string; questionId: string }): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(input.threadId);
    if (!acceptsThreadMessages(thread)) return json({ error: "open thread not found" }, 404);
    const question = this.deps.agentStore.openQuestions(thread.id).find((q) => q.id === input.questionId);
    if (!question) return json({ error: "That question is no longer open." }, 409);
    this.deps.userMessageQueue.skipQuestion(thread.id, question);
    return json({ ok: true });
  }

  /** A thread's model: Default, or what it was switched to, and the choices. */
  getThreadModel(threadId: string): AgentHttpResult {
    const state = this.deps.threadModels?.state(threadId);
    return state ? json({ model: state }) : json({ error: "thread not found" }, 404);
  }

  /** Switches it: `{ model: "provider/model" }`, or `{ model: null }` for Default. */
  setThreadModel(threadId: string, body: unknown): AgentHttpResult {
    if (!this.deps.threadModels) return json({ error: "thread not found" }, 404);
    const model = isRecord(body) ? body.model : undefined;
    if (model !== null && typeof model !== "string") return json({ error: "model must be a model name or null" }, 400);
    const result = this.deps.threadModels.set(threadId, model);
    return result.ok ? json({ model: result.state }) : json({ error: result.error }, result.status);
  }

  /** The commands a manager thread's or the personal agent's composer offers. */
  listThreadCommands(threadId: string): AgentHttpResult {
    if (!acceptsThreadMessages(this.deps.agentStore.getThreadById(threadId))) {
      return json({ error: "open thread not found" }, 404);
    }
    return json({ commands: listAgentCommands() });
  }

  /** The same for a worker, addressed by its worker like its messages. */
  listWorkerCommands(workerId: string | null): AgentHttpResult {
    const verifyError = this.verifyWorker(workerId);
    if (verifyError) return json({ error: verifyError }, 404);
    return json({ commands: listAgentCommands() });
  }

  runThreadCommand(input: { threadId: string; body: unknown }): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(input.threadId);
    if (!acceptsThreadMessages(thread)) return json({ error: "open thread not found" }, 404);
    return this.runCommandIn(thread.id, input.body);
  }

  runWorkerCommand(input: { workerId: string | null; body: unknown }): AgentHttpResult {
    const verifyError = this.verifyWorker(input.workerId);
    if (verifyError) return json({ error: verifyError }, 404);
    // A worker nobody has written to has no conversation yet, and a command
    // does not make one: nothing runs there, nothing is measured.
    return this.runCommandIn(this.deps.agentStore.getThreadByScope("worker", input.workerId)?.id ?? null, input.body);
  }

  /** A command is not a message: it goes to no queue, appends nothing and
   *  wakes nothing. */
  private runCommandIn(threadId: string | null, body: unknown): AgentHttpResult {
    const text = isRecord(body) && typeof body.text === "string" ? body.text : "";
    const attachments = isRecord(body) && typeof body.attachments === "number" && body.attachments > 0 ? body.attachments : 0;
    const result = runAgentCommand({ text, attachments }, this.commandHost(threadId));
    return result ? json(result) : json({ error: "not a command" }, 400);
  }

  private commandHost(threadId: string | null): CommandHost {
    const { wakeScheduler, compaction } = this.deps;
    return {
      compact: () => (threadId && compaction ? compaction.start(threadId) : "nothing"),
      compacting: () => Boolean(threadId && compaction?.inFlight(threadId)),
      stop: () => {
        const running = threadId ? wakeScheduler.getRunningWakeForThread?.(threadId) : null;
        return Boolean(running && wakeScheduler.cancelWake?.(running.id).ok);
      },
      contextUsage: () => {
        const usage = threadId ? this.contextUsageForThread(threadId) : null;
        if (!usage) return null;
        // No figure with a time on it: a compaction, and no call since.
        return { inputTokens: usage.inputTokens, budgetTokens: usage.budgetTokens, sinceCompaction: usage.inputTokens === null && usage.updatedAt !== null };
      }
    };
  }

  getThreadById(input: {
    threadId: string;
    since?: string;
    limit?: string;
    before?: string;
  }): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(input.threadId);
    if (!thread) {
      return json({ error: "thread not found" }, 404);
    }
    const since = optionalNumber(input.since);
    const limit = positiveInt(input.limit, 100);
    const before = optionalNumber(input.before);
    // A side chat's transcript starts at its first own row: the rows before
    // it are the conversation it was forked from, its model's context only.
    const fromSeq = thread.scope === "side_chat" ? this.deps.agentStore.sideChatStartSeq(thread.id) ?? 0 : undefined;
    const messages = since !== undefined
      ? this.deps.agentStore.getMessagesSince(thread.id, fromSeq === undefined ? since : Math.max(since, fromSeq - 1))
      : this.deps.agentStore.getMessagesPage(thread.id, {
          limit: limit + 1,
          beforeSeq: before,
          ...(fromSeq !== undefined ? { fromSeq } : {})
        });
    const hasMore = since === undefined && messages.length > limit;
    return json({
      thread,
      messages: this.clientMessages(since === undefined ? messages.slice(0, limit).reverse() : messages),
      hasMore,
      contextUsage: this.contextUsageForThread(thread.id),
      activeWake: this.activeWakeOf(thread.id),
      compacting: this.deps.compaction?.inFlight(thread.id) ?? false,
      ...this.monitorsOf(thread.id),
      ...(since !== undefined ? this.deletedOf(thread.id) : {}),
      readAt: new Date().toISOString()
    });
  }

  /** The messages deleted from a thread, for a read on from where a page
   *  was: it may hold one whose deletion it was never told of (its stream
   *  was down). Absent when there are none. A first page needs none: it
   *  holds the rows as they are. */
  private deletedOf(threadId: string): { deleted?: string[] } {
    const ids = this.deps.messageDeletion?.deletedIn(threadId) ?? [];
    return ids.length > 0 ? { deleted: ids } : {};
  }

  /** The questions a message says it answers by a pick, each with its own
   *  words as they were asked. One that is no longer open (answered in
   *  another window, taken back) refuses the whole message: sent without
   *  its mark it would read as typed, and answer every other question. */
  private pickedAnswers(threadId: string, raw: unknown): { answers: AnsweredQuestion[] } | { error: string; status: 400 | 409 } {
    if (raw === undefined) return { answers: [] };
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || !id)) {
      return { error: "answers must be a list of question ids", status: 400 };
    }
    const ids = [...new Set(raw as string[])];
    if (ids.length === 0) return { answers: [] };
    const open = new Map(this.deps.agentStore.openQuestions(threadId).map((q) => [q.id, q]));
    if (ids.some((id) => !open.has(id))) return { error: "That question is no longer open.", status: 409 };
    return { answers: ids.map((id) => ({ id, question: open.get(id)!.question })) };
  }

  /** Whether a message with images can go to a thread: by the model it runs
   *  on first when the thread is known, else by its scope's route. */
  private takesImages(scope: AgentScope, threadId: string | null): boolean {
    if (threadId && this.deps.supportsInputForThread) return this.deps.supportsInputForThread(threadId, "image");
    return !this.deps.modelSupportsInput || this.deps.modelSupportsInput(scope, "image");
  }

  /** `quoted`: the message quotes the page, so it may have no words. */
  private parseMessageInput(scope: AgentScope, body: unknown, threadId: string | null = null, quoted = false): ParsedMessageInput | { error: string } {
    const content = String(isRecord(body) ? body.content ?? "" : "").trim();
    const parsedAttachments = parseImageAttachments(isRecord(body) ? body.attachments : undefined);
    if ("error" in parsedAttachments) return parsedAttachments;
    if (!content && parsedAttachments.attachments.length === 0 && !quoted) {
      return { error: "content or image attachment is required" };
    }
    if (parsedAttachments.attachments.length > 0 && !this.takesImages(scope, threadId)) {
      return { error: "current agent model does not support image input" };
    }
    const clientRequestId = isRecord(body) && typeof body.clientRequestId === "string"
      ? body.clientRequestId
      : null;
    return {
      content,
      attachments: parsedAttachments.attachments,
      clientRequestId
    };
  }

  deleteWorkerQueuedMessage(input: { workerId: string | null; clientRequestId: string }): AgentHttpResult {
    const verifyError = this.verifyWorker(input.workerId);
    if (verifyError) return json({ error: verifyError }, 404);
    const thread = this.deps.agentStore.getThreadByScope("worker", input.workerId);
    const removed = thread
      ? this.deps.userMessageQueue.removeQueuedMessage(thread.id, input.clientRequestId)
      : false;
    return json({ ok: true, removed });
  }

  deleteThreadQueuedMessage(threadId: string, clientRequestId: string): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!acceptsThreadMessages(thread)) {
      return json({ error: "open thread not found" }, 404);
    }
    return json({
      ok: true,
      removed: this.deps.userMessageQueue.removeQueuedMessage(threadId, clientRequestId)
    });
  }

  getWorkerThread(input: {
    workerId: string | null;
    since?: string;
    limit?: string;
    before?: string;
  }): AgentHttpResult {
    const verifyError = this.verifyWorker(input.workerId);
    if (verifyError) return json({ error: verifyError }, 404);

    const thread = this.deps.agentStore.getThreadByScope("worker", input.workerId);
    if (!thread) return json({ thread: null, messages: [], hasMore: false });

    const since = optionalNumber(input.since);
    const limit = positiveInt(input.limit, 100);
    const before = optionalNumber(input.before);

    if (since !== undefined) {
      const messages = this.deps.agentStore.getMessagesSince(thread.id, since);
      return json({
        thread,
        messages: this.clientMessages(messages),
        hasMore: false,
        contextUsage: this.contextUsageForThread(thread.id),
        activeWake: this.activeWakeOf(thread.id),
        compacting: this.deps.compaction?.inFlight(thread.id) ?? false,
        ...this.monitorsOf(thread.id),
        ...this.deletedOf(thread.id),
        readAt: new Date().toISOString()
      });
    }

    const page = this.deps.agentStore.getMessagesPage(thread.id, {
      limit: limit + 1,
      beforeSeq: before
    });
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse();
    return json({
      thread,
      messages: this.clientMessages(messages),
      hasMore,
      contextUsage: this.contextUsageForThread(thread.id),
      activeWake: this.activeWakeOf(thread.id),
      compacting: this.deps.compaction?.inFlight(thread.id) ?? false,
      ...this.monitorsOf(thread.id),
      readAt: new Date().toISOString()
    });
  }

  listManagerThreads(archived?: string): AgentHttpResult {
    if (archived === "1") return json({ archived: this.deps.threadDeletion?.archivedThreads() ?? [] });
    return json({ threads: this.deps.managerThreads?.list() ?? [] });
  }

  /** Deletes a message of the owner's that the agent has not answered. */
  deleteThreadMessage(threadId: string, messageId: string): AgentHttpResult {
    const deletion = this.deps.messageDeletion;
    if (!deletion) return json({ error: "message not found" }, 404);
    const result = deletion.delete(threadId, messageId);
    return result.ok ? json(result) : json({ error: result.error }, result.status);
  }

  /** Deletes an archived thread for good; an open one is archived first. */
  deleteManagerThread(threadId: string): AgentHttpResult {
    const deletion = this.deps.threadDeletion;
    if (!deletion) return json({ error: "thread not found" }, 404);
    const result = deletion.delete(threadId);
    return result.ok ? json(result) : json({ error: result.error }, result.status);
  }

  /** Deletes every archived thread for good: only when the request names them. */
  deleteArchivedManagerThreads(archived?: string): AgentHttpResult {
    if (archived !== "1") return json({ error: "only archived threads can be deleted: send archived=1" }, 400);
    const deletion = this.deps.threadDeletion;
    if (!deletion) return json({ ok: true, count: 0, skipped: 0 });
    return json(deletion.deleteAllArchived());
  }

  createManagerThread(body: unknown): AgentHttpResult {
    const threads = this.deps.managerThreads;
    if (!threads) return json({ error: "threads are not available" }, 404);
    const record = isRecord(body) ? body : {};
    // Sent but unusable is an error, not an empty thread that dropped it.
    if (record.content !== undefined && typeof record.content !== "string") return json({ error: "content must be a string" }, 400);
    if (record.attachments !== undefined && !Array.isArray(record.attachments)) return json({ error: "attachments must be an array" }, 400);
    const hasContent = typeof record.content === "string" && record.content.trim().length > 0;
    const title = record.title === undefined ? null : normalizeThreadTitle(record.title);
    if (record.title !== undefined && !title) return json({ error: "title must be 1-80 characters on one line" }, 400);
    const hasAttachments = Array.isArray(record.attachments) && record.attachments.length > 0;
    if (hasContent || hasAttachments) {
      const parsed = this.parseMessageInput("manager", body);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      const created = threads.create(title);
      const sent = this.postThreadMessage({ threadId: created.id, body });
      return json({ thread: threads.dto(created.id), message: sent.body }, 201);
    }
    return json({ thread: threads.create(title), message: null }, 201);
  }

  patchManagerThread(threadId: string, body: unknown): AgentHttpResult | Promise<AgentHttpResult> {
    const threads = this.deps.managerThreads;
    const current = threads?.dto(threadId);
    if (!threads || !current || current.archivedAt) return json({ error: "thread not found" }, 404);
    if (!isRecord(body)) return json({ error: "invalid body" }, 400);
    if (body.archived === true) return this.archiveManagerThread(threadId, body);
    if (body.title !== undefined) {
      const result = threads.rename(threadId, body.title);
      return "error" in result ? json(result, 400) : json({ thread: result });
    }
    return json({ error: "nothing to change: send title or archived" }, 400);
  }

  listManagerThreadWorkers(threadId: string, archivedParam: string | undefined): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.scope !== "manager") return json({ error: "thread not found" }, 404);
    const archived = archivedParam === "1";
    return json({ workers: this.deps.listThreadWorkers?.(threadId, archived) ?? [] });
  }

  markManagerThreadSeen(threadId: string, body: unknown): AgentHttpResult {
    const threads = this.deps.managerThreads;
    const current = threads?.dto(threadId);
    if (!threads || !current || current.archivedAt) return json({ error: "thread not found" }, 404);
    const result = threads.markSeen(threadId, isRecord(body) ? body.seq : undefined);
    return "error" in result ? json(result, 400) : json({ thread: result });
  }

  /** The owner puts a label on a thread, open or archived; the answer is the
   *  thread's labels. */
  addThreadLabel(threadId: string, body: unknown): AgentHttpResult {
    const name = isRecord(body) ? body.name : undefined;
    if (typeof name !== "string") return json({ error: "name must be a string" }, 400);
    return this.changeThreadLabels((labels) => labels.add(threadId, name, "owner"));
  }

  removeThreadLabel(threadId: string, name: string): AgentHttpResult {
    return this.changeThreadLabels((labels) => labels.remove(threadId, name));
  }

  private changeThreadLabels(change: (labels: Pick<ThreadLabels, "add" | "remove">) => ThreadLabelDto[]): AgentHttpResult {
    const labels = this.deps.threadLabels;
    if (!labels) return json({ error: "thread not found" }, 404);
    try {
      return json({ labels: change(labels) });
    } catch (err) {
      if (err instanceof ThreadLabelRefusal) return json({ error: err.message }, err.status);
      throw err;
    }
  }

  /** With its workers (ThreadArchive). A refusal names the workers whose
   *  work would be lost and what was found in each; `confirmed` names the
   *  workers the user said to archive anyway. */
  private async archiveManagerThread(threadId: string, body: Record<string, unknown>): Promise<AgentHttpResult> {
    const archive = this.deps.threadArchive;
    if (!archive) return json({ error: "thread not found" }, 404);
    // The user's word is the list of workers they were shown. A box the user
    // unticked arrives as `false`; anything else is no choice.
    const result = await archive.archive({
      threadId,
      confirmed: Array.isArray(body.confirmed) ? body.confirmed.filter((id): id is string => typeof id === "string") : [],
      keepWorktrees: body.removeWorktrees === false,
      keepBranches: body.deleteBranches === false
    });
    if (result.ok) return json({ thread: result.thread, workers: result.workers, cleanupFailures: result.cleanupFailures });
    if (result.status === 404) return json({ error: result.error }, 404);
    return json({ error: result.error, workers: result.workers, archived: result.archived, cleanupFailures: result.cleanupFailures }, 409);
  }

  /** When a wake a send just started began: the client orders what it hears
   *  of a thread's wakes by their starts. */
  private wakeStartedAt(wakeId: string | null): string | null {
    return wakeId ? this.deps.agentStore.getWakeById(wakeId)?.startedAt ?? null : null;
  }

  /** What the thread's agent still waits on, and the revision it is current
   *  as of; nothing without a feed. */
  private monitorsOf(threadId: string): { monitors: PendingMonitorsSnapshot["monitors"]; monitorsRevision?: PendingMonitorsSnapshot["revision"] } {
    const snapshot = this.deps.pendingMonitors?.(threadId);
    return snapshot ? { monitors: snapshot.monitors, monitorsRevision: snapshot.revision } : { monitors: [] };
  }

  /** The thread's running wake, so a page opened mid-turn shows it working. */
  private activeWakeOf(threadId: string): AgentActiveWakeDto | null {
    const wake = this.deps.agentStore.getRunningWakeForThread(threadId);
    if (!wake) return null;
    const model = this.deps.wakeScheduler.modelInFlight?.(threadId) ?? null;
    return { wakeId: wake.id, startedAt: wake.startedAt, ...(model ? { model } : {}) };
  }

  /** GET /api/agents/active-wakes — every running wake with its thread's
   *  scope, so clients can rebuild live-activity state (which worker cards
   *  should "breathe") at boot and after SSE reconnects. */
  listActiveWakes(): AgentHttpResult {
    return json({ wakes: this.deps.agentStore.listRunningWakesWithScope() });
  }

  /** GET /api/agents/pending-monitors — every thread whose agent waits on a
   *  monitor, with whose thread it is, so the sidebar can draw a thread
   *  whose agents all sleep on one as watching. Read at boot
   *  and after SSE reconnects, as active-wakes is. */
  listPendingMonitors(): AgentHttpResult {
    const all = this.deps.allPendingMonitors?.();
    return json(all ?? { threads: [], revision: { boot: 0, seq: 0 } });
  }

  /** Runs a failed wake again as it was first run — its reason, what
   *  triggered it and its metadata — adding nothing to the transcript, and as
   *  its continuation: the new wake carries the failed one in its recovery
   *  chain, as a restart's recovery does, so what was delivered to the failed
   *  wake (a manager's request a reply is owed to) is found through it. Only
   *  an error, and only while its row is the thread's last message — the
   *  rule the page draws Retry by: anything written since has moved the
   *  conversation on, while a later turn that wrote nothing (a retry stopped
   *  at once) has not. */
  retryWake(wakeId: string): AgentHttpResult {
    const wake = this.deps.agentStore.getWakeById(wakeId);
    if (!wake) return json({ error: "wake not found" }, 404);
    if (wake.status !== "error") return json({ error: `only a failed wake can be retried; this one is ${wake.status}` }, 409);
    const last = this.deps.agentStore.getMessagesPage(wake.threadId, { limit: 1 })[0];
    if (last?.wakeId !== wake.id || last.content.type !== "wake_failure") {
      return json({ error: "the conversation has moved on since this turn failed" }, 409);
    }
    const before = wake.metadata?.recovery;
    const metadata: AgentWakeMetadata = {
      ...wake.metadata,
      recovery: {
        wakeIds: [...new Set([...(before?.wakeIds ?? []), wake.id])],
        originalReason: before?.originalReason ?? wake.reason,
        originalTriggerMessageId: before ? before.originalTriggerMessageId : wake.triggerMessageId
      }
    };
    const next = this.deps.wakeScheduler.wake(wake.threadId, wake.reason, wake.triggerMessageId, metadata);
    if (!next) return json({ error: "the thread is busy or closed" }, 409);
    return json({ ok: true, wakeId: next });
  }

  cancelWake(wakeId: string): AgentHttpResult {
    const wake = this.deps.agentStore.getWakeById(wakeId);
    if (!wake) return json({ error: "wake not found" }, 404);
    if (!this.deps.wakeScheduler.cancelWake) return json({ error: "wake cancellation is not available" }, 400);
    const result = this.deps.wakeScheduler.cancelWake(wakeId);
    return json(result, result.ok ? 200 : 409);
  }

  /** GET /api/agents/threads/:threadId/tasks — the thread's background
   *  tasks: its open ones and latest done ones (?before= the next page of
   *  done ones), or those changed after a number (?since=). */
  listThreadTasks(threadId: string, query: { before?: string | null; since?: string | null } = {}): AgentHttpResult {
    if (!this.deps.agentStore.getThreadById(threadId)) return json({ error: "thread not found" }, 404);
    const tasks = this.deps.backgroundTasks;
    if (query.since != null) {
      if (!/^\d+$/.test(query.since)) return json({ error: "since must be a whole number" }, 400);
      return json(tasks ? tasks.changedSince(threadId, Number(query.since)) : { tasks: [], seq: 0 });
    }
    return json(tasks ? tasks.pageForThread(threadId, query.before ?? null) : { tasks: [], olderDone: null, seq: 0 });
  }

  /** GET /api/agents/tasks/:taskId — one task's detail (its brief, its
   *  reply, how many calls it made), also for a line in a conversation whose
   *  task is older than the pages its list has read. */
  getTask(taskId: string): AgentHttpResult {
    const tasks = this.deps.backgroundTasks;
    const task = tasks?.get(taskId);
    const detail = task ? tasks!.detailOf(taskId) : null;
    if (!task || !detail) return json({ error: "task not found" }, 404);
    if (task.kind === "command") {
      // The end of its output as it is now; a file gone keeps the end it was told.
      const output = tasks!.commandOutput?.(taskId) ?? null;
      return json({
        task, brief: detail.brief, reply: output ? output.text : detail.reply, stepCount: 0,
        output: output
          ? { shownLines: output.shownLines, totalLines: output.totalLines, bytes: output.bytes, path: output.path }
          : { shownLines: 0, totalLines: 0, bytes: 0, path: task.outputPath ?? "" }
      });
    }
    return json({ task, brief: detail.brief, reply: detail.reply, stepCount: task.childThreadId ? this.deps.agentStore.countToolCalls(task.childThreadId) : 0 });
  }

  /** POST /api/agents/tasks/:taskId/stop — the user's Stop. A queued task
   *  ends at once; a running one comes back still running, and its wake's end
   *  records the stop (announced as backgroundTaskChanged). */
  stopTask(taskId: string): AgentHttpResult {
    const tasks = this.deps.backgroundTasks;
    const task = tasks?.get(taskId);
    if (!tasks || !task) return json({ error: "task not found" }, 404);
    if (task.status !== "queued" && task.status !== "running") return json({ error: `task is already ${task.status}` }, 409);
    const stopped = tasks.stop(taskId);
    return stopped ? json({ task: stopped }) : json({ error: "task is no longer running" }, 409);
  }

  /** Why a worker route's worker id names no worker; null when it does. */
  private verifyWorker(workerId: string | null): string | null {
    return this.deps.scopes.worker.verifyScopeId(workerId);
  }

  private contextUsageForThread(threadId: string) {
    const budget = typeof this.deps.contextBudgetTokens === "function" ? this.deps.contextBudgetTokens() : this.deps.contextBudgetTokens;
    if (!budget) return null;
    return this.deps.agentStore.getContextUsage(threadId, budget);
  }
}

interface ParsedMessageInput {
  content: string;
  attachments: AgentMessageAttachment[];
  clientRequestId: string | null;
}

/** Threads the thread-id message routes serve: an open manager thread, the
 *  personal agent's, or a side chat. Worker threads keep their /workers/:id routes. */
function acceptsThreadMessages(thread: AgentThread | null): thread is AgentThread {
  return Boolean(thread && (thread.scope === "manager" || thread.scope === "personal" || thread.scope === "side_chat") && !thread.archivedAt);
}

function json<T>(body: T, status: AgentHttpStatus = 200): AgentHttpResult<T> {
  return { status, body };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_NAME_LENGTH = 200;
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function parseImageAttachments(value: unknown):
  | { attachments: AgentMessageAttachment[] }
  | { error: string } {
  if (value === undefined || value === null) return { attachments: [] };
  if (!Array.isArray(value)) return { error: "attachments must be an array" };
  if (value.length > MAX_IMAGE_ATTACHMENTS) {
    return { error: `at most ${MAX_IMAGE_ATTACHMENTS} image attachments are allowed` };
  }

  const attachments: AgentMessageAttachment[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { error: `attachment ${index + 1} must be an object` };
    if (item.type !== "image") return { error: `attachment ${index + 1} must be an image` };
    const id = normalizeAttachmentId(item.id);
    if (!id) return { error: `attachment ${index + 1} is missing an id` };
    if (seen.has(id)) return { error: `duplicate attachment id: ${id}` };
    seen.add(id);

    const mediaType = typeof item.mediaType === "string" ? item.mediaType.trim().toLowerCase() : "";
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      return { error: `unsupported image type: ${mediaType || "(missing)"}` };
    }

    const data = typeof item.data === "string" ? item.data.replace(/\s+/g, "") : "";
    if (!data || !BASE64_RE.test(data)) return { error: `attachment ${index + 1} has invalid base64 data` };
    const sizeBytes = base64SizeBytes(data);
    if (sizeBytes <= 0) return { error: `attachment ${index + 1} is empty` };
    if (sizeBytes > MAX_IMAGE_BYTES) {
      return { error: `attachment ${index + 1} exceeds ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB` };
    }

    const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_IMAGE_NAME_LENGTH) : "";
    attachments.push({
      type: "image",
      id,
      mediaType,
      data,
      sizeBytes,
      ...(name ? { name } : {})
    });
  }
  return { attachments };
}

function normalizeAttachmentId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,100}$/.test(trimmed) ? trimmed : "";
}

function base64SizeBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}
