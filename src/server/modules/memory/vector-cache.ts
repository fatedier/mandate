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
 *  every rewrite, never a clock. A millisecond timestamp would repeat: with an embedder
 *  that resolves immediately, most write/search/write/search trials land inside a single
 *  millisecond (measured between roughly 70% and 93% depending on the machine), and
 *  every collision would serve the superseded vector. Production hides this behind the embedder's HTTP
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
// A memory's status is 'available' or 'archived' (the table's check), so
// the visible side is the available one: said so, the memories' listing
// index answers it with a seek, not a scan.
const STATUS_SQL = {
  visible: "m.status = 'available'",
  hidden: "m.status = 'archived'"
} as const;

/** Each memory's stamp on one side, from the memories' listing index and the
 *  embeddings' revision index, never a memory's row; `cross join` keeps the
 *  memories first, as the side is theirs, and the revision index (not the
 *  primary key, which lacks the revision) answers the embeddings. */
function stampsSql(side: Side, columns: string): string {
  return `
    select m.id as entry_id, e.revision as revision${columns}
    from memory_entries m
    cross join memory_embeddings e indexed by idx_memory_embeddings_revision on e.model = ? and e.entry_id = m.id
    where ${STATUS_SQL[side]}
  `;
}

type Side = keyof typeof STATUS_SQL;

/** Rows a warming step reads: ~1.5 MB of vector text, well under a stall. */
const WARM_BATCH = 50;

const shared = new WeakMap<Database, VectorCache>();

/** The one cache of a database: every provider on it reads the same vectors,
 *  so a provider built again (a config reload) or another reader (the dream)
 *  finds them loaded. Each load checks the database, so sharing is safe. */
export function sharedVectorCache(db: Database): VectorCache {
  let cache = shared.get(db);
  if (!cache) {
    cache = new VectorCache(db);
    shared.set(db, cache);
  }
  return cache;
}

export class VectorCache {
  private readonly bySet = new Map<string, Map<string, CachedVector>>();

  constructor(private readonly db: Database) {}

  /** The vectors a default search can reach. */
  load(model: string): Map<string, Float64Array> {
    return this.loadSide(model, "visible");
  }

  /** The rest — archived — for the searches that ask for them. */
  loadHidden(model: string): Map<string, Float64Array> {
    return this.loadSide(model, "hidden");
  }

  /** Fills a set ahead of a load, `batch` rows at a time with `pause`
   *  between: a first load reads every vector in one go (longer the more
   *  memories there are, archived ones included), which would otherwise hold the server all at once. A load meanwhile still
   *  reads whatever is missing itself. The default set by default. */
  async warm(model: string, opts: { batch?: number; pause?: () => Promise<void>; side?: Side } = {}): Promise<void> {
    const batch = Math.max(1, opts.batch ?? WARM_BATCH);
    const pause = opts.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    const side = opts.side ?? "visible";
    let left = this.reconcile(model, side, batch).left;
    // A row that will not parse is read again each round (the cache drops
    // it): the rounds a first pass needs, and no more.
    for (let rounds = Math.ceil(left / batch); left > 0 && rounds > 0; rounds--) {
      await pause();
      left = this.reconcile(model, side, batch).left;
    }
  }

  private loadSide(model: string, side: Side): Map<string, Float64Array> {
    const cached = this.reconcile(model, side, Number.POSITIVE_INFINITY).cached;
    const out = new Map<string, Float64Array>();
    for (const [id, entry] of cached) out.set(id, entry.vector);
    return out;
  }

  /** Brings the set up to date, reading at most `limit` changed rows; `left`
   *  is how many are still to read. */
  private reconcile(model: string, side: Side, limit: number): { cached: Map<string, CachedVector>; left: number } {
    const key = `${side}\0${model}`;
    const cached = this.bySet.get(key) ?? new Map<string, CachedVector>();
    this.bySet.set(key, cached);

    const stamps = this.db.prepare(stampsSql(side, "")).all(model) as Array<{ entry_id: string; revision: number }>;

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

    const now = stale.length > limit ? stale.slice(0, limit) : stale;
    if (now.length > 0) this.refresh(model, side, cached, now, now.length === stamps.length);
    return { cached, left: stale.length - now.length };
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
      ? this.db.prepare(stampsSql(side, ", e.vector_json as vector_json")).all(model) as Array<{ entry_id: string; revision: number; vector_json: string }>
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
