import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { stub } from "./helpers/typed.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { decisionQuestion, type JudgementCandidate } from "../src/server/modules/manager-checks/judge.js";
import { renderPromptFile } from "../src/server/platform/prompts/prompt-template.js";
import { LocalMemoryProvider, type MemoryEmbedder } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { extractFromWindow } from "../src/server/modules/memory/extraction.js";
import { MEMORY_REPEAT_CHOICE, repeatCheckContext } from "../src/server/modules/memory/repeat-check.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import type { MemoryRememberInput } from "../src/server/modules/memory/types.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";

// Memory repeat check: before extraction stores a memory, a judgement reads it
// beside the stored memories most like it; one that would add nothing is not
// stored. No answer, or no model, and it is stored as before.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const PROMPT = [
  "You read a new memory an agent is about to store and the stored memories most like it, and decide whether storing the new one adds anything.",
  "- repeat: one of the stored memories already says what the new one says, so storing it would add nothing.",
  "- new: it says something none of the stored memories says, even if it is about the same subject.",
  "",
  "Answer with JSON only: {\"status\": \"<one of the options above>\"}",
  ""
].join("\n");

test("the prompt reads word for word, as one choice between its two definitions", () => {
  const prompt = renderPromptFile(MEMORY_REPEAT_CHOICE.promptPath);
  expect(prompt).toBe(PROMPT);
  const question = decisionQuestion(prompt, MEMORY_REPEAT_CHOICE.options);
  expect(Object.keys(question.criteria)).toEqual(["repeat", "new"]);
  expect(question.instructions.startsWith("Read a new memory an agent is about to store")).toBe(true);
  expect(question.criteria.repeat!.startsWith("One of the stored memories already says what the new one says")).toBe(true);
});

test("a decision model's answer is a repeat once its chance reaches 0.8, else new", () => {
  expect(MEMORY_REPEAT_CHOICE.fromDecision({ repeat: 0.8, new: 0.2 })).toBe("repeat");
  expect(MEMORY_REPEAT_CHOICE.fromDecision({ repeat: 0.79, new: 0.21 })).toBe("new");
  expect(MEMORY_REPEAT_CHOICE.fromDecision({ new: 1 })).toBe("new");
});

test("the context is the new memory, then the stored ones most like it, numbered", () => {
  expect(repeatCheckContext("Builds run on the shared runner.", [{ content: "The shared runner builds every branch." }, { content: "Builds take ten minutes." }]))
    .toBe("New memory:\nBuilds run on the shared runner.\n\nStored memories most like it:\n1. The shared runner builds every branch.\n2. Builds take ten minutes.");
});

// ---- inside extraction ----

const said = (text: string) => stub<AgentMessage>({ id: "m_1", threadId: "thr_1", role: "user", source: "user", seq: 1, createdAt: "2026-10-07T00:00:00.000Z", content: { type: "text", text } });
const projects = [{ id: "proj_alpha", name: "alpha" }, { id: "proj_beta", name: "beta" }];
type Entry = { type: "preference" | "knowledge"; scope: "user" | "project"; projectId?: string; content: string; userQuote?: string };
const knowledge = (content: string, projectId = "proj_alpha"): Entry => ({ type: "knowledge", scope: "project", projectId, content });

