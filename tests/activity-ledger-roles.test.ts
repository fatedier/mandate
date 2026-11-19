import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { agentRoleOf, agentRoleWhere, wakeGroupOf, TIMER_WAKE_REASONS } from "../src/server/modules/activity/ledger-roles.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

test("roles from purpose and thread scope", () => {
  expect(agentRoleOf("agent_wake_step", "personal")).toBe("personal_agent");
  expect(agentRoleOf("agent_wake_step", "manager")).toBe("managers");
  expect(agentRoleOf("agent_wake_step", "worker")).toBe("workers");
  // A step with a scope no role names, or none at all, is a bare step.
  expect(agentRoleOf("agent_wake_step", "project")).toBe("purpose:agent_wake_step");
  expect(agentRoleOf("agent_wake_step", null)).toBe("purpose:agent_wake_step");
  expect(agentRoleOf("page_subagent_step", "subagent")).toBe("personal_agent_page");
  expect(agentRoleOf("subagent_step", "subagent")).toBe("subagents");
  // Any purpose but a step ignores its thread's scope.
  expect(agentRoleOf("odd_purpose", "personal")).toBe("purpose:odd_purpose");
  expect(["memory_dream", "agent_compression", "memory_extraction", "memory_repeat_check", "manager_request_check", "manager_stop_check", "web_search", "tool_review"].map((p) => agentRoleOf(p, null)))
    .toEqual(["dream", "compaction", "memory_extraction", "memory_repeat_check", "manager_request_check", "manager_stop_check", "web_search", "tool_review"]);
  expect(agentRoleOf("some_new_purpose", null)).toBe("purpose:some_new_purpose");
  // A purpose called like a role is still told apart from it.
  expect(agentRoleOf("dream", null)).toBe("purpose:dream");
  // A requested skill review's calls are its own role.
  expect(agentRoleOf("skill_review", "worker")).toBe("skill_review");
});

test("wake groups and timers", () => {
  expect(wakeGroupOf("user")).toEqual({ key: "messages", timer: false });
  expect(wakeGroupOf("alarm")).toEqual({ key: "alarms", timer: true });
  expect(wakeGroupOf("sweep")).toEqual({ key: "worker_checks", timer: true });
  expect(wakeGroupOf("worker-report")).toEqual({ key: "worker_reports", timer: false });
  expect(wakeGroupOf("thread-notice")).toEqual({ key: "thread_notices", timer: false });
  expect(wakeGroupOf("pane-monitor")).toEqual({ key: "monitors", timer: false });
  expect(wakeGroupOf("command-monitor")).toEqual({ key: "monitors", timer: false });
  expect(wakeGroupOf("command-result")).toEqual({ key: "command_results", timer: false });
  expect(wakeGroupOf("subagent-task").key).toBe("subagent_tasks");
  expect(wakeGroupOf("subagent-result").key).toBe("subagent_tasks");
  expect(wakeGroupOf(null)).toEqual({ key: "unknown", timer: false });
  expect(wakeGroupOf("brand-new")).toEqual({ key: "brand-new", timer: false });
  // Own keys only: a reason named like an object's built-ins is a reason.
  expect(wakeGroupOf("toString")).toEqual({ key: "toString", timer: false });
  expect(wakeGroupOf("schedule")).toEqual({ key: "scheduled_checks", timer: true });
  expect(wakeGroupOf("calendar")).toEqual({ key: "calendar", timer: true });
  expect([...TIMER_WAKE_REASONS]).toEqual(["alarm", "sweep", "schedule", "calendar"]);
});

