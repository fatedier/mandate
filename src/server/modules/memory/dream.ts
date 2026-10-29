import * as os from "node:os";
import type { Database } from "bun:sqlite";
import {
  streamText,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type TimeoutConfiguration,
  type ToolSet
} from "ai";
import { z } from "zod";
import { collectStream } from "../agent/stream-collector.js";
import { throwIfCutOff } from "../llm/output-limit-failure.js";
import { ToolDispatcher, ToolRegistry, type ToolDefinition } from "../agent/tool-registry.js";
import { assistantMessagesForModel, isToolImageResultContent, MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../agent/wake-message-adapter.js";
import { limitToolText } from "../agent/tool-result-format.js";
import { createBashTool } from "../agent/tools/bash.js";
import { buildReadFileTool } from "../agent/tools/read-file.js";
import type { AgentScope } from "../agent/tool-scope.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { ShellCommandRunner } from "../../platform/process/shell-command-runner.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import type { AgentMessage, AgentStore } from "../agent/agent-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { reasoningForAiSdk } from "../llm/reasoning.js";
import { ANTHROPIC_CACHE_CONTROL } from "../llm/anthropic-cache.js";
import { assistantMessagesOnly, providerOptionsForCandidate } from "../agent/wake-llm-attempts.js";
import { forReplay } from "../agent/reasoning-replay.js";
import { replayTargetFor, withCacheMarksFor, type ReplayCandidate } from "../agent/replay-target.js";
import type { AssistantContent } from "../../../shared/agent-message-types.js";
import { idleGuardedStreamOptions } from "../llm/stream-timeout.js";
import { LLM_STREAM_IDLE_TIMEOUT_MS, MEMORY_DREAM_STEP_LLM_TIMEOUT } from "../llm/timeouts.js";
import { llmAttemptMetadata, runLlmCandidates } from "../llm/run-candidates.js";
import { estimateTextTokens } from "../agent/compression.js";
import { newId } from "../../platform/ids.js";
import { nowIso } from "../../platform/time/time.js";
import { parseJsonRecord } from "../../platform/json.js";
import { formatErrorMessage } from "../../platform/errors.js";
import { errorText } from "../../../shared/error-text.js";
import type { MemoryManager } from "./manager.js";
import type { MemoryEntry, MemoryWriteTx } from "./types.js";
import { jsonOrNull } from "./local-provider-helpers.js";
import { entriesDigest } from "./briefs.js";
import { describeAge } from "./age.js";
import { projectsFolders, whereWorkIs } from "./dream-places.js";
import { buildDreamSystemPrompt, buildOpeningMessage, OPENING_RECENT_WORK } from "./dream-prompt.js";
import type { FeatureRecordStore } from "../plans/record-store.js";
import type { GitClient } from "../../platform/git/git.js";
import {
  arePossibleDuplicates,
  briefRejection,
  userStatedAt,
  dreamActionRejection,
  partitionContains,
  partitionFilter,
  type MemoryDreamPartition
} from "./dream-rules.js";
import { withoutKeptVersion } from "../../../shared/memory-last-update.js";

interface MemoryDreamLlmCandidate {
  model: LanguageModel;
  provider?: string;
  modelName?: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder?: AgentLlmCallRecorder;
}

/** A step as the model returned it, with what goes back to it next step. */
type DreamStepResult = Awaited<ReturnType<typeof collectStream>> & Pick<AssistantContent, "sdkAssistantMessages" | "writtenBy">;
/** The run's conversation: the opening and tool results as sent, and each
 *  step as recorded, so every candidate model gets it as it can take it. */
type DreamTurn = { message: ModelMessage } | { step: Pick<AssistantContent, "text" | "toolCalls" | "sdkAssistantMessages" | "writtenBy"> };

/** A dream candidate as the agent's replay rules name a model. */
function replayCandidate(candidate: MemoryDreamLlmCandidate): ReplayCandidate {
  return {
    model: candidate.model,
    meta: { provider: candidate.provider, model: candidate.modelName, reasoningEffort: candidate.reasoningEffort, supportsReasoning: candidate.supportsReasoning }
  };
}

const DEFAULT_MAX_STEPS = 100;
const SIMILAR_LIMIT = 5;
/** What writing the brief needs once a run's room is used up, at most. */
const BRIEF_RESERVE_TOKENS = 30_000;
/** What a tool asked for once the room is used up gets instead of running. */
const ROOM_USED_UP = "This run's room is used up: write the brief now.";

/** How large a run's conversation may grow while it still acts: the
 *  compaction threshold, less what writing the brief then needs (the smaller
 *  of BRIEF_RESERVE_TOKENS and a fifth of the threshold). */
export function dreamRoomTokens(contextLimitTokens: number): number {
  return contextLimitTokens - Math.min(BRIEF_RESERVE_TOKENS, Math.floor(contextLimitTokens / 5));
}

const ACTION_SCHEMA = z.object({
  type: z.enum(["merge", "update", "archive", "move", "split"]),
  memoryId: z.string().min(1),
  reason: z.string().min(1),
  targetMemoryId: z.string().min(1).optional().describe("merge: the memory that remains."),
  content: z.string().min(1).optional().describe("update: the new text. merge: the merged text, when the source adds something."),
  entryType: z.enum(["preference", "knowledge"]).optional().describe("update: a corrected type."),
  scope: z.enum(["user", "project"]).optional().describe("move: where to."),
  projectId: z.string().min(1).optional().describe("move to a project: its id."),
  parts: z.array(z.string().min(1)).max(8).optional().describe("split: each part becomes its own memory.")
});
/** A merge's target; any other action has none, whatever it names. */
function mergeTarget(action: z.infer<typeof ACTION_SCHEMA>): string | null {
  return action.type === "merge" ? action.targetMemoryId ?? null : null;
}

const LIST_SCHEMA = z.object({ type: z.enum(["preference", "knowledge"]).optional() });
const SEARCH_SCHEMA = z.object({ query: z.string().min(1), maxResults: z.number().int().min(1).max(20).optional() });
const READ_SCHEMA = z.object({ memoryId: z.string().min(1) });
const BRIEF_SCHEMA = z.object({
  content: z.string().min(1),
  summary: z.string().min(1).optional().describe("One sentence on what this run changed, for the user's activity log.")
});

export interface MemoryDreamerOptions {
  db: Database;
  memory: MemoryManager;
  /** Workers' task records: a project run's recent work, read-only. */
  records: Pick<FeatureRecordStore, "recent" | "getById">;
  agentStore: AgentStore;
  projectsStore: Pick<ProjectsStore, "listActive">;
  /** A project's workers, for where its work is; none known when absent. */
  featuresStore?: Pick<FeaturesStore, "listByProject">;
  model: LanguageModel;
  provider: string;
  modelName?: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder?: AgentLlmCallRecorder;
  candidates?: MemoryDreamLlmCandidate[];
  maxSteps?: number;
  /** The compaction threshold agents run to: a run acts while its
   *  conversation has room under it (dreamRoomTokens). */
  contextLimitTokens: number;
  /** How where the work is is read from git; the default runs it. */
  git?: GitClient;
  /** How the dream's shell runs a command; the default is the user's shell. */
  shellRunner?: ShellCommandRunner;
  /** The waits before a run's end the database refused is written again
   *  (FINISH_RETRY_DELAYS_MS); a test passes short ones. */
  finishRetryDelaysMs?: readonly number[];
  /** A step's SDK timeouts (MEMORY_DREAM_STEP_LLM_TIMEOUT) and how long its
   *  stream may go quiet (LLM_STREAM_IDLE_TIMEOUT_MS); a test passes short ones. */
  llmTimeout?: TimeoutConfiguration<ToolSet>;
  streamIdleTimeoutMs?: number;
}

/** A run's end refused by the database (another writer holding it) is tried
 *  again after these waits, then left for the next start to close. */
const FINISH_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000];

