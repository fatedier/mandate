import type { Database } from "bun:sqlite";
import { parseVector } from "./local-provider-helpers.js";

interface CachedVector {
  revision: number;
  vector: Float64Array;
}

/** Vectors live in memory because moving them through SQLite dominates every search.
 *  Fetching the rows of vector_json costs tens of times the cosine maths itself, and
 *  parsing them as much again -- the work is the text, not
 *  the arithmetic.
 *
 *  Staleness is not something a writer has to remember to avoid: every load re-reads
 *  (entry_id, revision) for the whole model and reconciles against it, so there is no
 *  "someone forgot to invalidate" path. The signal is a counter storeEmbedding bumps on
 *  every rewrite, never a clock. `updated_at` is millisecond text, and consecutive
 *  writes to one row routinely share a value: with an embedder that resolves
 *  immediately, most write/search/write/search trials land inside a single millisecond
 *  (measured between roughly 70% and 93% depending on the machine), and every collision
 *  serves the superseded vector. Production hides this behind the embedder's HTTP
 *  latency, but that is the network's property, not this cache's. A counter needs no
 *  such assumption, at any speed.
 *
 *  The probe is cheap only because of idx_memory_embeddings_revision -- without it
 *  SQLite scans the table, and these rows are ~29 KB each, so even reading two small
 *  columns touches every overflow page (scanning costs tens of times the covered read).
 *
 *  Caller contract: the returned Float64Arrays are the cached instances, not copies.
 *  Read them; never write through one, or the cache is corrupted for every later search.
 *  Copying on the way out would reimpose per-search work this class exists to remove. */
/**
 * Which side of the visible/hidden line a cached set holds.
 *
 * Split rather than filtered-on-read because the two are wanted at wildly
 * different rates. The hidden side can be larger than the visible one,
 * and all of it is unreachable by a default search, since
 * `buildSearchFilter` (local-provider-helpers.ts) keeps only available
 * entries unless a caller asks. Keeping one map meant every search paid to
 * hold and parse them.
 *
 * The sets are disjoint, not nested, so a search that does ask reads both and
 * neither copy is duplicated. The search's `includeArchived` decides
 * (local-provider.ts), the same input `buildSearchFilter` reads.
 */
const STATUS_SQL = {
  visible: "m.status not in ('archived','deleted')",
  hidden: "m.status in ('archived','deleted')"
} as const;

type Side = keyof typeof STATUS_SQL;

export class VectorCache {
  private readonly bySet = new Map<string, Map<string, CachedVector>>();

  constructor(private readonly db: Database) {}

  /** The vectors a default search can reach. */
  load(model: string): Map<string, Float64Array> {
    return this.loadSide(model, "visible");
  }

  /** The rest — archived and deleted — for the searches that ask for them. */
  loadHidden(model: string): Map<string, Float64Array> {
    return this.loadSide(model, "hidden");
  }

  private loadSide(model: string, side: Side): Map<string, Float64Array> {
    const key = `${side}\0${model}`;
    const cached = this.bySet.get(key) ?? new Map<string, CachedVector>();
    this.bySet.set(key, cached);

    const stamps = this.db.prepare(`
      select e.entry_id as entry_id, e.revision as revision
      from memory_embeddings e
      join memory_entries m on m.id = e.entry_id
      where e.model = ? and ${STATUS_SQL[side]}
    `).all(model) as Array<{ entry_id: string; revision: number }>;

    const present = new Set<string>();
    const stale: string[] = [];
    for (const stamp of stamps) {
      present.add(stamp.entry_id);
      const hit = cached.get(stamp.entry_id);
      if (!hit || hit.revision !== stamp.revision) stale.push(stamp.entry_id);
    }
    // The same line that evicts a deleted embedding now also evicts one whose
    // entry changed sides: an archived memory stops appearing in the visible
    // probe, so it leaves the visible set without anything having to notice
    // that archiving is what happened.
    for (const id of [...cached.keys()]) {
      if (!present.has(id)) cached.delete(id);
    }

    if (stale.length > 0) this.refresh(model, side, cached, stale, stale.length === stamps.length);

    const out = new Map<string, Float64Array>();
    for (const [id, entry] of cached) out.set(id, entry.vector);
    return out;
  }

  private refresh(
    model: string,
    side: Side,
    cached: Map<string, CachedVector>,
    stale: string[],
    all: boolean
  ): void {
    // A first load has every row stale, and binding one parameter per id would push
    // against SQLite's variable limit on a large corpus. Selecting the whole model
    // avoids that; the incremental case binds only the handful that actually moved,
    // and cannot be large because each rewrite costs a round trip to the embedder.
    const rows = all
      ? this.db.prepare(`
        select e.entry_id as entry_id, e.revision as revision, e.vector_json as vector_json
        from memory_embeddings e
        join memory_entries m on m.id = e.entry_id
        where e.model = ? and ${STATUS_SQL[side]}
      `).all(model) as Array<{ entry_id: string; revision: number; vector_json: string }>
      : this.db.prepare(
        `select entry_id, revision, vector_json from memory_embeddings
         where model = ? and entry_id in (${stale.map(() => "?").join(",")})`
      ).all(model, ...stale) as Array<{ entry_id: string; revision: number; vector_json: string }>;

    for (const row of rows) {
      const parsed = parseVector(row.vector_json);
      if (!parsed) {
        // Same treatment the search path already gives an unreadable vector: skip it.
        cached.delete(row.entry_id);
        continue;
      }
      cached.set(row.entry_id, {
        revision: row.revision,
        vector: Float64Array.from(parsed)
      });
    }
  }
}
