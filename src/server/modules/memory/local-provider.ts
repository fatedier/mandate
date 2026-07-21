import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import { nowIso } from "../../platform/time/time.js";
import {
  admitsHiddenStatuses,
  boundedLimit,
  buildFtsQuery,
  buildPromptVisibilityFilter,
  buildVisibilityFilter,
  clamp01,
  cosineSimilarity,
  escapeLike,
  fuseByRank,
  jsonArrayOrNull,
  jsonOrNull,
  markRecalled,
  mergeMetadata,
  normalizeNullableString,
  rowToEntry,
  validVector,
  type MemoryRow
} from "./local-provider-helpers.js";
import { VectorCache } from "./vector-cache.js";
import type {
  MemoryEntry,
  MemoryFeedbackCounts,
  MemoryFeedbackInput,
  MemoryProvider,
  MemoryRememberInput,
  MemorySearchContext,
  MemorySearchInput,
  MemorySearchReason,
  MemorySearchResult,
  MemoryUpdateInput
} from "./types.js";

export interface MemoryEmbedder {
  model: string;
  embed(text: string): Promise<number[]>;
}

export interface LocalMemoryProviderOptions {
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
    const id = newId("mem");
    const now = nowIso();
    const entry = {
      id,
      scope: input.scope,
      projectId: input.projectId ?? null,
      featureId: input.featureId ?? null,
      kind: input.kind,
      content: input.content.trim(),
      status: input.status ?? "available",
      strength: clamp01(input.strength ?? 0.5),
      confidence: clamp01(input.confidence ?? 0.7),
      cues: normalizeCues(input.cues, input.content),
      source: input.source,
      sourceThreadId: input.sourceThreadId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      createdAt: now,
      updatedAt: now,
      lastRecalledAt: null,
      recallCount: 0,
      lastUsedAt: null,
      useCount: 0,
      feedback: {},
      expiresAt: normalizeNullableString(input.expiresAt),
      supersedes: normalizeNullableString(input.supersedes),
      metadata: input.metadata ?? null
    } satisfies MemoryEntry;

