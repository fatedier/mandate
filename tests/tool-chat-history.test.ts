import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildChatHistoryTools } from "../src/server/modules/agent/tools/chat-history.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { seedWorker, seedProject } from "./helpers/fixtures.js";
import { historyEnv } from "./helpers/history-env.js";
import { toolContext } from "./helpers/typed.js";
import { preparedByAsync } from "./helpers/sql-watch.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";

/** A worker caller's scope. The chat-history tools read only the caller's
 *  thread and wake ids; the roots are here for the type. */
const workerScope: ToolContext["scope"] = { kind: "worker", worker: { workingDir: null }, project: { workingDir: "/alpha" } };

function setup(scope: "manager" | "worker" = "manager") {
  const env = historyEnv();
  const tools = buildChatHistoryTools({ db: env.store.db, scope });
  const search = tools.find((tool) => tool.name === "chat_history_search")!;
  const read = tools.find((tool) => tool.name === "chat_history_read")!;
  return { ...env, search, read };
}

test("chat_history_search worker schema omits project and exact thread filters", () => {
  const env = setup("worker");
  expect(env.search.parameters.safeParse({
    query: "meta version",
    includeOwnThread: true
  }).success).toBe(true);
  expect(env.search.parameters.safeParse({
    projectId: env.projectId,
    query: "meta version"
  }).success).toBe(false);
  expect(env.search.parameters.safeParse({
    query: "meta version",
    workerId: env.workerId
  }).success).toBe(false);
  expect(env.search.parameters.safeParse({
    query: "meta version",
    threadId: env.thread.id
  }).success).toBe(false);
});

test("chat_history_search treats blank exact-id filters as no filter", async () => {
  const env = setup();
  expect(env.search.parameters.safeParse({
    projectId: env.projectId,
    query: "meta version",
    workerId: "",
    threadId: ""
  }).success).toBe(true);

  env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "Legacy theme retirement note" }
  });

  const blank = await env.search.handler({
    projectId: env.projectId,
    query: "Legacy theme",
    workerId: "",
    threadId: "   "
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-blank" }));
  const omitted = await env.search.handler({
    projectId: env.projectId,
    query: "Legacy theme"
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-omitted" }));

  expect((blank as any).threads).toHaveLength(1);
  expect((blank as any).threads).toHaveLength((omitted as any).threads.length);
});

test("chat_history_search indexes messages and chat_history_read reads a bounded window around a hit", async () => {
  const env = setup();
  const say = (text: string) => env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text } });
  const reply = (text: string) => env.agentStore.appendMessage({ threadId: env.thread.id, role: "assistant", source: "manager", content: { type: "assistant", text } });
  say("Add the holiday calendar");
  reply("The holiday calendar is in.");
  say("Investigate the date picker regression");
  reply("The regression is caused by a stale month offset.");
  say("Ship the fix tonight");

  const result = await env.search.handler({
    projectId: env.projectId,
    query: "date picker",
    limit: 3
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-test" }));

  expect((result as any).threads).toHaveLength(1);
  const hit = (result as any).threads[0].hits[0];
  expect(hit.snippet).toContain("date picker");

  const readResult = await env.read.handler({
    threadId: (result as any).threads[0].id,
    seq: hit.seq,
    limitBefore: 1,
    limitAfter: 1
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-test" }));
  // One message on each side of the hit, none further.
  expect((readResult as any).messages.map((m: any) => m.content.text)).toStrictEqual([
    "The holiday calendar is in.", "Investigate the date picker regression", "The regression is caused by a stale month offset."
  ]);
  expect((readResult as any).thread.worker.id).toBe(env.workerId);
});

test("a plan reminder is never found by history search, nor read back around a hit", async () => {
  const env = setup();
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "Investigate the date picker regression" }
  });
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "plan-reminder",
    content: { type: "text", text: "<plan-reminder>date picker stale nudge</plan-reminder>" }
  });
  const ctx = toolContext({ threadId: env.caller.id, wakeId: "wake-test" });
  const result = await env.search.handler({ projectId: env.projectId, query: "stale nudge", limit: 3 }, ctx);
  expect((result as any).threads).toHaveLength(0);
  const found = ((await env.search.handler({ projectId: env.projectId, query: "date picker", limit: 3 }, ctx)) as any).threads[0];
  const hit = { threadId: found.id, seq: found.hits[0].seq };
  const read = await env.read.handler({ ...hit, limitBefore: 3, limitAfter: 3 }, ctx);
  expect(JSON.stringify(read)).not.toContain("stale nudge");
  // Nor does it take a slot in the window: two after the hit are two visible rows.
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "assistant", source: "manager", content: { type: "assistant", text: "first after" } });
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "assistant", source: "manager", content: { type: "assistant", text: "second after" } });
  const windowed = await env.read.handler({ ...hit, limitBefore: 0, limitAfter: 2 }, ctx);
  const texts = (windowed as any).messages.map((m: any) => m.content.text);
  expect(texts.slice(-2)).toEqual(["first after", "second after"]);
});

