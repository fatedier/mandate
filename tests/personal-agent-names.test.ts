import { expect, test } from "bun:test";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

// The agent above every thread is the personal agent in what is stored too:
// its tables, columns, indexes, its thread's scope and its config keys.

test("a fresh database names the personal agent's tables, columns and indexes personal", () => {
  const env = freshStoresEnv("md-personal-names-");
  const rows = env.store.db.prepare("select name, sql from sqlite_master where name not like 'sqlite_%'").all() as Array<{ name: string; sql: string | null }>;
  expect(rows.filter((row) => /global/i.test(row.name) || /global/i.test(row.sql ?? "")).map((row) => row.name)).toEqual([]);
  const names = new Set(rows.map((row) => row.name));
  for (const name of ["personal_handoffs", "personal_thread_tabs", "idx_personal_handoffs_target", "idx_personal_handoffs_state", "idx_agent_threads_personal_singleton"]) {
    expect(names.has(name)).toBe(true);
  }
  const columns = (env.store.db.prepare("select name from pragma_table_info('personal_handoffs')").all() as Array<{ name: string }>).map((row) => row.name);
  expect(columns).toContain("personal_thread_id");
});

test("the personal agent's thread is stored with the scope personal, and only one is open", () => {
  const env = freshStoresEnv("md-personal-scope-");
  const thread = env.agentStore.getOrCreatePersonalThread();
  expect(thread.scope).toBe("personal");
  expect((env.store.db.prepare("select scope from agent_threads where id = ?").get(thread.id) as { scope: string }).scope).toBe("personal");
  expect(() => env.store.db.prepare("insert into agent_threads (id, scope, scope_id, created_at, updated_at) values ('thr_second', 'personal', null, 'x', 'x')").run()).toThrow(/UNIQUE/);
});

test("config.json keeps the personal agent's route and name under personal", () => {
  const file = { agent: { personalAgentName: "Ada", routes: { personal: { model: "p/g", fallbacks: [{ model: "p/h" }] } } } };
  const flat = flatFromFile(file);
  expect(flat).toEqual({ agent: { personalAgentName: "Ada", personalModel: { model: "p/g" }, personalModelFallbacks: [{ model: "p/h" }] } });
  expect(fileFromFlat(flat)).toEqual(file);
});
