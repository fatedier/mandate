import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import { nowIso } from "../../platform/time/time.js";
import { escapeLike, normalizeNullableString } from "../../platform/text/sql-text.js";
import {
  boundedLimit,
  buildFtsQuery,
  buildListFilter,
  buildSearchFilter,
  cosineSimilarity,
  fuseByRank,
  jsonOrNull,
  mergeMetadata,
  rowToEntry,
  validVector,
  type MemoryRow
} from "./local-provider-helpers.js";
import { deleteBrief, getBrief, listBriefs, putBrief } from "./briefs.js";
import { VectorCache } from "./vector-cache.js";
import type {
  MemoryBrief,
  MemoryEntry,
  MemoryListFilter,
  MemoryProvider,
  MemoryRememberInput,
  MemoryScope,
  MemorySearchInput,
  MemorySearchReason,
  MemorySearchResult,
  MemoryUpdateInput,
  MemoryUse,
  MemoryWriteTx
} from "./types.js";
import { errorText } from "../../../shared/error-text.js";

export interface MemoryEmbedder {
  model: string;
  embed(text: string): Promise<number[]>;
}

interface LocalMemoryProviderOptions {
  embedder?: MemoryEmbedder | null;
}

export class LocalMemoryProvider implements MemoryProvider {
  private readonly vectorCache: VectorCache;

  constructor(
    private db: Database,
    private options: LocalMemoryProviderOptions = {}
  ) {
    this.vectorCache = new VectorCache(db);
  }

  async remember(input: MemoryRememberInput): Promise<MemoryEntry> {
    const entry = this.insertEntry(input);
    await this.storeEmbedding(entry.id, entry.content);
    return entry;
  }

