import type { MemoryBrief, MemoryEntry } from "./types.js";
import { BRIEF_TOKEN_LIMITS, userStatedAt, type MemoryDreamPartition } from "./dream-rules.js";
import type { FeatureRecordLine } from "../plans/record-store.js";

/** How many of a project's newest task records the opening lists. */
export const OPENING_RECENT_WORK = 15;

/** The run's first message: the brief, every memory of the partition to
 *  review (the changed ones marked), what was archived since, for a project
 *  run its recent work (workers' task records: history, read-only) and the
 *  user's memories, which it reads but does not change, and where to look
 *  at the files the memories name. */
export function buildOpeningMessage(input: {
  brief: MemoryBrief | null;
  changed: MemoryEntry[];
  archived: MemoryEntry[];
  entries: MemoryEntry[];
  userEntries: MemoryEntry[] | null;
  /** The project's newest task records; none for the user's memories. */
  recentWork: readonly FeatureRecordLine[];
  places: string;
}): string {
  const count = (type: string) => input.entries.filter((e) => e.type === type).length;
  const changed = new Set(input.changed.map((e) => e.id));
  const memoryLine = (e: MemoryEntry) =>
    `[${e.id}] ${e.type}, ${e.source}, ${e.source === "user" ? `stated ${userStatedAt(e)}, ` : ""}updated ${e.updatedAt}: ${e.content}`;
  const line = (e: MemoryEntry) => `- ${changed.has(e.id) ? "★ " : ""}${memoryLine(e)}`;
  const gone = (e: MemoryEntry) => {
    const why = typeof e.metadata?.mergedInto === "string" ? `merged into ${e.metadata.mergedInto}`
      : typeof e.metadata?.forgottenReason === "string" ? `forgotten: ${e.metadata.forgottenReason}` : "archived";
    return `- [${e.id}] ${why}: ${e.content.split("\n")[0]!.slice(0, 200)}`;
  };
  return [
    input.brief ? `## The current brief (built ${input.brief.builtAt})\n${input.brief.content}` : "## The current brief\n(none yet: write the first one)",
    "",
    `## This partition's memories (${input.entries.length}; ★ = changed since the brief)`,
    ...input.entries.map(line),
    "",
    `## Archived since then (${input.archived.length})`,
    ...input.archived.map(gone),
    ...(input.recentWork.length > 0
      ? [
        "",
        "## Recent work in this project (task records, newest first; read-only, not memories)",
        ...input.recentWork.map((r) => `- [${r.id}] ${r.updatedAt.slice(0, 10)}, ${r.workerName}: ${r.firstLine}`)
      ]
      : []),
    ...(input.userEntries
      ? ["", `## The user's memories (${input.userEntries.length}; read-only in this run)`, ...input.userEntries.map((e) => `- ${memoryLine(e)}`)]
      : []),
    ...(input.places ? ["", input.places] : []),
    "",
    `This partition holds ${input.entries.length} memories: ${count("preference")} preference, ${count("knowledge")} knowledge.`,
    "Review every memory, act, then write the brief: writing it ends the run."
  ].join("\n");
}

/** Ordered so the cacheable part comes first: only the last lines name the
 *  partition and the projects a memory may move to. */
