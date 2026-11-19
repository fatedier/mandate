import { z } from "zod";
import type { WorkerRecord, WorkerRecordStore } from "../../plans/record-store.js";
import { withoutStatedAt } from "../user-quote.js";
import type { ToolContext, ToolDefinition } from "../../agent/tool-registry.js";
import type { AgentScope, AgentStore } from "../../agent/agent-store.js";
import type { ProjectRow, ProjectsStore } from "../../projects/projects-store.js";
import type { MemoryManager } from "../manager.js";
import type { MemoryEntry } from "../types.js";
import { MIN_USER_QUOTE_CHARS, quoteMatcher } from "../user-quote.js";
import { describeAge } from "../age.js";
import { VOICE_TOOL_WAKE_ID } from "../../personal/handoff-service.js";
import { searchParams, readParams, rememberParams, updateParams, forgetParams } from "./memory-schema.js";

export interface MemoryToolDeps {
  memory: MemoryManager;
  scope: AgentScope;
  /** Workers' task records, beside their plans: opened by id, listed by project. */
  records: Pick<WorkerRecordStore, "getById" | "recent">;
  agentStore: Pick<AgentStore, "newestUserStatement" | "getThreadById">;
  projectsStore: Pick<ProjectsStore, "listActive" | "getById">;
  now?: () => number;
  /** How long a spoken call waits for the user's words; tests shorten it. */
  quoteWaitMs?: number;
}

export function buildMemoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  return [searchTool(deps), readTool(deps), rememberTool(deps), updateTool(deps), forgetTool(deps)];
}

/** Who used a memory: the kind of conversation the call came from. Not the
 *  tools' own scope: the personal agent calls the manager's instances. A
 *  side chat's use is the personal agent's. */
function usedBy(deps: MemoryToolDeps, threadId: string): string {
  const scope = deps.agentStore.getThreadById(threadId)?.scope ?? deps.scope;
  return scope === "side_chat" ? "personal" : scope;
}

function searchTool(deps: MemoryToolDeps): ToolDefinition<z.infer<typeof searchParams>, { memories: unknown[] }> {
  return {
    name: "memory_search",
    description:
      "Search Mandate's memory: the user's preferences and working rules, and project knowledge. "
      + "Workers' task records are found with chat_history_search. "
      + "Use it before working in a project, and when the user refers to something from an earlier conversation.",
    parameters: searchParams,
    handler: async (args, ctx) => {
      const project = args.project ? requireProject(args.project, deps) : null;
      const results = await deps.memory.search({
        query: args.query,
        projectId: project?.id ?? null,
        type: args.type,
        includeArchived: args.includeArchived,
        maxResults: args.maxResults
      });
      deps.memory.recordUses(results.map((result, i) => ({ memoryId: result.entry.id, kind: "search", threadId: ctx.threadId, agent: usedBy(deps, ctx.threadId), rank: i + 1 })));
      return { memories: results.map((result) => serializeEntry(result.entry, deps)) };
    }
  };
}

function readTool(deps: MemoryToolDeps): ToolDefinition<z.infer<typeof readParams>, unknown> {
  return {
    name: "memory_read",
    description:
      "Read one memory or task record by id, a project's whole brief with its recent task records, or the user brief. "
      + "Set target to say which; only that target's field is read.",
    parameters: readParams,
    handler: async (args, ctx) => {
      const now = deps.now?.() ?? Date.now();
      if (args.target === "memory") {
        const id = args.id?.trim();
        if (!id) throw new Error("target \"memory\" needs id");
        const entry = await deps.memory.get(id);
        if (entry) {
          deps.memory.recordUses([{ memoryId: entry.id, kind: "read", threadId: ctx.threadId, agent: usedBy(deps, ctx.threadId) }]);
          return { memory: serializeEntry(entry, deps) };
        }
        // A task record lives beside its worker's plan, under the id lists show.
        const record = deps.records.getById(id);
        if (!record) throw new Error(`memory not found: ${id}`);
        return { memory: serializeRecord(record, deps, now) };
      }
      if (args.target === "project") {
        const name = args.project?.trim();
        if (!name) throw new Error("target \"project\" needs project");
        const project = requireProject(name, deps);
        const brief = deps.memory.getBrief("project", project.id);
        const tasks = deps.records.recent(project.id, { limit: 5 });
        return {
          project: project.name,
          brief: brief?.content ?? null,
          built: brief ? describeAge(brief.builtAt, now) : null,
          recentTasks: tasks.map((task) => ({
            id: task.id,
            written: describeAge(task.updatedAt, now),
            firstLine: task.firstLine
          }))
        };
      }
      const brief = deps.memory.getBrief("user", null);
      return { brief: brief?.content ?? null, built: brief ? describeAge(brief.builtAt, now) : null };
    }
  };
}