export interface MemoryDreamRunResult {
  runId: string;
  trigger: string;
  phase: "user" | "project";
  projectId: string | null;
  processed: boolean;
  status: "succeeded" | "failed";
  candidateCount: number;
  actionCount: number;
  appliedCount: number;
  rejectedCount: number;
  failedCount: number;
}

interface DreamRunState {
  runId: string;
  trigger: string;
  partition: MemoryDreamPartition;
  applied: number;
  rejected: number;
  failed: number;
  actionCount: number;
  /** How large the conversation may grow while the run still acts. */
  roomTokens: number;
  /** A step started past roomTokens: every tool but write_brief is refused. */
  roomUsedUp: boolean;
  finished: boolean;
  finishReason: string;
  brief: string | null;
  /** The partition as this run knows it: each available memory's version
   *  when the run started, as the run's own writes left it. What anyone else
   *  writes meanwhile is the next run's: the run's writes are refused on a
   *  memory not at the version here, and the brief's digest is of this. */
  known: Map<string, string>;
  /** What each step called, kept with the run (nothing shows it). */
  steps: DreamStepLog[];
}

/** One step of a run: the tools it called, in order. */
interface DreamStepLog {
  step: number;
  tools: DreamToolLog[];
  /** Its model call failed (the run ends there). */
  failed?: true;
}

/** One tool call as a run keeps it: its arguments cut short, how many
 *  characters of result the model got back, and the result's status when
 *  it has one (an action's "applied" or "rejected"). */
interface DreamToolLog {
  name: string;
  args: string;
  chars: number;
  status?: string;
  error?: true;
}

/** How much of a tool call's arguments a run's step log keeps. */
const TOOL_LOG_ARGS_CHARS = 300;

/** Why a run left running was closed: it was cut off, not finished. */
const RESTARTED = "The server restarted during this run.";

/**
 * Closes the runs that were in flight when the server stopped (a restart, a
 * deploy): nothing resumes them, and left "running" the Memory page draws them
 * as live and keeps re-reading. They close as failed, saying why, with what
 * they applied counted; what they applied stands, and as they wrote no brief
 * the next run takes their partition again. Called at startup, before any run.
 */
export function closeInterruptedDreamRuns(db: Database): number {
  return db.transaction(() => {
    const rows = db.prepare(`select id, metadata_json from memory_dream_runs where status = 'running'`).all() as Array<{ id: string; metadata_json: string | null }>;
    const close = db.prepare(`
      update memory_dream_runs set
        status = 'failed',
        applied_count = (select count(*) from memory_dream_actions where run_id = ? and status = 'applied'),
        error_json = ?,
        metadata_json = ?,
        finished_at = ?
      where id = ? and status = 'running'
    `);
    for (const row of rows) {
      const metadata = { ...(parseJsonRecord(row.metadata_json) ?? {}), finishReason: RESTARTED };
      close.run(row.id, JSON.stringify({ message: RESTARTED }), JSON.stringify(metadata), nowIso(), row.id);
    }
    return rows.length;
  })();
}

export class MemoryDreamer {
  constructor(private options: MemoryDreamerOptions) {}

