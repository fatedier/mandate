import { z } from "zod";
import type { ToolDefinition, ToolContext } from "../../agent/tool-registry.js";
import type { AgentScope } from "../../agent/agent-store.js";
import {
  defaultMemoryScopeForContext,
  MEMORY_KINDS,
  MEMORY_FEEDBACK_OUTCOMES,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
  type MemoryManager
} from "../manager.js";
import type {
  MemoryKind,
  MemoryScope,
  MemorySearchResult
} from "../types.js";

const scopeSchema = z.enum(MEMORY_SCOPES);
const scopeOrAllSchema = z.union([scopeSchema, z.literal("all")]);
const scopeOrContextSchema = z.union([scopeSchema, z.literal("context")]);
const kindSchema = z.enum(MEMORY_KINDS);
const statusSchema = z.enum(MEMORY_STATUSES);
const sourceSchema = z.enum(MEMORY_SOURCES);
const feedbackOutcomeSchema = z.enum(MEMORY_FEEDBACK_OUTCOMES);

const searchBaseParams = {
  query: z.string().min(1).describe("Search query. Use natural language or keywords."),
  scope: scopeOrAllSchema.optional().describe(
    "Scope to search. Default 'all' searches user/global plus the current project/feature context."
  ),
  kind: kindSchema.optional(),
  status: z.union([statusSchema, z.literal("any")]).optional(),
  includeArchived: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(20).optional()
} satisfies z.ZodRawShape;

const overviewSearchParams = z.object({
  ...searchBaseParams,
  projectId: z.string().min(1).optional(),
  featureId: z.string().min(1).optional()
}).strict();

const featureSearchParams = z.object(searchBaseParams).strict();
type SearchParams = z.infer<typeof overviewSearchParams> | z.infer<typeof featureSearchParams>;

const memoryIdSchema = z.string().trim().min(1);

const getParams = z.object({
  id: memoryIdSchema
});

const rememberBaseParams = {
  content: z.string().min(1).describe("Compact durable memory text."),
  scope: scopeOrContextSchema.optional().describe(
    "Where to store the memory. Default 'context' means current feature, then project, then global."
  ),
  kind: kindSchema.default("semantic"),
  strength: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  cues: z.array(z.string().min(1)).max(12).optional(),
  source: sourceSchema.default("manual"),
  expiresAt: z.string().min(1).optional(),
  supersedes: z.string().min(1).optional(),
  metadata: z.looseObject({}).optional()
} satisfies z.ZodRawShape;

const overviewRememberParams = z.object({
  ...rememberBaseParams,
  projectId: z.string().min(1).optional(),
  featureId: z.string().min(1).optional()
}).strict();

const featureRememberParams = z.object(rememberBaseParams).strict();
type RememberParams = z.infer<typeof overviewRememberParams> | z.infer<typeof featureRememberParams>;

const updateParams = z.object({
  id: memoryIdSchema,
  content: z.string().min(1).optional(),
  kind: kindSchema.optional(),
  strength: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  cues: z.array(z.string().min(1)).max(12).optional(),
  expiresAt: z.union([z.string().min(1), z.null()]).optional(),
  supersedes: z.union([z.string().min(1), z.null()]).optional(),
  metadata: z.looseObject({}).optional()
});

const feedbackParams = z.object({
  id: memoryIdSchema.describe("Exact memory id from the Memory section, memory_search, or memory_get."),
  outcome: feedbackOutcomeSchema.describe(
    "used/helpful mean the memory was actually useful; irrelevant/stale/wrong are negative evidence signals only."
  ),
  note: z.string().min(1).describe("Concrete explanation for the feedback. Required so later memory maintenance can audit the signal.")
});

const forgetParams = z.object({
  id: memoryIdSchema,
  reason: z.string().optional()
});

export function buildMemoryTools(memory: MemoryManager, scope: AgentScope): ToolDefinition[] {
  return [
    memorySearchTool(memory, scope),
    memoryGetTool(memory),
    memoryRememberTool(memory, scope),
    memoryUpdateTool(memory),
    memoryFeedbackTool(memory),
    memoryForgetTool(memory)
  ];
}

function memorySearchTool(memory: MemoryManager, scope: AgentScope): ToolDefinition<SearchParams, {
  memories: Array<ReturnType<typeof serializeSearchResultForAgent>>;
}> {
  const featureScope = scope === "worker";
  return {
    name: "memory_search",
    description:
      "Search durable Mandate memory. Use this before relying on past user preferences, procedures, prior decisions, project conventions, recurring failures, or historical context not present in the chat."
      + (featureScope
        ? " Workers do not pass projectId or featureId; current project/feature context is applied automatically for project and feature scopes."
        : " The manager may pass projectId and featureId when intentionally searching a specific project or feature."),
    parameters: (featureScope ? featureSearchParams : overviewSearchParams) as z.ZodType<SearchParams>,
    approval: "never",
    handler: async (args, ctx) => ({
      memories: (await memory.search({
        query: args.query,
        scope: args.scope,
        projectId: "projectId" in args ? args.projectId : undefined,
        featureId: "featureId" in args ? args.featureId : undefined,
        kind: args.kind,
        status: args.status,
        includeArchived: args.includeArchived,
        maxResults: args.maxResults
      }, contextFromTool(ctx))).map(serializeSearchResultForAgent)
    })
  };
}

function memoryGetTool(memory: MemoryManager): ToolDefinition<z.infer<typeof getParams>, {
  memory: ReturnType<typeof serializeEntryForAgent>;
}> {
  return {
    name: "memory_get",
    description: "Read one durable memory entry by id.",
    parameters: getParams,
    approval: "never",
    handler: async ({ id }) => {
      const entry = await memory.get(id);
      if (!entry) throw new Error(`memory not found: ${id}`);
      return { memory: serializeEntryForAgent(entry) };
    }
  };
}