function setup(embedder: MemoryEmbedder | null = null) {
  env = freshStoresEnv("md-repeat-check-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db, { embedder }));
  const store = (input: Partial<MemoryRememberInput> & { content: string }) =>
    memory.remember({ scope: "project", projectId: "proj_alpha", type: "knowledge", source: "extraction", ...input });
  return { memory, store };
}

/** A decision model answering through an injected fetch: no network. */
function decisionServer(answer: (state: string) => Record<string, number> | Response | Promise<Record<string, number>>) {
  const states: string[] = [];
  const candidate: JudgementCandidate = {
    kind: "decision", baseURL: "https://gw.example/v1", apiKey: "sk-gw", model: "vendor/judge-1",
    recorder: new AgentLlmCallRecorder({ store: env!.store, logRequests: "metadata", provider: "gw", model: "vendor/judge-1", baseURL: "", apiMode: "decisions" }),
    fetch: async (input, init) => {
      const body = await new Request(input, init).json() as { state: string };
      states.push(body.state);
      const reply = await answer(body.state);
      return reply instanceof Response ? reply : Response.json({
        id: "gen-dec-1", model: "vendor/judge-1",
        answers: { status: { type: "choice", choice: "new", confidence: 1, probabilities: reply } },
        usage: { input_tokens: 10, output_tokens: 1 }
      });
    }
  };
  return { candidate, states };
}

function extract(memory: MemoryManager, entries: Entry[], repeatCheck: JudgementCandidate[], messages = [said("Notes on alpha")]) {
  return extractFromWindow({
    memory, records: stub<FeatureRecordStore>(), candidates: [{ model: createMockLLM([{ text: JSON.stringify({ entries }) }]), provider: "openai", supportsReasoning: undefined }],
    repeatCheck, trigger: "compression", threadId: "thr_1", messages, projects, worker: null, budgetTokens: 50_000
  });
}
const contents = (memory: MemoryManager, projectId = "proj_alpha") => memory.listAvailable({ scope: "project", projectId }).map((e) => e.content).sort();
/** The stored memories a state listed. */
const listed = (state: string) => state.split("\n").filter((line) => /^\d+\. /.test(line)).map((line) => line.replace(/^\d+\. /, ""));

test("an entry judged a repeat is not stored; one judged new is", async () => {
  const { memory, store } = setup();
  await store({ content: "alpha releases are cut on Fridays." });
  const { candidate, states } = decisionServer((state) => (state.includes("every Friday") ? { repeat: 0.9, new: 0.1 } : { repeat: 0.1, new: 0.9 }));
  const result = await extract(memory, [knowledge("Releases of alpha are cut every Friday."), knowledge("alpha's staging database is reset nightly.")], [candidate]);
  expect(result).toMatchObject({ processed: true, created: 1, repeats: 1 });
  expect(contents(memory)).toEqual(["alpha releases are cut on Fridays.", "alpha's staging database is reset nightly."]);
  expect(states).toHaveLength(2);
  expect(states[0]).toBe("New memory:\nReleases of alpha are cut every Friday.\n\nStored memories most like it:\n1. alpha releases are cut on Fridays.");
});

test("each check is a memory_repeat_check call on the thread, keeping the memory and the ones it was compared with", async () => {
  const { memory, store } = setup();
  const stored = await store({ content: "alpha releases are cut on Fridays." });
  const { candidate } = decisionServer(() => ({ repeat: 0.95, new: 0.05 }));
  await extract(memory, [knowledge("Releases of alpha are cut every Friday.")], [candidate]);
  const rows = env!.store.listLlmCalls(10).filter((call) => call.purpose === "memory_repeat_check");
  expect(rows.map((row) => [row.scopeType, row.scopeId, row.status])).toEqual([["agent_thread", "thr_1", "succeeded"]]);
  expect(rows[0]!.metadata?.judgement).toEqual({
    options: ["repeat", "new"], answer: "repeat", probabilities: { repeat: 0.95, new: 0.05 },
    subject: { memory: "Releases of alpha are cut every Friday.", similar: [stored.id] }
  });
});

// Left out as a repeat of one of the stored memories it was compared with —
// which one, the answer does not say: each is noted with how alike it was
// (1 the most), for statistics to weigh.
test("an entry left out as a repeat notes the stored memories it was compared with, most alike first; one judged new notes none", async () => {
  const { memory, store } = setup();
  await store({ content: "alpha releases are cut on Fridays." });
  await store({ content: "alpha releases ship after the Friday cut." });
  const { candidate } = decisionServer((state) => (state.includes("every Friday") ? { repeat: 0.9, new: 0.1 } : { repeat: 0.1, new: 0.9 }));
  await extract(memory, [knowledge("Releases of alpha are cut every Friday."), knowledge("alpha's staging database is reset nightly.")], [candidate]);
  const similar = (env!.store.listLlmCalls(10).filter((call) => call.purpose === "memory_repeat_check")
    .map((call) => call.metadata?.judgement as { answer: string; subject: { similar: string[] } })
    .find((j) => j.answer === "repeat"))!.subject.similar;
  expect(similar.length).toBeGreaterThan(0);
  expect(env!.store.db.prepare("select memory_id, kind, thread_id, agent, rank from memory_uses order by rowid").all())
    .toEqual(similar.map((id, i) => ({ memory_id: id, kind: "repeat", thread_id: "thr_1", agent: null, rank: i + 1 })));
});

// The dream may move, rewrite or archive a memory while the model is asked:
// an answer about memories that changed meanwhile is not acted on.
test("a repeat answer about a stored memory that changed while it was asked stores the entry, and says why", async () => {
  for (const change of ["archive", "move", "rewrite", "archived in the same millisecond"] as const) {
    const { memory, store } = setup();
    const stored = await store({ content: "alpha releases are cut on Fridays." });
    const { candidate } = decisionServer(async () => {
      if (change === "archive") await memory.archive(stored.id);
      if (change === "move") await memory.update({ id: stored.id, projectId: "proj_beta" });
      if (change === "rewrite") await memory.update({ id: stored.id, content: "alpha releases are cut on Thursdays." });
      // Archiving a project archives its memories at the wall clock's time,
      // which can be the time of their last write.
      if (change === "archived in the same millisecond") env!.store.db.prepare("update memory_entries set status = 'archived' where id = ?").run(stored.id);
      return { repeat: 0.95, new: 0.05 };
    });
    const result = await extract(memory, [knowledge("Releases of alpha are cut every Friday.")], [candidate]);
    expect([change, result.created, result.repeats]).toEqual([change, 1, 0]);
    const [row] = env!.store.listLlmCalls(10).filter((call) => call.purpose === "memory_repeat_check");
    expect((row!.metadata?.judgement as { answer: string; notUsed?: string })).toMatchObject({ answer: "repeat", notUsed: "memory_changed" });
    // An answer not acted on is no use of what it was about.
    expect(env!.store.db.prepare("select count(*) as n from memory_uses").get()).toEqual({ n: 0 });
    env!.cleanup();
    env = null;
  }
});

test("with no model on the route nothing is asked, nothing searched, and every entry is stored", async () => {
  const embedded: string[] = [];
  const { memory, store } = setup({ model: "embed-1", embed: async (text) => { embedded.push(text); return [1, 0]; } });
  await store({ content: "alpha releases are cut on Fridays." });
  const result = await extract(memory, [knowledge("Releases of alpha are cut every Friday.")], []);
  expect(result).toMatchObject({ created: 1, repeats: 0 });
  expect(env!.store.listLlmCalls(10).filter((call) => call.purpose === "memory_repeat_check")).toEqual([]);
  // Each memory embedded once, as it is stored: no search embedded the entry first.
  expect(embedded).toEqual(["alpha releases are cut on Fridays.", "Releases of alpha are cut every Friday."]);
});

test("a check that gets no answer stores the entry", async () => {
  const { memory, store } = setup();
  await store({ content: "alpha releases are cut on Fridays." });
  const { candidate, states } = decisionServer(() => new Response("upstream down", { status: 500 }));
  const result = await extract(memory, [knowledge("Releases of alpha are cut every Friday.")], [candidate]);
  // Asked (and, as every route step, asked again once after a server error).
  expect(states.length).toBeGreaterThan(0);
  expect(result).toMatchObject({ created: 1, repeats: 0 });
  expect(contents(memory)).toHaveLength(2);
});

test("a lookup of the stored memories that fails stores the entry, and the rest of the window with it", async () => {
  const { memory, store } = setup();
  await store({ content: "alpha releases are cut on Fridays." });
  const { candidate, states } = decisionServer(() => ({ repeat: 1 }));
  const search = memory.search.bind(memory);
  let failures = 1;
  memory.search = async (input) => {
    if (failures-- > 0) throw new Error("database is locked");
    return search(input);
  };
  const result = await extract(memory, [knowledge("Releases of alpha are cut every Friday."), knowledge("alpha's staging database is reset nightly.")], [candidate]);
  expect(result).toMatchObject({ created: 1, repeats: 1 });
  expect(contents(memory)).toEqual(["Releases of alpha are cut every Friday.", "alpha releases are cut on Fridays."]);
  expect(states).toHaveLength(1);
});

test("with nothing stored like it an entry is stored without asking", async () => {
  const { memory } = setup();
  const { candidate, states } = decisionServer(() => ({ repeat: 1 }));
  const result = await extract(memory, [knowledge("alpha's staging database is reset nightly.")], [candidate]);
  expect(result).toMatchObject({ created: 1, repeats: 0 });
  expect(states).toEqual([]);
});

test("an entry is compared with its own scope's preferences and knowledge: not another project's, not the user's, never a task record", async () => {
  const { memory, store } = setup();
  await store({ content: "deploy notes: alpha knowledge" });
  await store({ type: "preference", content: "deploy notes: alpha preference" });
  await store({ type: "task", featureId: "feat_1", content: "deploy notes: alpha task record" });
  await store({ projectId: "proj_beta", content: "deploy notes: beta knowledge" });
  await store({ scope: "user", projectId: null, type: "preference", content: "deploy notes: the user's preference" });
  const { candidate, states } = decisionServer(() => ({ new: 1 }));
  await extract(memory, [knowledge("deploy notes: alpha, again"), { type: "preference", scope: "user", content: "deploy notes: the user, again" }], [candidate]);
  expect(listed(states[0]!).sort()).toEqual(["deploy notes: alpha knowledge", "deploy notes: alpha preference"]);
  expect(listed(states[1]!)).toEqual(["deploy notes: the user's preference"]);
});

test("it reads the five stored memories most like the entry", async () => {
  const { memory, store } = setup();
  for (let k = 1; k <= 7; k++) await store({ content: `deploy notes number ${k}` });
  const { candidate, states } = decisionServer(() => ({ new: 1 }));
  await extract(memory, [knowledge("deploy notes number 8")], [candidate]);
  expect(listed(states[0]!)).toHaveLength(5);
});

test("an entry of the window stored first is among what a later one is compared with", async () => {
  const { memory } = setup();
  const { candidate, states } = decisionServer((state): Record<string, number> => (state.includes("1. Builds of alpha run on the shared runner.") ? { repeat: 0.9 } : { new: 1 }));
  const result = await extract(memory, [knowledge("Builds of alpha run on the shared runner."), knowledge("alpha builds run on the shared runner.")], [candidate]);
  expect(result).toMatchObject({ created: 1, repeats: 1 });
  expect(states).toHaveLength(1);
});

// Only what the window stored counts as stored by it: an entry left out as a
// repeat does not keep the same words from being judged again after it.
test("the same entry again after one left out as a repeat is judged again", async () => {
  const { memory, store } = setup();
  await store({ type: "preference", content: "alpha commit messages are in English." });
  let asked = 0;
  const { candidate, states } = decisionServer((): Record<string, number> => (asked++ === 0 ? { repeat: 1 } : { new: 1 }));
  const entry = { type: "preference" as const, scope: "project" as const, projectId: "proj_alpha", content: "alpha commit messages are written in English." };
  const result = await extract(memory, [entry, entry], [candidate]);
  expect(result).toMatchObject({ created: 1, repeats: 1, rejected: 0 });
  expect(states).toHaveLength(2);
});

// A memory carrying the user's own words is judged as any other.
test("an entry carrying the user's own words is checked like any other", async () => {
  const { memory, store } = setup();
  await store({ type: "preference", content: "alpha commit messages are in English." });
  const { candidate, states } = decisionServer(() => ({ repeat: 1 }));
  const result = await extract(memory, [{ type: "preference", scope: "project", projectId: "proj_alpha", content: "alpha commit messages are written in English.", userQuote: "alpha commit messages are written in English" }], [candidate],
    [said("From now on alpha commit messages are written in English")]);
  expect(result).toMatchObject({ created: 0, repeats: 1 });
  expect(states).toHaveLength(1);
});
