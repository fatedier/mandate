import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { freshAgentEnv } from "./helpers/fixtures.js";

const setup = () => freshAgentEnv("md-store-ov-");

test("agent-store: manager thread is a singleton (active)", () => {
  const { agentStore: agent, cleanup } = setup();
  try {
    const a = agent.getOrCreateThread("manager", null);
    const b = agent.getOrCreateThread("manager", null);
    expect(a.id).toBe(b.id);
    expect(a.scope).toBe("manager");
    expect(a.scopeId).toBe(null);
  } finally { cleanup(); }
});

test("agent-store: archiving manager lets a fresh one be created", () => {
  const { agentStore: agent, cleanup } = setup();
  try {
    const a = agent.getOrCreateThread("manager", null);
    agent.archiveThread(a.id);
    const b = agent.getOrCreateThread("manager", null);
    expect(a.id).not.toBe(b.id);
    expect(b.scope).toBe("manager");
    const archived = agent.getThreadById(a.id);
    expect(archived?.archivedAt).toBeTruthy();
  } finally { cleanup(); }
});

test("agent-store: cannot create a second active manager thread (DB-enforced)", () => {
  const { agentStore: agent, store, cleanup } = setup();
  try {
    agent.getOrCreateThread("manager", null);
    const db = (store as any).db as Database;
    expect(() => {
      db.prepare(
        `insert into agent_threads (id, scope, scope_id, created_at, updated_at)
         values ('forced', 'manager', null, ?, ?)`
      ).run(new Date().toISOString(), new Date().toISOString());
    }).toThrow(/UNIQUE/);
  } finally { cleanup(); }
});