test("history search never finds what a subagent's thread holds", async () => {
  const env = setup();
  const taskId = newId("task");
  const child = env.agentStore.createSubagentThread(taskId);
  new BackgroundTaskStore(env.store.db).create({ id: taskId, parentThreadId: env.caller.id, childThreadId: child.id, type: "general", title: "Ledger", task: "Find the ledger." });
  env.agentStore.appendMessage({ threadId: child.id, role: "assistant", source: "self", content: { type: "assistant", text: "Found the quarterly orchid ledger." } });
  const ctx = toolContext({ threadId: env.caller.id, wakeId: "wake-subagent" });
  const search = async () => (await env.search.handler({ projectId: env.projectId, query: "orchid ledger", limit: 3 }, ctx)) as any;
  expect((await search()).threads).toHaveLength(0);
  // The same words in a manager thread are found: the search reaches the threads outside the projects.
  env.agentStore.appendMessage({ threadId: env.caller.id, role: "assistant", source: "self", content: { type: "assistant", text: "The quarterly orchid ledger is due." } });
  expect((await search()).threads).toHaveLength(1);
});

test("chat_history_search defaults to last90d, and all searches every time", async () => {
  const env = setup();
  const old = env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "Ancient pottery repair note" }
  });
  const oldDate = new Date(Date.now() - 140 * 24 * 3600 * 1000).toISOString();
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(oldDate, old.id);
  env.store.db.prepare("update agent_message_search_entries set message_created_at = ? where message_id = ?")
    .run(oldDate, old.id);

  const defaultResult = await env.search.handler({
    projectId: env.projectId,
    query: "Ancient pottery"
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-default" }));
  expect((defaultResult as any).threads).toHaveLength(0);

  const allResult = await env.search.handler({
    projectId: env.projectId,
    query: "Ancient pottery",
    timeRange: { preset: "all" }
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-all" }));
  expect((allResult as any).threads).toHaveLength(1);
  expect((allResult as any).timeRange).toEqual({ preset: "all", since: null, until: null });
});

test("chat_history_search supports ISO since/until filtering", async () => {
  const env = setup();
  const first = env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "first harvest checkpoint needle" }
  });
  const second = env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "second harvest checkpoint needle" }
  });
  const firstDate = "2026-01-10T00:00:00.000Z";
  const secondDate = "2026-02-10T00:00:00.000Z";
  for (const [id, at] of [[first.id, firstDate], [second.id, secondDate]] as const) {
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(at, id);
    env.store.db.prepare("update agent_message_search_entries set message_created_at = ? where message_id = ?")
      .run(at, id);
  }

  const result = await env.search.handler({
    projectId: env.projectId,
    query: "harvest checkpoint needle",
    timeRange: {
      preset: "all",
      since: "2026-02-01T00:00:00.000Z",
      until: "2026-02-28T00:00:00.000Z"
    },
    snippetsPerThread: 5
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-range" }));

  const snippets = (result as any).threads.flatMap((r: any) => r.hits.map((h: any) => h.snippet));
  expect(snippets.join("\n")).toContain("second harvest");
  expect(snippets.join("\n")).not.toContain("first harvest");
});

