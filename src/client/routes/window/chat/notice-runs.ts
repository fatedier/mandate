import { threadNoticeOf } from "@shared/thread-notice";
import { rendersNothing, type DatedRow } from "./transcript-rows";

/** What a notice row standing on its own tells of: its thread, or its
 *  worker. Null for any other row, and for a notice drawn over the reply its
 *  wake gave (pairWakeCauses), which is that reply's row. */
function noticeSubject(entry: DatedRow): string | null {
  if (entry.kind !== "item" || entry.item.kind !== "msg" || entry.item.cause) return null;
  const message = entry.item.message;
  if (message.role !== "user" || message.source !== "thread-notice") return null;
  const notice = threadNoticeOf(message.content);
  if (!notice) return null;
  if (notice.kind === "worker") return notice.workerId ? `worker:${notice.workerId}` : null;
  return notice.targetThreadId ? `thread:${notice.targetThreadId}` : null;
}

/** Notice rows next to each other that tell of one thread (or worker), with
 *  nothing drawn between them: two or more fold into one row. A row drawn as
 *  nothing does not part them; any other row does, a date line too, and the
 *  first row from `splitAt` on (where the New line goes, as a run of tool
 *  steps is cut there). By the index of each run's first row, the indexes of
 *  all its rows. */
export function noticeRuns(entries: readonly DatedRow[], splitAt: number | null = null): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  let run: number[] = [];
  let subject: string | null = null;
  const close = () => {
    if (run.length > 1) runs.set(run[0]!, run);
    run = [];
    subject = null;
  };
  let before = true;
  entries.forEach((entry, index) => {
    if (entry.kind === "item" && rendersNothing(entry.item)) return;
    const of = noticeSubject(entry);
    const seq = entry.kind === "item" && entry.item.kind === "msg" ? entry.item.message.seq : null;
    const crossed = splitAt !== null && before && seq !== null && seq >= splitAt;
    if (crossed) before = false;
    if (of !== null && of === subject && !crossed) {
      run.push(index);
      return;
    }
    close();
    if (of !== null) {
      run = [index];
      subject = of;
    }
  });
  close();
  return runs;
}

/** The mark of a notice in an open run, in the set that holds the opened
 *  runs. Each of the run's notices is marked: a run open stays open as older
 *  notices load above it or newer ones come below. */
export function noticeRunOpenKey(messageId: string): string {
  return `notice-run:${messageId}`;
}

/** The message of the row at `index`, when it is a message's. */
function messageIdAt(entries: readonly DatedRow[], index: number): string | null {
  const entry = entries[index];
  return entry?.kind === "item" && entry.item.kind === "msg" ? entry.item.message.id : null;
}

/** Each run's key, by its first row's index. A run keeps the key one of its
 *  notices had (`known`, as the list last keyed them), so its row stays the
 *  same row as notices join it below or load above it; a run none of whose
 *  notices had one is keyed by its first. Two runs never share a key: of a
 *  run cut in two, its first part keeps it. */
export function noticeRunKeys(entries: readonly DatedRow[], runs: ReadonlyMap<number, readonly number[]>, known: ReadonlyMap<string, string>): Map<number, string> {
  const keys = new Map<number, string>();
  const used = new Set<string>();
  for (const [first, run] of runs) {
    const ids = run.flatMap((i) => messageIdAt(entries, i) ?? []);
    const key = ids.map((id) => known.get(id)).find((k): k is string => k !== undefined && !used.has(k))
      ?? ids.find((id) => !used.has(id));
    if (key === undefined) continue;
    used.add(key);
    keys.set(first, key);
  }
  return keys;
}

/** The notices in a run, as the list cuts runs: over every loaded row (not
 *  only those in its render window). */
export function noticesInRuns(entries: readonly DatedRow[], splitAt: number | null): Set<string> {
  const ids = new Set<string>();
  for (const run of noticeRuns(entries, splitAt).values()) {
    for (const i of run) {
      const id = messageIdAt(entries, i);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Whether a run opened in place pauses following, as an open fold does:
 *  opened at the end, it would be scrolled away as it grows. Read from the
 *  runs drawn, never from the marks alone: a notice marked open whose run is
 *  gone (its latest drawn over the reply its wake gave) holds no pause. */
export function openNoticeRunPausesFollow(inRuns: ReadonlySet<string>, expandedIds: ReadonlySet<string>): boolean {
  if (expandedIds.size === 0) return false;
  for (const id of inRuns) if (expandedIds.has(noticeRunOpenKey(id))) return true;
  return false;
}