function memoryRememberTool(memory: MemoryManager, scopeKind: AgentScope): ToolDefinition<RememberParams, {
  memory: ReturnType<typeof serializeMutationForAgent>;
}> {
  const featureScope = scopeKind === "worker";
  return {
    name: "memory_remember",
    description:
      "Create a compact durable memory. Use only for stable preferences, semantic facts/decisions, procedural lessons, episodic source notes, or explicit user requests to remember something."
      + (featureScope
        ? " Workers do not pass projectId or featureId; current project/feature context is applied automatically for project and feature scopes."
        : " The manager may pass projectId and featureId when intentionally storing a project or feature scoped memory."),
    parameters: (featureScope ? featureRememberParams : overviewRememberParams) as z.ZodType<RememberParams>,
    approval: "never",
    handler: async (args, ctx) => {
      const scope = defaultMemoryScopeForContext({
        requestedScope: args.scope,
        project: ctx.project ?? null,
        feature: ctx.feature ?? null
      });
      const entry = await memory.remember({
        scope,
        projectId: ("projectId" in args ? args.projectId : undefined) ?? projectIdForScope(scope, ctx),
        featureId: ("featureId" in args ? args.featureId : undefined) ?? featureIdForScope(scope, ctx),
        kind: args.kind as MemoryKind,
        content: args.content,
        strength: args.strength,
        confidence: args.confidence,
        cues: args.cues,
        source: args.source,
        sourceThreadId: ctx.threadId,
        expiresAt: args.expiresAt,
        supersedes: args.supersedes,
        metadata: args.metadata ?? null
      });
      return { memory: serializeMutationForAgent(entry) };
    }
  };
}

function memoryUpdateTool(memory: MemoryManager): ToolDefinition<z.infer<typeof updateParams>, {
  memory: ReturnType<typeof serializeMutationForAgent>;
}> {
  return {
    name: "memory_update",
    description: "Update a durable memory entry by id.",
    parameters: updateParams,
    approval: "never",
    handler: async (args) => {
      const entry = await memory.update(args);
      if (!entry) throw new Error(`memory not found: ${args.id}`);
      return { memory: serializeMutationForAgent(entry) };
    }
  };
}

function memoryFeedbackTool(memory: MemoryManager): ToolDefinition<z.infer<typeof feedbackParams>, {
  ok: true;
  id: string;
  outcome: z.infer<typeof feedbackOutcomeSchema>;
}> {
  return {
    name: "memory_feedback",
    description:
      "Record whether a recalled memory was actually used, helpful, irrelevant, stale, or wrong. Requires the exact memory id from the Memory section, memory_search, or memory_get. Include a concrete note. The tool attaches thread/wake source context automatically and never archives memory directly.",
    parameters: feedbackParams,
    approval: "never",
    handler: async (args, ctx) => {
      const entry = await memory.feedback({
        id: args.id,
        outcome: args.outcome,
        note: args.note,
        threadId: ctx.threadId,
        wakeId: ctx.wakeId
      });
      if (!entry) throw new Error(`memory not found: ${args.id}`);
      return { ok: true, id: entry.id, outcome: args.outcome };
    }
  };
}

function memoryForgetTool(memory: MemoryManager): ToolDefinition<z.infer<typeof forgetParams>, {
  memory: ReturnType<typeof serializeMutationForAgent>;
}> {
  return {
    name: "memory_forget",
    description:
      "Forget a durable memory entry by id. This redacts the content and marks it deleted. Use when the user asks to forget/remove a memory.",
    parameters: forgetParams,
    approval: "never",
    handler: async (args, ctx) => {
      const entry = await memory.forget(args.id, {
        forgottenByThreadId: ctx.threadId,
        reason: args.reason ?? ""
      });
      if (!entry) throw new Error(`memory not found: ${args.id}`);
      return { memory: serializeMutationForAgent(entry) };
    }
  };
}

function contextFromTool(ctx: ToolContext) {
  return {
    projectId: ctx.project?.id ?? ctx.feature?.projectId ?? null,
    featureId: ctx.feature?.id ?? null,
    threadId: ctx.threadId
  };
}

function projectIdForScope(scope: MemoryScope, ctx: ToolContext) {
  return scope === "project" || scope === "feature"
    ? ctx.project?.id ?? ctx.feature?.projectId ?? null
    : null;
}

function featureIdForScope(scope: MemoryScope, ctx: ToolContext) {
  return scope === "feature" ? ctx.feature?.id ?? null : null;
}

function serializeSearchResultForAgent(result: MemorySearchResult) {
  const entry = result.entry;
  return {
    id: entry.id,
    scope: entry.scope,
    kind: entry.kind,
    content: entry.content,
    cues: entry.cues.slice(0, 6),
    // Raw reciprocal-rank scores live around 1/60, so three decimals flatten the
    // whole result set onto one or two distinct values.
    score: Number(result.score.toFixed(5)),
    match: result.reason
  };
}

function serializeEntryForAgent(entry: MemorySearchResult["entry"]) {
  return {
    id: entry.id,
    scope: entry.scope,
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.featureId ? { featureId: entry.featureId } : {}),
    kind: entry.kind,
    content: entry.content,
    status: entry.status,
    cues: entry.cues.slice(0, 8),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {})
  };
}

function serializeMutationForAgent(entry: MemorySearchResult["entry"]) {
  return {
    id: entry.id,
    scope: entry.scope,
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.featureId ? { featureId: entry.featureId } : {}),
    kind: entry.kind,
    status: entry.status,
    updatedAt: entry.updatedAt
  };
}
