import { useContext, useState } from "react";
import { create } from "zustand";
import { PageShownContext } from "@/lib/page-shown";
import { usePageVisible } from "@/hooks/usePageVisible";
import type { AgentMessage } from "@/store/agent-chat";

/** The agent's own words, as the conversation's newest-visible point counts
 *  them: a notice or a worker's report is new too, but no reply. */
function isReply(message: AgentMessage): boolean {
  return message.role === "assistant" && message.content.type === "assistant"
    && typeof message.content.text === "string" && message.content.text.trim() !== "";
}

/** The user's own words, typed or spoken: a request the personal agent
 *  passed on for them is not. */
function isOwnWords(message: AgentMessage): boolean {
  if (message.role !== "user" || (message.source !== "user" && message.source !== "voice")) return false;
  return !(message.content.type === "text" && message.content.relay);
}

export interface ReadSince {
  /** The user has written since (a message of theirs after the point, or
   *  one being sent from here): nothing is new to them any more. */
  wrote: boolean;
  /** The replies after the point, among the messages loaded. */
  count: number;
  /** The first loaded message after it that is not the user's own: the
   *  line goes above its row. Null when none is loaded. */
  firstSeq: number | null;
}

/** What came after the point the user had read to, among the messages loaded. */
export function readSince(messages: readonly AgentMessage[], from: number, sending: number): ReadSince {
  let count = 0;
  let firstSeq: number | null = null;
  for (const message of messages) {
    if (message.seq <= from) continue;
    if (isOwnWords(message)) return { wrote: true, count: 0, firstSeq: null };
    if (isReply(message)) count += 1;
    firstSeq = firstSeq === null ? message.seq : Math.min(firstSeq, message.seq);
  }
  return { wrote: sending > 0, count, firstSeq };
}

/** Whether the loaded messages reach back to the read point: until they do,
 *  the first new message may be on a page not loaded yet. */
export function reachesBack(messages: readonly AgentMessage[], from: number, hasMoreOlder: boolean): boolean {
  return !hasMoreOlder || messages.some((message) => message.seq <= from);
}

/** Where the user had read the conversation to when it last came into sight
 *  (its page shown and its browser tab in front), held while it stays in
 *  sight: the page marks it all seen at once, and what came after the point
 *  is still new to the reader. Null out of sight, or before the point is
 *  known. Coming back, which point is right depends on how it was away:
 *  - a browser tab in the back: the page marks the conversation seen in its
 *    own listener as the tab shows, before this renders, so the point is the
 *    one followed while the tab was in the back (read on another device,
 *    say);
 *  - another page, or another tab of the page: nothing marks it seen before
 *    this renders, and a kept page hidden behind another (React Activity)
 *    followed nothing while hidden, so the point is what is read to now. */
export function useReadPoint(key: string, seenSeq: number | null | undefined, inSight: boolean): number | null {
  const visible = usePageVisible();
  // The kept page it may stand in (the personal agent's, a thread's tab
  // beside its chat) is out of sight while another page shows.
  const pageShown = useContext(PageShownContext);
  const [held, setHeld] = useState<{ key: string; seq: number; away: "tab" | "page" | null } | null>(null);
  if (seenSeq === null || seenSeq === undefined) {
    if (held !== null) setHeld(null);
    return null;
  }
  if (!inSight || !pageShown || !visible) {
    const away = !inSight || !pageShown ? "page" : "tab";
    if (held === null || held.key !== key || held.seq !== seenSeq || held.away !== away) setHeld({ key, seq: seenSeq, away });
    return null;
  }
  if (held === null || held.key !== key || held.away === "page") {
    setHeld({ key, seq: seenSeq, away: null });
    return seenSeq;
  }
  if (held.away === "tab") setHeld({ ...held, away: null });
  return held.seq;
}

/** The visits (a conversation and its read point) whose New line has been in
 *  view: the bar does not come back for them. Kept outside the list, which a
 *  page resized across the phone's width draws anew. */
export const useSeenNewLines = create<{ seen: ReadonlySet<string>; mark(visit: string): void }>()((set) => ({
  seen: new Set(),
  mark: (visit) => set((s) => (s.seen.has(visit) ? {} : { seen: new Set(s.seen).add(visit) }))
}));
