import { useId, useMemo, useState } from "react";
import { Check, ChevronRight, CircleQuestionMark } from "lucide-react";
import { Fold } from "@/components/Fold";
import { MarkdownView } from "@/components/MarkdownView";
import { cn } from "@/lib/utils";
import { markdownToText } from "@/lib/markdown-text";
import type { QuestionOption } from "@shared/questions";
import type { AskState } from "./ask-lines";

/** Where a question was asked, in the conversation: one quiet line. In the
 *  status colour while it waits for the user (the question itself, with its
 *  answers, stands above the composer); grey once answered; struck through
 *  when its asker took it back; skipped when the user closed it without an
 *  answer. Each state is said in words too, not by the colour alone. Once it
 *  no longer waits, the line opens in place to the whole question, drawn as
 *  the chat draws it, with its suggested answers and the user's own answer
 *  marked. Whether it is open is kept by `expanded` and `onExpandedChange`
 *  when given (the transcript keeps it across redraws), else by the line. */
export function AskLine({ questionId, question, state, options = [], answer = null, expanded, onExpandedChange }: {
  questionId: string;
  question: string;
  state: AskState;
  /** The answers it suggested. */
  options?: readonly QuestionOption[];
  /** What the user answered it with, as their message said it; null when
   *  not known (skipped, taken back, or the answer not loaded). */
  answer?: string | null;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const open = state === "open";
  // One line: the question's words, without its Markdown.
  const words = useMemo(() => markdownToText(question), [question]);
  const [ownShown, setOwnShown] = useState(false);
  const bodyId = useId();
  const shown = expanded ?? ownShown;
  const text = "min-w-0 flex-1 truncate";
  const head = (
    <>
      <CircleQuestionMark aria-hidden className={cn("size-3.5 shrink-0", open && "text-status-input-fg")} />
      <span data-slot="ask-line-label" className={cn("shrink-0 font-medium", open ? "text-status-input-fg" : "text-chrome")}>
        {open ? "Asked you" : `Asked you · ${state}`}
      </span>
      {state === "withdrawn"
        ? <s data-slot="ask-line-question" className={text}>{words}</s>
        : <span data-slot="ask-line-question" className={text}>{words}</span>}
    </>
  );
  if (open) {
    return (
      <p data-slot="ask-line" data-state={state} data-question-id={questionId} title={words} className="flex h-6 min-w-0 items-center gap-2 rounded-sm px-1 text-2xs text-faint">
        {head}
      </p>
    );
  }
  const answered = answer?.trim() ?? "";
  const picked = (option: QuestionOption) => answered !== "" && option.label.trim() === answered;
  const typed = answered !== "" && !options.some(picked);
  const toggle = () => (onExpandedChange ? onExpandedChange(!shown) : setOwnShown(!shown));
  return (
    <div data-slot="ask-line" data-state={state} data-question-id={questionId} className="min-w-0 rounded-sm">
      <button
        type="button"
        data-slot="ask-line-head"
        aria-expanded={shown}
        aria-controls={bodyId}
        title={words}
        onClick={toggle}
        className="flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left text-2xs text-faint transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11"
      >
        {head}
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform", shown && "rotate-90")} />
      </button>
      <Fold open={shown} id={bodyId}>
        <div data-slot="ask-line-body" className="flex min-w-0 flex-col gap-2.5 pt-1 pr-1 pb-1.5 pl-[26px]">
          <div data-slot="ask-line-full" className="text-foreground/85">
            <MarkdownView text={question} small />
          </div>
          {options.length > 0 && (
            <ul data-slot="ask-line-options" className="flex flex-col gap-1">
              {options.map((option, index) => {
                const mine = picked(option);
                return (
                  <li
                    key={index}
                    data-slot="ask-line-option"
                    data-picked={mine ? "true" : undefined}
                    className={cn(
                      "flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5",
                      mine ? "border-border bg-foreground/[0.04] text-foreground" : "border-border-soft pl-[30px] text-faint"
                    )}
                  >
                    {mine && <Check aria-hidden className="mt-[3px] size-3.5 shrink-0" />}
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className={cn("text-xs break-words", mine && "font-medium")}>
                        {markdownToText(option.label)}
                        {mine && <span className="font-normal text-muted-foreground"> · Your answer</span>}
                      </span>
                      {option.description && <span className="text-2xs break-words text-muted-foreground">{markdownToText(option.description)}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {typed && (
            <div data-slot="ask-line-answer" className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-foreground/[0.04] px-2.5 py-1.5 text-foreground">
              <Check aria-hidden className="mt-[3px] size-3.5 shrink-0" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-2xs text-muted-foreground">Your answer</span>
                <span className="text-xs break-words whitespace-pre-wrap">{answered}</span>
              </span>
            </div>
          )}
        </div>
      </Fold>
    </div>
  );
}
