import type { Database } from "bun:sqlite";
import {
  streamText,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet
} from "ai";
import { z } from "zod";
import { collectStream } from "../agent/stream-collector.js";
import { ToolDispatcher, ToolRegistry, type ToolDefinition } from "../agent/tool-registry.js";
import { isToolImageResultContent } from "../agent/wake-message-adapter.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import type { AgentMessage, AgentStore } from "../agent/agent-store.js";
import type { ReasoningEffort } from "../../../shared/settings.js";
import {
  providerOptionsWithReasoningForAiSdk,
  reasoningForAiSdk
} from "../llm/reasoning.js";
import { createFirstChunkTimeoutGuard } from "../llm/stream-timeout.js";
import { LLM_STREAM_IDLE_TIMEOUT_MS, MEMORY_DREAM_STEP_LLM_TIMEOUT } from "../llm/timeouts.js";
import {
  errorMessage,
  isNonFallbackLlmError,
  isRetryableLlmError,
  isTimeoutLlmError,
  maxAttemptsForLlmCandidateCount,
  retryDelayMs
} from "../llm/retry-policy.js";
import { newId } from "../../platform/ids.js";
import { nowIso } from "../../platform/time/time.js";
import { formatErrorMessage } from "../../platform/errors.js";
import type { MemoryDreamActionDto, MemoryDreamRunDto } from "../../../shared/api-contracts.js";
import type { MemoryManager } from "./manager.js";
import { clamp01, jsonOrNull, mergeMetadata, rowToEntry, type MemoryRow } from "./local-provider-helpers.js";
import type { MemoryEntry, MemoryScope, MemorySearchResult } from "./types.js";
import type { SqlValue } from "../../platform/db/sql-value.js";

const DEFAULT_MAX_CANDIDATES = 100;
const DEFAULT_MAX_STEPS = 100;
const DEFAULT_ACTION_BUDGET = 50;
const DREAM_REVIEW_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const UNREVIEWED_CANDIDATE_RESERVE_RATIO = 0.4;
const SOURCE_SNIPPET_LIMIT = 8;

const DREAM_ACTION_SCHEMA = z.object({
  type: z.enum(["keep", "update", "merge", "archive", "rescope"]),
  memoryId: z.string().min(1),
  targetMemoryId: z.string().min(1).optional(),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  patch: z.object({
    content: z.string().min(1).optional(),
    kind: z.enum(["episodic", "semantic", "preference", "procedural"]).optional(),
    strength: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    cues: z.array(z.string().min(1)).max(12).optional(),
    scope: z.enum(["user", "global", "project", "feature"]).optional(),
    projectId: z.union([z.string().min(1), z.null()]).optional(),
    featureId: z.union([z.string().min(1), z.null()]).optional()
  }).optional()
});

const LIST_CANDIDATES_SCHEMA = z.object({
  limit: z.number().int().min(1).max(DEFAULT_MAX_CANDIDATES).optional()
});

const MEMORY_ID_SCHEMA = z.object({
  memoryId: z.string().min(1)
});

type DreamAction = z.infer<typeof DREAM_ACTION_SCHEMA>;

const SEARCH_MEMORY_SCHEMA = z.object({
  query: z.string().min(1),
  kind: z.enum(["episodic", "semantic", "preference", "procedural"]).optional(),
  scope: z.union([z.enum(["user", "global", "project", "feature"]), z.literal("all")]).optional(),
  maxResults: z.number().int().min(1).max(20).optional()
});
type DreamSearchInput = z.infer<typeof SEARCH_MEMORY_SCHEMA>;

const FINISH_DREAM_SCHEMA = z.object({
  summary: z.string().min(1).optional()
});

export interface MemoryDreamerOptions {
  db: Database;
  memory: MemoryManager;
  agentStore: AgentStore;
  model: LanguageModel;
  provider: string;
  modelName?: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder?: AgentLlmCallRecorder;
  candidates?: MemoryDreamLlmCandidate[];
  maxCandidates?: number;
  maxSteps?: number;
  actionBudget?: number;
}

export interface MemoryDreamLlmCandidate {
  model: LanguageModel;
  provider?: string;
  modelName?: string;
  baseURL?: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder?: AgentLlmCallRecorder;
}

export interface MemoryDreamPartitionResult {
  runId: string;
  trigger: string;
  phase: "global" | "project";
  projectId: string | null;
  processed: boolean;
  candidateCount: number;
  actionCount: number;
  appliedCount: number;
  rejectedCount: number;
  failedCount: number;
}

export interface MemoryDreamResult extends MemoryDreamPartitionResult {
  /** Present when one scheduler tick processed more than one partition. */
  runCount?: number;
  runIds?: string[];
  partitions?: MemoryDreamPartitionResult[];
}

export type MemoryDreamPartition =
  | { kind: "global" }
  | { kind: "project"; projectId: string };

interface DreamCandidate {
  entry: MemoryEntry;
  score: number;
  signals: string[];
  similar: MemoryEntry[];
  sourceMessages: AgentMessage[];
}

interface DreamRunState {
  runId: string;
  trigger: string;
  partition: MemoryDreamPartition;
  applied: number;
  rejected: number;
  failed: number;
  actionCount: number;
  actionBudget: number;
  finished: boolean;
  finishReason: string;
  seen: Set<string>;
}

export class MemoryDreamer {
  constructor(private options: MemoryDreamerOptions) {}

  async run(
    trigger = "manual",
    partition: MemoryDreamPartition = { kind: "global" }
  ): Promise<MemoryDreamResult> {
    const runId = newId("drm");
    const startedAt = nowIso();
    const availableCountBefore = this.countAvailableMemories(partition);
    const candidates = this.selectCandidates(
      this.options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      partition
    );
    this.insertRun({
      id: runId,
      trigger,
      partition,
      status: candidates.length === 0 ? "skipped" : "running",
      candidateCount: candidates.length,
      appliedCount: 0,
      startedAt,
      availableCountBefore
    });

    if (candidates.length === 0) {
      this.finishRun(runId, {
        status: "skipped",
        appliedCount: 0,
        metadata: { reason: "no_candidates" },
        availableCountAfter: availableCountBefore
      });
      return {
        runId,
        trigger,
        phase: partition.kind,
        projectId: projectIdForPartition(partition),
        processed: false,
        candidateCount: 0,
        actionCount: 0,
        appliedCount: 0,
        rejectedCount: 0,
        failedCount: 0
      };
    }

    const state: DreamRunState = {
      runId,
      trigger,
      partition,
      applied: 0,
      rejected: 0,
      failed: 0,
      actionCount: 0,
      actionBudget: this.options.actionBudget ?? DEFAULT_ACTION_BUDGET,
      finished: false,
      finishReason: "",
      seen: new Set()
    };
    const maxSteps = Math.max(1, Math.floor(this.options.maxSteps ?? DEFAULT_MAX_STEPS));
    try {
      await this.runDreamAgent(state, maxSteps);
      this.finishRun(runId, {
        status: "succeeded",
        appliedCount: state.applied,
        metadata: {
          actionCount: state.actionCount,
          rejectedCount: state.rejected,
          failedCount: state.failed,
          finishReason: state.finishReason || (state.finished ? "finished" : "step_budget_exhausted"),
          maxSteps,
          actionBudget: state.actionBudget
        },
        availableCountAfter: this.countAvailableMemories(partition)
      });
      return {
        runId,
        trigger,
        phase: partition.kind,
        projectId: projectIdForPartition(partition),
        processed: true,
        candidateCount: candidates.length,
        actionCount: state.actionCount,
        appliedCount: state.applied,
        rejectedCount: state.rejected,
        failedCount: state.failed
      };
    } catch (error) {
      this.finishRun(runId, {
        status: "failed",
        appliedCount: state.applied,
        error,
        availableCountAfter: this.countAvailableMemories(partition)
      });
      throw error;
    }
  }

