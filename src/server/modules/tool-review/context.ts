import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "../../config.js";
import { logError } from "../../platform/logger.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentScope } from "../agent/tool-scope.js";
import type { ToolCallSpec } from "../agent/wake-loop.js";
import { resolveArchiveWorkerCleanup } from "../workers/worker-service.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { HandoffStore } from "../personal/handoff-store.js";

/**
 * What the tool-call review reads about one call. Mandate assembles it from
 * storage, never from the agent's own (possibly compacted) window: the
 * user's own words in each thread of the call's delegation chain, what
 * agents passed down labelled as theirs, facts from the host, and the calls.
 * Every item is one JSON line, so nothing an agent wrote can pose as a line
 * of the user's or as a heading.
 *
 * `full` is the second look's; `trimmed` the screen's: the user's rules, the
 * host facts and the calls, without the conversation (in the eval the screen
 * read the rules far better without it).
 */
export interface ReviewContextInput {
  threadId: string;
  scope: AgentScope;
  call: ToolCallSpec;
  /** Every call of the step, the judged one among them. */
  stepCalls: ToolCallSpec[];
  /** When the step was made: only what was written before it is read. */
  at: string;
}

/** A call the review held back earlier, with the reason it gave the agent. */
export interface HeldCall {
  call: ToolCallSpec;
  reason: string;
  at: string;
}

export interface ReviewContextDeps {
  agentStore: AgentStore;
  workers: WorkersStore;
  handoffs: HandoffStore;
  config: () => Config;
  /** The foreground program and last visible lines of a pane, when known. */
  paneFacts(paneId: string): Promise<{ program: string | null; lastLines: string } | null>;
  /** Decisions the user saved in their own words that bear on the call,
   *  their own and the call's project's (the second look only). */
  savedQuotes?(call: ToolCallSpec, projectId: string | null): Promise<string[]>;
  /** The thread's recent holds, newest last. */
  recentHolds?(threadId: string): Promise<HeldCall[]>;
  /** The conversation a subagent's thread works for. */
  parentThreadOf?(threadId: string): string | null;
}

const USER_WORD_LINES = 14;
const AGENT_TEXTS = 6;
const TEXT_MAX = 1500;
const RECENT_CALLS = 5;
const CALL_MAX = 600;
const JUDGED_CALL_MAX = 4000;
const HOLDS = 3;
/** How many rows each source gives before the merge (as evaluated). */
const OWN_WORDS_PER_THREAD = 8;
const WORDS_BEFORE_HANDOFF = 6;
const RELAYS = 4;
const MANAGER_TEXTS = 4;
/** Quotes marked per agent text, and how much of each is shown. */
const QUOTES = 5;
const QUOTE_MAX = 300;
/** A stored name or path shown among the host facts, and how many projects. */
const FACT_MAX = 300;
const PROJECTS = 10;

interface Word {
  at: string | null;
  where: string;
  text: string;
}

interface Passed {
  at: string;
  author: string;
  text: string;
}

/** What the review reads: the screen's trimmed context, and the second
 *  look's full one, built when it is first asked for (only a flagged call's
 *  is): the user's saved decisions are looked up then. */
export interface ReviewContext {
  trimmed: string;
  full: () => Promise<string>;
}

