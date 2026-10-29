import type { WaitingKind } from "../status-words.js";
import type { ThreadDot } from "../thread-dot.js";

/** A manager thread's one state, as the server works it out. */
export interface ThreadStatusDto {
  threadId: string;
  state: ThreadDot;
}

/** One thing that waits on the user, as Home lists it. */
export interface WaitingEntryDto {
  /** Stable while the entry stands: `${kind}:${id}:${waiting}`, the id a
   *  worker's feature id, else the thread's ("agent" for Your agent's). */
  key: string;
  /** Your agent's own question, a manager's question, a worker's question
   *  nobody took up, or the thread itself (it broke, or the manager stop check found
   *  its latest reply leaves the user something). */
  kind: "agent" | "question" | "worker" | "thread";
  waiting: WaitingKind;
  threadId: string | null;
  threadTitle: string | null;
  featureId: string | null;
  workerName: string | null;
  /** The question; why the thread failed or stopped; the judged reply. */
  text: string;
  /** A worker's project, and its page there: a row opens with what the
   *  snapshot says alone. Null for any other kind. */
  place: { projectName: string; projectSlug: string; featureSlug: string } | null;
}

/** Every open manager thread's state and what waits on the user, sent
 *  whole whenever any of it changes. */
export interface ThreadStatusSnapshotDto {
  threads: ThreadStatusDto[];
  waiting: WaitingEntryDto[];
}

/** A manager stop check's verdict while it shows: the thread stopped on that reply
 *  and the user has not read it. */
export interface CurrentVerdict {
  verdict: "decision" | "result";
  replySeq: number;
  replyText: string;
}