function seed(db: Database) {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const thread = db.prepare("insert into agent_threads (id, scope, created_at, updated_at) values (?, ?, ?, ?)");
  thread.run("t-global", "personal", at, at);
  thread.run("t-manager", "manager", at, at);
  const call = db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, model, status, started_at, created_at, updated_at, metadata_json)
    values (?, ?, ?, ?, 'openai-compatible', 'm', 'succeeded', ?, ?, ?, ?)`);
  call.run("c-global", "agent_wake_step", "agent_thread", "t-global", at, at, at, JSON.stringify({ wakeId: "w1", threadScope: "personal" }));
  call.run("c-manager", "agent_wake_step", "agent_thread", "t-manager", at, at, at, JSON.stringify({ threadScope: "manager" }));
  // A deleted thread: its call recorded its scope.
  call.run("c-gone-manager", "agent_wake_step", "agent_thread", "t-gone-1", at, at, at, JSON.stringify({ threadScope: "manager" }));
  // Metadata no writer leaves, read without taking the statement down: no scope.
  call.run("c-bad", "agent_wake_step", "agent_thread", "t-gone-3", at, at, at, "{not json");
  call.run("c-dream", "memory_dream", "memory", "global", at, at, at, null);
  call.run("c-page", "page_subagent_step", "agent_thread", "t-page", at, at, at, JSON.stringify({ threadScope: "subagent" }));
  call.run("c-odd", "odd_purpose", "agent_thread", "t-global", at, at, at, null);
  call.run("c-raw-dream", "dream", "memory", "x", at, at, at, null);
  thread.run("t-project", "project", at, at);
  call.run("c-project", "agent_wake_step", "agent_thread", "t-project", at, at, at, JSON.stringify({ threadScope: "project" }));
  // A recorded scope that is empty or not text: no scope at all.
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
  expect(idsFor(db, "personal_agent")).toEqual(["c-global"]);
  expect(idsFor(db, "managers")).toEqual(["c-gone-manager", "c-manager"]);
  expect(idsFor(db, "dream")).toEqual(["c-dream"]);
  expect(idsFor(db, "personal_agent_page")).toEqual(["c-page"]);
  expect(idsFor(db, "workers")).toEqual([]);
  // A bare purpose's role, and roles no call can have.
  expect(idsFor(db, "purpose:odd_purpose")).toEqual(["c-odd"]);
  expect(idsFor(db, "purpose:dream")).toEqual(["c-raw-dream"]);
  expect(idsFor(db, "purpose:memory_dream")).toEqual([]);
  expect(idsFor(db, "memory_dream")).toEqual([]);
  expect(idsFor(db, "purpose:agent_wake_step")).toEqual(["c-bad", "c-empty-scope", "c-number-scope", "c-project"]);
  expect(idsFor(db, "deleted_thread")).toEqual([]);
});

// Every step records its thread's scope (older steps were filled in
// when the column was added), so the role is read from the step, never from a join to its
// thread: one that says otherwise does not change it.
test("a step's role is the scope it recorded, whatever its thread's row says", () => {
  const env = freshStoresEnv();
  const db = env.store.db;
  const at = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare("insert into agent_threads (id, scope, created_at, updated_at) values ('t-x', 'manager', ?, ?)").run(at, at);
  db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, model, status, started_at, created_at, updated_at, metadata_json)
    values ('c-x', 'agent_wake_step', 'agent_thread', 't-x', 'openai-compatible', 'm', 'succeeded', ?, ?, ?, ?)`)
    .run(at, at, at, JSON.stringify({ threadScope: "worker" }));
  expect(idsFor(db, "workers")).toEqual(["c-x"]);
  expect(idsFor(db, "managers")).toEqual([]);
});

// A cache seal is a call of its own.
test("a seal is the Cache seal role", () => {
  expect(agentRoleOf("agent_cache_seal", "manager")).toBe("cache_seal");
  expect(agentRoleWhere("cache_seal")).toEqual({ sql: "(purpose = ?)", params: ["agent_cache_seal"] });
});

// A side chat's calls are a role of their own: its steps and its summaries
// (which calls each selects: tests/side-chat-scope.test.ts).
test("a side chat's call is the Side chat role", () => {
  expect(agentRoleOf("side_chat", "personal")).toBe("side_chat");
  expect(agentRoleOf("agent_wake_step", "side_chat")).toBe("side_chat");
});

// The call after a finished piece of work counts with the skill reviews,
// and the role's log lists both kinds.
test("the Skill review role holds the reviews and the calls that may ask for one", () => {
  expect(agentRoleOf("skill_review_nudge", "manager")).toBe("skill_review");
  const env = freshStoresEnv();
  const db = env.store.db;
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const call = db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, model, status, started_at, created_at, updated_at)
    values (?, ?, ?, ?, 'openai-compatible', 'm', 'succeeded', ?, ?, ?)`);
  call.run("c-review", "skill_review", "agent_thread", "t-w", at, at, at);
  call.run("c-nudge", "skill_review_nudge", "agent_thread", "t-m", at, at, at);
  expect(idsFor(db, "skill_review")).toEqual(["c-nudge", "c-review"]);
});
