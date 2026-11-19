import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { tempDir } from "./helpers/temp.js";

// A message's seq is its place in its thread: taken as the thread's last plus
// one and written in one step that holds the write lock, so two writers
// (connections of their own, as a worker's would be) never take the same one;
// and the database refuses a second row at a thread's seq.

const seqIndex = (db: Database) => (db.prepare("select \"unique\" as u from pragma_index_list('agent_messages') where name = 'idx_agent_messages_thread_seq'").get() as { u: number } | null)?.u ?? null;

async function race(dir: string, threadId: string, count: number): Promise<Array<{ done: boolean; error?: string }>> {
  const workers = ["a", "b"].map((tag) => {
    const worker = new Worker(new URL("./helpers/append-worker.ts", import.meta.url).href);
    const result = new Promise<{ done: boolean; error?: string }>((resolve) => {
      worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
      // A worker that dies outside its try is a result too, not a wait to the test's limit.
      worker.onerror = (e) => { resolve({ done: false, error: e.message }); worker.terminate(); };
    });
    return { worker, result, tag };
  });
  for (const { worker, tag } of workers) worker.postMessage({ dir, threadId, count, tag });
  return Promise.all(workers.map((w) => w.result));
}

test("two writers appending to one thread at once each take a seq of their own, with none left out", async () => {
  const dir = tempDir("md-seq-race-");
  const store = new MandateStore(dir);
  const thread = new AgentStore(store.db).getOrCreateThread("manager", null);
  store.db.close();
  const results = await race(dir, thread.id, 300);
  expect(results).toEqual([{ done: true }, { done: true }]);
  const db = new Database(path.join(dir, "mandate.db"), { readonly: true });
  try {
    const row = db.prepare("select count(*) as n, count(distinct seq) as d, max(seq) as top from agent_messages where thread_id = ? and source = 'self'").get(thread.id) as { n: number; d: number; top: number };
    expect(row).toEqual({ n: 600, d: 600, top: 600 });
  } finally {
    db.close();
  }
}, 30_000);

test("the database refuses a second message at a thread's seq", () => {
  const dir = tempDir("md-seq-unique-");
  const store = new MandateStore(dir);
  try {
    expect(seqIndex(store.db)).toBe(1);
    const agent = new AgentStore(store.db);
    const thread = agent.getOrCreateThread("manager", null);
    const first = agent.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "one" } });
    expect(() => agent.appendMessage({ threadId: thread.id, role: "user", source: "user", seq: first.seq, content: { type: "text", text: "again" } })).toThrow(/UNIQUE/);
  } finally {
    store.db.close();
  }
});
