import { streamText, type LanguageModel, type ModelMessage } from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { collectStream } from "../agent/stream-collector.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import type { ReasoningEffort } from "../../../shared/settings.js";
import {
  providerOptionsWithReasoningForAiSdk,
  reasoningForAiSdk
} from "../llm/reasoning.js";
import { DEFAULT_TEXT_MODEL_LLM_TIMEOUT } from "../llm/timeouts.js";
import type { MemoryManager } from "./manager.js";
import type { MemoryEntry, MemoryKind, MemoryScope } from "./types.js";

const EXTRACTION_CANDIDATE_SCHEMA = z.object({
  kind: z.enum(["episodic", "semantic", "preference", "procedural"]),
  content: z.string().min(1),
  /**
   * Where the memory applies — not where it was learned.
   *
   * Scope used to be assigned mechanically from the extracting agent's
   * context: work inside a feature stamped every memory `feature`. That put
   * project-level facts — an issue's verdict, a migration's outcome — inside a
   * one-off task nobody re-enters, where they could never be recalled again.
   * Optional, because a model that does not answer should fall back to the old
   * behaviour rather than guess.
   */
  scope: z.enum(["feature", "project", "user"]).optional(),
  cues: z.array(z.string().min(1)).max(12).optional(),
  reason: z.string().optional()
});

const EXTRACTION_SCHEMA = z.object({
  memories: z.array(EXTRACTION_CANDIDATE_SCHEMA).default([])
});

type ExtractionOutput = z.infer<typeof EXTRACTION_SCHEMA>;
type ExtractionCandidate = ExtractionOutput["memories"][number];
type ExtractionKind = "new_chat" | "summary" | "feature_archive";

type ExtractionDecision =
  | { status: "created"; memory: MemoryEntry; score: number; reason?: string }
  | { status: "merged"; memory: MemoryEntry; score: number; reason?: string }
  | { status: "rejected"; score: number; reason: string };

export interface MemoryExtractionOptions {
  memory: MemoryManager;
  source: MemoryExtractionSource;
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder?: AgentLlmCallRecorder;
}

