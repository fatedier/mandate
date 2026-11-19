import { useLayoutEffect, useRef, type RefObject } from "react";
import type { AgentMessage, PendingMessage } from "@/store/agent-chat-types";
import { pendingMatchesMessage } from "@/store/agent-chat-utils";
import { motionAllowed } from "@/lib/motion";

/** A row as the transcript drew it, for telling what arrived: a stored
 *  message, the stand-in for one on its way, or the reply streaming. Its
 *  key is the one its element carries as `data-row-key`. */
export type ShownRow =
  | { key: string; kind: "message"; message: AgentMessage }
  | { key: string; kind: "pending"; localId: string }
  | { key: string; kind: "stream"; wakeId: string };

/** What the transcript drew in one commit, and what it knew then. */
export interface ShownTranscript {
  threadId: string | null;
  rows: readonly ShownRow[];
  /** The newest message loaded (its seq), drawn or not. */
  newestSeq: number;
  /** The messages on their way, those waiting in the queue too. */
  pending: ReadonlyMap<string, PendingMessage>;
  /** The turn whose reply showed words as it streamed. */
  streamedWords: string | null;
  /** Voice lines that showed words as they were spoken. */
  voiceWords: { user: boolean; assistant: boolean };
}

/** The rows that arrived between two commits, to rise into place: stored
 *  rows newer than anything loaded before, a message as it is sent, a reply
 *  as it starts to stream. Not the rows it opened with, history (older
 *  pages, rows brought into its window, a row keyed anew), another
 *  conversation, nor a stored copy taking the place of what showed it just
 *  before: a sent message's stand-in, words shown streaming or spoken. */
export function arrivingRows(before: ShownTranscript | null, now: ShownTranscript): string[] {
  if (before === null || before.threadId !== now.threadId) return [];
  const drawn = new Set(before.rows.map((row) => row.key));
  const standIns = before.rows.flatMap((row) => {
    const pending = row.kind === "pending" ? before.pending.get(row.localId) : undefined;
    return pending ? [pending] : [];
  });
  return now.rows.filter((row) => {
    if (drawn.has(row.key)) return false;
    if (row.kind !== "message") return true;
    const m = row.message;
    if (m.seq <= before.newestSeq) return false;
    if (m.role === "user" && standIns.some((pending) => pendingMatchesMessage(pending.localId, pending, m))) return false;
    // Only a row of words can be the copy of words shown: a call is new.
    const words = m.content.type === "text" ? m.content.text.trim() !== "" : m.content.type === "assistant" && (m.content.text ?? "").trim() !== "";
    if (!words) return true;
    if (m.source === "voice" && (m.role === "user" ? before.voiceWords.user : before.voiceWords.assistant)) return false;
    return !(m.role === "assistant" && m.wakeId !== null && m.wakeId === before.streamedWords);
  }).map((row) => row.key);
}

/** A row's rise as it arrives: 6px up and in, on the house curve. */
const RISE: Keyframe[] = [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }];
const RISE_TIMING: KeyframeAnimationOptions = { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/** Rows that arrive rise into place (arrivingRows) before they are painted:
 *  the element in the column that carries the row's key as `data-row-key`
 *  (the streamed reply's own words, not the cards drawn after them). Asked
 *  for less motion, they are just there. */
export function useArrivingRows(column: RefObject<HTMLElement | null>, shown: ShownTranscript): void {
  const before = useRef<ShownTranscript | null>(null);
  useLayoutEffect(() => {
    const arrived = arrivingRows(before.current, shown);
    before.current = shown;
    const el = column.current;
    if (!el || arrived.length === 0 || !motionAllowed()) return;
    const wanted = new Set(arrived);
    for (const row of el.querySelectorAll<HTMLElement>("[data-row-key]")) {
      if (wanted.has(row.dataset.rowKey!)) row.animate(RISE, RISE_TIMING);
    }
  });
}