function rememberTool(deps: MemoryToolDeps): ToolDefinition<z.infer<typeof rememberParams>, { memory: unknown }> {
  return {
    name: "memory_remember",
    description:
      "Remember one durable thing for future conversations. When the user asks you to remember something, pass their words as userQuote. "
      + "Do not remember what the project's files or their history already show, temporary state, or one-off details of the current task.",
    parameters: rememberParams,
    handler: async (args, ctx) => {
      const projectId = args.scope === "project" ? projectForWrite(args.project, ctx, deps).id : null;
      const quote = await checkedQuote(args.userQuote, ctx, deps);
      const entry = await deps.memory.remember({
        scope: args.scope,
        projectId,
        workerId: ctx.worker?.id ?? null,
        type: args.type,
        source: quote ? "user" : "agent",
        userQuote: quote?.quote ?? null,
        content: args.content,
        sourceThreadId: ctx.threadId,
        // The dream orders the user's statements by when they were said.
        ...(quote ? { metadata: { statedAt: quote.saidAt } } : {})
      });
      return { memory: serializeEntry(entry, deps) };
    }
  };
}

function updateTool(deps: MemoryToolDeps): ToolDefinition<z.infer<typeof updateParams>, { memory: unknown }> {
  return {
    name: "memory_update",
    description:
      "Correct a memory in place, for example when the user changes their mind. Pass the user's words as userQuote when the correction is theirs.",
    parameters: updateParams,
    handler: async (args, ctx) => {
      refuseRecord(args.id, deps, "changed");
      const entry = await deps.memory.get(args.id);
      if (!entry) throw new Error(`memory not found: ${args.id}`);
      refuseUnwritable(entry, "changed");
      refuseOtherProject(entry, ctx, deps, "changes");
      const quote = await checkedQuote(args.userQuote, ctx, deps);
      // Written only at the version read above: the checks were made on it,
      // and a change since (the dream's merge, or another conversation's
      // correction) is not overwritten unseen.
      const updated = await deps.memory.writeIfUnchanged([entry], (tx) => tx.update({
        id: entry.id,
        content: args.content,
        // The dream orders the user's statements by when they were said.
        ...(quote
          ? { source: "user" as const, userQuote: quote.quote, sourceThreadId: ctx.threadId, sourceMessageId: null, metadata: { ...(entry.metadata ?? {}), statedAt: quote.saidAt } }
          // Changed without their words, a memory of the user's is the
          // agent's now: their old words never stand beside text they did not say.
          : entry.source === "user" ? { source: "agent" as const, metadata: withoutStatedAt(entry.metadata) } : {})
      }));
      if (!updated) return refuseChanged(entry.id, "changed", deps);
      return { memory: serializeEntry(updated, deps) };
    }
  };
}

function forgetTool(deps: MemoryToolDeps): ToolDefinition<z.infer<typeof forgetParams>, { memory: unknown }> {
  return {
    name: "memory_forget",
    description: "Forget a memory when the user asks you to, or when it has proved wrong. It is archived with the reason.",
    parameters: forgetParams,
    handler: async (args, ctx) => {
      refuseRecord(args.id, deps, "forgotten");
      const entry = await deps.memory.get(args.id);
      if (!entry) throw new Error(`memory not found: ${args.id}`);
      refuseUnwritable(entry, "forgotten");
      refuseOtherProject(entry, ctx, deps, "forgets");
      const archived = await deps.memory.writeIfUnchanged([entry], (tx) => tx.archive(entry.id, {
        forgottenReason: args.reason,
        forgottenByThreadId: ctx.threadId
      }));
      if (!archived) return refuseChanged(entry.id, "forgotten", deps);
      return { memory: serializeEntry(archived, deps) };
    }
  };
}

/** A task record is a worker's history: nothing changes or forgets it. */
function refuseRecord(id: string, deps: MemoryToolDeps, verb: "changed" | "forgotten"): void {
  if (deps.records.getById(id.trim())) throw new Error(`Task records are history and cannot be ${verb}.`);
}

function refuseUnwritable(entry: MemoryEntry, verb: "changed" | "forgotten"): void {
  if (entry.status === "archived") {
    const act = verb === "changed" ? "update" : "forget";
    const mergedInto = typeof entry.metadata?.mergedInto === "string" ? entry.metadata.mergedInto : null;
    const splitInto = Array.isArray(entry.metadata?.splitInto) ? entry.metadata.splitInto.filter((id): id is string => typeof id === "string") : [];
    throw new Error(mergedInto
      ? `memory ${entry.id} was merged into ${mergedInto}; ${act} that one.`
      : splitInto.length > 0
        ? `memory ${entry.id} was split into ${splitInto.join(", ")}; ${act} those.`
        : `memory ${entry.id} is archived.`);
  }
}

/** The write found the memory changed since it was read: archived (the
 *  dream's merge or split, another forget) says where it went; any other
 *  change asks for a fresh read. */
async function refuseChanged(id: string, verb: "changed" | "forgotten", deps: MemoryToolDeps): Promise<never> {
  const current = await deps.memory.get(id);
  if (!current) throw new Error(`memory not found: ${id}`);
  refuseUnwritable(current, verb);
  throw new Error(`memory ${id} changed since you read it: read it again with memory_read, then decide.`);
}

