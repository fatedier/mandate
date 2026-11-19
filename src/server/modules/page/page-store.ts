import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import { AGENT_PAGE_FIRST, AGENT_PAGE_LIMITS, type AgentPageAnswerDto, type AgentPageStateDto, type AgentPageVersionDto, type AgentPageWriteDto, type AgentPageWriteStatus } from "../../../shared/api/agent-page.js";
import { siteDigest, siteFileDigest, type SiteFile } from "./page-site.js";

interface VersionRow { revision: number; html: string; writer: string; created_at: string }
interface FileRow { path: string; bytes: Uint8Array }
interface WriteRow {
  task_id: string;
  title: string;
  status: AgentPageWriteStatus;
  started_at: string;
  finished_at: string | null;
  revision: number | null;
  error: string | null;
}

interface AnswerRow { id: string; value_json: string; created_at: string; mailbox_id: string | null; read_at: string | null }
const toAnswer = (r: AnswerRow): AgentPageAnswerDto => ({ id: r.id, value: JSON.parse(r.value_json) as unknown, at: r.created_at, read: r.read_at !== null });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const toWrite = (r: WriteRow): AgentPageWriteDto => ({
  taskId: r.task_id,
  title: r.title,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  revision: r.revision,
  error: r.error
});

/** Personal agent's page in the database: its versions, the newest kept,
 *  each with the files of its folder; the page subagents' writes; and what
 *  each file was when last published or applied. */
export class PageStore {
  constructor(private readonly db: Database) {}

  /** One write: all of it or none. */
  transaction<T>(write: () => T): T {
    return this.db.inTransaction ? write() : this.db.transaction(write).immediate();
  }

  /** A new version of these files, unless they are the latest version's
   *  again (null). Versions past the newest kept go, with the files only
   *  they held. */
  publish(files: readonly SiteFile[], writer: string): AgentPageVersionDto | null {
    return this.db.transaction(() => {
      const latest = this.latestRevision();
      const entries = files.map((f) => ({ path: f.path, digest: siteFileDigest(f.bytes) }));
      if (latest !== null && siteDigest(this.manifest(latest)) === siteDigest(entries)) return null;
      const revision = (latest ?? 0) + 1;
      // The first page's HTML in the version's own row too, as a version
      // from before the folder kept it.
      const first = files.find((f) => f.path === AGENT_PAGE_FIRST);
      this.db.prepare("insert into agent_page_versions (revision, html, writer, created_at) values (?, ?, ?, ?)")
        .run(revision, first ? decoder.decode(first.bytes) : "", writer, new Date().toISOString());
      const blob = this.db.prepare("insert into agent_page_blobs (digest, bytes) values (?, ?) on conflict(digest) do nothing");
      const file = this.db.prepare("insert into agent_page_version_files (revision, path, digest) values (?, ?, ?)");
      files.forEach((f, i) => {
        blob.run(entries[i]!.digest, f.bytes);
        file.run(revision, f.path, entries[i]!.digest);
      });
      const cut = revision - AGENT_PAGE_LIMITS.versions;
      this.db.prepare("delete from agent_page_version_files where revision <= ?").run(cut);
      this.db.prepare("delete from agent_page_versions where revision <= ?").run(cut);
      this.db.prepare("delete from agent_page_blobs where digest not in (select digest from agent_page_version_files)").run();
      return this.version(revision);
    }).immediate();
  }

  latest(): AgentPageVersionDto | null {
    const revision = this.latestRevision();
    return revision === null ? null : this.version(revision);
  }

  /** A version with the HTML of its pages. */
  version(revision: number): AgentPageVersionDto | null {
    const row = this.row(revision);
    if (!row) return null;
    const pages: Record<string, string> = {};
    for (const f of this.fileRows(row, "%.html")) if (f.path.endsWith(".html")) pages[f.path] = decoder.decode(f.bytes);
    return { revision: row.revision, pages, writer: row.writer, createdAt: row.created_at };
  }

  /** One file of a version, by its path; null when it has none there. */
  file(revision: number, filePath: string): Uint8Array | null {
    const row = this.row(revision);
    return row ? this.fileRows(row, filePath, true).find((f) => f.path === filePath)?.bytes ?? null : null;
  }

  /** Every file of a version, by path. */
  files(revision: number): SiteFile[] {
    const row = this.row(revision);
    return row ? this.fileRows(row, "%") : [];
  }

  private latestRevision(): number | null {
    const row = this.db.prepare("select revision from agent_page_versions order by revision desc limit 1").get() as { revision: number } | undefined;
    return row?.revision ?? null;
  }

  private row(revision: number): VersionRow | null {
    return (this.db.prepare("select * from agent_page_versions where revision = ?").get(revision) as VersionRow | undefined) ?? null;
  }

