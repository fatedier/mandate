import { afterEach, expect, test } from "bun:test";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { extractFromWindow, type ExtractionWorker } from "../src/server/modules/memory/extraction.js";
import { estimateTextTokens } from "../src/server/modules/agent/compression.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import type { MemoryRememberInput } from "../src/server/modules/memory/types.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";

// Memory merge at write: extraction reads the memories written or changed in
// the last 48 hours in the scopes it may write to, so it does not write them
// again, and rewrites one of them when the window adds to it.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const said = (text: string) => stub<AgentMessage>({ id: "m_1", threadId: "thr_1", role: "user", source: "user", seq: 1, createdAt: hoursAgo(0.5), content: { type: "text", text } });
const HEADING = "### Memories written or changed in the last 48 hours, newest first";

function setup() {
  env = freshStoresEnv("md-merge-at-write-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const project4 = seedProject(env.projects, { name: "project-4", tmuxSessionName: "md-project-4" });
  /** A memory as it was written `age` hours before NOW. */
  const store = async (age: number, input: Partial<MemoryRememberInput> & { content: string }) => {
    const entry = await memory.remember({ scope: "project", projectId: project1, type: "knowledge", source: "extraction", ...input });
    env!.store.db.prepare("update memory_entries set updated_at = ?, created_at = ? where id = ?").run(hoursAgo(age), hoursAgo(age), entry.id);
    return (await memory.get(entry.id))!;
  };
  const projects = [{ id: project1, name: "project-1" }, { id: project4, name: "project-4" }];
  return { memory, project1, project4, projects, store };
}

function extract(t: ReturnType<typeof setup>, opts: {
  worker?: ExtractionWorker | null;
  projects?: Array<{ id: string; name: string }>;
  answer?: unknown;
  messages?: AgentMessage[];
  /** Runs while the model answers, before its answer comes back. */
  meanwhile?: () => Promise<unknown>;
} = {}) {
  const model = createMockLLM([{ text: JSON.stringify(opts.answer ?? { entries: [] }) }]);
  if (opts.meanwhile) {
    const answer = model.doStream.bind(model);
    model.doStream = async (call) => { await opts.meanwhile!(); return answer(call); };
  }
  const result = extractFromWindow({
    memory: t.memory, records: new FeatureRecordStore(env!.store.db), candidates: [{ model, provider: "openai", supportsReasoning: undefined }], repeatCheck: [],
    trigger: "compression", threadId: "thr_1", messages: opts.messages ?? [said("Notes on project-1")],
    projects: opts.projects ?? t.projects, worker: opts.worker ?? null, budgetTokens: 50_000, now: NOW
  });
  return { model, result };
}

/** The user message extraction was given. */
function promptOf(model: ReturnType<typeof createMockLLM>): string {
  return String((model.streamCalls[0]?.prompt as Array<{ role: string; content: Array<{ text?: string }> }>)
    .find((m) => m.role === "user")!.content.map((part) => part.text ?? "").join(""));
}
/** The recent list's section: its heading and lines, up to the blank line after. */
function recentSection(prompt: string): string | null {
  const at = prompt.indexOf(HEADING);
  if (at < 0) return null;
  const end = prompt.indexOf("\n\n", at);
  return prompt.slice(at, end < 0 ? undefined : end);
}

test("the extraction reads the memories written or changed in the last 48 hours, newest first, with their ids", async () => {
  const t = setup();
  const user = await t.store(1, { scope: "user", projectId: null, type: "preference", content: "Replies stay short." });
  const recent = await t.store(3, { content: "project-1 releases are cut on Fridays." });
  await t.store(49, { content: "project-1 once used a nightly build." });
  await t.store(1, { type: "task", featureId: "feat_other", content: "Release notes: done." });
  await t.store(2, { projectId: t.project4, content: "project-4 deploys from main." });
  const worker = { featureId: "feat_1", projectId: t.project1, name: "Release" };
  const { model, result } = extract(t, { worker, projects: [t.projects[0]!] });
  await result;
  expect(recentSection(promptOf(model))).toBe([
    HEADING,
    `- [${user.id}] preference, user, 2026-10-20 09:00 UTC: Replies stay short.`,
    `- [${recent.id}] knowledge, project project-1, 2026-10-20 07:00 UTC: project-1 releases are cut on Fridays.`
  ].join("\n"));
});

test("a manager's window lists every project it may write to", async () => {
  const t = setup();
  await t.store(1, { scope: "user", projectId: null, type: "preference", content: "Replies stay short." });
  await t.store(3, { content: "project-1 releases are cut on Fridays." });
  const other = await t.store(2, { projectId: t.project4, content: "project-4 deploys from main." });
  const { model, result } = extract(t);
  await result;
  const lines = recentSection(promptOf(model))!.split("\n").slice(1);
  expect(lines.map((line) => line.slice(0, line.indexOf("]") + 1))).toHaveLength(3);
  expect(lines[1]).toBe(`- [${other.id}] knowledge, project project-4, 2026-10-20 08:00 UTC: project-4 deploys from main.`);
});

test("the list stops at 100 memories", async () => {
  const t = setup();
  for (let k = 0; k < 120; k++) await t.store(1 + k / 1000, { content: `project-1 fact ${k}.` });
  const { model, result } = extract(t);
  await result;
  expect(recentSection(promptOf(model))!.split("\n").slice(1)).toHaveLength(100);
});

test("the list stops before about 10,000 tokens", async () => {
  const t = setup();
  for (let k = 0; k < 30; k++) await t.store(1 + k / 100, { content: `project-1 long note ${k}: ${"x".repeat(2000)}` });
  // Older and short: the line that passes the tokens ends the list; nothing after it is picked instead.
  const older = await t.store(2, { content: "project-1 short and older." });
  const { model, result } = extract(t);
  await result;
  const lines = recentSection(promptOf(model))!.split("\n").slice(1);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.length).toBeLessThan(30);
  expect(estimateTextTokens(lines.join("\n"))).toBeLessThanOrEqual(10_000);
  expect(lines.some((line) => line.includes(older.id))).toBe(false);
});

