import { expect, test } from "bun:test";
import { buildChatHistoryTools } from "../src/server/modules/agent/tools/chat-history.js";
import { AgentHistoryStore, GLOBAL_HISTORY_PROJECT } from "../src/server/modules/agent/history-store.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

function setup(scope: "manager" | "worker" = "manager") {
  const env = freshStoresEnv("md-history-");
  const projectId = seedProject(env.projects, {
    name: "Alpha",
    workingDir: "/alpha",
    tmuxSessionName: "alpha"
  });
  const featureId = seedFeature(env.features, projectId, {
    name: "Login",
    tmuxWindowName: "login"
  });
  const caller = env.agentStore.getOrCreateThread("manager", null);
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  const tools = buildChatHistoryTools({ db: env.store.db, scope });
  const search = tools.find((tool) => tool.name === "chat_history_search")!;
  const read = tools.find((tool) => tool.name === "chat_history_read")!;
  return { ...env, projectId, featureId, caller, thread, search, read };
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
    } as any, { threadId: env.caller.id, wakeId: "wake-blank", scope: { kind: "manager" } } as any);
    const omitted = await env.search.handler({
      projectId: env.projectId,
      query: "Wire protocol"
    } as any, { threadId: env.caller.id, wakeId: "wake-omitted", scope: { kind: "manager" } } as any);

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
    } as any, { threadId: env.caller.id, wakeId: "wake-test", scope: { kind: "manager" } } as any);

    expect((result as any).results).toHaveLength(1);
    const hit = (result as any).results[0].hits[0];
    expect(hit.snippet).toContain("websocket reconnect");
    expect(hit.readHandle).toMatch(/^hist_/);

    const readResult = await env.read.handler({
      handle: hit.readHandle,
      limitBefore: 1,
      limitAfter: 1
    } as any, { threadId: env.caller.id, wakeId: "wake-test", scope: { kind: "manager" } } as any);
    expect((readResult as any).messages.map((m: any) => m.content.text).join("\n")).toContain("websocket reconnect");
    expect((readResult as any).thread.featureId).toBe(env.featureId);
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
    } as any, { threadId: env.caller.id, wakeId: "wake-default", scope: { kind: "manager" } } as any);
    expect((defaultResult as any).results).toHaveLength(0);

    await expect(env.search.handler({
      projectId: env.projectId,
      query: "Ancient migration",
      timeRange: { preset: "all" }
    } as any, { threadId: env.caller.id, wakeId: "wake-all", scope: { kind: "manager" } } as any))
      .rejects.toThrow(/all_time_reason_required/);

    const allResult = await env.search.handler({
      projectId: env.projectId,
      query: "Ancient migration",
      timeRange: { preset: "all", reason: "user asked for old migration context" }
    } as any, { threadId: env.caller.id, wakeId: "wake-all", scope: { kind: "manager" } } as any);
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
    } as any, { threadId: env.caller.id, wakeId: "wake-range", scope: { kind: "manager" } } as any);

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
    } as any, { threadId: env.caller.id, wakeId: "wake-clamp", scope: { kind: "manager" } } as any);

    expect((result as any).results).toHaveLength(0);
    expect(Date.parse((result as any).timeRange.since)).toBeGreaterThan(Date.now() - 91 * 24 * 3600 * 1000);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search backfills recent unindexed rows before old migration history", async () => {
  const env = setup();
  try {
    const oldMessages = [];
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
    env.store.db.prepare("delete from agent_message_search_fts").run();
    env.store.db.prepare("delete from agent_message_search_skipped").run();

    const result = await env.search.handler({
      projectId: env.projectId,
      query: "recent migration backfill",
      limit: 1
    } as any, { threadId: env.caller.id, wakeId: "wake-backfill", scope: { kind: "manager" } } as any);

    expect((result as any).results).toHaveLength(1);
    expect((result as any).results[0].hits[0].snippet).toContain("recent migration backfill needle");
  } finally {
    env.cleanup();
  }
});

test("chat_history_search projectLifetime starts at project creation", async () => {
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
      timeRange: { preset: "projectLifetime" },
      snippetsPerThread: 5
    } as any, { threadId: env.caller.id, wakeId: "wake-lifetime", scope: { kind: "manager" } } as any);
    const snippets = (result as any).results.flatMap((r: any) => r.hits.map((h: any) => h.snippet)).join("\n");
    expect(snippets).toContain("postproject");
    expect(snippets).not.toContain("preproject");
    expect((result as any).timeRange.since).toBe(projectCreatedAt);
  } finally {
    env.cleanup();
  }
});