test("chat_history_search clamps explicit since to relative preset window", async () => {
  const env = setup();
  const old = env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "old explicit since bypass marker" }
  });
  const oldDate = new Date(Date.now() - 140 * 24 * 3600 * 1000).toISOString();
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(oldDate, old.id);
  env.store.db.prepare("update agent_message_search_entries set message_created_at = ? where message_id = ?")
    .run(oldDate, old.id);

  const result = await env.search.handler({
    projectId: env.projectId,
    query: "explicit since bypass",
    timeRange: { since: "1970-01-01T00:00:00.000Z" }
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-clamp" }));

  expect((result as any).threads).toHaveLength(0);
  expect(Date.parse((result as any).timeRange.since)).toBeGreaterThan(Date.now() - 91 * 24 * 3600 * 1000);
});

test("chat_history_search backfills recent unindexed rows before old migration history", async () => {
  const env = setup();
  const oldMessages: AgentMessage[] = [];
  for (let i = 0; i < 12; i += 1) {
    oldMessages.push(env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: `old migration filler ${i}` }
    }));
  }
  const recent = env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "recent migration backfill needle" }
  });
  for (const [index, message] of oldMessages.entries()) {
    const at = `2020-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`;
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(at, message.id);
  }
  const recentAt = new Date().toISOString();
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(recentAt, recent.id);
  env.store.db.prepare("delete from agent_message_search_entries").run();
  env.store.db.prepare("delete from agent_message_search_skipped").run();

  const result = await env.search.handler({
    projectId: env.projectId,
    query: "recent migration backfill",
    limit: 1
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-backfill" }));

  expect((result as any).threads).toHaveLength(1);
  expect((result as any).threads[0].hits[0].snippet).toContain("recent migration backfill needle");
});

// One message is from before the project was created, one from after; the
// explicit since reaches back before both.
const projectLifetimeRanges: { name: string; timeRange: { preset: "projectLifetime"; since?: string } }[] = [
  { name: "starts at project creation", timeRange: { preset: "projectLifetime" } },
  { name: "clamps explicit since to project creation", timeRange: { preset: "projectLifetime", since: "2026-01-01T00:00:00.000Z" } }
];

test.each(projectLifetimeRanges)("chat_history_search projectLifetime $name", async ({ timeRange }) => {
  const env = setup();
  const beforeProject = env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "preproject checkpoint fossil" }
  });
  const afterProject = env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "postproject checkpoint fossil" }
  });
  const projectCreatedAt = "2026-03-01T00:00:00.000Z";
  env.store.db.prepare("update projects set created_at = ? where id = ?")
    .run(projectCreatedAt, env.projectId);
  for (const [id, at] of [
    [beforeProject.id, "2026-02-01T00:00:00.000Z"],
    [afterProject.id, "2026-03-02T00:00:00.000Z"]
  ] as const) {
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(at, id);
    env.store.db.prepare("update agent_message_search_entries set message_created_at = ? where message_id = ?")
      .run(at, id);
  }

  const result = await env.search.handler({
    projectId: env.projectId,
    query: "checkpoint fossil",
    timeRange,
    snippetsPerThread: 5
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-lifetime" }));
  const snippets = (result as any).threads.flatMap((r: any) => r.hits.map((h: any) => h.snippet)).join("\n");
  expect(snippets).toContain("postproject");
  expect(snippets).not.toContain("preproject");
  expect((result as any).timeRange.since).toBe(projectCreatedAt);
});

