import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getMemoryStats, listMemoryEntries } from "../src/server/modules/memory/browse.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

let seq = 0;

/**
 * Insert straight into the table: the recall columns these queries band on are
 * written by the recall path, not by `remember()`, and the point here is to pin
 * the banding rather than to exercise how a memory gets recalled.
 */
function insert(
  db: Database,
  row: {
    createdAt: string;
    recallCount?: number;
    lastRecalledAt?: string | null;
    useCount?: number;
    status?: string;
    scope?: string;
    kind?: string;
    projectId?: string | null;
    featureId?: string | null;
    content?: string;
  }
) {
  const id = `mem_test_${++seq}`;
  db.prepare(
    `insert into memory_entries
       (id, scope, project_id, feature_id, kind, status, content, strength, confidence,
        cues_json, source, created_at, updated_at, last_recalled_at, recall_count,
        last_used_at, use_count, feedback_json, metadata_json)
     values (?, ?, ?, ?, ?, ?, ?, 1.0, 0.9, '[]', 'manual', ?, ?, ?, ?, null, ?, '{}', null)`
  ).run(
    id,
    row.scope ?? "global",
    row.projectId ?? null,
    row.featureId ?? null,
    row.kind ?? "semantic",
    row.status ?? "available",
    row.content ?? `entry ${id}`,
    row.createdAt,
    row.createdAt,
    row.lastRecalledAt ?? null,
    row.recallCount ?? 0,
    row.useCount ?? 0
  );
  return id;
}

/** A store covering every usage band, plus one archived row that must be ignored. */
function seeded() {
  const env = freshStoresEnv("md-browse-");
  const db = env.store.db;
  const ids = {
    // Recalled and actually leaned on.
    used: insert(db, { createdAt: daysAgo(200), recallCount: 40, lastRecalledAt: daysAgo(2), useCount: 12 }),
    // Retrieved repeatedly, never once used.
    idleFresh: insert(db, { createdAt: daysAgo(5), recallCount: 3, lastRecalledAt: daysAgo(1) }),
    idleOld: insert(db, { createdAt: daysAgo(120), recallCount: 9, lastRecalledAt: daysAgo(1) }),
    // Never even retrieved.
    untouched: insert(db, { createdAt: daysAgo(120) }),
    archived: insert(db, { createdAt: daysAgo(300), status: "archived", recallCount: 0 })
  };
  return { env, db, ids };
}

describe("usage banding", () => {
  test("splits available memories into used, idle and untouched", () => {
    const { env, db } = seeded();
    try {
      const stats = getMemoryStats(db);
      expect(stats.usage.used).toBe(1);
      expect(stats.usage.idle).toBe(2);
      expect(stats.usage.untouched).toBe(1);
    } finally {
      env.cleanup?.();
    }
  });

  test("the three bands account for every available memory, and no archived one", () => {
    const { env, db } = seeded();
    try {
      const stats = getMemoryStats(db);
      const banded = stats.usage.used + stats.usage.idle + stats.usage.untouched;
      expect(banded).toBe(stats.totals.available);
      expect(stats.totals.archived).toBe(1);
    } finally {
      env.cleanup?.();
    }
  });

  test("recall alone does not make a memory used — that is the whole distinction", () => {
    const env = freshStoresEnv("md-browse-gap-");
    try {
      insert(env.store.db, { createdAt: daysAgo(10), recallCount: 300, useCount: 0 });
      const stats = getMemoryStats(env.store.db);
      expect(stats.usage.idle).toBe(1);
      expect(stats.usage.used).toBe(0);
    } finally {
      env.cleanup?.();
    }
  });

});

describe("usage filter", () => {
  const only = (db: Database, usage: Parameters<typeof listMemoryEntries>[1]["usage"]) =>
    listMemoryEntries(db, { usage, status: "available" });

  test("each band returns exactly its own memories", () => {
    const { env, db, ids } = seeded();
    try {
      expect(only(db, "used").entries.map((e) => e.id)).toEqual([ids.used]);
      expect(only(db, "idle").entries.map((e) => e.id).sort()).toEqual(
        [ids.idleFresh, ids.idleOld].sort()
      );
      expect(only(db, "untouched").entries.map((e) => e.id)).toEqual([ids.untouched]);
    } finally {
      env.cleanup?.();
    }
  });

  test("`all` and an absent filter both mean no filtering", () => {
    const { env, db } = seeded();
    try {
      expect(only(db, "all").total).toBe(4);
      expect(listMemoryEntries(db, { status: "available" }).total).toBe(4);
    } finally {
      env.cleanup?.();
    }
  });

  test("total reflects the filter, not the whole table — pagination depends on it", () => {
    const { env, db } = seeded();
    try {
      expect(only(db, "untouched").total).toBe(1);
    } finally {
      env.cleanup?.();
    }
  });
});

describe("sorting", () => {
  test("recalled puts the most-recalled first; oldest puts the earliest first", () => {
    const { env, db, ids } = seeded();
    try {
      const byRecall = listMemoryEntries(db, { sort: "recalled", status: "available" });
      expect(byRecall.entries[0]!.id).toBe(ids.used);

      const oldest = listMemoryEntries(db, { sort: "oldest", status: "available" });
      expect(oldest.entries[0]!.createdAt).toBe(daysAgo(200));

      const created = listMemoryEntries(db, { sort: "created", status: "available" });
      expect(created.entries[0]!.createdAt).toBe(daysAgo(5));
    } finally {
      env.cleanup?.();
    }
  });

  test("an unknown sort falls back to recent rather than producing invalid SQL", () => {
    const { env, db } = seeded();
    try {
      const res = listMemoryEntries(
        db,
        { sort: "; drop table memory_entries --" as never, status: "available" },
        NOW
      );
      expect(res.entries.length).toBe(4);
    } finally {
      env.cleanup?.();
    }
  });
});

describe("scope filters", () => {
  test("featureId narrows to one feature", () => {
    const env = freshStoresEnv("md-browse-feat-");
    try {
      const db = env.store.db;
      const wanted = insert(db, {
        createdAt: daysAgo(1),
        scope: "feature",
        projectId: "p1",
        featureId: "f1"
      });
      insert(db, { createdAt: daysAgo(1), scope: "feature", projectId: "p1", featureId: "f2" });
      const res = listMemoryEntries(db, { featureId: "f1", status: "available" });
      expect(res.entries.map((e) => e.id)).toEqual([wanted]);
    } finally {
      env.cleanup?.();
    }
  });

  test("usage and scope filters compose", () => {
    const env = freshStoresEnv("md-browse-combo-");
    try {
      const db = env.store.db;
      const wanted = insert(db, { createdAt: daysAgo(120), scope: "user", recallCount: 4 });
      insert(db, { createdAt: daysAgo(120), scope: "global", recallCount: 4 });
      insert(db, { createdAt: daysAgo(120), scope: "user", recallCount: 9, useCount: 3 });
      const res = listMemoryEntries(db, { scope: "user", usage: "idle", status: "available" });
      expect(res.entries.map((e) => e.id)).toEqual([wanted]);
    } finally {
      env.cleanup?.();
    }
  });
});
