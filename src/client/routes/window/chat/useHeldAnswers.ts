import { useCallback, useMemo, useState } from "react";
import type { ShownQuestion } from "@/lib/shown-questions";

/** What a conversation keeps of the answers to its questions: kept by the
 *  conversation and not by the dock, which stands over the composer or over
 *  what took its place, and is mounted anew when it moves from one to the
 *  other.
 *
 *  `held`: the questions an answer is on its way for, or went for, until it
 *  is refused or the conversation drops the question. A question the
 *  conversation dropped is let go: if it comes back (the message its answer
 *  became waited behind a turn and was taken back, or was lost at a
 *  restart), it is open to answer again.
 *  `refused`: why the last answer did not go, for the question it was for.
 *  `drafts`: what is typed in each question's own field, until it goes.
 *  `skip`: closes a question without an answer, held and refused as a pick
 *  is; absent where questions cannot be skipped. */
export interface HeldAnswers {
  held: ReadonlySet<string>;
  pick: (question: ShownQuestion, label: string) => Promise<string | null>;
  skip?: (question: ShownQuestion) => Promise<string | null>;
  refused: { id: string; reason: string } | null;
  drafts: Readonly<Record<string, string>>;
  setDraft: (questionId: string, words: string) => void;
}

export function useHeldAnswers(
  send: (question: ShownQuestion, label: string) => Promise<string | null>,
  questions: readonly ShownQuestion[],
  sendSkip?: (question: ShownQuestion) => Promise<string | null>
): HeldAnswers {
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [refused, setRefused] = useState<{ id: string; reason: string } | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  // Followed as the list changes, while rendering (no effect: the answers
  // are never drawn held for a question that has just come back).
  const [listed, setListed] = useState(questions);
  if (listed !== questions) {
    setListed(questions);
    const present = new Set(questions.map((question) => question.id));
    if ([...held].some((id) => !present.has(id))) setHeld(new Set([...held].filter((id) => present.has(id))));
  }
  // Held until the question goes; let go, with why, if refused.
  const hold = useCallback(async (question: ShownQuestion, go: () => Promise<string | null>) => {
    setRefused(null);
    setHeld((ids) => new Set(ids).add(question.id));
    const reason = await go();
    if (reason) {
      setHeld((ids) => new Set([...ids].filter((id) => id !== question.id)));
      setRefused({ id: question.id, reason });
    }
    return reason;
  }, []);
  const pick = useCallback((question: ShownQuestion, label: string) => hold(question, () => send(question, label)), [hold, send]);
  const skip = useMemo(
    () => (sendSkip ? (question: ShownQuestion) => hold(question, () => sendSkip(question)) : undefined),
    [hold, sendSkip]
  );
  const setDraft = useCallback((questionId: string, words: string) => {
    setDrafts((all) => ({ ...all, [questionId]: words }));
  }, []);
  // One object while nothing in it changes: the composer is not drawn again
  // for each piece of a reply.
  return useMemo(() => ({ held, pick, skip, refused, drafts, setDraft }), [held, pick, skip, refused, drafts, setDraft]);
}