test("chat_history_search enforces a manager's projectId and a worker's project scope", async () => {
  const env = setup();
  const otherProjectId = seedProject(env.projects, {
    name: "Beta",
    workingDir: "/beta",
    tmuxSessionName: "beta"
  });
  const otherWorkerId = seedWorker(env.workers, otherProjectId, {
    name: "Billing",
    tmuxWindowName: "billing"
  });
  const otherThread = env.agentStore.getOrCreateThread("worker", otherWorkerId);
  env.agentStore.appendMessage({
    threadId: otherThread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "billing secret needle" }
  });

  // Without projectId: every project's task records and the threads outside the projects, no project's chats.
  const unscoped = await env.search.handler({
    query: "billing secret"
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-scope" }));
  expect((unscoped as { threads: Array<{ id: string }> }).threads.map((result) => result.id)).not.toContain(otherThread.id);

  await expect(env.search.handler({
    projectId: env.projectId,
    query: "billing secret",
    threadId: otherThread.id
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-scope" })))
    .rejects.toThrow(/thread_out_of_scope/);

  const workerCaller = env.thread;
  await expect(env.search.handler({
    projectId: env.projectId,
    query: "billing secret"
  }, toolContext({ threadId: workerCaller.id, wakeId: "wake-worker", scope: workerScope })))
    .rejects.toThrow(/project_out_of_scope/);
});

test("chat_history_read filters secrets and raw tool payloads, and a worker reads only its own project", async () => {
  const env = setup();
  env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "Use api_key=sk-supersecret123456789 and OPENAI_API_KEY=sk-openaiStandalone123456 plus OPENAI_API_KEY=\"quotedStandaloneSecret123456\" plus sk-standaloneSecret123456 while debugging attachments", attachments: [{
      type: "image",
      id: "img-1",
      mediaType: "image/png",
      data: "base64-secret",
      sizeBytes: 12
    }] }
  });
  env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "assistant",
    source: "manager",
    content: {
      type: "assistant",
      text: "I will inspect the config.",
      toolCalls: [{ toolCallId: "tc-1", toolName: "read_file", args: { token: "sk-toolargsecret12345" } }]
    }
  });
  env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "tool",
    source: "self",
    content: {
      type: "tool_result",
      toolCallId: "tc-1",
      toolName: "read_file",
      result: { secret: "raw-tool-result-secret" }
    }
  });

  const result = await env.search.handler({
    projectId: env.projectId,
    query: "debugging attachments",
    includeOwnThread: true
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-redact" }));
  const hit = (result as any).threads[0].hits[0];
  expect(hit.snippet).toContain("[REDACTED]");
  expect(hit.snippet).not.toContain("sk-supersecret");
  expect(hit.snippet).not.toContain("sk-openaiStandalone");
  expect(hit.snippet).not.toContain("quotedStandaloneSecret");
  expect(hit.snippet).not.toContain("sk-standaloneSecret");
  expect(hit.redactions).toContain("secret");
  expect(hit.redactions).toContain("attachments_filtered");

  const at = { threadId: (result as any).threads[0].id, seq: hit.seq };
  const readResult = await env.read.handler({
    ...at,
    includeTools: true,
    limitAfter: 5
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-redact" }));
  const text = (readResult as any).messages.map((m: any) => m.content.text).join("\n");
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain("sk-supersecret");
  expect(text).not.toContain("sk-openaiStandalone");
  expect(text).not.toContain("quotedStandaloneSecret");
  expect(text).not.toContain("sk-standaloneSecret");
  expect(text).not.toContain("sk-toolargsecret");
  expect(text).not.toContain("raw-tool-result-secret");

  // Any manager reads it (a handle once bound a read to its caller); a
  // worker of another project does not.
  const otherManager = env.agentStore.createManagerThread("Another");
  expect(((await env.read.handler(at, toolContext({ threadId: otherManager.id, wakeId: "wake-other" }))) as any).thread.id).toBe(at.threadId);
  const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
  const elsewhere = env.agentStore.getOrCreateThread("worker", seedWorker(env.workers, beta, { name: "Billing", tmuxWindowName: "billing" }));
  await expect(env.read.handler(at, toolContext({ threadId: elsewhere.id, wakeId: "wake-elsewhere", scope: workerScope })))
    .rejects.toThrow(/thread_out_of_scope/);
});

test("chat_history_search indexes assistant self text but not raw tool payloads", async () => {
  const env = setup();
  env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "assistant",
    source: "self",
    content: {
      type: "assistant",
      text: "assistant-visible history marker",
      toolCalls: [{ toolCallId: "tc-visible", toolName: "read_file", args: { api_key: "sk-hiddenargs123456" } }]
    }
  });
  env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "tool",
    source: "self",
    content: {
      type: "tool_result",
      toolCallId: "tc-visible",
      toolName: "read_file",
      result: { secret: "raw-hidden-tool-result" }
    }
  });

  const result = await env.search.handler({
    projectId: env.projectId,
    query: "assistant-visible history"
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-assistant" }));
  expect((result as any).threads).toHaveLength(1);
  expect((result as any).threads[0].hits[0].redactions).toContain("tool_args_filtered");

  const at = { threadId: (result as any).threads[0].id, seq: (result as any).threads[0].hits[0].seq };
  const readWithoutTools = await env.read.handler({
    ...at,
    limitAfter: 5
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-assistant-read" }));
  expect((readWithoutTools as any).messages.map((m: any) => m.content.text).join("\n")).not.toContain("tool result omitted");

  const readWithTools = await env.read.handler({
    ...at,
    includeTools: true,
    limitAfter: 5
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-assistant-read" }));
  const text = (readWithTools as any).messages.map((m: any) => m.content.text).join("\n");
  expect(text).toContain("assistant-visible history marker");
  expect(text).toContain("tool read_file result omitted");
  expect(text).not.toContain("sk-hiddenargs");
  expect(text).not.toContain("raw-hidden-tool-result");
});

test("chat_history_search excludes archived threads by default and can include them explicitly", async () => {
  const env = setup();
  env.agentStore.appendMessage({
    threadId: env.thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "archived history marker" }
  });
  env.agentStore.archiveThread(env.thread.id);

  const hidden = await env.search.handler({
    projectId: env.projectId,
    query: "archived history"
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-archived" }));
  expect((hidden as any).threads).toHaveLength(0);

  const included = await env.search.handler({
    projectId: env.projectId,
    query: "archived history",
    includeArchived: true
  }, toolContext({ threadId: env.caller.id, wakeId: "wake-archived" }));
  expect((included as any).threads).toHaveLength(1);
  expect((included as any).threads[0].archivedAt).toBeTruthy();
});

test("search: a manager reaches its own conversation under default flags", async () => {
  const env = setup();
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "default flags marker in the manager's thread" }
  });
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "assistant", source: "manager",
    content: { type: "assistant", text: "the reply that followed the default flags marker" }
  });

  const ctx = toolContext({
    threadId: env.caller.id,
    wakeId: "wake-default-lineage"
  });
  // No includeOwnThread. This is the shipping default, and the caller's
  // own thread is what a manager searches for -- it is never excluded.
  const result = await env.search.handler({
    projectId: env.projectId,
    query: "default flags marker"
  }, ctx) as any;

  const hit = result.threads.find((r: any) => r.kind === "manager");
  expect(hit).toBeDefined();
  expect(hit.id).toBe(env.caller.id);

  const readResult = await env.read.handler({
    threadId: hit.id,
    seq: hit.hits[0].seq,
    limitAfter: 5
  }, ctx) as any;

  expect(readResult).not.toHaveProperty("project");
  expect(readResult.thread.kind).toBe("manager");
  expect(readResult.messages.map((m: any) => m.content.text).join("\n"))
    .toContain("the reply that followed the default flags marker");
});