test("chat_history_search projectLifetime clamps explicit since to project creation", async () => {
  const env = setup();
  try {
    const beforeProject = env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "early lifetime clamp marker" }
    });
    const afterProject = env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "late lifetime clamp marker" }
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
      query: "lifetime clamp marker",
      timeRange: { preset: "projectLifetime", since: "2026-01-01T00:00:00.000Z" },
      snippetsPerThread: 5
    } as any, { threadId: env.caller.id, wakeId: "wake-lifetime-clamp", scope: { kind: "manager" } } as any);
    const snippets = (result as any).results.flatMap((r: any) => r.hits.map((h: any) => h.snippet)).join("\n");
    expect(snippets).toContain("late lifetime");
    expect(snippets).not.toContain("early lifetime");
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

    await expect(env.search.handler({
      query: "billing secret"
    } as any, { threadId: env.caller.id, wakeId: "wake-scope", scope: { kind: "manager" } } as any))
      .rejects.toThrow(/project_required/);

    await expect(env.search.handler({
      projectId: env.projectId,
      query: "billing secret",
      threadId: otherThread.id
    } as any, { threadId: env.caller.id, wakeId: "wake-scope", scope: { kind: "manager" } } as any))
      .rejects.toThrow(/thread_out_of_scope/);

    const featureCaller = env.thread;
    await expect(env.search.handler({
      projectId: env.projectId,
      query: "billing secret"
    } as any, { threadId: featureCaller.id, wakeId: "wake-feature", scope: { kind: "worker" } } as any))
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
    } as any, { threadId: env.caller.id, wakeId: "wake-redact", scope: { kind: "manager" } } as any);
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
    } as any, { threadId: env.caller.id, wakeId: "wake-redact", scope: { kind: "manager" } } as any);
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
    } as any, { threadId: freshCaller.id, wakeId: "wake-other", scope: { kind: "manager" } } as any))
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
    } as any, { threadId: env.caller.id, wakeId: "wake-assistant", scope: { kind: "manager" } } as any);
    expect((result as any).results).toHaveLength(1);
    expect((result as any).results[0].hits[0].redactions).toContain("tool_args_filtered");

    const readWithoutTools = await env.read.handler({
      handle: (result as any).results[0].hits[0].readHandle,
      limitAfter: 5
    } as any, { threadId: env.caller.id, wakeId: "wake-assistant-read", scope: { kind: "manager" } } as any);
    expect((readWithoutTools as any).messages.map((m: any) => m.content.text).join("\n")).not.toContain("tool result omitted");

    const readWithTools = await env.read.handler({
      handle: (result as any).results[0].hits[0].readHandle,
      includeTools: true,
      limitAfter: 5
    } as any, { threadId: env.caller.id, wakeId: "wake-assistant-read", scope: { kind: "manager" } } as any);
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
    } as any, { threadId: env.caller.id, wakeId: "wake-archived", scope: { kind: "manager" } } as any);
    expect((hidden as any).results).toHaveLength(0);

    const included = await env.search.handler({
      projectId: env.projectId,
      query: "archived history",
      includeArchived: true
    } as any, { threadId: env.caller.id, wakeId: "wake-archived", scope: { kind: "manager" } } as any);
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
    } as any, { threadId: env.caller.id, wakeId: "wake-handle-range", scope: { kind: "manager" } } as any);
    const handle = (result as any).results[0].hits[0].readHandle;

    const outsideRange = "2026-05-15T00:00:00.000Z";
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(outsideRange, message.id);
    env.store.db.prepare("update agent_message_search_entries set message_created_at = ? where message_id = ?")
      .run(outsideRange, message.id);

    await expect(env.read.handler({
      handle
    } as any, { threadId: env.caller.id, wakeId: "wake-handle-range-read", scope: { kind: "manager" } } as any))
      .rejects.toThrow(/read_handle_out_of_range/);
  } finally {
    env.cleanup();
  }
});

test("history index: an overview thread's messages are indexed under the global scope", () => {
  const env = setup();
  try {
    const message = env.agentStore.appendMessage({
      threadId: env.caller.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "wire protocol retirement discussion" }
    });

    const row = env.store.db.prepare(
      "select project_id, feature_id, content_text from agent_message_search_entries where message_id = ?"
    ).get(message.id) as { project_id: string; feature_id: string | null; content_text: string } | null;

    expect(row).not.toBeNull();
    expect(row!.project_id).toBe("__global__");
    expect(row!.feature_id).toBeNull();
    expect(row!.content_text).toContain("wire protocol");
  } finally {
    env.cleanup();
  }
});

test("history index: a feature thread's messages are unchanged", () => {
  const env = setup();
  try {
    const message = env.agentStore.appendMessage({
      threadId: env.thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "feature side note" }
    });

    const row = env.store.db.prepare(
      "select project_id, feature_id from agent_message_search_entries where message_id = ?"
    ).get(message.id) as { project_id: string; feature_id: string | null } | null;

    expect(row!.project_id).toBe(env.projectId);
    expect(row!.feature_id).toBe(env.featureId);
  } finally {
    env.cleanup();
  }
});

test("history index: a side thread is still skipped", () => {
  const env = setup();
  try {
    const side = env.agentStore.getOrCreateThread("manager", null);
    env.store.db.prepare("update agent_threads set kind = 'side' where id = ?").run(side.id);
    const message = env.agentStore.appendMessage({
      threadId: side.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "ephemeral side chatter" }
    });

    const row = env.store.db.prepare(
      "select message_id from agent_message_search_entries where message_id = ?"
    ).get(message.id);
    const skipped = env.store.db.prepare(
      "select message_id from agent_message_search_skipped where message_id = ?"
    ).get(message.id);

    expect(row).toBeNull();
    expect(skipped).not.toBeNull();
  } finally {
    env.cleanup();
  }
});