test("with nothing recent there is no list; with no brief either, Already known says nothing yet", async () => {
  const t = setup();
  await t.store(49, { content: "project-1 once used a nightly build." });
  const bare = extract(t);
  await bare.result;
  expect(recentSection(promptOf(bare.model))).toBeNull();
  expect(promptOf(bare.model)).toContain("## Already known\n(nothing yet)");
  t.memory.putBrief({ scope: "project", projectId: t.project1, content: "project-1: its conventions.", inputDigest: "d", builtAt: hoursAgo(5), runId: null });
  const briefed = extract(t);
  await briefed.result;
  expect(recentSection(promptOf(briefed.model))).toBeNull();
  expect(promptOf(briefed.model)).not.toContain("(nothing yet)");
});

// ---- rewriting a listed memory ----

const entry = (projectId: string, content: string, memoryId?: string, extra: Record<string, unknown> = {}) =>
  ({ type: "knowledge", scope: "project", projectId, content, ...(memoryId === undefined ? {} : { memoryId }), ...extra });
const available = (t: ReturnType<typeof setup>) => t.memory.listAvailable({ scope: "project", projectId: t.project1 }).length;

test("an entry naming a listed memory rewrites it in place: same id, the entry's text and type, the old version kept, the extraction named", async () => {
  const t = setup();
  const listed = await t.store(3, { content: "project-1 releases are cut on Fridays.", metadata: { note: "kept" } });
  const before = available(t);
  const { result } = extract(t, { answer: { entries: [{ ...entry(t.project1, "project-1 releases are cut on Fridays, after the code freeze.", listed.id), type: "preference" }] } });
  expect(await result).toMatchObject({ created: 0, updated: 1 });
  const now = (await t.memory.get(listed.id))!;
  expect(now).toMatchObject({ id: listed.id, content: "project-1 releases are cut on Fridays, after the code freeze.", type: "preference", status: "available" });
  expect(now.metadata).toMatchObject({ note: "kept" });
  expect(now.metadata?.previous).toEqual({ content: "project-1 releases are cut on Fridays.", type: "knowledge", source: "extraction", userQuote: null, updatedAt: listed.updatedAt, replacedAt: now.updatedAt, asLearned: true });
  expect(now.metadata).not.toHaveProperty("previousContent");
  expect(String(now.metadata?.updatedByExtraction)).toMatch(/^extract_/);
  expect(available(t)).toBe(before);
});