test("search: a worker agent's own thread stays excluded under default flags", async () => {
  const env = setup("worker");
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "lineage default marker in the caller's own thread" }
  });

  const ctx = toolContext({
    threadId: env.thread.id,
    wakeId: "wake-worker-lineage",
    scope: workerScope
  });
  // The half that must not move: a worker agent's current thread really is
  // already in its context, so it stays excluded unless it asks otherwise.
  const excluded = await env.search.handler({
    query: "lineage default marker"
  }, ctx) as any;
  expect(excluded.threads).toHaveLength(0);

  const included = await env.search.handler({
    query: "lineage default marker",
    includeOwnThread: true
  }, ctx) as any;
  expect(included.threads).toHaveLength(1);
  expect(included.threads[0].kind).toBe("worker");
});

test("chat_history_search leads with the best match, not the most hits", async () => {
  const env = setup();
  const denseWorker = seedWorker(env.workers, env.projectId, {
    name: "Dense",
    tmuxWindowName: "dense"
  });
  const sparseWorker = seedWorker(env.workers, env.projectId, {
    name: "Sparse",
    tmuxWindowName: "sparse"
  });
  const dense = env.agentStore.getOrCreateThread("worker", denseWorker);
  const sparse = env.agentStore.getOrCreateThread("worker", sparseWorker);

  // One short message, term four times: the strongest bm25 in the set.
  env.agentStore.appendMessage({
    threadId: dense.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "quilloscope quilloscope quilloscope quilloscope" }
  });

  // Six long messages, term once each: six hits, weak bm25 apiece.
  const filler = "unrelated prose about scheduling and disk layout and window titles ".repeat(6);
  for (let i = 0; i < 6; i += 1) {
    env.agentStore.appendMessage({
      threadId: sparse.id,
      role: "assistant",
      source: "self",
      content: { type: "text", text: `${filler} quilloscope ${filler}` }
    });
  }

  const result = await env.search.handler(
    { projectId: env.projectId, query: "quilloscope" },
    toolContext({ threadId: env.caller.id, wakeId: "wake-rank" })
  );

  expect((result as any).threads.length).toBe(2);
  expect((result as any).threads[0].worker.id).toBe(denseWorker);
  expect((result as any).threads[0].hitCount).toBe(1);
  expect((result as any).threads[1].hitCount).toBe(6);

  // The same set under an explicit limit. Both threads still match, so a limit
  // that is not honored returns them both and leaves the payload cap as the
  // only brake on how much a search can hand back.
  const limited = await env.search.handler(
    { projectId: env.projectId, query: "quilloscope", limit: 1 },
    toolContext({ threadId: env.caller.id, wakeId: "wake-rank-limit" })
  );

  expect((limited as any).threads.length).toBe(1);
  expect((limited as any).threads[0].worker.id).toBe(denseWorker);
});