export interface MemoryExtractionSource {
  scope: MemoryScope;
  projectId?: string | null;
  featureId?: string | null;
  threadId?: string | null;
  messageIds?: string[];
  wakeId?: string | null;
  summaryMessageId?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryExtractionResult {
  processed: boolean;
  created: number;
  merged: number;
  rejected: number;
}

export function extractNewChatMemories(options: MemoryExtractionOptions) {
  return extractImmediateMemories(options, {
    kind: "new_chat",
    idPrefix: "new_chat_extract",
    purpose: "memory_new_chat_extraction",
    sourceTitle: "New chat archive transcript source",
    maxCandidates: 4,
    gate: "normal",
    system: [
      "You extract durable memory from a chat transcript immediately before the user starts a fresh chat.",
      "Only keep stable information that should help future sessions: user preferences, durable project facts, explicit decisions, or lessons learned.",
      "Do not keep transient status, command output, IDs, hashes, timestamps, URLs that are only one-off references, or chat filler.",
      "If nothing is worth remembering, return an empty memories array."
    ]
  });
}

export function extractSummaryMemories(options: MemoryExtractionOptions) {
  return extractImmediateMemories(options, {
    kind: "summary",
    idPrefix: "summary_extract",
    purpose: "memory_summary_extraction",
    sourceTitle: "Compression summary source",
    maxCandidates: 1,
    gate: "strict",
    system: [
      "You extract durable memory from a compressed conversation summary.",
      "Only keep stable information that should help future sessions: user preferences, durable project facts, explicit decisions, or lessons learned.",
      "Do not keep transient status, command output, IDs, hashes, timestamps, URLs that are only one-off references, or chat filler.",
      "If the summary only describes temporary progress, return an empty memories array."
    ]
  });
}

export function extractFeatureArchiveMemories(options: MemoryExtractionOptions) {
  return extractImmediateMemories(options, {
    kind: "feature_archive",
    idPrefix: "feature_archive_extract",
    purpose: "memory_feature_archive_extraction",
    sourceTitle: "Feature archive transcript source",
    maxCandidates: 4,
    gate: "normal",
    system: [
      "You extract durable memory from a feature chat transcript immediately before the feature is archived.",
      "The feature is being closed, so keep only information that should help future sessions: user preferences, durable project facts, explicit decisions, or reusable lessons learned.",
      "Do not keep transient implementation status, command output, IDs, hashes, timestamps, URLs that are only one-off references, or chat filler.",
      "If nothing is worth remembering after the feature is closed, return an empty memories array."
    ]
  });
}

async function extractImmediateMemories(
  options: MemoryExtractionOptions,
  mode: {
    kind: ExtractionKind;
    idPrefix: string;
    purpose: string;
    sourceTitle: string;
    maxCandidates: number;
    gate: "normal" | "strict";
    system: string[];
  }
): Promise<MemoryExtractionResult> {
  const sourceContent = options.source.content.trim();
  if (!sourceContent) {
    return { processed: false, created: 0, merged: 0, rejected: 0 };
  }

  const sourceKey = options.source.summaryMessageId
    ?? options.source.wakeId
    ?? options.source.messageIds?.[0]
    ?? options.source.threadId
    ?? "source";
  const extractionId = `${mode.idPrefix}_${Date.now().toString(36)}_${String(sourceKey).slice(0, 8)}`;
  const system = [
    ...mode.system,
    "Do not create memory solely from assistant/subagent-generated plans, drafts, summaries, or recommendations.",
    "Only promote assistant/subagent content when it is explicitly accepted by the user, directly states a user preference, or is backed by a concrete tool-verified outcome.",
    "Memory is expensive. Prefer returning zero memories. Usually return zero or one; return multiple only when each records a separate durable user preference, explicit decision, or reusable procedural lesson.",
    `Return at most ${mode.maxCandidates} memories.`,
    "Use kind=preference for durable user preferences, kind=semantic for stable facts/decisions, kind=procedural for reusable how-to lessons, and kind=episodic only for unusually important remembered events.",
    "Choose scope per memory: where the memory APPLIES, not where you happened to learn it.",
    "  scope=user — true regardless of project: the user's preferences, working style, and standing instructions.",
    "  scope=project — true for this whole project: an issue's verdict, an API contract, a dependency decision, a repository convention. Most findings from feature work belong here, because the feature is where you learned it, not what it is about.",
    "  scope=feature — only meaningful inside this one feature and worthless once it ends, such as its remaining steps or its own local state. A feature is a one-off task nobody re-enters, so a memory scoped there is unreachable afterwards. Choose it rarely.",
    "When torn between feature and project, choose project: a project memory is still visible while working in its features, but the reverse is not true.",
    "Do not include self-scoring fields such as strength, confidence, or durability; Mandate assigns conservative values itself.",
    "Return JSON only: {\"memories\":[{\"kind\":\"episodic|semantic|preference|procedural\",\"scope\":\"user|project|feature\",\"content\":\"...\",\"cues\":[\"...\"],\"reason\":\"...\"}]}."
  ].join("\n");
  const messages: ModelMessage[] = [{
    role: "user",
    content: [
      `Extraction kind: ${mode.kind}`,
      `Extraction ID: ${extractionId}`,
      `Current context scope: ${options.source.scope} (this is where you are, not where a memory must live)`,
      options.source.projectId ? `Project ID: ${options.source.projectId}` : "",
      options.source.featureId ? `Feature ID: ${options.source.featureId}` : "",
      options.source.threadId ? `Thread ID: ${options.source.threadId}` : "",
      options.source.wakeId ? `Wake ID: ${options.source.wakeId}` : "",
      options.source.messageIds?.length ? `Message IDs: ${options.source.messageIds.join(", ")}` : "",
      `${mode.sourceTitle}:`,
      sourceContent
    ].filter(Boolean).join("\n")
  }];

  const startedAt = Date.now();
  const callId = options.recorder?.startCall({
    purpose: mode.purpose,
    scopeType: options.source.scope,
    scopeId: options.source.featureId
      ?? options.source.projectId
      ?? options.source.threadId
      ?? sourceKey,
    requestPayload: { system, messages },
    metadata: {
      extractionKind: mode.kind,
      extractionId,
      sourceThreadId: options.source.threadId ?? null,
      sourceMessageIds: options.source.messageIds ?? []
    }
  }) ?? null;

  let result: Awaited<ReturnType<typeof callTextModel>>;
  try {
    result = await callTextModel({
      model: options.model,
      provider: options.provider,
      reasoningEffort: options.reasoningEffort,
      supportsReasoning: options.supportsReasoning,
      system,
      messages
    });
    options.recorder?.finishCall(callId, {
      status: "succeeded",
      result,
      latencyMs: Date.now() - startedAt
    });
  } catch (error) {
    options.recorder?.finishCall(callId, {
      status: "failed",
      error,
      latencyMs: Date.now() - startedAt
    });
    throw error;
  }

  const output = parseExtractionOutput(result.text);
  const decisions: ExtractionDecision[] = [];
  const seen = new Set<string>();

  const candidates = rankExtractionCandidates(output.memories, mode.kind).slice(0, mode.maxCandidates);
  for (const candidate of candidates) {
    const content = normalizeCandidateContent(candidate.content);
    const score = scoreCandidate(candidate, mode.kind);
    const duplicateKey = `${candidate.kind}:${normalizeForComparison(content)}`;
    let decision: ExtractionDecision;

    if (!content) {
      decision = { status: "rejected", score, reason: "empty_content" };
    } else if (seen.has(duplicateKey)) {
      decision = { status: "rejected", score, reason: "duplicate_candidate" };
    } else if (!passesPromotionGate(candidate, mode.kind, score, mode.gate)) {
      decision = { status: "rejected", score, reason: "low_quality_score" };
    } else {
      seen.add(duplicateKey);
      decision = await promoteCandidate(options, mode.kind, extractionId, candidate, content, score);
    }

    decisions.push(decision);
  }

  return {
    processed: true,
    created: decisions.filter((decision) => decision.status === "created").length,
    merged: decisions.filter((decision) => decision.status === "merged").length,
    rejected: decisions.filter((decision) => decision.status === "rejected").length
  };
}

async function callTextModel(input: {
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  system: string;
  messages: ModelMessage[];
}) {
  const result = streamText({
    model: input.model,
    reasoning: reasoningForAiSdk(input.reasoningEffort, input.supportsReasoning),
    providerOptions: providerOptionsWithReasoningForAiSdk(
      undefined,
      input.provider,
      input.reasoningEffort,
      input.supportsReasoning
    ),
    system: input.system,
    messages: input.messages,
    maxRetries: 0,
    timeout: DEFAULT_TEXT_MODEL_LLM_TIMEOUT
  });
  return collectStream(result.fullStream);
}

async function promoteCandidate(
  options: MemoryExtractionOptions,
  extractionKind: ExtractionKind,
  extractionId: string,
  candidate: ExtractionCandidate,
  content: string,
  score: number
): Promise<ExtractionDecision> {
  // Placement is resolved before the dedup, not after: a candidate the model
  // broadens to project scope has to be compared against project-scoped
  // memories, or an existing duplicate one level up is invisible and gets
  // written again.
  const placement = resolveMemoryPlacement(options.source, candidate.scope);
  const similar = await findSimilarActiveMemory(options.memory, placement, candidate.kind, content);
  if (similar && similar.similarity >= 0.82) {
    const existing = similar.entry;
    const defaults = promotionDefaults(extractionKind, candidate.kind);
    const memory = await options.memory.update({
      id: existing.id,
      content: chooseMergedContent(existing.content, content),
      strength: Math.max(existing.strength, defaults.strength),
      confidence: Math.max(existing.confidence, defaults.confidence),
      cues: uniqueStrings([...existing.cues, ...(candidate.cues ?? [])]),
      metadata: {
        ...(existing.metadata ?? {}),
        extractionLastKind: extractionKind,
        extractionLastId: extractionId,
        extractionSourceThreadIds: uniqueStrings([
          ...stringArray(existing.metadata?.extractionSourceThreadIds),
          options.source.threadId ?? ""
        ]),
        extractionSourceMessageIds: uniqueStrings([
          ...stringArray(existing.metadata?.extractionSourceMessageIds),
          ...(options.source.messageIds ?? [])
        ]),
        extractionMergeCount: Number(existing.metadata?.extractionMergeCount ?? 0) + 1,
        extractionLastScore: score
      }
    });
    return memory
      ? { status: "merged", memory, score, reason: candidate.reason }
      : { status: "rejected", score, reason: "merge_target_missing" };
  }

  const defaults = promotionDefaults(extractionKind, candidate.kind);
  const memory = await options.memory.remember({
    scope: placement.scope,
    projectId: placement.projectId,
    featureId: placement.featureId,
    kind: candidate.kind,
    content,
    status: "available",
    strength: defaults.strength,
    confidence: defaults.confidence,
    cues: candidate.cues,
    source: "agent_flush",
    sourceThreadId: options.source.threadId,
    sourceMessageId: options.source.messageIds?.[0] ?? options.source.summaryMessageId ?? null,
    metadata: {
      extractionKind,
      extractionId,
      extractionScore: score,
      extractionDurability: defaults.durability,
      extractionReason: candidate.reason?.trim() || undefined,
      sourceThreadId: options.source.threadId ?? null,
      sourceMessageIds: options.source.messageIds ?? [],
      sourceWakeId: options.source.wakeId ?? null,
      sourceSummaryMessageId: options.source.summaryMessageId ?? null,
      sourceMetadata: options.source.metadata ?? null
    }
  });
  return { status: "created", memory, score, reason: candidate.reason };
}

/**
 * Where a candidate actually gets stored.
 *
 * The model chooses where a memory applies, but it cannot reach outside the
 * context that produced it: an extraction running inside a feature may place a
 * memory on that feature, its project, or the user, and nowhere else. A choice
 * that needs an id the source does not carry — project scope during a
 * project-less thread — falls back to the source's own scope, which is the
 * behaviour this replaced.
 *
 * Broadening also has to drop the narrower ids: a project-scoped memory that
 * kept its featureId would be filtered right back out of every other feature's
 * prompt, which is the bug being fixed.
 */
export function resolveMemoryPlacement(
  source: Pick<MemoryExtractionSource, "scope" | "projectId" | "featureId">,
  chosen: "feature" | "project" | "user" | undefined
): { scope: MemoryScope; projectId: string | null; featureId: string | null } {
  const fallback = {
    scope: source.scope,
    projectId: source.projectId ?? null,
    featureId: source.featureId ?? null
  };
  if (!chosen) return fallback;

  if (chosen === "user") {
    return { scope: "user", projectId: null, featureId: null };
  }
  if (chosen === "project") {
    if (!source.projectId) return fallback;
    return { scope: "project", projectId: source.projectId, featureId: null };
  }
  // feature: only reachable when the extraction actually ran inside one.
  if (!source.featureId) return fallback;
  return { scope: "feature", projectId: source.projectId ?? null, featureId: source.featureId };
}

async function findSimilarActiveMemory(
  memory: MemoryManager,
  placement: { scope: MemoryScope; projectId: string | null; featureId: string | null },
  kind: MemoryKind,
  content: string
): Promise<{ entry: MemoryEntry; similarity: number } | null> {
  const results = await memory.search({
    query: content,
    scope: placement.scope,
    projectId: placement.projectId,
    featureId: placement.featureId,
    kind,
    status: "available",
    maxResults: 6,
    // A dedup lookup, not a retrieval for use. Counting it would credit a
    // recall to whichever stored memories happen to resemble the text being
    // written — the opposite of evidence that they are dead weight.
    recordRecall: false
  }, {
    // Visibility context matches the placement too, so the lookup sees exactly
    // the memories the new one would sit beside.
    projectId: placement.projectId,
    featureId: placement.featureId
  });
  let best: { entry: MemoryEntry; similarity: number } | null = null;
  for (const result of results) {
    const similarity = contentSimilarity(content, result.entry.content);
    if (!best || similarity > best.similarity) {
      best = { entry: result.entry, similarity };
    }
  }
  return best;
}

function parseExtractionOutput(text: unknown): ExtractionOutput {
  const parsed = EXTRACTION_SCHEMA.safeParse(JSON.parse(repairJsonText(String(text ?? ""))));
  if (!parsed.success) {
    throw new Error(`memory extraction output did not match schema: ${parsed.error.message}`);
  }
  return {
    memories: parsed.data.memories
      .map((memory) => ({
        ...memory,
        content: normalizeCandidateContent(memory.content)
      }))
      .filter((memory) => memory.content.length > 0)
  };
}

function rankExtractionCandidates(candidates: ExtractionCandidate[], extractionKind: ExtractionKind) {
  return [...candidates].sort((a, b) => scoreCandidate(b, extractionKind) - scoreCandidate(a, extractionKind));
}

function repairJsonText(text: string) {
  const stripped = stripMarkdownJsonFence(text.trim());
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    return jsonrepair(stripped || "{}");
  }
}

