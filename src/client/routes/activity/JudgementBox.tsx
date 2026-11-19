import type { JudgementRecordDto } from "@shared/api-contracts";
import { cn } from "@/lib/utils";
import { aboutLine, answerLabel, answerMeaning, JUDGEMENT_COPY, notUsedLine } from "./ledger-copy";

/** What a judgement answered: every choice it had, the answer marked (a
 *  decision model's odds beside each), what the answer means, what it was
 *  about, and why it was not acted on, if not. Neutral, as a cache verdict
 *  other than an expired one is. */
export function JudgementBox({ record, nowMs }: { record: JudgementRecordDto; nowMs: number }) {
  const meaning = answerMeaning(record.answer);
  return (
    <div data-call-judgement className="rounded-lg border border-border-soft bg-panel px-4 py-2.5">
      <div className="label-micro text-chrome">{JUDGEMENT_COPY.title}</div>
      {/* role: Safari reads a list without its markers as a group. */}
      <ul role="list" aria-label={JUDGEMENT_COPY.choices} className="mt-1 flex flex-wrap gap-1.5">
        {record.options.map((option) => {
          const chosen = option === record.answer;
          // Its own entry only: a choice named "constructor" inherits one.
          const odds = record.probabilities && Object.hasOwn(record.probabilities, option) ? record.probabilities[option] : undefined;
          return (
            <li
              key={option}
              data-judgement-choice
              aria-current={chosen ? "true" : undefined}
              className={cn("pill border", chosen ? "border-foreground/30 bg-sel font-semibold text-foreground" : "border-border text-muted-foreground")}
            >
              {answerLabel(option)}
              {odds !== undefined && <span className="num font-medium text-muted-foreground">{Math.round(odds * 100)}%</span>}
            </li>
          );
        })}
      </ul>
      {meaning && <p data-judgement-meaning className="mt-1.5 text-xs leading-relaxed text-foreground/85">{meaning}</p>}
      <p data-judgement-about className="text-xs leading-relaxed text-foreground/85">{aboutLine(record.subject, nowMs)}</p>
      {record.notUsed && <p data-judgement-not-used className="text-xs leading-relaxed text-chrome">{notUsedLine(record.notUsed)}</p>}
    </div>
  );
}
