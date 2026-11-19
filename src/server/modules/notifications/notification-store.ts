import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";

/** How long a notice and its sends are kept. */
export const RECORD_KEEP_DAYS = 30;

export type NotificationSource = "agent" | "system";
export type NotificationLevel = "needs_you" | "news";
export type SendState = "sent" | "failed" | "withdrawn";

export interface NewNotification {
  matterKey: string;
  source: NotificationSource;
  level: NotificationLevel;
  title: string;
  body: string;
  /** The app route it opens. */
  link: string;
  escalateAt?: string | null;
  line?: string | null;
  /** The channels the personal agent named; null or absent: Mandate chose. */
  namedChannels?: readonly string[] | null;
}

export interface NotificationRow {
  id: string;
  matterKey: string;
  source: NotificationSource;
  level: NotificationLevel;
  title: string;
  body: string;
  link: string;
  createdAt: string;
  escalateAt: string | null;
  seenAt: string | null;
  settledAt: string | null;
  supersededBy: string | null;
  line: string | null;
  namedChannels: string[] | null;
}

export interface SendRow {
  notificationId: string;
  channelId: string;
  state: SendState;
  ref: string | null;
  error: string | null;
  at: string;
  summary: boolean;
}

interface RawRow {
  id: string;
  matter_key: string;
  source: NotificationSource;
  level: NotificationLevel;
  title: string;
  body: string;
  link: string;
  created_at: string;
  escalate_at: string | null;
  seen_at: string | null;
  settled_at: string | null;
  superseded_by: string | null;
  line: string | null;
  named_channels: string | null;
}

interface RawSend {
  notification_id: string;
  channel_id: string;
  state: SendState;
  ref: string | null;
  error: string | null;
  at: string;
  summary: number;
}

const OPEN = "seen_at is null and settled_at is null and superseded_by is null";
/** What a settling takes back: the open notices, and every named one not yet
 *  settled — kept once seen, its message may outlive a newer notice that
 *  went elsewhere or nowhere. */
const SETTLEABLE = "settled_at is null and ((seen_at is null and superseded_by is null) or named_channels is not null)";

function toRow(raw: RawRow): NotificationRow {
  return {
    id: raw.id,
    matterKey: raw.matter_key,
    source: raw.source,
    level: raw.level,
    title: raw.title,
    body: raw.body,
    link: raw.link,
    createdAt: raw.created_at,
    escalateAt: raw.escalate_at,
    seenAt: raw.seen_at,
    settledAt: raw.settled_at,
    supersededBy: raw.superseded_by,
    line: raw.line,
    namedChannels: raw.named_channels === null ? null : JSON.parse(raw.named_channels) as string[]
  };
}

function toSend(raw: RawSend): SendRow {
  return { notificationId: raw.notification_id, channelId: raw.channel_id, state: raw.state, ref: raw.ref, error: raw.error, at: raw.at, summary: raw.summary === 1 };
}

/** The notices sent and each channel's part in them. Open: neither seen,
 *  settled nor superseded by a newer notice on its matter. */