// The user's words are the strongest evidence a memory has: a rewrite
// without new ones keeps theirs.
test("a rewrite with the user's words in this window is theirs; without them a memory of the user's keeps their words", async () => {
  const t = setup();
  const theirs = await t.store(3, { scope: "user", projectId: null, type: "preference", source: "user", userQuote: "replies stay short", content: "Replies stay short.", metadata: { statedAt: hoursAgo(3) } });
  const words = said("From now on replies stay short and in English");
  const quoted = extract(t, { messages: [words], answer: { entries: [{ type: "preference", scope: "user", content: "Replies stay short and in English.", memoryId: theirs.id, userQuote: "replies stay short and in English" }] } });
  expect(await quoted.result).toMatchObject({ updated: 1 });
  const after = (await t.memory.get(theirs.id))!;
  expect(after).toMatchObject({ source: "user", userQuote: "replies stay short and in English" });
  expect(after.metadata?.statedAt).toBe(words.createdAt);

  const unquoted = extract(t, { answer: { entries: [{ type: "preference", scope: "user", content: "Replies stay short, in English, with no headings.", memoryId: theirs.id }] } });
  expect(await unquoted.result).toMatchObject({ updated: 1 });
  const last = (await t.memory.get(theirs.id))!;
  expect(last).toMatchObject({ source: "user", userQuote: "replies stay short and in English", content: "Replies stay short, in English, with no headings." });
  expect(last.metadata?.statedAt).toBe(words.createdAt);
  expect(last.metadata?.previous).toEqual({ content: "Replies stay short and in English.", type: "preference", source: "user", userQuote: "replies stay short and in English", statedAt: words.createdAt, updatedAt: after.updatedAt, replacedAt: last.updatedAt });
});

// The source is where the memory's words come from: new words of the user
// move it to where they said them; a rewrite without them leaves it.
test("a rewrite with the user's words points the memory at where they said them", async () => {
  const t = setup();
  const theirs = await t.store(3, { scope: "user", projectId: null, type: "preference", source: "user", userQuote: "replies stay short", content: "Replies stay short.", sourceThreadId: "thr_old", sourceMessageId: "m_old" });
  const words = said("From now on replies stay short and in English");
  const quoted = extract(t, { messages: [words], answer: { entries: [{ type: "preference", scope: "user", content: "Replies stay short and in English.", memoryId: theirs.id, userQuote: "replies stay short and in English" }] } });
  expect(await quoted.result).toMatchObject({ updated: 1 });
  expect(await t.memory.get(theirs.id)).toMatchObject({ sourceThreadId: "thr_1", sourceMessageId: words.id });
  const unquoted = extract(t, { answer: { entries: [{ type: "preference", scope: "user", content: "Replies stay short, in English, with no headings.", memoryId: theirs.id }] } });
  expect(await unquoted.result).toMatchObject({ updated: 1 });
  expect(await t.memory.get(theirs.id)).toMatchObject({ sourceThreadId: "thr_1", sourceMessageId: words.id });
});

test("a rewrite without the user's words of a memory that has none is extraction's", async () => {
  const t = setup();
  const agents = await t.store(3, { source: "agent", content: "project-1 releases are cut on Fridays." });
  const { result } = extract(t, { answer: { entries: [entry(t.project1, "project-1 releases are cut on Fridays, after the freeze.", agents.id)] } });
  expect(await result).toMatchObject({ updated: 1 });
  expect(await t.memory.get(agents.id)).toMatchObject({ source: "extraction", userQuote: null });
  expect((await t.memory.get(agents.id))!.metadata?.previous).toMatchObject({ source: "agent" });
});