test("thread meta: an overview thread resolves with a null feature", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "global note" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "global note",
      includeCurrentLineage: true
    }) as any;

    expect(result.results).toHaveLength(1);
    expect(result.results[0].thread.scope).toBe("manager");
    expect(result.results[0].thread.featureId).toBeNull();
    expect(result.results[0].thread.featureName).toBeNull();
  } finally {
    env.cleanup();
  }
});

test("thread meta: a feature thread still reports string featureId and featureName", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "feature meta probe" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "feature meta probe"
    }) as any;

    expect(result.results).toHaveLength(1);
    expect(result.results[0].thread.scope).toBe("worker");
    expect(typeof result.results[0].thread.featureId).toBe("string");
    expect(typeof result.results[0].thread.featureName).toBe("string");
  } finally {
    env.cleanup();
  }
});

test("thread meta: the global scope resolves without a projects row", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "global project probe" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      query: "global project probe",
      timeRange: { preset: "projectLifetime" },
      includeCurrentLineage: true
    });

    expect(result.project.id).toBe(GLOBAL_HISTORY_PROJECT);
    expect(result.project.name).toBe("Overview");
    // The global scope has no creation date, so projectLifetime cannot narrow.
    expect(result.timeRange.since).toBe(new Date(0).toISOString());
  } finally {
    env.cleanup();
  }
});

test("thread meta: an overview agent may name an overview thread in the global scope", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "global thread filter probe" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      query: "global thread filter probe",
      threadId: env.caller.id,
      includeCurrentLineage: true
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.thread.id).toBe(env.caller.id);

    // This is what the call site's `caller.scope === "manager"` buys: naming
    // an overview thread while searching a real project is answered, not
    // rejected. A feature agent doing this is refused -- see "a feature agent
    // cannot name an overview thread" below. The answer is the overview
    // thread's own hits, because an overview agent's search reaches the global
    // scope alongside the project it named.
    const scoped = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "global thread filter probe",
      threadId: env.caller.id,
      includeCurrentLineage: true
    });

    expect(scoped.results).toHaveLength(1);
    expect(scoped.results[0]!.thread.id).toBe(env.caller.id);
    expect(scoped.results[0]!.thread.scope).toBe("manager");
  } finally {
    env.cleanup();
  }
});

test("thread meta: reading a global handle reports an overview thread", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    const message = env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "global read window marker" }
    });

    // Search cannot hand back a global hit until Task 3, so mint the handle
    // through the same writer search will use once it can.
    const handle = (history as any).createHandle({
      callerThreadId: env.caller.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      threadId: env.caller.id,
      messageId: message.id,
      seq: message.seq,
      timeRange: { preset: "all", since: null, until: null, reason: "global read window unit test" },
      includeArchived: false
    }) as string;

    const result = history.read({ callerThreadId: env.caller.id, handle });

    expect(result.project.id).toBe(GLOBAL_HISTORY_PROJECT);
    expect(result.thread.scope).toBe("manager");
    expect(result.thread.featureId).toBeNull();
    expect(result.thread.featureName).toBeNull();
    expect(result.messages.map((m) => m.content.text).join("\n")).toContain("global read window marker");
  } finally {
    env.cleanup();
  }
});

test("thread meta: a grouped global row keeps its overview meta", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    const message = env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "grouped global row marker" }
    });
    const row = env.store.db.prepare(
      "select *, 0 as rank from agent_message_search_entries where message_id = ?"
    ).get(message.id);
    expect(row).not.toBeNull();

    // Task 3 is what makes the search queries emit this row. Grouping it by
    // hand proves grouping will not reject it once they do.
    const group = (projectId: string, allowGlobal: boolean) => (history as any).groupSearchRows([row], {
      projectId,
      timeRange: { preset: "all", since: null, until: null, reason: "grouped global row unit test" },
      includeArchived: false,
      callerThreadId: env.caller.id,
      limit: 5,
      snippetsPerThread: 2,
      allowGlobal
    });

    const grouped = group(GLOBAL_HISTORY_PROJECT, true);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].thread.id).toBe(env.caller.id);
    expect(grouped[0].thread.scope).toBe("manager");
    expect(grouped[0].thread.featureId).toBeNull();
    expect(grouped[0].thread.featureName).toBeNull();
    expect(grouped[0].hits[0].snippet).toContain("grouped global row marker");
    expect(grouped[0].hits[0].readHandle).toMatch(/^hist_/);

    // This is what `allowGlobal` buys grouping: a row the search filter has
    // already vouched for is grouped even when the requested project id is not
    // the global one. Without the flag the same row is rejected.
    expect(group(env.projectId, true)).toHaveLength(1);
    expect(() => group(env.projectId, false)).toThrow(/thread_out_of_scope/);
  } finally {
    env.cleanup();
  }
});