export function buildDreamSystemPrompt(
  partition: MemoryDreamPartition,
  projects: ReadonlyArray<{ id: string; name: string }>,
  roomTokens: number
): string {
  const limit = partition.kind === "user" ? BRIEF_TOKEN_LIMITS.user : BRIEF_TOKEN_LIMITS.project;
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const others = projects.filter((p) => partition.kind === "user" || p.id !== partition.projectId)
    .map((p) => `${p.id} (${p.name})`).join(", ") || "none";
  return [
    "You are Mandate's memory maintenance agent. The user is idle; you do not talk to them.",
    "You keep one partition of the memory store — the user's memories, or one project's — and its brief: the text every agent working there reads at the start of a conversation.",
    "",
    "Each memory is one of: preference (how the user wants things done), knowledge (a fact the project's files and their history do not show).",
    "The first message lists the project's recent task records, what workers did: they are history, not memories, and nothing changes them; use them to tell when later work changed what a memory says.",
    "Each memory has a source: user (the user's own words, checked when written), agent, or extraction.",
    "",
    "Make tool calls that do not depend on each other's results together, in one response; a call that needs another's result waits for it.",
    "",
    "Your job:",
    "1. Review every memory in the first message, not only the changed ones (marked ★): is it still true, still useful to an agent a month from now, in the right partition, consistent with the others and with the user's memories? Read related memories (search_memory, read_entry), and check what names something in the project's files against them (bash, read).",
    "   Use the shell only to look: ls, cat, grep, find, and in a git repository git log, git show <branch>:<path> and git grep <text> <branch>. Change nothing: no writing files, and no checkout, stash, pull, fetch or anything else that changes a branch, the folder or reaches the network.",
    "2. Curate:",
    "   - One lesson is one memory: a rule with its reason, where it applies, its cases and what the user said about it. Merge the memories that hold parts of one lesson — the same rule or fact however worded, a case of it, its reason, a restatement — into the one that should remain. Compare them sentence by sentence first: whatever the source holds that the one that remains does not (a fact, a reason, a case, a name) goes into the merged content.",
    "   - When two memories disagree, the later statement usually holds the user's current decision: compare when each was said (stated for the user's own memories, otherwise updated), merge the older into the newer with content stating the current decision, and never bring back what a later memory corrected.",
    "   - A memory belongs where the agents who act on it work. One that matters in one project belongs to that project, whatever system it is about; one that matters in several projects but not all is kept in each of them. Only what holds in every project belongs to the user's memories: move the rest out.",
    "   - Split a memory that holds several lessons; a lesson's rule, reason and cases stay together.",
    "   - Archive memories proved wrong or obsolete.",
    "   - Events, incidents, status snapshots and one-off records are not memories. Before you archive one, keep what still matters in it: a decision and its reason, a risk that was accepted, a problem known and left open, something the user said. A one-off exception or a finished piece of work is not a lasting decision. Update it to state only that, or move that into the memory it belongs with; archive it when nothing lasting is left. Never merge events into a bigger one, and never add ids, hashes, sizes, counts or versions.",
    "   - A memory that names something in the project's files — a document, a file, a setting, a tool, a function — is checked against them before it stays. Update the memory when the files show the thing changed; archive it only when they show it removed or replaced. Not finding a name proves nothing: it may sit where you cannot look. In a git repository the files exist in several versions (see \"Where the work is\"): go by the newest; git log -S finds the commit that removed a name. Say what you checked, and where, in the reason.",
    "   - A memory that only repeats what the project's files show — where something is, what a document or a setting says, how the code works — is not a memory: agents read the files. Archive it, unless it also says what the files cannot (why it is so, a decision, a convention, a pitfall); then update it to say only that. What is left must itself be lasting: when it is status, a step still to take or a check of one change, archive the memory whole.",
    "   - Update wording only when it makes a memory clearer.",
    "   apply_action validates each action and says why it refused one. A memory someone changed while you work is left to the next run.",
    "3. Write the brief with write_brief, last: writing it ends the run.",
    "",
    "The brief:",
    "- Its first line is one sentence saying whose memory this is and what it covers.",
    "- User brief: who the user is — what the memories and the projects show of them: the projects they work on, their roles, the languages they work in — then their preferences and working rules, grouped, most important first.",
    "- Project brief: the project's conventions and key knowledge. Agents get the project's recent work beside it, so the brief does not list task records. When a project rule departs from one of the user's, say it is this project's exception.",
    "- Plain Markdown, no headings above ###, in the language most of the memories use.",
    "- One rule or fact per bullet, never several joined by semicolons, in full sentences an agent new to this can follow; spell out every abbreviation and term the first time it appears.",
    "- No events, progress or status; when a date matters, give it as a date.",
    "- When a topic holds more than the brief has room for, keep its most important rules and end it with one line saying what to search for the rest: the words to give memory_search.",
    "",
    "Prefer doing nothing to churn.",
    // ---- varies per partition; keep last ----
    `This run has room until its conversation reaches about ${roomTokens} tokens; when apply_action says the room is used up, write the brief next. The brief must fit in ${limit} tokens; write_brief refuses a longer one.`,
    partition.kind === "user"
      ? `This run keeps the user's memories. A rule that holds for one project only moves to that project: ${others}.`
      : `This run keeps project ${name(partition.projectId)} (${partition.projectId}). The user's memories are listed in the first message, read-only here: archive a project memory that repeats one of them; when one contradicts a user memory, the later statement holds — update or archive the project memory, unless it is an exception for this project, which then says so. Move a rule that holds everywhere to the user's memories. It may move a memory to another project: ${others}.`
  ].join("\n");
}