  /** A partition needs a run when its entries are not what its brief was
   *  built from. */
  needsRun(partition: MemoryDreamPartition): boolean {
    const filter = partitionFilter(partition);
    const entries = this.options.memory.listAvailable(filter);
    const brief = this.options.memory.getBrief(filter.scope, filter.projectId);
    if (!brief) return entries.length > 0;
    // An empty partition keeps no brief, whatever its digest: a run can store
    // one built from nothing it still held while someone added a memory, and
    // that memory can go too.
    return entries.length === 0 || brief.inputDigest !== entriesDigest(entries);
  }

  /** When a project's brief was built, while no worker of the project has
   *  spoken since: its brief is read where its workers are, so nothing has
   *  used it. Null for the user's memories, a project with no brief or no
   *  memories, or one a worker has worked in since. */
  unusedSinceBrief(partition: MemoryDreamPartition): number | null {
    if (partition.kind !== "project") return null;
    const filter = partitionFilter(partition);
    const brief = this.options.memory.getBrief(filter.scope, filter.projectId);
    if (!brief || this.options.memory.listAvailable(filter).length === 0) return null;
    const builtAt = Date.parse(brief.builtAt);
    const spoke = this.options.agentStore.lastWorkerMessageAtInProject(partition.projectId);
    return spoke !== null && Date.parse(spoke) >= builtAt ? null : builtAt;
  }

  /** Where a project run looks at the project's files; for the user's run,
   *  every project's folder (its memories name things from any of them). */
  private placesFor(partition: MemoryDreamPartition): string {
    const projects = this.options.projectsStore.listActive();
    if (partition.kind === "user") return projectsFolders(projects);
    const project = projects.find((p) => p.id === partition.projectId);
    if (!project) return "";
    // A list it could not read costs the run its map, never the run.
    try {
      return whereWorkIs({
        workingDir: project.workingDir,
        features: this.options.featuresStore?.listByProject(project.id) ?? [],
        now: Date.now(),
        ...(this.options.git ? { git: this.options.git } : {})
      });
    } catch {
      return "";
    }
  }

  /** The shell and read act as a manager's do (any path); the shell starts
   *  in the project's folder, or the home directory for the user's run. */
  private toolScopeFor(partition: MemoryDreamPartition): AgentScope {
    const projects = this.options.projectsStore.listActive();
    const own = partition.kind === "project" ? projects.find((p) => p.id === partition.projectId)?.workingDir : undefined;
    return { kind: "manager", managerDir: own ?? os.homedir(), projectWorkingDirs: projects.map((p) => p.workingDir) };
  }

  /** The user's memories a project run reads; none for the user's own run. */
  private userEntriesFor(partition: MemoryDreamPartition): MemoryEntry[] | null {
    return partition.kind === "project" ? this.options.memory.listAvailable({ scope: "user", projectId: null }) : null;
  }

  async run(trigger: string, partition: MemoryDreamPartition): Promise<MemoryDreamRunResult> {
    const filter = partitionFilter(partition);
    const memory = this.options.memory;
    const entries = memory.listAvailable(filter);
    const brief = memory.getBrief(filter.scope, filter.projectId);
    // At or after: a memory written in the millisecond the brief was built is
    // one the brief may not have seen.
    const changed = brief ? entries.filter((entry) => entry.updatedAt >= brief.builtAt) : entries;
    const archived = brief ? memory.listArchivedSince(filter, brief.builtAt) : [];
    const userEntries = this.userEntriesFor(partition);
    const runId = newId("drm");
    const startedAt = nowIso();
    const state: DreamRunState = {
      runId, trigger, partition, applied: 0, rejected: 0, failed: 0, actionCount: 0,
      roomTokens: dreamRoomTokens(this.options.contextLimitTokens), roomUsedUp: false, finished: false, finishReason: "", brief: null,
      known: new Map(entries.map((entry) => [entry.id, entry.updatedAt])),
      steps: []
    };
    const result = (status: MemoryDreamRunResult["status"]): MemoryDreamRunResult => ({
      runId, trigger, phase: partition.kind, projectId: filter.projectId, processed: true, status,
      candidateCount: changed.length + archived.length, actionCount: state.actionCount,
      appliedCount: state.applied, rejectedCount: state.rejected, failedCount: state.failed
    });
    if (entries.length === 0) {
      memory.deleteBrief(filter.scope, filter.projectId);
      return { ...result("succeeded"), processed: false };
    }
    this.insertRun({ id: runId, trigger, partition, status: "running", candidateCount: changed.length + archived.length, appliedCount: 0, startedAt, availableCountBefore: entries.length });
    const maxSteps = Math.max(1, Math.floor(this.options.maxSteps ?? DEFAULT_MAX_STEPS));
    const metadata = () => ({ actionCount: state.actionCount, rejectedCount: state.rejected, failedCount: state.failed, finishReason: state.finishReason || (state.finished ? "finished" : "step_budget_exhausted"), steps: state.steps });
    try {
      const recentWork = partition.kind === "project" ? this.options.records.recent(partition.projectId, { limit: OPENING_RECENT_WORK }) : [];
      await this.runDreamAgent(state, maxSteps, buildOpeningMessage({ brief, changed, archived, entries, userEntries, recentWork, places: this.placesFor(partition) }));
      const after = memory.listAvailable(filter);
      // A partition left empty keeps no brief, whatever the run wrote; nor
      // does a project archived while the run went (its brief went with it).
      // Checked with nothing awaited before the brief is stored.
      const gone = after.length === 0
        || (partition.kind === "project" && !this.options.projectsStore.listActive().some((p) => p.id === partition.projectId));
      if (gone) memory.deleteBrief(filter.scope, filter.projectId);
      if (state.brief === null) {
        // The actions it applied stand; the brief it did not write stays the
        // old one (none, once the partition is empty), so the digest still
        // differs and the next tick runs again.
        await this.finishRun(runId, { status: "failed", appliedCount: state.applied, metadata: metadata(), error: new Error("the run ended without writing a brief"), availableCountAfter: after.length });
        return result("failed");
      }
      if (gone) {
        await this.finishRun(runId, { status: "succeeded", appliedCount: state.applied, metadata: metadata(), availableCountAfter: after.length });
        return result("succeeded");
      }
      // The digest is of what the run knew, and builtAt is when it started: a
      // memory someone wrote meanwhile makes the digest differ, so the next run
      // sees it among what changed.
      const inputDigest = entriesDigest([...state.known].map(([id, updatedAt]) => ({ id, updatedAt })));
      memory.putBrief({ scope: filter.scope, projectId: filter.projectId, content: state.brief, inputDigest, builtAt: startedAt, runId });
      // Kept with the run, so its detail can show the brief and the one before.
      await this.finishRun(runId, { status: "succeeded", appliedCount: state.applied, metadata: { ...metadata(), brief: state.brief }, availableCountAfter: after.length });
      return result("succeeded");
    } catch (error) {
      // The model failed, or the store did: the actions it applied stand and
      // are counted, the run is recorded failed, and the next partition still
      // gets its turn.
      console.warn(`[mandate] memory dream ${partition.kind} failed: ${errorText(error)}`);
      state.finishReason = error instanceof MemoryDreamStepError ? "model_error" : "store_error";
      // The failure is recorded whether or not the cleanup works.
      let left: number | null = null;
      try {
        left = memory.listAvailable(filter).length;
        if (left === 0) memory.deleteBrief(filter.scope, filter.projectId);
      } catch (cleanup) {
        console.warn(`[mandate] memory dream ${partition.kind} cleanup failed: ${errorText(cleanup)}`);
      }
      await this.finishRun(runId, { status: "failed", appliedCount: state.applied, metadata: metadata(), error, availableCountAfter: left });
      return result("failed");
    }
  }

