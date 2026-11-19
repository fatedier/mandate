import type { ManagerThreadDto } from "@shared/api/agents";
import type { ThreadDot } from "@shared/thread-dot";
import { SIDEBAR_RANK } from "@shared/status-words";

export function isThreadNew(thread: Pick<ManagerThreadDto, "lastVisibleSeq" | "seenSeq">): boolean {
  return thread.lastVisibleSeq > thread.seenSeq;
}

export function sortThreadsForSidebar<T extends Pick<ManagerThreadDto, "id" | "lastActivityAt">>(
  threads: T[],
  dotOf: (id: string) => ThreadDot
): T[] {
  const rank = (id: string) => SIDEBAR_RANK[dotOf(id)];
  return [...threads].sort((a, b) => rank(a.id) - rank(b.id) || b.lastActivityAt.localeCompare(a.lastActivityAt));
}
