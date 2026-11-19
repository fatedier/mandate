import type { Database } from "bun:sqlite";
import type { SideChatPart } from "../../../shared/agent-message-types.js";

/** A Send whose message waits behind the main conversation's turn, kept so a
 *  restart before it lands delivers it then, note and all. */
export interface WaitingSend {
  sideChatId: string;
  personalThreadId: string;
  requestId: string;
  text: string;
  part: SideChatPart;
}

export function initializeSideChatSchema(db: Database): void {
  db.exec(`
    create table if not exists side_chat_sends (
      side_chat_id        text primary key,
      personal_thread_id  text not null,
      request_id          text not null,
      text                text not null,
      summary             text not null,
      note                text not null,
      file                text not null,
      created_at          text not null
    )
  `);
}

export class SideChatSendStore {
  constructor(private readonly db: Database) {}

  add(send: WaitingSend): void {
    this.db.prepare(
      `insert or replace into side_chat_sends (side_chat_id, personal_thread_id, request_id, text, summary, note, file, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(send.sideChatId, send.personalThreadId, send.requestId, send.text, send.part.summary, send.part.note, send.part.file, new Date().toISOString());
  }

  remove(sideChatId: string): void {
    this.db.prepare(`delete from side_chat_sends where side_chat_id = ?`).run(sideChatId);
  }

  list(): WaitingSend[] {
    const rows = this.db.prepare(`select * from side_chat_sends order by created_at`).all() as Array<{
      side_chat_id: string; personal_thread_id: string; request_id: string; text: string; summary: string; note: string; file: string;
    }>;
    return rows.map((r) => ({
      sideChatId: r.side_chat_id, personalThreadId: r.personal_thread_id, requestId: r.request_id, text: r.text,
      part: { summary: r.summary, note: r.note, file: r.file }
    }));
  }
}