  hasCandidates(partition: MemoryDreamPartition): boolean {
    return this.selectCandidates(1, partition).length > 0;
  }

  private countAvailableMemories(partition: MemoryDreamPartition): number {
    const filter = partitionSql(partition);
    const row = this.options.db.prepare(`
      select count(*) as n
      from memory_entries
      where status = 'available' and ${filter.where}
    `).get(...filter.params) as { n: number };
    return row.n;
  }

  private async runDreamAgent(state: DreamRunState, maxSteps: number): Promise<void> {
    const registry = this.buildDreamToolRegistry(state);
    const dispatcher = new ToolDispatcher(registry);
    // Wrapped as a SystemModelMessage so the immutable instructions carry an
    // explicit cache breakpoint. Providers with automatic prefix caching ignore
    // it; Anthropic requires it, and without one the dream got no reuse at all
    // there while the agent path (wake-loop) did.
    const systemText = buildDreamAgentSystemPrompt(state.actionBudget, state.partition);
    const system: SystemModelMessage = {
      role: "system",
      content: systemText,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
    };
    const candidates = this.llmCandidates();
    const messages: ModelMessage[] = [{
      role: "user",
      content: buildDreamTaskPrompt()
    }];

    for (let step = 1; step <= maxSteps; step += 1) {
      const started = Date.now();
      const requestPayload = {
        system: systemText,
        messages,
        toolNames: Object.keys(registry.tools),
        step,
        maxSteps
      };

      let collected: Awaited<ReturnType<typeof collectStream>>;
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
          messages,
          tools: registry.tools
        });
      } catch (error) {
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

      messages.push(assistantMessageForDreamStep(collected));
      if (collected.toolCalls.length === 0) {
        state.finished = true;
        state.finishReason ||= collected.text.trim() ? "assistant_stopped" : "assistant_stopped_empty";
        return;
      }

      for (const call of collected.toolCalls) {
        const dispatched = await dispatcher.dispatch(call, {
          threadId: state.runId,
          wakeId: state.runId,
          scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] }
        });
        messages.push(toolResultMessage(call, dispatched));
      }

      if (state.finished) return;
    }
  }

  private async runLlmCandidates(input: {
    candidates: MemoryDreamLlmCandidate[];
    requestPayload: unknown;
    metadata: Record<string, unknown>;
    system: SystemModelMessage;
    messages: ModelMessage[];
    tools: ToolSet;
  }): Promise<Awaited<ReturnType<typeof collectStream>>> {
    let lastError: unknown = null;
    const maxAttemptsPerCandidate = maxAttemptsForLlmCandidateCount(input.candidates.length);
    for (let candidateIndex = 0; candidateIndex < input.candidates.length; candidateIndex += 1) {
      const candidate = input.candidates[candidateIndex]!;
      for (let attempt = 1; attempt <= maxAttemptsPerCandidate; attempt += 1) {
        const started = Date.now();
        const metadata = {
          ...input.metadata,
          ...(candidateIndex === 0 && attempt === 1 ? {} : {
            fallbackAttempt: true,
            candidateIndex,
            attempt,
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
          requestPayload: input.requestPayload,
          metadata
        }) ?? null;
        const firstChunkGuard = createFirstChunkTimeoutGuard(undefined, LLM_STREAM_IDLE_TIMEOUT_MS);
        try {
          const stream = streamText({
            model: candidate.model,
            reasoning: reasoningForAiSdk(candidate.reasoningEffort, candidate.supportsReasoning),
            providerOptions: providerOptionsWithReasoningForAiSdk(
              undefined,
              candidate.provider,
              candidate.reasoningEffort,
              candidate.supportsReasoning
            ),
            system: input.system,
            messages: input.messages,
            tools: input.tools,
            abortSignal: firstChunkGuard.signal,
            maxRetries: 0,
            timeout: MEMORY_DREAM_STEP_LLM_TIMEOUT
          });
          const collected = await collectStream(stream.fullStream, {
            onPart: firstChunkGuard.markChunk
          });
          recorder?.finishCall(callId, {
            status: "succeeded",
            result: collected,
            usage: collected.usage,
            metadata,
            latencyMs: Date.now() - started
          });
          return collected;
        } catch (error) {
          recorder?.finishCall(callId, {
            status: "failed",
            error,
            metadata,
            latencyMs: Date.now() - started
          });
          lastError = error;

          const retryable = isRetryableLlmError(error) && !isTimeoutLlmError(error);
          if (attempt < maxAttemptsPerCandidate && retryable) {
            await delay(retryDelayMs(attempt));
            continue;
          }

          if (candidateIndex < input.candidates.length - 1 && !isNonFallbackLlmError(error)) {
            break;
          }
          throw error;
        } finally {
          firstChunkGuard.cleanup();
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(errorMessage(lastError) || "LLM call failed");
  }

  private llmCandidates(): MemoryDreamLlmCandidate[] {
    const candidates = this.options.candidates?.length
      ? this.options.candidates
      : [{
          model: this.options.model,
          provider: this.options.provider,
          modelName: this.options.modelName ?? languageModelId(this.options.model),
          reasoningEffort: this.options.reasoningEffort,
          supportsReasoning: this.options.supportsReasoning,
          recorder: this.options.recorder
        }];
    return candidates.length ? candidates : [{
      model: this.options.model,
      provider: this.options.provider,
      modelName: this.options.modelName ?? languageModelId(this.options.model),
      reasoningEffort: this.options.reasoningEffort,
      supportsReasoning: this.options.supportsReasoning,
      recorder: this.options.recorder
    }];
  }

  private selectCandidates(limit: number, partition: MemoryDreamPartition): DreamCandidate[] {
    const entries = this.availableEntries(partition);
    const similarById = similarMemoryMap(entries);
    const boundedLimit = Math.max(1, Math.min(DEFAULT_MAX_CANDIDATES, Math.floor(limit)));
    const candidates = entries
      .map((entry) => {
        const similar = similarById.get(entry.id) ?? [];
        const { score, signals } = scoreDreamCandidate(entry, similar);
        return {
          entry,
          score,
          signals,
          similar,
          sourceMessages: []
        };
      })
      .filter((candidate) => candidate.score > 0 && !isDreamReviewCoolingDown(candidate.entry));
    return prioritizeDreamCandidates(candidates, boundedLimit).map((candidate) => ({
      ...candidate,
      sourceMessages: this.sourceMessagesFor(candidate.entry)
    }));
  }

  private sourceMessagesFor(entry: MemoryEntry): AgentMessage[] {
    const feedbackWakeMessageIds = arrayValue(entry.metadata?.feedbackEvents)
      .flatMap((event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) return [];
        const wakeId = (event as Record<string, unknown>).wakeId;
        return typeof wakeId === "string" && wakeId
          ? this.options.agentStore.getMessageIdsForWake(wakeId)
          : [];
      });
    const ids = uniqueStrings([
      entry.sourceMessageId ?? "",
      ...stringArray(entry.metadata?.sourceMessageIds),
      ...stringArray(entry.metadata?.extractionSourceMessageIds),
      ...feedbackWakeMessageIds
    ]).slice(0, SOURCE_SNIPPET_LIMIT);
    return ids
      .map((id) => this.options.agentStore.getMessageById(id))
      .filter((message): message is AgentMessage => Boolean(message));
  }

  private buildDreamToolRegistry(state: DreamRunState): ToolRegistry {
    const registry = new ToolRegistry();
    const tools: ToolDefinition[] = [
      {
        name: "list_memory_candidates",
        description:
          "List memory entries that look most worth reviewing for maintenance. Use this to choose what to inspect first.",
        parameters: LIST_CANDIDATES_SCHEMA,
        approval: "never",
        handler: async (input) => {
          const args = LIST_CANDIDATES_SCHEMA.parse(input);
          return {
            candidates: this.selectCandidates(args.limit ?? DEFAULT_MAX_CANDIDATES, state.partition)
              .map(candidateSummaryForTool)
          };
        }
      },
      {
        name: "search_memory",
        description:
          "Search available durable memories when looking for duplicates, related memories, or entries matching a topic.",
        parameters: SEARCH_MEMORY_SCHEMA,
        approval: "never",
        handler: async (input) => {
          const args = SEARCH_MEMORY_SCHEMA.parse(input);
          return {
            memories: (await this.searchMemoryPartition(state.partition, args)).map((result) => ({
              id: result.entry.id,
              // Raw reciprocal-rank scores live around 1/60; see the same note in
              // the memory tool serializer.
              score: Number(result.score.toFixed(5)),
              match: result.reason,
              scope: result.entry.scope,
              kind: result.entry.kind,
              content: result.entry.content,
              cues: result.entry.cues.slice(0, 8)
            }))
          };
        }
      },
      {
        name: "read_memory_context",
        description:
          "Read one memory with maintenance signals, similar memories, feedback, and source-message snippets before deciding.",
        parameters: MEMORY_ID_SCHEMA,
        approval: "never",
        handler: async ({ memoryId }) => {
          const candidate = await this.candidateForMemoryId(memoryId, state.partition);
          if (!candidate) throw new Error(`available memory not found: ${memoryId}`);
          return { memory: candidateForPrompt(candidate) };
        }
      },
      {
        name: "apply_memory_action",
        description:
          "Validate and immediately apply one memory maintenance action. Returns applied, rejected, or failed with the reason.",
        parameters: DREAM_ACTION_SCHEMA,
        approval: "never",
        handler: async (input) => this.applyActionFromTool(state, DREAM_ACTION_SCHEMA.parse(input))
      },
      {
        name: "finish_memory_dream",
        description: "Finish this memory maintenance run when useful review work is complete or the remaining candidates are low value.",
        parameters: FINISH_DREAM_SCHEMA,
        approval: "never",
        handler: async (input) => {
          const args = FINISH_DREAM_SCHEMA.parse(input);
          state.finished = true;
          state.finishReason = args.summary ? `finished: ${args.summary}` : "finished";
          return {
            ok: true,
            applied: state.applied,
            rejected: state.rejected,
            failed: state.failed,
            actionCount: state.actionCount
          };
        }
      }
    ];
    for (const tool of tools) registry.register(tool);
    return registry;
  }

  private async applyActionFromTool(state: DreamRunState, action: DreamAction) {
    if (state.finished) {
      return { status: "rejected", error: "dream run is already finished" };
    }
    if (state.actionCount >= state.actionBudget) {
      return { status: "rejected", error: "memory dream action budget exhausted" };
    }

    const candidate = await this.candidateForMemoryId(action.memoryId, state.partition);
    if (!candidate) {
      this.recordAction(state.runId, action, {
        status: "rejected",
        reason: action.reason,
        error: `available memory not found: ${action.memoryId}`
      });
      state.rejected += 1;
      state.actionCount += 1;
      return { status: "rejected", memoryId: action.memoryId, actionType: action.type, error: "available memory not found" };
    }
    if (state.seen.has(action.memoryId) && action.type !== "merge") {
      this.recordAction(state.runId, action, {
        status: "rejected",
        before: candidate.entry,
        reason: action.reason,
        error: "duplicate action for memory"
      });
      state.rejected += 1;
      state.actionCount += 1;
      return { status: "rejected", memoryId: action.memoryId, actionType: action.type, error: "duplicate action for memory" };
    }
    state.seen.add(action.memoryId);

    try {
      const result = await this.applyAction(state.runId, state.partition, candidate, action);
      if (result.status === "applied") state.applied += 1;
      else state.rejected += 1;
      state.actionCount += 1;
      return result;
    } catch (error) {
      state.failed += 1;
      state.actionCount += 1;
      this.recordAction(state.runId, action, {
        status: "failed",
        before: candidate.entry,
        reason: action.reason,
        error
      });
      return {
        status: "failed",
        memoryId: action.memoryId,
        actionType: action.type,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async candidateForMemoryId(
    memoryId: string,
    partition: MemoryDreamPartition
  ): Promise<DreamCandidate | null> {
    const entry = await this.options.memory.get(memoryId);
    if (!entry || entry.status !== "available" || !entryBelongsToPartition(entry, partition)) return null;
    const entries = this.availableEntries(partition);
    const similar = entries
      .filter((other) => other.id !== entry.id)
      .filter((other) => (
        other.kind === entry.kind
        && other.scope === entry.scope
        && other.projectId === entry.projectId
        && other.featureId === entry.featureId
        && contentSimilarity(entry.content, other.content) >= 0.82
      ));
    const { score, signals } = scoreDreamCandidate(entry, similar);
    return {
      entry,
      score,
      signals,
      similar,
      sourceMessages: this.sourceMessagesFor(entry)
    };
  }

  private async searchMemoryPartition(
    partition: MemoryDreamPartition,
    input: DreamSearchInput
  ): Promise<MemorySearchResult[]> {
    const allowedScopes: MemoryScope[] = partition.kind === "project"
      ? ["project", "feature"]
      : ["user", "global"];
    if (input.scope && input.scope !== "all" && !allowedScopes.includes(input.scope)) {
      throw new Error(`${input.scope} memory is outside the ${partition.kind} dream partition`);
    }
    const scopes = input.scope && input.scope !== "all" ? [input.scope] : allowedScopes;
    const maxResults = input.maxResults ?? 10;
    const context = partition.kind === "project" ? { projectId: partition.projectId } : {};
    const batches = await Promise.all(scopes.map((scope) => this.options.memory.search({
      query: input.query,
      kind: input.kind,
      scope,
      status: "available",
      maxResults,
      // Maintenance reading the store is not the store being used. Counting
      // these searches both inflated the recalled_without_use score that ranks
      // the dream's own candidates, and — because the review cooldown treats
      // any recall after a review as a reason to look again — let the dream
      // thaw memories it had just decided to leave alone.
      recordRecall: false
    }, context)));
    const byId = new Map<string, MemorySearchResult>();
    for (const result of batches.flat()) {
      const existing = byId.get(result.entry.id);
      if (!existing || result.score > existing.score) byId.set(result.entry.id, result);
    }
    return [...byId.values()]
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, maxResults);
  }

  private availableEntries(partition: MemoryDreamPartition): MemoryEntry[] {
    const filter = partitionSql(partition);
    const rows = this.options.db.prepare(`
      select *
      from memory_entries
      where status = 'available' and ${filter.where}
      order by updated_at desc
      limit 500
    `).all(...filter.params) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  private async applyAction(
    runId: string,
    partition: MemoryDreamPartition,
    candidate: DreamCandidate,
    action: DreamAction
  ) {
    const before = await this.options.memory.get(candidate.entry.id) ?? candidate.entry;
    const reason = action.reason.trim();
    const confidence = clamp01(action.confidence ?? 0.5);
    const metadata = dreamMetadata(before, runId, action);
    let after: MemoryEntry | null = null;
    let rejectReason = "";

    if (action.type === "archive") {
      rejectReason = archiveRejectionReason(before, candidate, reason, confidence);
      after = rejectReason
        ? before
        : await this.options.memory.archive(before.id, metadata);
    } else if (action.type === "merge") {
      const target = action.targetMemoryId ? await this.options.memory.get(action.targetMemoryId) : null;
      rejectReason = mergeRejectionReason(before, target, reason, confidence, partition);
      if (!rejectReason && target) {
        await this.options.memory.update({
          id: target.id,
          content: action.patch?.content?.trim() || chooseMergedContent(target.content, before.content),
          kind: action.patch?.kind ?? target.kind,
          strength: Math.max(target.strength, before.strength, action.patch?.strength ?? 0),
          confidence: Math.max(target.confidence, before.confidence, action.patch?.confidence ?? 0),
          cues: uniqueStrings([
            ...target.cues,
            ...before.cues,
            ...(action.patch?.cues ?? [])
          ]),
          metadata: mergeMetadata(target.metadata, {
            dreamLastRunId: runId,
            dreamLastAction: "merge_target",
            dreamMergedMemoryIds: uniqueStrings([
              ...stringArray(target.metadata?.dreamMergedMemoryIds),
              before.id
            ])
          })
        });
        after = await this.options.memory.archive(before.id, {
          ...metadata,
          mergedInto: target.id
        });
      }
    } else if (action.type === "rescope") {
      const resolved = resolveDreamRescope(before, action, partition);
      rejectReason = resolved.error;
      after = rejectReason
        ? before
        : await this.options.memory.update({
            id: before.id,
            scope: resolved.scope,
            projectId: resolved.projectId,
            featureId: resolved.featureId,
            content: action.patch?.content ?? before.content,
            kind: action.patch?.kind ?? before.kind,
            strength: action.patch?.strength ?? before.strength,
            confidence: action.patch?.confidence ?? before.confidence,
            cues: action.patch?.cues ?? before.cues,
            metadata
          });
    } else {
      after = await this.options.memory.update({
        id: before.id,
        scope: before.scope,
        projectId: before.projectId,
        featureId: before.featureId,
        content: action.patch?.content ?? before.content,
        kind: action.patch?.kind ?? before.kind,
        strength: action.patch?.strength ?? before.strength,
        confidence: action.patch?.confidence ?? before.confidence,
        cues: action.patch?.cues ?? before.cues,
        metadata
      });
    }

    const status = rejectReason ? "rejected" : "applied";
    this.recordAction(runId, action, {
      status,
      before,
      after,
      reason,
      error: rejectReason || undefined,
      source: actionSource(candidate)
    });
    return {
      status,
      memoryId: before.id,
      actionType: action.type,
      error: rejectReason || undefined,
      after: after ? {
        id: after.id,
        status: after.status,
        scope: after.scope,
        kind: after.kind,
        content: after.content
      } : null
    };
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
      projectIdForPartition(input.partition),
      input.candidateCount,
      input.appliedCount,
      input.startedAt,
      input.availableCountBefore
    );
  }

  private finishRun(runId: string, input: {
    status: "succeeded" | "failed" | "skipped";
    appliedCount: number;
    metadata?: Record<string, unknown>;
    error?: unknown;
    availableCountAfter: number;
  }) {
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

  private recordAction(runId: string, action: DreamAction, input: {
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
        before_json, after_json, reason, confidence, source_json, error_json,
        created_at, applied_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId("dma"),
      runId,
      action.type,
      input.status,
      action.memoryId,
      action.targetMemoryId ?? null,
      input.before ? jsonOrNull(input.before) : null,
      input.after ? jsonOrNull(input.after) : null,
      input.reason,
      action.confidence ?? null,
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

function aggregateDreamResults(results: MemoryDreamResult[]): MemoryDreamResult {
  const last = results.at(-1);
  if (!last) throw new Error("memory dream batch produced no results");
  if (results.length === 1) return last;
  return {
    ...last,
    candidateCount: results.reduce((total, result) => total + result.candidateCount, 0),
    actionCount: results.reduce((total, result) => total + result.actionCount, 0),
    appliedCount: results.reduce((total, result) => total + result.appliedCount, 0),
    rejectedCount: results.reduce((total, result) => total + result.rejectedCount, 0),
    failedCount: results.reduce((total, result) => total + result.failedCount, 0),
    runCount: results.length,
    runIds: results.map((result) => result.runId),
    partitions: results.map(({ runId, trigger, phase, projectId, processed, candidateCount, actionCount, appliedCount, rejectedCount, failedCount }) => ({
      runId,
      trigger,
      phase,
      projectId,
      processed,
      candidateCount,
      actionCount,
      appliedCount,
      rejectedCount,
      failedCount
    }))
  };
}

export class MemoryDreamJob {
  private running = false;
  private readonly startedAtMs: number;

  constructor(private input: {
    db: Database;
    dreamer: Pick<MemoryDreamer, "run"> & Partial<Pick<MemoryDreamer, "hasCandidates">>;
    idleMs?: number;
    minIntervalMs?: number;
    now?: () => number;
  }) {
    this.startedAtMs = input.now?.() ?? Date.now();
  }

  async tick(
    trigger = "idle",
    options: { force?: boolean } = {}
  ): Promise<MemoryDreamResult | { skipped: true; reason: string }> {
    if (this.running) return { skipped: true, reason: "already_running" };
    if (!options.force) {
      const eligible = this.eligibility();
      if (!eligible.ok) return { skipped: true, reason: eligible.reason };
    }
    this.running = true;
    try {
      const results: MemoryDreamResult[] = [];
      for (const partition of this.partitionsForTick()) {
        const result = await this.input.dreamer.run(trigger, partition);
        results.push(result);
      }
      return aggregateDreamResults(results);
    } finally {
      this.running = false;
    }
  }

  private partitionsForTick(): MemoryDreamPartition[] {
    const projects = listDreamProjectIds(this.input.db)
      .map((projectId): MemoryDreamPartition => ({ kind: "project", projectId }))
      .filter((partition) => this.input.dreamer.hasCandidates?.(partition) ?? true);
    return [...projects, { kind: "global" }];
  }

  eligibility(): { ok: true } | { ok: false; reason: string } {
    if (this.running) return { ok: false, reason: "already_running" };
    const now = this.input.now?.() ?? Date.now();
    const idleMs = this.input.idleMs ?? 60 * 60 * 1000;
    const lastHumanInput = latestHumanInputMs(this.input.db);
    const idleSince = Math.max(lastHumanInput ?? 0, this.startedAtMs);
    if (now - idleSince < idleMs) {
      return { ok: false, reason: "not_idle_long_enough" };
    }
    const minIntervalMs = this.input.minIntervalMs ?? 12 * 60 * 60 * 1000;
    const lastRun = latestDreamRunMs(this.input.db);
    if (lastRun && now - lastRun < minIntervalMs) {
      return { ok: false, reason: "dream_interval_not_elapsed" };
    }
    return { ok: true };
  }
}

interface MemoryDreamRunRow {
  id: string;
  trigger: string;
  status: string;
  provider: string;
  model: string;
  phase: string;
  project_id: string | null;
  project_name: string | null;
  candidate_count: number;
  applied_count: number;
  error_json: string | null;
  metadata_json: string | null;
  started_at: string;
  finished_at: string | null;
  available_count_before: number | null;
  available_count_after: number | null;
  keep_count: number;
  update_count: number;
  merge_count: number;
  archive_count: number;
  rescope_count: number;
}

interface MemoryDreamActionRow {
  id: string;
  run_id: string;
  action_type: string;
  status: string;
  memory_id: string;
  target_memory_id: string | null;
  before_json: string | null;
  after_json: string | null;
  reason: string;
  confidence: number | null;
  source_json: string | null;
  error_json: string | null;
  created_at: string;
  applied_at: string | null;
}

export function listMemoryDreamRuns(db: Database, limit = 20): MemoryDreamRunDto[] {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const rows = db.prepare(`
    select r.*, p.name as project_name,
      sum(case when a.status = 'applied' and a.action_type = 'keep' then 1 else 0 end) as keep_count,
      sum(case when a.status = 'applied' and a.action_type = 'update' then 1 else 0 end) as update_count,
      sum(case when a.status = 'applied' and a.action_type = 'merge' then 1 else 0 end) as merge_count,
      sum(case when a.status = 'applied' and a.action_type = 'archive' then 1 else 0 end) as archive_count,
      sum(case when a.status = 'applied' and a.action_type = 'rescope' then 1 else 0 end) as rescope_count
    from memory_dream_runs r
    left join projects p on p.id = r.project_id
    left join memory_dream_actions a on a.run_id = r.id
    group by r.id
    order by coalesce(r.finished_at, r.started_at) desc, r.started_at desc
    limit ?
  `).all(boundedLimit) as MemoryDreamRunRow[];
  return rows.map(memoryDreamRunFromRow);
}

export function getMemoryDreamRun(
  db: Database,
  id: string
): { run: MemoryDreamRunDto; actions: MemoryDreamActionDto[] } | null {
  const run = db.prepare(`
    select r.*, p.name as project_name,
      sum(case when a.status = 'applied' and a.action_type = 'keep' then 1 else 0 end) as keep_count,
      sum(case when a.status = 'applied' and a.action_type = 'update' then 1 else 0 end) as update_count,
      sum(case when a.status = 'applied' and a.action_type = 'merge' then 1 else 0 end) as merge_count,
      sum(case when a.status = 'applied' and a.action_type = 'archive' then 1 else 0 end) as archive_count,
      sum(case when a.status = 'applied' and a.action_type = 'rescope' then 1 else 0 end) as rescope_count
    from memory_dream_runs r
    left join projects p on p.id = r.project_id
    left join memory_dream_actions a on a.run_id = r.id
    where r.id = ?
    group by r.id
    limit 1
  `).get(id) as MemoryDreamRunRow | undefined;
  if (!run) return null;
  const actions = db.prepare(`
    select *
    from memory_dream_actions
    where run_id = ?
    order by created_at asc
  `).all(id) as MemoryDreamActionRow[];
  return {
    run: memoryDreamRunFromRow(run),
    actions: actions.map(memoryDreamActionFromRow)
  };
}

function memoryDreamRunFromRow(row: MemoryDreamRunRow): MemoryDreamRunDto {
  const metadata = parseJsonRecord(row.metadata_json);
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    provider: row.provider,
    model: row.model,
    phase: normalizeDreamPhase(row.phase),
    projectId: row.project_id,
    projectName: row.project_name,
    candidateCount: row.candidate_count,
    appliedCount: row.applied_count,
    actionCount: numberOrNull(metadata?.actionCount),
    actionCounts: {
      keep: row.keep_count,
      update: row.update_count,
      merge: row.merge_count,
      archive: row.archive_count,
      rescope: row.rescope_count
    },
    rejectedCount: numberOrNull(metadata?.rejectedCount),
    failedCount: numberOrNull(metadata?.failedCount),
    finishReason: typeof metadata?.finishReason === "string" ? metadata.finishReason : null,
    error: parseJsonUnknown(row.error_json),
    metadata,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    availableCountBefore: row.available_count_before,
    availableCountAfter: row.available_count_after
  };
}

function memoryDreamActionFromRow(row: MemoryDreamActionRow): MemoryDreamActionDto {
  return {
    id: row.id,
    runId: row.run_id,
    actionType: row.action_type,
    status: row.status,
    memoryId: row.memory_id,
    targetMemoryId: row.target_memory_id,
    reason: row.reason,
    confidence: row.confidence,
    source: parseJsonUnknown(row.source_json),
    error: parseJsonUnknown(row.error_json),
    before: parseJsonUnknown(row.before_json),
    after: parseJsonUnknown(row.after_json),
    createdAt: row.created_at,
    appliedAt: row.applied_at
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  const parsed = parseJsonUnknown(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function parseJsonUnknown(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDreamPhase(value: string): MemoryDreamRunDto["phase"] {
  return value === "project" || value === "global" ? value : "legacy";
}

/**
 * The dream's system prompt, ordered so the cacheable part comes first.
 *
 * Providers cache on an exact prompt prefix, so anything that varies has to
 * sit at the end or it invalidates everything after it. The partition rules
 * are the only varying part — they name the project this run may touch — so
 * they move from the middle of the instructions to the tail. Every run in
 * every dream now shares the whole body above them.
 */
export function buildDreamAgentSystemPrompt(
  actionBudget: number,
  partition: MemoryDreamPartition
) {
  const partitionRules = partition.kind === "project"
    ? [
        `This run is restricted to project ${partition.projectId} and may review only its project/feature memories.`,
        "Never merge across projects or features. Use rescope only to promote a feature memory to this project."
      ]
    : [
        "This run is restricted to user/global memories.",
        "Never merge or rescope project/feature memories into this partition."
      ];
  return [
    // ---- stable across every run ----
    "You are Mandate's offline memory maintenance process.",
    "You review durable memory entries after the user has been idle. You do not answer the user.",
    "Your job is to reduce memory clutter and improve long-term memory quality.",
    "You have tools to list candidates, search memory, read source context, and apply maintenance actions.",
    "Prioritize candidates with the never_reviewed signal before revisiting reviewed memories, unless another candidate has a higher-risk maintenance signal.",
    "Decide what to inspect and when to stop. Do not try to review every memory if the useful work is already done.",
    `You may apply at most ${actionBudget} memory actions in this run.`,
    "Feedback is evidence only. Never archive solely because one feedback event says stale or wrong.",
    "Archive only when the memory is clearly obsolete, contradicted by reliable source context, redundant after merge, or low-value after repeated negative signals and no useful use.",
    "A memory carrying recalled_without_use has been loaded into an agent's context that many times and never once relied on. That is evidence of low value in its own right, not an absence of evidence: this kind of waste is silent and never produces a feedback event, so waiting for negative feedback on it means waiting forever. Weigh a high recall count here as you would repeated negative signals, and prefer update — sharper cues, narrower scope — when the memory is sound but keeps being retrieved for the wrong queries.",
    "Do not archive explicit_user memories unless source context clearly shows the user reversed that preference or instruction.",
    "Prefer keep when uncertain.",
    "Allowed actions: keep, update, merge, archive, rescope.",
    "Use update to improve wording, cues, kind, strength, or confidence.",
    "Use merge only for duplicate or near-duplicate memories; targetMemoryId must be the memory that should remain.",
    "When merging, if the source has useful details the target lacks, provide patch.content that keeps them; otherwise the fallback just picks the longer string and the rest is dropped.",
    "Use rescope only when a memory clearly belongs at another scope allowed by the current partition rules.",
    "Use apply_memory_action to execute a decision. The tool validates and applies the action immediately, returning applied, rejected, or failed.",
    "Use keep when you deliberately reviewed a memory and decided no lifecycle change is needed.",
    "Call finish_memory_dream when you have completed useful maintenance or should stop.",
    // ---- varies by partition; must stay last ----
    ...partitionRules
  ].join("\n");
}

/**
 * The opening message. Byte-identical for every run, deliberately.
 *
 * It used to open with `Dream run: ${runId}`, which gave each run a unique
 * first line and so invalidated the cached prefix for the entire conversation
 * that followed — no two runs could ever share a cache entry. The model never
 * needed it: tools receive the run id from the dispatcher context, not from
 * the prompt. The partition is named in the system prompt's tail instead.
 */
export function buildDreamTaskPrompt() {
  return [
    "Maintain Mandate's durable memory store.",
    "Start by listing candidates or searching memory, inspect source context for risky decisions, apply only well-supported actions, then finish."
  ].join("\n");
}

function candidateForPrompt(candidate: DreamCandidate) {
  const entry = candidate.entry;
  return {
    id: entry.id,
    scope: entry.scope,
    projectId: entry.projectId,
    featureId: entry.featureId,
    kind: entry.kind,
    source: entry.source,
    content: entry.content,
    cues: entry.cues,
    strength: entry.strength,
    confidence: entry.confidence,
    recallCount: entry.recallCount,
    useCount: entry.useCount,
    lastRecalledAt: entry.lastRecalledAt,
    lastUsedAt: entry.lastUsedAt,
    feedback: entry.feedback,
    feedbackEvents: arrayValue(entry.metadata?.feedbackEvents).slice(-8),
    extractionReason: entry.metadata?.extractionReason ?? null,
    signals: candidate.signals,
    similar: candidate.similar.slice(0, 5).map((similar) => ({
      id: similar.id,
      kind: similar.kind,
      scope: similar.scope,
      content: similar.content,
      strength: similar.strength,
      confidence: similar.confidence,
      useCount: similar.useCount
    })),
    sourceMessages: candidate.sourceMessages.map(formatSourceMessage)
  };
}

function candidateSummaryForTool(candidate: DreamCandidate) {
  const entry = candidate.entry;
  return {
    id: entry.id,
    scope: entry.scope,
    projectId: entry.projectId,
    featureId: entry.featureId,
    kind: entry.kind,
    source: entry.source,
    content: entry.content,
    cues: entry.cues.slice(0, 8),
    strength: entry.strength,
    confidence: entry.confidence,
    recallCount: entry.recallCount,
    useCount: entry.useCount,
    feedback: entry.feedback,
    score: Number(candidate.score.toFixed(3)),
    signals: candidate.signals,
    similarMemoryIds: candidate.similar.slice(0, 5).map((similar) => similar.id)
  };
}

function assistantMessageForDreamStep(
  collected: Awaited<ReturnType<typeof collectStream>>
): ModelMessage {
  const parts: Array<
    { type: "text"; text: string } |
    { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];
  if (collected.text) {
    parts.push({ type: "text", text: collected.text });
  }
  for (const call of collected.toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.args
    });
  }
  return { role: "assistant", content: parts.length ? parts : "" };
}

function toolResultMessage(
  call: Awaited<ReturnType<typeof collectStream>>["toolCalls"][number],
  dispatched: { result?: unknown; isError?: boolean; error?: string }
): ModelMessage {
  const output = dispatched.isError
    ? { type: "error-text" as const, value: dispatched.error ?? "tool error" }
    : { type: "json" as const, value: toJsonValue(dispatched.result) };
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

/** Below this many recalls there isn't yet evidence of anything. */
const RECALLED_WITHOUT_USE_MIN = 3;
const RECALLED_WITHOUT_USE_MAX = 75;

/**
 * How strongly "loaded into context again and again, never once used" argues
 * for maintenance.
 *
 * This used to be `min(25, recallCount * 3)`, which saturated at nine recalls:
 * a memory wasted 234 times scored exactly the same as one wasted nine times,
 * and both lost to two pieces of negative feedback at 20 apiece. The strongest
 * evidence a store actually produces could not compete, which is why a real
 * store accumulated 102 of these and maintenance kept every one.
 *
 * Log growth, because the difference between 3 and 30 wasted recalls is large
 * and the difference between 200 and 234 is not. The curve is fitted to leave
 * the weak end where it already was — three recalls scored 9 before and scores
 * 10 now, so barely-seen memories do not suddenly become archive candidates —
 * while 50 recalls overtakes two negative feedbacks and the cap stays under
 * four, since repeated explicit rejection is still the stronger signal.
 */
export function recalledWithoutUseScore(recallCount: number): number {
  if (recallCount < RECALLED_WITHOUT_USE_MIN) return 0;
  return Math.min(RECALLED_WITHOUT_USE_MAX, Math.round(10 * Math.log2(recallCount) - 6));
}

function scoreDreamCandidate(entry: MemoryEntry, similar: MemoryEntry[]) {
  const feedback = entry.feedback;
  const negative = Number(feedback.irrelevant ?? 0) + Number(feedback.stale ?? 0) + Number(feedback.wrong ?? 0);
  const positive = Number(feedback.used ?? 0) + Number(feedback.helpful ?? 0);
  const signals: string[] = [];
  let score = 0;

  if (negative > 0) {
    score += negative * 20;
    signals.push(`negative_feedback:${negative}`);
  }
  if (positive > 0) {
    score += 6;
    signals.push(`positive_feedback:${positive}`);
  }
  if (entry.recallCount >= RECALLED_WITHOUT_USE_MIN && entry.useCount === 0) {
    score += recalledWithoutUseScore(entry.recallCount);
    signals.push("recalled_without_use");
  }
  if (similar.length > 0) {
    score += 18;
    signals.push(`possible_duplicates:${similar.length}`);
  }
  if (!dreamReviewedAt(entry)) {
    score += 8;
    signals.push("never_reviewed");
  }
  if (entry.confidence < 0.4 || entry.strength < 0.25) {
    score += 12;
    signals.push("low_trust");
  }

  return { score, signals };
}

function prioritizeDreamCandidates(candidates: DreamCandidate[], limit: number) {
  const sortByScore = (a: DreamCandidate, b: DreamCandidate) =>
    b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  const sortUnreviewed = (a: DreamCandidate, b: DreamCandidate) =>
    b.score - a.score
      || a.entry.createdAt.localeCompare(b.entry.createdAt)
      || b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  const unreviewed = candidates
    .filter((candidate) => !dreamReviewedAt(candidate.entry))
    .sort(sortUnreviewed);
  const reviewed = candidates
    .filter((candidate) => Boolean(dreamReviewedAt(candidate.entry)))
    .sort(sortByScore);
  const reserve = Math.min(
    unreviewed.length,
    Math.max(1, Math.floor(limit * UNREVIEWED_CANDIDATE_RESERVE_RATIO))
  );
  return [
    ...unreviewed.slice(0, reserve),
    ...reviewed.slice(0, limit - reserve),
    ...unreviewed.slice(reserve)
  ].slice(0, limit);
}

function dreamReviewedAt(entry: MemoryEntry): number | null {
  return timestampMs(entry.metadata?.dreamLastReviewedAt);
}

function isDreamReviewCoolingDown(entry: MemoryEntry, nowMs = Date.now()) {
  const reviewedAt = dreamReviewedAt(entry);
  if (reviewedAt === null || nowMs - reviewedAt >= DREAM_REVIEW_COOLDOWN_MS) return false;
  return ![
    entry.lastRecalledAt,
    entry.lastUsedAt,
    entry.metadata?.lastFeedbackAt
  ].some((value) => {
    const timestamp = timestampMs(value);
    return timestamp !== null && timestamp > reviewedAt;
  });
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function similarMemoryMap(entries: MemoryEntry[]) {
  const result = new Map<string, MemoryEntry[]>();
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (a.kind !== b.kind) continue;
      if (a.scope !== b.scope || a.projectId !== b.projectId || a.featureId !== b.featureId) continue;
      if (contentSimilarity(a.content, b.content) < 0.82) continue;
      result.set(a.id, [...(result.get(a.id) ?? []), b]);
      result.set(b.id, [...(result.get(b.id) ?? []), a]);
    }
  }
  return result;
}

function dreamMetadata(entry: MemoryEntry, runId: string, action: DreamAction) {
  return mergeMetadata(entry.metadata, {
    dreamLastRunId: runId,
    dreamLastReviewedAt: nowIso(),
    dreamLastAction: action.type,
    dreamLastReason: action.reason,
    dreamLastConfidence: action.confidence ?? null,
    dreamReviewCount: Number(entry.metadata?.dreamReviewCount ?? 0) + 1
  });
}

function archiveRejectionReason(
  entry: MemoryEntry,
  candidate: DreamCandidate,
  reason: string,
  confidence: number
) {
  if (!reason.trim()) return "archive requires reason";
  if (confidence < 0.65) return "archive confidence below threshold";
  const negative = Number(entry.feedback.irrelevant ?? 0) + Number(entry.feedback.stale ?? 0) + Number(entry.feedback.wrong ?? 0);
  if (
    entry.source === "explicit_user"
    && (
      negative === 0
      || !candidate.sourceMessages.some((message) => message.role === "user")
      || !reason.toLowerCase().includes("user")
    )
  ) {
    return "explicit_user memory requires user-derived reversal evidence";
  }
  if (negative > 0 && candidate.sourceMessages.length === 0 && candidate.similar.length === 0 && !entry.expiresAt) {
    return "negative feedback without source context is not enough to archive memory";
  }
  return "";
}

function mergeRejectionReason(
  entry: MemoryEntry,
  target: MemoryEntry | null,
  reason: string,
  confidence: number,
  partition: MemoryDreamPartition
) {
  if (!reason.trim()) return "merge requires reason";
  if (confidence < 0.6) return "merge confidence below threshold";
  if (!target) return "merge target not found";
  if (target.status !== "available") return "merge target is not available";
  if (target.id === entry.id) return "merge target cannot be self";
  if (!entryBelongsToPartition(target, partition)) return "merge target is outside dream partition";
  if (!sameDreamMergeBoundary(entry, target)) return "merge target must share the same memory scope";
  return "";
}

function sameDreamMergeBoundary(a: MemoryEntry, b: MemoryEntry) {
  return a.scope === b.scope
    && a.projectId === b.projectId
    && a.featureId === b.featureId;
}

function resolveDreamRescope(
  entry: MemoryEntry,
  action: DreamAction,
  partition: MemoryDreamPartition
): {
  error: string;
  scope: MemoryEntry["scope"];
  projectId: string | null;
  featureId: string | null;
} {
  const requestedScope = action.patch?.scope;
  if (!requestedScope) {
    return {
      error: "rescope requires a target scope",
      scope: entry.scope,
      projectId: entry.projectId,
      featureId: entry.featureId
    };
  }
  if (!entryBelongsToPartition(entry, partition)) {
    return {
      error: "memory is outside dream partition",
      scope: entry.scope,
      projectId: entry.projectId,
      featureId: entry.featureId
    };
  }
  if (partition.kind === "global") {
    if (requestedScope !== "user" && requestedScope !== "global") {
      return {
        error: "global dream can only rescope user/global memories",
        scope: entry.scope,
        projectId: entry.projectId,
        featureId: entry.featureId
      };
    }
    if (action.patch?.projectId || action.patch?.featureId) {
      return {
        error: "global/user memory cannot retain project or feature ids",
        scope: entry.scope,
        projectId: entry.projectId,
        featureId: entry.featureId
      };
    }
    return {
      error: "",
      scope: requestedScope,
      projectId: null,
      featureId: null
    };
  }
  if (entry.projectId !== partition.projectId) {
    return {
      error: "memory belongs to another project",
      scope: entry.scope,
      projectId: entry.projectId,
      featureId: entry.featureId
    };
  }
  const requestedProjectId = action.patch?.projectId === undefined
    ? partition.projectId
    : action.patch.projectId;
  if (requestedProjectId !== partition.projectId) {
    return {
      error: "project dream cannot rescope across projects",
      scope: entry.scope,
      projectId: entry.projectId,
      featureId: entry.featureId
    };
  }
  if (entry.scope === "project") {
    if (requestedScope !== "project") {
      return {
        error: "project memory can only remain project-scoped in a project dream",
        scope: entry.scope,
        projectId: entry.projectId,
        featureId: entry.featureId
      };
    }
    return { error: "", scope: "project", projectId: partition.projectId, featureId: null };
  }
  if (entry.scope !== "feature") {
    return {
      error: "project dream cannot rescope global/user memories",
      scope: entry.scope,
      projectId: entry.projectId,
      featureId: entry.featureId
    };
  }
  if (requestedScope === "project") {
    return { error: "", scope: "project", projectId: partition.projectId, featureId: null };
  }
  if (requestedScope !== "feature") {
    return {
      error: "feature memory can only rescope to its project or remain feature-scoped",
      scope: entry.scope,
      projectId: entry.projectId,
      featureId: entry.featureId
    };
  }
  const requestedFeatureId = action.patch?.featureId === undefined
    ? entry.featureId
    : action.patch.featureId;
  if (!requestedFeatureId || requestedFeatureId !== entry.featureId) {
    return {
      error: "feature memory cannot rescope to another feature",
      scope: entry.scope,
      projectId: entry.projectId,
      featureId: entry.featureId
    };
  }
  return { error: "", scope: "feature", projectId: partition.projectId, featureId: requestedFeatureId };
}

function actionSource(candidate: DreamCandidate) {
  return {
    candidateScore: candidate.score,
    signals: candidate.signals,
    sourceMessageIds: candidate.sourceMessages.map((message) => message.id),
    similarMemoryIds: candidate.similar.map((memory) => memory.id)
  };
}

function chooseMergedContent(a: string, b: string) {
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  if (normalizedA.includes(normalizedB)) return a;
  if (normalizedB.includes(normalizedA)) return b;
  return a.length >= b.length ? a : b;
}

function projectIdForPartition(partition: MemoryDreamPartition): string | null {
  return partition.kind === "project" ? partition.projectId : null;
}

function partitionSql(partition: MemoryDreamPartition): { where: string; params: SqlValue[] } {
  if (partition.kind === "project") {
    return {
      where: "scope in ('project','feature') and project_id = ?",
      params: [partition.projectId]
    };
  }
  return {
    where: "scope in ('user','global')",
    params: []
  };
}

function entryBelongsToPartition(entry: MemoryEntry, partition: MemoryDreamPartition) {
  if (partition.kind === "project") {
    return (entry.scope === "project" || entry.scope === "feature")
      && entry.projectId === partition.projectId;
  }
  return entry.scope === "user" || entry.scope === "global";
}

function listDreamProjectIds(db: Database): string[] {
  const rows = db.prepare(`
    select project_id,
      min(case
        when json_extract(metadata_json, '$.dreamLastReviewedAt') is null then created_at
        else null
      end) as oldest_unreviewed_at,
      min(coalesce(json_extract(metadata_json, '$.dreamLastReviewedAt'), created_at)) as oldest_review_at
    from memory_entries
    where status = 'available'
      and scope in ('project','feature')
      and project_id is not null
      and project_id <> ''
    group by project_id
    order by oldest_unreviewed_at is null, oldest_unreviewed_at asc, oldest_review_at asc, project_id asc
  `).all() as Array<{ project_id: string }>;
  return rows.map((row) => row.project_id);
}

function latestHumanInputMs(db: Database) {
  const row = db.prepare(`
    select max(created_at) as ts
    from agent_messages
    where role = 'user'
      and source in ('user', 'voice')
  `).get() as { ts: string | null } | undefined;
  return row?.ts ? Date.parse(row.ts) : null;
}

function latestDreamRunMs(db: Database) {
  const row = db.prepare(`
    select coalesce(finished_at, started_at) as ts
    from memory_dream_runs
    where status in ('running','succeeded','failed','skipped')
    order by coalesce(finished_at, started_at) desc
    limit 1
  `).get() as { ts: string | null } | undefined;
  return row?.ts ? Date.parse(row.ts) : null;
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
    case "feature_event":
      return `${content.label} ${content.kind}: ${content.summary}`;
    case "summary":
      return content.summary;
  }
}

function contentSimilarity(a: string, b: string) {
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
    return Math.min(normalizedA.length, normalizedB.length) / Math.max(normalizedA.length, normalizedB.length);
  }
  return jaccard(featureSet(normalizedA), featureSet(normalizedB));
}

function normalizeForComparison(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function featureSet(value: string) {
  const features = new Set<string>();
  for (const token of value.split(/\s+/).filter(Boolean)) features.add(token);
  const compact = value.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i += 1) features.add(compact.slice(i, i + 2));
  return features;
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function languageModelId(model: LanguageModel) {
  if (typeof model === "object" && model && "modelId" in model && typeof model.modelId === "string") {
    return model.modelId;
  }
  return "";
}
