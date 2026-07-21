import { expect, test } from "bun:test";
import { freshStoresEnv } from "./helpers/fixtures.js";

/**
 * Seeds one call at an exact timestamp. Sharing a `created_at` across rows is
 * the whole point here: `nowIso()` is whole-millisecond, so parallel agent
 * wakes can land several calls in one, and that is where a cursor that carries
 * only a timestamp loses rows.
 */
function seed(db: import("bun:sqlite").Database, id: string, createdAt: string) {
  db.prepare(`
    insert into llm_calls
      (id, purpose, provider, request_hash, response_hash, status,
       started_at, finished_at, latency_ms, created_at, updated_at)
    values (?, 'agent_wake_step', 'openai-compatible', 'rq', 'rs', 'succeeded',
            ?, ?, 100, ?, ?)
  `).run(id, createdAt, createdAt, createdAt, createdAt);
}

type PagedRow = { id: string; createdAt: string };
type Pager = {
  listLlmCallSummaries: (limit: number, filters: Record<string, string>) => PagedRow[];
};

/** Walks every page the way the Logs tab does, and returns the ids in order. */
function pageThrough(store: Pager, pageSize: number): string[] {
  const seen: string[] = [];
  let cursor: { before: string; beforeId: string } | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = store.listLlmCallSummaries(pageSize, cursor ?? {});
    if (page.length === 0) break;
    seen.push(...page.map((row) => row.id));
    const last = page[page.length - 1]!;
    cursor = { before: last.createdAt, beforeId: last.id };
  }
  return seen;
}

test("paging past a boundary that several calls share loses none of them", () => {
  const env = freshStoresEnv("md-llm-page-");
  try {
    // Five calls in one millisecond, with a distinct call on either side. A
    // page size of two puts the boundary inside the shared group twice over.
    seed(env.store.db, "call_newest", "2026-08-04T00:00:02.000Z");
    for (let i = 0; i < 5; i += 1) {
      seed(env.store.db, `call_tied_${i}`, "2026-08-04T00:00:01.000Z");
    }
    seed(env.store.db, "call_oldest", "2026-08-04T00:00:00.000Z");

    const seen = pageThrough(env.store, 2);

    // Every row exactly once. With a timestamp-only cursor the second page asks
    // for `created_at < 00:00:01.000` and the three unread tied rows are gone.
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe("call_newest");
    expect(seen.at(-1)).toBe("call_oldest");
    // The tied rows keep one stable order rather than an arbitrary one, which
    // is what makes the cursor resumable at all.
    expect(seen.slice(1, 6)).toEqual([
      "call_tied_4", "call_tied_3", "call_tied_2", "call_tied_1", "call_tied_0"
    ]);
  } finally {
    env.cleanup();
  }
});

test("a cursor without its id still pages, and is the reason the id is sent", () => {
  const env = freshStoresEnv("md-llm-page-legacy-");
  try {
    for (let i = 0; i < 3; i += 1) {
      seed(env.store.db, `call_tied_${i}`, "2026-08-04T00:00:01.000Z");
    }
    seed(env.store.db, "call_oldest", "2026-08-04T00:00:00.000Z");

    // `before` alone remains a legal cursor — the older behaviour — and this is
    // what it costs: asking past the tied group skips the two rows in it that
    // the first page did not return.
    const first = env.store.listLlmCallSummaries(1, {});
    const next = env.store.listLlmCallSummaries(10, { before: first[0]!.createdAt });
    expect(next.map((row: { id: string }) => row.id)).toEqual(["call_oldest"]);
  } finally {
    env.cleanup();
  }
});
