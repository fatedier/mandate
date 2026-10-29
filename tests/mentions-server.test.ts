import { afterEach, describe, expect, test } from "bun:test";
import { mentionModelLines, resolveMentions } from "../src/server/modules/agent/mentions.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { mentionsOf } from "../src/shared/mentions.js";
import { API_PATHS, API_ROUTES } from "../src/shared/api/routes.js";
import { freshAgentEnv, freshStoresEnv, NOOP_WAKE, type StoresEnv } from "./helpers/fixtures.js";
import { buildAgentsTestApp, buildTestScopes, postJson } from "./helpers/test-app.js";

const mention = (id: string, label = "Some thread") => ({ kind: "thread", id, label });

function setup(prefix: string) {
  const env = freshAgentEnv(prefix);
  const open = env.agentStore.createManagerThread("Parser error messages");
  const receiving = env.agentStore.createManagerThread("Docs overhaul");
  return { env, open, receiving, deps: { agentStore: env.agentStore } };
}

test("a thread mention is kept for an open manager thread", () => {
  const s = setup("md-mentions-open-");
  try {
    const m = mention(s.open.id, "Parser error messages");
    expect(resolveMentions(s.deps, s.receiving.id, [m])).toEqual([m]);
  } finally { s.env.cleanup(); }
});

test("a mention of an archived, missing or receiving thread, or of an unknown kind, is dropped", () => {
  const s = setup("md-mentions-dropped-");
  try {
    const archived = s.env.agentStore.createManagerThread("Old work");
    s.env.agentStore.archiveThread(archived.id);
    const worker = s.env.agentStore.getOrCreateThread("worker", "feat_x");
    expect(resolveMentions(s.deps, s.receiving.id, [
      mention(archived.id),
      mention("thr_missing"),
      mention(s.receiving.id),
      mention(worker.id),
      { kind: "file", id: s.open.id, label: "x" }
    ])).toEqual([]);
  } finally { s.env.cleanup(); }
});

// A kind is looked up as the registry's own entry: one an object inherits
// ("toString", "constructor", "__proto__") is an unknown kind, not a crash.
test("a kind an object inherits is an unknown kind: dropped, and the model reads nothing for it", () => {
  const s = setup("md-mentions-inherited-");
  try {
    const inherited = ["toString", "constructor", "__proto__", "hasOwnProperty"].map((kind) => ({ kind, id: s.open.id, label: "x" }));
    expect(resolveMentions(s.deps, s.receiving.id, inherited)).toEqual([]);
    expect(mentionModelLines(inherited)).toBe("");
  } finally { s.env.cleanup(); }
});

test("malformed entries are dropped and at most ten are kept", () => {
  const s = setup("md-mentions-malformed-");
  try {
    expect(resolveMentions(s.deps, s.receiving.id, "nope")).toEqual([]);
    expect(resolveMentions(s.deps, s.receiving.id, [null, 3, { kind: "thread", id: s.open.id }, { kind: "thread", id: s.open.id, label: "" }])).toEqual([]);
    const twelve = Array.from({ length: 12 }, () => mention(s.open.id, "Parser error messages"));
    expect(resolveMentions(s.deps, s.receiving.id, twelve)).toHaveLength(10);
  } finally { s.env.cleanup(); }
});

// How a label is cleaned and cut is mentionLabel's, tested in mentions.test;
// this is the server keeping what it writes.
test("a label is kept as mentionLabel writes it, on one line for the model too", () => {
  const s = setup("md-mentions-label-");
  try {
    // Every line break any reader honours, and other control characters, too.
    const [odd] = resolveMentions(s.deps, s.receiving.id, [mention(s.open.id, "First\u0085Second\u2028third\x1cfourth\x00end")]);
    expect(odd!.label).toBe("First Second third fourth end");
    expect(mentionModelLines([odd!]).split("\n")).toHaveLength(2);
  } finally { s.env.cleanup(); }
});

test("the model reads one line per mention", () => {
  expect(mentionModelLines([{ kind: "thread", id: "thr_a", label: "Parser error messages" }]))
    .toBe('[Mentioned thread "Parser error messages", threadId thr_a; read it with read_thread]\n');
  expect(mentionModelLines([mention("thr_a", "A"), mention("thr_b", "B")]))
    .toBe('[Mentioned thread "A", threadId thr_a; read it with read_thread]\n[Mentioned thread "B", threadId thr_b; read it with read_thread]\n');
  expect(mentionModelLines([{ kind: "file", id: "f", label: "x" }])).toBe("");
});

describe("the agents routes keep a sent message's mentions", () => {
  let env: StoresEnv | null = null;
  afterEach(() => { env?.cleanup(); env = null; });

  function setupRoutes() {
    env = freshStoresEnv("md-http-mentions-");
    const managerThreads = new ManagerThreadService({ agentStore: env.agentStore });
    const app = buildAgentsTestApp({ agentStore: env.agentStore, wakeScheduler: NOOP_WAKE, scopes: buildTestScopes(env.features), managerThreads });
    const target = env.agentStore.createManagerThread("Parser error messages");
    const receiving = env.agentStore.createManagerThread("Docs overhaul");
    return { env, app, target, receiving };
  }
  const lastMessage = (s: ReturnType<typeof setupRoutes>, threadId: string) => s.env.agentStore.getActiveMessages(threadId).at(-1)!;

  test("a thread message keeps valid mentions and drops the rest", async () => {
    const s = setupRoutes();
    const archived = s.env.agentStore.createManagerThread("Old");
    s.env.agentStore.archiveThread(archived.id);
    const valid = { kind: "thread", id: s.target.id, label: "Parser error messages" };
    const res = await postJson(s.app, API_PATHS.agentThreadMessages(s.receiving.id), {
      content: "Follow up on @Parser error messages and @Old and @Docs overhaul",
      mentions: [valid, { kind: "thread", id: archived.id, label: "Old" }, { kind: "thread", id: s.receiving.id, label: "Docs overhaul" }]
    });
    expect(res.status).toBe(202);
    expect(mentionsOf(lastMessage(s, s.receiving.id).content)).toEqual([valid]);
  });

  test("a new thread's first message keeps its mentions", async () => {
    const s = setupRoutes();
    const valid = { kind: "thread", id: s.target.id, label: "Parser error messages" };
    const res = await postJson(s.app, API_ROUTES.agentManagerThreads, { content: "Continue from @Parser error messages", clientRequestId: "local-1", mentions: [valid] });
    expect(res.status).toBe(201);
    expect(mentionsOf(lastMessage(s, res.body.thread.id).content)).toEqual([valid]);
  });

  test("a thread renamed after it was picked is still mentioned by id, with the words as sent", async () => {
    const s = setupRoutes();
    s.env.agentStore.setThreadTitle(s.target.id, "Parser cleanup");
    const sent = { kind: "thread", id: s.target.id, label: "Parser error messages" };
    await postJson(s.app, API_PATHS.agentThreadMessages(s.receiving.id), { content: "Follow up on @Parser error messages", mentions: [sent] });
    expect(mentionsOf(lastMessage(s, s.receiving.id).content)).toEqual([sent]);
  });
});