test("an entry naming a memory that was not listed is stored as new", async () => {
  const t = setup();
  const old = await t.store(49, { content: "project-1 once used a nightly build." });
  const elsewhere = await t.store(1, { projectId: t.project4, content: "project-4 deploys from main." });
  const worker = { featureId: "feat_1", projectId: t.project1, name: "Release" };
  for (const memoryId of [old.id, elsewhere.id, "mem_unknown"]) {
    const { result } = extract(t, { worker, projects: [t.projects[0]!], answer: { entries: [entry(t.project1, `project-1 note about ${memoryId}.`, memoryId)] } });
    expect([memoryId, await result]).toMatchObject([memoryId, { created: 1, updated: 0 }]);
  }
  expect((await t.memory.get(old.id))!.content).toBe("project-1 once used a nightly build.");
  expect((await t.memory.get(elsewhere.id))!.content).toBe("project-4 deploys from main.");
});

test("a rewrite whose scope or project differs from the listed memory is stored as new", async () => {
  const t = setup();
  const listed = await t.store(3, { content: "project-1 releases are cut on Fridays." });
  const moved = extract(t, { answer: { entries: [entry(t.project4, "project-4 releases are cut on Fridays.", listed.id)] } });
  expect(await moved.result).toMatchObject({ created: 1, updated: 0 });
  const toUser = extract(t, { answer: { entries: [{ type: "preference", scope: "user", content: "Releases are cut on Fridays.", memoryId: listed.id }] } });
  expect(await toUser.result).toMatchObject({ created: 1, updated: 0 });
  expect((await t.memory.get(listed.id))!.content).toBe("project-1 releases are cut on Fridays.");
});

test("a rewrite whose memory changed while the model answered is stored as new", async () => {
  for (const change of ["rewritten", "archived"] as const) {
    const t = setup();
    const listed = await t.store(3, { content: "project-1 releases are cut on Fridays." });
    const meanwhile = () => (change === "rewritten" ? t.memory.update({ id: listed.id, content: "project-1 releases are cut on Thursdays." }) : t.memory.archive(listed.id));
    const { result } = extract(t, { meanwhile, answer: { entries: [entry(t.project1, "project-1 releases are cut on Fridays, after the freeze.", listed.id)] } });
    expect([change, await result]).toMatchObject([change, { created: 1, updated: 0 }]);
    expect((await t.memory.get(listed.id))!.content).not.toContain("after the freeze");
    env!.cleanup();
    env = null;
  }
});

test("two entries naming the same memory: the first rewrites it, the second is stored as new", async () => {
  const t = setup();
  const listed = await t.store(3, { content: "project-1 releases are cut on Fridays." });
  const { result } = extract(t, { answer: { entries: [
    entry(t.project1, "project-1 releases are cut on Fridays, after the freeze.", listed.id),
    entry(t.project1, "project-1 releases are cut on Fridays, with release notes.", listed.id)
  ] } });
  expect(await result).toMatchObject({ created: 1, updated: 1 });
  expect((await t.memory.get(listed.id))!.content).toBe("project-1 releases are cut on Fridays, after the freeze.");
});

test("an id written as [mem_…] or with spaces still names the listed memory", async () => {
  const t = setup();
  const listed = await t.store(3, { content: "project-1 releases are cut on Fridays." });
  const { result } = extract(t, { answer: { entries: [entry(t.project1, "project-1 releases are cut on Fridays, after the freeze.", ` [${listed.id}] `)] } });
  expect(await result).toMatchObject({ created: 0, updated: 1 });
});

// A model that fills the template's memoryId with null on a new entry: the
// window is read as it would be without the field.
test("an entry whose memoryId is null is a new entry, and the window is kept", async () => {
  const t = setup();
  const { result } = extract(t, { answer: { entries: [{ ...entry(t.project1, "project-1 releases are cut on Fridays."), memoryId: null }] } });
  expect(await result).toMatchObject({ processed: true, created: 1, updated: 0 });
});