test("scope isolation: a project-scoped handle cannot read an overview thread", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    const message = env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "project scoped handle probe" }
    });

    // A handle minted under a real project must not open an overview thread,
    // even for the overview agent that owns the handle. Only a handle that
    // records the global scope may.
    const handle = (history as any).createHandle({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      threadId: env.caller.id,
      messageId: message.id,
      seq: message.seq,
      timeRange: { preset: "all", since: null, until: null, reason: "project scoped handle unit test" },
      includeArchived: false
    }) as string;

    expect(() => history.read({ callerThreadId: env.caller.id, handle }))
      .toThrow(/thread_out_of_scope/);
  } finally {
    env.cleanup();
  }
});

test("scope isolation: a feature agent cannot search the global scope", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "overview only isolation marker" }
    });

    // A feature agent may not name another project id at all...
    expect(() => history.search({
      callerThreadId: env.thread.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      query: "overview only isolation"
    })).toThrow(/project_out_of_scope/);

    // ...and its own project scope never matches a global entry.
    const own = history.search({
      callerThreadId: env.thread.id,
      query: "overview only isolation",
      includeCurrentLineage: true
    });
    expect(own.project.id).toBe(env.projectId);
    expect(own.results).toHaveLength(0);
  } finally {
    env.cleanup();
  }
});

test("search: an overview agent sees both project hits and global hits", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "shared marker in a feature thread" }
    });
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "shared marker in the overview thread" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "shared marker",
      includeCurrentLineage: true
    });

    const scopes = result.results.map((r) => r.thread.scope).sort();
    expect(scopes).toEqual(["manager", "worker"]);
    const overviewHit = result.results.find((r) => r.thread.scope === "manager")!;
    expect(overviewHit.thread.id).toBe(env.caller.id);
    expect(overviewHit.thread.featureId).toBeNull();
    expect(overviewHit.thread.featureName).toBeNull();
  } finally {
    env.cleanup();
  }
});

test("search: a global hit's read handle opens the manager conversation", async () => {
  const env = setup();
  try {
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "cross scope marker in the overview thread" }
    });
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "assistant", source: "manager",
      content: { type: "assistant", text: "the overview reply that followed the marker" }
    });

    const ctx = {
      threadId: env.caller.id,
      wakeId: "wake-cross-scope",
      scope: { kind: "manager" }
    } as any;
    const result = await env.search.handler({
      projectId: env.projectId,
      query: "cross scope marker",
      includeCurrentLineage: true
    } as any, ctx) as any;

    // The search names a real project, so the hit's handle must still record
    // the global scope the entry actually lives in -- otherwise the read below
    // is refused with thread_out_of_scope.
    const hit = result.results.find((r: any) => r.thread.scope === "manager");
    expect(hit).toBeDefined();

    const readResult = await env.read.handler({
      handle: hit.hits[0].readHandle,
      limitAfter: 5
    } as any, ctx) as any;

    expect(readResult.project.id).toBe(GLOBAL_HISTORY_PROJECT);
    expect(readResult.project.name).toBe("Overview");
    expect(readResult.thread.scope).toBe("manager");
    expect(readResult.thread.id).toBe(env.caller.id);
    expect(readResult.thread.featureId).toBeNull();
    const text = readResult.messages.map((m: any) => m.content.text).join("\n");
    expect(text).toContain("cross scope marker in the overview thread");
    expect(text).toContain("the overview reply that followed the marker");
  } finally {
    env.cleanup();
  }
});

test("search: a feature agent never sees global hits", async () => {
  const env = setup("worker");
  try {
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "isolation marker in the overview thread" }
    });
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "isolation marker in a feature thread" }
    });

    // A feature caller: resolveRequestedProjectId forces its own project.
    const result = await env.search.handler({
      query: "isolation marker",
      includeCurrentLineage: true
    } as any, {
      threadId: env.thread.id,
      wakeId: "wake-feature-isolation",
      scope: { kind: "worker" }
    } as any) as any;

    expect(result.results).toHaveLength(1);
    expect(result.results[0].thread.scope).toBe("worker");
  } finally {
    env.cleanup();
  }
});

test("search: narrowing to a featureId excludes global hits", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "narrow marker in the overview thread" }
    });
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "narrow marker in a feature thread" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      featureId: env.featureId,
      query: "narrow marker",
      includeCurrentLineage: true
    });

    // Global entries have a null feature_id, so `and e.feature_id = ?` drops
    // them. Narrowing to a feature means asking not to see the overview.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.thread.scope).toBe("worker");
  } finally {
    env.cleanup();
  }
});

test("search: the LEFT JOIN does not surface an entry whose feature is missing", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    const dangling = env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "orphan marker with a dangling feature" }
    });
    const absent = env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "orphan marker with no feature at all" }
    });
    // Today the INNER JOIN on features drops both: one names a feature that
    // does not exist, the other names none while claiming a real project.
    // After the change to LEFT JOIN they must still be dropped -- only a
    // global entry is allowed to have no feature.
    env.store.db.prepare(
      "update agent_message_search_entries set feature_id = ? where message_id = ?"
    ).run("feat_does_not_exist", dangling.id);
    env.store.db.prepare(
      "update agent_message_search_entries set feature_id = null where message_id = ?"
    ).run(absent.id);

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "orphan marker",
      includeCurrentLineage: true
    });

    expect(result.results).toHaveLength(0);
  } finally {
    env.cleanup();
  }
});

