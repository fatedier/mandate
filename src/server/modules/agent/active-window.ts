import type { AgentMessageDto as AgentMessage } from "../../../shared/api-contracts.js";
import { stallWatch } from "../../platform/diagnostics/stall-watch.js";

/** How long a window nobody read is kept. A turn's steps, and the turns that
 *  follow it, read it again within seconds; a quiet thread is read afresh. */
export const ACTIVE_WINDOW_IDLE_MS = 10 * 60_000;
/** All windows held together, by the length of their stored content in
 *  UTF-16 code units (a string's length; what it takes in memory is a
 *  multiple of that). Above it the windows read longest ago go first. */
export const ACTIVE_WINDOW_MAX_BYTES = 256 * 1024 * 1024;

/** A read of a window, or of the rows after it, with the size of the stored
 *  content behind it. */
export interface ActiveWindowRead { messages: AgentMessage[]; bytes: number }

/** What the windows read: the store's queries. */
export interface ActiveWindowRows {
  /** The window as a full read gives it now. */
  readActiveWindow(threadId: string): ActiveWindowRead;
  /** The conversation's rows with seq above `seq` that a window holds (not
   *  its system instruction), in the window's order. */
  activeRowsAfter(threadId: string, seq: number): ActiveWindowRead;
  /** Moves whenever one of the conversation's stored messages changes after
   *  it was written (schema.ts keeps it). */
  messageVersion(threadId: string): number;
  /** A transaction is open: what is read now may yet be rolled back. */
  uncommitted(): boolean;
}

export interface ActiveWindowOptions { now?: () => number; idleMs?: number; maxBytes?: number }

interface Entry {
  messages: AgentMessage[];
  lastSeq: number;
  version: number;
  bytes: number;
  usedAt: number;
}

/**
 * Each conversation's active window, kept between reads. Every step reads its
 * window several times (the plan reminder, the runtime context, the
 * compaction gate, the step's own prompt), and a long window is megabytes:
 * read whole each time it cost the server's thread most of its database time.
 *
 * A read takes the conversation's version, then the rows after the highest
 * seq held: rows are appended with ever higher seqs, and every other change
 * to a stored message moves the version, which makes the next read a full
 * one. A new summary does too (it starts a new window). So a read gives what
 * a fresh read of the database gives, without anything having to tell the
 * windows that something changed.
 *
 * Inside a transaction it reads afresh and keeps nothing: rows written there
 * may be rolled back, and a window that had taken them would outlive them.
 *
 * The messages are shared between reads, so they are frozen: a reader that
 * writes into one fails at once instead of changing every later read.
 */
export class ActiveWindows {
  private readonly entries = new Map<string, Entry>();
  private heldBytes = 0;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxBytes: number;

  constructor(private readonly rows: ActiveWindowRows, options: ActiveWindowOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? ACTIVE_WINDOW_IDLE_MS;
    this.maxBytes = options.maxBytes ?? ACTIVE_WINDOW_MAX_BYTES;
  }

  get(threadId: string): AgentMessage[] {
    if (this.rows.uncommitted()) return this.rows.readActiveWindow(threadId).messages;
    // The version before the rows: nothing lands between the two (one
    // thread, no awaits).
    const version = this.rows.messageVersion(threadId);
    let entry = this.entries.get(threadId);
    if (entry && (entry.version !== version || this.now() - entry.usedAt > this.idleMs)) entry = this.drop(threadId);
    if (entry) {
      const after = stallWatch.run("active window catch-up", () => this.rows.activeRowsAfter(threadId, entry!.lastSeq));
      if (after.messages.some(startsWindow)) {
        entry = this.drop(threadId);
      } else {
        for (const message of after.messages) entry.messages.push(frozen(message));
        entry.lastSeq = highestSeq(after.messages, entry.lastSeq);
        entry.bytes += after.bytes;
        this.heldBytes += after.bytes;
      }
    }
    if (!entry) {
      const read = stallWatch.run("active window load", () => this.rows.readActiveWindow(threadId));
      entry = { messages: read.messages.map(frozen), lastSeq: highestSeq(read.messages, 0), version, bytes: read.bytes, usedAt: 0 };
      this.heldBytes += read.bytes;
    }
    // Most recently read last: the map's order is the order to let go in.
    this.entries.delete(threadId);
    entry.usedAt = this.now();
    this.entries.set(threadId, entry);
    this.letGo(threadId);
    return entry.messages.slice();
  }

  held(): { threads: number; bytes: number } {
    return { threads: this.entries.size, bytes: this.heldBytes };
  }

  private drop(threadId: string): undefined {
    const entry = this.entries.get(threadId);
    if (entry) {
      this.heldBytes -= entry.bytes;
      this.entries.delete(threadId);
    }
    return undefined;
  }

  /** Windows unread too long go, then the least recently read while all
   *  together hold too much (never the one just read). */
  private letGo(keep: string): void {
    const now = this.now();
    for (const [threadId, entry] of this.entries) {
      if (threadId !== keep && now - entry.usedAt > this.idleMs) this.drop(threadId);
    }
    for (const threadId of this.entries.keys()) {
      if (this.heldBytes <= this.maxBytes) break;
      if (threadId !== keep) this.drop(threadId);
    }
  }
}

/** A compaction's summary: the window starts again from it. */
function startsWindow(message: AgentMessage): boolean {
  return message.source === "compression" && message.content.type === "summary";
}

function highestSeq(messages: AgentMessage[], from: number): number {
  return messages.reduce((max, message) => Math.max(max, message.seq), from);
}

function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) frozen(inner);
  }
  return value;
}