export class NotificationStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  /** Writes a notice; notices older than RECORD_KEEP_DAYS go in the same step. */
  insert(input: NewNotification): NotificationRow {
    const id = newId("ntf");
    const createdAt = this.now().toISOString();
    const cutoff = new Date(this.now().getTime() - RECORD_KEEP_DAYS * 86_400_000).toISOString();
    this.db.transaction(() => {
      this.db.prepare("delete from notification_sends where notification_id in (select id from notifications where created_at < ?)").run(cutoff);
      this.db.prepare("delete from notifications where created_at < ?").run(cutoff);
      this.db.prepare(`
        insert into notifications (id, matter_key, source, level, title, body, link, created_at, escalate_at, line, named_channels)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.matterKey, input.source, input.level, input.title, input.body, input.link, createdAt, input.escalateAt ?? null, input.line ?? null,
        input.namedChannels ? JSON.stringify(input.namedChannels) : null);
    })();
    return this.get(id)!;
  }

  get(id: string): NotificationRow | null {
    const raw = this.db.prepare("select * from notifications where id = ?").get(id) as RawRow | null;
    return raw ? toRow(raw) : null;
  }

  latestOpen(matterKey: string): NotificationRow | null {
    const raw = this.db.prepare(`select * from notifications where matter_key = ? and ${OPEN} order by created_at desc, rowid desc limit 1`).get(matterKey) as RawRow | null;
    return raw ? toRow(raw) : null;
  }

  supersede(oldId: string, newId: string): void {
    this.db.prepare("update notifications set superseded_by = ?, escalate_at = null where id = ?").run(newId, oldId);
  }

  /** Marks the matter's open notices seen; their ids. */
  markSeen(matterKey: string, at: string): string[] {
    return this.closeWhere(matterKey, "seen_at", at, OPEN);
  }

  /** Marks the matter's notices settled — open ones, and named ones kept
   *  once seen; their ids. */
  markSettled(matterKey: string, at: string): string[] {
    return this.closeWhere(matterKey, "settled_at", at, SETTLEABLE);
  }

  private closeWhere(matterKey: string, column: "seen_at" | "settled_at", at: string, which: string): string[] {
    const ids = (this.db.prepare(`select id from notifications where matter_key = ? and ${which}`).all(matterKey) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length > 0) {
      this.db.prepare(`update notifications set ${column} = ?, escalate_at = null where matter_key = ? and ${which}`).run(at, matterKey);
    }
    return ids;
  }

  openMatters(): NotificationRow[] {
    return (this.db.prepare(`select * from notifications where ${OPEN} order by created_at, rowid`).all() as RawRow[]).map(toRow);
  }

  /** The matters a settling would take something back from, oldest first. */
  settleableMatterKeys(): string[] {
    const rows = this.db.prepare(`select matter_key from notifications where ${SETTLEABLE} order by created_at, rowid`).all() as Array<{ matter_key: string }>;
    return [...new Set(rows.map((row) => row.matter_key))];
  }

  dueEscalations(now: Date): NotificationRow[] {
    return (this.db.prepare("select * from notifications where escalate_at is not null and escalate_at <= ? order by escalate_at, rowid").all(now.toISOString()) as RawRow[]).map(toRow);
  }

  clearEscalation(id: string): void {
    this.db.prepare("update notifications set escalate_at = null where id = ?").run(id);
  }

  /** The matter's newest notice, open or not. */
  latestFor(matterKey: string): NotificationRow | null {
    const raw = this.db.prepare("select * from notifications where matter_key = ? order by created_at desc, rowid desc limit 1").get(matterKey) as RawRow | null;
    return raw ? toRow(raw) : null;
  }

  /** The matter's newest notice with a send on one of the channels. */
  latestWithSend(matterKey: string, channelIds: readonly string[]): NotificationRow | null {
    const raw = this.db.prepare(`
      select n.* from notifications n
      where n.matter_key = ? and exists (select 1 from notification_sends s where s.notification_id = n.id and s.channel_id in (${channelIds.map(() => "?").join(", ")}))
      order by n.created_at desc, n.rowid desc limit 1
    `).get(matterKey, ...channelIds) as RawRow | null;
    return raw ? toRow(raw) : null;
  }

  setLine(id: string, line: string | null): void {
    this.db.prepare("update notifications set line = ? where id = ?").run(line, id);
  }

  /** What a channel did with a notice; a later state replaces the earlier
   *  one, keeping when it was first sent. */
  recordSend(notificationId: string, channelId: string, outcome: { state: SendState; ref: string | null; error: string | null; summary?: boolean }): void {
    this.db.prepare(`
      insert into notification_sends (notification_id, channel_id, state, ref, error, at, summary) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (notification_id, channel_id) do update set state = excluded.state, ref = coalesce(excluded.ref, ref), error = excluded.error
    `).run(notificationId, channelId, outcome.state, outcome.ref, outcome.error, this.now().toISOString(), outcome.summary ? 1 : 0);
  }

  /** What a matter still shows on its channels: every message sent for any
   *  of its notices and not yet taken back, newest first. */
  liveSends(matterKey: string): SendRow[] {
    return (this.db.prepare(`
      select s.* from notification_sends s join notifications n on n.id = s.notification_id
      where n.matter_key = ? and s.state = 'sent' and s.ref is not null and s.summary = 0
      order by s.at desc, s.rowid desc
    `).all(matterKey) as RawSend[]).map(toSend);
  }

  /** The message is gone from its channel: every notice that showed it. */
  markWithdrawn(channelId: string, ref: string): void {
    this.db.prepare("update notification_sends set state = 'withdrawn' where channel_id = ? and ref = ? and state = 'sent'").run(channelId, ref);
  }

  /** When the channel was last told it is paused, within the window. */
  lastSummarySince(channelId: string, sinceIso: string): string | null {
    const row = this.db.prepare("select max(at) at from notification_sends where channel_id = ? and summary = 1 and state = 'sent' and at >= ?").get(channelId, sinceIso) as { at: string | null };
    return row.at;
  }

  sendsOf(notificationId: string): SendRow[] {
    return (this.db.prepare("select * from notification_sends where notification_id = ? order by rowid").all(notificationId) as RawSend[]).map(toSend);
  }

  /** How many notices reached the channel since then (withdrawn ones did
   *  reach it; the pause notice is not one). */
  externalSendsSince(channelId: string, sinceIso: string): number {
    const row = this.db.prepare("select count(*) n from notification_sends where channel_id = ? and state <> 'failed' and summary = 0 and at >= ?").get(channelId, sinceIso) as { n: number };
    return row.n;
  }

  oldestExternalSendSince(channelId: string, sinceIso: string): string | null {
    const row = this.db.prepare("select min(at) at from notification_sends where channel_id = ? and state <> 'failed' and summary = 0 and at >= ?").get(channelId, sinceIso) as { at: string | null };
    return row.at;
  }

  lastWithSameText(matterKey: string, title: string, body: string, sinceIso: string): NotificationRow | null {
    const raw = this.db.prepare("select * from notifications where matter_key = ? and title = ? and body = ? and created_at >= ? order by created_at desc, rowid desc limit 1")
      .get(matterKey, title, body, sinceIso) as RawRow | null;
    return raw ? toRow(raw) : null;
  }
}