export async function buildReviewContext(input: ReviewContextInput, deps: ReviewContextDeps): Promise<ReviewContext> {
  const config = deps.config();
  const standing: Word[] = [
    ...(config.agent.toolReviewRules ? [{ at: null, where: "their rules for the tool-call review", text: config.agent.toolReviewRules }] : []),
    ...(config.agent.preferences ? [{ at: null, where: "their Delegation preferences", text: config.agent.preferences }] : [])
  ];
  const { words, passed } = delegationChain(input, deps);
  const facts = await hostFacts(input, deps);
  const holds = ((await deps.recentHolds?.(input.threadId)) ?? []).filter((held) => held.at < input.at).slice(-HOLDS);
  // The step's own row is stored before it is reviewed: its calls are this
  // step's, not ones made before it.
  // Its row may hold calls cut from it too, never reviewed nor run: the
  // whole row is the step's.
  const inStep = new Set(input.stepCalls.map((call) => call.toolCallId));
  const stored = deps.agentStore.toolCallsBefore(input.threadId, input.at, RECENT_CALLS + 1);
  // The newest row holding one of them: an id an earlier step used again
  // leaves that step in view.
  const stepRow = stored.filter((call) => inStep.has(call.toolCallId)).at(-1)?.messageId ?? null;
  const recent = stored.filter((call) => call.messageId !== stepRow).slice(-RECENT_CALLS);
  const others = input.stepCalls.filter((call) => call.toolCallId !== input.call.toolCallId);

  const buildFull = async (): Promise<string> => {
    const saved: Word[] = (await savedWords(input, deps)).map((text) => ({ at: null, where: "a decision they saved", text }));
    const userWords = [...standing, ...newestFirstUnique(words).slice(0, USER_WORD_LINES), ...saved];
    // A quote counts when one statement of the user's holds it as whole words,
    // never a run across two of them nor a piece of a longer word.
    const said = userWords.map((word) => wordsOf(word.text));
    return [
      "# The user's own words (from storage; newest first)",
      ...linesOr(userWords.map(wordLine), "(none in the threads of this call's chain)"),
      "# Written by agents and passed down — not the user's words",
      ...linesOr(passed.slice(0, AGENT_TEXTS).map((item) => passedLine(item, said)), "(none)"),
      "# Facts from the host",
      ...facts,
      ...(holds.length > 0 ? [
        "# Calls held earlier in this thread — held by the review, not the user's words",
        ...holds.map((held) => JSON.stringify({ at: held.at.slice(0, 16), ...callFields(held.call, CALL_MAX), reason: clip(held.reason, TEXT_MAX) }))
      ] : []),
      "# This thread's last calls before this step (no output)",
      ...linesOr(recent.map((call) => JSON.stringify(callFields(call, CALL_MAX))), "(none)"),
      "# Other calls in the same step",
      ...linesOr(others.map((call) => JSON.stringify(callFields(call, CALL_MAX))), "(none)"),
      "# The call to judge",
      JSON.stringify(callFields(input.call, JUDGED_CALL_MAX))
    ].join("\n");
  };
  let full: Promise<string> | null = null;

  const rules = standing.filter((word) => word.where === "their rules for the tool-call review");
  const trimmed = [
    "# The user's own words (from storage; newest first)",
    ...linesOr(rules.map(wordLine), "(no rules of their own)"),
    "# Facts from the host",
    ...facts,
    "# Other calls in the same step",
    ...linesOr(others.map((call) => JSON.stringify(callFields(call, CALL_MAX))), "(none)"),
    "# The call to judge",
    JSON.stringify(callFields(input.call, JUDGED_CALL_MAX))
  ].join("\n");

  return { trimmed, full: () => (full ??= buildFull()) };
}

/** The decisions the user saved that bear on the call; none when the lookup
 *  fails (the second look goes on without them). */
async function savedWords(input: ReviewContextInput, deps: ReviewContextDeps): Promise<string[]> {
  try {
    return (await deps.savedQuotes?.(input.call, projectOf(input, deps))) ?? [];
  } catch (err) {
    logError("tool-call review: the user's saved decisions", err);
    return [];
  }
}

/** The user's words and the agents' texts along the call's chain: the
 *  thread (for a subagent, the conversation it works for); for a worker,
 *  its manager's thread and the manager's messages to it; and in either,
 *  what the personal agent relayed in, with what the user said to the personal agent before
 *  each such handoff. A handoff counts by its message: one that only waits,
 *  or was not delivered before the step, delegated nothing. */