  private async runDreamAgent(state: DreamRunState, maxSteps: number, opening: string): Promise<void> {
    const registry = this.buildToolRegistry(state);
    const dispatcher = new ToolDispatcher(registry);
    // Wrapped as a SystemModelMessage so the immutable instructions carry an
    // explicit cache breakpoint, an hour long as an agent's (anthropic-cache.ts).
    // Providers with automatic prefix caching ignore it; Anthropic requires it.
    const activeProjects = this.options.projectsStore.listActive().map(({ id, name }) => ({ id, name }));
    const systemText = buildDreamSystemPrompt(state.partition, activeProjects, state.roomTokens);
    const system: SystemModelMessage = {
      role: "system",
      content: systemText,
      providerOptions: { anthropic: { cacheControl: ANTHROPIC_CACHE_CONTROL } }
    };
    const candidates = this.llmCandidates();
    const history: DreamTurn[] = [{ message: { role: "user", content: opening } }];
    // Each candidate model gets the run's history as an agent's step does: a
    // step's own record (reasoning items, encrypted content, signatures) goes
    // back to the model id that wrote it, any other model gets its text and
    // tool calls (replay-target.ts).
    const messagesFor = (candidate: MemoryDreamLlmCandidate): ModelMessage[] => {
      const { target } = replayTargetFor(replayCandidate(candidate));
      const messages = history.flatMap((turn) => ("step" in turn ? assistantMessagesForModel(turn.step, target) : [turn.message]));
      return withCacheMarksFor(replayCandidate(candidate), messages);
    };

    for (let step = 1; step <= maxSteps; step += 1) {
      const started = Date.now();
      // Every step is kept: one that calls nothing, and one that fails, too.
      const log: DreamStepLog = { step, tools: [] };
      state.steps.push(log);
      // Each attempt records it with the history its own model got.
      const requestPayload = {
        system: systemText,
        toolNames: Object.keys(registry.tools),
        step,
        maxSteps
      };

      let collected: DreamStepResult;
      try {
        collected = await this.runLlmCandidates({
          candidates,
          requestPayload,
          metadata: {
            runId: state.runId,
            trigger: state.trigger,
            step,
            maxSteps
          },
          system,
          messagesFor,
          cacheKey: state.runId,
          tools: registry.tools
        });
      } catch (error) {
        log.failed = true;
        const latencyMs = Date.now() - started;
        const wrapped = new MemoryDreamStepError({
          cause: error,
          runId: state.runId,
          trigger: state.trigger,
          step,
          maxSteps,
          latencyMs
        });
        throw wrapped;
      }

      history.push({ step: {
        ...(collected.text ? { text: collected.text } : {}),
        toolCalls: collected.toolCalls.map(({ toolCallId, toolName, args }) => ({ toolCallId, toolName, args })),
        ...(collected.sdkAssistantMessages ? { sdkAssistantMessages: collected.sdkAssistantMessages } : {}),
        ...(collected.writtenBy ? { writtenBy: collected.writtenBy } : {})
      } });
      if (collected.toolCalls.length === 0) {
        state.finished = true;
        state.finishReason ||= collected.text.trim() ? "assistant_stopped" : "assistant_stopped_empty";
        return;
      }
      // The conversation this step read: once it is past the room, the
      // run only writes its brief.
      if ((collected.usage.contextPromptTokens ?? collected.usage.promptTokens) >= state.roomTokens) state.roomUsedUp = true;

      for (const call of collected.toolCalls) {
        const dispatched = state.roomUsedUp && call.toolName !== "write_brief"
          ? { result: { status: "rejected", error: ROOM_USED_UP } }
          : await dispatcher.dispatch(call, {
            threadId: state.runId,
            wakeId: state.runId,
            scope: this.toolScopeFor(state.partition)
          });
        const output = toolOutput(dispatched);
        history.push({ message: toolResultMessage(call, output) });
        log.tools.push(toolLog(call, dispatched, output));
      }

      if (state.finished) return;
    }
  }