  private insertEntry(input: MemoryRememberInput): MemoryEntry {
    const now = nowIso();
    const entry: MemoryEntry = {
      id: newId("mem"),
      scope: input.scope,
      projectId: input.scope === "project" ? input.projectId ?? null : null,
      featureId: input.featureId ?? null,
      type: input.type,
      source: input.source,
      userQuote: input.source === "user" ? normalizeNullableString(input.userQuote) : null,
      content: input.content.trim(),
      status: "available",
      sourceThreadId: input.sourceThreadId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? null
    };
    if (entry.scope === "project" && !entry.projectId) throw new Error("a project memory needs a projectId");
    this.db.prepare(`
      insert into memory_entries (
        id, scope, project_id, feature_id, type, source, user_quote, content, status,
        source_thread_id, source_message_id, created_at, updated_at, metadata_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.scope, entry.projectId, entry.featureId, entry.type, entry.source, entry.userQuote,
      entry.content, entry.status, entry.sourceThreadId, entry.sourceMessageId, entry.createdAt,
      entry.updatedAt, jsonOrNull(entry.metadata)
    );
    return entry;
  }

  async update(input: MemoryUpdateInput): Promise<MemoryEntry | null> {
    const entry = this.writeUpdate(input);
    if (entry && input.content !== undefined) await this.storeEmbedding(entry.id, entry.content);
    return entry;
  }

  /** Read and written in one go, with nothing awaited between: a write made
   *  meanwhile cannot be overwritten by fields read before it. */
  private writeUpdate(input: MemoryUpdateInput): MemoryEntry | null {
    const existing = this.readEntry(input.id);
    if (!existing) return null;
    const scope = input.scope ?? existing.scope;
    const source = input.source ?? existing.source;
    const projectId = scope === "project"
      ? (input.projectId === undefined ? existing.projectId : input.projectId)
      : null;
    const content = input.content === undefined ? existing.content : input.content.trim();
    const updatedAt = stampAfter(existing.updatedAt);
    const metadata = input.metadata === undefined ? existing.metadata : input.metadata;
    const next: MemoryEntry = {
      ...existing,
      scope,
      projectId,
      // A worker belongs to one project: moved elsewhere, the memory is no longer its.
      featureId: scope === existing.scope && projectId === existing.projectId ? existing.featureId : null,
      type: input.type ?? existing.type,
      source,
      userQuote: source === "user"
        ? (input.userQuote === undefined ? existing.userQuote : normalizeNullableString(input.userQuote))
        : null,
      content,
      status: input.status ?? existing.status,
      metadata: content === existing.content ? withTextAsLearned(existing, metadata) : withLastUpdate(existing, metadata, updatedAt, input.byExtraction),
      sourceThreadId: input.sourceThreadId === undefined ? existing.sourceThreadId : input.sourceThreadId,
      sourceMessageId: input.sourceMessageId === undefined ? existing.sourceMessageId : input.sourceMessageId,
      updatedAt
    };
    if (next.scope === "project" && !next.projectId) throw new Error("a project memory needs a projectId");
    this.db.prepare(`
      update memory_entries set
        scope = ?, project_id = ?, feature_id = ?, type = ?, source = ?, user_quote = ?, content = ?,
        status = ?, metadata_json = ?, source_thread_id = ?, source_message_id = ?, updated_at = ?
      where id = ?
    `).run(
      next.scope, next.projectId, next.featureId, next.type, next.source, next.userQuote, next.content,
      next.status, jsonOrNull(next.metadata), next.sourceThreadId, next.sourceMessageId, next.updatedAt, next.id
    );
    return next;
  }

  /**
   * The dream's writes: all of them in one transaction, or none when a memory
   * in `expected` is no longer available at the version given — someone else
   * wrote it since. The check is in the transaction, so nothing can land
   * between it and the writes. New text is embedded after the commit.
   */
  async writeIfUnchanged<T>(
    expected: ReadonlyArray<Pick<MemoryEntry, "id" | "updatedAt">>,
    write: (tx: MemoryWriteTx) => T
  ): Promise<T | null> {
    const toEmbed: MemoryEntry[] = [];
    const tx: MemoryWriteTx = {
      update: (input) => {
        const entry = this.writeUpdate(input);
        if (!entry) throw new Error(`memory not found: ${input.id}`);
        if (input.content !== undefined) toEmbed.push(entry);
        return entry;
      },
      archive: (id, metadata = {}) => tx.update({ id, status: "archived", metadata: mergeMetadata(this.readEntry(id)?.metadata ?? null, metadata) }),
      remember: (input) => {
        const entry = this.insertEntry(input);
        toEmbed.push(entry);
        return entry;
      }
    };
    const version = this.db.prepare("select status, updated_at as updatedAt from memory_entries where id = ?");
    const written = this.db.transaction(() => {
      for (const { id, updatedAt } of expected) {
        const row = version.get(id) as { status: string; updatedAt: string } | null;
        if (row?.status !== "available" || row.updatedAt !== updatedAt) return null;
      }
      return { value: write(tx) };
    }).immediate();
    if (!written) return null;
    for (const entry of toEmbed) await this.storeEmbedding(entry.id, entry.content);
    return written.value;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.readEntry(id);
  }

  private readEntry(id: string): MemoryEntry | null {
    const row = this.db.prepare(`
      select *
      from memory_entries
      where id = ?
      limit 1
    `).get(id) as MemoryRow | null;
    return row ? rowToEntry(row) : null;
  }

  async search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    const limit = boundedLimit(input.maxResults);
    const filter = buildSearchFilter(input, "e");
    const ftsQuery = buildFtsQuery(input.query);
    const entries = new Map<string, MemoryEntry>();
    const lists: Array<{ path: MemorySearchReason; ids: string[] }> = [];

    const ftsIds: string[] = [];
    if (ftsQuery) {
      try {
        const rows = this.db.prepare(`
          select e.*, bm25(memory_entries_fts) as rank
          from memory_entries_fts
          join memory_entries e on e.rowid = memory_entries_fts.rowid
          where memory_entries_fts match ?
            ${filter.where}
          order by rank asc, e.updated_at desc
          limit ?
        `).all(ftsQuery, ...filter.params, limit) as Array<MemoryRow & { rank: number }>;
        for (const row of rows) {
          const entry = rowToEntry(row);
          entries.set(entry.id, entry);
          ftsIds.push(entry.id);
        }
      } catch {
        // A malformed FTS query contributes no ids rather than failing the search.
      }
    }

    let vectorIds: string[] = [];
    if (this.options.embedder && input.query.trim()) {
      // Fuse the same depth from both lanes. FTS is capped at `limit` by its own
      // SQL; the vector lane scores every candidate it loaded, and cosine is
      // positive for essentially every real pair, so untruncated it contains the
      // whole visible scope. That handed a second rank term to every FTS hit and
      // to nothing else, which kept vector-only entries out of a full page
      // entirely. Truncating here is the standard top-K-per-path fusion, and the
      // ordering above is untouched -- only its depth is.
      vectorIds = (await this.vectorRankedIds(input, entries)).slice(0, limit);
    }

    const ftsIdSet = new Set(ftsIds);
    const substringIds: string[] = [];
    {
      const like = `%${escapeLike(input.query.trim())}%`;
      const rows = this.db.prepare(`
        select e.*
        from memory_entries e
        where e.content like ? escape '\\'
          ${filter.where}
        order by e.updated_at desc
        limit ?
      `).all(like, ...filter.params, limit) as MemoryRow[];
      for (const row of rows) {
        // Only the rows FTS could not reach. A substring hit is not independent
        // evidence from an FTS hit -- fusing the two as peer lists would hand every
        // FTS hit a second rank term that a vector-only entry cannot get, which is
        // the crowding-out the same-depth fix removed, re-entering through a lane
        // instead of through depth.
        if (ftsIdSet.has(row.id)) continue;
        const entry = rowToEntry(row);
        entries.set(entry.id, entry);
        substringIds.push(entry.id);
      }
    }

    // One lexical lane with two mechanisms, not two lanes: FTS first in its own
    // order, then the substring rows it could not reach. That tail is the only way
    // to a query sitting inside a token -- unicode61 does not segment Han, so a
    // whole Chinese clause is one token and FTS prefix matching cannot get inside
    // it, while short queries are also where embeddings are weakest. Without the
    // tail the default page misses most literal matches for a Han fragment; with
    // it, it shows them.
    //
    // The truncation is load-bearing, not tidying. The tail is real for English
    // too -- many words in stored content have substring hits FTS misses,
    // `moved` inside `removed`, `port` inside `important` -- so what bounds it is
    // this slice, not the dedupe above: when FTS fills the page the tail is cut
    // away entirely, and when FTS underfills, substring rows take slots that would
    // otherwise sit empty. Drop the slice believing the dedupe protects English and
    // an underfilling query like `moved` (few FTS rows, many substring rows) pushes
    // vector-only entries off the page.
    const lexicalIds = [...ftsIds, ...substringIds].slice(0, limit);
    // The lane carries a single path, so remember which of its ids arrived by the
    // substring mechanism and restore that below. Keep the distinction: "fts" and
    // "like" name how the entry was reached, and only one of them survives a query
    // the tokenizer cannot segment.
    const reachedBySubstring = new Set(lexicalIds.filter((id) => !ftsIdSet.has(id)));
    // Vector first, and the order is load-bearing rather than stylistic: the sort
    // below is stable over insertion order, so the list fused first keeps the slot
    // when two entries tie on score *and* on update time -- the comparator tries
    // updatedAt in between, so this only decides a double tie. A literal match ties
    // the semantic top hit at 1/(k+1) whenever both are their lane's first row, and
    // if update time does not separate them that tie should resolve to the semantic
    // hit: the literal match lands behind it instead of displacing it. Swap these
    // two lines and it displaces it.
    // `reason` does not depend on this order -- PATH_PRECEDENCE resolves an equal
    // best rank to "fts" whichever list ran first.
    if (vectorIds.length > 0) lists.push({ path: "vector", ids: vectorIds });
    if (lexicalIds.length > 0) lists.push({ path: "fts", ids: lexicalIds });

    const fused = fuseByRank(lists);
    const results: MemorySearchResult[] = [...fused]
      .map(([id, { score, path }]) => ({
        entry: entries.get(id)!,
        score,
        reason: path === "fts" && reachedBySubstring.has(id) ? "like" as MemorySearchReason : path
      }))
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, limit);

    return results;
  }

  async archive(id: string, metadata: Record<string, unknown> = {}): Promise<MemoryEntry | null> {
    // Read and handed to update in the same turn: update writes before it awaits.
    const existing = this.readEntry(id);
    if (!existing) return null;
    return this.update({ id, status: "archived", metadata: mergeMetadata(existing.metadata, metadata) });
  }

  listAvailable(filter: MemoryListFilter): MemoryEntry[] {
    const where = buildListFilter(filter, "e");
    const rows = this.db.prepare(`
      select e.* from memory_entries e
      where e.status = 'available' and ${where.where}
      order by e.updated_at desc
    `).all(...where.params) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  listArchivedSince(filter: MemoryListFilter, sinceIso: string): MemoryEntry[] {
    const where = buildListFilter(filter, "e");
    const rows = this.db.prepare(`
      select e.* from memory_entries e
      where e.status = 'archived' and e.updated_at >= ? and ${where.where}
      order by e.updated_at desc
    `).all(sinceIso, ...where.params) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  getBrief(scope: MemoryScope, projectId: string | null): MemoryBrief | null {
    return getBrief(this.db, scope, projectId);
  }

  putBrief(brief: MemoryBrief): void {
    putBrief(this.db, brief);
  }

  listBriefs(): MemoryBrief[] {
    return listBriefs(this.db);
  }
  recordUses(uses: readonly MemoryUse[]): void {
    const at = nowIso();
    const insert = this.db.prepare("insert into memory_uses (memory_id, kind, at, thread_id, agent, rank) values (?, ?, ?, ?, ?, ?)");
    // A note is worth no wait: while another process writes the database it
    // fails at once (the caller drops it) instead of holding the server for
    // the connection's busy timeout. That timeout is the connection's, put
    // back before anything else runs.
    const { timeout } = this.db.prepare("pragma busy_timeout").get() as { timeout: number };
    this.db.exec("pragma busy_timeout = 0");
    try {
      this.db.transaction(() => {
        for (const use of uses) insert.run(use.memoryId, use.kind, at, use.threadId, use.agent, use.rank ?? null);
      })();
    } finally {
      this.db.exec(`pragma busy_timeout = ${timeout}`);
    }
  }


  deleteBrief(scope: MemoryScope, projectId: string | null): void {
    deleteBrief(this.db, scope, projectId);
  }

  availableVectors(): ReadonlyMap<string, Float64Array> | null {
    const embedder = this.options.embedder;
    return embedder ? this.vectorCache.load(embedder.model) : null;
  }

  private async storeEmbedding(entryId: string, content: string) {
    const embedder = this.options.embedder;
    if (!embedder) return;
    try {
      const vector = await embedder.embed(content);
      if (!validVector(vector)) return;
      // The text changed again while this one was embedded: its own embedding
      // is the one to keep.
      const current = this.db.prepare("select content from memory_entries where id = ?").get(entryId) as { content: string } | null;
      if (current?.content !== content) return;
      this.db.prepare(`
        insert into memory_embeddings (entry_id, model, dimensions, vector_json, updated_at, revision)
        values (?, ?, ?, ?, ?, 0)
        on conflict(entry_id, model) do update set
          dimensions = excluded.dimensions,
          vector_json = excluded.vector_json,
          updated_at = excluded.updated_at,
          revision = memory_embeddings.revision + 1
      `).run(entryId, embedder.model, vector.length, JSON.stringify(vector), nowIso());
    } catch (err) {
      const msg = errorText(err);
      console.warn(`[mandate] memory embedding failed: ${msg}`);
    }
  }

  private async vectorRankedIds(
    input: MemorySearchInput,
    entries: Map<string, MemoryEntry>
  ): Promise<string[]> {
    const embedder = this.options.embedder;
    if (!embedder) return [];
    let queryVector: number[];
    try {
      queryVector = await embedder.embed(input.query);
    } catch {
      return [];
    }
    if (!validVector(queryVector)) return [];

    const filter = buildSearchFilter(input, "e");
    // No `limit` here. The old one kept 200 rows by `strength desc` -- an axis the
    // query has nothing to do with -- so a weak entry that was the best semantic
    // match for the query was cut before its cosine was ever computed. With the
    // vectors resident, scoring the whole corpus is cheap.
    //
    // The `order by` stays, and is not decoration now that it no longer decides who
    // survives: `ranked.sort` is stable, so this is what orders entries whose rank
    // ties. Dropping it would change that tie-break.
    //
    // Where this lane's cost now lives, and where it stops winning. With the vectors
    // resident the cosine maths is no longer the bill; `select e.*` plus `rowToEntry`
    // over every visible row is. That grows with the corpus and the cache does nothing
    // about it, so the uncapped path eventually loses to the old capped one. Simulated
    // with payloads of a realistic size, visible embedded entries against total lane
    // time, new versus old:
    //     1000 ->  23 ms vs 64 ms
    //     2000 ->  47 ms vs 66 ms
    //     5000 -> 193 ms vs 93 ms
    // Crossover is around 3000. At 5000 the `select e.*` alone is 119 ms.
    //
    // A scope usually holds far fewer visible entries than that, so this is a large-corpus
    // concern, and the cap is not the answer to it: the old path was only faster
    // because it was wrong, cutting by `strength desc` before any cosine was computed.
    // When these numbers start to bite, fix the row fetch -- select the columns the
    // ranker actually needs and defer `rowToEntry` to the survivors -- not the vectors.
    const vectors = this.vectorCache.load(embedder.model);
    // The cache holds only what a default search can see. A query that reaches
    // past that — `includeArchived`, or an explicit archived/deleted status —
    // gets the other side too; without this its rows come back from the join
    // below with no vector, score nothing, and fall out of the semantic lane
    // while the lexical one still answers, which reads as "semantic search
    // does not work on archived memories" rather than as a bug.
    const hidden = input.includeArchived ? this.vectorCache.loadHidden(embedder.model) : null;
    const rows = this.db.prepare(`
      select e.*
      from memory_embeddings me
      join memory_entries e on e.id = me.entry_id
      where me.model = ?
        ${filter.where}
      order by e.updated_at desc
    `).all(embedder.model, ...filter.params) as MemoryRow[];

    const ranked: Array<{ id: string; rank: number }> = [];
    for (const row of rows) {
      const vector = vectors.get(row.id) ?? hidden?.get(row.id);
      if (!vector || vector.length !== queryVector.length) continue;
      const vectorScore = cosineSimilarity(queryVector, vector);
      // Not a relevance threshold. Two reasons this line exists:
      //   1. A sanity guard: a vector orthogonal or opposed to the query (a
      //      degenerate one among them) scores <= 0 and says nothing for it.
      //   2. It is the backstop for a cache miss. `vectors.get` returns nothing for a
      //      row whose `vector_json` will not parse -- `VectorCache` drops it on
      //      refresh while this join still yields the row -- and any zero or
      //      zero-length vector standing in for it scores exactly 0 here.
      // Rarely hit is not permission to delete it. Job 1 is pinned:
      // delete this line and `two paths agreeing outrank a single path's best hit`
      // (memory-provider.test.ts) goes red, because the orthogonal entry it scores at
      // exactly 0 stops being skipped and joins the vector lane. Job 2 is not: nothing
      // in the suite constructs a cache miss, so if the line is ever narrowed to
      // "degenerate vectors only" the tests still pass while a missing vector starts
      // being ranked on whatever stood in for it.
      if (vectorScore <= 0) continue;
      const entry = rowToEntry(row);
      entries.set(entry.id, entry);
      ranked.push({ id: entry.id, rank: vectorScore });
    }
    return ranked.sort((a, b) => b.rank - a.rank).map((item) => item.id);
  }
}