test("search: the LEFT JOIN does not surface an entry whose project is missing", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    const message = env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "dangling marker" }
    });
    // Point the indexed entry at a project that does not exist. Today the INNER
    // JOIN drops it; after the change to LEFT JOIN it must still be dropped.
    env.store.db.prepare(
      "update agent_message_search_entries set project_id = ? where message_id = ?"
    ).run("proj_does_not_exist", message.id);

    // search() rejects an unknown projectId before it ever runs a query, so the
    // row filter is the only thing that can drop this entry. Drive the query
    // directly to see it do that.
    const rows = (history as any).searchRows({
      query: "dangling marker",
      projectId: "proj_does_not_exist",
      featureId: null,
      threadId: null,
      timeRange: { preset: "all", since: null, until: null, reason: "dangling project unit test" },
      includeArchived: false,
      excludedThreads: new Set<string>(),
      limit: 25
    });
    expect(rows).toHaveLength(0);

    // The public path refuses the id outright, before any row is considered.
    expect(() => history.search({
      callerThreadId: env.caller.id,
      projectId: "proj_does_not_exist",
      query: "dangling marker"
    })).toThrow(/project_not_found/);
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

    const ctx = {
      threadId: env.caller.id,
      wakeId: "wake-default-lineage",
      scope: { kind: "manager" }
    } as any;
    // No includeCurrentLineage. This is the shipping default, and every global
    // entry lives in the caller's own thread -- excluding it returns nothing.
    const result = await env.search.handler({
      projectId: env.projectId,
      query: "default flags marker"
    } as any, ctx) as any;

    const hit = result.results.find((r: any) => r.thread.scope === "manager");
    expect(hit).toBeDefined();
    expect(hit.thread.id).toBe(env.caller.id);

    const readResult = await env.read.handler({
      handle: hit.hits[0].readHandle,
      limitAfter: 5
    } as any, ctx) as any;

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

    const ctx = {
      threadId: env.thread.id,
      wakeId: "wake-feature-lineage",
      scope: { kind: "worker" }
    } as any;
    // The half that must not move: a feature agent's current thread really is
    // already in its context, so it stays excluded unless it asks otherwise.
    const excluded = await env.search.handler({
      query: "lineage default marker"
    } as any, ctx) as any;
    expect(excluded.results).toHaveLength(0);

    const included = await env.search.handler({
      query: "lineage default marker",
      includeCurrentLineage: true
    } as any, ctx) as any;
    expect(included.results).toHaveLength(1);
    expect(included.results[0].thread.scope).toBe("worker");
  } finally {
    env.cleanup();
  }
});

test("search: the LIKE fallback also returns global hits", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "feature thread arrow --> marker" }
    });
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "overview thread arrow --> marker" }
    });

    // A query with no letters or digits leaves buildFtsQuery with nothing to
    // match on, so searchRows falls through to the LIKE query. That path is
    // reachable in production -- FTS also yields nothing when it matches no row
    // or when searchRowsFts swallows a query it cannot parse.
    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "-->"
    });

    const scopes = result.results.map((r) => r.thread.scope).sort();
    expect(scopes).toEqual(["manager", "worker"]);
  } finally {
    env.cleanup();
  }
});

test("search: a saturated row budget still returns the project's own threads", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    // Four feature threads in the requested project, each with a few hits.
    const featureThreads = [env.thread.id];
    for (const name of ["Billing", "Search", "Deploy"]) {
      const featureId = seedFeature(env.features, env.projectId, {
        name,
        tmuxWindowName: name.toLowerCase()
      });
      featureThreads.push(env.agentStore.getOrCreateThread("worker", featureId).id);
    }
    for (const threadId of featureThreads) {
      for (let i = 0; i < 3; i += 1) {
        env.agentStore.appendMessage({
          threadId, role: "user", source: "user",
          content: { type: "text", text: `budget saturation marker ${i}` }
        });
      }
    }
    // The live overview thread in production is a single thread holding tens of
    // thousands of indexed entries. Give it more hits than the row budget
    // (limit * snippetsPerThread * 3 = 30) so it can eat the whole window on
    // its own -- and append it last so recency ties break in its favour.
    for (let i = 0; i < 40; i += 1) {
      env.agentStore.appendMessage({
        threadId: env.caller.id, role: "user", source: "user",
        content: { type: "text", text: `budget saturation marker ${i}` }
      });
    }

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "budget saturation marker"
    });

    // One ranked query over both scopes returns a single group here: all 30 rows
    // come from the overview thread, and the project's own threads never make it
    // into the window at all.
    const featureResults = result.results.filter((r) => r.thread.scope === "worker");
    expect(featureResults.map((r) => r.thread.id).sort()).toEqual(featureThreads.slice().sort());
    expect(result.results.some((r) => r.thread.scope === "manager")).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("search: the LIKE fallback is decided per scope, not once for both", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    // The feature rows carry `aturationtoken` as a whole token, so the FTS
    // prefix query `aturationtoken*` matches them. The overview rows carry it
    // only inside `saturationtoken`, which no prefix query can reach -- but LIKE
    // can. So the project scope answers from FTS while the global scope has to
    // fall back on its own.
    for (let i = 0; i < 3; i += 1) {
      env.agentStore.appendMessage({
        threadId: env.thread.id, role: "user", source: "user",
        content: { type: "text", text: `aturationtoken in a feature thread ${i}` }
      });
      env.agentStore.appendMessage({
        threadId: env.caller.id, role: "user", source: "user",
        content: { type: "text", text: `saturationtoken in the overview thread ${i}` }
      });
    }

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "aturationtoken"
    });

    const scopes = result.results.map((r) => r.thread.scope).sort();
    expect(scopes).toEqual(["manager", "worker"]);
  } finally {
    env.cleanup();
  }
});

