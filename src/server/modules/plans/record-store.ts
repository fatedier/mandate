import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import { buildWordsQuery, historyWordsVersion, queryTerms, wordsOf } from "../agent/history-words.js";

/** How many records one search returns. */
export const RECORD_SEARCH_LIMIT = 5;

/** How long a line of a record a search shows can be. */
const LINE_CHARS = 200;

/** A task record's first line, cut at 200 characters: how lists and searches
 *  name one (the record itself is long history). */
export function firstLineOf(content: string): string {
  return content.split("\n")[0]!.slice(0, LINE_CHARS);
}

export interface FeatureRecord {
  id: string;
  featureId: string;
  /** The worker's name, as its feature is named. */
  workerName: string;
  projectId: string;
  content: string;
  sourceThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
}

/** A record as a list names it: by its worker and first line. */
export interface FeatureRecordLine {
  id: string;
  featureId: string;
  workerName: string;
  projectId: string;
  updatedAt: string;
  firstLine: string;
}

/** A record a search found, with the lines that hold the query's terms. */
export interface FeatureRecordHit extends FeatureRecordLine {
  lines: string[];
}

interface RecordRow {
  rid: number;
  id: string;
  feature_id: string;
  project_id: string;
  content: string;
  source_thread_id: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
  worker_name?: string;
}

const COLUMNS = "r.rowid as rid, r.id, r.feature_id, r.project_id, r.content, r.source_thread_id, r.created_at, r.updated_at, r.metadata_json";

function toRecord(row: RecordRow): FeatureRecord {
  return {
    id: row.id,
    featureId: row.feature_id,
    workerName: row.worker_name ?? "",
    projectId: row.project_id,
    content: row.content,
    sourceThreadId: row.source_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : null
  };
}

function toLine(row: RecordRow): FeatureRecordLine {
  return {
    id: row.id,
    featureId: row.feature_id,
    workerName: row.worker_name ?? "",
    projectId: row.project_id,
    updatedAt: row.updated_at,
    firstLine: firstLineOf(row.content)
  };
}

/** The lines of `content` holding one of the terms, the first two, each cut. */
function linesWith(content: string, terms: readonly string[]): string[] {
  const wanted = terms.map((term) => term.toLowerCase());
  return content
    .split("\n")
    .filter((line) => wanted.some((term) => line.toLowerCase().includes(term)))
    .slice(0, 2)
    .map((line) => line.slice(0, LINE_CHARS));
}

/**
 * Workers' task records: one per worker, written by memory extraction and
 * rewritten in place, read whole by the worker itself and by any agent that
 * opens one, listed newest first and found by the words they hold. A record
 * goes with its worker (the table cascades from `features`, and a trigger
 * takes its words with it).
 */
export class FeatureRecordStore {
  constructor(private readonly db: Database, private readonly now: () => string = () => new Date().toISOString()) {}

  get(featureId: string): FeatureRecord | null {
    const row = this.db.prepare(`select ${COLUMNS}, f.name as worker_name from feature_records r join features f on f.id = r.feature_id where r.feature_id = ?`).get(featureId) as RecordRow | null;
    return row ? toRecord(row) : null;
  }

  getById(id: string): FeatureRecord | null {
    const row = this.db.prepare(`select ${COLUMNS}, f.name as worker_name from feature_records r join features f on f.id = r.feature_id where r.id = ?`).get(id) as RecordRow | null;
    return row ? toRecord(row) : null;
  }