/** A worker writes project memories of its own project only;
 *  the user's memories it may change like any agent. */
function refuseOtherProject(entry: MemoryEntry, ctx: ToolContext, deps: MemoryToolDeps, verb: "changes" | "forgets"): void {
  if (deps.scope !== "worker" || entry.scope !== "project") return;
  const own = ctx.project ?? null;
  if (entry.projectId !== own?.id) {
    throw new Error(`A worker ${verb} project memories of its own project (${own?.name ?? "none"}) only.`);
  }
}

/** The realtime API can send a tool call before the transcript of the speech
 *  it answers, so a spoken call waits for the words to reach the thread. */
const SPOKEN_QUOTE_WAIT_MS = 5000;

/** The user's words, checked against this thread, and when they said them:
 *  a memory of their words is dated by their message. */
async function checkedQuote(quote: string | undefined, ctx: ToolContext, deps: MemoryToolDeps): Promise<{ quote: string; saidAt: string } | null> {
  if (quote === undefined) return null;
  const spoken = ctx.wakeId === VOICE_TOOL_WAKE_ID;
  const askedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
  const matches = quoteMatcher(quote);
  // Read from the newest message back, stopping at the match; asked again
  // (a spoken quote waiting for its transcript), only what came since.
  let readTo = 0;
  const said = () => {
    if (!matches) return null;
    const found = deps.agentStore.newestUserStatement(ctx.threadId, matches, readTo);
    readTo = found.newestSeq;
    return found.said?.at ?? null;
  };
  let latest = said();
  if (latest === null && spoken) {
    const deadline = Date.now() + (deps.quoteWaitMs ?? SPOKEN_QUOTE_WAIT_MS);
    while (latest === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      latest = said();
    }
  }
  // A spoken call answers what the user is saying now, even when an earlier
  // message holds the same words and this utterance's transcript is still on
  // its way: it is dated no earlier than the call.
  const saidAt = latest !== null && spoken && askedAt > latest ? askedAt : latest;
  if (saidAt === null) {
    throw new Error(
      `Those words are not in the user's messages in this conversation (at least ${MIN_USER_QUOTE_CHARS} characters, as they wrote them). `
      + "Pass the user's exact words, or save without userQuote."
    );
  }
  return { quote: quote.trim(), saidAt };
}

function projectForWrite(ref: string | undefined, ctx: ToolContext, deps: MemoryToolDeps): ProjectRow {
  if (deps.scope === "worker") {
    const own = ctx.project ?? null;
    if (!own) throw new Error("This worker has no project.");
    if (ref !== undefined) {
      const named = findProject(ref, deps);
      if (named?.id !== own.id) throw new Error(`A worker writes project memories to its own project (${own.name}) only.`);
    }
    return own;
  }
  if (ref === undefined) throw new Error(`Name the project. Projects: ${projectNames(deps)}.`);
  return requireProject(ref, deps);
}

function requireProject(ref: string, deps: MemoryToolDeps): ProjectRow {
  const project = findProject(ref, deps);
  if (!project) throw new Error(`No active project named ${ref}. Projects: ${projectNames(deps)}.`);
  return project;
}

/** An id or a name as written first; a name differing only in case is
 *  accepted when it matches one project, since names are unique only as written. */
function findProject(ref: string, deps: MemoryToolDeps): ProjectRow | null {
  const wanted = ref.trim();
  const active = deps.projectsStore.listActive();
  const exact = active.find((p) => p.id === wanted || p.name === wanted);
  if (exact) return exact;
  const byCase = active.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (byCase.length > 1) {
    throw new Error(`${wanted} matches more than one project: ${byCase.map((p) => p.name).join(", ")}. Name it exactly.`);
  }
  return byCase[0] ?? null;
}

function projectNames(deps: MemoryToolDeps): string {
  return deps.projectsStore.listActive().map((p) => p.name).join(", ");
}

/** A task record as memory_read gives it: whole, with its worker and project. */
function serializeRecord(record: WorkerRecord, deps: MemoryToolDeps, now: number) {
  return {
    id: record.id,
    type: "task" as const,
    scope: "project" as const,
    project: deps.projectsStore.getById(record.projectId)?.name ?? record.projectId,
    worker: record.workerName,
    updated: describeAge(record.updatedAt, now),
    content: record.content
  };
}

function serializeEntry(entry: MemoryEntry, deps: MemoryToolDeps) {
  const mergedInto = typeof entry.metadata?.mergedInto === "string" ? entry.metadata.mergedInto : null;
  return {
    id: entry.id,
    type: entry.type,
    scope: entry.scope,
    ...(entry.projectId ? { project: deps.projectsStore.getById(entry.projectId)?.name ?? entry.projectId } : {}),
    source: entry.source,
    ...(entry.userQuote ? { userQuote: entry.userQuote } : {}),
    status: entry.status,
    written: describeAge(entry.updatedAt, deps.now?.() ?? Date.now()),
    content: entry.content,
    ...(mergedInto ? { mergedInto } : {})
  };
}
