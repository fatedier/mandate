import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { agentRoleOf, agentRoleWhere, wakeGroupOf, TIMER_WAKE_REASONS } from "../src/server/modules/activity/ledger-roles.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

test("roles from purpose and thread scope", () => {
  expect(agentRoleOf("agent_wake_step", "global", true)).toBe("your_agent");
  expect(agentRoleOf("agent_wake_step", "manager", true)).toBe("managers");
  expect(agentRoleOf("agent_wake_step", "worker", true)).toBe("workers");
  // A deleted thread whose call recorded its scope.
  expect(agentRoleOf("agent_wake_step", "manager", false)).toBe("managers");
  expect(agentRoleOf("agent_wake_step", null, false)).toBe("deleted_thread");
  // A thread that exists with a scope no role names.
  expect(agentRoleOf("agent_wake_step", "project", true)).toBe("purpose:agent_wake_step");
  expect(agentRoleOf("page_subagent_step", "subagent", true)).toBe("your_agents_page");
  expect(agentRoleOf("subagent_step", "subagent", true)).toBe("subagents");
  // Any purpose but a step ignores its thread's scope.
  expect(agentRoleOf("odd_purpose", "global", true)).toBe("purpose:odd_purpose");
  expect(["memory_dream", "agent_compression", "memory_extraction", "memory_repeat_check", "manager_request_check", "manager_stop_check", "web_search"].map((p) => agentRoleOf(p, null, false)))
    .toEqual(["dream", "compaction", "memory_extraction", "memory_repeat_check", "manager_request_check", "manager_stop_check", "web_search"]);
  expect(agentRoleOf("some_new_purpose", null, false)).toBe("purpose:some_new_purpose");
  // A purpose called like a role is still told apart from it.
  expect(agentRoleOf("dream", null, false)).toBe("purpose:dream");
});

test("wake groups and timers", () => {
  expect(wakeGroupOf("user")).toEqual({ key: "messages", timer: false });
  expect(wakeGroupOf("alarm")).toEqual({ key: "alarms", timer: true });
  expect(wakeGroupOf("work-item-heartbeat")).toEqual({ key: "check_ins", timer: true });
  expect(wakeGroupOf("worker-report")).toEqual({ key: "worker_reports", timer: false });
  expect(wakeGroupOf("thread-notice")).toEqual({ key: "thread_notices", timer: false });
  expect(wakeGroupOf("watch")).toEqual({ key: "watches", timer: false });
  expect(wakeGroupOf("monitor")).toEqual({ key: "watches", timer: false });
  expect(wakeGroupOf("command-result")).toEqual({ key: "command_results", timer: false });
  expect(wakeGroupOf("subagent-task").key).toBe("subagent_tasks");
  expect(wakeGroupOf("subagent-result").key).toBe("subagent_tasks");
  expect(wakeGroupOf(null)).toEqual({ key: "unknown", timer: false });
  expect(wakeGroupOf("brand-new")).toEqual({ key: "brand-new", timer: false });
  // Own keys only: a reason named like an object's built-ins is a reason.
  expect(wakeGroupOf("toString")).toEqual({ key: "toString", timer: false });
  expect([...TIMER_WAKE_REASONS]).toEqual(["alarm", "work-item-heartbeat"]);
});

function seed(db: Database) {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const thread = db.prepare("insert into agent_threads (id, scope, created_at, updated_at) values (?, ?, ?, ?)");
  thread.run("t-global", "global", at, at);
  thread.run("t-manager", "manager", at, at);
  const call = db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, model, status, started_at, created_at, updated_at, metadata_json)
    values (?, ?, ?, ?, 'openai-compatible', 'm', 'succeeded', ?, ?, ?, ?)`);
  call.run("c-global", "agent_wake_step", "agent_thread", "t-global", at, at, at, JSON.stringify({ wakeId: "w1" }));
  call.run("c-manager", "agent_wake_step", "agent_thread", "t-manager", at, at, at, null);
  // Deleted threads: one whose call recorded its scope, one from before that.
  call.run("c-gone-manager", "agent_wake_step", "agent_thread", "t-gone-1", at, at, at, JSON.stringify({ threadScope: "manager" }));
  call.run("c-gone", "agent_wake_step", "agent_thread", "t-gone-2", at, at, at, JSON.stringify({ wakeId: "w2" }));
  call.run("c-bad", "agent_wake_step", "agent_thread", "t-gone-3", at, at, at, "{not json");
  call.run("c-dream", "memory_dream", "memory", "global", at, at, at, null);
  call.run("c-page", "page_subagent_step", "agent_thread", "t-page", at, at, at, JSON.stringify({ threadScope: "subagent" }));
  call.run("c-odd", "odd_purpose", "agent_thread", "t-global", at, at, at, null);
  call.run("c-raw-dream", "dream", "memory", "x", at, at, at, null);
  thread.run("t-project", "project", at, at);
  call.run("c-project", "agent_wake_step", "agent_thread", "t-project", at, at, at, null);
  // A deleted thread's call whose recorded scope is empty or not text: no scope at all.
  call.run("c-empty-scope", "agent_wake_step", "agent_thread", "t-gone-4", at, at, at, JSON.stringify({ threadScope: "" }));
  call.run("c-number-scope", "agent_wake_step", "agent_thread", "t-gone-5", at, at, at, JSON.stringify({ threadScope: 5 }));
}

function idsFor(db: Database, role: string): string[] {
  const where = agentRoleWhere(role);
  return (db.prepare(`select id from llm_calls where ${where.sql} order by id`).all(...where.params) as Array<{ id: string }>).map((r) => r.id);
}

test("agentRoleWhere selects the role's rows, deleted threads included", () => {
  const env = freshStoresEnv();
  const db = env.store.db;
  seed(db);
  expect(idsFor(db, "your_agent")).toEqual(["c-global"]);
  expect(idsFor(db, "managers")).toEqual(["c-gone-manager", "c-manager"]);
  expect(idsFor(db, "deleted_thread")).toEqual(["c-bad", "c-empty-scope", "c-gone", "c-number-scope"]);
  expect(idsFor(db, "dream")).toEqual(["c-dream"]);
  expect(idsFor(db, "your_agents_page")).toEqual(["c-page"]);
  expect(idsFor(db, "workers")).toEqual([]);
  // A bare purpose's role, and roles no call can have.
  expect(idsFor(db, "purpose:odd_purpose")).toEqual(["c-odd"]);
  expect(idsFor(db, "purpose:dream")).toEqual(["c-raw-dream"]);
  expect(idsFor(db, "dream")).toEqual(["c-dream"]);
  expect(idsFor(db, "purpose:memory_dream")).toEqual([]);
  expect(idsFor(db, "memory_dream")).toEqual([]);
  expect(idsFor(db, "purpose:agent_wake_step")).toEqual(["c-project"]);
});

// A cache seal is a call of its own.
test("a seal is the Cache seal role", () => {
  expect(agentRoleOf("agent_cache_seal", "manager", true)).toBe("cache_seal");
  expect(agentRoleWhere("cache_seal")).toEqual({ sql: "(purpose = ?)", params: ["agent_cache_seal"] });
});
