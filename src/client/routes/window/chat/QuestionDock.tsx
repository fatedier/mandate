import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleQuestionMark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QUESTION_FRAME, QuestionCallout } from "@/components/QuestionCallout";
import { questionHeading, type ShownQuestion } from "@/lib/shown-questions";
import { cn } from "@/lib/utils";
import { markdownToText } from "@/lib/markdown-text";
import type { HeldAnswers } from "./useHeldAnswers";

/** The questions that wait for the user's answer, above the composer: there
 *  whatever the conversation has moved on to since they were asked. One at a
 *  time, with where it is among them; folded to a line when the reader wants
 *  the room. A suggested answer, or one typed in the question's own field, is
 *  sent as the user's message naming the question: what is typed in the
 *  composer below names none, and answers nothing. A worker's question that
 *  came up to its thread is answered below, to the manager, who passes it on. */
export function QuestionDock({ questions, answers, onLeave }: {
  questions: readonly ShownQuestion[];
  /** What the conversation keeps of the answers: held, refused, drafted
   *  (useHeldAnswers), so a dock mounted anew picks up where it was. */
  answers: HeldAnswers;
  /** The last question went with an answer given from it: the focus goes
   *  back to the composer. */
  onLeave?: () => void;
}) {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [folded, setFolded] = useState(false);
  const { held, refused, drafts, setDraft } = answers;
  const rootRef = useRef<HTMLDivElement>(null);
  // Whether the focus is in the block, as it last landed anywhere on the
  // page: landing outside it (the composer) says no, and nothing is taken
  // back. Going to nothing (what had it was taken away, or a click on the
  // transcript's text) lands nowhere and changes nothing.
  const focusInside = useRef(false);
  useEffect(() => {
    const landed = (e: FocusEvent) => { focusInside.current = rootRef.current?.contains(e.target as Node) ?? false; };
    document.addEventListener("focusin", landed);
    return () => document.removeEventListener("focusin", landed);
  }, []);
  // A move made here, for the render it causes: a page, or a fold.
  const paged = useRef<null | "Previous question" | "Next question">(null);
  const toggled = useRef(false);
  const leaveRef = useRef(onLeave);
  useEffect(() => { leaveRef.current = onLeave; });
  /** The focus last landed in the block, and what had it is gone with it
   *  (the question answered and gone, whichever of that and the send's
   *  answer came first): it is nowhere now. Gone into a frame (a canvas),
   *  the page hears no landing, but the focus is there. */
  const fell = () => focusInside.current && (document.activeElement === null || document.activeElement === document.body);
  // The one in view stays in view while others are answered around it; once
  // it is answered itself, the first of what is left.
  const at = Math.max(0, questions.findIndex((q) => q.id === currentId));
  const question = questions[at];
  const shownId = question?.id;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const want = paged.current;
    paged.current = null;
    if (want) {
      // Paged: the same button, or the other one at the end of the row.
      const pager = [...root.querySelectorAll<HTMLButtonElement>('[aria-label="Previous question"], [aria-label="Next question"]')];
      (pager.find((b) => b.getAttribute("aria-label") === want && !b.disabled) ?? pager.find((b) => !b.disabled))?.focus();
      return;
    }
    // Another question is in view and what had the focus went with the last:
    // its first answer, or its field; a worker's question has neither, and
    // is answered in the composer.
    if (!fell()) return;
    const first = root.querySelector<HTMLElement>('[data-slot="question-option"], [data-slot="question-input"]');
    if (first) first.focus();
    else leaveRef.current?.();
  }, [shownId]);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    rootRef.current?.querySelector<HTMLElement>(folded ? '[data-slot="question-reminder"]' : '[aria-label="Hide the question"]')?.focus();
  }, [folded]);
  // The last question gone with the focus in it: the composer is next.
  useEffect(() => () => { if (fell()) leaveRef.current?.(); }, []);
  if (!question) return null;
  const count = questions.length === 1 ? "1 question" : `${questions.length} questions`;

  const toggle = (next: boolean) => {
    toggled.current = rootRef.current?.contains(document.activeElement) ?? false;
    setFolded(next);
  };
  const page = (to: string, direction: "Previous question" | "Next question") => {
    paged.current = rootRef.current?.contains(document.activeElement) ? direction : null;
    setCurrentId(to);
  };


  if (folded) {
    return (
      <div ref={rootRef} className="flex min-w-0 flex-col">
      <button
        type="button"
        data-slot="question-reminder"
        aria-expanded="false"
        onClick={() => toggle(false)}
        className={cn("flex min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-status-input/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11", QUESTION_FRAME)}
      >
        <CircleQuestionMark className="size-4 shrink-0 text-status-input-fg" aria-hidden />
        <span className="shrink-0 text-xs font-semibold text-status-input-fg">{count}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{markdownToText(question.question)}</span>
        <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      </div>
    );
  }

  const answer = (words: string) => answers.pick(question, words);
  const pick = (label: string) => { void answer(label); };

  return (
    <div ref={rootRef} className="flex min-h-0 flex-col">
    <QuestionCallout
      // Its own field per question: a draft stays with its question.
      key={question.id}
      heading={questionHeading(question)}
      question={question.question}
      options={question.options}
      onPick={pick}
      busy={held.has(question.id)}
      error={refused?.id === question.id ? refused.reason : null}
      hint={question.from ? "Type your answer below." : undefined}
      onSend={question.from ? undefined : (words) => answer(words)}
      draft={drafts[question.id] ?? ""}
      onDraftChange={(words) => setDraft(question.id, words)}
      placeholder={question.options.length > 0 ? "Type your own answer" : "Type your answer"}
      actions={(
        <>
          {questions.length > 1 && (
            <span data-slot="question-pager" className="flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground pointer-coarse:gap-3">
              <Button size="icon-xs" variant="ghost" aria-label="Previous question" disabled={at === 0} onClick={() => page(questions[at - 1]!.id, "Previous question")} className="-my-1">
                <ChevronLeft className="size-3.5" />
              </Button>
              <span data-slot="question-position" className="tabular-nums">{at + 1} of {questions.length}</span>
              <Button size="icon-xs" variant="ghost" aria-label="Next question" disabled={at === questions.length - 1} onClick={() => page(questions[at + 1]!.id, "Next question")} className="-my-1">
                <ChevronRight className="size-3.5" />
              </Button>
            </span>
          )}
          <Button size="icon-xs" variant="ghost" aria-label="Hide the question" aria-expanded="true" onClick={() => toggle(true)} className="-my-1 shrink-0 text-muted-foreground">
            <ChevronDown className="size-3.5" />
          </Button>
          {/* Closes it without an answer; rarely wanted, so it is quiet. A
              worker's question lives in its plan and is not this one's. */}
          {answers.skip && !question.from && (
            <Button
              size="xs"
              variant="ghost"
              data-slot="question-skip"
              title="Skip without answering"
              aria-disabled={held.has(question.id) || undefined}
              onClick={() => { if (!held.has(question.id)) void answers.skip!(question); }}
              // 8px more on a touch screen: its touch area and the fold's meet otherwise.
              className="-my-1 h-6 shrink-0 px-2 text-2xs text-muted-foreground aria-disabled:pointer-events-none aria-disabled:opacity-60 pointer-coarse:ml-2"
            >
              Skip
            </Button>
          )}
        </>
      )}
    />
    </div>
  );
}
