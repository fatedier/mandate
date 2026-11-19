import type { Database } from "bun:sqlite";

/** Chat history read by word. The FTS5 `unicode61` tokenizer keeps a run of
 *  Han (or kana) characters as one token, so a Chinese word inside a clause
 *  was found only when it began the run. The words index holds each entry's
 *  text with those runs split into words by the platform's ICU segmenter, and
 *  a query's terms are split the same way. */

/** Runs of characters written without spaces between words. */
const UNSPACED_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const HAS_UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/** `text` with every unspaced run split into words, each set apart by spaces. */
export function wordsOf(text: string): string {
  return text.replace(UNSPACED_RUN, (run) => ` ${Array.from(segmenter.segment(run), (part) => part.segment).join(" ")} `);
}

/** What splits words differently: a new ICU may cut a run another way, and
 *  the index must then be read again with it. */
export function historyWordsVersion(): string {
  return `icu-${process.versions.icu ?? "unknown"}`;
}

/** The terms of a query: at most 12. */
export function queryTerms(query: string): string[] {
  return query
    .trim()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim().replace(/"/g, ""))
    .filter((term) => term.length > 0)
    .slice(0, 12);
}

/** The FTS5 query for the words index: a term with unspaced text is its
 *  words in order, as a phrase whose last word may run on; another term,
 *  its start. Every term is quoted, so one spelled like an operator (OR,
 *  AND, NOT, NEAR) is a word. Terms are joined by OR. */
export function buildWordsQuery(query: string): string {
  return queryTerms(query).map((term) => {
    const words = HAS_UNSPACED.test(term) ? wordsOf(term).trim().split(/\s+/).filter(Boolean) : [term];
    return `"${words.join(" ")}"*`;
  }).join(" OR ");
}

/** A word row's rowid: the message's second, times this, plus the first
 *  free slot in that second. Rowids then run in time, and a search's time
 *  range is a rowid range the FTS index can skip by. Whole seconds keep
 *  every rowid a safe integer until the year 2242. */
export const WORD_KEY_SLOTS = 2 ** 20;

function secondOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

/** The rowid range of a time range: whole seconds, the last one included. */
export function wordKeyBounds(range: { since: string | null; until: string | null }): [number, number] {
  const low = range.since ? secondOf(range.since) * WORD_KEY_SLOTS : 0;
  const high = range.until ? secondOf(range.until) * WORD_KEY_SLOTS + WORD_KEY_SLOTS - 1 : Number.MAX_SAFE_INTEGER;
  return [low, high];
}

/** The first rowid of a message's second. */
export function wordKeyBase(createdAt: string): number {
  return secondOf(createdAt) * WORD_KEY_SLOTS;
}


/** Whether this database has the words index: an SQLite older than 3.43
 *  cannot make it (history-schema.ts), and then nothing here does anything. */
const available = new WeakMap<Database, boolean>();
export function historyWordsAvailable(db: Database): boolean {
  let known = available.get(db);
  if (known === undefined) {
    known = Boolean(db.prepare("select 1 from sqlite_master where name = 'agent_message_search_words'").get());
    available.set(db, known);
  }
  return known;
}

/** The old index is the one written and read: only where the words index cannot be made. */
export function historyOldIndexInUse(db: Database): boolean {
  return !historyWordsAvailable(db);
}

/** Forgets what historyWordsAvailable found (for tests that drop the table). */
export function resetHistoryWordsAvailability(db: Database): void {
  available.delete(db);
}

/** One entry's text, as the words index reads it. */
export interface WordsEntry {
  id: string;
  createdAt: string;
  contentText: string;
  toolNames: string[];
  /** When the entry was written: an entry rewritten outside the server (a
   *  data script, which then starts a new pass) differs from its words. */
  indexedAt: string;
}

/** Writes `entry`'s words, replacing any it had, at the next free rowid of its
 *  second: the row and its key together, or neither. A slot is free when the
 *  words table has no row there, so a stray row (an older crash) is passed over. */
export function writeWordsRow(db: Database, entry: WordsEntry): void {
  if (!historyWordsAvailable(db)) return;
  db.transaction(() => {
    deleteWordsRow(db, entry.id);
    const base = wordKeyBase(entry.createdAt);
    const last = (db.prepare("select max(rowid) as m from agent_message_search_words where rowid between ? and ?")
      .get(base, base + WORD_KEY_SLOTS - 1) as { m: number | null }).m;
    const key = last === null ? base : last + 1;
    if (key >= base + WORD_KEY_SLOTS) throw new Error("no free words rowid left in this second");
    db.prepare("insert into agent_message_search_words (rowid, content_words, tool_names) values (?, ?, ?)")
      .run(key, wordsOf(entry.contentText), entry.toolNames.join(" "));
    db.prepare("insert into agent_message_search_word_keys (entry_id, word_rowid, indexed_at) values (?, ?, ?)")
      .run(entry.id, key, entry.indexedAt);
  }).immediate();
}

/** Pages of merging one statement does: a few milliseconds of work, nothing
 *  when there is nothing to fold. */
const MERGE_PAGES = 64;
/** How long one run of merging may hold the server's thread. */
const MERGE_BUDGET_MS = 20;

/** Folds the segments writes left in the words index, which does not merge
 *  as a message is written (history-schema.ts), step by step until nothing
 *  is left or `budgetMs` is spent; true when more is left. Run on a timer
 *  often enough to keep up: an index left behind would have SQLite fold
 *  sixteen segments at once inside some message's write (its crisis merge),
 *  far longer than any of these steps. */
export function mergeHistoryWords(db: Database, budgetMs = MERGE_BUDGET_MS): boolean {
  if (!historyWordsAvailable(db)) return false;
  const step = db.prepare("insert into agent_message_search_words(agent_message_search_words, rank) values('merge', ?)");
  // FTS5's list of the index's segments, kept as row 10 of its data table: a
  // step that leaves it as it was found nothing to fold. (The step is an
  // insert, so SQLite's change count moves whether it merged or not.)
  const structure = db.prepare("select block from agent_message_search_words_data where id = 10");
  const read = () => (structure.get() as { block: Uint8Array } | null)?.block ?? null;
  const same = (a: Uint8Array | null, b: Uint8Array | null) => a === b || (a !== null && b !== null && Buffer.from(a).equals(Buffer.from(b)));
  const started = performance.now();
  for (;;) {
    const before = read();
    step.run(MERGE_PAGES);
    if (same(read(), before)) return false;
    if (performance.now() - started >= budgetMs) return true;
  }
}

/** Removes `entryId`'s words, by the rowid kept for it. */
export function deleteWordsRow(db: Database, entryId: string): void {
  if (!historyWordsAvailable(db)) return;
  const row = db.prepare("select word_rowid from agent_message_search_word_keys where entry_id = ?").get(entryId) as { word_rowid: number } | null;
  if (!row) return;
  db.prepare("delete from agent_message_search_words where rowid = ?").run(row.word_rowid);
  db.prepare("delete from agent_message_search_word_keys where entry_id = ?").run(entryId);
}

function stateOf(db: Database, key: string): string | null {
  return (db.prepare("select value from agent_message_search_words_state where key = ?").get(key) as { value: string } | null)?.value ?? null;
}

function setState(db: Database, key: string, value: string): void {
  db.prepare("insert into agent_message_search_words_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
}

/** Whether search may read the words index: a whole pass has read every
 *  entry with this segmenter. */
export function historyWordsReady(db: Database, version = historyWordsVersion()): boolean {
  return historyWordsAvailable(db) && stateOf(db, "version") === version && stateOf(db, "ready") === "1";
}

/** One step of a pass over the words index, never more than `batch` rows:
 *  first the entries, a window of rowids at a time, each read in when the
 *  index lacks it or holds it stale (rewritten without its words); then the
 *  keys, a window at a time, dropping those whose entry is gone. Ready when
 *  a pass ends. Another segmenter's index is cleared first, and only where
 *  `reset` allows (not on a search: that is the whole index at once). */
export function fillHistoryWords(db: Database, opts: { batch?: number; version?: string; reset?: boolean } = {}): { ready: boolean; filled: number } {
  if (!historyWordsAvailable(db)) return { ready: false, filled: 0 };
  const batch = opts.batch ?? 1_000;
  const version = opts.version ?? historyWordsVersion();
  return db.transaction(() => {
    const stored = stateOf(db, "version");
    if (stored !== version) {
      // A first fill keeps what this binary wrote; another segmenter's rows go.
      if (stored !== null) {
        if (opts.reset === false) return { ready: false, filled: 0 };
        db.exec("insert into agent_message_search_words (agent_message_search_words) values ('delete-all'); delete from agent_message_search_word_keys");
      }
      setState(db, "version", version);
      startPass(db);
    }
    // A step spends at most `batch` rowids: the entries' window first, what
    // is left on the keys' window.
    let budget = batch;
    let filled = 0;
    let cursor = Number(stateOf(db, "cursor") ?? "0");
    const lastEntry = (db.prepare("select max(rowid) as m from agent_message_search_entries").get() as { m: number | null }).m ?? 0;
    if (cursor < lastEntry) {
      const end = Math.min(cursor + budget, lastEntry);
      const rows = db.prepare(`
        select e.id, e.content_text, e.tool_names_json, e.message_created_at, e.indexed_at
        from agent_message_search_entries e
        left join agent_message_search_word_keys k on k.entry_id = e.id
        where e.rowid > ? and e.rowid <= ? and (k.entry_id is null or k.indexed_at != e.indexed_at)
        order by e.rowid`).all(cursor, end) as Array<{ id: string; content_text: string; tool_names_json: string | null; message_created_at: string; indexed_at: string }>;
      for (const row of rows) {
        writeWordsRow(db, { id: row.id, createdAt: row.message_created_at, contentText: row.content_text, toolNames: toolNamesOf(row.tool_names_json), indexedAt: row.indexed_at });
      }
      filled = rows.length;
      budget -= end - cursor;
      cursor = end;
    }
    let keyCursor = Number(stateOf(db, "keyCursor") ?? "0");
    const lastKey = (db.prepare("select max(rowid) as m from agent_message_search_word_keys").get() as { m: number | null }).m ?? 0;
    if (cursor >= lastEntry && budget > 0 && keyCursor < lastKey) {
      const end = Math.min(keyCursor + budget, lastKey);
      const gone = db.prepare(`
        select k.entry_id from agent_message_search_word_keys k
        where k.rowid > ? and k.rowid <= ? and not exists (select 1 from agent_message_search_entries e where e.id = k.entry_id)`)
        .all(keyCursor, end) as Array<{ entry_id: string }>;
      for (const row of gone) deleteWordsRow(db, row.entry_id);
      keyCursor = end;
    }
    // The pass is over when every entry is read and every key checked.
    const done = cursor >= lastEntry && keyCursor >= lastKey;
    setState(db, "cursor", done ? "0" : String(cursor));
    setState(db, "keyCursor", done ? "0" : String(keyCursor));
    if (done) setState(db, "ready", "1");
    return { ready: done, filled };
  }).immediate();
}

/** A new pass from the first entry (a first fill, a new segmenter): search
 *  finds by text until it ends. */
function startPass(db: Database): void {
  setState(db, "cursor", "0");
  setState(db, "keyCursor", "0");
  setState(db, "ready", "0");
}

const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

/** At start-up: when the words index is not whole for this segmenter (a first
 *  fill, a new ICU), a pass over it, each step scheduled after the one before,
 *  so the server goes on answering in between. A whole index is left alone:
 *  every write keeps an entry and its words together. */
export function runHistoryWordsFill(db: Database, opts: {
  /** Runs `step` after `delayMs` (none: as soon as the server is free). */
  schedule: (step: () => void, delayMs?: number) => void;
  log?: (line: string) => void;
  /** A step failed (a lock, a full disk): it is tried again after a minute,
   *  then twice as long each time, up to half an hour. */
  onError?: (error: unknown) => void;
  batch?: number;
  version?: string;
}): void {
  if (!historyWordsAvailable(db)) return;
  const version = opts.version ?? historyWordsVersion();
  let started = false;
  let filled = 0;
  let failures = 0;
  const step = () => {
    let result: { ready: boolean; filled: number };
    try {
      // Asked inside the try, so a read that fails is tried again too.
      if (!started) {
        if (historyWordsReady(db, version)) return;
        started = true;
      }
      result = fillHistoryWords(db, { ...(opts.batch ? { batch: opts.batch } : {}), version });
    } catch (error) {
      opts.onError?.(error);
      // Only here may another segmenter's index be cleared (a search may
      // not), so the fill must go on once the database is free again.
      opts.schedule(step, Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_MAX_MS));
      failures += 1;
      return;
    }
    failures = 0;
    filled += result.filled;
    if (!result.ready) {
      opts.schedule(step);
      return;
    }
    if (filled > 0) opts.log?.(`[mandate] chat history: read ${filled} messages into the words index`);
  };
  opts.schedule(step);
}

function toolNamesOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}