  private async runLlmCandidates(input: {
    candidates: MemoryDreamLlmCandidate[];
    requestPayload: Record<string, unknown>;
    metadata: Record<string, unknown>;
    system: SystemModelMessage;
    messagesFor: (candidate: MemoryDreamLlmCandidate) => ModelMessage[];
    /** The prompt-cache key of the run's steps: the run. */
    cacheKey: string;
    tools: ToolSet;
  }): Promise<DreamStepResult> {
    return runLlmCandidates({
      candidates: input.candidates,
      attempt: async (candidate, at) => {
        const started = Date.now();
        // The history this model takes, as sent and as recorded.
        const messages = input.messagesFor(candidate);
        const metadata = {
          ...input.metadata,
          ...llmAttemptMetadata(at, {
            provider: candidate.provider,
            model: candidate.modelName,
            reasoningEffort: candidate.reasoningEffort,
            supportsReasoning: candidate.supportsReasoning
          })
        };
        const recorder = candidate.recorder;
        const callId = recorder?.startCall({
          purpose: "memory_dream",
          scopeType: "memory",
          scopeId: "global",
          requestPayload: { ...input.requestPayload, messages },
          metadata
        }) ?? null;
        // Cut when quiet, as every model call is. Its raw chunks are kept
        // too: a gateway's reported cost is in them, and the SDK's chat
        // schema drops it (pricing/call-facts.ts).
        const idle = idleGuardedStreamOptions({
          model: candidate.model,
          timeout: this.options.llmTimeout ?? MEMORY_DREAM_STEP_LLM_TIMEOUT,
          idleMs: this.options.streamIdleTimeoutMs ?? LLM_STREAM_IDLE_TIMEOUT_MS
        });
        try {
          const stream = streamText({
            model: candidate.model,
            reasoning: reasoningForAiSdk(candidate.reasoningEffort, candidate.supportsReasoning),
            // As an agent's step asks (wake-llm-attempts.ts); the dream shows
            // no reasoning heading, so it asks for no summary.
            providerOptions: providerOptionsForCandidate(undefined, replayCandidate(candidate), input.cacheKey, false),
            system: input.system,
            messages,
            tools: input.tools,
            maxRetries: 0,
            ...idle.options
          });
          const collected = await collectStream(stream.fullStream);
          throwIfCutOff(collected.finishReason);
          // What the model returned, kept for its next step: its reasoning
          // items go back to it as an agent's do (reasoning-replay.ts).
          const sdkAssistantMessages = assistantMessagesOnly(await stream.responseMessages).map(forReplay);
          const writtenBy = candidate.modelName ? { provider: candidate.provider ?? "", model: candidate.modelName } : undefined;
          recorder?.finishCall(callId, {
            status: "succeeded",
            result: collected,
            usage: collected.usage,
            metadata,
            latencyMs: Date.now() - started
          });
          return {
            ...collected,
            ...(sdkAssistantMessages.length ? { sdkAssistantMessages } : {}),
            ...(writtenBy ? { writtenBy } : {})
          };
        } catch (error) {
          recorder?.finishCall(callId, {
            status: "failed",
            error,
            metadata,
            latencyMs: Date.now() - started
          });
          throw error;
        } finally {
          idle.cleanup();
        }
      }
    });
  }