// The listed memory sent back unchanged, without the user's words: nothing
// to write — the memory keeps its words, its version and its recovery text.
test("a listed memory sent back unchanged is left as it was", async () => {
  const t = setup();
  const theirs = await t.store(3, { scope: "user", projectId: null, type: "preference", source: "user", userQuote: "replies stay short", content: "Replies stay short.", metadata: { statedAt: hoursAgo(3), previousContent: "Replies are short." } });
  const { result } = extract(t, { answer: { entries: [{ type: "preference", scope: "user", content: " Replies stay short. ", memoryId: theirs.id }] } });
  expect(await result).toMatchObject({ created: 0, updated: 0 });
  expect(await t.memory.get(theirs.id)).toEqual(theirs);
});

test("the same text sent back with the user's words in this window is theirs again, dated now", async () => {
  const t = setup();
  const listed = await t.store(3, { scope: "user", projectId: null, type: "preference", content: "Replies stay short." });
  const words = said("Again: replies stay short, please");
  const { result } = extract(t, { messages: [words], answer: { entries: [{ type: "preference", scope: "user", content: "Replies stay short.", memoryId: listed.id, userQuote: "replies stay short" }] } });
  expect(await result).toMatchObject({ updated: 1 });
  const now = (await t.memory.get(listed.id))!;
  expect(now).toMatchObject({ source: "user", userQuote: "replies stay short" });
  expect(now.metadata?.statedAt).toBe(words.createdAt);
});

// Only the very same text is unchanged: a sign, an operator or a digit is a
// change, however alike the two look.
test("a rewrite that changes only a sign or an operator is a rewrite", async () => {
  const t = setup();
  const listed = await t.store(3, { content: "Approval is required when the balance < 0." });
  const { result } = extract(t, { answer: { entries: [entry(t.project1, "Approval is required when the balance > 0.", listed.id)] } });
  expect(await result).toMatchObject({ updated: 1 });
  expect((await t.memory.get(listed.id))!.content).toBe("Approval is required when the balance > 0.");
});

// Sent back unchanged, but the memory moved while the model answered: the
// entry is stored as new rather than dropped.
test("an unchanged entry whose memory was archived or rewritten while the model answered is stored as new", async () => {
  for (const change of ["archived", "rewritten"] as const) {
    const t = setup();
    const listed = await t.store(3, { content: "project-1 releases are cut on Fridays." });
    const meanwhile = () => (change === "archived" ? t.memory.archive(listed.id) : t.memory.update({ id: listed.id, content: "project-1 releases are cut on Thursdays." }));
    const { result } = extract(t, { meanwhile, answer: { entries: [entry(t.project1, "project-1 releases are cut on Fridays.", listed.id)] } });
    expect([change, await result]).toMatchObject([change, { created: 1, updated: 0 }]);
    expect(t.memory.listAvailable({ scope: "project", projectId: t.project1 }).map((m) => m.content)).toContain("project-1 releases are cut on Fridays.");
    env!.cleanup();
    env = null;
  }
});

test("a memory the window rewrites, or sends back unchanged, is noted as said again in this conversation; a new entry is not", async () => {
  const t = setup();
  const grown = await t.store(2, { content: "Exports are CSV." });
  const same = await t.store(3, { content: "Imports are JSON." });
  await extract(t, { answer: { entries: [
    entry(t.project1, "Exports are CSV with a header row.", grown.id),
    entry(t.project1, "Imports are JSON.", same.id),
    entry(t.project1, "Backups run nightly.")
  ] } }).result;
  expect(env!.store.db.prepare("select memory_id, kind, thread_id, agent, rank from memory_uses order by rowid").all()).toEqual([
    { memory_id: grown.id, kind: "restated", thread_id: "thr_1", agent: null, rank: null },
    { memory_id: same.id, kind: "restated", thread_id: "thr_1", agent: null, rank: null }
  ]);
});