test("search: narrowing to a featureId skips the global query entirely", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "skip global query marker" }
    });

    const pinned: string[] = [];
    const original = (history as any).searchRows.bind(history);
    (history as any).searchRows = (input: any) => {
      pinned.push(input.projectId);
      return original(input);
    };

    history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "skip global query marker"
    });
    expect(pinned).toEqual([env.projectId, GLOBAL_HISTORY_PROJECT]);

    pinned.length = 0;
    history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      featureId: env.featureId,
      query: "skip global query marker"
    });
    // Global entries have a null feature_id, so the global query could only ever
    // return nothing. It must not be run at all.
    expect(pinned).toEqual([env.projectId]);
  } finally {
    env.cleanup();
  }
});

test("search: naming the global scope itself does not run the global query twice", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    for (let i = 0; i < 3; i += 1) {
      env.agentStore.appendMessage({
        threadId: env.caller.id, role: "user", source: "user",
        content: { type: "text", text: `sentinel double query marker ${i}` }
      });
    }

    const pinned: string[] = [];
    const original = (history as any).searchRows.bind(history);
    (history as any).searchRows = (input: any) => {
      pinned.push(input.projectId);
      return original(input);
    };

    // getProject accepts the sentinel, so an overview agent may ask for it by
    // name -- and the result echoes project "Overview" back to it, which invites
    // exactly this call. The project half has then already searched the global
    // scope, so running the global half too would return every row twice.
    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      query: "sentinel double query marker"
    });

    expect(pinned).toEqual([GLOBAL_HISTORY_PROJECT]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.hitCount).toBe(3);
    const ids = result.results[0]!.hits.map((hit) => hit.messageId);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    env.cleanup();
  }
});

// Scoring fixtures: two threads whose entries differ only in the fields under
// test, so a score difference can only come from the term being probed.
// message_created_at defaults to one pinned value, which makes the recency term
// equal unless a block overrides it.
// scoreThreads normalizes each signal onto [0, 1] across the whole result set:
// |bm25| and hit count each map the set's low to 0 and its high to 1, and a
// signal with only one distinct value maps to 1 for every group. Relevance is
// LIKE_MATCH_RELEVANCE (0.5) for an unranked group, and for *every* group in a
// mixed set whose ranked groups hold fewer than two distinct qualities.
// Weights: relevance 0.72, hits 0.2, recency 0.08.
function scoringEnv() {
  const env = setup();
  const history = new AgentHistoryStore(env.store.db);
  const secondFeature = seedFeature(env.features, env.projectId, {
    name: "Payments",
    tmuxWindowName: "payments"
  });
  const second = env.agentStore.getOrCreateThread("worker", secondFeature);
  const pinnedAt = "2026-06-01T00:00:00.000Z";
  const rows = (threadId: string, count: number, rank: number | null, createdAt = pinnedAt) => {
    const built: any[] = [];
    for (let i = 0; i < count; i += 1) {
      const message = env.agentStore.appendMessage({
        threadId, role: "user", source: "user",
        content: { type: "text", text: `scoring fixture row ${threadId} ${i}` }
      });
      env.store.db.prepare(
        "update agent_message_search_entries set message_created_at = ? where message_id = ?"
      ).run(createdAt, message.id);
      const row = env.store.db.prepare(
        "select * from agent_message_search_entries where message_id = ?"
      ).get(message.id) as any;
      built.push({ ...row, rank });
    }
    return built;
  };
  const group = (input: any[]) => (history as any).groupSearchRows(input, {
    projectId: env.projectId,
    timeRange: { preset: "all", since: null, until: null, reason: "scoring unit test" },
    includeArchived: false,
    callerThreadId: env.caller.id,
    limit: 5,
    snippetsPerThread: 2,
    allowGlobal: true
  });
  const scoreOf = (results: any[], threadId: string) =>
    results.find((r: any) => r.thread.id === threadId)!.score;
  return { env, history, second, rows, group, scoreOf };
}