  private llmCandidates(): MemoryDreamLlmCandidate[] {
    return this.options.candidates?.length
      ? this.options.candidates
      : [{
          model: this.options.model,
          provider: this.options.provider,
          modelName: this.options.modelName ?? languageModelId(this.options.model),
          reasoningEffort: this.options.reasoningEffort,
          supportsReasoning: this.options.supportsReasoning,
          recorder: this.options.recorder
        }];
  }
  private buildToolRegistry(state: DreamRunState): ToolRegistry {
    const memory = this.options.memory;
    const filter = partitionFilter(state.partition);
    const registry = new ToolRegistry();
    const tools: ToolDefinition[] = [
      {
        name: "list_entries",
        description: "List this partition's available memories, one line each.",
        parameters: LIST_SCHEMA,
        handler: async (input) => {
          const { type } = LIST_SCHEMA.parse(input);
          return {
            entries: memory.listAvailable({ ...filter, ...(type ? { type } : {}) }).map((entry) => ({
              id: entry.id, type: entry.type, source: entry.source, ...statedOf(entry), updated: describeAge(entry.updatedAt),
              content: entry.content.length > 300 ? `${entry.content.slice(0, 300)}…` : entry.content
            }))
          };
        }
      },
      {
        name: "search_memory",
        description: "Search this partition's memories for duplicates, contradictions or related entries.",
        parameters: SEARCH_SCHEMA,
        handler: async (input) => {
          const args = SEARCH_SCHEMA.parse(input);
          const results = await memory.search({
            query: args.query,
            ...(filter.scope === "project" ? { projectId: filter.projectId } : { scope: "user" as const }),
            maxResults: args.maxResults ?? 10
          });
          return {
            memories: results.map((r) => ({
              id: r.entry.id, type: r.entry.type, source: r.entry.source, ...statedOf(r.entry), updated: describeAge(r.entry.updatedAt),
              content: r.entry.content
            }))
          };
        }
      },
      {
        name: "read_entry",
        description: "Read one memory whole, the memories most like it, the conversation it came from, and what earlier runs did to it. It also opens a task record from the recent work list, whole.",
        parameters: READ_SCHEMA,
        handler: async (input) => {
          const { memoryId } = READ_SCHEMA.parse(input);
          const entry = await memory.get(memoryId);
          if (!entry) {
            // A task record of this project: read-only history beside its worker's plan.
            const record = this.options.records.getById(memoryId);
            if (record && state.partition.kind === "project" && record.projectId === state.partition.projectId) {
              return { record: { id: record.id, worker: record.workerName, updated: describeAge(record.updatedAt), content: record.content } };
            }
          }
          if (!entry || !partitionContains(entry, state.partition)) throw new Error(`memory not in this partition: ${memoryId}`);
          const vectors = memory.availableVectors();
          const similar = memory.listAvailable(filter)
            .filter((other) => other.id !== entry.id && arePossibleDuplicates(entry, other, vectors))
            .slice(0, SIMILAR_LIMIT);
          return {
            memory: { ...entry, metadata: withoutKeptVersion(entry.metadata), ...statedOf(entry), updated: describeAge(entry.updatedAt) },
            similar: similar.map((s) => ({ id: s.id, type: s.type, source: s.source, createdAt: s.createdAt, updatedAt: s.updatedAt, content: s.content })),
            sources: this.sourceMessagesFor(entry).map(formatSourceMessage),
            history: this.actionsOn(entry.id)
          };
        }
      },
      {
        name: "apply_action",
        description: "Validate and apply one action. Returns applied, or rejected with the reason.",
        parameters: ACTION_SCHEMA,
        handler: async (input) => this.applyAction(state, ACTION_SCHEMA.parse(input))
      },
      {
        name: "write_brief",
        description: "Write this partition's brief, last: it ends the run. Refused when it is over its token limit; then shorten it and call again.",
        parameters: BRIEF_SCHEMA,
        handler: async (input) => {
          const { content, summary } = BRIEF_SCHEMA.parse(input);
          if (state.finished) throw new Error("the run has finished");
          const error = briefRejection(content, state.partition, estimateTextTokens);
          if (error) throw new Error(error);
          state.brief = content.trim();
          state.finished = true;
          state.finishReason = summary ? `finished: ${summary}` : "finished";
          return { ok: true, tokens: estimateTextTokens(content), applied: state.applied, rejected: state.rejected };
        }
      }
    ];
    // To look at a project's files: an agent's own shell and read.
    const look = [createBashTool(this.options.shellRunner ? { runner: this.options.shellRunner } : {}), buildReadFileTool()] as ToolDefinition[];
    for (const tool of [...tools, ...look]) registry.register(tool);
    return registry;
  }

  private async applyAction(state: DreamRunState, action: z.infer<typeof ACTION_SCHEMA>) {
    if (state.finished) return { status: "rejected", error: "the run has finished" };
    state.actionCount += 1;
    const memory = this.options.memory;
    const entry = await memory.get(action.memoryId);
    // Each action reads only its own fields: a target is a merge's. Another
    // action that names one (the model fills it with something) acts on its
    // own memory alone, and the named memory does not hold it back.
    const target = mergeTarget(action) ? await memory.get(mergeTarget(action)!) : null;
    const activeProjectIds = new Set(this.options.projectsStore.listActive().map((p) => p.id));
    const refuse = (error: string) => {
      state.rejected += 1;
      this.recordAction(state.runId, action, { status: "rejected", before: entry, after: entry, reason: action.reason, source: actionText(action), error });
      return { status: "rejected", memoryId: action.memoryId, actionType: action.type, error };
    };
    const rejection = dreamActionRejection(action, {
      entry, target, partition: state.partition, activeProjectIds,
      isRecord: (id) => this.options.records.getById(id) !== null
    });
    if (rejection) return refuse(rejection);
    // Written only at the version this run knows: a memory someone changed or
    // added since the run started (no version here, so never a match) is the
    // next run's to curate.
    const touched = [entry!, ...(target ? [target] : [])];
    const expected = touched.map((m) => ({ id: m.id, updatedAt: state.known.get(m.id) ?? "" }));
    const leftForNext = `${touched.map((m) => m.id).join(" or ")} changed during this run: leave it to the next run`;
    const stamp = { dreamRunId: state.runId, dreamReason: action.reason };
    type Written = { after: MemoryEntry; produced: MemoryEntry[] };
    let written: Written | null;
    const change = (tx: MemoryWriteTx): Written => {
      switch (action.type) {
        case "merge": {
          const after = tx.archive(entry!.id, { ...stamp, mergedInto: target!.id });
          const kept = tx.update({
            id: target!.id,
            ...(action.content ? { content: action.content } : {}),
            metadata: { ...(target!.metadata ?? {}), dreamMergedMemoryIds: [...stringArray(target!.metadata?.dreamMergedMemoryIds), entry!.id] }
          });
          return { after, produced: [after, kept] };
        }
        case "update": {
          const after = tx.update({ id: entry!.id, content: action.content, ...(action.entryType ? { type: action.entryType } : {}), metadata: { ...(entry!.metadata ?? {}), ...stamp } });
          return { after, produced: [after] };
        }
        case "archive": {
          const after = tx.archive(entry!.id, stamp);
          return { after, produced: [after] };
        }
        case "move": {
          const after = tx.update({ id: entry!.id, scope: action.scope, projectId: action.scope === "project" ? action.projectId : null, metadata: { ...(entry!.metadata ?? {}), ...stamp } });
          return { after, produced: [after] };
        }
        case "split": {
          const parts = (action.parts ?? []).map((content) => tx.remember({
            scope: entry!.scope, projectId: entry!.projectId, featureId: entry!.featureId, type: entry!.type,
            source: entry!.source, content, sourceThreadId: entry!.sourceThreadId, sourceMessageId: entry!.sourceMessageId,
            // The user's words, and when they said them, go with each part.
            ...(entry!.source === "user" ? { userQuote: entry!.userQuote } : {}),
            metadata: { splitFrom: entry!.id, dreamRunId: state.runId, ...(entry!.source === "user" ? { statedAt: userStatedAt(entry!) } : {}) }
          }));
          const after = tx.archive(entry!.id, { ...stamp, splitInto: parts.map((part) => part.id) });
          return { after, produced: [after, ...parts] };
        }
      }
    };
    try {
      // Recorded in the write that makes the change: the new text's
      // embedding (network calls) comes after it commits, and a restart there
      // leaves no change without its record.
      written = await memory.writeIfUnchanged(expected, (tx): Written => {
        const done = change(tx);
        this.recordAction(state.runId, action, { status: "applied", before: entry, after: done.after, reason: action.reason, source: actionText(action) });
        return done;
      });
    } catch (error) {
      // Rolled back: nothing of it was written.
      state.failed += 1;
      this.recordAction(state.runId, action, { status: "failed", before: entry, after: entry, reason: action.reason, source: actionText(action), error });
      return { status: "failed", memoryId: action.memoryId, actionType: action.type, error: errorText(error) };
    }
    if (!written) return refuse(leftForNext);
    state.applied += 1;
    for (const version of written.produced) {
      if (version.status === "available" && partitionContains(version, state.partition)) state.known.set(version.id, version.updatedAt);
      else state.known.delete(version.id);
    }
    return { status: "applied", memoryId: action.memoryId, actionType: action.type };
  }