  /** The worker's record created, or rewritten in place: same id, same
   *  start, the thread it was first written from kept. */
  write(input: { featureId: string; projectId: string; content: string; sourceThreadId: string | null; metadata: Record<string, unknown> | null }): { record: FeatureRecord; created: boolean } {
    return this.db.transaction(() => {
      const at = this.now();
      const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
      const existing = this.db.prepare("select rowid as rid from feature_records where feature_id = ?").get(input.featureId) as { rid: number } | null;
      if (existing) {
        this.db.prepare("update feature_records set content = ?, metadata_json = ?, updated_at = ? where feature_id = ?")
          .run(input.content, metadata, at, input.featureId);
        this.db.prepare("update feature_record_words set content_words = ? where rowid = ?").run(wordsOf(input.content), existing.rid);
      } else {
        this.db.prepare(`insert into feature_records (feature_id, id, project_id, content, source_thread_id, created_at, updated_at, metadata_json)
          values (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.featureId, newId("mem"), input.projectId, input.content, input.sourceThreadId, at, at, metadata);
        const rid = (this.db.prepare("select rowid as rid from feature_records where feature_id = ?").get(input.featureId) as { rid: number }).rid;
        this.db.prepare("insert into feature_record_words (rowid, content_words) values (?, ?)").run(rid, wordsOf(input.content));
      }
      // The words above were read by this ICU: an index without a version yet is current.
      this.db.prepare("insert or ignore into feature_record_words_state (key, value) values ('version', ?)").run(historyWordsVersion());
      return { record: this.get(input.featureId)!, created: !existing };
    })();
  }

  /** A project's newest records, archived workers' included. */
  recent(projectId: string, opts: { limit: number; excludeFeatureId?: string | null }): FeatureRecordLine[] {
    const rows = this.db.prepare(`select ${COLUMNS}, f.name as worker_name
      from feature_records r join features f on f.id = r.feature_id
      where r.project_id = ? and r.feature_id != ?
      order by r.updated_at desc, r.rowid desc
      limit ?`).all(projectId, opts.excludeFeatureId ?? "", opts.limit) as RecordRow[];
    return rows.map(toLine);
  }

  hasAny(projectId: string): boolean {
    return this.db.prepare("select 1 from feature_records where project_id = ? limit 1").get(projectId) != null;
  }

  /** The records holding the query's words, most relevant first, then the
   *  newest. `since` / `until` bound the last rewrite when given. */
  search(input: { query: string; projectIds: readonly string[]; featureId?: string | null; excludeFeatureId?: string | null; since?: string | null; until?: string | null; limit: number }): FeatureRecordHit[] {
    const match = buildWordsQuery(input.query);
    if (!match || input.projectIds.length === 0) return [];
    const where = [`feature_record_words match ?`, `r.project_id in (${input.projectIds.map(() => "?").join(",")})`];
    const params: Array<string | number> = [match, ...input.projectIds];
    if (input.featureId) { where.push("r.feature_id = ?"); params.push(input.featureId); }
    if (input.excludeFeatureId) { where.push("r.feature_id != ?"); params.push(input.excludeFeatureId); }
    if (input.since) { where.push("r.updated_at >= ?"); params.push(input.since); }
    if (input.until) { where.push("r.updated_at <= ?"); params.push(input.until); }
    const rows = this.db.prepare(`select ${COLUMNS}, f.name as worker_name
      from feature_record_words w
      join feature_records r on r.rowid = w.rowid
      join features f on f.id = r.feature_id
      where ${where.join(" and ")}
      order by bm25(feature_record_words), r.updated_at desc
      limit ?`).all(...params, input.limit) as RecordRow[];
    const terms = queryTerms(input.query);
    return rows.map((row) => ({ ...toLine(row), lines: linesWith(row.content, terms) }));
  }

  /** Every record read again by word, at each start-up. The words are kept
   *  by the record's rowid, which a VACUUM may renumber (the table has no
   *  INTEGER PRIMARY KEY), and another ICU (a new runtime) splits runs
   *  differently. Records are few (one per worker). How many were read, and
   *  whether the ICU had changed. */
  reindex(): { read: number; icuChanged: boolean } {
    const version = historyWordsVersion();
    const stored = this.db.prepare("select value from feature_record_words_state where key = 'version'").get() as { value: string } | null;
    const icuChanged = stored !== null && stored.value !== version;
    const read = this.db.transaction(() => {
      const rows = this.db.prepare("select rowid as rid, content from feature_records").all() as Array<{ rid: number; content: string }>;
      this.db.prepare("delete from feature_record_words").run();
      const insert = this.db.prepare("insert into feature_record_words (rowid, content_words) values (?, ?)");
      for (const row of rows) insert.run(row.rid, wordsOf(row.content));
      this.db.prepare("insert into feature_record_words_state (key, value) values ('version', ?) on conflict(key) do update set value = excluded.value").run(version);
      return rows.length;
    })();
    return { read, icuChanged };
  }
}