test("chat_history_search says it finds task records, and a manager may name no project", () => {
  const worker = setup("worker");
  const manager = setup("manager");
  expect(worker.search.description).toContain(
    "this tool does not accept projectId, workerId, or threadId. It also searches this project's task records — what each worker was asked, did and left open — archived workers' included, and returns them as records with their first line; read one whole with memory_read."
  );
  // One project's chats and the conversations outside any project, not only one project's.
  expect(manager.search.description.startsWith("Search historical Mandate agent chat messages. Pass the exact projectId")).toBe(true);
  const queryField = (manager.search.parameters as unknown as { shape: { query: { description?: string } } }).shape.query;
  expect(queryField.description).toBe("Search query over historical agent chat messages.");
  expect(manager.search.description).toContain(
    "Pass the exact projectId to search a project's chats; do not pass a project name, slug, or path. Without projectId it searches the task records of every project and the conversations outside any project: manager threads and the user's personal agent's. Task records come back as records with their first line; read one whole with memory_read."
  );
  expect(manager.search.description).not.toContain("The manager must pass the exact projectId.");
  expect(manager.search.parameters.safeParse({ query: "meta version" }).success).toBe(true);
  const projectField = (manager.search.parameters as unknown as { shape: { projectId: { description?: string } } }).shape.projectId;
  expect(projectField.description).toBe("Exact project id to search. Omit it to search every project's task records and the conversations outside any project. Do not pass a project name, slug, or path.");
});

// Messages are indexed as they are written; a search repairs what that
// missed. Once a backfill has found nothing left, a search stops looking over
// every message for misses (a full pass over the table, a tenth of a second
// on a large one, holding the server) until a message's indexing fails again.
async function backfillProbes(db: Database, fn: () => Promise<unknown>) {
  return (await preparedByAsync(db, fn)).filter((sql) => sql.includes("left join agent_message_search_skipped")).length;
}

test("once a backfill has found nothing left, a search no longer looks over every message", async () => {
  const env = setup();
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "the packing checklist" } });
  const ask = () => env.search.handler({ projectId: env.projectId, query: "packing checklist", limit: 1 }, toolContext({ threadId: env.caller.id, wakeId: "wake-once" }));
  expect(await backfillProbes(env.store.db, ask)).toBeGreaterThan(0);
  expect(await backfillProbes(env.store.db, ask)).toBe(0);
});

test("a message whose indexing failed as it was written is found by the next search, the index complete or not", async () => {
  const env = setup();
  const ask = (query: string) => env.search.handler({ projectId: env.projectId, query, limit: 1 }, toolContext({ threadId: env.caller.id, wakeId: "wake-repair" }));
  await ask("anything at all");
  env.store.db.exec("create temp trigger refuse_entry before insert on agent_message_search_entries begin select raise(abort, 'refused'); end");
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "rotate the signing keys" } });
  env.store.db.exec("drop trigger refuse_entry");
  const found = await ask("signing keys") as { threads: Array<{ hits: Array<{ snippet: string }> }> };
  expect(found.threads[0]?.hits[0]?.snippet).toContain("rotate the signing keys");
});
