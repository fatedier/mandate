import { foldQuestions, type OpenQuestion, type QuestionRow } from "../../../shared/questions.js";

/** What the index reads: the store's two queries. */
export interface QuestionRows {
  /** The rows after `seq` that can open or close a question, oldest first. */
  questionRowsAfter(threadId: string, seq: number): Array<QuestionRow & { seq: number }>;
  /** Seq of the conversation's newest row; 0 for an empty one. */
  lastSeq(threadId: string): number;
  /** The rows being read may yet be rolled back: a transaction is open. */
  uncommitted(): boolean;
}

/** The open questions of each conversation, kept as the fold of its rows up
 *  to a sequence mark. Every read folds in what landed after the mark, so the
 *  list is always what the rows say and nothing has to tell the index that a
 *  row arrived. It holds nothing a restart loses: the first read of a
 *  conversation folds it from the start (a question stays open until it is
 *  named and answered, however long ago it was asked), which the filter on
 *  the rows keeps to the few that ask, answer or take back.
 *
 *  The mark moves to the conversation's newest row, whatever kind it is: the
 *  rows of ordinary work are most of a conversation, and a mark left at the
 *  last question would have every read search them again.
 *
 *  Inside a transaction it reads and keeps nothing: rows written there may be
 *  rolled back, and what it had folded of them would outlive them (its mark
 *  past rows that are gone, and so past the rows that take their numbers). */
export class QuestionIndex {
  private readonly byThread = new Map<string, { seq: number; open: OpenQuestion[] }>();

  constructor(private readonly rows: QuestionRows) {}

  open(threadId: string): OpenQuestion[] {
    let { seq, open } = this.byThread.get(threadId) ?? { seq: 0, open: [] };
    // Read before the rows: nothing lands between the two (one thread, no awaits).
    const last = this.rows.lastSeq(threadId);
    for (const row of this.rows.questionRowsAfter(threadId, seq)) open = foldQuestions(open, row);
    if (!this.rows.uncommitted()) this.byThread.set(threadId, { seq: Math.max(seq, last), open });
    return open;
  }
}
