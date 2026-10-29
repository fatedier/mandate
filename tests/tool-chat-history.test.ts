import { expect, test } from "bun:test";
import { buildChatHistoryTools } from "../src/server/modules/agent/tools/chat-history.js";
import { GLOBAL_HISTORY_PROJECT } from "../src/server/modules/agent/history-store.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { seedFeature, seedProject } from "./helpers/fixtures.js";
import { historyEnv } from "./helpers/history-env.js";
import { toolContext } from "./helpers/typed.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";

/** A worker caller's scope. The chat-history tools read only the caller's
 *  thread and wake ids; the roots are here for the type. */
const workerScope: ToolContext["scope"] = { kind: "worker", feature: { workingDir: null }, project: { workingDir: "/alpha" } };

function setup(scope: "manager" | "worker" = "manager") {
  const env = historyEnv();
  const tools = buildChatHistoryTools({ db: env.store.db, scope });
  const search = tools.find((tool) => tool.name === "chat_history_search")!;
  const read = tools.find((tool) => tool.name === "chat_history_read")!;
  return { ...env, search, read };
}

test("chat_history_search feature schema omits project and exact thread filters", () => {
  const env = setup("worker");
  try {
    expect(env.search.parameters.safeParse({
      query: "meta version",
      includeCurrentLineage: true
    }).success).toBe(true);
    expect(env.search.parameters.safeParse({
      projectId: env.projectId,
      query: "meta version"
    }).success).toBe(false);
    expect(env.search.parameters.safeParse({
      query: "meta version",
      featureId: env.featureId
    }).success).toBe(false);
    expect(env.search.parameters.safeParse({
      query: "meta version",
      threadId: env.thread.id
    }).success).toBe(false);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search treats blank exact-id filters as no filter", async () => {
  const env = setup();
  try {
    expect(env.search.parameters.safeParse({
      projectId: env.projectId,
      query: "meta version",
      featureId: "",
      threadId: ""
    }).success).toBe(true);

    env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "Wire protocol retirement note" }
    });

    const blank = await env.search.handler({
      projectId: env.projectId,
      query: "Wire protocol",
      featureId: "",
      threadId: "   "
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-blank" }));
    const omitted = await env.search.handler({
      projectId: env.projectId,
      query: "Wire protocol"
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-omitted" }));

    expect((blank as any).results).toHaveLength(1);
    expect((blank as any).results).toHaveLength((omitted as any).results.length);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search indexes messages and chat_history_read reads a bounded handle window", async () => {
  const env = setup();
  try {
    env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "Investigate the websocket reconnect regression" }
    });
    env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "assistant",
      source: "manager",
      content: { type: "assistant", text: "The regression is caused by stale retry state." }
    });

    const result = await env.search.handler({
      projectId: env.projectId,
      query: "websocket reconnect",
      limit: 3
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-test" }));

    expect((result as any).results).toHaveLength(1);
    const hit = (result as any).results[0].hits[0];
    expect(hit.snippet).toContain("websocket reconnect");
    expect(hit.readHandle).toMatch(/^hist_/);

    const readResult = await env.read.handler({
      handle: hit.readHandle,
      limitBefore: 1,
      limitAfter: 1
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-test" }));
    expect((readResult as any).messages.map((m: any) => m.content.text).join("\n")).toContain("websocket reconnect");
    expect((readResult as any).thread.featureId).toBe(env.featureId);
  } finally {
    env.cleanup();
  }
});

test("a plan reminder is never found by history search, nor read back around a hit", async () => {
  const env = setup();
  try {
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "Investigate the websocket reconnect regression" }
    });
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "plan-reminder",
      content: { type: "text", text: "<plan-reminder>websocket reconnect stale nudge</plan-reminder>" }
    });
    const ctx = toolContext({ threadId: env.caller.id, wakeId: "wake-test" });
    const result = await env.search.handler({ projectId: env.projectId, query: "stale nudge", limit: 3 }, ctx);
    expect((result as any).results).toHaveLength(0);
    const hit = ((await env.search.handler({ projectId: env.projectId, query: "websocket reconnect", limit: 3 }, ctx)) as any).results[0].hits[0];
    const read = await env.read.handler({ handle: hit.readHandle, limitBefore: 3, limitAfter: 3 }, ctx);
    expect(JSON.stringify(read)).not.toContain("stale nudge");
    // Nor does it take a slot in the window: two after the hit are two visible rows.
    env.agentStore.appendMessage({ threadId: env.thread.id, role: "assistant", source: "manager", content: { type: "assistant", text: "first after" } });
    env.agentStore.appendMessage({ threadId: env.thread.id, role: "assistant", source: "manager", content: { type: "assistant", text: "second after" } });
    const windowed = await env.read.handler({ handle: hit.readHandle, limitBefore: 0, limitAfter: 2 }, ctx);
    const texts = (windowed as any).messages.map((m: any) => m.content.text);
    expect(texts.slice(-2)).toEqual(["first after", "second after"]);
  } finally {
    env.cleanup();
  }
});