  /** A version's files whose paths match `like` (or equal it, `exact`); a
   *  version from before the folder has its html as index.html. */
  private fileRows(row: VersionRow, like: string, exact = false): FileRow[] {
    const rows = this.db.prepare(
      `select f.path, b.bytes from agent_page_version_files f join agent_page_blobs b on b.digest = f.digest
       where f.revision = ? and f.path ${exact ? "=" : "like"} ?`
    ).all(row.revision, like) as FileRow[];
    if (rows.length === 0 && !this.hasFiles(row.revision)) {
      return [{ path: AGENT_PAGE_FIRST, bytes: encoder.encode(row.html) }];
    }
    return rows.map((r) => ({ path: r.path, bytes: new Uint8Array(r.bytes) })).sort(byPath);
  }

  private hasFiles(revision: number): boolean {
    return Boolean(this.db.prepare("select 1 from agent_page_version_files where revision = ? limit 1").get(revision));
  }

  /** A version's files by path and digest. */
  private manifest(revision: number): Array<{ path: string; digest: string }> {
    const rows = this.db.prepare("select path, digest from agent_page_version_files where revision = ?").all(revision) as Array<{ path: string; digest: string }>;
    if (rows.length > 0) return rows;
    const row = this.row(revision);
    return row ? [{ path: AGENT_PAGE_FIRST, digest: siteFileDigest(encoder.encode(row.html)) }] : [];
  }

  startWrite(taskId: string, title: string): void {
    this.db.prepare(
      `insert into agent_page_writes (task_id, title, status, started_at) values (?, ?, 'running', ?)
       on conflict(task_id) do update set title = excluded.title, status = 'running', started_at = excluded.started_at,
         finished_at = null, revision = null, error = null`
    ).run(taskId, title, new Date().toISOString());
  }

  finishWrite(taskId: string, end: { status: Exclude<AgentPageWriteStatus, "running">; revision: number | null; error: string | null }): void {
    this.db.prepare("update agent_page_writes set status = ?, finished_at = ?, revision = ?, error = ? where task_id = ?")
      .run(end.status, new Date().toISOString(), end.revision, end.error, taskId);
  }

  /** The latest version's stamp, and the running write, else the last one. */
  state(): AgentPageStateDto {
    const latest = this.db.prepare("select revision, writer, created_at from agent_page_versions order by revision desc limit 1")
      .get() as Omit<VersionRow, "html"> | undefined;
    const write = this.db.prepare(
      `select * from agent_page_writes
       order by case status when 'running' then 0 else 1 end, started_at desc, rowid desc limit 1`
    ).get() as WriteRow | undefined;
    return {
      latest: latest ? { revision: latest.revision, writer: latest.writer, createdAt: latest.created_at } : null,
      write: write ? toWrite(write) : null
    };
  }

  /** Writes left running by a Mandate that stopped: failed, with why. */
  markRunningWritesFailed(error: string): string[] {
    const rows = this.db.prepare("select task_id from agent_page_writes where status = 'running' order by started_at, rowid")
      .all() as Array<{ task_id: string }>;
    this.db.prepare("update agent_page_writes set status = 'failed', finished_at = ?, error = ? where status = 'running'")
      .run(new Date().toISOString(), error);
    return rows.map((r) => r.task_id);
  }

  /** What the user gave on the page, with the mailbox row that carries it
   *  to the personal agent. */
  addAnswer(value: unknown, mailboxId: string, at = new Date().toISOString()): AgentPageAnswerDto {
    const id = newId("pga");
    this.db.prepare("insert into agent_page_answers (id, value_json, created_at, mailbox_id) values (?, ?, ?, ?)")
      .run(id, JSON.stringify(value), at, mailboxId);
    return toAnswer(this.db.prepare("select * from agent_page_answers where id = ?").get(id) as AnswerRow);
  }

  /** How many answers have not reached the personal agent yet. */
  unreadAnswers(): number {
    return (this.db.prepare("select count(*) as n from agent_page_answers where read_at is null").get() as { n: number }).n;
  }

  /** Newest first. */
  answers(limit: number): AgentPageAnswerDto[] {
    return (this.db.prepare("select * from agent_page_answers order by created_at desc, rowid desc limit ?").all(limit) as AnswerRow[]).map(toAnswer);
  }

  /** The answers these mailbox rows carried reached the personal agent: read. The
   *  ones read now. */
  markDelivered(mailboxIds: readonly string[]): AgentPageAnswerDto[] {
    if (mailboxIds.length === 0) return [];
    const marks = mailboxIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`select * from agent_page_answers where read_at is null and mailbox_id in (${marks})`).all(...mailboxIds) as AnswerRow[];
    if (rows.length === 0) return [];
    const at = new Date().toISOString();
    this.db.prepare(`update agent_page_answers set read_at = ? where read_at is null and mailbox_id in (${marks})`).run(at, ...mailboxIds);
    return rows.map((row) => toAnswer({ ...row, read_at: at }));
  }

  fileDigest(name: string): string | null {
    const row = this.db.prepare("select digest from agent_page_files where name = ?").get(name) as { digest: string } | undefined;
    return row?.digest ?? null;
  }

  setFileDigest(name: string, digest: string): void {
    this.db.prepare("insert into agent_page_files (name, digest) values (?, ?) on conflict(name) do update set digest = excluded.digest")
      .run(name, digest);
  }
}