// The user's memories come first in every window, up to half the list (50
// memories, about 5,000 tokens): a dream pass over the user's memories must
// not push the projects' out.
test("the user's recent memories come first, up to half the list", async () => {
  const t = setup();
  for (let k = 0; k < 80; k++) await t.store(5 + k / 1000, { scope: "user", projectId: null, type: "preference", content: `User rule ${k}.` });
  for (let k = 0; k < 80; k++) await t.store(1 + k / 1000, { content: `project-1 fact ${k}.` });
  const { model, result } = extract(t);
  await result;
  const lines = recentSection(promptOf(model))!.split("\n").slice(1);
  expect(lines).toHaveLength(100);
  expect(lines.slice(0, 50).every((line) => line.includes(", user, "))).toBe(true);
  expect(lines.slice(50).every((line) => line.includes(", project project-1, "))).toBe(true);
  expect(lines[0]).toContain("User rule 0.");
  expect(lines[50]).toContain("project-1 fact 0.");
});

test("what the user's memories leave goes to the projects", async () => {
  const t = setup();
  for (let k = 0; k < 10; k++) await t.store(5 + k / 1000, { scope: "user", projectId: null, type: "preference", content: `User rule ${k}.` });
  for (let k = 0; k < 120; k++) await t.store(1 + k / 1000, { content: `project-1 fact ${k}.` });
  const { model, result } = extract(t);
  await result;
  const lines = recentSection(promptOf(model))!.split("\n").slice(1);
  expect(lines.filter((line) => line.includes(", user, "))).toHaveLength(10);
  expect(lines.filter((line) => line.includes(", project project-1, "))).toHaveLength(90);
});

test("the user's share stops at about half the tokens", async () => {
  const t = setup();
  for (let k = 0; k < 30; k++) await t.store(5 + k / 100, { scope: "user", projectId: null, type: "preference", content: `User rule ${k}: ${"y".repeat(1500)}` });
  for (let k = 0; k < 30; k++) await t.store(1 + k / 100, { content: `project-1 fact ${k}.` });
  const { model, result } = extract(t);
  await result;
  const lines = recentSection(promptOf(model))!.split("\n").slice(1);
  const userLines = lines.filter((line) => line.includes(", user, "));
  expect(userLines.length).toBeGreaterThan(0);
  expect(estimateTextTokens(userLines.join("\n"))).toBeLessThanOrEqual(5_000);
  expect(lines.filter((line) => line.includes(", project project-1, "))).toHaveLength(30);
});

// What a window did is kept with its call in Activity: how many memories it
// stored, rewrote, left out as repeats or refused, and its task record.
test("the extraction's call row keeps what the window did", async () => {
  const t = setup();
  const listed = await t.store(3, { content: "project-1 releases are cut on Fridays." });
  const recorder = new AgentLlmCallRecorder({ store: env!.store, logRequests: "metadata", provider: "openai", model: "test-model", baseURL: "", apiMode: "streamText" });
  const model = createMockLLM([{ text: JSON.stringify({ entries: [entry(t.project1, "project-1 releases are cut on Fridays, after the freeze.", listed.id), entry(t.project1, "project-1 tags come from stable.")] }) }]);
  const result = await extractFromWindow({
    memory: t.memory, records: new FeatureRecordStore(env!.store.db), candidates: [{ model, provider: "openai", supportsReasoning: undefined, recorder }], repeatCheck: [],
    trigger: "compression", threadId: "thr_1", messages: [said("Notes on project-1")],
    projects: t.projects, worker: null, budgetTokens: 50_000, now: NOW
  });
  expect(result).toMatchObject({ created: 1, updated: 1 });
  const call = env!.store.listLlmCalls(10).find((c) => c.purpose === "memory_extraction")!;
  // No task record (not a worker): absent, as the log keeps no nulls.
  expect(call.metadata?.outcome).toEqual({ created: 1, updated: 1, repeats: 0, rejected: 0 });
});
