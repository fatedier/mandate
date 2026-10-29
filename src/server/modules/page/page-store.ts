import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import { AGENT_PAGE_LIMITS, type AgentPageAnswerDto, type AgentPageStateDto, type AgentPageVersionDto, type AgentPageWriteDto, type AgentPageWriteStatus } from "../../../shared/api/agent-page.js";

interface VersionRow { revision: number; html: string; writer: string; created_at: string }
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

const toVersion = (r: VersionRow): AgentPageVersionDto => ({ revision: r.revision, html: r.html, writer: r.writer, createdAt: r.created_at });
const toWrite = (r: WriteRow): AgentPageWriteDto => ({
  taskId: r.task_id,
  title: r.title,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  revision: r.revision,
  error: r.error
});

/** Your agent's page in the database: its versions, newest kept; the page
 *  subagents' writes; and what each file was when last published or applied. */
export class PageStore {
  constructor(private readonly db: Database) {}

  /** One write: all of it or none. */
  transaction<T>(write: () => T): T {
    return this.db.inTransaction ? write() : this.db.transaction(write).immediate();
  }

  /** A new version, unless it is the latest one's HTML again (null). */
  publish(html: string, writer: string): AgentPageVersionDto | null {
    return this.db.transaction(() => {
      const latest = this.latest();
      if (latest && latest.html === html) return null;
      const revision = (latest?.revision ?? 0) + 1;
      this.db.prepare("insert into agent_page_versions (revision, html, writer, created_at) values (?, ?, ?, ?)")
        .run(revision, html, writer, new Date().toISOString());
      this.db.prepare("delete from agent_page_versions where revision <= ?").run(revision - AGENT_PAGE_LIMITS.versions);
      return this.version(revision);
    }).immediate();
  }

  latest(): AgentPageVersionDto | null {
    const row = this.db.prepare("select * from agent_page_versions order by revision desc limit 1").get() as VersionRow | undefined;
    return row ? toVersion(row) : null;
  }

  version(revision: number): AgentPageVersionDto | null {
    const row = this.db.prepare("select * from agent_page_versions where revision = ?").get(revision) as VersionRow | undefined;
    return row ? toVersion(row) : null;
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
   *  to Your agent. */
  addAnswer(value: unknown, mailboxId: string, at = new Date().toISOString()): AgentPageAnswerDto {
    const id = newId("pga");
    this.db.prepare("insert into agent_page_answers (id, value_json, created_at, mailbox_id) values (?, ?, ?, ?)")
      .run(id, JSON.stringify(value), at, mailboxId);
    return toAnswer(this.db.prepare("select * from agent_page_answers where id = ?").get(id) as AnswerRow);
  }

  /** How many answers have not reached Your agent yet. */
  unreadAnswers(): number {
    return (this.db.prepare("select count(*) as n from agent_page_answers where read_at is null").get() as { n: number }).n;
  }

  /** Newest first. */
  answers(limit: number): AgentPageAnswerDto[] {
    return (this.db.prepare("select * from agent_page_answers order by created_at desc, rowid desc limit ?").all(limit) as AnswerRow[]).map(toAnswer);
  }

  /** The answers these mailbox rows carried reached Your agent: read. The
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