  private sourceMessagesFor(entry: MemoryEntry): AgentMessage[] {
    const message = entry.sourceMessageId ? this.options.agentStore.getMessageById(entry.sourceMessageId) : null;
    // A system row is for people (a failed turn's line) or is the prompt:
    // neither is a source of what the agent learned.
    return message && message.role !== "system" ? [message] : [];
  }

  /** What earlier runs did to a memory, newest first. */
  private actionsOn(memoryId: string): Array<{ at: string; actionType: string; status: string; reason: string }> {
    return this.options.db.prepare(`
      select created_at as at, action_type as actionType, status, reason
      from memory_dream_actions
      where memory_id = ? or target_memory_id = ?
      order by created_at desc
      limit 10
    `).all(memoryId, memoryId) as Array<{ at: string; actionType: string; status: string; reason: string }>;
  }

  private insertRun(input: {
    id: string;
    trigger: string;
    partition: MemoryDreamPartition;
    status: "running" | "succeeded" | "failed" | "skipped";
    candidateCount: number;
    appliedCount: number;
    startedAt: string;
    availableCountBefore: number;
  }) {
    const primary = this.llmCandidates()[0];
    this.options.db.prepare(`
      insert into memory_dream_runs (
        id, trigger, status, provider, model, phase, project_id, candidate_count, applied_count,
        started_at, available_count_before
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.trigger,
      input.status,
      primary?.provider ?? this.options.provider,
      primary?.modelName ?? this.options.modelName ?? languageModelId(this.options.model),
      input.partition.kind,
      input.partition.kind === "project" ? input.partition.projectId : null,
      input.candidateCount,
      input.appliedCount,
      input.startedAt,
      input.availableCountBefore
    );
  }

  /** Records how the run ended. A write the database refused is tried again
   *  (FINISH_RETRY_DELAYS_MS); refused every time, the run is left running for
   *  the next start to close (closeInterruptedDreamRuns), and nothing throws:
   *  what the run did stands either way. */
  private async finishRun(runId: string, input: {
    status: "succeeded" | "failed" | "skipped";
    appliedCount: number;
    metadata?: Record<string, unknown>;
    error?: unknown;
    availableCountAfter: number | null;
  }): Promise<void> {
    const delays = this.options.finishRetryDelaysMs ?? FINISH_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        this.writeRunEnd(runId, input);
        return;
      } catch (error) {
        if (attempt >= delays.length) {
          console.warn(`[mandate] memory dream run ${runId} could not be recorded as ended: ${errorText(error)}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  private writeRunEnd(runId: string, input: Parameters<MemoryDreamer["finishRun"]>[1]): void {
    this.options.db.prepare(`
      update memory_dream_runs set
        status = ?,
        applied_count = ?,
        error_json = ?,
        metadata_json = ?,
        finished_at = ?,
        available_count_after = ?
      where id = ?
    `).run(
      input.status,
      input.appliedCount,
      input.error ? jsonOrNull(errorForJson(input.error)) : null,
      input.metadata ? jsonOrNull(input.metadata) : null,
      nowIso(),
      input.availableCountAfter,
      runId
    );
  }

  private recordAction(runId: string, action: z.infer<typeof ACTION_SCHEMA>, input: {
    status: "applied" | "rejected" | "failed";
    before?: MemoryEntry | null;
    after?: MemoryEntry | null;
    reason: string;
    source?: Record<string, unknown>;
    error?: unknown;
  }) {
    const now = nowIso();
    this.options.db.prepare(`
      insert into memory_dream_actions (
        id, run_id, action_type, status, memory_id, target_memory_id,
        before_json, after_json, reason, source_json, error_json,
        created_at, applied_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId("dma"),
      runId,
      action.type,
      input.status,
      action.memoryId,
      mergeTarget(action),
      input.before ? jsonOrNull(input.before) : null,
      input.after ? jsonOrNull(input.after) : null,
      input.reason,
      input.source ? jsonOrNull(input.source) : null,
      input.error ? jsonOrNull(errorForJson(input.error)) : null,
      now,
      input.status === "applied" ? now : null
    );
  }
}

export class MemoryDreamStepError extends Error {
  readonly runId: string;
  readonly trigger: string;
  readonly step: number;
  readonly maxSteps: number;
  readonly latencyMs: number;

  constructor(input: {
    cause: unknown;
    runId: string;
    trigger: string;
    step: number;
    maxSteps: number;
    latencyMs: number;
  }) {
    const causeMessage = formatErrorMessage(input.cause, "LLM call failed");
    super(
      `memory dream step ${input.step}/${input.maxSteps} failed after ${input.latencyMs}ms: ${causeMessage}`,
      { cause: input.cause }
    );
    this.name = "MemoryDreamStepError";
    this.runId = input.runId;
    this.trigger = input.trigger;
    this.step = input.step;
    this.maxSteps = input.maxSteps;
    this.latencyMs = input.latencyMs;
  }
}

/** The text an action carried, kept with its record. */
function actionText(action: z.infer<typeof ACTION_SCHEMA>): Record<string, unknown> | undefined {
  if (action.content === undefined && action.parts === undefined) return undefined;
  return {
    ...(action.content !== undefined ? { content: action.content } : {}),
    ...(action.parts !== undefined ? { parts: action.parts } : {})
  };
}

/** When the user said a memory they stated, for the model to order them as the rules do. */
function statedOf(entry: MemoryEntry): { stated?: string } {
  return entry.source === "user" ? { stated: describeAge(userStatedAt(entry)) } : {};
}

type DreamToolCall = Awaited<ReturnType<typeof collectStream>>["toolCalls"][number];
type DispatchedTool = { result?: unknown; isError?: boolean; error?: string };

/** A tool's result as the model gets it. A text result is cut where an
 *  agent's is (the shell's output can be long). */
function toolOutput(dispatched: DispatchedTool) {
  return dispatched.isError
    ? { type: "error-text" as const, value: dispatched.error ?? "tool error" }
    : typeof dispatched.result === "string"
      ? { type: "text" as const, value: limitToolText(dispatched.result, MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS).text }
      : { type: "json" as const, value: toJsonValue(dispatched.result) };
}

function toolLog(call: DreamToolCall, dispatched: DispatchedTool, output: ReturnType<typeof toolOutput>): DreamToolLog {
  const result = dispatched.result;
  const status = result && typeof result === "object" && typeof (result as { status?: unknown }).status === "string"
    ? (result as { status: string }).status
    : null;
  return {
    name: call.toolName,
    args: (JSON.stringify(call.args) ?? "").slice(0, TOOL_LOG_ARGS_CHARS),
    chars: typeof output.value === "string" ? output.value.length : JSON.stringify(output.value).length,
    ...(status !== null ? { status } : {}),
    ...(dispatched.isError ? { error: true as const } : {})
  };
}

function toolResultMessage(call: DreamToolCall, output: ReturnType<typeof toolOutput>): ModelMessage {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output
    }]
  };
}

function toJsonValue(value: unknown): JSONValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function formatSourceMessage(message: AgentMessage) {
  return {
    id: message.id,
    threadId: message.threadId,
    wakeId: message.wakeId,
    role: message.role,
    source: message.source,
    createdAt: message.createdAt,
    text: messageContentText(message).slice(0, 1200)
  };
}

function messageContentText(message: AgentMessage) {
  const content = message.content;
  switch (content.type) {
    case "text":
      return content.text;
    case "assistant":
      return [
        content.text ?? "",
        ...(content.toolCalls ?? []).map((call) => `tool:${call.toolName}`)
      ].filter(Boolean).join(" ");
    case "tool_result":
      if (content.isError) return `${content.toolName}: ${content.error ?? "error"}`;
      if (isToolImageResultContent(content.result)) {
        return `${content.toolName}: ${content.result.message} (${content.result.image.mediaType}, ${content.result.image.sizeBytes} bytes)`;
      }
      return `${content.toolName}: ${JSON.stringify(content.result ?? null)}`;
    case "summary":
      return content.summary;
    case "wake_failure":
      return "";
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function errorForJson(error: unknown) {
  const output: Record<string, unknown> = {
    message: formatErrorMessage(error, "Error")
  };
  const record = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  copyJsonErrorField(record, output, "name");
  copyJsonErrorField(record, output, "code");
  copyJsonErrorField(record, output, "runId");
  copyJsonErrorField(record, output, "trigger");
  copyJsonErrorField(record, output, "step");
  copyJsonErrorField(record, output, "maxSteps");
  copyJsonErrorField(record, output, "latencyMs");
  if (error instanceof Error && error.stack) output.stack = error.stack;
  return output;
}

function copyJsonErrorField(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string
) {
  const value = source[key];
  if (typeof value === "string" && value.trim()) {
    target[key] = value.trim();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function languageModelId(model: LanguageModel) {
  if (typeof model === "object" && model && "modelId" in model && typeof model.modelId === "string") {
    return model.modelId;
  }
  return "";
}
