import { useEffect, useRef, useState } from "react";
import type { OpenQuestion } from "@shared/questions";
import { QUESTION_HEADING } from "./QuestionDock";
import { markdownToText } from "@/lib/markdown-text";

/** A question as said once: by its id and its words. */
const sayingOf = (question: OpenQuestion) => `${question.id}\u0000${question.question}`;

/** Says a question aloud to a screen reader when it comes to stand above
 *  the composer: that it waits for an answer, and the question; once each, and nothing when
 *  one leaves. Of several new at once, the one asked last. Mounted with the
 *  conversation, not with the block, so that it is there before a question
 *  is and its change is heard. Each announcement is put in anew, so a new
 *  question worded as the last one is heard too. */
export function QuestionAnnouncer({ questions }: { questions: readonly OpenQuestion[] }) {
  const [said, setSaid] = useState({ text: "", count: 0 });
  const announced = useRef(new Set<string>());
  useEffect(() => {
    const fresh = questions.filter((question) => !announced.current.has(sayingOf(question)));
    if (fresh.length === 0) return;
    for (const question of fresh) announced.current.add(sayingOf(question));
    // ISO times sort as text; one with none is the oldest, and a tie goes to the later in the list.
    const newest = fresh.reduce((latest, question) => (question.askedAt >= latest.askedAt ? question : latest));
    setSaid((last) => ({ text: `${QUESTION_HEADING}: ${markdownToText(newest.question)}`, count: last.count + 1 }));
  }, [questions]);
  return (
    <div data-slot="question-announcer" role="status" aria-live="polite" className="sr-only">
      {said.count > 0 && <span key={said.count}>{said.text}</span>}
    </div>
  );
}