function stripMarkdownJsonFence(value: string) {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() || value;
}

function scoreCandidate(candidate: ExtractionCandidate, extractionKind: ExtractionKind) {
  const { strength, confidence, durability } = promotionDefaults(extractionKind, candidate.kind);
  return clamp01(strength * 0.4 + confidence * 0.35 + durability * 0.25);
}

function passesPromotionGate(
  candidate: ExtractionCandidate,
  extractionKind: ExtractionKind,
  score: number,
  gate: "normal" | "strict"
) {
  const { confidence, durability } = promotionDefaults(extractionKind, candidate.kind);
  if (gate === "strict") {
    return score >= 0.66 && confidence >= 0.7 && durability >= 0.72;
  }
  return score >= 0.68 && confidence >= 0.6 && durability >= 0.6;
}

function promotionDefaults(extractionKind: ExtractionKind, kind: MemoryKind) {
  const archiveLike = extractionKind === "new_chat" || extractionKind === "feature_archive";
  switch (kind) {
    case "preference":
      return archiveLike
        ? { strength: 0.78, confidence: 0.78, durability: 0.82 }
        : { strength: 0.7, confidence: 0.72, durability: 0.78 };
    case "procedural":
      return archiveLike
        ? { strength: 0.74, confidence: 0.74, durability: 0.78 }
        : { strength: 0.66, confidence: 0.72, durability: 0.76 };
    case "semantic":
      return archiveLike
        ? { strength: 0.66, confidence: 0.7, durability: 0.72 }
        : { strength: 0.6, confidence: 0.7, durability: 0.74 };
    case "episodic":
      return archiveLike
        ? { strength: 0.46, confidence: 0.62, durability: 0.58 }
        : { strength: 0.4, confidence: 0.58, durability: 0.52 };
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

function normalizeCandidateContent(content: string) {
  return content.trim().replace(/\s+/g, " ").slice(0, 1200);
}

function featureSet(value: string) {
  const features = new Set<string>();
  for (const token of value.split(/\s+/).filter(Boolean)) {
    features.add(token);
  }
  const compact = value.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i += 1) {
    features.add(compact.slice(i, i + 2));
  }
  return features;
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function chooseMergedContent(existing: string, candidate: string) {
  if (candidate.length > existing.length * 1.15 && contentSimilarity(existing, candidate) >= 0.9) {
    return candidate;
  }
  return existing;
}

function clamp01(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