test("history search never finds what a subagent's thread holds", async () => {
  const env = setup();
  try {
    const taskId = newId("task");
    const child = env.agentStore.createSubagentThread(taskId);
    new BackgroundTaskStore(env.store.db).create({ id: taskId, parentThreadId: env.caller.id, childThreadId: child.id, type: "general", title: "Ledger", task: "Find the ledger." });
    env.agentStore.appendMessage({ threadId: child.id, role: "assistant", source: "self", content: { type: "assistant", text: "Found the quarterly orchid ledger." } });
    const ctx = toolContext({ threadId: env.caller.id, wakeId: "wake-subagent" });
    const search = async () => (await env.search.handler({ projectId: env.projectId, query: "orchid ledger", limit: 3 }, ctx)) as any;
    expect((await search()).results).toHaveLength(0);
    // The same words in a manager thread are found: the search reaches the global scope.
    env.agentStore.appendMessage({ threadId: env.caller.id, role: "assistant", source: "self", content: { type: "assistant", text: "The quarterly orchid ledger is due." } });
    expect((await search()).results).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search defaults to last90d and supports all with audited reason", async () => {
  const env = setup();
  try {
    const old = env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "Ancient migration rollback note" }
    });
    const oldDate = new Date(Date.now() - 140 * 24 * 3600 * 1000).toISOString();
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(oldDate, old.id);
    env.store.db.prepare("update agent_message_search_entries set message_created_at = ? where message_id = ?")
      .run(oldDate, old.id);

    const defaultResult = await env.search.handler({
      projectId: env.projectId,
      query: "Ancient migration"
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-default" }));
    expect((defaultResult as any).results).toHaveLength(0);

    await expect(env.search.handler({
      projectId: env.projectId,
      query: "Ancient migration",
      timeRange: { preset: "all" }
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-all" })))
      .rejects.toThrow(/all_time_reason_required/);

    const allResult = await env.search.handler({
      projectId: env.projectId,
      query: "Ancient migration",
      timeRange: { preset: "all", reason: "user asked for old migration context" }
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-all" }));
    expect((allResult as any).results).toHaveLength(1);
    expect((allResult as any).timeRange.reason).toContain("old migration");

    const audit = env.store.db.prepare(`
      select reason
      from agent_history_audit
      where tool_name = 'chat_history_search' and time_preset = 'all'
      order by created_at desc
      limit 1
    `).get() as { reason: string } | undefined;
    expect(audit?.reason).toBe("user asked for old migration context");
  } finally {
    env.cleanup();
  }
});

test("chat_history_search supports ISO since/until filtering", async () => {
  const env = setup();
  try {
    const first = env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "first deploy checkpoint needle" }
    });
    const second = env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "second deploy checkpoint needle" }
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
      query: "deploy checkpoint needle",
      timeRange: {
        preset: "all",
        reason: "test explicit ISO range filtering",
        since: "2026-02-01T00:00:00.000Z",
        until: "2026-02-28T00:00:00.000Z"
      },
      snippetsPerThread: 5
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-range" }));

    const snippets = (result as any).results.flatMap((r: any) => r.hits.map((h: any) => h.snippet));
    expect(snippets.join("\n")).toContain("second deploy");
    expect(snippets.join("\n")).not.toContain("first deploy");
  } finally {
    env.cleanup();
  }
});

test("chat_history_search clamps explicit since to relative preset window", async () => {
  const env = setup();
  try {
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

    expect((result as any).results).toHaveLength(0);
    expect(Date.parse((result as any).timeRange.since)).toBeGreaterThan(Date.now() - 91 * 24 * 3600 * 1000);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search backfills recent unindexed rows before old migration history", async () => {
  const env = setup();
  try {
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

    expect((result as any).results).toHaveLength(1);
    expect((result as any).results[0].hits[0].snippet).toContain("recent migration backfill needle");
  } finally {
    env.cleanup();
  }
});

// One message is from before the project was created, one from after; the
// explicit since reaches back before both.
const projectLifetimeRanges: { name: string; timeRange: { preset: "projectLifetime"; since?: string } }[] = [
  { name: "starts at project creation", timeRange: { preset: "projectLifetime" } },
  { name: "clamps explicit since to project creation", timeRange: { preset: "projectLifetime", since: "2026-01-01T00:00:00.000Z" } }
];

test.each(projectLifetimeRanges)("chat_history_search projectLifetime $name", async ({ timeRange }) => {
  const env = setup();
  try {
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
    const snippets = (result as any).results.flatMap((r: any) => r.hits.map((h: any) => h.snippet)).join("\n");
    expect(snippets).toContain("postproject");
    expect(snippets).not.toContain("preproject");
    expect((result as any).timeRange.since).toBe(projectCreatedAt);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search enforces overview projectId and feature project scope", async () => {
  const env = setup();
  try {
    const otherProjectId = seedProject(env.projects, {
      name: "Beta",
      workingDir: "/beta",
      tmuxSessionName: "beta"
    });
    const otherFeatureId = seedFeature(env.features, otherProjectId, {
      name: "Billing",
      tmuxWindowName: "billing"
    });
    const otherThread = env.agentStore.getOrCreateThread("worker", otherFeatureId);
    env.agentStore.appendMessage({
      threadId: otherThread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "billing secret needle" }
    });

    // Without projectId: every project's task records and the overview's own history, no project's chats.
    const unscoped = await env.search.handler({
      query: "billing secret"
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-scope" }));
    expect((unscoped as { results: Array<{ thread: { id: string } }> }).results.map((result) => result.thread.id)).not.toContain(otherThread.id);

    await expect(env.search.handler({
      projectId: env.projectId,
      query: "billing secret",
      threadId: otherThread.id
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-scope" })))
      .rejects.toThrow(/thread_out_of_scope/);

    const featureCaller = env.thread;
    await expect(env.search.handler({
      projectId: env.projectId,
      query: "billing secret"
    }, toolContext({ threadId: featureCaller.id, wakeId: "wake-feature", scope: workerScope })))
      .rejects.toThrow(/project_out_of_scope/);
  } finally {
    env.cleanup();
  }
});

test("chat_history_read handle is caller-bound and filters raw tool payloads", async () => {
  const env = setup();
  try {
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
      includeCurrentLineage: true
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-redact" }));
    const hit = (result as any).results[0].hits[0];
    expect(hit.snippet).toContain("[REDACTED]");
    expect(hit.snippet).not.toContain("sk-supersecret");
    expect(hit.snippet).not.toContain("sk-openaiStandalone");
    expect(hit.snippet).not.toContain("quotedStandaloneSecret");
    expect(hit.snippet).not.toContain("sk-standaloneSecret");
    expect(hit.redactions).toContain("secret");
    expect(hit.redactions).toContain("attachments_filtered");

    const readResult = await env.read.handler({
      handle: hit.readHandle,
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

    const otherCaller = env.agentStore.getOrCreateThread("manager", null);
    env.agentStore.archiveThread(otherCaller.id);
    const freshCaller = env.agentStore.getOrCreateThread("manager", null);
    await expect(env.read.handler({
      handle: hit.readHandle
    }, toolContext({ threadId: freshCaller.id, wakeId: "wake-other" })))
      .rejects.toThrow(/read_handle_not_found/);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search indexes assistant self text but not raw tool payloads", async () => {
  const env = setup();
  try {
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
    expect((result as any).results).toHaveLength(1);
    expect((result as any).results[0].hits[0].redactions).toContain("tool_args_filtered");

    const readWithoutTools = await env.read.handler({
      handle: (result as any).results[0].hits[0].readHandle,
      limitAfter: 5
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-assistant-read" }));
    expect((readWithoutTools as any).messages.map((m: any) => m.content.text).join("\n")).not.toContain("tool result omitted");

    const readWithTools = await env.read.handler({
      handle: (result as any).results[0].hits[0].readHandle,
      includeTools: true,
      limitAfter: 5
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-assistant-read" }));
    const text = (readWithTools as any).messages.map((m: any) => m.content.text).join("\n");
    expect(text).toContain("assistant-visible history marker");
    expect(text).toContain("tool read_file result omitted");
    expect(text).not.toContain("sk-hiddenargs");
    expect(text).not.toContain("raw-hidden-tool-result");
  } finally {
    env.cleanup();
  }
});

test("chat_history_search excludes archived threads by default and can include them explicitly", async () => {
  const env = setup();
  try {
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
    expect((hidden as any).results).toHaveLength(0);

    const included = await env.search.handler({
      projectId: env.projectId,
      query: "archived history",
      includeArchived: true
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-archived" }));
    expect((included as any).results).toHaveLength(1);
    expect((included as any).results[0].thread.archivedAt).toBeTruthy();
  } finally {
    env.cleanup();
  }
});

test("chat_history_read handle remains bound to search time range", async () => {
  const env = setup();
  try {
    const message = env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "range-bound handle marker" }
    });
    const inRange = "2026-04-15T00:00:00.000Z";
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(inRange, message.id);
    env.store.db.prepare("update agent_message_search_entries set message_created_at = ? where message_id = ?")
      .run(inRange, message.id);

    const result = await env.search.handler({
      projectId: env.projectId,
      query: "range-bound handle",
      timeRange: {
        preset: "all",
        reason: "test read handle time binding",
        since: "2026-04-01T00:00:00.000Z",
        until: "2026-04-30T00:00:00.000Z"
      }
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-handle-range" }));
    const handle = (result as any).results[0].hits[0].readHandle;

    const outsideRange = "2026-05-15T00:00:00.000Z";
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(outsideRange, message.id);
    env.store.db.prepare("update agent_message_search_entries set message_created_at = ? where message_id = ?")
      .run(outsideRange, message.id);

    await expect(env.read.handler({
      handle
    }, toolContext({ threadId: env.caller.id, wakeId: "wake-handle-range-read" })))
      .rejects.toThrow(/read_handle_out_of_range/);
  } finally {
    env.cleanup();
  }
});

test("search: an overview agent reaches its own history under default flags", async () => {
  const env = setup();
  try {
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "default flags marker in the overview thread" }
    });
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "assistant", source: "manager",
      content: { type: "assistant", text: "the reply that followed the default flags marker" }
    });

    const ctx = toolContext({
      threadId: env.caller.id,
      wakeId: "wake-default-lineage"
    });
    // No includeCurrentLineage. This is the shipping default, and every global
    // entry lives in the caller's own thread -- excluding it returns nothing.
    const result = await env.search.handler({
      projectId: env.projectId,
      query: "default flags marker"
    }, ctx) as any;

    const hit = result.results.find((r: any) => r.thread.scope === "manager");
    expect(hit).toBeDefined();
    expect(hit.thread.id).toBe(env.caller.id);

    const readResult = await env.read.handler({
      handle: hit.hits[0].readHandle,
      limitAfter: 5
    }, ctx) as any;

    expect(readResult.project.id).toBe(GLOBAL_HISTORY_PROJECT);
    expect(readResult.thread.scope).toBe("manager");
    expect(readResult.messages.map((m: any) => m.content.text).join("\n"))
      .toContain("the reply that followed the default flags marker");
  } finally {
    env.cleanup();
  }
});

test("search: a feature agent's own thread stays excluded under default flags", async () => {
  const env = setup("worker");
  try {
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "lineage default marker in the caller's own thread" }
    });

    const ctx = toolContext({
      threadId: env.thread.id,
      wakeId: "wake-feature-lineage",
      scope: workerScope
    });
    // The half that must not move: a feature agent's current thread really is
    // already in its context, so it stays excluded unless it asks otherwise.
    const excluded = await env.search.handler({
      query: "lineage default marker"
    }, ctx) as any;
    expect(excluded.results).toHaveLength(0);

    const included = await env.search.handler({
      query: "lineage default marker",
      includeCurrentLineage: true
    }, ctx) as any;
    expect(included.results).toHaveLength(1);
    expect(included.results[0].thread.scope).toBe("worker");
  } finally {
    env.cleanup();
  }
});

test("chat_history_search leads with the best match, not the most hits", async () => {
  const env = setup();
  try {
    const denseFeature = seedFeature(env.features, env.projectId, {
      name: "Dense",
      tmuxWindowName: "dense"
    });
    const sparseFeature = seedFeature(env.features, env.projectId, {
      name: "Sparse",
      tmuxWindowName: "sparse"
    });
    const dense = env.agentStore.getOrCreateThread("worker", denseFeature);
    const sparse = env.agentStore.getOrCreateThread("worker", sparseFeature);

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

    expect((result as any).results.length).toBe(2);
    expect((result as any).results[0].thread.featureId).toBe(denseFeature);
    expect((result as any).results[0].hitCount).toBe(1);
    expect((result as any).results[1].hitCount).toBe(6);

    // The same set under an explicit limit. Both threads still match, so a limit
    // that is not honored returns them both and leaves the payload cap as the
    // only brake on how much a search can hand back.
    const limited = await env.search.handler(
      { projectId: env.projectId, query: "quilloscope", limit: 1 },
      toolContext({ threadId: env.caller.id, wakeId: "wake-rank-limit" })
    );

    expect((limited as any).results.length).toBe(1);
    expect((limited as any).results[0].thread.featureId).toBe(denseFeature);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search says it finds task records, and the overview takes no projectId", () => {
  const worker = setup("worker");
  const manager = setup("manager");
  try {
    expect(worker.search.description).toContain(
      "this tool does not accept projectId, featureId, or threadId. It also searches this project's task records — what each worker was asked, did and left open — archived workers' included, and returns them as records with their first line; read one whole with memory_read."
    );
    expect(manager.search.description).toContain(
      "Pass the exact projectId to search a project's chats; do not pass a project name, slug, or path. Without projectId it searches the task records of every project and your own earlier conversation. Task records come back as records with their first line; read one whole with memory_read."
    );
    expect(manager.search.description).not.toContain("The manager must pass the exact projectId.");
    expect(manager.search.parameters.safeParse({ query: "meta version" }).success).toBe(true);
    const projectField = (manager.search.parameters as unknown as { shape: { projectId: { description?: string } } }).shape.projectId;
    expect(projectField.description).toBe("Exact project id to search. Omit it to search every project's task records and your own earlier conversation. Do not pass a project name, slug, or path.");
  } finally {
    worker.cleanup();
    manager.cleanup();
  }
});