    this.db.prepare(`
      insert into memory_entries (
        id, scope, project_id, feature_id, kind, content, status,
        strength, confidence, cues_json, source, source_thread_id, source_message_id,
        created_at, updated_at, last_recalled_at, recall_count, last_used_at, use_count,
        feedback_json, expires_at, supersedes, metadata_json
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.scope, entry.projectId, entry.featureId, entry.kind,
      entry.content, entry.status, entry.strength, entry.confidence, jsonArrayOrNull(entry.cues),
      entry.source, entry.sourceThreadId, entry.sourceMessageId, entry.createdAt,
      entry.updatedAt, entry.lastRecalledAt, entry.recallCount, entry.lastUsedAt,
      entry.useCount, jsonOrNull(entry.feedback), entry.expiresAt, entry.supersedes,
      jsonOrNull(entry.metadata)
    );
    await this.storeEmbedding(entry.id, entry.content);
    return entry;
  }

  async update(input: MemoryUpdateInput): Promise<MemoryEntry | null> {
    const existing = await this.get(input.id);
    if (!existing) return null;
    const now = nowIso();
    const next: MemoryEntry = {
      ...existing,
      scope: input.scope ?? existing.scope,
      projectId: input.projectId === undefined ? existing.projectId : input.projectId,
      featureId: input.featureId === undefined ? existing.featureId : input.featureId,
      content: input.content === undefined ? existing.content : input.content.trim(),
      kind: input.kind ?? existing.kind,
      status: input.status ?? existing.status,
      strength: input.strength === undefined ? existing.strength : clamp01(input.strength),
      confidence: input.confidence === undefined ? existing.confidence : clamp01(input.confidence),
      cues: input.cues === undefined ? existing.cues : normalizeCues(input.cues, input.content ?? existing.content),
      expiresAt: input.expiresAt === undefined ? existing.expiresAt : normalizeNullableString(input.expiresAt),
      supersedes: input.supersedes === undefined ? existing.supersedes : normalizeNullableString(input.supersedes),
      metadata: input.metadata === undefined ? existing.metadata : input.metadata,
      updatedAt: now
    };

    this.db.prepare(`
      update memory_entries set
        scope = ?,
        project_id = ?,
        feature_id = ?,
        content = ?,
        kind = ?,
        status = ?,
        strength = ?,
        confidence = ?,
        cues_json = ?,
        expires_at = ?,
        supersedes = ?,
        metadata_json = ?,
        updated_at = ?
      where id = ?
    `).run(
      next.scope, next.projectId, next.featureId,
      next.content, next.kind, next.status, next.strength, next.confidence, jsonArrayOrNull(next.cues),
      next.expiresAt, next.supersedes, jsonOrNull(next.metadata), next.updatedAt,
      next.id
    );
    if (input.content !== undefined && next.status !== "deleted") {
      await this.storeEmbedding(next.id, next.content);
    }
    return next;
  }

  async feedback(input: MemoryFeedbackInput): Promise<MemoryEntry | null> {
    const existing = await this.get(input.id);
    if (!existing || existing.status === "deleted") return existing;

    const now = nowIso();
    const nextFeedback = incrementFeedback(existing.feedback, input.outcome);
    const useSignal = input.outcome === "used" || input.outcome === "helpful";
    const nextStrength = feedbackStrength(existing.strength, input.outcome);
    const nextConfidence = feedbackConfidence(existing.confidence, input.outcome);
    const feedbackEvent = {
      at: now,
      outcome: input.outcome,
      note: input.note.trim(),
      source: "agent_feedback",
      threadId: input.threadId ?? null,
      wakeId: input.wakeId ?? null
    };
    const nextMetadata = mergeMetadata(existing.metadata, {
      lastFeedbackAt: now,
      lastFeedbackOutcome: input.outcome,
      lastFeedbackSource: feedbackEvent.source,
      lastFeedbackThreadId: input.threadId ?? null,
      lastFeedbackWakeId: input.wakeId ?? null,
      lastFeedbackNote: feedbackEvent.note,
      feedbackEvents: appendFeedbackEvent(existing.metadata, feedbackEvent)
    });

    this.db.prepare(`
      update memory_entries set
        status = ?,
        strength = ?,
        confidence = ?,
        last_used_at = ?,
        use_count = ?,
        feedback_json = ?,
        metadata_json = ?,
        updated_at = ?
      where id = ?
    `).run(
      existing.status,
      nextStrength,
      nextConfidence,
      useSignal ? now : existing.lastUsedAt,
      useSignal ? existing.useCount + 1 : existing.useCount,
      jsonOrNull(nextFeedback),
      jsonOrNull(nextMetadata),
      now,
      existing.id
    );

    return this.get(existing.id);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.prepare(`
      select *
      from memory_entries
      where id = ?
      limit 1
    `).get(id) as MemoryRow | null;
    return row ? rowToEntry(row) : null;
  }

  async search(input: MemorySearchInput, context: MemorySearchContext = {}): Promise<MemorySearchResult[]> {
    const limit = boundedLimit(input.maxResults);
    const filter = buildVisibilityFilter(input, context, "e");
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
          order by rank asc, e.strength desc, e.confidence desc, e.use_count desc, e.updated_at desc
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
      vectorIds = (await this.vectorRankedIds(input, context, entries)).slice(0, limit);
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
        order by e.strength desc, e.confidence desc, e.use_count desc, e.updated_at desc
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
    // it, while short queries are also where embeddings are weakest. Measured:
    // literal matches on the default page went from 2 of 10 to 10 of 10 for Han
    // fragments.
    //
    // The truncation is load-bearing, not tidying. The tail is real for English
    // too -- 172 of 1276 words in stored content have substring hits FTS misses,
    // `moved` inside `removed`, `port` inside `important` -- so what bounds it is
    // this slice, not the dedupe above: when FTS fills the page the tail is cut
    // away entirely, and when FTS underfills, substring rows take slots that would
    // otherwise sit empty. Drop the slice believing the dedupe protects English and
    // an underfilling query like `moved` (2 FTS rows, 7 substring rows) pushes
    // vector-only entries off an 8-slot page.
    const lexicalIds = [...ftsIds, ...substringIds].slice(0, limit);
    // The lane carries a single path, so remember which of its ids arrived by the
    // substring mechanism and restore that below. Keep the distinction: "fts" and
    // "like" name how the entry was reached, and only one of them survives a query
    // the tokenizer cannot segment.
    const reachedBySubstring = new Set(lexicalIds.filter((id) => !ftsIdSet.has(id)));
    // Vector first, and the order is load-bearing rather than stylistic: the sort
    // below is stable over insertion order, so the list fused first keeps the slot
    // when two entries tie on score *and* on strength -- the comparator tries
    // strength in between, so this only decides a double tie. A literal match ties
    // the semantic top hit at 1/(k+1) whenever both are their lane's first row, and
    // if strength does not separate them that tie should resolve to the semantic
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
      .sort((a, b) => b.score - a.score || b.entry.strength - a.entry.strength)
      .slice(0, limit);

    if (results.length > 0 && input.recordRecall !== false) {
      markRecalled(this.db, results.map((result) => result.entry.id));
    }
    return results;
  }

  async archive(id: string, metadata: Record<string, unknown> = {}): Promise<MemoryEntry | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    return this.update({
      id,
      status: "archived",
      metadata: mergeMetadata(existing.metadata, metadata)
    });
  }

  async forget(id: string, metadata: Record<string, unknown> = {}): Promise<MemoryEntry | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    return this.update({
      id,
      content: "[deleted]",
      status: "deleted",
      metadata: mergeMetadata(existing.metadata, metadata)
    });
  }

  async listForPrompt(context: MemorySearchContext, limit = 12): Promise<MemoryEntry[]> {
    const filter = buildPromptVisibilityFilter(context, "e");
    const rows = this.db.prepare(`
      select e.*
      from memory_entries e
      where e.status = 'available'
        ${filter.where}
        and (e.expires_at is null or e.expires_at > ?)
      order by
        case e.kind
          when 'preference' then 0
          when 'procedural' then 1
          when 'semantic' then 2
          else 3
        end asc,
        e.strength desc,
        e.confidence desc,
        e.use_count desc,
        e.updated_at desc
      limit ?
    `).all(...filter.params, nowIso(), boundedLimit(limit)) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  private async storeEmbedding(entryId: string, content: string) {
    const embedder = this.options.embedder;
    if (!embedder) return;
    try {
      const vector = await embedder.embed(content);
      if (!validVector(vector)) return;
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
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mandate] memory embedding failed: ${msg}`);
    }
  }

  private async vectorRankedIds(
    input: MemorySearchInput,
    context: MemorySearchContext,
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

    const filter = buildVisibilityFilter(input, context, "e");
    // No `limit` here. The old one kept 200 rows by `strength desc` -- an axis the
    // query has nothing to do with -- so a weak entry that was the best semantic
    // match for the query was cut before its cosine was ever computed. With the
    // vectors resident, scoring the whole corpus measures 1.19 ms.
    //
    // The `order by` stays, and is not decoration now that it no longer decides who
    // survives: `ranked.sort` is stable, so this is what orders entries whose rank
    // ties. Dropping it would change that tie-break, which is not this change.
    //
    // Where this lane's cost now lives, and where it stops winning. With the vectors
    // resident the cosine maths is no longer the bill; `select e.*` plus `rowToEntry`
    // over every visible row is. That grows with the corpus and the cache does nothing
    // about it, so the uncapped path eventually loses to the old capped one. Simulated
    // with real payloads replayed to size, visible embedded entries against total lane
    // time, new versus old:
    //     1000 ->  23 ms vs 64 ms
    //     2000 ->  47 ms vs 66 ms
    //     5000 -> 193 ms vs 93 ms
    // Crossover is around 3000. At 5000 the `select e.*` alone is 119 ms. (An earlier
    // planning note guessed ~9 ms at a thousand; it was a guess, and the measurement
    // above replaces it.)
    //
    // The busiest real scope today holds 90 visible entries, so this is a ~20x-corpus
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
    const hidden = admitsHiddenStatuses(input) ? this.vectorCache.loadHidden(embedder.model) : null;
    const rows = this.db.prepare(`
      select e.*
      from memory_embeddings me
      join memory_entries e on e.id = me.entry_id
      where me.model = ?
        ${filter.where}
      order by e.strength desc, e.confidence desc, e.use_count desc, e.updated_at desc
    `).all(embedder.model, ...filter.params) as MemoryRow[];

    const ranked: Array<{ id: string; rank: number }> = [];
    for (const row of rows) {
      const vector = vectors.get(row.id) ?? hidden?.get(row.id);
      if (!vector || vector.length !== queryVector.length) continue;
      const vectorScore = cosineSimilarity(queryVector, vector);
      // Not a relevance threshold. Two reasons this line exists, and the measurement
      // only justifies the first:
      //   1. A sanity guard against a degenerate vector -- over 7,875 real pairs,
      //      zero scored <= 0, so it rejects nothing real.
      //   2. It is the backstop for a cache miss. `vectors.get` returns nothing for a
      //      row whose `vector_json` will not parse -- `VectorCache` drops it on
      //      refresh while this join still yields the row -- and any zero or
      //      zero-length vector standing in for it scores exactly 0 here.
      // So "it rejects nothing" is not permission to delete it. Job 1 is pinned:
      // delete this line and `two paths agreeing outrank a single path's best hit`
      // (memory-provider.test.ts) goes red, because the orthogonal entry it scores at
      // exactly 0 stops being skipped and joins the vector lane. Job 2 is not: nothing
      // in the suite constructs a cache miss, so if the line is ever narrowed to
      // "degenerate vectors only" the tests still pass while a missing vector starts
      // being ranked on whatever stood in for it.
      if (vectorScore <= 0) continue;
      const entry = rowToEntry(row);
      entries.set(entry.id, entry);
      ranked.push({ id: entry.id, rank: vectorScore * 0.8 + clamp01(entry.strength) * 0.2 });
    }
    return ranked.sort((a, b) => b.rank - a.rank).map((item) => item.id);
  }
}