function delegationChain(input: ReviewContextInput, deps: ReviewContextDeps): { words: Word[]; passed: Passed[] } {
  const { agentStore, workers, handoffs } = deps;
  const words: Word[] = [];
  const passed: Passed[] = [];
  const thread = agentStore.getThreadById(input.threadId);
  const parentId = thread?.scope === "subagent" ? deps.parentThreadOf?.(input.threadId) ?? null : null;
  const conversation = (parentId ? agentStore.getThreadById(parentId) : null) ?? thread;
  if (!conversation) return { words, passed };
  const at = input.at;
  const own = (threadId: string, where: string, before = at, limit = OWN_WORDS_PER_THREAD) => {
    for (const row of agentStore.textsBefore(threadId, "own", before, limit)) words.push({ at: row.at, where, text: row.text });
  };
  own(conversation.id, parentId ? "the conversation this subagent works for" : "this thread");

  const managerId = conversation.scope === "manager" ? conversation.id
    : conversation.scope === "worker" && conversation.scopeId ? workers.getById(conversation.scopeId)?.ownerThreadId ?? null
      : null;
  if (managerId && managerId !== conversation.id) own(managerId, "the manager's thread");
  const relayedInto = (threadId: string, author: string) => {
    for (const row of agentStore.textsBefore(threadId, "relayed", at, RELAYS)) {
      passed.push({ at: row.at, author, text: row.text });
      const handoff = row.handoffId ? handoffs.get(row.handoffId) : null;
      if (handoff) own(handoff.personalThreadId, "The personal agent's thread, before that handoff", handoff.createdAt, WORDS_BEFORE_HANDOFF);
    }
  };
  if (managerId) relayedInto(managerId, "The personal agent (relayed into the manager's thread)");
  if (conversation.scope === "worker") relayedInto(conversation.id, "The personal agent (relayed into this worker's thread)");
  if (conversation.scope === "worker") {
    for (const row of agentStore.textsBefore(conversation.id, "manager", at, MANAGER_TEXTS)) {
      passed.push({ at: row.at, author: "the manager → this worker", text: row.text });
    }
  }
  passed.sort((a, b) => b.at.localeCompare(a.at));
  return { words, passed };
}

async function hostFacts(input: ReviewContextInput, deps: ReviewContextDeps): Promise<string[]> {
  const thread = deps.agentStore.getThreadById(input.threadId);
  const facts: Record<string, unknown> = { scope: thread?.scope === "personal" ? "personal agent" : thread?.scope ?? input.scope.kind };
  if (thread?.title) facts.thread = clip(thread.title, FACT_MAX);
  // A subagent works in the conversation it works for: its branch is that worker's.
  const parentId = thread?.scope === "subagent" ? deps.parentThreadOf?.(input.threadId) ?? null : null;
  const conversation = (parentId ? deps.agentStore.getThreadById(parentId) : null) ?? thread;
  if (input.scope.kind === "worker") {
    facts.workspace = clip(input.scope.worker.workingDir ?? input.scope.project.workingDir, FACT_MAX);
    const worker = conversation?.scope === "worker" && conversation.scopeId ? deps.workers.getById(conversation.scopeId) : null;
    if (worker?.branch) facts.branch = clip(worker.branch, FACT_MAX);
  } else {
    facts.projects = input.scope.projectWorkingDirs.slice(0, PROJECTS).map((dir) => clip(dir, FACT_MAX));
  }
  const lines = [JSON.stringify(facts)];
  const args = isObject(input.call.args) ? input.call.args : {};
  switch (input.call.toolName) {
    case "send_keys": {
      const pane = typeof args.paneId === "string" ? await deps.paneFacts(args.paneId) : null;
      if (pane) {
        lines.push(JSON.stringify({
          "target pane's foreground program": pane.program === null ? null : clip(pane.program, FACT_MAX),
          // Its last lines: the question the keys answer is at the bottom.
          "target pane's last visible lines (untrusted screen text)": clipStart(pane.lastLines, TEXT_MAX)
        }));
      }
      break;
    }
    case "write":
    case "edit": {
      if (typeof args.path === "string") {
        const base = input.scope.kind === "worker" ? input.scope.worker.workingDir ?? input.scope.project.workingDir : input.scope.managerDir;
        const target = path.resolve(base, args.path);
        lines.push(JSON.stringify({ "target path": clip(target, FACT_MAX), exists: fs.existsSync(target) }));
      }
      break;
    }
    case "archive_worker": {
      const worker = typeof args.workerId === "string" ? deps.workers.getById(args.workerId) : null;
      if (worker) {
        const cleanup = resolveArchiveWorkerCleanup(worker, { cleanup: args });
        lines.push(JSON.stringify({
          "archives the worker": clip(worker.name, FACT_MAX),
          "removes its worktree": cleanup.removeWorktree && worker.worktreePath ? clip(worker.worktreePath, FACT_MAX) : null,
          "deletes its branch": cleanup.deleteBranch && worker.branch ? clip(worker.branch, FACT_MAX) : null,
          ...(cleanup.forceRemoveWorktree || cleanup.forceDeleteBranch ? { "with force": true } : {})
        }));
      }
      break;
    }
    case "archive_project":
      lines.push(JSON.stringify({ "archives the project": typeof args.projectId === "string" ? clip(args.projectId, FACT_MAX) : null, "kills its tmux session": args.killTmux === true }));
      break;
  }
  return lines;
}

