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

export interface WorkerRecord {
  id: string;
  workerId: string;
  /** The worker's name, as its worker is named. */
  workerName: string;
  projectId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** A record as a list names it: by its worker and first line. */
export interface WorkerRecordLine {
  id: string;
  workerId: string;
  workerName: string;
  projectId: string;
  updatedAt: string;
  firstLine: string;
}

/** A record a search found, with the lines that hold the query's terms. */
export interface WorkerRecordHit extends WorkerRecordLine {
  lines: string[];
}

interface RecordRow {
  rid: number;
  id: string;
  worker_id: string;
  project_id: string;
  content: string;
  created_at: string;
  updated_at: string;
  worker_name?: string;
}

const COLUMNS = "r.rowid as rid, r.id, r.worker_id, r.project_id, r.content, r.created_at, r.updated_at";

function toRecord(row: RecordRow): WorkerRecord {
  return {
    id: row.id,
    workerId: row.worker_id,
    workerName: row.worker_name ?? "",
    projectId: row.project_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toLine(row: RecordRow): WorkerRecordLine {
  return {
    id: row.id,
    workerId: row.worker_id,
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
 * goes with its worker (the table cascades from `workers`, and a trigger
 * takes its words with it).
 */
export class WorkerRecordStore {
  constructor(private readonly db: Database, private readonly now: () => string = () => new Date().toISOString()) {}

  get(workerId: string): WorkerRecord | null {
    const row = this.db.prepare(`select ${COLUMNS}, wk.name as worker_name from worker_records r join workers wk on wk.id = r.worker_id where r.worker_id = ?`).get(workerId) as RecordRow | null;
    return row ? toRecord(row) : null;
  }

  getById(id: string): WorkerRecord | null {
    const row = this.db.prepare(`select ${COLUMNS}, wk.name as worker_name from worker_records r join workers wk on wk.id = r.worker_id where r.id = ?`).get(id) as RecordRow | null;
    return row ? toRecord(row) : null;
  }

  /** The worker's record created, or rewritten in place: same id, same
   *  start. */
  write(input: { workerId: string; projectId: string; content: string }): { record: WorkerRecord; created: boolean } {
    return this.db.transaction(() => {
      const at = this.now();
      const existing = this.db.prepare("select rowid as rid from worker_records where worker_id = ?").get(input.workerId) as { rid: number } | null;
      if (existing) {
        this.db.prepare("update worker_records set content = ?, updated_at = ? where worker_id = ?")
          .run(input.content, at, input.workerId);
        this.db.prepare("update worker_record_words set content_words = ? where rowid = ?").run(wordsOf(input.content), existing.rid);
      } else {
        this.db.prepare(`insert into worker_records (worker_id, id, project_id, content, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`)
          .run(input.workerId, newId("mem"), input.projectId, input.content, at, at);
        const rid = (this.db.prepare("select rowid as rid from worker_records where worker_id = ?").get(input.workerId) as { rid: number }).rid;
        this.db.prepare("insert into worker_record_words (rowid, content_words) values (?, ?)").run(rid, wordsOf(input.content));
      }
      // The words above were read by this ICU: an index without a version yet is current.
      this.db.prepare("insert or ignore into worker_record_words_state (key, value) values ('version', ?)").run(historyWordsVersion());
      return { record: this.get(input.workerId)!, created: !existing };
    }).immediate();
  }

  /** A project's newest records, archived workers' included. */
  recent(projectId: string, opts: { limit: number; excludeWorkerId?: string | null }): WorkerRecordLine[] {
    const rows = this.db.prepare(`select ${COLUMNS}, wk.name as worker_name
      from worker_records r join workers wk on wk.id = r.worker_id
      where r.project_id = ? and r.worker_id != ?
      order by r.updated_at desc, r.rowid desc
      limit ?`).all(projectId, opts.excludeWorkerId ?? "", opts.limit) as RecordRow[];
    return rows.map(toLine);
  }

  hasAny(projectId: string): boolean {
    return this.db.prepare("select 1 from worker_records where project_id = ? limit 1").get(projectId) != null;
  }

  /** The records holding the query's words, most relevant first, then the
   *  newest. `since` / `until` bound the last rewrite when given. */
  search(input: { query: string; projectIds: readonly string[]; workerId?: string | null; excludeWorkerId?: string | null; since?: string | null; until?: string | null; limit: number }): WorkerRecordHit[] {
    const match = buildWordsQuery(input.query);
    if (!match || input.projectIds.length === 0) return [];
    const where = [`worker_record_words match ?`, `r.project_id in (${input.projectIds.map(() => "?").join(",")})`];
    const params: Array<string | number> = [match, ...input.projectIds];
    if (input.workerId) { where.push("r.worker_id = ?"); params.push(input.workerId); }
    if (input.excludeWorkerId) { where.push("r.worker_id != ?"); params.push(input.excludeWorkerId); }
    if (input.since) { where.push("r.updated_at >= ?"); params.push(input.since); }
    if (input.until) { where.push("r.updated_at <= ?"); params.push(input.until); }
    const rows = this.db.prepare(`select ${COLUMNS}, wk.name as worker_name
      from worker_record_words w
      join worker_records r on r.rowid = w.rowid
      join workers wk on wk.id = r.worker_id
      where ${where.join(" and ")}
      order by bm25(worker_record_words), r.updated_at desc
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
    const stored = this.db.prepare("select value from worker_record_words_state where key = 'version'").get() as { value: string } | null;
    const icuChanged = stored !== null && stored.value !== version;
    const read = this.db.transaction(() => {
      const rows = this.db.prepare("select rowid as rid, content from worker_records").all() as Array<{ rid: number; content: string }>;
      this.db.prepare("delete from worker_record_words").run();
      const insert = this.db.prepare("insert into worker_record_words (rowid, content_words) values (?, ?)");
      for (const row of rows) insert.run(row.rid, wordsOf(row.content));
      this.db.prepare("insert into worker_record_words_state (key, value) values ('version', ?) on conflict(key) do update set value = excluded.value").run(version);
      return rows.length;
    }).immediate();
    return { read, icuChanged };
  }
}