test("scoring: the LIKE query reports no rank rather than a perfect one", () => {
  const { env, history, group } = scoringEnv();
  try {
    const message = env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "unranked path arrow --> marker" }
    });
    // No letters or digits, so buildFtsQuery has nothing to match on and the
    // search is answered entirely by searchRowsLike.
    const real = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "-->"
    });
    expect(real.results).toHaveLength(1);

    // Score the very same indexed entry by hand, once as the LIKE path reports
    // it and once as it used to. The real search must match the first and not the
    // second: what the LIKE query selects is what decides which branch of
    // scoreThreads runs.
    const row = env.store.db.prepare(
      "select * from agent_message_search_entries where message_id = ?"
    ).get(message.id) as any;
    const unranked = group([{ ...row, rank: null }]);
    const asPerfect = group([{ ...row, rank: 0 }]);

    expect(real.results[0]!.score).toBeCloseTo(unranked[0].score, 10);
    expect(asPerfect[0].score - unranked[0].score).toBeCloseTo(0.72 * (1 - 0.5), 10);
  } finally {
    env.cleanup();
  }
});

test("scoring: an all-FTS search is unchanged by the LIKE relevance constant", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  try {
    // Both groups are ranked, so the unranked branch is never taken and neither
    // score can depend on LIKE_MATCH_RELEVANCE at all. FTS5 makes a better match
    // more negative, so bm25 -7 is the better match of the two and it leads.
    const results = group([
      ...rows(env.thread.id, 1, -1),
      ...rows(second.id, 1, -7)
    ]);

    expect(results.map((r: any) => r.thread.id)).toEqual([second.id, env.thread.id]);
    // The qualities are |-7| = 7 and |-1| = 1, which are this set's high and low,
    // so they normalize to 1 and 0 and the entire relevance weight separates
    // them. Every other term is equal here by construction.
    expect(scoreOf(results, second.id) - scoreOf(results, env.thread.id))
      .toBeCloseTo(0.72, 10);
  } finally {
    env.cleanup();
  }
});

test("scoring: an all-LIKE search keeps its order whatever the constant is", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  try {
    // Every group is unranked, so every group gets the same relevance and the
    // relevance term cancels out of every comparison. What is left is hits and
    // recency -- so the order of a homogeneous LIKE search cannot depend on the
    // constant's value at all.
    const results = group([
      ...rows(env.thread.id, 3, null),
      ...rows(second.id, 1, null)
    ]);

    expect(results.map((r: any) => r.thread.id)).toEqual([env.thread.id, second.id]);
    // Hits are now normalized across the set rather than boosted by a saturating
    // min(0.25, n * 0.04): 3 is this set's high and 1 its low, so they map to 1
    // and 0 and the difference is the whole 0.2 weight.
    expect(scoreOf(results, env.thread.id) - scoreOf(results, second.id))
      .toBeCloseTo(0.2, 10);
  } finally {
    env.cleanup();
  }
});

test("scoring: a mixed search treats its LIKE half as neutral", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  try {
    // The LIKE path used to select `0 as rank`, which 1 / (1 + |rank|) read as a
    // flawless match: relevance 1.0, the ceiling, so the LIKE group outranked
    // every ranked group no matter how well it matched. Which retrieval path
    // answered is not a quality signal, so a LIKE group is now worth the midpoint
    // of the scale the ranked groups normalize onto -- neither the ceiling it used
    // to take nor the floor -- and where the set leaves a lone bm25 nothing to be
    // placed against, every group is worth that midpoint.
    const overview = rows(env.caller.id, 1, null);

    // Exactly one ranked group is the shape a mixed search almost always takes,
    // because the overview thread is a singleton: whichever half fell back to
    // LIKE, the other half is usually one group. A single bm25 is not a span --
    // nothing in the set is commensurable with it -- so quality is inert for
    // every group here and the ordering falls to hits and recency. Equal hits, so
    // it falls all the way to recency and the gap is exactly that weight.
    const better = group([
      ...rows(env.thread.id, 1, -1, "2026-05-01T00:00:00.000Z"),
      ...overview
    ]);
    expect(better.map((r: any) => r.thread.id)).toEqual([env.caller.id, env.thread.id]);
    expect(scoreOf(better, env.caller.id) - scoreOf(better, env.thread.id))
      .toBeCloseTo(0.08, 10);

    // Inert means inert at either end of the scale: a strong bm25 buys the lone
    // ranked group nothing either, so the unranked group's extra hits carry it.
    // This is where the old formula was backwards -- a bm25 of -7 scored *below*
    // one of -1 there -- and where the fix for that overshot: a degenerate span
    // handed the lone ranked group the ceiling of 1 against the midpoint, so it
    // led on quality alone whatever its bm25.
    const strong = group([...rows(second.id, 1, -7), ...rows(env.caller.id, 3, null)]);
    expect(strong.map((r: any) => r.thread.id)).toEqual([env.caller.id, second.id]);
    expect(scoreOf(strong, env.caller.id) - scoreOf(strong, second.id))
      .toBeCloseTo(0.2, 10);

    // Neutral means neither end, which only two ranked groups can show: with a
    // real quality span (|-12| and |-6|) the LIKE group has to land between them.
    // This is the half a careless edit is most likely to break -- sinking LIKE
    // groups would punish whichever half of a search fell back, and 39 of 45
    // measured mixed-path searches had the project half on LIKE.
    const spread = group([
      ...rows(env.thread.id, 1, -12),
      ...rows(second.id, 1, -6),
      ...overview
    ]);
    expect(spread.map((r: any) => r.thread.id))
      .toEqual([env.thread.id, env.caller.id, second.id]);
    // Asserted on scores as well as order, because at LIKE_MATCH_RELEVANCE = 1
    // the LIKE group ties the best ranked group and a stable sort would keep the
    // order above regardless.
    expect(scoreOf(spread, env.caller.id)).toBeLessThan(scoreOf(spread, env.thread.id));
    expect(scoreOf(spread, env.caller.id)).toBeGreaterThan(scoreOf(spread, second.id));
  } finally {
    env.cleanup();
  }
});

