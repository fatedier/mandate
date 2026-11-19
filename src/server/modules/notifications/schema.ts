import type { Database } from "bun:sqlite";

/** Each notice sent, and what each channel did with it: what a repeat, an
 *  escalation or a withdrawal reads, after a restart too. */
export function initializeNotificationsSchema(db: Database): void {
  db.exec(`
    create table if not exists notifications (
      id            text primary key,
      matter_key    text not null,
      source        text not null check (source in ('agent', 'system')),
      level         text not null check (level in ('needs_you', 'news')),
      title         text not null,
      body          text not null,
      link          text not null,
      created_at    text not null,
      -- The external channels' turn, while the user was at the desk.
      escalate_at   text,
      seen_at       text,
      settled_at    text,
      superseded_by text,
      -- What the agent was told of this notice: a repeat is told it again.
      line          text,
      -- The channels the personal agent named (a JSON array of their names), null
      -- when Mandate chose: those keep the notice once the user has seen it.
      named_channels text
    )
  `);
  db.exec("create index if not exists idx_notifications_matter on notifications(matter_key, created_at)");
  db.exec("create index if not exists idx_notifications_escalate on notifications(escalate_at) where escalate_at is not null");
  db.exec("create index if not exists idx_notifications_created on notifications(created_at)");
  db.exec(`
    create table if not exists notification_sends (
      notification_id text not null,
      channel_id      text not null,
      state           text not null check (state in ('sent', 'failed', 'withdrawn')),
      -- The channel's own id for what it showed (Telegram's message id).
      ref             text,
      error           text,
      at              text not null,
      -- 1 for the "More in Mandate" notice that pauses a channel: neither
      -- counted against the hour nor ever replaced or taken back.
      summary         integer not null default 0,
      primary key (notification_id, channel_id)
    )
  `);
  db.exec("create index if not exists idx_notification_sends_channel on notification_sends(channel_id, at)");
}