/** Whether the memory's text is known to be the one it was learned with:
 *  never written since, or every write since left the text and said so. A
 *  memory written before the store kept track is not known to be. */
function stillAsLearned(existing: MemoryEntry): boolean {
  return existing.metadata?.previous === undefined
    && (existing.updatedAt === existing.createdAt || existing.metadata?.textAsLearned === true);
}

/** A write that leaves the text carries on that it is the text learned. */
function withTextAsLearned(existing: MemoryEntry, metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  return stillAsLearned(existing) ? { ...(metadata ?? {}), textAsLearned: true } : metadata;
}

/** A change of the text keeps the version it replaced, one back, and when,
 *  and whether that version was the one learned. The extraction's mark
 *  speaks only of the last change: any other writer's change drops it, even
 *  one that writes back the metadata it read. */
function withLastUpdate(
  existing: MemoryEntry,
  metadata: Record<string, unknown> | null,
  replacedAt: string,
  byExtraction: string | undefined
): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(metadata ?? {})
    .filter(([key]) => key !== "updatedByExtraction" && key !== "textAsLearned"));
  const statedAt = existing.metadata?.statedAt;
  return {
    ...rest,
    previous: {
      content: existing.content,
      type: existing.type,
      source: existing.source,
      userQuote: existing.userQuote,
      ...(typeof statedAt === "string" ? { statedAt } : {}),
      updatedAt: existing.updatedAt,
      replacedAt,
      ...(stillAsLearned(existing) ? { asLearned: true } : {})
    },
    ...(byExtraction ? { updatedByExtraction: byExtraction } : {})
  };
}

/** Now, or just after the last write when the clock has not passed it: every
 *  write moves a memory's version on, which the dream's writes check. */
function stampAfter(previous: string): string {
  const now = nowIso();
  return now > previous ? now : new Date(Date.parse(previous) + 1).toISOString();
}