function wordLine(word: Word): string {
  return JSON.stringify({ ...(word.at ? { at: word.at.slice(0, 16) } : {}), where: word.where, text: clip(word.text, TEXT_MAX) });
}

/** An agent's text, with each span it quotes marked by whether the user's
 *  own words hold it: that mark is what makes a relayed "the user agreed"
 *  count, never the agent's say-so. */
function passedLine(item: Passed, said: ReadonlyArray<readonly string[]>): string {
  const quotes = quotedSpans(item.text).slice(0, QUOTES).map((words) => {
    const quote = wordsOf(words, "trim");
    return { words: clip(words, QUOTE_MAX), "in the user's own words": said.some((statement) => holdsInOrder(statement, quote)) };
  });
  return JSON.stringify({ at: item.at.slice(0, 16), author: item.author, text: clip(item.text, TEXT_MAX), ...(quotes.length > 0 ? { quotes } : {}) });
}

const QUOTED = /“([^”]+)”|"([^"]+)"|「([^」]+)」|『([^』]+)』/g;

function quotedSpans(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((match) => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim()).filter(Boolean);
}

/** Text compared for a quote: whitespace collapsed, every quote mark the
 *  same one. The marks stay: `rm "a b"` names one file, `rm a b` two. */
function normalizeQuote(text: string): string {
  return text.replace(/[“”「」『』]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

/** Word boundaries as the platform finds them, in any script (Chinese and
 *  Japanese have no spaces between words). */
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

/** A text's words with the punctuation and the (collapsed) spaces between
 *  them: `/tmp/cache-prod` is not `/tmp/cache/prod`, nor `cache-rf` `cache
 *  -rf`. A quote drops what stands at its edges ("ok!" is "ok"). */
function wordsOf(text: string, edges: "keep" | "trim" = "keep"): string[] {
  const parts = [...WORDS.segment(normalizeQuote(text))];
  if (edges === "trim") {
    while (parts.length > 0 && !parts[0]!.isWordLike) parts.shift();
    while (parts.length > 0 && !parts.at(-1)!.isWordLike) parts.pop();
  }
  return parts.map((part) => part.segment);
}

/** `quote`'s words appear in `statement`, next to each other and in order. */
function holdsInOrder(statement: readonly string[], quote: readonly string[]): boolean {
  if (quote.length === 0) return false;
  for (let i = 0; i + quote.length <= statement.length; i++) {
    if (quote.every((word, j) => statement[i + j] === word)) return true;
  }
  return false;
}

function newestFirstUnique(words: Word[]): Word[] {
  const seen = new Set<string>();
  return [...words]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .filter((word) => (seen.has(word.text) ? false : (seen.add(word.text), true)));
}

/** A call as data; arguments too long for the line become their clipped JSON text. */
function callFields(call: { toolName: string; args: unknown }, max: number): { tool: string; args: unknown } {
  const text = JSON.stringify(call.args) ?? "null";
  return { tool: clip(call.toolName, FACT_MAX), args: text.length <= max ? call.args : clip(text, max) };
}

function linesOr(lines: string[], empty: string): string[] {
  return lines.length > 0 ? lines : [empty];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

/** The end of a text, for one whose last part matters most. */
function clipStart(text: string, max: number): string {
  return text.length <= max ? text : `[${text.length - max} earlier chars] …${text.slice(-max)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The project a call works in: a worker's (a subagent's, its worker's);
 *  none for a manager or the personal agent, whose work spans projects. */
function projectOf(input: ReviewContextInput, deps: ReviewContextDeps): string | null {
  const thread = deps.agentStore.getThreadById(deps.parentThreadOf?.(input.threadId) ?? input.threadId);
  if (thread?.scope !== "worker" || !thread.scopeId) return null;
  return deps.workers.getById(thread.scopeId)?.projectId ?? null;
}