function incrementFeedback(
  existing: MemoryFeedbackCounts,
  outcome: MemoryFeedbackInput["outcome"]
): MemoryFeedbackCounts {
  return {
    ...existing,
    [outcome]: Number(existing[outcome] ?? 0) + 1
  };
}

function appendFeedbackEvent(
  metadata: Record<string, unknown> | null,
  event: Record<string, unknown>
): Array<Record<string, unknown>> {
  const existing = Array.isArray(metadata?.feedbackEvents)
    ? metadata.feedbackEvents.filter((item): item is Record<string, unknown> => (
      !!item && typeof item === "object" && !Array.isArray(item)
    ))
    : [];
  return [...existing, event].slice(-20);
}

function feedbackStrength(current: number, outcome: MemoryFeedbackInput["outcome"]) {
  switch (outcome) {
    case "helpful":
      return clamp01(current + 0.04);
    case "used":
      return clamp01(current + 0.02);
    case "irrelevant":
      return clamp01(current - 0.05);
    case "stale":
      return clamp01(current - 0.1);
    case "wrong":
      return clamp01(current - 0.2);
  }
}

function feedbackConfidence(current: number, outcome: MemoryFeedbackInput["outcome"]) {
  switch (outcome) {
    case "helpful":
      return clamp01(current + 0.02);
    case "used":
      return current;
    case "irrelevant":
      return clamp01(current - 0.03);
    case "stale":
      return clamp01(current - 0.15);
    case "wrong":
      return clamp01(current - 0.3);
  }
}

function normalizeCues(input: string[] | undefined, content: string): string[] {
  const explicit = (input ?? [])
    .map((cue) => cue.trim())
    .filter(Boolean);
  if (explicit.length > 0) return Array.from(new Set(explicit)).slice(0, 12);
  return Array.from(new Set(content
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 12)));
}