test("search: an archived feature still hides its history by default", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "archived feature owner marker" }
    });
    // The thread itself stays live, so the LEFT JOINed features row is the only
    // thing that can hide this entry -- exactly as the INNER JOIN did.
    env.store.db.prepare("update features set archived_at = ? where id = ?")
      .run(new Date().toISOString(), env.featureId);

    const hidden = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "archived feature owner marker"
    });
    expect(hidden.results).toHaveLength(0);

    const included = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "archived feature owner marker",
      includeArchived: true
    });
    expect(included.results).toHaveLength(1);
    expect(included.results[0]!.thread.scope).toBe("worker");
  } finally {
    env.cleanup();
  }
});

test("search: an archived project still hides its history by default", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "archived project owner marker" }
    });
    env.store.db.prepare("update projects set archived_at = ? where id = ?")
      .run(new Date().toISOString(), env.projectId);

    // The public path never reaches the row filter here: getProject rejects an
    // archived project outright.
    expect(() => history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "archived project owner marker"
    })).toThrow(/project_not_found/);

    // So drive the filter directly to see it drop the row on its own, which is
    // what the INNER JOIN's `p.archived_at is null` used to guarantee.
    const rows = (history as any).searchRows({
      query: "archived project owner marker",
      projectId: env.projectId,
      featureId: null,
      threadId: null,
      timeRange: { preset: "all", since: null, until: null, reason: "archived project unit test" },
      includeArchived: false,
      excludedThreads: new Set<string>(),
      limit: 25
    });
    expect(rows).toHaveLength(0);

    const included = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "archived project owner marker",
      includeArchived: true
    });
    expect(included.results).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});

test("search: an archived overview thread still hides its global history by default", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "archived overview owner marker" }
    });
    // Archiving the live overview thread and taking the fresh one is what
    // production looks like: many archived overview threads, one live.
    env.agentStore.archiveThread(env.caller.id);
    const live = env.agentStore.getOrCreateThread("manager", null);
    expect(live.id).not.toBe(env.caller.id);

    // A global entry has no feature or project to be archived, so the thread's
    // own archived_at is the only thing that can hide it.
    const hidden = history.search({
      callerThreadId: live.id,
      projectId: env.projectId,
      query: "archived overview owner marker"
    });
    expect(hidden.results).toHaveLength(0);

    const included = history.search({
      callerThreadId: live.id,
      projectId: env.projectId,
      query: "archived overview owner marker",
      includeArchived: true
    });
    expect(included.results).toHaveLength(1);
    expect(included.results[0]!.thread.scope).toBe("manager");
    expect(included.results[0]!.thread.archivedAt).toBeTruthy();
  } finally {
    env.cleanup();
  }
});

test("scope isolation: a feature agent cannot name an overview thread", () => {
  const env = setup();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "overview thread filter probe" }
    });

    expect(() => history.search({
      callerThreadId: env.thread.id,
      query: "overview thread filter probe",
      threadId: env.caller.id
    })).toThrow(/thread_out_of_scope/);
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
        source: "agent",
        content: { type: "text", text: `${filler} quilloscope ${filler}` }
      });
    }

    const result = await env.search.handler(
      { projectId: env.projectId, query: "quilloscope" } as any,
      { threadId: env.caller.id, wakeId: "wake-rank", scope: { kind: "manager" } } as any
    );

    expect((result as any).results.length).toBe(2);
    expect((result as any).results[0].thread.featureId).toBe(denseFeature);
    expect((result as any).results[0].hitCount).toBe(1);
    expect((result as any).results[1].hitCount).toBe(6);

    // The same set under an explicit limit. Both threads still match, so a limit
    // that is not honored returns them both and leaves the payload cap as the
    // only brake on how much a search can hand back.
    const limited = await env.search.handler(
      { projectId: env.projectId, query: "quilloscope", limit: 1 } as any,
      { threadId: env.caller.id, wakeId: "wake-rank-limit", scope: { kind: "manager" } } as any
    );

    expect((limited as any).results.length).toBe(1);
    expect((limited as any).results[0].thread.featureId).toBe(denseFeature);
  } finally {
    env.cleanup();
  }
});
